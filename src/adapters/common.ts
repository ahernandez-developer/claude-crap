/**
 * Shared types and helpers for per-scanner SARIF adapters.
 *
 * Every adapter in this directory converts a scanner's native output
 * into a `PersistedSarif` 2.1.0 document that the `SarifStore` can
 * ingest directly. The adapters also enrich the finding `properties`
 * bag with a stable `effortMinutes` field so the Stop quality gate and
 * the Technical Debt Ratio computation can treat every source tool
 * uniformly.
 *
 * Rule-level effort estimates live in `DEFAULT_EFFORT_BY_SEVERITY`.
 * Individual adapters may override the default per rule id when the
 * scanner attaches a more specific hint.
 *
 * @module adapters/common
 */

import type { PersistedSarif } from "../sarif/sarif-store.js";
import type { SarifLevel } from "../sarif/sarif-builder.js";

/**
 * The canonical list of scanners claude-sonar understands. The
 * `ingest_scanner_output` MCP tool uses this as its `enum` constraint,
 * so keeping it narrow prevents drift.
 */
export const KNOWN_SCANNERS = ["semgrep", "eslint", "bandit", "stryker"] as const;

/**
 * Union of supported scanner identifiers.
 */
export type KnownScanner = (typeof KNOWN_SCANNERS)[number];

/**
 * Default remediation effort in minutes per SARIF severity level. These
 * numbers are deliberately conservative — real projects should override
 * them per rule via adapter-specific rule maps or via SARIF properties.
 *
 * The mapping follows the common-sense rule that every bug takes at
 * least a test plus a patch, so even a note-level finding costs time.
 */
export const DEFAULT_EFFORT_BY_SEVERITY: Readonly<Record<SarifLevel, number>> = Object.freeze({
  error: 60,
  warning: 30,
  note: 10,
  none: 5,
});

/**
 * Envelope common to every adapter output. Adapters return a
 * `PersistedSarif` document and a small stats block describing what
 * they saw, so the MCP tool handler can echo those stats back to the
 * LLM even when the SarifStore rejects duplicates.
 */
export interface AdapterResult {
  /** Normalized SARIF 2.1.0 document ready for `SarifStore.ingestRun`. */
  readonly document: PersistedSarif;
  /** Scanner identifier, propagated into every finding's `properties.sourceTool`. */
  readonly sourceTool: KnownScanner;
  /** Raw number of findings the adapter read from the scanner's native output. */
  readonly findingCount: number;
  /** Total estimated remediation effort across all findings, in minutes. */
  readonly totalEffortMinutes: number;
}

/**
 * Build a `PersistedSarif` document from a flat list of already-mapped
 * result entries. Every adapter produces its results with the same
 * shape and then calls this helper to wrap them in a valid 2.1.0 envelope.
 *
 * @param sourceTool  Stable scanner identifier (e.g. `"semgrep"`).
 * @param version     Adapter version string stored in `tool.driver.version`.
 * @param results     Pre-built SARIF `result` entries.
 */
export function wrapResultsInSarif(
  sourceTool: KnownScanner,
  version: string,
  results: ReadonlyArray<object>,
): PersistedSarif {
  return {
    $schema: "https://schemastore.azurewebsites.net/schemas/json/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: sourceTool,
            version,
          },
        },
        results: results as ReadonlyArray<SarifResultShape>,
      },
    ],
  } as PersistedSarif;
}

/**
 * Narrow structural contract of a SARIF `result` object. We type it
 * loosely so adapters can emit the minimum required fields without
 * importing the full SARIF spec types from `sarif-store.ts`.
 */
interface SarifResultShape {
  readonly ruleId: string;
  readonly level?: SarifLevel;
  readonly message: { readonly text: string };
  readonly locations?: ReadonlyArray<{
    readonly physicalLocation?: {
      readonly artifactLocation?: { readonly uri?: string };
      readonly region?: {
        readonly startLine?: number;
        readonly startColumn?: number;
        readonly endLine?: number;
        readonly endColumn?: number;
      };
    };
  }>;
  readonly properties?: Record<string, unknown>;
}

/**
 * Estimate remediation effort for a single finding given its severity
 * and an optional rule-specific override. Returns `minutes` clamped to
 * a non-negative integer.
 *
 * @param level     SARIF severity level (`"error"`, `"warning"`, ...).
 * @param override  Optional rule-specific effort in minutes.
 */
export function estimateEffortMinutes(level: SarifLevel | undefined, override?: number): number {
  if (typeof override === "number" && Number.isFinite(override) && override >= 0) {
    return Math.round(override);
  }
  const base = DEFAULT_EFFORT_BY_SEVERITY[level ?? "warning"];
  return Math.max(0, Math.round(base ?? 30));
}
