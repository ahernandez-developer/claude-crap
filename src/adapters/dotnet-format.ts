/**
 * Adapter: `dotnet format --report <path>` JSON output → SARIF 2.1.0.
 *
 * The dotnet format tool emits a JSON array with this shape:
 *
 *   [
 *     {
 *       "DocumentId": { "ProjectId": { "Id": "..." }, "Id": "..." },
 *       "FileName": "AuthController.cs",
 *       "FilePath": "/absolute/path/to/AuthController.cs",
 *       "FileChanges": [
 *         {
 *           "LineNumber": 84,
 *           "CharNumber": 16,
 *           "DiagnosticId": "WHITESPACE",
 *           "FormatDescription": "Fix whitespace formatting. Delete 5 characters."
 *         }
 *       ]
 *     }
 *   ]
 *
 * All dotnet format findings are style/formatting issues, so they
 * map uniformly to SARIF "warning" level with a 5-minute effort
 * estimate (formatting fixes are quick, mechanical changes).
 *
 * @module adapters/dotnet-format
 */

import {
  type AdapterResult,
  wrapResultsInSarif,
} from "./common.js";

// ── Types ──────────────────────────────────────────────────────────

interface DotnetFileChange {
  LineNumber: number;
  CharNumber: number;
  DiagnosticId: string;
  FormatDescription: string;
}

interface DotnetFormatDocument {
  DocumentId: {
    ProjectId: { Id: string };
    Id: string;
  };
  FileName: string;
  FilePath: string;
  FileChanges: DotnetFileChange[];
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Convert `dotnet format --report <path>` JSON output to SARIF 2.1.0.
 *
 * @param rawOutput The JSON string or pre-parsed array from `dotnet format`.
 */
export function adaptDotnetFormat(rawOutput: unknown): AdapterResult {
  let parsed: DotnetFormatDocument[];

  if (typeof rawOutput === "string") {
    try {
      parsed = JSON.parse(rawOutput) as DotnetFormatDocument[];
    } catch {
      throw new Error("[dotnet-format adapter] rawOutput is not valid JSON");
    }
  } else if (Array.isArray(rawOutput)) {
    parsed = rawOutput as DotnetFormatDocument[];
  } else {
    throw new Error(
      "[dotnet-format adapter] rawOutput must be a JSON string or an array of document entries",
    );
  }

  if (!Array.isArray(parsed)) {
    throw new Error("[dotnet-format adapter] parsed output must be an array");
  }

  const EFFORT_MINUTES = 5;
  const results: object[] = [];
  let findingCount = 0;
  let totalEffortMinutes = 0;

  for (const doc of parsed) {
    if (!Array.isArray(doc.FileChanges)) continue;

    for (const change of doc.FileChanges) {
      findingCount++;
      totalEffortMinutes += EFFORT_MINUTES;

      results.push({
        ruleId: change.DiagnosticId,
        level: "warning",
        message: {
          text: change.FormatDescription,
        },
        locations: [
          {
            physicalLocation: {
              artifactLocation: {
                uri: doc.FilePath,
              },
              region: {
                startLine: change.LineNumber,
                startColumn: change.CharNumber,
              },
            },
          },
        ],
        properties: {
          effortMinutes: EFFORT_MINUTES,
        },
      });
    }
  }

  return {
    document: wrapResultsInSarif("dotnet_format", "1.0.0", results),
    sourceTool: "dotnet_format",
    findingCount,
    totalEffortMinutes,
  };
}
