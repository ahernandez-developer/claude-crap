/**
 * Unit tests for the workspace crap-config loader.
 *
 * `.claude-crap.json` lives at the user's workspace root and lets
 * teams pick how strictly claude-crap enforces its Stop quality
 * gate. The loader resolves a single `strictness` value from three
 * possible sources, in priority order:
 *
 *   1. `CLAUDE_CRAP_STRICTNESS` environment variable (session override)
 *   2. `.claude-crap.json` at the workspace root
 *   3. Hardcoded default `"strict"`
 *
 * These tests pin both the characterization invariants (defaults,
 * valid values, precedence) and the attack invariants (invalid
 * values are rejected, not silently downgraded).
 *
 * @module tests/crap-config.test
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_STRICTNESS,
  STRICTNESS_VALUES,
  CrapConfigError,
  loadCrapConfig,
  type Strictness,
} from "../crap-config.js";

/**
 * Drop every `CLAUDE_CRAP_STRICTNESS` entry from `process.env` for
 * the duration of one test so stray developer environments don't
 * leak into the assertions.
 */
function unsetStrictnessEnv(): () => void {
  const previous = process.env.CLAUDE_CRAP_STRICTNESS;
  delete process.env.CLAUDE_CRAP_STRICTNESS;
  return () => {
    if (previous === undefined) delete process.env.CLAUDE_CRAP_STRICTNESS;
    else process.env.CLAUDE_CRAP_STRICTNESS = previous;
  };
}

describe("loadCrapConfig — characterization (defaults and valid inputs)", () => {
  let workspace = "";
  let restoreEnv: () => void = () => {};

  before(async () => {
    workspace = await mkdtemp(join(tmpdir(), "claude-crap-config-"));
  });

  after(async () => {
    if (workspace) await rm(workspace, { recursive: true, force: true });
  });

  beforeEach(() => {
    restoreEnv = unsetStrictnessEnv();
  });

  afterEach(() => {
    restoreEnv();
  });

  it("defaults to 'warn' when neither env nor file is present", () => {
    const config = loadCrapConfig({ workspaceRoot: workspace });
    assert.equal(config.strictness, "warn");
    assert.equal(DEFAULT_STRICTNESS, "warn");
  });

  it("exposes the exhaustive list of strictness values as a readonly tuple", () => {
    // Sanity check: every value in STRICTNESS_VALUES must be assignable
    // to the Strictness type, and the list must match the intent of
    // this plugin — strict enforces, warn reports, advisory whispers.
    for (const value of STRICTNESS_VALUES) {
      const typed: Strictness = value;
      assert.ok(["strict", "warn", "advisory"].includes(typed));
    }
    assert.equal(STRICTNESS_VALUES.length, 3);
  });

  it("reads strictness='warn' from .claude-crap.json", async () => {
    const path = join(workspace, ".claude-crap.json");
    await fs.writeFile(path, JSON.stringify({ strictness: "warn" }), "utf8");
    const config = loadCrapConfig({ workspaceRoot: workspace });
    assert.equal(config.strictness, "warn");
    await fs.unlink(path);
  });

  it("reads strictness='advisory' from .claude-crap.json", async () => {
    const path = join(workspace, ".claude-crap.json");
    await fs.writeFile(path, JSON.stringify({ strictness: "advisory" }), "utf8");
    const config = loadCrapConfig({ workspaceRoot: workspace });
    assert.equal(config.strictness, "advisory");
    await fs.unlink(path);
  });

  it("env variable wins over .claude-crap.json", async () => {
    const path = join(workspace, ".claude-crap.json");
    await fs.writeFile(path, JSON.stringify({ strictness: "warn" }), "utf8");
    process.env.CLAUDE_CRAP_STRICTNESS = "strict";
    const config = loadCrapConfig({ workspaceRoot: workspace });
    assert.equal(config.strictness, "strict");
    await fs.unlink(path);
  });

  it("env variable works without any file present", () => {
    process.env.CLAUDE_CRAP_STRICTNESS = "advisory";
    const config = loadCrapConfig({ workspaceRoot: workspace });
    assert.equal(config.strictness, "advisory");
  });

  it("env variable is trimmed and case-insensitive", () => {
    process.env.CLAUDE_CRAP_STRICTNESS = "  WARN  ";
    const config = loadCrapConfig({ workspaceRoot: workspace });
    assert.equal(config.strictness, "warn");
  });

  it("file value is trimmed and case-insensitive", async () => {
    const path = join(workspace, ".claude-crap.json");
    await fs.writeFile(path, JSON.stringify({ strictness: "Advisory" }), "utf8");
    const config = loadCrapConfig({ workspaceRoot: workspace });
    assert.equal(config.strictness, "advisory");
    await fs.unlink(path);
  });

  it("empty env variable is ignored and falls back to file / default", async () => {
    const path = join(workspace, ".claude-crap.json");
    await fs.writeFile(path, JSON.stringify({ strictness: "advisory" }), "utf8");
    process.env.CLAUDE_CRAP_STRICTNESS = "";
    const config = loadCrapConfig({ workspaceRoot: workspace });
    assert.equal(config.strictness, "advisory");
    await fs.unlink(path);
  });

  it("file with no strictness key falls back to default", async () => {
    const path = join(workspace, ".claude-crap.json");
    await fs.writeFile(path, JSON.stringify({ somethingElse: true }), "utf8");
    const config = loadCrapConfig({ workspaceRoot: workspace });
    assert.equal(config.strictness, "warn");
    await fs.unlink(path);
  });
});

