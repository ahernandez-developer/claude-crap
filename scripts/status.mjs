// @ts-check
/**
 * `claude-sonar status` — show resolved paths and runtime state.
 *
 * Designed to be the first thing you run when someone asks
 * "is claude-sonar working?". It reports:
 *
 *   - Plugin version (from package.json)
 *   - Plugin root (where the CLI resolved it to)
 *   - Node.js version in use
 *   - Whether dist/ is built
 *   - Whether the SARIF store has a consolidated report yet
 *   - Currently configured thresholds (CRAP, TDR rating, LOC cost)
 *
 * Does not attempt to verify anything — that's what `doctor` is for.
 * Always exits 0.
 *
 * @module scripts/status
 */

import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";

import { printBanner, printKv, paint } from "./lib/cli-ui.mjs";

/**
 * @typedef {Object} CommandContext
 * @property {string}   pluginRoot
 * @property {string[]} argv
 */

/**
 * Status entrypoint.
 *
 * @param {CommandContext} ctx
 * @returns {Promise<number>}
 */
export default async function status(ctx) {
  printBanner("claude-sonar :: status");

  // -- plugin version
  const pkg = await readJson(join(ctx.pluginRoot, "package.json"));
  printKv("version", String(pkg.version ?? "unknown"));

  // -- plugin root
  printKv("plugin root", ctx.pluginRoot);
  printKv("workspace cwd", process.cwd());
  printKv("Node.js", process.versions.node);

  // -- entrypoints
  const distEntry = join(ctx.pluginRoot, "dist", "index.js");
  const distOk = await exists(distEntry);
  printKv("dist/index.js", distOk ? paint.green("built") : paint.red("MISSING"));

  const gitEntry = join(ctx.pluginRoot, "plugin", "bundle", "mcp-server.mjs");
  const gitOk = await exists(gitEntry);
  printKv("plugin/bundle/...", gitOk ? paint.green("built") : paint.red("MISSING"));

  // -- SARIF store
  const sarifDir = resolve(process.cwd(), ".claude-sonar", "reports");
  const sarifPath = join(sarifDir, "latest.sarif");
  const sarifOk = await exists(sarifPath);
  printKv("SARIF report", sarifOk ? sarifPath : paint.yellow("<not yet generated>"));

  // -- dashboard port
  const port = process.env.CLAUDE_PLUGIN_OPTION_DASHBOARD_PORT ?? "5117";
  printKv("dashboard port", port);

  // -- thresholds
  process.stdout.write(`\n${paint.bold("  Current policy (from env):")}\n`);
  printKv("CRAP threshold", process.env.CLAUDE_PLUGIN_OPTION_CRAP_THRESHOLD ?? "30 (default)");
  printKv("TDR max rating", process.env.CLAUDE_PLUGIN_OPTION_TDR_MAINTAINABILITY_MAX_RATING ?? "C (default)");
  printKv("minutes / LOC", process.env.CLAUDE_PLUGIN_OPTION_MINUTES_PER_LINE_OF_CODE ?? "30 (default)");

  process.stdout.write(
    `\n${paint.dim("Run `claude-sonar doctor` for a full diagnostic pass.")}\n`,
  );
  return 0;
}

/**
 * Read and parse a JSON file. Returns `{}` when the file is missing
 * so the caller's property accesses always work.
 *
 * @param {string} path
 * @returns {Promise<Record<string, unknown>>}
 */
async function readJson(path) {
  try {
    const raw = await fs.readFile(path, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * `true` when `path` exists on disk and is readable.
 *
 * @param {string} path
 * @returns {Promise<boolean>}
 */
async function exists(path) {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}
