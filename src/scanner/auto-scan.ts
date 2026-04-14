/**
 * Orchestrator: detect available scanners, run them, and ingest results.
 *
 * This module ties together the detector, runner, and adapter pipeline
 * into a single `autoScan()` function that:
 *
 *   1. Probes the workspace for available scanners
 *   2. Executes detected scanners in parallel
 *   3. Routes each scanner's output through its adapter
 *   4. Ingests the normalized SARIF into the store
 *
 * The function is designed to be called:
 *   - At MCP server boot (fire-and-forget, non-blocking)
 *   - On demand via the `auto_scan` MCP tool
 *
 * Failures in individual scanners are logged and skipped — a broken
 * Semgrep install should not prevent ESLint from running.
 *
 * @module scanner/auto-scan
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "pino";
import {
  detectScanners,
  detectMonorepoScanners,
  mergeMonorepoDetections,
  type ScannerDetection,
} from "./detector.js";
import { runScanner, type ScannerRunResult } from "./runner.js";
import { bootstrapScanner } from "./bootstrap.js";
import { scanComplexity, type ComplexityScanResult } from "./complexity-scanner.js";
import { adaptScannerOutput, type KnownScanner } from "../adapters/index.js";
import type { TreeSitterEngine } from "../ast/tree-sitter-engine.js";
import type { SarifStore } from "../sarif/sarif-store.js";

// ── Types ──────────────────────────────────────────────────────────

/**
 * Per-scanner result within the auto-scan summary.
 */
export interface ScannerResult {
  scanner: KnownScanner;
  success: boolean;
  findingsIngested: number;
  durationMs: number;
  error?: string;
}

/**
 * Complete result of an auto-scan run.
 */
export interface AutoScanResult {
  /** Detection results for all four scanners. */
  detected: ScannerDetection[];
  /** Execution + ingestion results for scanners that were available. */
  results: ScannerResult[];
  /** Total findings ingested across all scanners. */
  totalFindings: number;
  /** Wall-clock time for the entire auto-scan. */
  totalDurationMs: number;
  /** Result of the built-in cyclomatic complexity scan, when enabled. */
  complexityScan?: ComplexityScanResult;
}

// ── Orchestrator ───────────────────────────────────────────────────

/**
 * Ingest a single scanner's raw output through its adapter and into
 * the SARIF store. Returns the number of accepted findings.
 */
function ingestScannerRun(
  scanner: KnownScanner,
  rawOutput: string,
  sarifStore: SarifStore,
): { accepted: number } {
  // Parse the raw output — adapters accept string or object
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawOutput);
  } catch {
    // Semgrep outputs SARIF as a string, others are JSON.
    // If parsing fails, pass the raw string to the adapter.
    parsed = rawOutput;
  }

  const adapted = adaptScannerOutput(scanner, parsed);
  const stats = sarifStore.ingestRun(adapted.document, adapted.sourceTool);
  return { accepted: stats.accepted };
}

/**
 * Auto-detect, run, and ingest all available scanners.
 *
 * @param workspaceRoot Absolute path to the project root.
 * @param sarifStore    Live SARIF store to ingest findings into.
 * @param logger        Pino logger for progress and error reporting.
 * @returns             Summary of what was detected, run, and ingested.
 */
