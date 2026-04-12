/**
 * Unit tests for the workspace path containment guard.
 *
 * F-A01-01: the previous inlined guard used a naive
 * `candidate.startsWith(workspace)` check that was fooled by
 * sibling-prefix paths (e.g. `/tmp/ws-evil` vs `/tmp/ws`). These
 * tests pin both the characterization invariants (paths inside the
 * workspace still resolve, paths outside still throw) and the attack
 * invariant (sibling-prefix paths now throw).
 *
 * The tests use a temp directory to avoid any dependency on the
 * developer's local filesystem layout.
 *
 * @module tests/workspace-guard.test
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { resolveWithinWorkspace } from "../workspace-guard.js";

describe("resolveWithinWorkspace — characterization (well-formed paths)", () => {
  let workspace = "";

  before(async () => {
    workspace = await mkdtemp(join(tmpdir(), "claude-crap-wg-"));
  });

  after(async () => {
    if (workspace) await rm(workspace, { recursive: true, force: true });
  });

  it("accepts a relative path resolved against the workspace", () => {
    const resolved = resolveWithinWorkspace(workspace, "src/foo.ts");
    assert.equal(resolved, join(workspace, "src", "foo.ts"));
  });

  it("accepts an absolute path already inside the workspace", () => {
    const input = join(workspace, "src", "bar.ts");
    const resolved = resolveWithinWorkspace(workspace, input);
    assert.equal(resolved, input);
  });

  it("accepts the workspace root itself", () => {
    const resolved = resolveWithinWorkspace(workspace, workspace);
    assert.equal(resolved, workspace);
  });

  it("accepts a deeply nested path inside the workspace", () => {
    const resolved = resolveWithinWorkspace(workspace, "a/b/c/d/e.ts");
    assert.equal(resolved, join(workspace, "a", "b", "c", "d", "e.ts"));
  });
});

describe("resolveWithinWorkspace — attack invariants (outside paths rejected)", () => {
  let workspace = "";

  before(async () => {
    workspace = await mkdtemp(join(tmpdir(), "claude-crap-wg-"));
  });

  after(async () => {
    if (workspace) await rm(workspace, { recursive: true, force: true });
  });

  it("rejects an absolute path completely outside the workspace", () => {
    assert.throws(
      () => resolveWithinWorkspace(workspace, "/etc/passwd"),
      /escapes the workspace root/,
    );
  });

  it("rejects a parent-directory relative escape", () => {
    assert.throws(
      () => resolveWithinWorkspace(workspace, "../../../etc/passwd"),
      /escapes the workspace root/,
    );
  });

  it("rejects a sibling directory that shares the workspace prefix (F-A01-01)", () => {
    // This is the exact attack class F-A01-01 covers: the sibling path
    // starts with the literal workspace string but is NOT contained in
    // it. The old `startsWith(workspace)` check would have accepted
    // this. The fixed check uses `workspace + sep` so it rejects.
    const siblingPrefix = `${workspace}-evil${sep}secret.txt`;
    assert.throws(
      () => resolveWithinWorkspace(workspace, siblingPrefix),
      /escapes the workspace root/,
    );
  });

  it("rejects another sibling-prefix variant (workspace-clone)", () => {
    const siblingPrefix = `${workspace}-clone${sep}a${sep}b.ts`;
    assert.throws(
      () => resolveWithinWorkspace(workspace, siblingPrefix),
      /escapes the workspace root/,
    );
  });

  it("rejects an empty relative path that resolves to a parent", () => {
    // `..` alone resolves to the parent directory, which is always
    // outside the workspace for a tempdir.
    assert.throws(
      () => resolveWithinWorkspace(workspace, ".."),
      /escapes the workspace root/,
    );
  });
});
