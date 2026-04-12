/**
 * Unit tests for the AJV-backed SARIF validator.
 *
 * F-A05-01: the `ingest_sarif` MCP tool used to accept any object
 * shaped like `{version: "2.1.0", runs: [...]}` without verifying
 * the inner structure. These tests pin (a) the characterization
 * invariants — valid minimal SARIF documents still pass — and (b)
 * the attack invariants — every kind of malformed input throws a
 * `SarifValidationError`.
 *
 * @module tests/sarif-validator.test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  SarifValidationError,
  validateSarifDocument,
} from "../sarif/sarif-validator.js";

/**
 * Produce a minimal, fully-valid SARIF 2.1.0 document with a single
 * result. Tests use this as the "known good" baseline and then mutate
 * one field at a time to exercise a specific validator branch.
 */
function validMinimalSarif(): unknown {
  return {
    version: "2.1.0",
    runs: [
      {
        tool: { driver: { name: "semgrep", version: "1.50.0" } },
        results: [
          {
            ruleId: "R1",
            level: "warning",
            message: { text: "a finding" },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: "src/a.ts" },
                  region: { startLine: 1, startColumn: 1 },
                },
              },
            ],
          },
        ],
      },
    ],
  };
}

describe("validateSarifDocument — characterization (valid docs pass)", () => {
  it("accepts a minimal valid SARIF 2.1.0 document", () => {
    assert.doesNotThrow(() => validateSarifDocument(validMinimalSarif()));
  });

  it("accepts a document with multiple runs", () => {
    const doc = validMinimalSarif() as { runs: unknown[] };
    doc.runs.push({
      tool: { driver: { name: "eslint", version: "8" } },
      results: [],
    });
    assert.doesNotThrow(() => validateSarifDocument(doc));
  });

  it("accepts a result with no locations array (passthrough)", () => {
    const doc = validMinimalSarif() as any;
    delete doc.runs[0].results[0].locations;
    assert.doesNotThrow(() => validateSarifDocument(doc));
  });

  it("accepts a result with an extra passthrough property", () => {
    const doc = validMinimalSarif() as any;
    doc.runs[0].results[0].customExtensionField = { foo: "bar" };
    assert.doesNotThrow(() => validateSarifDocument(doc));
  });

  it("accepts a document with an empty results array", () => {
    const doc = validMinimalSarif() as any;
    doc.runs[0].results = [];
    assert.doesNotThrow(() => validateSarifDocument(doc));
  });
});

describe("validateSarifDocument — attack invariants", () => {
  it("rejects non-object input (null)", () => {
    assert.throws(() => validateSarifDocument(null), SarifValidationError);
  });

  it("rejects non-object input (string)", () => {
    assert.throws(() => validateSarifDocument("not a sarif doc"), SarifValidationError);
  });

  it("rejects input with wrong version", () => {
    const doc = validMinimalSarif() as any;
    doc.version = "2.0.0";
    assert.throws(() => validateSarifDocument(doc), SarifValidationError);
  });

  it("rejects input missing the runs field", () => {
    const doc = validMinimalSarif() as any;
    delete doc.runs;
    assert.throws(() => validateSarifDocument(doc), SarifValidationError);
  });

  it("rejects input where runs is not an array", () => {
    const doc = validMinimalSarif() as any;
    doc.runs = { notAnArray: true };
    assert.throws(() => validateSarifDocument(doc), SarifValidationError);
  });

  it("rejects a run with no tool.driver", () => {
    const doc = validMinimalSarif() as any;
    delete doc.runs[0].tool;
    assert.throws(() => validateSarifDocument(doc), SarifValidationError);
  });

  it("rejects a run with no results array", () => {
    const doc = validMinimalSarif() as any;
    delete doc.runs[0].results;
    assert.throws(() => validateSarifDocument(doc), SarifValidationError);
  });

  it("rejects a result missing ruleId", () => {
    const doc = validMinimalSarif() as any;
    delete doc.runs[0].results[0].ruleId;
    assert.throws(() => validateSarifDocument(doc), SarifValidationError);
  });

  it("rejects a result with an empty ruleId", () => {
    const doc = validMinimalSarif() as any;
    doc.runs[0].results[0].ruleId = "";
    assert.throws(() => validateSarifDocument(doc), SarifValidationError);
  });

  it("rejects a result missing message", () => {
    const doc = validMinimalSarif() as any;
    delete doc.runs[0].results[0].message;
    assert.throws(() => validateSarifDocument(doc), SarifValidationError);
  });

  it("rejects a result with an empty message.text", () => {
    const doc = validMinimalSarif() as any;
    doc.runs[0].results[0].message.text = "";
    assert.throws(() => validateSarifDocument(doc), SarifValidationError);
  });

  it("rejects a result with a non-enum level", () => {
    const doc = validMinimalSarif() as any;
    doc.runs[0].results[0].level = "critical"; // not in {none,note,warning,error}
    assert.throws(() => validateSarifDocument(doc), SarifValidationError);
  });

  it("exposes the AJV error list on the thrown error", () => {
    try {
      validateSarifDocument({ version: "2.1.0", runs: "not-an-array" });
      assert.fail("expected validateSarifDocument to throw");
    } catch (err) {
      assert.ok(err instanceof SarifValidationError);
      assert.ok(Array.isArray(err.errors) || err.errors === null);
    }
  });
});
