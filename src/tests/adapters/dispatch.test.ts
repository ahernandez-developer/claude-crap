/**
 * Unit tests for the `adaptScannerOutput` dispatcher.
 *
 * The dispatcher is a thin switch that picks the right adapter based
 * on the `scanner` argument. These tests pin the happy path per
 * scanner and the error path for unknown names.
 *
 * @module tests/adapters/dispatch.test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { adaptScannerOutput, KNOWN_SCANNERS } from "../../adapters/index.js";

describe("adaptScannerOutput", () => {
  it("routes semgrep input through the semgrep adapter", () => {
    const result = adaptScannerOutput("semgrep", {
      version: "2.1.0",
      runs: [
        {
          tool: { driver: { name: "semgrep", version: "1" } },
          results: [
            {
              ruleId: "r1",
              level: "error",
              message: { text: "m" },
              locations: [
                {
                  physicalLocation: {
                    artifactLocation: { uri: "a.py" },
                    region: { startLine: 1, startColumn: 1 },
                  },
                },
              ],
            },
          ],
        },
      ],
    });
    assert.equal(result.sourceTool, "semgrep");
    assert.equal(result.findingCount, 1);
  });

  it("routes eslint input through the eslint adapter", () => {
    const result = adaptScannerOutput("eslint", [
      {
        filePath: "/a.js",
        messages: [{ ruleId: "no-undef", severity: 2, message: "m", line: 1, column: 1 }],
      },
    ]);
    assert.equal(result.sourceTool, "eslint");
    assert.equal(result.findingCount, 1);
  });

  it("routes bandit input through the bandit adapter", () => {
    const result = adaptScannerOutput("bandit", {
      results: [
        { filename: "a.py", line_number: 1, col_offset: 0, test_id: "B101", issue_severity: "LOW" },
      ],
    });
    assert.equal(result.sourceTool, "bandit");
    assert.equal(result.findingCount, 1);
  });

  it("routes stryker input through the stryker adapter", () => {
    const result = adaptScannerOutput("stryker", {
      schemaVersion: "1.0",
      files: {
        "src/a.ts": {
          mutants: [
            {
              id: "1",
              mutatorName: "Cond",
              replacement: "!",
              location: {
                start: { line: 1, column: 1 },
                end: { line: 1, column: 5 },
              },
              status: "Survived",
            },
          ],
        },
      },
    });
    assert.equal(result.sourceTool, "stryker");
    assert.equal(result.findingCount, 1);
  });

  it("throws on unknown scanner names", () => {
    // Cast through unknown → string to keep the test compile-time safe
    // while we exercise the runtime exhaustiveness guard.
    const scanner = "does-not-exist" as unknown as "semgrep";
    assert.throws(() => adaptScannerOutput(scanner, {}));
  });

  it("KNOWN_SCANNERS is frozen and contains all supported names", () => {
    assert.deepEqual([...KNOWN_SCANNERS].sort(), ["bandit", "dart_analyze", "dotnet_format", "eslint", "semgrep", "stryker"]);
  });
});
