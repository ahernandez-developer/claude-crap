/**
 * Unit tests for the Technical Debt Ratio engine and its letter grading.
 *
 * @module tests/tdr.test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { classifyTdr, computeTdr, ratingIsWorseThan, ratingToRank } from "../metrics/tdr.js";

describe("classifyTdr", () => {
  it("maps 0–5% to A", () => {
    assert.equal(classifyTdr(0), "A");
    assert.equal(classifyTdr(5), "A");
  });

  it("maps >5–10% to B", () => {
    assert.equal(classifyTdr(5.0001), "B");
    assert.equal(classifyTdr(10), "B");
  });

  it("maps >10–20% to C", () => {
    assert.equal(classifyTdr(10.0001), "C");
    assert.equal(classifyTdr(20), "C");
  });

  it("maps >20–50% to D", () => {
    assert.equal(classifyTdr(20.0001), "D");
    assert.equal(classifyTdr(50), "D");
  });

  it("maps >50% to E", () => {
    assert.equal(classifyTdr(50.0001), "E");
    assert.equal(classifyTdr(999), "E");
  });

  it("rejects negative percentages", () => {
    assert.throws(() => classifyTdr(-0.01));
  });
});

describe("computeTdr", () => {
  it("produces an A rating for healthy projects", () => {
    // 240 minutes of remediation / (30 × 500) = 0.016 = 1.6%
    const result = computeTdr({
      remediationMinutes: 240,
      totalLinesOfCode: 500,
      minutesPerLoc: 30,
    });
    assert.equal(result.percent, 1.6);
    assert.equal(result.rating, "A");
    assert.equal(result.developmentCostMinutes, 15_000);
  });

  it("produces an E rating for unmaintainable projects", () => {
    // 9000 minutes on 100 LOC at 30 min/LOC → 300%
    const result = computeTdr({
      remediationMinutes: 9000,
      totalLinesOfCode: 100,
      minutesPerLoc: 30,
    });
    assert.equal(result.rating, "E");
    assert.ok(result.percent > 50);
  });

  it("rejects a non-positive LOC denominator", () => {
    assert.throws(() =>
      computeTdr({ remediationMinutes: 10, totalLinesOfCode: 0, minutesPerLoc: 30 }),
    );
  });
});

describe("rating helpers", () => {
  it("ranks A..E in the expected order", () => {
    assert.equal(ratingToRank("A"), 0);
    assert.equal(ratingToRank("C"), 2);
    assert.equal(ratingToRank("E"), 4);
  });

  it("detects when actual is worse than the policy limit", () => {
    assert.equal(ratingIsWorseThan("D", "C"), true);
    assert.equal(ratingIsWorseThan("A", "C"), false);
    assert.equal(ratingIsWorseThan("C", "C"), false); // equal is not worse
  });
});
