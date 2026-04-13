/**
 * Cyclomatic complexity scanner.
 *
 * Walks the workspace, analyzes each supported source file with
 * tree-sitter, and emits SARIF findings for functions whose cyclomatic
 * complexity exceeds the configured threshold (`cyclomaticMax`).
 *
 * This scanner is an internal analyzer — it is NOT a "known scanner"
 * in the `KnownScanner` union (eslint/semgrep/bandit/stryker). It
 * bypasses the adapter pipeline and writes SARIF directly via
 * `wrapResultsInSarif()` from the common adapter helpers.
 *
 * Severity mapping:
 *   - `warning` — CC > threshold but < 2× threshold
 *   - `error`   — CC >= 2× threshold (aligns with CRAP index hard block at CC >= 30)
 *
 * @module scanner/complexity-scanner
 */

import { promises as fs } from "node:fs";
import { join, relative } from "node:path";
import type { Logger } from "pino";

import { TreeSitterEngine } from "../ast/tree-sitter-engine.js";
import { detectLanguageFromPath } from "../ast/language-config.js";
import { wrapResultsInSarif, estimateEffortMinutes } from "../adapters/common.js";
import type { SarifStore } from "../sarif/sarif-store.js";
import type { SarifLevel } from "../sarif/sarif-builder.js";

// ── Constants ─────────────────────────────────────────────────────

/** Directories that should never be scanned. Mirrors `workspace-walker.ts`. */
const SKIP_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "bundle",
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

/** Hard cap on files to prevent unbounded analysis. */
const MAX_FILES = 20_000;

/** SARIF rule ID for cyclomatic complexity violations. */
const RULE_ID = "complexity/cyclomatic-max";

/** Source tool identifier used in SARIF properties. */
const SOURCE_TOOL = "complexity";

// ── Types ─────────────────────────────────────────────────────────

/** Result of a complexity scan run. */
export interface ComplexityScanResult {
  /** Number of source files successfully analyzed. */
  readonly filesScanned: number;
  /** Total number of functions found across all files. */
  readonly functionsAnalyzed: number;
  /** Number of functions that exceeded the threshold. */
  readonly violations: number;
  /** Wall-clock time for the entire scan. */
  readonly durationMs: number;
}

/** Configuration accepted by the scanner. */
export interface ComplexityScanConfig {
  /** Maximum cyclomatic complexity allowed per function. */
  readonly cyclomaticMax: number;
}

// ── Scanner ───────────────────────────────────────────────────────

/**
 * Scan a workspace for cyclomatic complexity violations.
 *
 * Walks the directory tree, analyzes each source file with the
 * tree-sitter engine, and emits SARIF findings for functions above
 * the configured threshold. Findings are ingested into the provided
 * `SarifStore` and persisted to disk.
 *
 * @param workspaceRoot Absolute path to the workspace root.
 * @param engine        Initialized tree-sitter engine instance.
 * @param sarifStore    Live SARIF store to ingest findings into.
 * @param config        Scanner configuration (threshold).
 * @param logger        Pino logger for progress and error reporting.
 * @returns             Summary of what was scanned and found.
 */
export async function scanComplexity(
  workspaceRoot: string,
  engine: TreeSitterEngine,
  sarifStore: SarifStore,
  config: ComplexityScanConfig,
  logger: Logger,
): Promise<ComplexityScanResult> {
  const start = Date.now();
  const threshold = config.cyclomaticMax;
  const errorThreshold = threshold * 2;

  // 1. Collect supported source files
  const files = await collectSourceFiles(workspaceRoot);
  logger.info(
    { fileCount: files.length, threshold },
    "complexity-scanner: starting analysis",
  );

  // 2. Analyze each file and collect violations
  const sarifResults: object[] = [];
  let filesScanned = 0;
  let functionsAnalyzed = 0;
  let violations = 0;

  for (const filePath of files) {
    const language = detectLanguageFromPath(filePath);
    if (!language) continue;

    try {
      const metrics = await engine.analyzeFile({ filePath, language });
      filesScanned += 1;
      functionsAnalyzed += metrics.functions.length;

      for (const fn of metrics.functions) {
        if (fn.cyclomaticComplexity <= threshold) continue;

        const level: SarifLevel =
          fn.cyclomaticComplexity >= errorThreshold ? "error" : "warning";

        const relPath = relative(workspaceRoot, filePath);

        sarifResults.push({
          ruleId: RULE_ID,
          level,
          message: {
            text: `Function '${fn.name}' has cyclomatic complexity ${fn.cyclomaticComplexity} (threshold: ${threshold})`,
          },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: relPath },
                region: {
                  startLine: fn.startLine,
                  startColumn: 1,
                  endLine: fn.endLine,
                  endColumn: 1,
                },
              },
            },
          ],
          properties: {
            sourceTool: SOURCE_TOOL,
            effortMinutes: estimateEffortMinutes(level),
            cyclomaticComplexity: fn.cyclomaticComplexity,
          },
        });
        violations += 1;
      }
    } catch (err) {
      logger.warn(
        { filePath, err: (err as Error).message },
        "complexity-scanner: failed to analyze file, skipping",
      );
    }
  }

  // 3. Ingest findings into the SARIF store
  if (sarifResults.length > 0) {
    const document = wrapResultsInSarif(
      SOURCE_TOOL as never,
      "0.1.0",
      sarifResults,
    );
    sarifStore.ingestRun(document, SOURCE_TOOL);
    await sarifStore.persist();
  }

  const durationMs = Date.now() - start;
  logger.info(
    { filesScanned, functionsAnalyzed, violations, durationMs },
    "complexity-scanner: analysis complete",
  );

  return { filesScanned, functionsAnalyzed, violations, durationMs };
}

// ── File walker ───────────────────────────────────────────────────

/**
 * Collect source files from the workspace that the tree-sitter engine
 * can analyze. Skips directories in `SKIP_DIRS` and hidden directories.
 * Only returns files whose extension maps to a supported language.
 */
async function collectSourceFiles(workspaceRoot: string): Promise<string[]> {
  const files: string[] = [];
  let truncated = false;

  async function walk(dir: string): Promise<void> {
    if (truncated) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (truncated) return;
      if (entry.name.startsWith(".") && entry.name !== ".claude-plugin") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      // Only include files the tree-sitter engine can parse
      if (!detectLanguageFromPath(entry.name)) continue;
      files.push(full);
      if (files.length >= MAX_FILES) {
        truncated = true;
        return;
      }
    }
  }

  await walk(workspaceRoot);
  return files;
}
