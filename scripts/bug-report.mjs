// @ts-check
/**
 * `claude-crap bug-report` — generate a diagnostic bundle for triage.
 *
 * Inspired by claude-mem's `npm run bug-report`. Collects every piece
 * of information a maintainer typically asks for when triaging an
 * issue and writes it to a single Markdown file under the current
 * workspace (or stdout with `--stdout`).
 *
 * The report never contains secrets — we redact every environment
 * variable whose name looks sensitive (`*TOKEN`, `*KEY`, `*PASSWORD`,
 * etc.) before writing it. The user should still skim the file before
 * pasting it into a public issue, but the defaults are safe.
 *
 * Contents of the report:
 *
 *   1. Header — timestamp, plugin version, Node version, OS
 *   2. Plugin file presence (same 9 files the doctor checks)
 *   3. Resolved CLAUDE_PLUGIN_OPTION_* env vars (redacted)
 *   4. Build state — `dist/index.js` mtime and size
 *   5. `doctor` output — we run the doctor subcommand and capture its stdout
 *   6. Recent SARIF report summary if one exists
 *   7. Hook script permission bits
 *
 * Usage:
 *
 *   node ./scripts/bug-report.mjs            # writes ./claude-crap-bug-report-<ts>.md
 *   node ./scripts/bug-report.mjs --stdout   # prints to stdout instead
 *   node ./scripts/bug-report.mjs -o foo.md  # explicit output path
 *
 * Exits 0 on success regardless of individual check outcomes —
 * collecting the report is the goal, not passing every probe.
 *
 * @module scripts/bug-report
 */

