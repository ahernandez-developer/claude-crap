/**
 * Unit tests for the cyclomatic complexity scanner.
 *
 * These tests verify that the scanner walks a workspace, analyzes source
 * files with tree-sitter, and emits SARIF findings for functions whose
 * cyclomatic complexity exceeds the configured threshold.
 *
 * @module tests/complexity-scanner.test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pino from "pino";

import { scanComplexity } from "../scanner/complexity-scanner.js";
import { TreeSitterEngine } from "../ast/tree-sitter-engine.js";
import { SarifStore } from "../sarif/sarif-store.js";

const logger = pino({ level: "silent" });

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "crap-complexity-"));
}

/** Simple function: CC = 1 (straight-line). */
const SIMPLE_TS = `
export function greet(name: string): string {
  return "hello " + name;
}
`;

/** Function with CC = 5: 4 if-branches + 1 baseline. */
const COMPLEX_TS = `
export function classify(x: number): string {
  if (x < 0) return "negative";
  if (x === 0) return "zero";
  if (x < 10) return "small";
  if (x < 100) return "medium";
  return "large";
}
`;

/**
 * Extremely complex function: many branches to push CC well above 30.
 * Each if/else-if adds +1, plus boolean operators.
 */
const EXTREME_TS = `
export function extremelyComplex(a: number, b: number, c: number): string {
  if (a > 0) { return "a1"; }
  if (a > 1) { return "a2"; }
  if (a > 2) { return "a3"; }
  if (a > 3) { return "a4"; }
  if (a > 4) { return "a5"; }
  if (a > 5) { return "a6"; }
  if (a > 6) { return "a7"; }
  if (a > 7) { return "a8"; }
  if (a > 8) { return "a9"; }
  if (a > 9) { return "a10"; }
  if (b > 0) { return "b1"; }
  if (b > 1) { return "b2"; }
  if (b > 2) { return "b3"; }
  if (b > 3) { return "b4"; }
  if (b > 4) { return "b5"; }
  if (b > 5) { return "b6"; }
  if (b > 6) { return "b7"; }
  if (b > 7) { return "b8"; }
  if (b > 8) { return "b9"; }
  if (b > 9) { return "b10"; }
  if (c > 0) { return "c1"; }
  if (c > 1) { return "c2"; }
  if (c > 2) { return "c3"; }
  if (c > 3) { return "c4"; }
  if (c > 4) { return "c5"; }
  if (c > 5) { return "c6"; }
  if (c > 6) { return "c7"; }
  if (c > 7) { return "c8"; }
  if (c > 8) { return "c9"; }
  if (c > 9) { return "c10"; }
  return "default";
}
`;

describe("scanComplexity", () => {
  const engine = new TreeSitterEngine();

  it("returns zero violations for an empty workspace", async () => {
    const dir = makeTmpDir();
    try {
      const store = new SarifStore({
        workspaceRoot: dir,
        outputDir: join(dir, ".claude-crap/reports"),
      });
      const result = await scanComplexity(
        dir, engine, store, { cyclomaticMax: 15 }, logger,
      );
      assert.equal(result.violations, 0);
      assert.equal(result.filesScanned, 0);
      assert.equal(result.functionsAnalyzed, 0);
      assert.ok(result.durationMs >= 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("finds no violations when all functions are below threshold", async () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, "simple.ts"), SIMPLE_TS);
      const store = new SarifStore({
        workspaceRoot: dir,
        outputDir: join(dir, ".claude-crap/reports"),
      });
      const result = await scanComplexity(
        dir, engine, store, { cyclomaticMax: 15 }, logger,
      );
      assert.equal(result.violations, 0);
      assert.equal(result.filesScanned, 1);
      assert.ok(result.functionsAnalyzed >= 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("flags functions above cyclomaticMax as warnings", async () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, "complex.ts"), COMPLEX_TS);
      const store = new SarifStore({
        workspaceRoot: dir,
        outputDir: join(dir, ".claude-crap/reports"),
      });
      // Set threshold to 3 so the CC=5 function triggers
      const result = await scanComplexity(
        dir, engine, store, { cyclomaticMax: 3 }, logger,
      );
      assert.equal(result.violations, 1);

      // Verify the finding is in the SARIF store
      const findings = store.list();
      const complexityFindings = findings.filter(
        (f) => f.ruleId === "complexity/cyclomatic-max",
      );
      assert.equal(complexityFindings.length, 1);
      assert.equal(complexityFindings[0]!.level, "warning");
      assert.equal(complexityFindings[0]!.sourceTool, "complexity");
      assert.ok(complexityFindings[0]!.message.includes("classify"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("emits error level for functions at >= 2x threshold", async () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, "extreme.ts"), EXTREME_TS);
      const store = new SarifStore({
        workspaceRoot: dir,
        outputDir: join(dir, ".claude-crap/reports"),
      });
      // threshold=15, CC=31 → 31 >= 30 (2x15) → error
      const result = await scanComplexity(
        dir, engine, store, { cyclomaticMax: 15 }, logger,
      );
      assert.equal(result.violations, 1);

      const findings = store.list();
      const complexityFindings = findings.filter(
        (f) => f.ruleId === "complexity/cyclomatic-max",
      );
      assert.equal(complexityFindings.length, 1);
      assert.equal(complexityFindings[0]!.level, "error");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips directories in SKIP_DIRS", async () => {
    const dir = makeTmpDir();
    try {
      // Put a complex file inside node_modules — should be skipped
      const nmDir = join(dir, "node_modules", "pkg");
      mkdirSync(nmDir, { recursive: true });
      writeFileSync(join(nmDir, "index.ts"), COMPLEX_TS);

      const store = new SarifStore({
        workspaceRoot: dir,
        outputDir: join(dir, ".claude-crap/reports"),
      });
      const result = await scanComplexity(
        dir, engine, store, { cyclomaticMax: 3 }, logger,
      );
      assert.equal(result.filesScanned, 0);
      assert.equal(result.violations, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips unsupported file extensions", async () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, "data.json"), '{"key": "value"}');
      writeFileSync(join(dir, "readme.md"), "# Hello");
      writeFileSync(join(dir, "styles.css"), "body {}");

      const store = new SarifStore({
        workspaceRoot: dir,
        outputDir: join(dir, ".claude-crap/reports"),
      });
      const result = await scanComplexity(
        dir, engine, store, { cyclomaticMax: 15 }, logger,
      );
      assert.equal(result.filesScanned, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("respects custom cyclomaticMax threshold", async () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, "complex.ts"), COMPLEX_TS);
      const store = new SarifStore({
        workspaceRoot: dir,
        outputDir: join(dir, ".claude-crap/reports"),
      });
      // CC=5, threshold=10 → no violation
      const result = await scanComplexity(
        dir, engine, store, { cyclomaticMax: 10 }, logger,
      );
      assert.equal(result.violations, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sets effortMinutes and cyclomaticComplexity in finding properties", async () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, "complex.ts"), COMPLEX_TS);
      const store = new SarifStore({
        workspaceRoot: dir,
        outputDir: join(dir, ".claude-crap/reports"),
      });
      const result = await scanComplexity(
        dir, engine, store, { cyclomaticMax: 3 }, logger,
      );
      assert.equal(result.violations, 1);

      const findings = store.list();
      const finding = findings.find((f) => f.ruleId === "complexity/cyclomatic-max");
      assert.ok(finding);
      assert.equal(typeof finding.properties?.effortMinutes, "number");
      assert.ok((finding.properties?.effortMinutes as number) > 0);
      assert.equal(typeof finding.properties?.cyclomaticComplexity, "number");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
