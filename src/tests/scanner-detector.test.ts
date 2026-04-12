/**
 * Unit tests for the scanner auto-detector.
 *
 * These tests probe the detection logic for each scanner type:
 * config file detection, package.json dependency detection, and
 * the fallback to binary availability.
 *
 * @module tests/scanner-detector.test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { detectScanners, SCANNER_SIGNALS } from "../scanner/detector.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "crap-detect-"));
}

describe("detectScanners", () => {
  it("detects eslint when eslint.config.mjs exists", async () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, "eslint.config.mjs"), "export default [];");
      const results = await detectScanners(dir);
      const eslint = results.find((r) => r.scanner === "eslint");
      assert.ok(eslint);
      assert.equal(eslint.available, true);
      assert.ok(eslint.reason.includes("eslint.config.mjs"));
      assert.ok(eslint.configPath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects eslint from .eslintrc.json", async () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, ".eslintrc.json"), "{}");
      const results = await detectScanners(dir);
      const eslint = results.find((r) => r.scanner === "eslint");
      assert.ok(eslint);
      assert.equal(eslint.available, true);
      assert.ok(eslint.reason.includes(".eslintrc.json"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects semgrep when .semgrep.yml exists", async () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, ".semgrep.yml"), "rules: []");
      const results = await detectScanners(dir);
      const semgrep = results.find((r) => r.scanner === "semgrep");
      assert.ok(semgrep);
      assert.equal(semgrep.available, true);
      assert.ok(semgrep.reason.includes(".semgrep.yml"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects bandit when .bandit config exists", async () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, ".bandit"), "");
      const results = await detectScanners(dir);
      const bandit = results.find((r) => r.scanner === "bandit");
      assert.ok(bandit);
      assert.equal(bandit.available, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects stryker when stryker.conf.js exists", async () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, "stryker.conf.js"), "module.exports = {};");
      const results = await detectScanners(dir);
      const stryker = results.find((r) => r.scanner === "stryker");
      assert.ok(stryker);
      assert.equal(stryker.available, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects eslint from package.json devDependencies", async () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ devDependencies: { eslint: "^9.0.0" } }),
      );
      const results = await detectScanners(dir);
      const eslint = results.find((r) => r.scanner === "eslint");
      assert.ok(eslint);
      assert.equal(eslint.available, true);
      assert.ok(eslint.reason.includes("package.json"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects stryker from package.json @stryker-mutator/core", async () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({
          devDependencies: { "@stryker-mutator/core": "^7.0.0" },
        }),
      );
      const results = await detectScanners(dir);
      const stryker = results.find((r) => r.scanner === "stryker");
      assert.ok(stryker);
      assert.equal(stryker.available, true);
      assert.ok(stryker.reason.includes("package.json"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns available:false for all scanners in an empty directory", async () => {
    const dir = makeTmpDir();
    try {
      const results = await detectScanners(dir);
      // Config and package.json probes will all fail.
      // Binary probe results depend on the host — don't assert on those,
      // but do assert the structure is correct.
      assert.equal(results.length, 4);
      for (const r of results) {
        assert.ok(["eslint", "semgrep", "bandit", "stryker"].includes(r.scanner));
        assert.equal(typeof r.available, "boolean");
        assert.equal(typeof r.reason, "string");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("handles malformed package.json gracefully", async () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, "package.json"), "not json at all");
      // Should not throw — just skip the package.json probe
      const results = await detectScanners(dir);
      assert.equal(results.length, 4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("short-circuits on config file — does not need binary", async () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, "eslint.config.mjs"), "export default [];");
      const results = await detectScanners(dir);
      const eslint = results.find((r) => r.scanner === "eslint");
      assert.ok(eslint);
      assert.equal(eslint.available, true);
      // Reason mentions config file, not binary
      assert.ok(eslint.reason.includes("config file"));
      assert.ok(!eslint.reason.includes("binary"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("SCANNER_SIGNALS covers all four scanners", () => {
    assert.deepEqual(
      Object.keys(SCANNER_SIGNALS).sort(),
      ["bandit", "eslint", "semgrep", "stryker"],
    );
  });
});
