/**
 * Stryker (JavaScript mutation testing) adapter.
 *
 * Stryker emits a JSON report under `reports/mutation/mutation.json`.
 * The report shape is documented at
 * https://stryker-mutator.io/docs/mutation-testing-elements/mutant-result-schema/ :
 *
 *   {
 *     "schemaVersion": "1.0",
 *     "thresholds": { ... },
 *     "files": {
 *       "src/foo.ts": {
 *         "language": "typescript",
 *         "source": "...",
 *         "mutants": [
 *           {
 *             "id": "1",
 *             "mutatorName": "ConditionalExpression",
 *             "replacement": "false",
 *             "location": {
 *               "start": { "line": 10, "column": 5 },
 *               "end":   { "line": 10, "column": 15 }
 *             },
 *             "status": "Survived",   // Killed | Survived | Timeout | NoCoverage | RuntimeError | CompileError | Ignored
 *             "statusReason": "..."
 *           }
 *         ]
 *       }
 *     }
 *   }
 *
 * This adapter treats every **surviving mutant** as a SARIF
 * `error`-level finding — surviving mutants are exactly the ones the
 * Golden Rule forbids, because they prove the test suite does not
 * pin the code's behavior tightly enough to notice a change.
 *
 * Mutants with status `NoCoverage` become `warning`-level findings
 * (not blocking the Stop gate by themselves, but still ingested so
 * the dashboard can surface uncovered lines). All other statuses are
 * ignored — they do not represent defects.
 *
 * @module adapters/stryker
 */

import type { SarifLevel } from "../sarif/sarif-builder.js";
import {
  estimateEffortMinutes,
  wrapResultsInSarif,
  type AdapterResult,
  type KnownScanner,
} from "./common.js";

const STRYKER: KnownScanner = "stryker";

interface StrykerReport {
  readonly schemaVersion?: string;
  readonly files?: Record<string, StrykerFileReport>;
}

interface StrykerFileReport {
  readonly language?: string;
  readonly mutants?: ReadonlyArray<StrykerMutant>;
}

interface StrykerMutant {
  readonly id?: string;
  readonly mutatorName?: string;
  readonly replacement?: string;
  readonly location?: {
    readonly start?: { readonly line?: number; readonly column?: number };
    readonly end?: { readonly line?: number; readonly column?: number };
  };
  readonly status?: string;
  readonly statusReason?: string;
}

/**
 * Accept a Stryker JSON mutation report and return a normalized
 * `PersistedSarif` document with one finding per surviving mutant
 * and per uncovered mutant.
 *
 * @param input Raw Stryker report (string or parsed object).
 * @returns     Adapter result.
 * @throws      When the input is not a Stryker mutation report.
 */
export function adaptStryker(input: unknown): AdapterResult {
  const parsed = typeof input === "string" ? (JSON.parse(input) as unknown) : input;
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`[adapter:stryker] expected a JSON object`);
  }
  const report = parsed as StrykerReport;
  if (!report.files || typeof report.files !== "object") {
    throw new Error(`[adapter:stryker] report is missing a files{} map`);
  }

  const results: Array<ReturnType<typeof buildSarifResult>> = [];
  let totalEffortMinutes = 0;

  for (const [filename, fileReport] of Object.entries(report.files)) {
    const mutants = Array.isArray(fileReport?.mutants) ? fileReport.mutants : [];
    for (const mutant of mutants) {
      const level = classifyMutant(mutant.status);
      if (level === null) continue; // Killed / Ignored / CompileError — not a defect
      const startLine = mutant.location?.start?.line ?? 1;
      const startColumn = mutant.location?.start?.column ?? 1;
      const endLine = mutant.location?.end?.line;
      const endColumn = mutant.location?.end?.column;

      // Surviving mutants cost more to fix than the default error
      // budget because the agent has to first write a killing test,
      // THEN possibly rewrite the code.
      const effortOverride = level === "error" ? 45 : 15;
      const effort = estimateEffortMinutes(level, effortOverride);
      totalEffortMinutes += effort;

      const mutator = mutant.mutatorName ?? "Unknown";
      const ruleId = `stryker.${mutator}`;
      const statusText = mutant.status ?? "Unknown";
      const message =
        `${statusText}: ${mutator} mutant on '${mutant.replacement ?? "?"}'` +
        (mutant.statusReason ? ` — ${mutant.statusReason}` : "");

      results.push(
        buildSarifResult({
          ruleId,
          level,
          message,
          uri: filename,
          startLine,
          startColumn,
          endLine: typeof endLine === "number" ? endLine : undefined,
          endColumn: typeof endColumn === "number" ? endColumn : undefined,
          effortMinutes: effort,
          mutantId: mutant.id,
          mutator,
          mutantStatus: statusText,
        }),
      );
    }
  }

  return {
    document: wrapResultsInSarif(STRYKER, String(report.schemaVersion ?? "unknown"), results),
    sourceTool: STRYKER,
    findingCount: results.length,
    totalEffortMinutes,
  };
}

/**
 * Classify a Stryker mutant status into a SARIF level, or `null` when
 * the status represents a mutant that was correctly handled by the
 * test suite and should not produce a finding.
 */
function classifyMutant(status: string | undefined): SarifLevel | null {
  switch ((status ?? "").toLowerCase()) {
    case "survived":
      return "error";
    case "nocoverage":
      return "warning";
    case "timeout":
      // Timeout mutants are suspicious but not proof of defect —
      // they deserve a note so the dashboard highlights them.
      return "note";
    case "killed":
    case "ignored":
    case "compileerror":
    case "runtimeerror":
    default:
      return null;
  }
}

/**
 * Build the SARIF `result` object for a single Stryker mutant. We
 * propagate the mutant id, mutator name, and raw status into
 * `properties` so the dashboard can display them as tags.
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
  mutantId?: string | undefined;
  mutator?: string | undefined;
  mutantStatus?: string | undefined;
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
      sourceTool: STRYKER,
      effortMinutes: opts.effortMinutes,
      ...(opts.mutantId ? { mutantId: opts.mutantId } : {}),
      ...(opts.mutator ? { mutator: opts.mutator } : {}),
      ...(opts.mutantStatus ? { mutantStatus: opts.mutantStatus } : {}),
    },
  };
}
