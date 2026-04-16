/**
 * Characterization tests for the PreToolUse gatekeeper rule primitives.
 *
 * Pins the desired behaviour for three v0.4.5 audit findings:
 *
 *   BUG-01 — `BASH-RMROOT` regex must block every realistic `rm -rf /`
 *            variant, including critical-path system directories, and
 *            must not block safe project-relative removals.
 *   BUG-02 — Emitted SARIF rule IDs carry exactly one category prefix
 *            (`SONAR-SEC-...` or `SONAR-BASH-...`), never a doubled
 *            prefix such as `SONAR-SEC-SEC-AWS`.
 *   BUG-10 — The `AKIA...` AWS access-key regex allowlists canonical
 *            AWS-published example keys so the gatekeeper does not
 *            reject its own documentation and fixtures.
 *
 * The test imports the rule module directly so each assertion runs
 * against the pure helper — no subprocess, no stdin parsing — which
 * keeps failure diagnostics tight.
 *
 * NOTE: real-looking AWS key shapes and canonical example keys are
 * constructed from split literals so the source of this test file
 * itself does not match the gatekeeper regex that scans the `content`
 * field of Write/Edit tool calls.
 *
 * @module tests/gatekeeper-rules.test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// The rule module lives under `plugin/hooks/lib/` so the hook entry
// points (pure JS, zero deps) can load it at runtime without going
// through the TypeScript build. tsx resolves the .mjs import at
// test-time; tsc never sees it (plugin/ is outside rootDir).
// @ts-expect-error — .mjs file, no .d.ts declarations (intentional)
import {
  findDestructiveBashHit,
  findSecretHits,
  formatSecretRuleId,
  formatBashRuleId,
  HARDCODED_SECRET_PATTERNS,
  DESTRUCTIVE_BASH_PATTERNS,
} from "../../plugin/hooks/lib/gatekeeper-rules.mjs";

// ── BUG-01 ────────────────────────────────────────────────────────────

describe("BUG-01 — BASH-RMROOT blocks every realistic rm -rf / variant", () => {
  const MUST_BLOCK: ReadonlyArray<string> = [
    // Filesystem root in every common shape.
    "rm -rf /",
    "rm -rf  /",
    "rm -rf / ",
    'rm -rf "/"',
    "rm -rf /*",
    "sudo rm -rf /",
    "rm --force /",
    "rm --recursive /",
    "rm -rfv /",
    // Critical system directories.
    "rm -rf /usr",
    "rm -rf /etc",
    "rm -rf /var/log",
    "rm -rf /bin",
    "rm -rf /boot",
    "rm -rf /System",
    // Home directory shortcuts (already covered by RMHOME; keep pinned).
    "rm -rf $HOME",
  ];

  for (const cmd of MUST_BLOCK) {
    it(`blocks: ${cmd}`, () => {
      const hit = findDestructiveBashHit(cmd);
      assert.ok(hit, `expected block, got pass for: ${cmd}`);
    });
  }

  const MUST_PASS: ReadonlyArray<string> = [
    "rm -rf /tmp/foo",        // /tmp is scratch, fine
    "rm -rf ./build",         // relative path
    "rm -rf node_modules",    // named target, no leading /
    "rm -rf dist",
    "echo 'rm -rf /'",        // text inside echo, not an rm target
  ];

  for (const cmd of MUST_PASS) {
    it(`passes: ${cmd}`, () => {
      const hit = findDestructiveBashHit(cmd);
      assert.equal(hit, null, `expected pass, got block for: ${cmd}`);
    });
  }
});

// ── BUG-02 ────────────────────────────────────────────────────────────

describe("BUG-02 — rule IDs carry exactly one category prefix", () => {
  it("formatSecretRuleId prepends SONAR-SEC exactly once", () => {
    assert.equal(formatSecretRuleId({ id: "AWS" }), "SONAR-SEC-AWS");
    assert.equal(formatSecretRuleId({ id: "PRIVKEY" }), "SONAR-SEC-PRIVKEY");
  });

  it("formatBashRuleId prepends SONAR-BASH exactly once", () => {
    assert.equal(formatBashRuleId({ id: "RMROOT" }), "SONAR-BASH-RMROOT");
    assert.equal(formatBashRuleId({ id: "RMHOME" }), "SONAR-BASH-RMHOME");
  });

  it("no secret rule embeds its category in id", () => {
    for (const pat of HARDCODED_SECRET_PATTERNS as ReadonlyArray<{ id: string }>) {
      assert.ok(
        !/^SEC-/.test(pat.id),
        `rule id leaks category (should be stripped): ${pat.id}`,
      );
    }
  });

  it("no bash rule embeds its category in id", () => {
    for (const pat of DESTRUCTIVE_BASH_PATTERNS as ReadonlyArray<{ id: string }>) {
      assert.ok(
        !/^BASH-/.test(pat.id),
        `rule id leaks category (should be stripped): ${pat.id}`,
      );
    }
  });
});

// ── BUG-10 ────────────────────────────────────────────────────────────

describe("BUG-10 — canonical AWS example keys are allowlisted", () => {
  // Split so this very file doesn't match the regex it is testing.
  const CANONICAL_EXAMPLE = "AKIA" + "IOSFODNN7" + "EXAMPLE";
  const REAL_SHAPE = "AKIA" + "J7NVPZZZAB12CDEF"; // 20 chars, AKIA + 16 upper-alnum

  it(`canonical example key '${CANONICAL_EXAMPLE}' is not flagged`, () => {
    const hits = findSecretHits(`aws_access_key_id="${CANONICAL_EXAMPLE}"`);
    const awsHits = hits.filter((h: { id: string }) => h.id === "AWS");
    assert.equal(
      awsHits.length,
      0,
      `canonical example must not match: got ${JSON.stringify(awsHits)}`,
    );
  });

  it("real-shape AWS key is still flagged", () => {
    const hits = findSecretHits(`aws_access_key_id="${REAL_SHAPE}"`);
    const awsHits = hits.filter((h: { id: string }) => h.id === "AWS");
    assert.ok(
      awsHits.length >= 1,
      `real-shape key must flag: ${REAL_SHAPE}`,
    );
  });
});
