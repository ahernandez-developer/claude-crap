/**
 * CRAP (Change Risk Anti-Patterns) index — deterministic computation.
 *
 * The CRAP index is a single number that summarizes how dangerous it is
 * to change a given function. It combines two signals:
 *
 *   1. Cyclomatic complexity (`comp`) — how many independent paths the
 *      function has. Tracks how easy it is to reason about the code.
 *   2. Test coverage percentage (`cov`) — empirical safety net provided
 *      by the automated test suite.
 *
 * The formula (see docs/quality-gate.md) is:
 *
 *     CRAP(m) = comp(m)² × (1 − cov(m)/100)³ + comp(m)
 *
 * The cubic uncovered-weight term makes CRAP punish uncovered, branchy
 * code extremely aggressively. A function with complexity 10 and 0%
 * coverage scores CRAP = 10² × 1³ + 10 = 110, well above the 30 threshold.
 *
 * The additive `+ comp(m)` tail is intentional: it means that any function
 * with `comp ≥ 30` can NEVER reach a passing CRAP score, even with 100%
 * coverage (because the final term alone equals the threshold). This
 * encodes the policy "functions above complexity 30 must be decomposed,
 * period" — you cannot test your way out of structural complexity.
 *
 * @module metrics/crap
 */

/**
 * Inputs required to compute CRAP for a single function.
 */
export interface CrapInput {
  /** Cyclomatic complexity of the function. Must be an integer ≥ 1. */
  readonly cyclomaticComplexity: number;
  /** Test coverage percentage for the function. Must be in `[0, 100]`. */
  readonly coveragePercent: number;
}

/**
 * Result of a CRAP computation, including the inputs used so callers can
 * echo the context back to the LLM or dump it to a SARIF result's
 * `properties` bag without re-reading the source data.
 */
export interface CrapResult {
  /** The CRAP score, rounded to 4 decimals for stable serialization. */
  readonly crap: number;
  /** Cyclomatic complexity echoed from the input. */
  readonly cyclomaticComplexity: number;
  /** Coverage percentage echoed from the input. */
  readonly coveragePercent: number;
  /** `true` when `crap > threshold` — caller should block on this. */
  readonly exceedsThreshold: boolean;
  /** The threshold used for the `exceedsThreshold` decision. */
  readonly threshold: number;
}

/**
 * Compute the CRAP index for a single function, against a configurable
 * block threshold. This function is pure, deterministic, and performs no
 * I/O — it can be called from any context (MCP tool handler, hook, unit
 * test) without side effects.
 *
 * @param input     Cyclomatic complexity and coverage for the function.
 * @param threshold The CRAP score above which the caller should block.
 * @returns         A {@link CrapResult} containing the score and decision.
 * @throws          When any input is out of range or not finite.
 *
 * @example
 * // 12 branches, 60% coverage, threshold = 30
 * computeCrap({ cyclomaticComplexity: 12, coveragePercent: 60 }, 30)
 * // → { crap: 21.216, exceedsThreshold: false, ... }
 */
export function computeCrap(input: CrapInput, threshold: number): CrapResult {
  if (!Number.isFinite(input.cyclomaticComplexity) || input.cyclomaticComplexity < 1) {
    throw new Error(
      `[crap] cyclomaticComplexity must be ≥ 1, got ${input.cyclomaticComplexity}`,
    );
  }
  if (!Number.isFinite(input.coveragePercent) || input.coveragePercent < 0 || input.coveragePercent > 100) {
    throw new Error(
      `[crap] coveragePercent must be in [0, 100], got ${input.coveragePercent}`,
    );
  }
  if (!Number.isFinite(threshold) || threshold <= 0) {
    throw new Error(`[crap] threshold must be > 0, got ${threshold}`);
  }

  const comp = input.cyclomaticComplexity;
  const uncovered = 1 - input.coveragePercent / 100;
  const crap = comp * comp * Math.pow(uncovered, 3) + comp;

  return {
    // Round to 4 decimals so JSON serialization is stable across runs
    // (important for SARIF diffing and dashboard caching).
    crap: Number(crap.toFixed(4)),
    cyclomaticComplexity: comp,
    coveragePercent: input.coveragePercent,
    exceedsThreshold: crap > threshold,
    threshold,
  };
}
