/**
 * Technical Debt Ratio (TDR) — deterministic computation and rating.
 *
 * The Technical Debt Ratio expresses how expensive it would be to remediate
 * all known issues in a scope, relative to how much it would have cost to
 * write the code in the first place. Formally (see docs/quality-gate.md):
 *
 *     TDR = remediationCost / (costPerLine × totalLinesOfCode)
 *
 * Where the remediation cost is the sum (in minutes) of every linter /
 * scanner / mutator finding's individual estimated effort, and the per-line
 * cost is assumed to be a constant `minutesPerLoc` (industry default: 30
 * minutes per line of code, including design, writing and review).
 *
 * The resulting ratio is converted to a percentage and mapped to a letter
 * grade A..E. The thresholds are strict and non-negotiable:
 *
 *   | Rating | TDR %        | Meaning                                   |
 *   |--------|--------------|-------------------------------------------|
 *   | A      | 0..5%        | Excellent — remediation cost is noise     |
 *   | B      | >5..10%      | Low risk                                  |
 *   | C      | >10..20%     | Moderate, watch closely                   |
 *   | D      | >20..50%     | Critical, remediation plan required       |
 *   | E      | >50%         | Unmaintainable — halt feature work        |
 *
 * Rating E always halts the workflow at the Stop quality gate, regardless
 * of the configured `TDR_MAX_RATING` tolerance.
 *
 * @module metrics/tdr
 */

import type { MaintainabilityRating } from "../config.js";

/**
 * Inputs required to compute a Technical Debt Ratio over any scope
 * (project, module, or file).
 */
export interface TdrInput {
  /** Sum of all finding remediation estimates, in minutes. Must be ≥ 0. */
  readonly remediationMinutes: number;
  /** Total lines of code in the scope. Must be > 0 (division denominator). */
  readonly totalLinesOfCode: number;
  /** Assumed development cost per LOC, in minutes. Must be > 0. */
  readonly minutesPerLoc: number;
}

/**
 * Result of a TDR computation with both the raw ratio and the letter grade.
 */
export interface TdrResult {
  /** Raw ratio (remediation / development), rounded to 6 decimals. */
  readonly ratio: number;
  /** Same ratio expressed as a percentage, rounded to 4 decimals. */
  readonly percent: number;
  /** Letter grade derived from `percent` via {@link classifyTdr}. */
  readonly rating: MaintainabilityRating;
  /** Remediation input, echoed for traceability. */
  readonly remediationMinutes: number;
  /** LOC input, echoed for traceability. */
  readonly totalLinesOfCode: number;
  /** Computed `minutesPerLoc × totalLinesOfCode`, useful for the dashboard. */
  readonly developmentCostMinutes: number;
}

/** Canonical ordering used by {@link ratingToRank}. */
const RATING_ORDER: ReadonlyArray<MaintainabilityRating> = ["A", "B", "C", "D", "E"];

/**
 * Convert a letter rating to its numeric rank (A=0, E=4). Useful when
 * comparing two ratings without relying on lexical order.
 *
 * @param rating The rating letter.
 * @returns      Its rank in `[0, 4]`.
 */
export function ratingToRank(rating: MaintainabilityRating): number {
  return RATING_ORDER.indexOf(rating);
}

/**
 * Return `true` when `actual` is strictly worse than `limit`, false otherwise.
 * Used by the Stop quality gate to decide whether to block task completion.
 *
 * @param actual Rating currently achieved by the project.
 * @param limit  Maximum tolerated rating (worst allowed).
 * @returns      `true` if `actual` should trigger a block.
 *
 * @example
 * ratingIsWorseThan("D", "C") // → true
 * ratingIsWorseThan("B", "C") // → false
 * ratingIsWorseThan("C", "C") // → false (equal, not worse)
 */
export function ratingIsWorseThan(
  actual: MaintainabilityRating,
  limit: MaintainabilityRating,
): boolean {
  return ratingToRank(actual) > ratingToRank(limit);
}

/**
 * Map a TDR percentage to its letter rating. The boundaries are inclusive
 * on the upper end (5% is still an A, 10% is still a B, etc.).
 *
 * @param percent TDR expressed as a percentage. Must be ≥ 0.
 * @returns       Letter rating A..E.
 * @throws        When `percent` is negative or not finite.
 */
export function classifyTdr(percent: number): MaintainabilityRating {
  if (!Number.isFinite(percent) || percent < 0) {
    throw new Error(`[tdr] percent is invalid: ${percent}`);
  }
  if (percent <= 5) return "A";
  if (percent <= 10) return "B";
  if (percent <= 20) return "C";
  if (percent <= 50) return "D";
  return "E";
}

/**
 * Compute the Technical Debt Ratio for a scope and return the full result.
 * This function is pure and deterministic.
 *
 * @param input Remediation minutes, total LOC and the cost-per-line assumption.
 * @returns     A {@link TdrResult} ready to be serialized to SARIF properties.
 * @throws      When any numeric input is out of range.
 *
 * @example
 * // 240 minutes of remediation across 500 LOC at 30 min/LOC
 * computeTdr({ remediationMinutes: 240, totalLinesOfCode: 500, minutesPerLoc: 30 })
 * // → { ratio: 0.016, percent: 1.6, rating: "A", ... }
 */
export function computeTdr(input: TdrInput): TdrResult {
  if (input.totalLinesOfCode <= 0) {
    throw new Error(`[tdr] totalLinesOfCode must be > 0, got ${input.totalLinesOfCode}`);
  }
  if (input.minutesPerLoc <= 0) {
    throw new Error(`[tdr] minutesPerLoc must be > 0, got ${input.minutesPerLoc}`);
  }
  if (input.remediationMinutes < 0) {
    throw new Error(`[tdr] remediationMinutes must be ≥ 0, got ${input.remediationMinutes}`);
  }

  const developmentCostMinutes = input.minutesPerLoc * input.totalLinesOfCode;
  const ratio = input.remediationMinutes / developmentCostMinutes;
  const percent = ratio * 100;
  const rating = classifyTdr(percent);

  return {
    ratio: Number(ratio.toFixed(6)),
    percent: Number(percent.toFixed(4)),
    rating,
    remediationMinutes: input.remediationMinutes,
    totalLinesOfCode: input.totalLinesOfCode,
    developmentCostMinutes,
  };
}
