/**
 * Unit tests for the scanner runner.
 *
 * These tests verify the command definitions and error handling of the
 * runner module. Actual scanner execution is not tested here — that
 * requires the scanner binaries to be installed.
 *
 * @module tests/scanner-runner.test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { getScannerCommand, type ScannerCommand } from "../scanner/runner.js";

describe("getScannerCommand", () => {
  it("returns correct eslint command", () => {
    const cmd = getScannerCommand("eslint", "/tmp/project");
    assert.equal(cmd.command, "npx");
    assert.deepEqual(cmd.args, ["eslint", "-f", "json", "."]);
    assert.equal(cmd.nonZeroIsNormal, true);
    assert.equal(cmd.outputFile, undefined);
  });

  it("returns correct semgrep command", () => {
    const cmd = getScannerCommand("semgrep", "/tmp/project");
    assert.equal(cmd.command, "semgrep");
    assert.deepEqual(cmd.args, ["--sarif", "--quiet", "."]);
    assert.equal(cmd.nonZeroIsNormal, false);
    assert.equal(cmd.outputFile, undefined);
  });

  it("returns correct bandit command", () => {
    const cmd = getScannerCommand("bandit", "/tmp/project");
    assert.equal(cmd.command, "bandit");
    assert.deepEqual(cmd.args, ["-f", "json", "-r", ".", "-q"]);
    assert.equal(cmd.nonZeroIsNormal, true);
    assert.equal(cmd.outputFile, undefined);
  });

  it("returns correct stryker command with output file", () => {
    const cmd = getScannerCommand("stryker", "/tmp/project");
    assert.equal(cmd.command, "npx");
    assert.deepEqual(cmd.args, ["stryker", "run"]);
    assert.equal(cmd.nonZeroIsNormal, false);
    assert.ok(cmd.outputFile);
    assert.ok(cmd.outputFile.includes("mutation.json"));
  });

  it("all scanners have reasonable timeouts", () => {
    for (const scanner of ["eslint", "semgrep", "bandit", "stryker"] as const) {
      const cmd = getScannerCommand(scanner, "/tmp");
      assert.ok(cmd.timeoutMs >= 60_000, `${scanner} timeout should be >= 60s`);
      assert.ok(cmd.timeoutMs <= 300_000, `${scanner} timeout should be <= 300s`);
    }
  });

  it("stryker has a longer timeout than other scanners", () => {
    const stryker = getScannerCommand("stryker", "/tmp");
    const eslint = getScannerCommand("eslint", "/tmp");
    assert.ok(stryker.timeoutMs > eslint.timeoutMs);
  });
});
