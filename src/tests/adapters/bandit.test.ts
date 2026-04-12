/**
 * Unit tests for the Bandit adapter.
 *
 * Bandit's `-f json` output has a `results[]` array of findings with
 * `issue_severity` strings HIGH / MEDIUM / LOW that map to SARIF
 * error / warning / note.
 *
 * @module tests/adapters/bandit.test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { adaptBandit } from "../../adapters/bandit.js";

describe("adaptBandit", () => {
  it("maps HIGH severity to error", () => {
    const raw = {
      results: [
        {
          filename: "app.py",
          line_number: 12,
          col_offset: 4,
          test_id: "B608",
          test_name: "hardcoded_sql_expressions",
          issue_severity: "HIGH",
          issue_confidence: "HIGH",
          issue_text: "Possible SQL injection",
          issue_cwe: { id: 89 },
        },
      ],
    };
    const result = adaptBandit(raw);
    assert.equal(result.sourceTool, "bandit");
    const finding = result.document.runs[0]?.results?.[0] as {
      level?: string;
      ruleId?: string;
      properties?: { cwe?: number; confidence?: string };
    };
    assert.equal(finding?.level, "error");
    assert.equal(finding?.ruleId, "bandit.B608");
    assert.equal(finding?.properties?.cwe, 89);
    assert.equal(finding?.properties?.confidence, "HIGH");
  });

  it("maps MEDIUM severity to warning and LOW severity to note", () => {
    const raw = {
      results: [
        {
          filename: "a.py",
          line_number: 1,
          col_offset: 0,
          test_id: "B101",
          issue_severity: "MEDIUM",
        },
        {
          filename: "b.py",
          line_number: 2,
          col_offset: 0,
          test_id: "B102",
          issue_severity: "LOW",
        },
      ],
    };
    const result = adaptBandit(raw);
    const levels = (result.document.runs[0]?.results ?? [])
      .map((r) => (r as { level?: string }).level)
      .sort();
    assert.deepEqual(levels, ["note", "warning"]);
  });

  it("converts 0-based col_offset to 1-based SARIF startColumn", () => {
    const raw = {
      results: [
        { filename: "a.py", line_number: 5, col_offset: 0, test_id: "B101", issue_severity: "LOW" },
      ],
    };
    const result = adaptBandit(raw);
    const finding = result.document.runs[0]?.results?.[0] as {
      locations?: Array<{ physicalLocation?: { region?: { startColumn?: number } } }>;
    };
    assert.equal(finding?.locations?.[0]?.physicalLocation?.region?.startColumn, 1);
  });

  it("assigns a high effort budget to HIGH severity findings", () => {
    const high = adaptBandit({
      results: [
        { filename: "a.py", line_number: 1, col_offset: 0, test_id: "B1", issue_severity: "HIGH" },
      ],
    });
    const low = adaptBandit({
      results: [
        { filename: "a.py", line_number: 1, col_offset: 0, test_id: "B1", issue_severity: "LOW" },
      ],
    });
    assert.ok(high.totalEffortMinutes > low.totalEffortMinutes * 2);
  });

  it("accepts a JSON string", () => {
    const raw = JSON.stringify({
      results: [
        { filename: "x.py", line_number: 1, col_offset: 0, test_id: "B101", issue_severity: "LOW" },
      ],
    });
    assert.equal(adaptBandit(raw).findingCount, 1);
  });

  it("throws on inputs missing the results[] array", () => {
    assert.throws(() => adaptBandit({ not: "a bandit report" }));
  });
});
