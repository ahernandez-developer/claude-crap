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

import type { Logger } from "pino";
import { detectScanners, type ScannerDetection } from "./detector.js";
import { runScanner, type ScannerRunResult } from "./runner.js";
import { adaptScannerOutput, type KnownScanner } from "../adapters/index.js";
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
): Promise<AutoScanResult> {
  const start = Date.now();

  // 1. Detect available scanners
  const detected = await detectScanners(workspaceRoot);
  const available = detected.filter((d) => d.available);

  logger.info(
    {
      detected: detected.map((d) => `${d.scanner}:${d.available}`),
      available: available.length,
    },
    "auto-scan: detection complete",
  );

  if (available.length === 0) {
    return {
      detected,
      results: [],
      totalFindings: 0,
      totalDurationMs: Date.now() - start,
    };
  }

  // 2. Run all available scanners in parallel
  const runResults = await Promise.allSettled(
    available.map((d) => runScanner(d.scanner, workspaceRoot)),
  );

  // 3. Ingest results
  const results: ScannerResult[] = [];
  let totalFindings = 0;
  let persistNeeded = false;

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

  // 4. Persist consolidated SARIF if anything was ingested
  if (persistNeeded) {
    await sarifStore.persist();
  }

  return {
    detected,
    results,
    totalFindings,
    totalDurationMs: Date.now() - start,
  };
}
