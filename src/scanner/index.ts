/**
 * Public SDK entry point for the scanner auto-detection and execution
 * pipeline.
 *
 * Usage:
 *
 * ```ts
 * import { autoScan, detectScanners } from "claude-crap/scanner";
 *
 * // Full pipeline: detect → run → ingest
 * const result = await autoScan(workspaceRoot, sarifStore, logger);
 *
 * // Detection only (no execution)
 * const detections = await detectScanners(workspaceRoot);
 * ```
 *
 * @module scanner
 */

export { detectScanners, type ScannerDetection } from "./detector.js";
export { runScanner, type ScannerRunResult } from "./runner.js";
export { autoScan, type AutoScanResult, type ScannerResult } from "./auto-scan.js";
