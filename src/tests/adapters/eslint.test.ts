/**
 * Unit tests for the ESLint adapter.
 *
 * ESLint's native JSON format (`eslint -f json`) is an array of file
 * reports with a `messages[]` array inside each. The adapter flattens
 * every message into a SARIF `result` and maps severity codes
 * 0 / 1 / 2 to "note" / "warning" / "error".
 *
 * @module tests/adapters/eslint.test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { adaptEslint } from "../../adapters/eslint.js";

describe("adaptEslint", () => {
  it("maps severity 2 to SARIF error", () => {
    const raw = [
      {
        filePath: "/abs/src/a.js",
        messages: [
          {
            ruleId: "no-undef",
            severity: 2,
            message: "'foo' is not defined.",
            line: 10,
            column: 5,
          },
        ],
      },
    ];
    const result = adaptEslint(raw);
    const sarifResult = result.document.runs[0]?.results?.[0] as { level?: string };
    assert.equal(sarifResult?.level, "error");
    assert.equal(result.sourceTool, "eslint");
    assert.equal(result.findingCount, 1);
  });

  it("maps severity 1 to SARIF warning and 0 to note", () => {
    const raw = [
      {
        filePath: "/abs/src/b.js",
        messages: [
          { ruleId: "no-unused-vars", severity: 1, message: "warn", line: 1, column: 1 },
          { ruleId: "no-console", severity: 0, message: "off", line: 2, column: 1 },
        ],
      },
    ];
    const result = adaptEslint(raw);
    const levels = (result.document.runs[0]?.results ?? [])
      .map((r) => (r as { level?: string }).level)
      .sort();
    assert.deepEqual(levels, ["note", "warning"]);
  });

  it("propagates line, column, endLine, and endColumn", () => {
    const raw = [
      {
        filePath: "/abs/src/c.js",
        messages: [
          {
            ruleId: "prefer-const",
            severity: 1,
            message: "use const",
            line: 42,
            column: 9,
            endLine: 42,
            endColumn: 15,
          },
        ],
      },
    ];
    const result = adaptEslint(raw);
    const first = result.document.runs[0]?.results?.[0] as {
      locations?: Array<{
        physicalLocation?: {
          region?: { startLine?: number; startColumn?: number; endLine?: number; endColumn?: number };
        };
      }>;
    };
    const region = first?.locations?.[0]?.physicalLocation?.region;
    assert.equal(region?.startLine, 42);
    assert.equal(region?.startColumn, 9);
    assert.equal(region?.endLine, 42);
    assert.equal(region?.endColumn, 15);
  });

  it("flattens multiple file reports into a single run", () => {
    const raw = [
      {
        filePath: "/abs/src/x.js",
        messages: [{ ruleId: "r1", severity: 2, message: "m1", line: 1, column: 1 }],
      },
      {
        filePath: "/abs/src/y.js",
        messages: [{ ruleId: "r2", severity: 1, message: "m2", line: 2, column: 2 }],
      },
    ];
    const result = adaptEslint(raw);
    assert.equal(result.findingCount, 2);
    assert.equal(result.document.runs.length, 1);
  });

  it("accepts a JSON string", () => {
    const raw = JSON.stringify([
      { filePath: "/a.js", messages: [{ ruleId: "r", severity: 2, message: "m", line: 1, column: 1 }] },
    ]);
    const result = adaptEslint(raw);
    assert.equal(result.findingCount, 1);
  });

  it("throws when the input is not an array of file reports", () => {
    assert.throws(() => adaptEslint({ not: "an array" }));
  });

  it("ignores file reports with no filePath", () => {
    const raw = [
      { messages: [{ ruleId: "r", severity: 2, message: "m", line: 1, column: 1 }] },
      {
        filePath: "/a.js",
        messages: [{ ruleId: "r2", severity: 1, message: "m2", line: 1, column: 1 }],
      },
    ];
    const result = adaptEslint(raw);
    assert.equal(result.findingCount, 1);
  });

  it("propagates error budgets proportional to severity", () => {
    const errorOnly = adaptEslint([
      { filePath: "/a.js", messages: [{ ruleId: "r", severity: 2, message: "m", line: 1, column: 1 }] },
    ]);
    const warnOnly = adaptEslint([
      { filePath: "/a.js", messages: [{ ruleId: "r", severity: 1, message: "m", line: 1, column: 1 }] },
    ]);
    assert.ok(errorOnly.totalEffortMinutes > warnOnly.totalEffortMinutes);
  });
});
