// @ts-check
/**
 * npm `postinstall` hook for the claude-sonar package.
 *
 * Runs automatically after every `npm install` (or
 * `npx @sr-herz/claude-sonar install` of the package). Its only job
 * is to make sure `dist/` exists
 * so the MCP server, the hooks, and the dashboard can all start
 * without a pre-build step from the user. We intentionally keep this
 * tiny — heavier validation belongs in `doctor`.
 *
 * Behavior:
 *
 *   - If `dist/index.js` already exists, print a one-line welcome and
 *     exit 0. This is the common case when the package was installed
 *     from a pre-built npm tarball.
 *   - Otherwise spawn `tsc -p tsconfig.json` to build `dist/` from the
 *     shipped `src/` sources. If that fails, print a warning with the
 *     exact command the user can run manually, but still exit 0 so
 *     `npm install` is not aborted (the user may still want a
 *     source-only install for inspection).
 *   - npm sets `INIT_CWD` to the package being installed — we use
 *     that to resolve paths so `npm install claude-sonar` from a
 *     parent project also works.
 *
 * We never write to stdout unless we have something useful to say,
 * to stay friendly inside larger `npm install` output.
 *
 * @module scripts/postinstall
 */

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Skip the whole postinstall during `npm ci` in production-only
// environments where build tools may be missing. Users can opt out
// by setting `CLAUDE_SONAR_SKIP_POSTINSTALL=1`.
if (process.env.CLAUDE_SONAR_SKIP_POSTINSTALL) {
  process.exit(0);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(HERE, "..");

/** @returns {Promise<boolean>} */
async function distIsBuilt() {
  try {
    await fs.access(join(PLUGIN_ROOT, "dist", "index.js"));
    return true;
  } catch {
    return false;
  }
}

/**
 * Spawn `tsc` (via npx so it resolves from the package's own devDeps)
 * and pipe its output through to stderr so the user sees build errors
 * in context with the rest of the npm install output.
 *
 * @returns {Promise<number>} Exit code from tsc.
 */
function runBuild() {
  return new Promise((resolvePromise) => {
    const child = spawn(
      process.execPath,
      [join(PLUGIN_ROOT, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.json"],
      { cwd: PLUGIN_ROOT, stdio: ["ignore", "inherit", "inherit"] },
    );
    child.on("exit", (code) => resolvePromise(code ?? 1));
    child.on("error", () => resolvePromise(1));
  });
}

async function main() {
  // Already built? One-line banner and we're done.
  if (await distIsBuilt()) {
    process.stderr.write(
      "claude-sonar: ✓ prebuilt dist/ detected. Run `npx @sr-herz/claude-sonar install` to finish setup.\n",
    );
    return;
  }

  // Not built yet — try to build with the bundled TypeScript. If
  // TypeScript is missing (production-only install), warn and exit.
  try {
    await fs.access(join(PLUGIN_ROOT, "node_modules", "typescript", "bin", "tsc"));
  } catch {
    process.stderr.write(
      "claude-sonar: ! dist/ is missing and TypeScript is not installed. " +
        "Run `npm install` with devDependencies enabled and then `npx @sr-herz/claude-sonar install`.\n",
    );
    return;
  }

  process.stderr.write("claude-sonar: building dist/ ...\n");
  const code = await runBuild();
  if (code !== 0) {
    process.stderr.write(
      `claude-sonar: ! build failed (tsc exit ${code}). ` +
        `Run \`npm run build\` from ${PLUGIN_ROOT} to see the full error.\n`,
    );
    return;
  }
  process.stderr.write("claude-sonar: ✓ build complete. Next: `npx @sr-herz/claude-sonar install`.\n");
}

main().catch((err) => {
  process.stderr.write(`claude-sonar postinstall: ${err?.message ?? err}\n`);
  // Do not fail the install — the user can still run the plugin.
  process.exit(0);
});
