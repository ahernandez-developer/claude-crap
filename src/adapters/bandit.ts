/**
 * Bandit adapter.
 *
 * Bandit is a Python security linter. When run with `-f json` it
 * emits a JSON report shaped like this (abbreviated):
 *
 *   {
 *     "results": [
 *       {
 *         "filename": "app.py",
 *         "line_number": 42,
 *         "col_offset": 5,
 *         "test_id": "B608",
 *         "test_name": "hardcoded_sql_expressions",
 *         "issue_severity": "HIGH",       // LOW | MEDIUM | HIGH
 *         "issue_confidence": "HIGH",     // LOW | MEDIUM | HIGH
 *         "issue_text": "Possible SQL injection via string-based query construction.",
 *         "issue_cwe": { "id": 89 }
 *       }
 *     ],
 *     "metrics": { ... },
 *     "errors": [ ... ]
 *   }
 *
 * This adapter converts each `results[]` entry into a SARIF 2.1.0
 * `result`, mapping Bandit severity levels to SARIF levels:
 *
 *   LOW     → "note"
 *   MEDIUM  → "warning"
 *   HIGH    → "error"
 *
 * Every finding gets a rule id of `bandit.<test_id>` (e.g.
 * `bandit.B608`) so it is trivial to correlate with Bandit's own docs
 * from inside the claude-sonar dashboard.
 *
 * @module adapters/bandit
 */

import type { SarifLevel } from "../sarif/sarif-builder.js";
import {
  estimateEffortMinutes,
  wrapResultsInSarif,
  type AdapterResult,
  type KnownScanner,
} from "./common.js";

const BANDIT: KnownScanner = "bandit";

interface BanditReport {
  readonly results?: ReadonlyArray<BanditFinding>;
}

interface BanditFinding {
  readonly filename?: string;
  readonly line_number?: number;
  readonly col_offset?: number;
  readonly test_id?: string;
  readonly test_name?: string;
  readonly issue_severity?: string;
  readonly issue_confidence?: string;
  readonly issue_text?: string;
  readonly issue_cwe?: { readonly id?: number };
}

/**
 * Accept a Bandit JSON report and return a normalized
 * `PersistedSarif` document.
 *
 * @param input Raw Bandit JSON (string or parsed object).
 * @returns     Adapter result.
 * @throws      When the input does not look like a Bandit report.
 */
export function adaptBandit(input: unknown): AdapterResult {
  const parsed = typeof input === "string" ? (JSON.parse(input) as unknown) : input;
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`[adapter:bandit] expected a JSON object`);
  }
  const report = parsed as BanditReport;
  if (!Array.isArray(report.results)) {
    throw new Error(`[adapter:bandit] report is missing a results[] array`);
  }

  const results: Array<ReturnType<typeof buildSarifResult>> = [];
  let totalEffortMinutes = 0;

  for (const finding of report.results) {
    const filename = finding.filename;
    if (typeof filename !== "string" || !filename) continue;
    const level = mapSeverity(finding.issue_severity);
    // High-severity security findings cost more to fix than the
    // generic default, so we bias the budget toward reality. Bandit
    // is always security-focused, so every finding is treated as a
    // security issue for TDR accounting downstream.
    const effortOverride = level === "error" ? 120 : level === "warning" ? 60 : 20;
    const effort = estimateEffortMinutes(level, effortOverride);
    totalEffortMinutes += effort;

    const testId = finding.test_id ?? "unknown";
    const ruleId = `bandit.${testId}`;
    const messageText =
      finding.issue_text ??
      `${finding.test_name ?? "Bandit finding"} (${finding.issue_severity ?? "UNKNOWN"})`;

    const startLine =
      typeof finding.line_number === "number" && finding.line_number > 0
        ? finding.line_number
        : 1;
    const startColumn =
      typeof finding.col_offset === "number" && finding.col_offset >= 0
        ? finding.col_offset + 1
        : 1;

    results.push(
      buildSarifResult({
        ruleId,
        level,
        message: messageText,
        uri: filename,
        startLine,
        startColumn,
        effortMinutes: effort,
        cwe: finding.issue_cwe?.id,
        confidence: finding.issue_confidence,
      }),
    );
  }

  return {
    document: wrapResultsInSarif(BANDIT, "unknown", results),
    sourceTool: BANDIT,
    findingCount: results.length,
    totalEffortMinutes,
  };
}

/**
 * Map Bandit's `issue_severity` string to a SARIF level. Unknown
 * values default to `"warning"` so findings are still surfaced.
 */
function mapSeverity(severity: string | undefined): SarifLevel {
  switch ((severity ?? "").toUpperCase()) {
    case "HIGH":
      return "error";
    case "MEDIUM":
      return "warning";
    case "LOW":
      return "note";
    default:
      return "warning";
  }
}

/**
 * Build the SARIF `result` object for a single Bandit finding. We
 * stash the CWE id and Bandit confidence in the `properties` bag so
 * consumers can surface them in the dashboard hot-spot view.
 */
function buildSarifResult(opts: {
  ruleId: string;
  level: SarifLevel;
  message: string;
  uri: string;
  startLine: number;
  startColumn: number;
  effortMinutes: number;
  cwe?: number | undefined;
  confidence?: string | undefined;
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
          },
        },
      },
    ],
    properties: {
      sourceTool: BANDIT,
      effortMinutes: opts.effortMinutes,
      ...(typeof opts.cwe === "number" ? { cwe: opts.cwe } : {}),
      ...(typeof opts.confidence === "string" ? { confidence: opts.confidence } : {}),
    },
  };
}
