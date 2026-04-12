/**
 * End-to-end tests for the Stop quality-gate hook under each of the
 * three supported strictness modes.
 *
 * The test spawns `hooks/stop-quality-gate.mjs` as a subprocess with
 * a hand-crafted fixture workspace containing:
 *
 *   - `.claude-sonar/reports/latest.sarif` — one error-level finding
 *     so the gate has a reason to fail.
 *   - (optional) `.claude-sonar.json` — exercises file-based config.
 *   - One small `.ts` file so the workspace walker returns a non-zero
 *     LOC denominator and TDR math does not divide by one.
 *
 * The test then asserts on the subprocess exit code and where the
 * verdict was written (stdout vs stderr) for each mode, matching the
 * design in the CHANGELOG:
 *
 *   - `strict`   — exit 2, verdict on stderr   (hard block)
 *   - `warn`     — exit 0, verdict on stdout   (soft nudge, agent sees it)
 *   - `advisory` — exit 0, one-liner on stdout (minimal pressure)
 *
 * These tests require `dist/` to be built because the Stop hook
 * imports `dist/metrics/tdr.js` at runtime. The suite skips cleanly
 * on fresh checkouts before the first build.
 *
 * @module tests/stop-quality-gate-strictness.test
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(HERE, "..", "..");
const HOOK_PATH = join(PLUGIN_ROOT, "hooks", "stop-quality-gate.mjs");
const TDR_ENTRY = join(PLUGIN_ROOT, "dist", "metrics", "tdr.js");

let distBuilt = false;
try {
  statSync(TDR_ENTRY);
  distBuilt = true;
} catch {
  distBuilt = false;
}

interface HookResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Spawn the Stop hook against a fixture workspace, passing an empty
 * JSON payload on stdin (the Stop hook does not depend on the hook
 * input — the verdict is entirely a function of the on-disk SARIF
 * plus the workspace LOC walk).
 */
function runStopHook(
  workspace: string,
  envOverrides: Record<string, string | undefined> = {},
): Promise<HookResult> {
  return new Promise((resolvePromise, reject) => {
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      NODE_ENV: "test",
      CLAUDE_PROJECT_DIR: workspace,
    };
    for (const [key, value] of Object.entries(envOverrides)) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
    const child = spawn(process.execPath, [HOOK_PATH], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: workspace,
      env,
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
    child.stdin.write("{}");
    child.stdin.end();
  });
}

/**
 * Build a fixture workspace with a failing SARIF report on disk and
 * one minimal source file so the LOC walk returns a sensible
 * denominator for the TDR computation.
 */
async function createFailingFixture(): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "claude-sonar-strict-"));
  const reportsDir = join(workspace, ".claude-sonar", "reports");
  await fs.mkdir(reportsDir, { recursive: true });

  // One error-level finding guarantees the SONAR-GATE-ERRORS policy fails.
  const sarif = {
    version: "2.1.0",
    runs: [
      {
        tool: { driver: { name: "claude-sonar-fixture", version: "0.0.0" } },
        results: [
          {
            ruleId: "FIXTURE-ERR-001",
            level: "error",
            message: { text: "fixture error so the gate has something to block on" },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: "src/a.ts" },
                  region: { startLine: 1, startColumn: 1 },
                },
              },
            ],
            properties: {
              sourceTool: "claude-sonar-fixture",
              effortMinutes: 90,
            },
          },
        ],
      },
    ],
  };
  await fs.writeFile(
    join(reportsDir, "latest.sarif"),
    JSON.stringify(sarif, null, 2),
    "utf8",
  );

  // A non-zero physical LOC means TDR math is well-defined.
  await fs.mkdir(join(workspace, "src"), { recursive: true });
  await fs.writeFile(
    join(workspace, "src", "a.ts"),
    "export const answer = 42;\n",
    "utf8",
  );

  return workspace;
}

describe(
  "stop-quality-gate hook — strictness matrix",
  { skip: !distBuilt },
  () => {
    let workspace = "";

    before(async () => {
      workspace = await createFailingFixture();
    });

    after(async () => {
      if (workspace) await rm(workspace, { recursive: true, force: true });
    });

    it("default (no env, no file) → exit 2 + stderr box (strict is the default)", async () => {
      const result = await runStopHook(workspace, {
        CLAUDE_SONAR_STRICTNESS: undefined,
      });
      assert.equal(result.code, 2, `stderr was: ${result.stderr}`);
      assert.match(result.stderr, /Stop quality gate BLOCKED/);
      assert.match(result.stderr, /SONAR-GATE-ERRORS/);
    });

    it("CLAUDE_SONAR_STRICTNESS=strict → exit 2 + stderr box", async () => {
      const result = await runStopHook(workspace, {
        CLAUDE_SONAR_STRICTNESS: "strict",
      });
      assert.equal(result.code, 2);
      assert.match(result.stderr, /Stop quality gate BLOCKED/);
    });

    it("CLAUDE_SONAR_STRICTNESS=warn → exit 0 + full verdict on stdout", async () => {
      const result = await runStopHook(workspace, {
        CLAUDE_SONAR_STRICTNESS: "warn",
      });
      assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
      // The full verdict must still reach the hook transcript so the
      // agent can choose to remediate on its next turn.
      assert.match(result.stdout, /Stop quality gate WARNING/);
      assert.match(result.stdout, /SONAR-GATE-ERRORS/);
    });

    it("CLAUDE_SONAR_STRICTNESS=advisory → exit 0 + one-line summary on stdout", async () => {
      const result = await runStopHook(workspace, {
        CLAUDE_SONAR_STRICTNESS: "advisory",
      });
      assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
      assert.match(result.stdout, /Stop quality gate ADVISORY/);
      // Advisory must NOT render the heavy multi-line verdict box —
      // the point is minimal pressure. Walking the stdout for the
      // "policy failure(s)" decorator from the blocking/warning box
      // would be a robust negative assertion.
      assert.doesNotMatch(result.stdout, /policy failure\(s\)/);
    });

    it(".claude-sonar.json with strictness='warn' is honored when env is unset", async () => {
      const configPath = join(workspace, ".claude-sonar.json");
      await fs.writeFile(configPath, JSON.stringify({ strictness: "warn" }), "utf8");
      try {
        const result = await runStopHook(workspace, {
          CLAUDE_SONAR_STRICTNESS: undefined,
        });
        assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
        assert.match(result.stdout, /Stop quality gate WARNING/);
      } finally {
        await fs.unlink(configPath);
      }
    });

    it("env variable wins over .claude-sonar.json even when the file disagrees", async () => {
      const configPath = join(workspace, ".claude-sonar.json");
      await fs.writeFile(
        configPath,
        JSON.stringify({ strictness: "advisory" }),
        "utf8",
      );
      try {
        const result = await runStopHook(workspace, {
          CLAUDE_SONAR_STRICTNESS: "strict",
        });
        assert.equal(result.code, 2, `stderr was: ${result.stderr}`);
        assert.match(result.stderr, /Stop quality gate BLOCKED/);
      } finally {
        await fs.unlink(configPath);
      }
    });
  },
);
