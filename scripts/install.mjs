// @ts-check
/**
 * `claude-sonar install` — prepare the workspace and print the Claude
 * Code registration command.
 *
 * This subcommand does every bit of side-effecty work that the plugin
 * needs to run cleanly AND nothing else. We intentionally do NOT try to
 * edit Claude Code's own settings file — that surface is owned by
 * Claude Code's `/plugin install` command, and manipulating it behind
 * the user's back would be a support nightmare. Instead, we:
 *
 *   1. Verify Node.js and the plugin directory look sane.
 *   2. Ensure `dist/` exists (postinstall should have built it, but we
 *      still check so a manual clone also works).
 *   3. `chmod +x` the hook scripts and the bin entrypoint (defensive —
 *      npm should handle this but tarballs sometimes lose the bits).
 *   4. Create `.claude-sonar/reports/` inside the current workspace so
 *      the SARIF store can write without a race on its first ingestion.
 *   5. Print the exact Claude Code command the user needs to run next.
 *
 * Exits 0 on success and 1 on any preparation failure.
 *
 * @module scripts/install
 */

import { promises as fs, constants as fsConstants } from "node:fs";
import { resolve, join } from "node:path";

import { printBanner, printStep, paint, icons } from "./lib/cli-ui.mjs";

/**
 * @typedef {Object} CommandContext
 * @property {string}   pluginRoot Absolute path to the plugin root (this dir).
 * @property {string[]} argv       Remaining CLI arguments after the subcommand name.
 */

/**
 * Entrypoint invoked by `bin/claude-sonar.mjs`.
 *
 * @param {CommandContext} ctx
 * @returns {Promise<number>} Exit code (0 = success, 1 = failure).
 */
export default async function install(ctx) {
  printBanner("claude-sonar :: install");

  const checks = [];
  checks.push(await checkNodeVersion());
  checks.push(await checkDistBuilt(ctx.pluginRoot));
  checks.push(await chmodHooks(ctx.pluginRoot));
  checks.push(await ensureReportsDir(process.cwd()));

  for (const step of checks) printStep(step);

  const hasFailure = checks.some((c) => c.status === "fail");
  if (hasFailure) {
    process.stdout.write(
      `\n${paint.red(icons.fail)} Installation prerequisites failed. ` +
        `Run ${paint.bold("claude-sonar doctor")} for details.\n`,
    );
    return 1;
  }

  // Success — tell the user exactly what to do next. We print the
  // Claude Code native command and also mention the marketplace path
  // for users who cloned the repo from GitHub.
  process.stdout.write(
    [
      "",
      `${paint.green(icons.ok)} claude-sonar is ready to register with Claude Code.`,
      "",
      `  Plugin root: ${paint.cyan(ctx.pluginRoot)}`,
      "",
      paint.bold("  Next steps — pick ONE of the following:"),
      "",
      "  1. Native Claude Code install from this directory:",
      `       ${paint.cyan(`/plugin install ${ctx.pluginRoot}`)}`,
      "",
      "  2. Marketplace install (if the plugin is published to GitHub):",
      `       ${paint.cyan("/plugin marketplace add ahernandez-developer/claude-sonar")}`,
      `       ${paint.cyan("/plugin install claude-sonar")}`,
      "",
      paint.dim("  Then open a Claude Code session in this workspace. The"),
      paint.dim("  PreToolUse gatekeeper, PostToolUse verifier, Stop quality"),
      paint.dim("  gate, and the local Vue dashboard will all start on their"),
      paint.dim("  own. Run `claude-sonar doctor` any time to re-verify."),
      "",
    ].join("\n"),
  );
  return 0;
}

/**
 * Verify the Node.js major version is at least 20 (matches `engines`
 * in package.json).
 *
 * @returns {Promise<import("./lib/cli-ui.mjs").StepResult>}
 */
async function checkNodeVersion() {
  const raw = process.versions.node;
  const major = Number(raw.split(".")[0]);
  if (!Number.isFinite(major) || major < 20) {
    return {
      status: "fail",
      label: `Node.js runtime`,
      detail: `Found ${raw}, claude-sonar requires ≥ 20.0.0. Install a newer Node.js and retry.`,
    };
  }
  return { status: "ok", label: `Node.js runtime (${raw})` };
}

/**
 * Check that `dist/index.js` exists. The postinstall hook should have
 * built it automatically; this is a safety net for users who pulled
 * the repo without running `npm install`.
 *
 * @param {string} pluginRoot
 * @returns {Promise<import("./lib/cli-ui.mjs").StepResult>}
 */
async function checkDistBuilt(pluginRoot) {
  const entry = join(pluginRoot, "dist", "index.js");
  try {
    await fs.access(entry);
    return { status: "ok", label: `MCP server is built`, detail: entry };
  } catch {
    return {
      status: "fail",
      label: `MCP server is NOT built`,
      detail: `Expected ${entry}. Run \`npm run build\` from the plugin root.`,
    };
  }
}

/**
 * Ensure every hook script is marked executable. npm usually handles
 * this via the `files` field in package.json, but tarballs extracted
 * manually or pulled over non-UNIX filesystems sometimes lose the bit.
 *
 * @param {string} pluginRoot
 * @returns {Promise<import("./lib/cli-ui.mjs").StepResult>}
 */
async function chmodHooks(pluginRoot) {
  const hookDir = join(pluginRoot, "hooks");
  const entries = ["pre-tool-use.mjs", "post-tool-use.mjs", "stop-quality-gate.mjs", "session-start.mjs"];
  const fixed = [];
  for (const name of entries) {
    const full = join(hookDir, name);
    try {
      await fs.access(full, fsConstants.F_OK);
      await fs.chmod(full, 0o755);
      fixed.push(name);
    } catch {
      return {
        status: "fail",
        label: `Hook scripts are executable`,
        detail: `Missing ${full}`,
      };
    }
  }
  return {
    status: "ok",
    label: `Hook scripts are executable`,
    detail: fixed.join(", "),
  };
}

/**
 * Ensure the SARIF reports directory exists inside the current
 * workspace so the first ingestion doesn't race with a missing dir.
 * This is a separate directory from the plugin root — it lives in the
 * user's project, not the plugin's install location.
 *
 * @param {string} workspace
 * @returns {Promise<import("./lib/cli-ui.mjs").StepResult>}
 */
async function ensureReportsDir(workspace) {
  const dir = resolve(workspace, ".claude-sonar", "reports");
  try {
    await fs.mkdir(dir, { recursive: true });
    return {
      status: "ok",
      label: `SARIF reports directory ready`,
      detail: dir,
    };
  } catch (err) {
    return {
      status: "warn",
      label: `Could not create reports directory`,
      detail: `${dir} :: ${/** @type {Error} */ (err).message}`,
    };
  }
}
