// @ts-check
/**
 * `claude-crap doctor` — full diagnostic pass.
 *
 * Runs every check the install script runs, plus several deeper probes
 * that make sure the plugin can actually function against the current
 * workspace:
 *
 *   - Node.js runtime ≥ 20
 *   - Plugin structure sanity (package.json, .claude-plugin/plugin.json,
 *     .mcp.json, hooks/hooks.json)
 *   - `dist/index.js` exists (built)
 *   - Hook scripts are executable
 *   - tree-sitter runtime WASM is reachable
 *   - tree-sitter language grammars (c_sharp, javascript, typescript,
 *     python, java) are all present
 *   - Dashboard port is free on 127.0.0.1
 *   - SARIF reports directory is writable in the current workspace
 *
 * Exits 0 when all checks pass, 1 when any check fails, and 2 when
 * there are only warnings. This makes it easy to embed in CI:
 * `claude-crap doctor && echo ok`.
 *
 * @module scripts/doctor
 */

import { promises as fs, constants as fsConstants } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";

import { printBanner, printStep, paint, icons } from "./lib/cli-ui.mjs";

const SUPPORTED_LANGUAGES = /** @type {const} */ ([
  { id: "c_sharp", wasm: "tree-sitter-c_sharp.wasm" },
  { id: "javascript", wasm: "tree-sitter-javascript.wasm" },
  { id: "typescript", wasm: "tree-sitter-typescript.wasm" },
  { id: "python", wasm: "tree-sitter-python.wasm" },
  { id: "java", wasm: "tree-sitter-java.wasm" },
]);

/**
 * @typedef {Object} CommandContext
 * @property {string}   pluginRoot
 * @property {string[]} argv
 */

/**
 * Doctor entrypoint.
 *
 * @param {CommandContext} ctx
 * @returns {Promise<number>}
 */
export default async function doctor(ctx) {
  printBanner("claude-crap :: doctor");

  const checks = [];
  checks.push(await checkNodeVersion());
  checks.push(await checkPluginStructure(ctx.pluginRoot));
  checks.push(await checkDist(ctx.pluginRoot));
  checks.push(await checkHooksExecutable(ctx.pluginRoot));
  checks.push(await checkTreeSitterRuntime(ctx.pluginRoot));
  checks.push(...(await checkGrammars(ctx.pluginRoot)));
  checks.push(await checkDashboardPort());
  checks.push(await checkReportsWritable(process.cwd()));

  for (const step of checks) printStep(step);

  const fails = checks.filter((c) => c.status === "fail").length;
  const warns = checks.filter((c) => c.status === "warn").length;

  process.stdout.write(
    `\n${paint.bold("Summary:")} ${checks.length - fails - warns} ok, ${warns} warn, ${fails} fail\n`,
  );

  if (fails > 0) {
    process.stdout.write(
      `${paint.red(icons.fail)} At least one check failed. Fix the issues above and re-run ${paint.bold("claude-crap doctor")}.\n`,
    );
    return 1;
  }
  if (warns > 0) {
    process.stdout.write(
      `${paint.yellow(icons.warn)} Checks passed with warnings. The plugin should still work.\n`,
    );
    return 2;
  }
  process.stdout.write(`${paint.green(icons.ok)} All checks passed. claude-crap is ready.\n`);
  return 0;
}

/** @returns {Promise<import("./lib/cli-ui.mjs").StepResult>} */
async function checkNodeVersion() {
  const raw = process.versions.node;
  const major = Number(raw.split(".")[0]);
  if (!Number.isFinite(major) || major < 20) {
    return {
      status: "fail",
      label: `Node.js runtime (${raw})`,
      detail: `claude-crap requires Node.js ≥ 20.0.0`,
    };
  }
  return { status: "ok", label: `Node.js runtime (${raw})` };
}

/**
 * @param {string} pluginRoot
 * @returns {Promise<import("./lib/cli-ui.mjs").StepResult>}
 */
async function checkPluginStructure(pluginRoot) {
  const required = [
    "package.json",
    "plugin/.claude-plugin/plugin.json",
    "plugin/.mcp.json",
    "plugin/CLAUDE.md",
    "plugin/hooks/hooks.json",
    "plugin/hooks/pre-tool-use.mjs",
    "plugin/hooks/post-tool-use.mjs",
    "plugin/hooks/stop-quality-gate.mjs",
    "plugin/hooks/session-start.mjs",
  ];
  const missing = [];
  for (const rel of required) {
    try {
      await fs.access(join(pluginRoot, rel));
    } catch {
      missing.push(rel);
    }
  }
  if (missing.length > 0) {
    return {
      status: "fail",
      label: `Plugin files present`,
      detail: `Missing: ${missing.join(", ")}`,
    };
  }
  return { status: "ok", label: `Plugin files present (${required.length} checked)` };
}

/**
 * @param {string} pluginRoot
 * @returns {Promise<import("./lib/cli-ui.mjs").StepResult>}
 */
