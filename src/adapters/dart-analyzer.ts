/**
 * Adapter: `dart analyze --format=json` → SARIF 2.1.0.
 *
 * The Dart analyzer emits JSON with this shape:
 *
 *   {
 *     "version": 1,
 *     "diagnostics": [
 *       {
 *         "code": "unused_import",
 *         "severity": "WARNING",
 *         "type": "STATIC_WARNING",
 *         "location": {
 *           "file": "/absolute/path/to/file.dart",
 *           "range": {
 *             "start": { "offset": 7, "line": 1, "column": 8 },
 *             "end":   { "offset": 16, "line": 1, "column": 17 }
 *           }
 *         },
 *         "problemMessage": "Unused import: 'dart:io'.",
 *         "correctionMessage": "Try removing the import directive.",
 *         "documentation": "https://dart.dev/diagnostics/unused_import"
 *       }
 *     ]
 *   }
 *
 * Severity mapping:
 *   - "ERROR"   → SARIF "error"   (30 min effort)
 *   - "WARNING" → SARIF "warning" (15 min effort)
 *   - "INFO"    → SARIF "note"    (5 min effort)
 *
 * @module adapters/dart-analyzer
 */

import {
  type AdapterResult,
  wrapResultsInSarif,
  estimateEffortMinutes,
} from "./common.js";
import type { SarifLevel } from "../sarif/sarif-builder.js";

// ── Types ──────────────────────────────────────────────────────────

interface DartDiagnosticLocation {
  file: string;
  range: {
    start: { offset: number; line: number; column: number };
    end: { offset: number; line: number; column: number };
  };
}

interface DartDiagnostic {
  code: string;
  severity: string;
  type: string;
  location: DartDiagnosticLocation;
  problemMessage: string;
  correctionMessage?: string;
  documentation?: string;
}

interface DartAnalyzeOutput {
  version: number;
  diagnostics: DartDiagnostic[];
}

// ── Severity mapping ───────────────────────────────────────────────

function mapSeverity(dartSeverity: string): SarifLevel {
  switch (dartSeverity.toUpperCase()) {
    case "ERROR":
      return "error";
    case "WARNING":
      return "warning";
    case "INFO":
      return "note";
    default:
      return "warning";
  }
}

// ── Effort estimates per severity ──────────────────────────────────

const EFFORT_BY_SEVERITY: Record<SarifLevel, number> = {
  error: 30,
  warning: 15,
  note: 5,
  none: 0,
};

// ── Public API ─────────────────────────────────────────────────────

/**
 * Convert `dart analyze --format=json` output to SARIF 2.1.0.
 *
 * @param rawOutput The JSON string or pre-parsed object from `dart analyze`.
 */
export function adaptDartAnalyzer(rawOutput: unknown): AdapterResult {
  let parsed: DartAnalyzeOutput;

  if (typeof rawOutput === "string") {
    try {
      parsed = JSON.parse(rawOutput) as DartAnalyzeOutput;
    } catch {
      throw new Error("[dart-analyzer adapter] rawOutput is not valid JSON");
    }
  } else if (rawOutput && typeof rawOutput === "object" && "diagnostics" in rawOutput) {
    parsed = rawOutput as DartAnalyzeOutput;
  } else {
    throw new Error(
      "[dart-analyzer adapter] rawOutput must be a JSON string or an object with a 'diagnostics' array",
    );
  }

  if (!Array.isArray(parsed.diagnostics)) {
    throw new Error("[dart-analyzer adapter] 'diagnostics' must be an array");
  }

  const results: object[] = [];
  let totalEffortMinutes = 0;

  for (const diag of parsed.diagnostics) {
    const level = mapSeverity(diag.severity);
    const effort = EFFORT_BY_SEVERITY[level] ?? estimateEffortMinutes(level);
    totalEffortMinutes += effort;

    results.push({
      ruleId: diag.code,
      level,
      message: {
        text: diag.problemMessage + (diag.correctionMessage ? ` ${diag.correctionMessage}` : ""),
      },
      locations: [
        {
          physicalLocation: {
            artifactLocation: {
              uri: diag.location.file,
            },
            region: {
              startLine: diag.location.range.start.line,
              startColumn: diag.location.range.start.column,
              endLine: diag.location.range.end.line,
              endColumn: diag.location.range.end.column,
            },
          },
        },
      ],
      properties: {
        effortMinutes: effort,
        ...(diag.documentation ? { helpUri: diag.documentation } : {}),
      },
    });
  }

  return {
    document: wrapResultsInSarif("dart_analyze", "1.0.0", results),
    sourceTool: "dart_analyze",
    findingCount: parsed.diagnostics.length,
    totalEffortMinutes,
  };
}
