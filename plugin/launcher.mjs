#!/usr/bin/env node
// @ts-check
/**
 * claude-crap :: MCP server launcher — zero-dependency bootstrap wrapper.
 *
 * This file is the actual entry point declared in `.mcp.json`. It
 * ensures the MCP server's runtime dependencies (fastify, pino,
 * tree-sitter, etc.) are installed before the server's static ESM
 * `import` statements fire. Without this guard, a clean install from
 * git would fail with ERR_MODULE_NOT_FOUND because `node_modules/`
 * is not committed to the repository.
 *
 * Design constraints:
 *
 *   - ZERO external dependencies — only Node.js builtins.
 *   - Synchronous check + install so the control flow is linear.
 *   - All output goes to stderr (fd 2) to preserve the MCP JSON-RPC
 *     channel on stdout.
 *   - Must work on macOS, Linux, and Windows.
 *
 * After dependencies are guaranteed to exist, this module dynamically
 * imports `./mcp-server.mjs` which handles the rest of the startup.
 *
 * @module launcher
 */

import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * The plugin root is one level above `bundle/`. This is where
 * `package.json` lives and where `npm install` must run.
 *
 * In the deployed layout:
 *   ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/
 *     ├── package.json          ← PLUGIN_ROOT
 *     ├── node_modules/         ← created by ensureDependencies()
 *     └── bundle/
 *         ├── launcher.mjs      ← this file
 *         └── mcp-server.mjs    ← the real entry point
 */
const PLUGIN_ROOT = resolve(__dirname, "..");

/**
 * Check whether all runtime dependencies are installed. When they are
 * not, run `npm install --omit=dev` synchronously and verify success.
 *
 * The check is deliberately simple: if the `node_modules/` directory
 * exists we assume all packages are present. A more thorough check
 * would resolve every external, but the cost of a false-positive skip
 * is a cryptic ERR_MODULE_NOT_FOUND — vs. a ~5s npm install on first
 * run. Speed wins.
 */
function ensureDependencies() {
  const nodeModulesPath = join(PLUGIN_ROOT, "node_modules");
  if (existsSync(nodeModulesPath)) return; // fast path — already installed

  // ── Report what we're about to install ────────────────────────────
  let depsSummary = "(unable to read package.json)";
  try {
    const pkgPath = join(PLUGIN_ROOT, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    const deps = Object.entries(pkg.dependencies || {});
    depsSummary = deps.map(([n, v]) => `${n}@${v}`).join(", ");
  } catch {
    /* proceed anyway — the install itself will surface any real error */
  }

  process.stderr.write(
    `[claude-crap] node_modules/ not found — installing runtime dependencies...\n` +
      `[claude-crap] deps: ${depsSummary}\n`,
  );

  // ── Run npm install synchronously ─────────────────────────────────
  try {
    execFileSync("npm", [
      "install",
      "--omit=dev",
      "--no-audit",
      "--no-fund",
      "--no-progress",
      "--loglevel=error",
    ], {
      cwd: PLUGIN_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000, // 2 minutes — generous for slow networks
      env: { ...process.env, NODE_ENV: "production" },
    });
    process.stderr.write("[claude-crap] dependencies installed successfully.\n");
  } catch (err) {
    const stderr = /** @type {any} */ (err).stderr?.toString?.() ?? "";
    const lastLines = stderr.split("\n").filter(Boolean).slice(-20).join("\n");
    process.stderr.write(
      `[claude-crap] FATAL: npm install failed (exit ${/** @type {any} */ (err).status ?? "unknown"}).\n` +
        (lastLines ? `${lastLines}\n` : "") +
        `[claude-crap] Try manually: cd "${PLUGIN_ROOT}" && npm install --omit=dev\n`,
    );
    process.exit(1);
  }
}

// ── Bootstrap ─────────────────────────────────────────────────────────
ensureDependencies();

// Now that node_modules/ exists, the static ESM imports inside
// mcp-server.mjs can resolve. Dynamic import avoids top-level
// resolution failures.
await import("./mcp-server.mjs");
