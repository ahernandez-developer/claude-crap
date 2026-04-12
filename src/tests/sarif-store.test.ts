/**
 * Unit tests for the on-disk SARIF store.
 *
 * Uses a fresh temp directory per test run to keep the suite hermetic.
 * Only touches the filesystem through Node's `fs/promises` API — no
 * external processes or fixtures.
 *
 * @module tests/sarif-store.test
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SarifStore, type PersistedSarif } from "../sarif/sarif-store.js";

/**
 * Build a minimal valid SARIF 2.1.0 document with a single finding. The
 * `ruleId`, `uri`, `line` and `column` inputs drive the dedup key used
 * by the store, so tests can craft duplicates or near-duplicates easily.
 */
function makeSarif(opts: {
  ruleId: string;
  uri: string;
  line: number;
  column: number;
  message?: string;
}): PersistedSarif {
  return {
    version: "2.1.0",
    runs: [
      {
        tool: { driver: { name: "test-tool", version: "0.0.1" } },
        results: [
          {
            ruleId: opts.ruleId,
            level: "warning",
            message: { text: opts.message ?? "finding" },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: opts.uri },
                  region: { startLine: opts.line, startColumn: opts.column },
                },
              },
            ],
          },
        ],
      },
    ],
  };
}

describe("SarifStore", () => {
  let workspace = "";

  before(async () => {
    workspace = await mkdtemp(join(tmpdir(), "claude-crap-test-"));
  });

  after(async () => {
    if (workspace) await rm(workspace, { recursive: true, force: true });
  });

  it("starts empty when no report exists on disk", async () => {
    const store = new SarifStore({ workspaceRoot: workspace, outputDir: "reports" });
    await store.loadLatest();
    assert.equal(store.size(), 0);
    assert.equal(store.invocationsCount, 0);
  });

  it("accepts a fresh finding and reports the stats", async () => {
    const store = new SarifStore({ workspaceRoot: workspace, outputDir: "reports" });
    await store.loadLatest();
    const stats = store.ingestRun(
      makeSarif({ ruleId: "R1", uri: "src/a.ts", line: 10, column: 5 }),
      "test-tool",
    );
    assert.deepEqual(stats, { accepted: 1, duplicates: 0, total: 1 });
    assert.equal(store.size(), 1);
  });

  it("deduplicates identical findings across ingestions", async () => {
    const store = new SarifStore({ workspaceRoot: workspace, outputDir: "reports2" });
    await store.loadLatest();
    const doc = makeSarif({ ruleId: "R2", uri: "src/b.ts", line: 1, column: 1 });
    store.ingestRun(doc, "test-tool");
    const second = store.ingestRun(doc, "test-tool");
    assert.deepEqual(second, { accepted: 0, duplicates: 1, total: 1 });
    assert.equal(store.size(), 1);
  });

  it("treats different columns as distinct findings", async () => {
    const store = new SarifStore({ workspaceRoot: workspace, outputDir: "reports3" });
    await store.loadLatest();
    store.ingestRun(makeSarif({ ruleId: "R3", uri: "src/c.ts", line: 1, column: 1 }), "t");
    store.ingestRun(makeSarif({ ruleId: "R3", uri: "src/c.ts", line: 1, column: 2 }), "t");
    assert.equal(store.size(), 2);
  });

  it("persists to disk and reloads the same findings", async () => {
    const dir = "reports4";
    const store = new SarifStore({ workspaceRoot: workspace, outputDir: dir });
    await store.loadLatest();
    store.ingestRun(
      makeSarif({ ruleId: "R4", uri: "src/d.ts", line: 7, column: 3, message: "boom" }),
      "semgrep",
    );
    await store.persist();

    // New store instance reading the same file should see the finding.
    const store2 = new SarifStore({ workspaceRoot: workspace, outputDir: dir });
    await store2.loadLatest();
    assert.equal(store2.size(), 1);
    const [finding] = store2.list();
    assert.equal(finding?.ruleId, "R4");
    assert.equal(finding?.sourceTool, "semgrep");
  });

  it("rejects non-SARIF-2.1.0 documents", async () => {
    const store = new SarifStore({ workspaceRoot: workspace, outputDir: "reports5" });
    await store.loadLatest();
    assert.throws(() =>
      store.ingestRun(
        { version: "2.0.0", runs: [] } as unknown as PersistedSarif,
        "old-tool",
      ),
    );
  });

  it("ignores findings with missing coordinates", async () => {
    const store = new SarifStore({ workspaceRoot: workspace, outputDir: "reports6" });
    await store.loadLatest();
    const malformed: PersistedSarif = {
      version: "2.1.0",
      runs: [
        {
          tool: { driver: { name: "bad", version: "0" } },
          results: [
            {
              ruleId: "R",
              message: { text: "no location" },
              // locations intentionally missing
            },
          ],
        },
      ],
    };
    const stats = store.ingestRun(malformed, "bad");
    assert.equal(stats.accepted, 0);
    assert.equal(stats.total, 1);
  });

  it("reports an absolute path for the consolidated report", async () => {
    const store = new SarifStore({ workspaceRoot: workspace, outputDir: "reports7" });
    await store.loadLatest();
    assert.ok(store.consolidatedReportPath.startsWith(workspace));
    assert.ok(store.consolidatedReportPath.endsWith("latest.sarif"));
    // Sanity: directory should not yet exist until persist() runs.
    assert.rejects(() => fs.access(store.consolidatedReportPath));
  });

  it("F-A08-01: loadLatest survives a run with non-iterable results", async () => {
    // Persist a document whose first run has a non-array `results`
    // field. A naive `for (const r of run.results)` throws TypeError
    // "X is not iterable" on this input, which would crash the MCP
    // server on boot (persistent DoS). After the fix the store must
    // skip the malformed run, load the second run's well-formed
    // finding, and return without throwing.
    const dir = "reports-a08-a";
    const reportDir = join(workspace, dir);
    await fs.mkdir(reportDir, { recursive: true });
    const latestPath = join(reportDir, "latest.sarif");
    const corrupted = {
      version: "2.1.0",
      runs: [
        // Malformed: `results` is null, not an array.
        {
          tool: { driver: { name: "broken", version: "0" } },
          results: null,
        },
        // Well-formed: must survive.
        {
          tool: { driver: { name: "claude-crap", version: "0.1.0" } },
          results: [
            {
              ruleId: "GOOD-001",
              level: "warning",
              message: { text: "a normal finding" },
              locations: [
                {
                  physicalLocation: {
                    artifactLocation: { uri: "src/ok.ts" },
                    region: { startLine: 1, startColumn: 1 },
                  },
                },
              ],
            },
          ],
        },
      ],
    };
    await fs.writeFile(latestPath, JSON.stringify(corrupted, null, 2), "utf8");

    const store = new SarifStore({ workspaceRoot: workspace, outputDir: dir });
    await assert.doesNotReject(
      () => store.loadLatest(),
      "loadLatest must not throw when a run has a non-iterable results field",
    );
    assert.equal(store.size(), 1, "only the well-formed finding should survive");
    const [survivor] = store.list();
    assert.equal(survivor?.ruleId, "GOOD-001");
  });

  it("F-A08-01: loadLatest survives a top-level runs field that is not an array", async () => {
    // If `runs` is serialized as an object instead of an array (a
    // tampered file, or a mis-generated report), the outer
    // `for (const run of parsed.runs)` throws. The store must catch
    // the failure, log to stderr, and return with zero findings — NOT
    // crash the MCP server startup.
    const dir = "reports-a08-b";
    const reportDir = join(workspace, dir);
    await fs.mkdir(reportDir, { recursive: true });
    const latestPath = join(reportDir, "latest.sarif");
    await fs.writeFile(
      latestPath,
      JSON.stringify({ version: "2.1.0", runs: { notAnArray: true } }),
      "utf8",
    );

    const store = new SarifStore({ workspaceRoot: workspace, outputDir: dir });
    await assert.doesNotReject(
      () => store.loadLatest(),
      "loadLatest must not throw when `runs` is not an array",
    );
    assert.equal(store.size(), 0, "no findings should survive a bad top-level shape");
  });
});
