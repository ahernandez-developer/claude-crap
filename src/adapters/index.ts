/**
 * Public SDK entry point for the per-scanner SARIF adapters.
 *
 * Adapters convert a scanner's native output (SARIF, JSON, or some
 * other structured format) into a normalized `PersistedSarif`
 * document that the `SarifStore` can ingest directly. Every adapter
 * enriches its findings with a stable `effortMinutes` value on the
 * `properties` bag so the Stop quality gate and the project score
 * engine can compute a Technical Debt Ratio.
 *
 * Usage:
 *
 * ```ts
 * import {
 *   adaptScannerOutput,
 *   adaptSemgrep,
 *   adaptEslint,
 *   adaptBandit,
 *   adaptStryker,
 * } from "@sr-herz/claude-sonar/adapters";
 *
 * const result = adaptScannerOutput("eslint", rawJsonFromEslint);
 * sarifStore.ingestRun(result.document, result.sourceTool);
 * ```
 *
 * @module adapters
 */

export { adaptSemgrep } from "./semgrep.js";
export { adaptEslint } from "./eslint.js";
export { adaptBandit } from "./bandit.js";
export { adaptStryker } from "./stryker.js";

export {
  DEFAULT_EFFORT_BY_SEVERITY,
  KNOWN_SCANNERS,
  estimateEffortMinutes,
  wrapResultsInSarif,
} from "./common.js";

export type { AdapterResult, KnownScanner } from "./common.js";

import { adaptSemgrep } from "./semgrep.js";
import { adaptEslint } from "./eslint.js";
import { adaptBandit } from "./bandit.js";
import { adaptStryker } from "./stryker.js";
import type { AdapterResult, KnownScanner } from "./common.js";

/**
 * Route a raw scanner output to the correct adapter based on its
 * name. Preferred entry point for the `ingest_scanner_output` MCP
 * tool — the dispatch is a single switch so the compiler can verify
 * every case with `never` exhaustiveness.
 *
 * @param scanner   One of the known scanner identifiers.
 * @param rawOutput The scanner's native output (string or parsed).
 * @returns         A normalized `AdapterResult`.
 * @throws          When `scanner` is unknown or the raw output is malformed.
 */
export function adaptScannerOutput(
  scanner: KnownScanner,
  rawOutput: unknown,
): AdapterResult {
  switch (scanner) {
    case "semgrep":
      return adaptSemgrep(rawOutput);
    case "eslint":
      return adaptEslint(rawOutput);
    case "bandit":
      return adaptBandit(rawOutput);
    case "stryker":
      return adaptStryker(rawOutput);
    default: {
      const exhaustive: never = scanner;
      throw new Error(`[adapters] Unknown scanner: ${String(exhaustive)}`);
    }
  }
}