describe("loadCrapConfig — attack invariants (invalid inputs rejected)", () => {
  let workspace = "";
  let restoreEnv: () => void = () => {};

  before(async () => {
    workspace = await mkdtemp(join(tmpdir(), "claude-crap-config-bad-"));
  });

  after(async () => {
    if (workspace) await rm(workspace, { recursive: true, force: true });
  });

  beforeEach(() => {
    restoreEnv = unsetStrictnessEnv();
  });

  afterEach(() => {
    restoreEnv();
  });

  it("throws CrapConfigError on invalid env variable value", () => {
    process.env.CLAUDE_CRAP_STRICTNESS = "lenient"; // not in the enum
    assert.throws(
      () => loadCrapConfig({ workspaceRoot: workspace }),
      CrapConfigError,
    );
  });

  it("throws CrapConfigError on invalid file strictness value", async () => {
    const path = join(workspace, ".claude-crap.json");
    await fs.writeFile(path, JSON.stringify({ strictness: "lenient" }), "utf8");
    assert.throws(
      () => loadCrapConfig({ workspaceRoot: workspace }),
      CrapConfigError,
    );
    await fs.unlink(path);
  });

  it("throws CrapConfigError on a malformed JSON file", async () => {
    const path = join(workspace, ".claude-crap.json");
    await fs.writeFile(path, "{ this is not json", "utf8");
    assert.throws(
      () => loadCrapConfig({ workspaceRoot: workspace }),
      CrapConfigError,
    );
    await fs.unlink(path);
  });

  it("throws CrapConfigError when strictness is the wrong JSON type", async () => {
    const path = join(workspace, ".claude-crap.json");
    await fs.writeFile(path, JSON.stringify({ strictness: 42 }), "utf8");
    assert.throws(
      () => loadCrapConfig({ workspaceRoot: workspace }),
      CrapConfigError,
    );
    await fs.unlink(path);
  });

  it("throws CrapConfigError when the JSON root is not an object", async () => {
    const path = join(workspace, ".claude-crap.json");
    await fs.writeFile(path, JSON.stringify(["strict"]), "utf8");
    assert.throws(
      () => loadCrapConfig({ workspaceRoot: workspace }),
      CrapConfigError,
    );
    await fs.unlink(path);
  });

  it("CrapConfigError error messages identify the source that was invalid", () => {
    process.env.CLAUDE_CRAP_STRICTNESS = "supercritical";
    try {
      loadCrapConfig({ workspaceRoot: workspace });
      assert.fail("expected loadCrapConfig to throw");
    } catch (err) {
      assert.ok(err instanceof CrapConfigError);
      assert.match(err.message, /CLAUDE_CRAP_STRICTNESS/);
      assert.match(err.message, /supercritical/);
    }
  });
});
