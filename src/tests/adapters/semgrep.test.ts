/**
 * Unit tests for the Semgrep SARIF adapter.
 *
 * Semgrep emits SARIF 2.1.0 natively, so the adapter's responsibility
 * is enrichment: add `effortMinutes` and `sourceTool` to every
 * finding's `properties` bag, and normalize `tool.driver.name` to the
 * canonical `"semgrep"` string.
 *
 * @module tests/adapters/semgrep.test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { adaptSemgrep } from "../../adapters/semgrep.js";
import type { PersistedSarif } from "../../sarif/sarif-store.js";

/**
 * Build a minimal semgrep-style SARIF document with one finding.
 */
function makeSemgrepSarif(opts: {
  ruleId?: string;
  level?: "error" | "warning" | "note";
  line?: number;
  column?: number;
}): PersistedSarif {
  return {
    version: "2.1.0",
    runs: [
      {
        tool: { driver: { name: "Semgrep OSS", version: "1.108.0" } },
        results: [
          {
            ruleId: opts.ruleId ?? "python.lang.security.dangerous-call",
            level: opts.level ?? "warning",
            message: { text: "Dangerous call detected" },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: "src/app.py" },
                  region: {
                    startLine: opts.line ?? 12,
                    startColumn: opts.column ?? 3,
                  },
                },
              },
            ],
          },
        ],
      },
    ],
  };
}

describe("adaptSemgrep", () => {
  it("normalizes tool.driver.name to the canonical 'semgrep' value", () => {
    const result = adaptSemgrep(makeSemgrepSarif({}));
    assert.equal(result.sourceTool, "semgrep");
    const driver = result.document.runs[0]?.tool?.driver;
    assert.equal(driver?.name, "semgrep");
    // Original version should be preserved when present.
    assert.equal(driver?.version, "1.108.0");
  });

  it("attaches effortMinutes and sourceTool to every result's properties", () => {
    const result = adaptSemgrep(
      makeSemgrepSarif({ ruleId: "javascript.unused-var", level: "warning" }),
    );
    const firstResult = result.document.runs[0]?.results?.[0] as {
      properties?: { effortMinutes?: number; sourceTool?: string };
    };
    assert.equal(firstResult?.properties?.sourceTool, "semgrep");
    assert.ok(
      typeof firstResult?.properties?.effortMinutes === "number" &&
        firstResult.properties.effortMinutes > 0,
    );
  });

  it("assigns a higher effort budget to security.* rules", () => {
    const securityResult = adaptSemgrep(
      makeSemgrepSarif({ ruleId: "python.lang.security.audit.eval", level: "error" }),
    );
    const stylisticResult = adaptSemgrep(
      makeSemgrepSarif({ ruleId: "python.lang.style.missing-semicolon", level: "warning" }),
    );
    assert.ok(
      securityResult.totalEffortMinutes > stylisticResult.totalEffortMinutes,
      "security rules should cost more than stylistic rules",
    );
  });

  it("assigns even higher effort to named injection classes (sqli, xss, rce, ...)", () => {
    const sqliResult = adaptSemgrep(
      makeSemgrepSarif({ ruleId: "python.django.sqli-raw-sql", level: "error" }),
    );
    const genericSecurityResult = adaptSemgrep(
      makeSemgrepSarif({ ruleId: "python.lang.security.audit.eval", level: "error" }),
    );
    assert.ok(
      sqliResult.totalEffortMinutes >= genericSecurityResult.totalEffortMinutes,
      "sqli-tagged rules should cost at least as much as generic security rules",
    );
  });

  it("accepts a JSON string input", () => {
    const raw = JSON.stringify(makeSemgrepSarif({}));
    const result = adaptSemgrep(raw);
    assert.equal(result.findingCount, 1);
  });

  it("rejects a non-SARIF document", () => {
    assert.throws(() => adaptSemgrep({ version: "2.0.0", runs: [] }));
  });

  it("rejects a string that is not valid JSON", () => {
    assert.throws(() => adaptSemgrep("not json"));
  });

  it("does not mutate the caller's document", () => {
    const doc = makeSemgrepSarif({});
    const originalName = doc.runs[0]?.tool?.driver?.name;
    adaptSemgrep(doc);
    assert.equal(doc.runs[0]?.tool?.driver?.name, originalName);
  });
});
