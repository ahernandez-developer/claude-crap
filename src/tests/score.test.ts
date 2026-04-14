/**
 * Unit tests for the project score engine.
 *
 * Builds in-memory `SarifStore` instances with hand-crafted finding
 * sets so we can verify each dimension's letter-grade boundaries and
 * the overall worst-of aggregation in isolation, with no filesystem.
 *
 * @module tests/score.test
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SarifStore, type PersistedSarif } from "../sarif/sarif-store.js";
import {
  computeProjectScore,
  renderProjectScoreMarkdown,
  type ProjectScore,
} from "../metrics/score.js";

/**
 * Build a minimal SARIF doc with one finding. The `ruleId`, `level`,
 * and `effortMinutes` parameters drive how the score engine classifies
 * the finding (security vs reliability, severity, TDR contribution).
 */
function makeSarif(opts: {
  ruleId: string;
  uri?: string;
  line?: number;
  column?: number;
  level?: "error" | "warning" | "note";
  effortMinutes?: number;
  sourceTool?: string;
}): PersistedSarif {
  return {
    version: "2.1.0",
    runs: [
      {
        tool: { driver: { name: opts.sourceTool ?? "test", version: "0" } },
        results: [
          {
            ruleId: opts.ruleId,
            level: opts.level ?? "warning",
            message: { text: opts.ruleId },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: opts.uri ?? "src/foo.ts" },
                  region: { startLine: opts.line ?? 1, startColumn: opts.column ?? 1 },
                },
              },
            ],
            properties: { effortMinutes: opts.effortMinutes ?? 0 },
          },
        ],
      },
    ],
  };
}

/**
 * Construct a fresh in-memory SarifStore in a temp directory and ingest
 * a list of findings. Each doc carries its own `tool.driver.name`, and
 * we pass that exact name to `ingestRun()` so the per-tool aggregation
 * tests can distinguish between scanners.
 */
async function buildStore(workspace: string, docs: PersistedSarif[]): Promise<SarifStore> {
  const store = new SarifStore({ workspaceRoot: workspace, outputDir: "reports" });
  await store.loadLatest();
  for (const doc of docs) {
    const sourceTool = doc.runs[0]?.tool?.driver?.name ?? "test-tool";
    store.ingestRun(doc, sourceTool);
  }
  return store;
}

/**
 * Helper that runs the score engine with a minimal sane config.
 */
function score(store: SarifStore, workspaceRoot: string, loc = 1000, files = 10): ProjectScore {
  return computeProjectScore({
    workspaceRoot,
    minutesPerLoc: 30,
    tdrMaxRating: "C",
    workspace: { physicalLoc: loc, fileCount: files },
    sarifStore: store,
    dashboardUrl: "http://127.0.0.1:5117",
    sarifReportPath: store.consolidatedReportPath,
  });
}

