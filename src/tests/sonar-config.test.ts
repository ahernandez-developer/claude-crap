/**
 * Unit tests for the workspace sonar-config loader.
 *
 * `.claude-sonar.json` lives at the user's workspace root and lets
 * teams pick how strictly claude-sonar enforces its Stop quality
 * gate. The loader resolves a single `strictness` value from three
 * possible sources, in priority order:
 *
 *   1. `CLAUDE_SONAR_STRICTNESS` environment variable (session override)
 *   2. `.claude-sonar.json` at the workspace root
 *   3. Hardcoded default `"strict"`
 *
 * These tests pin both the characterization invariants (defaults,
 * valid values, precedence) and the attack invariants (invalid
 * values are rejected, not silently downgraded).
 *
 * @module tests/sonar-config.test
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
  SonarConfigError,
  loadSonarConfig,
  type Strictness,
} from "../sonar-config.js";

/**
 * Drop every `CLAUDE_SONAR_STRICTNESS` entry from `process.env` for
 * the duration of one test so stray developer environments don't
 * leak into the assertions.
 */
function unsetStrictnessEnv(): () => void {
  const previous = process.env.CLAUDE_SONAR_STRICTNESS;
  delete process.env.CLAUDE_SONAR_STRICTNESS;
  return () => {
    if (previous === undefined) delete process.env.CLAUDE_SONAR_STRICTNESS;
    else process.env.CLAUDE_SONAR_STRICTNESS = previous;
  };
}

describe("loadSonarConfig — characterization (defaults and valid inputs)", () => {
  let workspace = "";
  let restoreEnv: () => void = () => {};

  before(async () => {
    workspace = await mkdtemp(join(tmpdir(), "claude-sonar-config-"));
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

  it("defaults to 'strict' when neither env nor file is present", () => {
    const config = loadSonarConfig({ workspaceRoot: workspace });
    assert.equal(config.strictness, "strict");
    assert.equal(DEFAULT_STRICTNESS, "strict");
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

  it("reads strictness='warn' from .claude-sonar.json", async () => {
    const path = join(workspace, ".claude-sonar.json");
    await fs.writeFile(path, JSON.stringify({ strictness: "warn" }), "utf8");
    const config = loadSonarConfig({ workspaceRoot: workspace });
    assert.equal(config.strictness, "warn");
    await fs.unlink(path);
  });

  it("reads strictness='advisory' from .claude-sonar.json", async () => {
    const path = join(workspace, ".claude-sonar.json");
    await fs.writeFile(path, JSON.stringify({ strictness: "advisory" }), "utf8");
    const config = loadSonarConfig({ workspaceRoot: workspace });
    assert.equal(config.strictness, "advisory");
    await fs.unlink(path);
  });

  it("env variable wins over .claude-sonar.json", async () => {
    const path = join(workspace, ".claude-sonar.json");
    await fs.writeFile(path, JSON.stringify({ strictness: "warn" }), "utf8");
    process.env.CLAUDE_SONAR_STRICTNESS = "strict";
    const config = loadSonarConfig({ workspaceRoot: workspace });
    assert.equal(config.strictness, "strict");
    await fs.unlink(path);
  });

  it("env variable works without any file present", () => {
    process.env.CLAUDE_SONAR_STRICTNESS = "advisory";
    const config = loadSonarConfig({ workspaceRoot: workspace });
    assert.equal(config.strictness, "advisory");
  });

  it("env variable is trimmed and case-insensitive", () => {
    process.env.CLAUDE_SONAR_STRICTNESS = "  WARN  ";
    const config = loadSonarConfig({ workspaceRoot: workspace });
    assert.equal(config.strictness, "warn");
  });

  it("file value is trimmed and case-insensitive", async () => {
    const path = join(workspace, ".claude-sonar.json");
    await fs.writeFile(path, JSON.stringify({ strictness: "Advisory" }), "utf8");
    const config = loadSonarConfig({ workspaceRoot: workspace });
    assert.equal(config.strictness, "advisory");
    await fs.unlink(path);
  });

  it("empty env variable is ignored and falls back to file / default", async () => {
    const path = join(workspace, ".claude-sonar.json");
    await fs.writeFile(path, JSON.stringify({ strictness: "advisory" }), "utf8");
    process.env.CLAUDE_SONAR_STRICTNESS = "";
    const config = loadSonarConfig({ workspaceRoot: workspace });
    assert.equal(config.strictness, "advisory");
    await fs.unlink(path);
  });

  it("file with no strictness key falls back to default", async () => {
    const path = join(workspace, ".claude-sonar.json");
    await fs.writeFile(path, JSON.stringify({ somethingElse: true }), "utf8");
    const config = loadSonarConfig({ workspaceRoot: workspace });
    assert.equal(config.strictness, "strict");
    await fs.unlink(path);
  });
});

describe("loadSonarConfig — attack invariants (invalid inputs rejected)", () => {
  let workspace = "";
  let restoreEnv: () => void = () => {};

  before(async () => {
    workspace = await mkdtemp(join(tmpdir(), "claude-sonar-config-bad-"));
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

  it("throws SonarConfigError on invalid env variable value", () => {
    process.env.CLAUDE_SONAR_STRICTNESS = "lenient"; // not in the enum
    assert.throws(
      () => loadSonarConfig({ workspaceRoot: workspace }),
      SonarConfigError,
    );
  });

  it("throws SonarConfigError on invalid file strictness value", async () => {
    const path = join(workspace, ".claude-sonar.json");
    await fs.writeFile(path, JSON.stringify({ strictness: "lenient" }), "utf8");
    assert.throws(
      () => loadSonarConfig({ workspaceRoot: workspace }),
      SonarConfigError,
    );
    await fs.unlink(path);
  });

  it("throws SonarConfigError on a malformed JSON file", async () => {
    const path = join(workspace, ".claude-sonar.json");
    await fs.writeFile(path, "{ this is not json", "utf8");
    assert.throws(
      () => loadSonarConfig({ workspaceRoot: workspace }),
      SonarConfigError,
    );
    await fs.unlink(path);
  });

  it("throws SonarConfigError when strictness is the wrong JSON type", async () => {
    const path = join(workspace, ".claude-sonar.json");
    await fs.writeFile(path, JSON.stringify({ strictness: 42 }), "utf8");
    assert.throws(
      () => loadSonarConfig({ workspaceRoot: workspace }),
      SonarConfigError,
    );
    await fs.unlink(path);
  });

  it("throws SonarConfigError when the JSON root is not an object", async () => {
    const path = join(workspace, ".claude-sonar.json");
    await fs.writeFile(path, JSON.stringify(["strict"]), "utf8");
    assert.throws(
      () => loadSonarConfig({ workspaceRoot: workspace }),
      SonarConfigError,
    );
    await fs.unlink(path);
  });

  it("SonarConfigError error messages identify the source that was invalid", () => {
    process.env.CLAUDE_SONAR_STRICTNESS = "supercritical";
    try {
      loadSonarConfig({ workspaceRoot: workspace });
      assert.fail("expected loadSonarConfig to throw");
    } catch (err) {
      assert.ok(err instanceof SonarConfigError);
      assert.match(err.message, /CLAUDE_SONAR_STRICTNESS/);
      assert.match(err.message, /supercritical/);
    }
  });
});
