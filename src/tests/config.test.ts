/**
 * Characterization tests for the MCP server config loader.
 *
 * `loadConfig()` resolves `pluginRoot` from three env vars with
 * strict priority:
 *
 *   1. `CLAUDE_PROJECT_DIR`      — set by Claude Code to the workspace
 *   2. `CLAUDE_CRAP_PLUGIN_ROOT` — legacy explicit override
 *   3. `process.cwd()`           — last-resort fallback
 *
 * These tests pin the priority chain and the numeric/rating parsers
 * so that regressions in workspace resolution are caught before they
 * ship a bundle that writes SARIF reports into the plugin cache.
 *
 * @module tests/config.test
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { loadConfig } from "../config.js";

/* ── env snapshot / restore ─────────────────────────────────────── */

const ENV_KEYS = [
  "CLAUDE_PROJECT_DIR",
  "CLAUDE_CRAP_PLUGIN_ROOT",
  "CLAUDE_CRAP_SARIF_OUTPUT_DIR",
  "CLAUDE_CRAP_CRAP_THRESHOLD",
  "CLAUDE_CRAP_CYCLOMATIC_MAX",
  "CLAUDE_CRAP_TDR_MAX_RATING",
  "CLAUDE_CRAP_MINUTES_PER_LOC",
  "CLAUDE_CRAP_DASHBOARD_PORT",
] as const;

type Snapshot = Map<string, string | undefined>;

function snapshotEnv(): Snapshot {
  const snap = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) snap.set(key, process.env[key]);
  return snap;
}

function restoreEnv(snap: Snapshot): void {
  for (const [key, val] of snap) {
    if (val === undefined) delete process.env[key];
    else process.env[key] = val;
  }
}

function clearConfigEnv(): void {
  for (const key of ENV_KEYS) delete process.env[key];
}

/* ── tests ──────────────────────────────────────────────────────── */

describe("loadConfig — pluginRoot priority chain", () => {
  let saved: Snapshot;

  beforeEach(() => {
    saved = snapshotEnv();
    clearConfigEnv();
  });

  afterEach(() => {
    restoreEnv(saved);
  });

  it("falls back to process.cwd() when no env vars are set", () => {
    const cfg = loadConfig();
    assert.equal(cfg.pluginRoot, process.cwd());
  });

  it("CLAUDE_CRAP_PLUGIN_ROOT wins over process.cwd()", () => {
    process.env.CLAUDE_CRAP_PLUGIN_ROOT = "/explicit/plugin/root";
    const cfg = loadConfig();
    assert.equal(cfg.pluginRoot, "/explicit/plugin/root");
  });

  it("CLAUDE_PROJECT_DIR wins over CLAUDE_CRAP_PLUGIN_ROOT", () => {
    process.env.CLAUDE_PROJECT_DIR = "/workspace/project";
    process.env.CLAUDE_CRAP_PLUGIN_ROOT = "/explicit/plugin/root";
    const cfg = loadConfig();
    assert.equal(cfg.pluginRoot, "/workspace/project");
  });

  it("CLAUDE_PROJECT_DIR alone resolves correctly", () => {
    process.env.CLAUDE_PROJECT_DIR = "/workspace/project";
    const cfg = loadConfig();
    assert.equal(cfg.pluginRoot, "/workspace/project");
  });
});

describe("loadConfig — defaults", () => {
  let saved: Snapshot;

  beforeEach(() => {
    saved = snapshotEnv();
    clearConfigEnv();
  });

  afterEach(() => {
    restoreEnv(saved);
  });

  it("sarifOutputDir defaults to .claude-crap/reports", () => {
    assert.equal(loadConfig().sarifOutputDir, ".claude-crap/reports");
  });

  it("crapThreshold defaults to 30", () => {
    assert.equal(loadConfig().crapThreshold, 30);
  });

  it("cyclomaticMax defaults to 15", () => {
    assert.equal(loadConfig().cyclomaticMax, 15);
  });

  it("tdrMaxRating defaults to C", () => {
    assert.equal(loadConfig().tdrMaxRating, "C");
  });

  it("minutesPerLoc defaults to 30", () => {
    assert.equal(loadConfig().minutesPerLoc, 30);
  });

  it("dashboardPort defaults to 5117", () => {
    assert.equal(loadConfig().dashboardPort, 5117);
  });
});

describe("loadConfig — numeric parsing", () => {
  let saved: Snapshot;

  beforeEach(() => {
    saved = snapshotEnv();
    clearConfigEnv();
  });

  afterEach(() => {
    restoreEnv(saved);
  });

  it("reads CLAUDE_CRAP_CRAP_THRESHOLD from env", () => {
    process.env.CLAUDE_CRAP_CRAP_THRESHOLD = "50";
    assert.equal(loadConfig().crapThreshold, 50);
  });

  it("throws on non-numeric CLAUDE_CRAP_CRAP_THRESHOLD", () => {
    process.env.CLAUDE_CRAP_CRAP_THRESHOLD = "not-a-number";
    assert.throws(() => loadConfig(), /not a finite number/);
  });

  it("ignores empty string and falls back to default", () => {
    process.env.CLAUDE_CRAP_CRAP_THRESHOLD = "";
    assert.equal(loadConfig().crapThreshold, 30);
  });
});

describe("loadConfig — rating parsing", () => {
  let saved: Snapshot;

  beforeEach(() => {
    saved = snapshotEnv();
    clearConfigEnv();
  });

  afterEach(() => {
    restoreEnv(saved);
  });

  it("accepts lowercase rating", () => {
    process.env.CLAUDE_CRAP_TDR_MAX_RATING = "a";
    assert.equal(loadConfig().tdrMaxRating, "A");
  });

  it("accepts padded rating", () => {
    process.env.CLAUDE_CRAP_TDR_MAX_RATING = "  B  ";
    assert.equal(loadConfig().tdrMaxRating, "B");
  });

  it("throws on invalid rating letter", () => {
    process.env.CLAUDE_CRAP_TDR_MAX_RATING = "F";
    assert.throws(() => loadConfig(), /must be one of A, B, C, D, E/);
  });
});
