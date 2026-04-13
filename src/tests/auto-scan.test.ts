/**
 * Unit tests for the auto-scan orchestrator.
 *
 * These tests verify the orchestration logic: detection → run → ingest.
 * They use a real (temporary) workspace with config files to trigger
 * detection, but scanner execution will fail (binaries aren't installed
 * in the test environment). This tests the graceful-failure path.
 *
 * @module tests/auto-scan.test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pino from "pino";

import { autoScan, type AutoScanResult } from "../scanner/auto-scan.js";
import { SarifStore } from "../sarif/sarif-store.js";

const logger = pino({ level: "silent" });

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "crap-autoscan-"));
}

describe("autoScan", () => {
  it("returns empty results when no scanners are detected", async () => {
    const dir = makeTmpDir();
    try {
      const store = new SarifStore({
        workspaceRoot: dir,
        outputDir: join(dir, ".claude-crap/reports"),
      });
      const result = await autoScan(dir, store, logger);
      assert.equal(result.detected.length, 5);
      assert.ok(result.totalDurationMs >= 0);
      // No scanners available means no results
      // (unless the host has scanner binaries installed)
      assert.ok(Array.isArray(result.results));
      assert.equal(typeof result.totalFindings, "number");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects scanners from config files in workspace", async () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, "eslint.config.mjs"), "export default [];");
      writeFileSync(join(dir, ".semgrep.yml"), "rules: []");

      const store = new SarifStore({
        workspaceRoot: dir,
        outputDir: join(dir, ".claude-crap/reports"),
      });
      const result = await autoScan(dir, store, logger);

      // ESLint and Semgrep should be detected
      const eslintDetection = result.detected.find((d) => d.scanner === "eslint");
      const semgrepDetection = result.detected.find((d) => d.scanner === "semgrep");
      assert.ok(eslintDetection);
      assert.equal(eslintDetection.available, true);
      assert.ok(semgrepDetection);
      assert.equal(semgrepDetection.available, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns correct structure even when all scanners fail", async () => {
    const dir = makeTmpDir();
    try {
      // Create config files so scanners are detected but will fail to run
      // (the temp dir isn't a real project)
      writeFileSync(join(dir, "eslint.config.mjs"), "export default [];");

      const store = new SarifStore({
        workspaceRoot: dir,
        outputDir: join(dir, ".claude-crap/reports"),
      });
      const result = await autoScan(dir, store, logger);

      // Structure must be valid regardless of scanner success
      assert.ok(Array.isArray(result.detected));
      assert.ok(Array.isArray(result.results));
      assert.equal(typeof result.totalFindings, "number");
      assert.equal(typeof result.totalDurationMs, "number");

      // eslint was detected, so it should appear in results
      const eslintResult = result.results.find((r) => r.scanner === "eslint");
      if (eslintResult) {
        assert.equal(typeof eslintResult.success, "boolean");
        assert.equal(typeof eslintResult.durationMs, "number");
        assert.equal(typeof eslintResult.findingsIngested, "number");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("totalFindings sums findings across all successful scanners", async () => {
    const dir = makeTmpDir();
    try {
      const store = new SarifStore({
        workspaceRoot: dir,
        outputDir: join(dir, ".claude-crap/reports"),
      });
      const result = await autoScan(dir, store, logger);

      // Sum of individual scanner findings should equal total
      const sumFromResults = result.results
        .filter((r) => r.success)
        .reduce((sum, r) => sum + r.findingsIngested, 0);
      assert.equal(result.totalFindings, sumFromResults);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("result has one ScannerDetection per known scanner", async () => {
    const dir = makeTmpDir();
    try {
      const store = new SarifStore({
        workspaceRoot: dir,
        outputDir: join(dir, ".claude-crap/reports"),
      });
      const result = await autoScan(dir, store, logger);

      const scannerNames = result.detected.map((d) => d.scanner).sort();
      assert.deepEqual(scannerNames, ["bandit", "dart_analyze", "eslint", "semgrep", "stryker"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
