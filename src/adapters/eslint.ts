/**
 * ESLint adapter.
 *
 * ESLint's default JSON output (`eslint -f json .`) is NOT SARIF.
 * This adapter converts it into a SARIF 2.1.0 document with one
 * `result` per ESLint `messages[]` entry, mapping ESLint's numeric
 * severity to SARIF levels:
 *
 *   severity 0 → "note"     (parser info / disabled)
 *   severity 1 → "warning"
 *   severity 2 → "error"
 *
 * ESLint's JSON shape:
 *
 *   [
 *     {
 *       "filePath": "/abs/path/to/foo.js",
 *       "messages": [
 *         {
 *           "ruleId": "no-unused-vars",
 *           "severity": 1,
 *           "message": "'foo' is defined but never used.",
 *           "line": 10,
 *           "column": 5,
 *           "endLine": 10,
 *           "endColumn": 8
 *         }
 *       ],
 *       "errorCount": 0,
 *       "warningCount": 1,
 *       "fatalErrorCount": 0,
 *       "source": "...",
 *       "usedDeprecatedRules": []
 *     }
 *   ]
 *
 * We preserve the full `line`/`column` range when ESLint provides one
 * so the dashboard's hot-spot table can show a precise location.
 *
 * @module adapters/eslint
 */

import type { SarifLevel } from "../sarif/sarif-builder.js";
import {
  estimateEffortMinutes,
  wrapResultsInSarif,
  type AdapterResult,
  type KnownScanner,
} from "./common.js";

const ESLINT: KnownScanner = "eslint";

/**
 * ESLint JSON file entry as produced by `eslint -f json`. We type it
 * permissively because many ESLint fields are optional depending on
 * version and plugin.
 */
interface EslintFileReport {
  readonly filePath?: string;
  readonly messages?: ReadonlyArray<EslintMessage>;
}

interface EslintMessage {
  readonly ruleId?: string | null;
  readonly severity?: number;
  readonly message?: string;
  readonly line?: number;
  readonly column?: number;
  readonly endLine?: number;
  readonly endColumn?: number;
  readonly fatal?: boolean;
}

/**
 * Accept ESLint native JSON output and return a normalized
 * `PersistedSarif` document plus counts.
 *
 * @param input Raw ESLint JSON (string or parsed array).
 * @returns     Adapter result.
 * @throws      When the input is not a valid ESLint report.
 */
export function adaptEslint(input: unknown): AdapterResult {
  const parsed = typeof input === "string" ? (JSON.parse(input) as unknown) : input;
  if (!Array.isArray(parsed)) {
    throw new Error(`[adapter:eslint] expected an array of file reports`);
  }

  const results: Array<ReturnType<typeof buildSarifResult>> = [];
  let totalEffortMinutes = 0;

  for (const fileReport of parsed as ReadonlyArray<EslintFileReport>) {
    const filePath = fileReport?.filePath;
    if (typeof filePath !== "string" || !filePath) continue;
    const messages = Array.isArray(fileReport.messages) ? fileReport.messages : [];
    for (const msg of messages) {
      const level = mapSeverity(msg.severity);
      const ruleId = typeof msg.ruleId === "string" ? msg.ruleId : "eslint.unknown";
      const line = typeof msg.line === "number" && msg.line > 0 ? msg.line : 1;
      const column = typeof msg.column === "number" && msg.column > 0 ? msg.column : 1;
      const effort = estimateEffortMinutes(level);
      totalEffortMinutes += effort;
      results.push(
        buildSarifResult({
          ruleId,
          level,
          message: msg.message ?? ruleId,
          uri: filePath,
          startLine: line,
          startColumn: column,
          endLine: typeof msg.endLine === "number" ? msg.endLine : undefined,
          endColumn: typeof msg.endColumn === "number" ? msg.endColumn : undefined,
          effortMinutes: effort,
        }),
      );
    }
  }

  return {
    document: wrapResultsInSarif(ESLINT, "unknown", results),
    sourceTool: ESLINT,
    findingCount: results.length,
    totalEffortMinutes,
  };
}

/**
 * Translate ESLint's numeric severity to a SARIF level. ESLint uses:
 *
 *   0 = off / disabled   → `"note"` (informational)
 *   1 = warn             → `"warning"`
 *   2 = error            → `"error"`
 *
 * Unknown values default to `"warning"` so the finding is still
 * visible without being treated as a blocker.
 */
function mapSeverity(severity: number | undefined): SarifLevel {
  switch (severity) {
    case 2:
      return "error";
    case 1:
      return "warning";
    case 0:
      return "note";
    default:
      return "warning";
  }
}

/**
 * Assemble a SARIF `result` object from the narrow set of fields an
 * ESLint message provides. The shape matches what the SarifStore
 * expects when hydrating a finding from a persisted document.
 */
function buildSarifResult(opts: {
  ruleId: string;
  level: SarifLevel;
  message: string;
  uri: string;
  startLine: number;
  startColumn: number;
  endLine?: number | undefined;
  endColumn?: number | undefined;
  effortMinutes: number;
}) {
  return {
    ruleId: opts.ruleId,
    level: opts.level,
    message: { text: opts.message },
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri: opts.uri },
          region: {
            startLine: opts.startLine,
            startColumn: opts.startColumn,
            ...(opts.endLine !== undefined ? { endLine: opts.endLine } : {}),
            ...(opts.endColumn !== undefined ? { endColumn: opts.endColumn } : {}),
          },
        },
      },
    ],
    properties: {
      sourceTool: ESLINT,
      effortMinutes: opts.effortMinutes,
    },
  };
}
