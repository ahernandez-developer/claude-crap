/**
 * End-to-end tests for the PreToolUse hook (`hooks/pre-tool-use.mjs`).
 *
 * These tests spawn the real hook as a subprocess with crafted stdin
 * payloads and assert on the exit code. They are the contract test for
 * F-A06-01 (fail-closed gate for high-risk tools): the PreToolUse hook
 * is NOT allowed to fall back to permissive mode when the tool being
 * invoked is `Write`, `Edit`, `MultiEdit`, `NotebookEdit` or `Bash`,
 * because those tools are the ones the Golden Rule (CLAUDE.md) protects.
 *
 * Claude Code's hook exit code contract:
 *
 *   0 → allow (permissive / "pass")
 *   2 → block (stderr is injected into the agent's context)
 *   * → treated as "allow" (fail-open)
 *
 * This suite encodes both the characterization invariants (benign calls
 * still pass, the existing blocked-path rule still fires) and the attack
 * invariants that were introduced for F-A06-01 (fail-closed on errors
 * when the tool is high-risk).
 *
 * @module tests/pre-tool-use-hook.test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK_PATH = resolve(HERE, "..", "..", "hooks", "pre-tool-use.mjs");

interface HookResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Spawn the PreToolUse hook with the given stdin payload and return its
 * exit code plus captured stdout/stderr. The child is given a fixed
 * environment so no user-specific CLAUDE_PLUGIN_OPTION_* overrides leak
 * in from the developer's shell.
 */
function runHook(stdinPayload: string): Promise<HookResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [HOOK_PATH], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH ?? "",
        NODE_ENV: "test",
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      resolvePromise({ code: code ?? -1, stdout, stderr });
    });
    child.stdin.write(stdinPayload);
    child.stdin.end();
  });
}

describe("pre-tool-use hook — characterization (benign paths still work)", () => {
  it("allows a well-formed Read call (exit 0)", async () => {
    const result = await runHook(
      JSON.stringify({
        tool_name: "Read",
        tool_input: { file_path: "/tmp/claude-sonar-scan-fixture.txt" },
      }),
    );
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
  });

  it("allows a well-formed Write to a benign path (exit 0)", async () => {
    const result = await runHook(
      JSON.stringify({
        tool_name: "Write",
        tool_input: {
          file_path: "/tmp/claude-sonar-scan-fixture.txt",
          content: "hello world",
        },
      }),
    );
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
  });

  it("blocks a Write to a .env file (pre-existing SONAR-PATH-001 rule)", async () => {
    // Characterization: the existing blocked-path rule must still fire.
    const result = await runHook(
      JSON.stringify({
        tool_name: "Write",
        tool_input: { file_path: "/tmp/.env", content: "SECRET=x" },
      }),
    );
    assert.equal(result.code, 2);
    assert.match(result.stderr, /SONAR-PATH-001/);
  });

  it("blocks a Bash command matching a destructive pattern", async () => {
    // Characterization: the existing destructive-bash rule must still fire.
    // We use `git push --force` because it has a simpler, well-defined regex;
    // the BASH-RMROOT regex has its own edge cases that are out of scope here.
    const result = await runHook(
      JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: "git push --force origin main" },
      }),
    );
    assert.equal(result.code, 2);
    assert.match(result.stderr, /BASH-GITFORCE/);
  });
});

describe("pre-tool-use hook — F-A06-01 fail-closed gate for high-risk tools", () => {
  it("fails CLOSED (exit 2) when stdin is unparseable but tool_name='Write' is extractable", async () => {
    // Attack scenario: malformed JSON whose `tool_name` still leaks via regex.
    // Before the fix this exited 1 (fail-open). After the fix it must exit 2.
    const result = await runHook('{"tool_name":"Write","tool_input":NOT_JSON');
    assert.equal(
      result.code,
      2,
      `expected fail-closed exit 2 for high-risk tool, got ${result.code}. stderr: ${result.stderr}`,
    );
    assert.match(result.stderr, /SONAR-GATEKEEPER-FAILCLOSED/);
  });

  it("fails CLOSED (exit 2) when stdin is unparseable but tool_name='Bash' is extractable", async () => {
    const result = await runHook('{"tool_name":"Bash","tool_input":broken');
    assert.equal(result.code, 2);
    assert.match(result.stderr, /SONAR-GATEKEEPER-FAILCLOSED/);
  });

  it("fails CLOSED (exit 2) when stdin is unparseable but tool_name='Edit' is extractable", async () => {
    const result = await runHook('{"tool_name":"Edit"    bogus');
    assert.equal(result.code, 2);
  });

  it("fails CLOSED (exit 2) when stdin is unparseable but tool_name='MultiEdit' is extractable", async () => {
    const result = await runHook('{"tool_name":"MultiEdit" <garbage');
    assert.equal(result.code, 2);
  });

  it("fails CLOSED (exit 2) when stdin is unparseable but tool_name='NotebookEdit' is extractable", async () => {
    const result = await runHook('{"tool_name":"NotebookEdit"xxx');
    assert.equal(result.code, 2);
  });
});

describe("pre-tool-use hook — F-A06-01 fail-open stays for low-risk tools", () => {
  it("fails OPEN (exit 1) when stdin is unparseable and tool_name='Read' is extractable", async () => {
    // Read is not in the high-risk allowlist, so fail-open semantics are preserved.
    const result = await runHook('{"tool_name":"Read","tool_input":broken');
    assert.equal(
      result.code,
      1,
      `expected fail-open exit 1 for low-risk tool, got ${result.code}. stderr: ${result.stderr}`,
    );
  });

  it("fails OPEN (exit 1) when stdin is unparseable and no tool_name is extractable", async () => {
    const result = await runHook("totally garbage, not even json");
    assert.equal(result.code, 1);
  });

  it("fails OPEN (exit 1) when stdin is empty", async () => {
    const result = await runHook("");
    assert.equal(result.code, 1);
  });
});
