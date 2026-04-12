/**
 * Unit tests for the /api/file-detail endpoint logic.
 *
 * These tests exercise the file detail builder function directly,
 * without spawning the full MCP server. They verify that source lines,
 * function metrics, and filtered findings are returned correctly.
 *
 * @module tests/file-detail-api.test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { buildFileDetail } from "../dashboard/file-detail.js";
import { TreeSitterEngine } from "../ast/tree-sitter-engine.js";
import { SarifStore } from "../sarif/sarif-store.js";
import { wrapResultsInSarif } from "../adapters/common.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "crap-file-detail-"));
}

const SAMPLE_TS = `export function greet(name: string): string {
  return "hello " + name;
}

export function classify(x: number): string {
  if (x < 0) return "negative";
  if (x === 0) return "zero";
  if (x < 10) return "small";
  if (x < 100) return "medium";
  return "large";
}
`;

describe("buildFileDetail", () => {
  const engine = new TreeSitterEngine();

  it("returns source lines for a valid file", async () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, "hello.ts"), SAMPLE_TS);
      const store = new SarifStore({
        workspaceRoot: dir,
        outputDir: join(dir, ".claude-crap/reports"),
      });
      const result = await buildFileDetail({
        relativePath: "hello.ts",
        workspaceRoot: dir,
        astEngine: engine,
        sarifStore: store,
        cyclomaticMax: 15,
      });
      assert.equal(result.filePath, "hello.ts");
      assert.ok(result.sourceLines.length > 0);
      assert.ok(result.sourceLines[0]!.includes("export function greet"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns function metrics for supported languages", async () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, "hello.ts"), SAMPLE_TS);
      const store = new SarifStore({
        workspaceRoot: dir,
        outputDir: join(dir, ".claude-crap/reports"),
      });
      const result = await buildFileDetail({
        relativePath: "hello.ts",
        workspaceRoot: dir,
        astEngine: engine,
        sarifStore: store,
        cyclomaticMax: 15,
      });
      assert.equal(result.language, "typescript");
      assert.ok(result.functions.length >= 2);
      const greet = result.functions.find((f) => f.name === "greet");
      assert.ok(greet);
      assert.equal(greet.cyclomaticComplexity, 1);
      const classify = result.functions.find((f) => f.name === "classify");
      assert.ok(classify);
      assert.ok(classify.cyclomaticComplexity >= 4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("filters findings to the requested file only", async () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, "a.ts"), 'export const a = 1;\n');
      writeFileSync(join(dir, "b.ts"), 'export const b = 2;\n');

      const store = new SarifStore({
        workspaceRoot: dir,
        outputDir: join(dir, ".claude-crap/reports"),
      });

      // Ingest findings for both files
      const doc = wrapResultsInSarif("eslint" as never, "0.1.0", [
        {
          ruleId: "no-unused-vars",
          level: "warning",
          message: { text: "unused in a" },
          locations: [{
            physicalLocation: {
              artifactLocation: { uri: "a.ts" },
              region: { startLine: 1, startColumn: 1 },
            },
          }],
          properties: { sourceTool: "eslint", effortMinutes: 30 },
        },
        {
          ruleId: "no-unused-vars",
          level: "warning",
          message: { text: "unused in b" },
          locations: [{
            physicalLocation: {
              artifactLocation: { uri: "b.ts" },
              region: { startLine: 1, startColumn: 1 },
            },
          }],
          properties: { sourceTool: "eslint", effortMinutes: 30 },
        },
      ]);
      store.ingestRun(doc, "eslint");

      const result = await buildFileDetail({
        relativePath: "a.ts",
        workspaceRoot: dir,
        astEngine: engine,
        sarifStore: store,
        cyclomaticMax: 15,
      });

      assert.equal(result.findings.length, 1);
      assert.ok(result.findings[0]!.message.includes("unused in a"));
      assert.equal(result.summary.totalFindings, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws for non-existent file", async () => {
    const dir = makeTmpDir();
    try {
      const store = new SarifStore({
        workspaceRoot: dir,
        outputDir: join(dir, ".claude-crap/reports"),
      });
      await assert.rejects(
        buildFileDetail({
          relativePath: "nonexistent.ts",
          workspaceRoot: dir,
          astEngine: engine,
          sarifStore: store,
          cyclomaticMax: 15,
        }),
        /not found|ENOENT/i,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects path traversal attempts", async () => {
    const dir = makeTmpDir();
    try {
      const store = new SarifStore({
        workspaceRoot: dir,
        outputDir: join(dir, ".claude-crap/reports"),
      });
      await assert.rejects(
        buildFileDetail({
          relativePath: "../../etc/passwd",
          workspaceRoot: dir,
          astEngine: engine,
          sarifStore: store,
          cyclomaticMax: 15,
        }),
        /escapes the workspace/i,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns empty functions for unsupported languages", async () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, "data.json"), '{"key": "value"}\n');
      const store = new SarifStore({
        workspaceRoot: dir,
        outputDir: join(dir, ".claude-crap/reports"),
      });
      const result = await buildFileDetail({
        relativePath: "data.json",
        workspaceRoot: dir,
        astEngine: engine,
        sarifStore: store,
        cyclomaticMax: 15,
      });
      assert.equal(result.language, null);
      assert.equal(result.functions.length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("computes summary with correct effort and complexity stats", async () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, "hello.ts"), SAMPLE_TS);
      const store = new SarifStore({
        workspaceRoot: dir,
        outputDir: join(dir, ".claude-crap/reports"),
      });

      const doc = wrapResultsInSarif("eslint" as never, "0.1.0", [
        {
          ruleId: "no-magic-numbers",
          level: "warning",
          message: { text: "magic number" },
          locations: [{
            physicalLocation: {
              artifactLocation: { uri: "hello.ts" },
              region: { startLine: 6, startColumn: 7 },
            },
          }],
          properties: { sourceTool: "eslint", effortMinutes: 30 },
        },
      ]);
      store.ingestRun(doc, "eslint");

      const result = await buildFileDetail({
        relativePath: "hello.ts",
        workspaceRoot: dir,
        astEngine: engine,
        sarifStore: store,
        cyclomaticMax: 15,
      });

      assert.equal(result.summary.totalFindings, 1);
      assert.equal(result.summary.warningCount, 1);
      assert.equal(result.summary.errorCount, 0);
      assert.ok(result.summary.totalEffortMinutes >= 30);
      assert.ok(result.summary.maxComplexity >= 4); // classify has CC>=4
      assert.ok(result.summary.avgComplexity > 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