export async function autoScan(
  workspaceRoot: string,
  sarifStore: SarifStore,
  logger: Logger,
  options?: { engine?: TreeSitterEngine; cyclomaticMax?: number; exclude?: ReadonlyArray<string> },
): Promise<AutoScanResult> {
  const start = Date.now();

  // 1. Detect available scanners (root + monorepo subdirs).
  //    mergeMonorepoDetections preserves every (scanner, workingDir)
  //    pair so a root ESLint config does NOT shadow an apps/app or
  //    apps/www ESLint config — each sub-project gets its own
  //    invocation in a polyglot monorepo.
  const rootDetected = await detectScanners(workspaceRoot);
  const monorepoDetected = await detectMonorepoScanners(workspaceRoot);
  const detected = mergeMonorepoDetections(rootDetected, monorepoDetected);

  const available = detected.filter((d) => d.available);

  logger.info(
    {
      detected: detected.map((d) => `${d.scanner}:${d.available}`),
      monorepo: monorepoDetected.length,
      available: available.length,
    },
    "auto-scan: detection complete",
  );

  // If ESLint is detected (e.g. in package.json) but has no config file,
  // bootstrap will create one before we try to scan.
  const eslintConfigFiles = [
    "eslint.config.js", "eslint.config.mjs", "eslint.config.cjs",
    "eslint.config.ts", "eslint.config.mts", "eslint.config.cts",
    ".eslintrc.js", ".eslintrc.cjs", ".eslintrc.yaml",
    ".eslintrc.yml", ".eslintrc.json",
  ];
  const eslintDetected = available.some((d) => d.scanner === "eslint");
  const hasEslintConfig = eslintConfigFiles.some((f) => existsSync(join(workspaceRoot, f)));

  if (eslintDetected && !hasEslintConfig) {
    logger.info("auto-scan: ESLint detected but no config — running bootstrap");
    try {
      const bootstrapResult = await bootstrapScanner(workspaceRoot, sarifStore, logger);
      if (bootstrapResult.autoScanResult) {
        return bootstrapResult.autoScanResult;
      }
    } catch (err) {
      logger.warn(
        { err: (err as Error).message },
        "auto-scan: bootstrap config creation failed",
      );
    }
  }

  if (available.length === 0) {
    // No scanners configured — try to bootstrap one automatically.
    logger.info("auto-scan: no scanners found, attempting bootstrap");
    try {
      const bootstrapResult = await bootstrapScanner(workspaceRoot, sarifStore, logger);
      if (bootstrapResult.autoScanResult) {
        return bootstrapResult.autoScanResult;
      }
    } catch (err) {
      logger.warn(
        { err: (err as Error).message },
        "auto-scan: bootstrap failed — continuing with empty results",
      );
    }

    return {
      detected,
      results: [],
      totalFindings: 0,
      totalDurationMs: Date.now() - start,
    };
  }

  // 2. Evict stale findings from the SARIF store for every scanner we
  //    are about to re-run. Without this step, a scanner that returned
  //    `[A, B, C]` on the previous run and `[A]` on the current run
  //    would leave B and C stuck in the store forever — the original
  //    "stale SARIF store" bug. Eviction is scoped per scanner name
  //    so a broken run of ESLint never wipes Semgrep findings.
  const scannersToRun = new Set(available.map((d) => d.scanner));
  const evictionCounts: Record<string, number> = {};
  for (const scanner of scannersToRun) {
    const removed = sarifStore.clearSourceTool(scanner);
    if (removed > 0) evictionCounts[scanner] = removed;
  }
  if (Object.keys(evictionCounts).length > 0) {
    logger.info(
      { evicted: evictionCounts },
      "auto-scan: cleared stale findings before re-running scanners",
    );
  }

  // 3. Run all available scanners in parallel (each from its detected workingDir)
  const runResults = await Promise.allSettled(
    available.map((d) => runScanner(d.scanner, workspaceRoot, d.workingDir ? { workingDir: d.workingDir } : undefined)),
  );

  // 4. Ingest results.
  //    `persistNeeded` used to gate the final persist() on whether any
  //    scanner produced findings. After the eviction fix we must also
  //    persist when findings were *removed* but no new ones arrived —
  //    otherwise the stale view survives on disk.
  const results: ScannerResult[] = [];
  let totalFindings = 0;
  let persistNeeded = Object.keys(evictionCounts).length > 0;

  for (let i = 0; i < available.length; i++) {
    const detection = available[i]!;
    const settled = runResults[i]!;

    if (settled.status === "rejected") {
      const error = String(settled.reason);
      logger.warn(
        { scanner: detection.scanner, error },
        "auto-scan: scanner execution rejected",
      );
      results.push({
        scanner: detection.scanner,
        success: false,
        findingsIngested: 0,
        durationMs: 0,
        error,
      });
      continue;
    }

    const runResult: ScannerRunResult = settled.value;

    if (!runResult.success) {
      logger.warn(
        { scanner: runResult.scanner, error: runResult.error },
        "auto-scan: scanner returned failure",
      );
      results.push({
        scanner: runResult.scanner,
        success: false,
        findingsIngested: 0,
        durationMs: runResult.durationMs,
        error: runResult.error ?? "unknown error",
      });
      continue;
    }

    // Ingest through adapter pipeline
    try {
      const { accepted } = ingestScannerRun(
        runResult.scanner,
        runResult.rawOutput,
        sarifStore,
      );
      totalFindings += accepted;
      persistNeeded = true;

      logger.info(
        { scanner: runResult.scanner, accepted, durationMs: runResult.durationMs },
        "auto-scan: scanner ingested",
      );

      results.push({
        scanner: runResult.scanner,
        success: true,
        findingsIngested: accepted,
        durationMs: runResult.durationMs,
      });
    } catch (err) {
      const error = (err as Error).message;
      logger.warn(
        { scanner: runResult.scanner, error },
        "auto-scan: adapter/ingestion failed",
      );
      results.push({
        scanner: runResult.scanner,
        success: false,
        findingsIngested: 0,
        durationMs: runResult.durationMs,
        error,
      });
    }
  }

  // 5. Persist consolidated SARIF if anything was ingested or evicted.
  if (persistNeeded) {
    await sarifStore.persist();
  }

  // 6. Run built-in cyclomatic complexity scanner.
  //    Same eviction invariant as external scanners: a function whose
  //    complexity drops below threshold between runs should NOT leave
  //    a stale finding in the store.
  let complexityScan: ComplexityScanResult | undefined;
  if (options?.engine) {
    const evictedComplexity = sarifStore.clearSourceTool("complexity");
    if (evictedComplexity > 0) {
      logger.info(
        { evicted: evictedComplexity },
        "auto-scan: cleared stale complexity findings before re-scan",
      );
    }
    try {
      complexityScan = await scanComplexity(
        workspaceRoot,
        options.engine,
        sarifStore,
        { cyclomaticMax: options.cyclomaticMax ?? 15, ...(options.exclude ? { exclude: options.exclude } : {}) },
        logger,
      );
      totalFindings += complexityScan.violations;
      // scanComplexity only persists when it produced findings of its
      // own. If the eviction above actually removed stale findings and
      // the fresh scan produced none, persist the cleared view here.
      if (evictedComplexity > 0 && complexityScan.violations === 0) {
        await sarifStore.persist();
      }
    } catch (err) {
      logger.warn(
        { err: (err as Error).message },
        "auto-scan: complexity scanner failed — continuing without it",
      );
    }
  }

  return {
    detected,
    results,
    totalFindings,
    totalDurationMs: Date.now() - start,
    ...(complexityScan ? { complexityScan } : {}),
  };
}
