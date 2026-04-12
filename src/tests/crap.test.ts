/**
 * Unit tests for the CRAP engine.
 *
 * Uses Node's built-in `node:test` runner so the test suite ships with no
 * extra dependencies. Run with `npm test` from `src/mcp-server`.
 *
 * @module tests/crap.test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { computeCrap } from "../metrics/crap.js";

describe("computeCrap", () => {
  it("returns the baseline complexity when coverage is 100%", () => {
    const result = computeCrap({ cyclomaticComplexity: 10, coveragePercent: 100 }, 30);
    // With full coverage the cubic term vanishes and only the +comp(m)
    // tail remains. This is the property that forces decomposition of
    // functions with complexity ≥ 30 even when perfectly tested.
    assert.equal(result.crap, 10);
    assert.equal(result.exceedsThreshold, false);
  });

  it("explodes cubically when coverage is 0%", () => {
    const result = computeCrap({ cyclomaticComplexity: 10, coveragePercent: 0 }, 30);
    // CRAP = 10² × 1³ + 10 = 110
    assert.equal(result.crap, 110);
    assert.equal(result.exceedsThreshold, true);
  });

  it("respects the threshold for partially tested code", () => {
    // 12 branches, 60% coverage
    // CRAP = 12² × 0.4³ + 12 = 144 × 0.064 + 12 = 9.216 + 12 = 21.216
    const result = computeCrap({ cyclomaticComplexity: 12, coveragePercent: 60 }, 30);
    assert.equal(result.crap, 21.216);
    assert.equal(result.exceedsThreshold, false);
  });

  it("blocks any function above complexity 30 regardless of coverage", () => {
    // With comp = 31 and 100% coverage, the tail alone is 31 > 30.
    const result = computeCrap({ cyclomaticComplexity: 31, coveragePercent: 100 }, 30);
    assert.equal(result.crap, 31);
    assert.equal(result.exceedsThreshold, true);
  });

  it("rejects negative complexity", () => {
    assert.throws(() => computeCrap({ cyclomaticComplexity: 0, coveragePercent: 50 }, 30));
  });

  it("rejects coverage outside [0, 100]", () => {
    assert.throws(() => computeCrap({ cyclomaticComplexity: 5, coveragePercent: -1 }, 30));
    assert.throws(() => computeCrap({ cyclomaticComplexity: 5, coveragePercent: 101 }, 30));
  });

  it("rejects non-positive thresholds", () => {
    assert.throws(() => computeCrap({ cyclomaticComplexity: 5, coveragePercent: 50 }, 0));
  });
});