async function checkDist(pluginRoot) {
  const npmEntry = join(pluginRoot, "dist", "index.js");
  const gitEntry = join(pluginRoot, "plugin", "bundle", "mcp-server.mjs");
  
  let npmOk = false;
  let gitOk = false;
  let npmAge, gitAge;

  try {
    const stat = await fs.stat(npmEntry);
    npmAge = Math.round((Date.now() - stat.mtimeMs) / (1000 * 60 * 60));
    npmOk = true;
  } catch { /* probe — absence is expected */ }

  try {
    const stat = await fs.stat(gitEntry);
    gitAge = Math.round((Date.now() - stat.mtimeMs) / (1000 * 60 * 60));
    gitOk = true;
  } catch { /* probe — absence is expected */ }

  const details = [];
  if (npmOk) details.push(`dist/index.js (~${npmAge}h)`);
  if (gitOk) details.push(`plugin/bundle/mcp-server.mjs (~${gitAge}h)`);

  if (!npmOk && !gitOk) {
    return {
      status: "fail",
      label: `Server entrypoints built`,
      detail: `Both dist/ and plugin/bundle/ are missing. Run \`npm run build && npm run build:plugin\`.`
    };
  }

  return {
    status: npmOk && gitOk ? "ok" : "warn",
    label: `Server entrypoints built`,
    detail: details.join(", ") + (!npmOk || !gitOk ? " (one is missing)" : "")
  };
}

/**
 * @param {string} pluginRoot
 * @returns {Promise<import("./lib/cli-ui.mjs").StepResult>}
 */
async function checkHooksExecutable(pluginRoot) {
  const hooks = ["pre-tool-use.mjs", "post-tool-use.mjs", "stop-quality-gate.mjs", "session-start.mjs"];
  const notExec = [];
  for (const name of hooks) {
    const full = join(pluginRoot, "plugin", "hooks", name);
    try {
      await fs.access(full, fsConstants.X_OK);
    } catch {
      notExec.push(name);
    }
  }
  if (notExec.length > 0) {
    return {
      status: "warn",
      label: `Hooks are executable`,
      detail:
        `${notExec.length} hook(s) lack the executable bit: ${notExec.join(", ")}. ` +
        `Run \`claude-crap install\` to fix.`,
    };
  }
  return { status: "ok", label: `Hooks are executable (4 checked)` };
}

/**
 * @param {string} pluginRoot
 * @returns {Promise<import("./lib/cli-ui.mjs").StepResult>}
 */
async function checkTreeSitterRuntime(pluginRoot) {
  const runtime = join(pluginRoot, "node_modules", "web-tree-sitter", "tree-sitter.wasm");
  try {
    const stat = await fs.stat(runtime);
    return {
      status: "ok",
      label: `tree-sitter runtime WASM present`,
      detail: `${runtime} (${stat.size} bytes)`,
    };
  } catch {
    return {
      status: "fail",
      label: `tree-sitter runtime WASM present`,
      detail: `Missing ${runtime}. Run \`npm install\` from ${pluginRoot}.`,
    };
  }
}

/**
 * @param {string} pluginRoot
 * @returns {Promise<import("./lib/cli-ui.mjs").StepResult[]>}
 */
async function checkGrammars(pluginRoot) {
  const base = join(pluginRoot, "node_modules", "tree-sitter-wasms", "out");
  /** @type {import("./lib/cli-ui.mjs").StepResult[]} */
  const results = [];
  for (const lang of SUPPORTED_LANGUAGES) {
    const full = join(base, lang.wasm);
    try {
      await fs.access(full);
      results.push({ status: "ok", label: `Grammar: ${lang.id}` });
    } catch {
      results.push({
        status: "fail",
        label: `Grammar: ${lang.id}`,
        detail: `Missing ${full}. Run \`npm install\`.`,
      });
    }
  }
  return results;
}

/**
 * Probe the configured dashboard port on 127.0.0.1. We attempt to
 * open a TCP listener ourselves — if it succeeds the port is free,
 * if it fails with EADDRINUSE then something is already holding it.
 *
 * @returns {Promise<import("./lib/cli-ui.mjs").StepResult>}
 */
async function checkDashboardPort() {
  const raw = process.env.CLAUDE_PLUGIN_OPTION_DASHBOARD_PORT;
  const port = Number(raw ?? 5117);
  if (!Number.isFinite(port)) {
    return {
      status: "warn",
      label: `Dashboard port configured`,
      detail: `CLAUDE_PLUGIN_OPTION_DASHBOARD_PORT=${raw} is not a number`,
    };
  }
  return await new Promise((resolvePromise) => {
    const server = createServer();
    server.once("error", (err) => {
      const nodeErr = /** @type {NodeJS.ErrnoException} */ (err);
      if (nodeErr.code === "EADDRINUSE") {
        resolvePromise({
          status: "warn",
          label: `Dashboard port ${port} is free`,
          detail:
            `Port ${port} is already in use. The dashboard will refuse to start ` +
            `but the MCP server will keep running.`,
        });
      } else {
        resolvePromise({
          status: "warn",
          label: `Dashboard port ${port} is free`,
          detail: nodeErr.message,
        });
      }
    });
    server.listen({ port, host: "127.0.0.1" }, () => {
      server.close(() => {
        resolvePromise({ status: "ok", label: `Dashboard port ${port} is free` });
      });
    });
  });
}

/**
 * @param {string} workspace
 * @returns {Promise<import("./lib/cli-ui.mjs").StepResult>}
 */
async function checkReportsWritable(workspace) {
  const dir = resolve(workspace, ".claude-crap", "reports");
  try {
    await fs.mkdir(dir, { recursive: true });
    // Try to write a tiny probe file and then immediately unlink it.
    const probe = join(dir, `.doctor-${process.pid}`);
    await fs.writeFile(probe, "ok");
    await fs.unlink(probe);
    return { status: "ok", label: `SARIF reports directory writable`, detail: dir };
  } catch (err) {
    return {
      status: "fail",
      label: `SARIF reports directory writable`,
      detail: `${dir} :: ${/** @type {Error} */ (err).message}`,
    };
  }
}