describe("computeProjectScore", () => {
  let workspace = "";

  before(async () => {
    workspace = await mkdtemp(join(tmpdir(), "claude-crap-score-"));
  });

  after(async () => {
    if (workspace) await rm(workspace, { recursive: true, force: true });
  });

  it("rates an empty project as A across the board", async () => {
    const store = await buildStore(workspace, []);
    const s = score(store, workspace);
    assert.equal(s.maintainability.rating, "A");
    assert.equal(s.reliability.rating, "A");
    assert.equal(s.security.rating, "A");
    assert.equal(s.overall.rating, "A");
    assert.equal(s.overall.passes, true);
  });

  it("classifies a SQL injection rule as security", async () => {
    const store = await buildStore(workspace, [
      makeSarif({ ruleId: "python.lang.sql-injection", level: "error" }),
    ]);
    const s = score(store, workspace);
    assert.equal(s.security.errorFindings, 1);
    assert.equal(s.reliability.errorFindings, 0);
    assert.equal(s.security.rating, "D"); // 1 error → D
  });

  it("classifies a non-security rule as reliability", async () => {
    const store = await buildStore(workspace, [
      makeSarif({ ruleId: "ts.unused-variable", level: "warning" }),
    ]);
    const s = score(store, workspace);
    assert.equal(s.reliability.warningFindings, 1);
    assert.equal(s.security.warningFindings, 0);
    assert.equal(s.reliability.rating, "C"); // 1 warning → C
  });

  it("escalates reliability to E with 3+ errors", async () => {
    const store = await buildStore(workspace, [
      makeSarif({ ruleId: "rule.a", level: "error", line: 1 }),
      makeSarif({ ruleId: "rule.b", level: "error", line: 2 }),
      makeSarif({ ruleId: "rule.c", level: "error", line: 3 }),
    ]);
    const s = score(store, workspace);
    assert.equal(s.reliability.rating, "E");
  });

  it("collapses overall to the worst dimension", async () => {
    const store = await buildStore(workspace, [
      // 1 security error → security D, reliability A, maintainability A → overall D
      makeSarif({ ruleId: "auth.broken", level: "error" }),
    ]);
    const s = score(store, workspace);
    assert.equal(s.security.rating, "D");
    assert.equal(s.reliability.rating, "A");
    assert.equal(s.maintainability.rating, "A");
    assert.equal(s.overall.rating, "D");
  });

  it("marks overall as failing when worse than the policy ceiling", async () => {
    const store = await buildStore(workspace, [
      makeSarif({ ruleId: "auth.broken", level: "error" }),
    ]);
    const s = score(store, workspace);
    // Overall = D, policy ceiling = C → fails
    assert.equal(s.overall.passes, false);
  });

  it("marks overall as passing when within policy", async () => {
    const store = await buildStore(workspace, [
      makeSarif({ ruleId: "ts.style", level: "warning" }),
    ]);
    const s = score(store, workspace);
    // Reliability = C, ceiling = C → equal, not worse, so passes
    assert.equal(s.overall.rating, "C");
    assert.equal(s.overall.passes, true);
  });

  it("derives maintainability rating from TDR boundaries", async () => {
    // 360 minutes of remediation over 1000 LOC × 30 min/LOC = 30000 cost
    // → TDR = 360 / 30000 = 1.2% → A
    const store = await buildStore(workspace, [
      makeSarif({ ruleId: "ts.todo", level: "note", effortMinutes: 360 }),
    ]);
    const s = score(store, workspace);
    assert.ok(s.maintainability.tdrPercent < 5);
    assert.equal(s.maintainability.rating, "A");

    // 6000 minutes / 30000 = 20% → C
    const store2 = await buildStore(workspace, [
      makeSarif({ ruleId: "ts.todo2", level: "note", effortMinutes: 6000 }),
    ]);
    const s2 = score(store2, workspace);
    assert.equal(s2.maintainability.rating, "C");

    // 18000 minutes / 30000 = 60% → E
    const store3 = await buildStore(workspace, [
      makeSarif({ ruleId: "ts.todo3", level: "note", effortMinutes: 18000 }),
    ]);
    const s3 = score(store3, workspace);
    assert.equal(s3.maintainability.rating, "E");
  });

  it("aggregates findings by tool and by file", async () => {
    const store = await buildStore(workspace, [
      makeSarif({ ruleId: "rule.a", uri: "src/a.ts", line: 1, sourceTool: "semgrep" }),
      makeSarif({ ruleId: "rule.b", uri: "src/a.ts", line: 2, sourceTool: "semgrep" }),
      makeSarif({ ruleId: "rule.c", uri: "src/b.ts", line: 1, sourceTool: "eslint" }),
    ]);
    const s = score(store, workspace);
    assert.equal(s.findings.byTool.semgrep, 2);
    assert.equal(s.findings.byTool.eslint, 1);
    assert.equal(s.findings.byFile["src/a.ts"], 2);
    assert.equal(s.findings.byFile["src/b.ts"], 1);
  });

  it("propagates the dashboard URL into the location block", async () => {
    const store = await buildStore(workspace, []);
    const s = score(store, workspace);
    assert.equal(s.location.dashboardUrl, "http://127.0.0.1:5117");
    assert.ok(s.location.sarifReportPath.endsWith("latest.sarif"));
  });

  describe("scope filtering (filterPathPrefix)", () => {
    // These tests pin the bug reported by the monorepo user:
    //   `score_project --scope mobile` was narrowing the LOC denominator
    //   but not the finding set, so apps/api findings were polluting the
    //   mobile project rating. The fix adds a `filterPathPrefix` option
    //   to computeProjectScore; when present, findings whose URI does
    //   not sit under that prefix are excluded from EVERY aggregation
    //   (total counts, byFile, byTool, reliability, security, TDR).

    it("excludes findings outside the prefix from every count", async () => {
      const store = await buildStore(workspace, [
        makeSarif({ ruleId: "rule.a", uri: "apps/mobile/lib/a.dart", line: 1 }),
        makeSarif({ ruleId: "rule.b", uri: "apps/mobile/lib/b.dart", line: 2 }),
        makeSarif({ ruleId: "rule.c", uri: "apps/api/Controllers/C.cs", line: 1 }),
        makeSarif({ ruleId: "rule.d", uri: "apps/api/Controllers/D.cs", line: 2 }),
      ]);
      const s = computeProjectScore({
        workspaceRoot: workspace,
        minutesPerLoc: 30,
        tdrMaxRating: "C",
        workspace: { physicalLoc: 1000, fileCount: 10 },
        sarifStore: store,
        dashboardUrl: null,
        sarifReportPath: store.consolidatedReportPath,
        filterPathPrefix: "apps/mobile",
      });
      assert.equal(s.findings.total, 2, "mobile prefix keeps only mobile findings");
      assert.deepEqual(Object.keys(s.findings.byFile).sort(), [
        "apps/mobile/lib/a.dart",
        "apps/mobile/lib/b.dart",
      ]);
      assert.equal(s.reliability.findings, 2);
    });

    it("does not leak other-project findings into TDR remediation", async () => {
      // The bug: mobile's remediation was inflated by apps/api effort.
      const store = await buildStore(workspace, [
        makeSarif({
          ruleId: "rule.heavy",
          uri: "apps/api/huge.cs",
          line: 1,
          effortMinutes: 9999,
        }),
        makeSarif({
          ruleId: "rule.light",
          uri: "apps/mobile/tiny.dart",
          line: 1,
          effortMinutes: 5,
        }),
      ]);
      const s = computeProjectScore({
        workspaceRoot: workspace,
        minutesPerLoc: 30,
        tdrMaxRating: "C",
        workspace: { physicalLoc: 1000, fileCount: 10 },
        sarifStore: store,
        dashboardUrl: null,
        sarifReportPath: store.consolidatedReportPath,
        filterPathPrefix: "apps/mobile",
      });
      assert.equal(s.maintainability.remediationMinutes, 5);
    });

    it("treats an absent prefix as whole workspace (backwards compatible)", async () => {
      const store = await buildStore(workspace, [
        makeSarif({ ruleId: "rule.a", uri: "apps/api/X.cs", line: 1 }),
        makeSarif({ ruleId: "rule.b", uri: "apps/mobile/Y.dart", line: 1 }),
      ]);
      const s = score(store, workspace);
      assert.equal(s.findings.total, 2);
    });

    it("normalizes absolute paths when comparing against the prefix", async () => {
      // The SARIF store may hold absolute URIs from scanners that emit
      // them (ESLint, dotnet_format). The filter must still match after
      // normalization against the workspace root.
      const abs = join(workspace, "apps/mobile/deep/x.dart");
      const store = await buildStore(workspace, [
        makeSarif({ ruleId: "rule.a", uri: abs, line: 1 }),
      ]);
      const s = computeProjectScore({
        workspaceRoot: workspace,
        minutesPerLoc: 30,
        tdrMaxRating: "C",
        workspace: { physicalLoc: 1000, fileCount: 10 },
        sarifStore: store,
        dashboardUrl: null,
        sarifReportPath: store.consolidatedReportPath,
        filterPathPrefix: "apps/mobile",
      });
      assert.equal(s.findings.total, 1);
    });

    it("does not match partial directory names (apps/mob != apps/mobile)", async () => {
      const store = await buildStore(workspace, [
        makeSarif({ ruleId: "rule.a", uri: "apps/mobile-web/x.ts", line: 1 }),
        makeSarif({ ruleId: "rule.b", uri: "apps/mobile/x.dart", line: 2 }),
      ]);
      const s = computeProjectScore({
        workspaceRoot: workspace,
        minutesPerLoc: 30,
        tdrMaxRating: "C",
        workspace: { physicalLoc: 1000, fileCount: 10 },
        sarifStore: store,
        dashboardUrl: null,
        sarifReportPath: store.consolidatedReportPath,
        filterPathPrefix: "apps/mobile",
      });
      assert.equal(s.findings.total, 1);
      assert.equal(Object.keys(s.findings.byFile)[0], "apps/mobile/x.dart");
    });
  });
});

