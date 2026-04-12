/**
 * Semgrep adapter.
 *
 * Semgrep already emits SARIF 2.1.0 natively when invoked with
 * `--sarif`, so this adapter's job is not translation but
 * **enrichment**: we walk every `result` entry and stamp a
 * `properties.effortMinutes` value so the Stop quality gate can
 * compute a Technical Debt Ratio, plus we normalize the
 * `properties.sourceTool` field so downstream consumers always know
 * the finding came from Semgrep.
 *
 * If the caller passes a string, we parse it as JSON. If they pass an
 * object that already matches the SARIF 2.1.0 envelope, we use it
 * directly. Anything else throws a descriptive error that the MCP
 * tool handler surfaces back to the LLM.
 *
 * @module adapters/semgrep
 */

import type { PersistedSarif } from "../sarif/sarif-store.js";
import type { SarifLevel } from "../sarif/sarif-builder.js";
import {
  estimateEffortMinutes,
  type AdapterResult,
  type KnownScanner,
} from "./common.js";

const SEMGREP: KnownScanner = "semgrep";

/**
 * Rule-id effort overrides. Semgrep emits lots of stylistic rules
 * that take less than a minute to fix and a handful of deep security
 * rules that deserve more budget than the default warning tier. The
 * list below is intentionally short — teams should extend it.
 */
const SEMGREP_EFFORT_OVERRIDES: ReadonlyMap<RegExp, number> = new Map([
  [/security\./i, 90],
  [/sqli|xss|ssrf|rce|deserial|crypto/i, 120],
  [/style\./i, 5],
  [/formatting\./i, 3],
]);

/**
 * Accept a Semgrep SARIF document (as a string or object) and return
 * an enriched `PersistedSarif` with effort estimates and a normalized
 * `sourceTool` field.
 *
 * @param input     Raw SARIF document from Semgrep (`JSON.stringify`ed or parsed).
 * @returns         The enriched document plus per-run stats.
 * @throws          When the input is not a SARIF 2.1.0 document.
 */
export function adaptSemgrep(input: unknown): AdapterResult {
  const doc = coerceToSarif(input);

  let findingCount = 0;
  let totalEffortMinutes = 0;

  // We deep-clone the document so callers don't observe a mutation on
  // the value they passed us. JSON round-trip is cheap here; a
  // typical Semgrep SARIF report is well under 1 MB.
  //
  // We operate on the cloned value through a loose `Record`-based view
  // to keep the adapter agnostic to the full SARIF schema — the
  // canonical types live in `sarif-store.ts` and we only care about a
  // handful of fields here. The final return casts through `unknown`
  // because the JSON round-trip is shape-preserving by construction.
  const cloned = JSON.parse(JSON.stringify(doc)) as {
    runs?: Array<Record<string, unknown>>;
  };
  const runs = Array.isArray(cloned.runs) ? cloned.runs : [];

  for (const run of runs) {
    const rawResults = run["results"];
    const results = Array.isArray(rawResults) ? (rawResults as Array<Record<string, unknown>>) : [];
    for (const result of results) {
      findingCount += 1;
      const ruleId = typeof result["ruleId"] === "string" ? (result["ruleId"] as string) : "";
      const level = result["level"] as SarifLevel | undefined;
      const override = matchOverride(ruleId);
      const effort = estimateEffortMinutes(level, override);
      totalEffortMinutes += effort;
      const existingProps =
        result["properties"] && typeof result["properties"] === "object"
          ? (result["properties"] as Record<string, unknown>)
          : {};
      result["properties"] = {
        ...existingProps,
        sourceTool: SEMGREP,
        effortMinutes: effort,
      };
    }

    // Overwrite tool.driver.name so store-level filters always match
    // `"semgrep"` regardless of the label Semgrep reported. Preserve
    // the existing version and rules[] array when present.
    const existingTool = (run["tool"] as Record<string, unknown> | undefined) ?? {};
    const existingDriver = (existingTool["driver"] as Record<string, unknown> | undefined) ?? {};
    const driverOut: Record<string, unknown> = {
      name: SEMGREP,
      version: typeof existingDriver["version"] === "string" ? existingDriver["version"] : "unknown",
    };
    if (Array.isArray(existingDriver["rules"])) {
      driverOut["rules"] = existingDriver["rules"];
    }
    run["tool"] = { driver: driverOut };
  }

  return {
    document: cloned as unknown as PersistedSarif,
    sourceTool: SEMGREP,
    findingCount,
    totalEffortMinutes,
  };
}

/**
 * Accept either a pre-parsed SARIF object or a JSON string and return
 * a strongly-typed `PersistedSarif`. Throws on malformed input.
 *
 * @param input Raw caller-provided value.
 */
function coerceToSarif(input: unknown): PersistedSarif {
  const parsed = typeof input === "string" ? (JSON.parse(input) as unknown) : input;
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`[adapter:semgrep] input is not a SARIF object`);
  }
  const doc = parsed as { version?: unknown; runs?: unknown };
  if (doc.version !== "2.1.0") {
    throw new Error(
      `[adapter:semgrep] expected SARIF version 2.1.0, got ${String(doc.version)}`,
    );
  }
  if (!Array.isArray(doc.runs)) {
    throw new Error(`[adapter:semgrep] document is missing a runs[] array`);
  }
  return parsed as PersistedSarif;
}

/**
 * Return the effort override (in minutes) matching the first pattern
 * that matches the given rule id, or `undefined` when none match.
 *
 * @param ruleId Semgrep rule identifier.
 */
function matchOverride(ruleId: string): number | undefined {
  for (const [pattern, minutes] of SEMGREP_EFFORT_OVERRIDES) {
    if (pattern.test(ruleId)) return minutes;
  }
  return undefined;
}
