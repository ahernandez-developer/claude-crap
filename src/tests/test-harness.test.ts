/**
 * Unit tests for the test-file resolver used by `require_test_harness`.
 *
 * Uses a temp workspace populated with a handful of source and test
 * files so we can exercise every resolver convention (sibling, mirror
 * tree, Python prefix) in isolation.
 *
 * @module tests/test-harness.test
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { candidatePaths, findTestFile, isTestFile } from "../tools/test-harness.js";

describe("isTestFile", () => {
  it("recognizes .test.ts suffix", () => {
    assert.equal(isTestFile("src/foo.test.ts"), true);
  });

  it("recognizes .spec.js suffix", () => {
    assert.equal(isTestFile("app/bar.spec.js"), true);
  });

  it("recognizes python test_ prefix", () => {
    assert.equal(isTestFile("pkg/test_mod.py"), true);
  });

  it("recognizes __tests__ directory name", () => {
    assert.equal(isTestFile("src/__tests__/foo.ts"), true);
  });

  it("rejects plain source files", () => {
    assert.equal(isTestFile("src/foo.ts"), false);
    assert.equal(isTestFile("src/utils/math.py"), false);
  });
});

describe("candidatePaths", () => {
  it("lists sibling test locations first", () => {
    const candidates = candidatePaths("/ws", "/ws/src/foo.ts");
    assert.ok(candidates.includes("/ws/src/foo.test.ts"));
    assert.ok(candidates.includes("/ws/src/foo.spec.ts"));
  });

  it("includes mirror-tree candidates under tests/", () => {
    const candidates = candidatePaths("/ws", "/ws/src/foo.ts");
    assert.ok(candidates.includes("/ws/tests/src/foo.test.ts"));
  });

  it("includes nearest-ancestor flat tests directory candidates", () => {
    // For src/mcp-server/src/metrics/crap.ts the walker should probe
    // every ancestor `tests/` dir up to the workspace root.
    const candidates = candidatePaths(
      "/ws",
      "/ws/src/mcp-server/src/metrics/crap.ts",
    );
    assert.ok(candidates.includes("/ws/src/mcp-server/src/metrics/tests/crap.test.ts"));
    assert.ok(candidates.includes("/ws/src/mcp-server/src/tests/crap.test.ts"));
    assert.ok(candidates.includes("/ws/src/mcp-server/tests/crap.test.ts"));
    assert.ok(candidates.includes("/ws/src/tests/crap.test.ts"));
    assert.ok(candidates.includes("/ws/tests/crap.test.ts"));
  });

  it("stops walking at the workspace root", () => {
    // Make sure the walker does not produce candidates OUTSIDE the workspace.
    const candidates = candidatePaths("/ws", "/ws/src/foo.ts");
    for (const c of candidates) {
      assert.ok(c.startsWith("/ws"), `candidate '${c}' escaped the workspace root`);
    }
  });

  it("adds python test_ prefix candidates for .py files", () => {
    const candidates = candidatePaths("/ws", "/ws/pkg/mod.py");
    assert.ok(candidates.includes("/ws/pkg/test_mod.py"));
    assert.ok(candidates.includes("/ws/tests/test_mod.py"));
  });
});

describe("findTestFile", () => {
  let workspace = "";

  before(async () => {
    workspace = await mkdtemp(join(tmpdir(), "claude-crap-th-"));
    // src/foo.ts with a sibling test
    await fs.mkdir(join(workspace, "src"), { recursive: true });
    await fs.writeFile(join(workspace, "src", "foo.ts"), "// source");
    await fs.writeFile(join(workspace, "src", "foo.test.ts"), "// test");
    // src/bar.ts with a mirror-tree test
    await fs.writeFile(join(workspace, "src", "bar.ts"), "// source");
    await fs.mkdir(join(workspace, "tests", "src"), { recursive: true });
    await fs.writeFile(join(workspace, "tests", "src", "bar.test.ts"), "// test");
    // src/baz.ts with no test at all
    await fs.writeFile(join(workspace, "src", "baz.ts"), "// source");
    // pkg/mod.py with a sibling python test
    await fs.mkdir(join(workspace, "pkg"), { recursive: true });
    await fs.writeFile(join(workspace, "pkg", "mod.py"), "# source");
    await fs.writeFile(join(workspace, "pkg", "test_mod.py"), "# test");
    // Flat-tests-dir layout: src/mcp/src/metrics/qux.ts tested by
    // src/mcp/src/tests/qux.test.ts (mirrors this very project's layout).
    await fs.mkdir(join(workspace, "src", "mcp", "src", "metrics"), { recursive: true });
    await fs.writeFile(join(workspace, "src", "mcp", "src", "metrics", "qux.ts"), "// source");
    await fs.mkdir(join(workspace, "src", "mcp", "src", "tests"), { recursive: true });
    await fs.writeFile(join(workspace, "src", "mcp", "src", "tests", "qux.test.ts"), "// test");
  });

  after(async () => {
    if (workspace) await rm(workspace, { recursive: true, force: true });
  });

  it("finds a sibling .test.ts", async () => {
    const res = await findTestFile(workspace, join(workspace, "src", "foo.ts"));
    assert.equal(res.isTestFile, false);
    assert.equal(res.testFile, join(workspace, "src", "foo.test.ts"));
  });

  it("finds a mirror-tree test", async () => {
    const res = await findTestFile(workspace, join(workspace, "src", "bar.ts"));
    assert.equal(res.testFile, join(workspace, "tests", "src", "bar.test.ts"));
  });

  it("returns null when no test exists", async () => {
    const res = await findTestFile(workspace, join(workspace, "src", "baz.ts"));
    assert.equal(res.testFile, null);
    assert.ok(res.candidates.length > 0);
  });

  it("short-circuits when input is already a test file", async () => {
    const res = await findTestFile(workspace, join(workspace, "src", "foo.test.ts"));
    assert.equal(res.isTestFile, true);
    assert.equal(res.testFile, join(workspace, "src", "foo.test.ts"));
  });

  it("finds a python test_ prefix file", async () => {
    const res = await findTestFile(workspace, join(workspace, "pkg", "mod.py"));
    assert.equal(res.testFile, join(workspace, "pkg", "test_mod.py"));
  });

  it("finds a test inside a flat ancestor tests/ directory", async () => {
    const res = await findTestFile(
      workspace,
      join(workspace, "src", "mcp", "src", "metrics", "qux.ts"),
    );
    assert.equal(
      res.testFile,
      join(workspace, "src", "mcp", "src", "tests", "qux.test.ts"),
    );
  });
});