describe("renderProjectScoreMarkdown", () => {
  let workspace = "";

  before(async () => {
    workspace = await mkdtemp(join(tmpdir(), "claude-crap-score-md-"));
  });

  after(async () => {
    if (workspace) await rm(workspace, { recursive: true, force: true });
  });

  it("renders a compact summary that includes the overall rating and dashboard URL", async () => {
    const store = await buildStore(workspace, [
      makeSarif({ ruleId: "ts.style", level: "warning" }),
    ]);
    const s = score(store, workspace);
    const md = renderProjectScoreMarkdown(s);
    assert.match(md, /## claude-crap :: project score/);
    assert.match(md, /\*\*Overall: C\*\*/);
    assert.match(md, /Dashboard:.*127\.0\.0\.1:5117/);
    assert.match(md, /Report:.*latest\.sarif/);
  });

  it("renders a fallback line when no dashboard URL is configured", async () => {
    const store = await buildStore(workspace, []);
    const s = computeProjectScore({
      workspaceRoot: workspace,
      minutesPerLoc: 30,
      tdrMaxRating: "C",
      workspace: { physicalLoc: 100, fileCount: 1 },
      sarifStore: store,
      dashboardUrl: null,
      sarifReportPath: store.consolidatedReportPath,
    });
    const md = renderProjectScoreMarkdown(s);
    assert.match(md, /not running/);
  });
});