import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import { arch, platform, release, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(HERE, "..");

const REQUIRED_FILES = [
  "package.json",
  "plugin/.claude-plugin/plugin.json",
  "plugin/.mcp.json",
  "plugin/CLAUDE.md",
  "plugin/hooks/hooks.json",
  "plugin/hooks/pre-tool-use.mjs",
  "plugin/hooks/post-tool-use.mjs",
  "plugin/hooks/stop-quality-gate.mjs",
  "plugin/hooks/session-start.mjs",
  "dist/index.js",
  "plugin/bundle/mcp-server.mjs",
];

/**
 * Regex identifying env var names that should be redacted. We never
 * write the actual value for matches — just the name and `<redacted>`.
 */
const SENSITIVE_ENV_PATTERN = /(TOKEN|KEY|SECRET|PASSWORD|AUTH|COOKIE|CREDENTIAL|BEARER)/i;

/**
 * Entry point. When required as a module, use {@link generateBugReport}
 * directly — this default export is just the CLI wrapper.
 *
 * @param {{pluginRoot: string, argv: string[]}} ctx
 * @returns {Promise<number>}
 */
export default async function bugReportCommand(ctx) {
  const argv = ctx.argv;
  const useStdout = argv.includes("--stdout");
  const outIdx = argv.indexOf("-o");
  const explicitOut = outIdx >= 0 ? argv[outIdx + 1] : undefined;

  const report = await generateBugReport(ctx.pluginRoot);

  if (useStdout) {
    process.stdout.write(report);
    return 0;
  }

  const outPath =
    explicitOut ??
    join(process.cwd(), `claude-crap-bug-report-${timestampSlug()}.md`);
  await fs.writeFile(outPath, report, "utf8");
  process.stdout.write(`claude-crap: bug report written to ${outPath}\n`);
  return 0;
}

/**
 * Build the full Markdown bug report string. Pure-ish — reads env and
 * filesystem but does not write anywhere. Exported so other scripts
 * (or tests) can embed it without shelling out.
 *
 * @param {string} pluginRoot Absolute plugin root.
 * @returns {Promise<string>}
 */
export async function generateBugReport(pluginRoot) {
  const lines = [];

  // --- header ---
  lines.push(`# claude-crap bug report`);
  lines.push("");
  lines.push(`_Generated: ${new Date().toISOString()}_`);
  lines.push("");

  const version = await readPackageVersion(pluginRoot);
  lines.push(`| Field | Value |`);
  lines.push(`| --- | --- |`);
  lines.push(`| claude-crap version | \`${version}\` |`);
  lines.push(`| Node.js | \`${process.versions.node}\` |`);
  lines.push(`| npm | \`${tryExec("npm", ["-v"])}\` |`);
  lines.push(`| Platform | \`${platform()} ${release()} ${arch()}\` |`);
  lines.push(`| Shell | \`${process.env.SHELL ?? "unknown"}\` |`);
  lines.push(`| User (login) | \`${safeUser()}\` |`);
  lines.push(`| CWD | \`${process.cwd()}\` |`);
  lines.push(`| Plugin root | \`${pluginRoot}\` |`);
  lines.push("");

  // --- plugin files ---
  lines.push(`## Plugin files`);
  lines.push("");
  lines.push(`| File | Present |`);
  lines.push(`| --- | :---: |`);
  for (const rel of REQUIRED_FILES) {
    const full = join(pluginRoot, rel);
    const present = await exists(full);
    lines.push(`| \`${rel}\` | ${present ? "✅" : "❌"} |`);
  }
  lines.push("");

  // --- build state ---
  lines.push(`## Build state`);
  lines.push("");
  const distEntry = join(pluginRoot, "dist", "index.js");
  try {
    const stat = await fs.stat(distEntry);
    lines.push(`- npm entry: \`${distEntry}\``);
    lines.push(`  - Size: ${stat.size} bytes`);
    lines.push(`  - Modified: ${new Date(stat.mtimeMs).toISOString()}`);
  } catch {
    lines.push(`- npm entry: \`${distEntry}\` is missing. Run \`npm run build\`.`);
  }
  const gitEntry = join(pluginRoot, "plugin", "bundle", "mcp-server.mjs");
  try {
    const stat = await fs.stat(gitEntry);
    lines.push(`- git entry: \`${gitEntry}\``);
    lines.push(`  - Size: ${stat.size} bytes`);
    lines.push(`  - Modified: ${new Date(stat.mtimeMs).toISOString()}`);
  } catch {
    lines.push(`- git entry: \`${gitEntry}\` is missing. Run \`npm run build:plugin\`.`);
  }
  lines.push("");

  // --- env vars (redacted) ---
  lines.push(`## Environment (CLAUDE_* + CLAUDE_PLUGIN_OPTION_*, redacted)`);
  lines.push("");
  const relevantEnv = Object.entries(process.env)
    .filter(([k]) => k.startsWith("CLAUDE"))
    .sort(([a], [b]) => a.localeCompare(b));
  if (relevantEnv.length === 0) {
    lines.push(`_No claude-crap env vars set._`);
  } else {
    lines.push("```");
    for (const [k, v] of relevantEnv) {
      const value =
        SENSITIVE_ENV_PATTERN.test(k) && v && v.length > 0 ? "<redacted>" : String(v ?? "");
      lines.push(`${k}=${value}`);
    }
    lines.push("```");
  }
  lines.push("");

  // --- doctor output ---
  lines.push(`## \`claude-crap doctor\` output`);
  lines.push("");
  lines.push("```");
  const doctorBin = join(pluginRoot, "bin", "claude-crap.mjs");
  const doctor = spawnSync(process.execPath, [doctorBin, "doctor"], {
    env: { ...process.env, NO_COLOR: "1" },
    encoding: "utf8",
  });
  lines.push(stripAnsi(doctor.stdout ?? ""));
  if (doctor.stderr) lines.push(stripAnsi(doctor.stderr));
  lines.push(`[exit code: ${doctor.status ?? "null"}]`);
  lines.push("```");
  lines.push("");

  // --- SARIF report (if any) ---
  lines.push(`## Consolidated SARIF report`);
  lines.push("");
  const sarifPath = join(process.cwd(), ".claude-crap", "reports", "latest.sarif");
  if (await exists(sarifPath)) {
    try {
      const raw = await fs.readFile(sarifPath, "utf8");
      const doc = JSON.parse(raw);
      const findings =
        Array.isArray(doc?.runs) && Array.isArray(doc.runs[0]?.results)
          ? doc.runs[0].results.length
          : 0;
      lines.push(`- Path: \`${sarifPath}\``);
      lines.push(`- SARIF version: \`${doc.version ?? "unknown"}\``);
      lines.push(`- Findings: ${findings}`);
    } catch (err) {
      lines.push(`- Could not parse \`${sarifPath}\`: ${/** @type {Error} */ (err).message}`);
    }
  } else {
    lines.push(`_No consolidated SARIF report at \`${sarifPath}\` yet._`);
  }
  lines.push("");

  // --- footer ---
  lines.push(`## How to file this`);
  lines.push("");
  lines.push(
    `1. Review this file for anything sensitive that slipped past the redactor.`,
  );
  lines.push(`2. Open a new issue at the plugin repository.`);
  lines.push(`3. Paste this entire file as the issue body, or attach it directly.`);
  lines.push("");

  return lines.join("\n") + "\n";
}

/**
 * Read the plugin version from `package.json`.
 *
 * @param {string} pluginRoot
 * @returns {Promise<string>}
 */
async function readPackageVersion(pluginRoot) {
  try {
    const require_ = createRequire(import.meta.url);
    const pkg = require_(join(pluginRoot, "package.json"));
    return String(pkg.version ?? "unknown");
  } catch {
    return "unknown";
  }
}

/**
 * Run a shell command and return its trimmed stdout, or `"unknown"`
 * when it fails. Used for optional diagnostics like `npm -v` that
 * should never fail the report.
 *
 * @param {string}   cmd
 * @param {string[]} args
 * @returns {string}
 */
function tryExec(cmd, args) {
  try {
    const r = spawnSync(cmd, args, { encoding: "utf8" });
    return (r.stdout ?? "unknown").trim();
  } catch {
    return "unknown";
  }
}

/**
 * Return the current login name, defaulting to `"unknown"` when we
 * cannot read it (sandboxed environments, non-interactive runs).
 *
 * @returns {string}
 */
function safeUser() {
  try {
    return userInfo().username;
  } catch {
    return "unknown";
  }
}

/**
 * `true` when `path` exists on disk.
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

/**
 * Strip ANSI color escapes from a string. The doctor command inherits
 * `NO_COLOR=1` so its output should already be plain, but we defend
 * against pino loggers or npm wrappers that inject colors anyway.
 *
 * @param {string} input
 * @returns {string}
 */
function stripAnsi(input) {
  // eslint-disable-next-line no-control-regex
  return input.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Filesystem-safe ISO timestamp suitable for a filename (no colons).
 *
 * @returns {string}
 */
function timestampSlug() {
  return new Date().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "");
}

// When run directly via `node ./scripts/bug-report.mjs`, delegate to
// the CLI wrapper. When imported by bin/claude-crap.mjs, the default
// export is consumed instead.
const isDirectInvocation =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("bug-report.mjs");
if (isDirectInvocation) {
  bugReportCommand({ pluginRoot: PLUGIN_ROOT, argv: process.argv.slice(2) })
    .then((code) => process.exit(code ?? 0))
    .catch((err) => {
      process.stderr.write(`claude-crap bug-report: ${err?.message ?? err}\n`);
      process.exit(1);
    });
}
