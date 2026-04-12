// @ts-check
/**
 * Shared quality-gate evaluator used by the Stop and SubagentStop hooks.
 *
 * The evaluator is a pure function of:
 *
 *   - the current claude-crap configuration (read from env),
 *   - the consolidated SARIF file on disk (optional — a missing file
 *     is treated as "no findings yet"),
 *   - a coarse workspace LOC count (bounded walk of the project tree).
 *
 * It produces a structured verdict with one `failures[]` entry per
 * violated policy. The calling hook then decides whether to block
 * (exit 2) or allow (exit 0) based on whether any failures were found.
 *
 * Engine imports (CRAP / TDR letter classification) come from the
 * esbuild-produced bundle at `plugin/bundle/tdr-engine.mjs`, so the
 * math stays in one place and the hook cannot drift from the server.
 *
 * @module hooks/lib/quality-gate
 */

import { promises as fs } from "node:fs";
import { resolve, join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

// Import the TDR engines from the bundled MCP server. The relative path
// resolves from `hooks/lib/` up to `plugin/bundle/`. Requires the
// plugin to have been built at least once via `npm run build:plugin`.
const HOOK_DIR = dirname(fileURLToPath(import.meta.url));
const TDR_ENGINE_PATH = resolve(HOOK_DIR, "..", "..", "bundle", "tdr-engine.mjs");

/**
 * @typedef {"A" | "B" | "C" | "D" | "E"} MaintainabilityRating
 */

/**
 * @typedef {Object} QualityGateConfig
 * @property {string}                workspaceRoot          Absolute path to the project root.
 * @property {string}                sarifReportPath        Absolute path to the consolidated SARIF file.
 * @property {number}                crapThreshold
 * @property {MaintainabilityRating} tdrMaxRating
 * @property {number}                minutesPerLoc
 */

/**
 * @typedef {Object} GateFailure
 * @property {string} ruleId
 * @property {string} message
 */

/**
 * @typedef {Object} GateVerdict
 * @property {boolean}                   passed
 * @property {GateFailure[]}             failures
 * @property {Object}                    summary
 * @property {number}                    summary.totalFindings
 * @property {number}                    summary.errorFindings
 * @property {number}                    summary.warningFindings
 * @property {number}                    summary.noteFindings
 * @property {number}                    summary.remediationMinutes
 * @property {number}                    summary.physicalLoc
 * @property {number}                    summary.tdrPercent
 * @property {MaintainabilityRating}     summary.tdrRating
 * @property {string[]}                  summary.toolsSeen
 */

/**
 * Load the claude-crap configuration from environment variables. Hooks
 * read the same `CLAUDE_PLUGIN_OPTION_*` family of variables that the
 * MCP server uses, so the two always agree.
 *
 * @returns {QualityGateConfig}
 */
export function loadQualityGateConfig() {
  const workspaceRoot = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const sarifOutputDir =
    process.env.CLAUDE_PLUGIN_OPTION_SARIF_OUTPUT_DIR ?? ".claude-crap/reports";
  const sarifReportDir = isAbsolute(sarifOutputDir)
    ? sarifOutputDir
    : resolve(workspaceRoot, sarifOutputDir);
  const sarifReportPath = join(sarifReportDir, "latest.sarif");

  const crapThreshold = Number(process.env.CLAUDE_PLUGIN_OPTION_CRAP_THRESHOLD ?? 30);
  const tdrMaxRating = /** @type {MaintainabilityRating} */ (
    process.env.CLAUDE_PLUGIN_OPTION_TDR_MAINTAINABILITY_MAX_RATING ?? "C"
  );
  const minutesPerLoc = Number(process.env.CLAUDE_PLUGIN_OPTION_MINUTES_PER_LINE_OF_CODE ?? 30);

  return { workspaceRoot, sarifReportPath, crapThreshold, tdrMaxRating, minutesPerLoc };
}

/**
 * Read and parse the consolidated SARIF file. Returns an empty findings
 * list when the file does not exist (fresh workspace, no gate runs yet).
 *
 * @param {string} path Absolute path to the SARIF file.
 * @returns {Promise<{findings: Array<{ruleId: string, level: string, uri: string, effortMinutes: number, sourceTool: string}>, toolsSeen: Set<string>}>}
 */
async function readConsolidatedFindings(path) {
  const findings = [];
  const toolsSeen = new Set();
  let raw;
  try {
    raw = await fs.readFile(path, "utf8");
  } catch (err) {
    const error = /** @type {NodeJS.ErrnoException} */ (err);
    if (error.code === "ENOENT") return { findings, toolsSeen };
    throw error;
  }
  const doc = JSON.parse(raw);
  if (!doc || !Array.isArray(doc.runs)) return { findings, toolsSeen };

  for (const run of doc.runs) {
    const results = Array.isArray(run.results) ? run.results : [];
    for (const result of results) {
      const loc = result.locations?.[0]?.physicalLocation;
      const uri = loc?.artifactLocation?.uri ?? "<unknown>";
      const effort =
        typeof result.properties?.effortMinutes === "number"
          ? result.properties.effortMinutes
          : 0;
      const sourceTool =
        typeof result.properties?.sourceTool === "string"
          ? result.properties.sourceTool
          : run.tool?.driver?.name ?? "unknown";
      findings.push({
        ruleId: String(result.ruleId ?? "unknown"),
        level: String(result.level ?? "warning"),
        uri,
        effortMinutes: effort,
        sourceTool,
      });
      toolsSeen.add(sourceTool);
    }
  }
  return { findings, toolsSeen };
}

/**
 * Directories we do not descend into when estimating workspace LOC. These
 * are either dependency caches, build artifacts, or VCS metadata that the
 * TDR policy is not meant to penalize.
 */
const LOC_WALK_SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "target",
  ".venv",
  "venv",
  "__pycache__",
  ".cache",
  ".next",
  ".nuxt",
  ".claude-crap",
  ".codesight",
]);

