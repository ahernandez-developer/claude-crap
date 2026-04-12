/**
 * Unit tests for the Stryker mutation-testing adapter.
 *
 * Stryker's mutation report is a per-file map of mutants. The adapter
 * surfaces surviving mutants as SARIF error-level findings, uncovered
 * mutants as warnings, and timeouts as notes. Everything else
 * (killed, compileError, ignored, runtimeError) is suppressed.
 *
 * @module tests/adapters/stryker.test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { adaptStryker } from "../../adapters/stryker.js";

/**
 * Helper that builds a Stryker report shell with a single mutant.
 */
function makeStrykerReport(opts: {
  status: string;
  mutator?: string;
  line?: number;
  column?: number;
}) {
  return {
    schemaVersion: "1.0",
    files: {
      "src/foo.ts": {
        language: "typescript",
        source: "const x = 1;",
        mutants: [
          {
            id: "1",
            mutatorName: opts.mutator ?? "ConditionalExpression",
            replacement: "false",
            location: {
              start: { line: opts.line ?? 10, column: opts.column ?? 5 },
              end: { line: opts.line ?? 10, column: (opts.column ?? 5) + 6 },
            },
            status: opts.status,
          },
        ],
      },
    },
  };
}

describe("adaptStryker", () => {
  it("flags a Survived mutant as a SARIF error", () => {
    const result = adaptStryker(makeStrykerReport({ status: "Survived" }));
    assert.equal(result.sourceTool, "stryker");
    const finding = result.document.runs[0]?.results?.[0] as { level?: string; ruleId?: string };
    assert.equal(finding?.level, "error");
    assert.equal(finding?.ruleId, "stryker.ConditionalExpression");
  });

  it("flags a NoCoverage mutant as a SARIF warning", () => {
    const result = adaptStryker(makeStrykerReport({ status: "NoCoverage" }));
    const finding = result.document.runs[0]?.results?.[0] as { level?: string };
    assert.equal(finding?.level, "warning");
  });

  it("flags a Timeout mutant as a SARIF note", () => {
    const result = adaptStryker(makeStrykerReport({ status: "Timeout" }));
    const finding = result.document.runs[0]?.results?.[0] as { level?: string };
    assert.equal(finding?.level, "note");
  });

  it("suppresses Killed, Ignored, CompileError, and RuntimeError mutants", () => {
    for (const status of ["Killed", "Ignored", "CompileError", "RuntimeError"]) {
      const result = adaptStryker(makeStrykerReport({ status }));
      assert.equal(result.findingCount, 0, `${status} should produce no findings`);
    }
  });

  it("preserves mutant id, mutator name, and status on properties", () => {
    const result = adaptStryker(makeStrykerReport({ status: "Survived" }));
    const finding = result.document.runs[0]?.results?.[0] as {
      properties?: { mutantId?: string; mutator?: string; mutantStatus?: string };
    };
    assert.equal(finding?.properties?.mutantId, "1");
    assert.equal(finding?.properties?.mutator, "ConditionalExpression");
    assert.equal(finding?.properties?.mutantStatus, "Survived");
  });

  it("assigns the correct file URI from the Stryker files{} key", () => {
    const result = adaptStryker(makeStrykerReport({ status: "Survived" }));
    const finding = result.document.runs[0]?.results?.[0] as {
      locations?: Array<{ physicalLocation?: { artifactLocation?: { uri?: string } } }>;
    };
    assert.equal(finding?.locations?.[0]?.physicalLocation?.artifactLocation?.uri, "src/foo.ts");
  });

  it("accepts a JSON string", () => {
    const raw = JSON.stringify(makeStrykerReport({ status: "Survived" }));
    assert.equal(adaptStryker(raw).findingCount, 1);
  });

  it("throws on inputs missing the files{} map", () => {
    assert.throws(() => adaptStryker({ schemaVersion: "1.0" }));
  });
});
