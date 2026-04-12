/**
 * Minimal SARIF 2.1.0 document builder.
 *
 * Every report that leaves the MCP server on its way to the agent is
 * normalized to SARIF 2.1.0 first. This module provides the typed
 * helpers used to wrap raw findings in the canonical
 * `tool → runs → results` taxonomy with exact file coordinates.
 *
 * Per-scanner adapters (Semgrep, ESLint, Bandit, Stryker) live under
 * `src/adapters/` and call into `buildSarifDocument` through the
 * `wrapResultsInSarif` helper in `src/adapters/common.ts`. The
 * on-disk deduplication store lives in `./sarif-store.ts`.
 *
 * The SARIF 2.1.0 spec lives at:
 *   https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html
 *
 * @module sarif/sarif-builder
 */

/**
 * Severity levels supported by SARIF 2.1.0. They map 1:1 to the
 * `result.level` field. `"error"` is the strongest, `"none"` is informational.
 */
export type SarifLevel = "none" | "note" | "warning" | "error";

/**
 * Physical location of a finding inside a source artifact. `startLine` and
 * `startColumn` are 1-based, matching the SARIF spec. `endLine` and
 * `endColumn` are optional — omit them for point-like findings.
 */
export interface SarifLocation {
  /** Artifact URI, typically a file path relative to the workspace root. */
  readonly uri: string;
  /** 1-based line number where the finding starts. */
  readonly startLine: number;
  /** 1-based column number where the finding starts. */
  readonly startColumn: number;
  /** Optional 1-based line number where the finding ends. */
  readonly endLine?: number;
  /** Optional 1-based column number where the finding ends. */
  readonly endColumn?: number;
}

/**
 * A single finding ready to be embedded in a SARIF run. This is the
 * internal shape used by claude-sonar adapters; it is converted into the
 * official SARIF `result` object by {@link buildSarifDocument}.
 */
export interface SarifFinding {
  /** Stable rule identifier (e.g. `"SONAR-CRAP-001"`, `"semgrep.python.sqli"`). */
  readonly ruleId: string;
  /** Severity level for this finding. */
  readonly level: SarifLevel;
  /** Human-readable message describing the finding. */
  readonly message: string;
  /** Physical location where the finding was detected. */
  readonly location: SarifLocation;
  /** Optional extra metadata stored in the SARIF `properties` bag. */
  readonly properties?: Record<string, unknown>;
}

/**
 * Metadata describing the tool that produced a SARIF run. The `name` is
 * required by the spec; `version` is strongly recommended so that dashboard
 * diffs can distinguish between scanner releases.
 */
export interface SarifToolInfo {
  /** Tool display name (e.g. `"claude-sonar"`, `"semgrep"`). */
  readonly name: string;
  /** Tool semantic version. */
  readonly version: string;
  /** Optional URL pointing to the tool's documentation or home page. */
  readonly informationUri?: string;
}

/**
 * Build a minimal but valid SARIF 2.1.0 document from a list of findings.
 *
 * The returned object conforms to the SARIF JSON schema hosted at:
 *   https://schemastore.azurewebsites.net/schemas/json/sarif-2.1.0.json
 *
 * Rules are deduplicated by `ruleId` and emitted in the `tool.driver.rules`
 * array so that downstream consumers (Claude Code, the dashboard, or any
 * third-party SARIF viewer) can render a rule index.
 *
 * @param tool     Metadata about the producing tool.
 * @param findings Findings to include in the single run.
 * @returns        A SARIF 2.1.0 document literal (frozen by `as const`).
 */
export function buildSarifDocument(tool: SarifToolInfo, findings: ReadonlyArray<SarifFinding>) {
  return {
    $schema: "https://schemastore.azurewebsites.net/schemas/json/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: tool.name,
            version: tool.version,
            informationUri: tool.informationUri ?? "https://github.com/local/claude-sonar",
            // Deduplicate rules by id while preserving insertion order so
            // the emitted `rules` array matches the order findings appear.
            rules: Array.from(
              new Map(
                findings.map((f) => [
                  f.ruleId,
                  {
                    id: f.ruleId,
                    shortDescription: { text: f.ruleId },
                    defaultConfiguration: { level: f.level },
                  },
                ]),
              ).values(),
            ),
          },
        },
        results: findings.map((f) => ({
          ruleId: f.ruleId,
          level: f.level,
          message: { text: f.message },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: f.location.uri },
                region: {
                  startLine: f.location.startLine,
                  startColumn: f.location.startColumn,
                  ...(f.location.endLine !== undefined ? { endLine: f.location.endLine } : {}),
                  ...(f.location.endColumn !== undefined ? { endColumn: f.location.endColumn } : {}),
                },
              },
            },
          ],
          ...(f.properties ? { properties: f.properties } : {}),
        })),
      },
    ],
  } as const;
}