/**
 * Extensions we treat as "code" for the LOC count. Anything else is
 * ignored by the walker.
 */
const LOC_CODE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".java",
  ".cs",
  ".go",
  ".rs",
  ".rb",
  ".php",
  ".swift",
  ".kt",
  ".scala",
  ".dart",
  ".vue",
]);

/**
 * Maximum number of files the walker will open before giving up. Protects
 * against pathological repos where the walk would dominate the hook's
 * 120-second budget. When hit, we return the partial count and warn.
 */
const MAX_FILES_WALKED = 20_000;

/**
 * Count physical lines of code across the workspace. Skips dependency
 * and build directories and never follows symlinks. Returns the total
 * physical LOC and the number of files it actually read.
 *
 * @param {string} workspaceRoot
 * @returns {Promise<{physicalLoc: number, filesWalked: number, truncated: boolean}>}
 */
export async function estimateWorkspaceLoc(workspaceRoot) {
  let physicalLoc = 0;
  let filesWalked = 0;
  let truncated = false;

  /** @param {string} dir */
  async function walk(dir) {
    if (truncated) return;
    /** @type {import("node:fs").Dirent[]} */
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (truncated) return;
      if (entry.name.startsWith(".") && entry.name !== ".claude-plugin") {
        // Hidden files are skipped except the plugin dir itself (tiny).
        continue;
      }
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (LOC_WALK_SKIP_DIRS.has(entry.name)) continue;
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const lower = entry.name.toLowerCase();
      const dot = lower.lastIndexOf(".");
      if (dot < 0) continue;
      const ext = lower.substring(dot);
      if (!LOC_CODE_EXTENSIONS.has(ext)) continue;
      filesWalked += 1;
      if (filesWalked > MAX_FILES_WALKED) {
        truncated = true;
        return;
      }
      try {
        const content = await fs.readFile(full, "utf8");
        if (content.length > 0) {
          // `split(/\r?\n/)` overcounts by 1 when the file ends in a
          // newline, so we fix that here to match editor behavior.
          const newlineCount = content.split(/\r?\n/).length;
          physicalLoc += content.endsWith("\n") ? newlineCount - 1 : newlineCount;
        }
      } catch {
        // Unreadable file (permissions, binary). Skip silently.
      }
    }
  }

  await walk(workspaceRoot);
  return { physicalLoc, filesWalked, truncated };
}

/**
 * Evaluate the quality gate against the current workspace state. Pure
 * function of its inputs — perform side effects (stdout / stderr / exit)
 * in the calling hook script.
 *
 * @param {QualityGateConfig} config
 * @returns {Promise<GateVerdict>}
 */
export async function evaluateQualityGate(config) {
  const { classifyTdr, ratingIsWorseThan } = await import(TDR_ENGINE_PATH);

  const { findings, toolsSeen } = await readConsolidatedFindings(config.sarifReportPath);
  const { physicalLoc } = await estimateWorkspaceLoc(config.workspaceRoot);

  const remediationMinutes = findings.reduce((sum, f) => sum + f.effortMinutes, 0);
  const errorFindings = findings.filter((f) => f.level === "error").length;
  const warningFindings = findings.filter((f) => f.level === "warning").length;
  const noteFindings = findings.filter((f) => f.level === "note").length;

  // Guard against divide-by-zero on a truly empty workspace.
  const safeLoc = Math.max(physicalLoc, 1);
  const developmentCost = config.minutesPerLoc * safeLoc;
  const tdrPercent = (remediationMinutes / developmentCost) * 100;
  const tdrRating = /** @type {MaintainabilityRating} */ (classifyTdr(tdrPercent));

  /** @type {GateFailure[]} */
  const failures = [];

  // Policy 1 — TDR rating must not exceed the configured tolerance.
  if (ratingIsWorseThan(tdrRating, config.tdrMaxRating)) {
    failures.push({
      ruleId: "SONAR-GATE-TDR",
      message:
        `Maintainability rating ${tdrRating} is worse than the policy limit ` +
        `${config.tdrMaxRating}. Current TDR = ${tdrPercent.toFixed(2)}% ` +
        `(${remediationMinutes} min of remediation over ${physicalLoc} LOC). ` +
        `Corrective action: resolve enough findings to reduce the TDR below the bracket for ` +
        `rating ${config.tdrMaxRating}, then re-run the Stop hook.`,
    });
  }

  // Policy 2 — no error-level findings may survive the gate.
  if (errorFindings > 0) {
    failures.push({
      ruleId: "SONAR-GATE-ERRORS",
      message:
        `The consolidated SARIF report contains ${errorFindings} finding(s) at level "error". ` +
        `CLAUDE.md forbids closing a task with unresolved reliability or security errors. ` +
        `Corrective action: open 'sonar://reports/latest.sarif' via the MCP server and fix every ` +
        `error-level finding before retrying the Stop hook.`,
    });
  }

  return {
    passed: failures.length === 0,
    failures,
    summary: {
      totalFindings: findings.length,
      errorFindings,
      warningFindings,
      noteFindings,
      remediationMinutes,
      physicalLoc,
      tdrPercent: Number(tdrPercent.toFixed(4)),
      tdrRating,
      toolsSeen: Array.from(toolsSeen),
    },
  };
}
