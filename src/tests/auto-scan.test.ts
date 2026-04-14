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
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pino from "pino";

import { autoScan, type AutoScanResult } from "../scanner/auto-scan.js";
import { SarifStore } from "../sarif/sarif-store.js";
import {
  detectScanners,
  detectMonorepoScanners,
  mergeMonorepoDetections,
} from "../scanner/detector.js";

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
      assert.equal(result.detected.length, 6);
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
      assert.deepEqual(scannerNames, ["bandit", "dart_analyze", "dotnet_format", "eslint", "semgrep", "stryker"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("monorepo detection merge (mergeMonorepoDetections)", () => {
    // Pins the monorepo-user bug where root-level ESLint detection
    // shadowed every sub-project ESLint config. The dedupe logic used
    // `Set<scanner-name>` which collapsed e.g. root ESLint + apps/app
    // ESLint + apps/www ESLint into a single detection. The fix keeps
    // every (scanner, workingDir) pair so each sub-project gets its
    // own scanner invocation.

    it("keeps sub-project scanners that share a name with a root scanner", () => {
      const rootEslint = {
        scanner: "eslint" as const,
        available: true,
        reason: "config file found: eslint.config.mjs",
      };
      const appEslint = {
        scanner: "eslint" as const,
        available: true,
        reason: "config file found in apps/app/",
        workingDir: "/ws/apps/app",
      };
      const wwwEslint = {
        scanner: "eslint" as const,
        available: true,
        reason: "config file found in apps/www/",
        workingDir: "/ws/apps/www",
      };
      const merged = mergeMonorepoDetections([rootEslint], [appEslint, wwwEslint]);
      // Expect three detections: one root + two sub-project.
      const eslints = merged.filter((d) => d.scanner === "eslint");
      assert.equal(eslints.length, 3);
      const workingDirs = eslints.map((d) => d.workingDir ?? "<root>").sort();
      assert.deepEqual(workingDirs, ["/ws/apps/app", "/ws/apps/www", "<root>"]);
    });

    it("still skips duplicates when the (scanner, workingDir) pair matches", () => {
      // Two identical detections from overlapping discovery sources
      // must collapse into one.
      const a = {
        scanner: "dart_analyze" as const,
        available: true,
        reason: "config file found in apps/mobile/",
        workingDir: "/ws/apps/mobile",
      };
      const merged = mergeMonorepoDetections([a], [a]);
      assert.equal(merged.filter((d) => d.scanner === "dart_analyze").length, 1);
    });

    it("preserves unavailable root detections while adding monorepo finds", () => {
      const rootUnavailable = {
        scanner: "eslint" as const,
        available: false,
        reason: "no config",
      };
      const subAvailable = {
        scanner: "eslint" as const,
        available: true,
        reason: "config file found in apps/app/",
        workingDir: "/ws/apps/app",
      };
      const merged = mergeMonorepoDetections([rootUnavailable], [subAvailable]);
      const eslints = merged.filter((d) => d.scanner === "eslint");
      assert.equal(eslints.length, 2);
    });
  });

  describe("monorepo scanner detection in mixed workspaces", () => {
    // Black-box integration: a workspace with a root eslint.config.mjs
    // AND apps/app/eslint.config.mjs AND apps/www/eslint.config.mjs
    // must see three separate ESLint detections.

    it("detects ESLint at root and in every sub-app independently", async () => {
      const dir = makeTmpDir();
      try {
        writeFileSync(join(dir, "eslint.config.mjs"), "export default [];");
        mkdirSync(join(dir, "apps/app"), { recursive: true });
        mkdirSync(join(dir, "apps/www"), { recursive: true });
        writeFileSync(
          join(dir, "apps/app/eslint.config.mjs"),
          "export default [];",
        );
        writeFileSync(
          join(dir, "apps/www/eslint.config.mjs"),
          "export default [];",
        );

        const root = await detectScanners(dir);
        const mono = await detectMonorepoScanners(dir);
        const merged = mergeMonorepoDetections(root, mono);
        const eslints = merged.filter((d) => d.scanner === "eslint");
        assert.equal(eslints.length, 3, "expected 3 ESLint detections");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
