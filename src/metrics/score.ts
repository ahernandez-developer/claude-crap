/**
 * Aggregate project score engine.
 *
 * Given a fully resolved configuration, the live SARIF store, and a
 * workspace LOC walker, this module produces a single immutable
 * `ProjectScore` snapshot describing the entire project's quality
 * posture across three dimensions:
 *
 *   - **Maintainability** — derived from the Technical Debt Ratio (TDR)
 *     using the existing `metrics/tdr.ts` engine.
 *   - **Reliability**     — derived from the worst non-security finding.
 *   - **Security**        — derived from the worst security finding.
 *
 * Each dimension produces a letter grade A..E and the `overall` field
 * collapses them by taking the worst grade. The `passes` field tells
 * the caller whether the overall grade is within the configured
 * `tdrMaxRating` tolerance — handy for the Stop quality gate and the
 * `score_project` MCP tool.
 *
 * Security vs reliability is determined by a heuristic on the `ruleId`:
 * any rule whose identifier matches a security keyword (`sec`, `sql`,
 * `xss`, `csrf`, `injection`, `crypt`, `auth`, `secret`, `password`,
 * `cve`, `vuln`) is treated as security. Everything else is reliability.
 * This is intentionally coarse: adapters that stamp a richer SARIF
 * taxonomy (e.g. `properties.tags = ["security"]`) could replace this
 * classifier with an exact match, but the regex is sufficient for the
 * scanners this plugin ships with.
 *
 * The score engine is pure: it does no I/O, takes a `WorkspaceStats`
 * value (which the caller produces from the bounded LOC walker), and
 * returns a brand new score object on every call. Tests can construct
 * a `SarifStore` in memory and verify the boundaries directly.
 *
 * @module metrics/score
 */

import { isAbsolute, relative, resolve } from "node:path";

import type { MaintainabilityRating } from "../config.js";
import type { IngestedFinding, SarifStore } from "../sarif/sarif-store.js";
import { classifyTdr, ratingIsWorseThan } from "./tdr.js";

/**
 * Letter rating shared by every dimension. The same A..E scale used by
 * SonarQube's reliability and security ratings, where A is best and E
 * is unmaintainable / blocker-class.
 */
export type SeverityRating = MaintainabilityRating;

/**
 * Workspace size statistics produced by an external bounded walker.
 * The score engine does not walk the disk itself — pass these in.
 */
export interface WorkspaceStats {
  /** Total physical lines of code under the workspace root. */
  readonly physicalLoc: number;
  /** Number of files visited by the walker. */
  readonly fileCount: number;
}

/**
 * Per-dimension breakdown.
 */
export interface DimensionScore {
  readonly rating: SeverityRating;
  readonly findings: number;
  readonly errorFindings: number;
  readonly warningFindings: number;
  readonly noteFindings: number;
}

/**
 * Per-finding-level summary plus per-tool counts.
 */
export interface FindingsSummary {
  readonly total: number;
  readonly error: number;
  readonly warning: number;
  readonly note: number;
  readonly byTool: Readonly<Record<string, number>>;
  readonly byFile: Readonly<Record<string, number>>;
}

/**
 * Maintainability dimension expressed as a TDR percentage.
 */
export interface MaintainabilityScore {
  readonly rating: MaintainabilityRating;
  readonly tdrPercent: number;
  readonly remediationMinutes: number;
  readonly developmentCostMinutes: number;
}

/**
 * Pointer to where the consolidated report can be found.
 */
export interface ScoreLocation {
  /** Local dashboard URL when the HTTP server is running, otherwise `null`. */
  readonly dashboardUrl: string | null;
  /** Absolute path to the consolidated SARIF document on disk. */
  readonly sarifReportPath: string;
}

/**
 * The full project score snapshot. Returned from {@link computeProjectScore}.
 */
export interface ProjectScore {
  readonly generatedAt: string;
  readonly workspaceRoot: string;
  readonly loc: { readonly physical: number; readonly files: number };
  readonly findings: FindingsSummary;
  readonly maintainability: MaintainabilityScore;
  readonly reliability: DimensionScore;
  readonly security: DimensionScore;
  readonly overall: {
    readonly rating: SeverityRating;
    /** True when `overall.rating` is no worse than `policyRating`. */
    readonly passes: boolean;
    /** Echoed from the configured policy. */
    readonly policyRating: MaintainabilityRating;
  };
  readonly location: ScoreLocation;
}

/**
 * Inputs accepted by {@link computeProjectScore}.
 */
export interface ComputeProjectScoreInput {
  readonly workspaceRoot: string;
  readonly minutesPerLoc: number;
  readonly tdrMaxRating: MaintainabilityRating;
  readonly workspace: WorkspaceStats;
  readonly sarifStore: SarifStore;
  readonly dashboardUrl: string | null;
  readonly sarifReportPath: string;
  /**
   * Optional workspace-relative path prefix. When set, only findings
   * whose URI sits under this prefix are included in every aggregation
   * (total counts, byFile, byTool, reliability, security, TDR). Used by
   * `score_project --scope <project>` so a per-sub-project reading
   * reflects reality instead of pulling in the whole workspace's
   * findings. The prefix is matched against SARIF URIs after the store
   * has already normalized them to workspace-relative form; absolute
   * paths and `file://` URIs are normalized here as a safety net.
   */
  readonly filterPathPrefix?: string;
  /**
   * Absolute path to the original workspace root when
   * {@link filterPathPrefix} may contain absolute paths that need to
   * be normalized. Defaults to {@link workspaceRoot}.
   */
  readonly scopeWorkspaceRoot?: string;
}

/**
 * Pattern that classifies a rule identifier as security-relevant.
 * Matches case-insensitively against the rule id text. Intentionally
 * permissive — false positives in classification are recoverable, but
 * a missed security finding being graded as reliability is not.
 */
const SECURITY_RULE_PATTERN =
  /(sec|sql|xss|csrf|ssrf|injection|crypt|auth|secret|password|token|cve|vuln|jwt|cors|rce|deserial|prototype-pollution)/i;

/**
 * Compute the full project score. Pure function — no side effects.
 *
 * @param input Aggregated inputs.
 * @returns     A {@link ProjectScore} ready to be serialized.
 */
export function computeProjectScore(input: ComputeProjectScoreInput): ProjectScore {
  const findingsList = filterFindingsByPrefix(
    input.sarifStore.list(),
    input.filterPathPrefix,
    input.scopeWorkspaceRoot ?? input.workspaceRoot,
  );

  // ---- Findings summary ----
  /** @type {Record<string, number>} */
  const byTool: Record<string, number> = {};
  const byFile: Record<string, number> = {};
  let errorCount = 0;
  let warningCount = 0;
  let noteCount = 0;
  let remediationMinutes = 0;

  /** Findings split by classification. */
  const securityFindings: Array<{ level: string }> = [];
  const reliabilityFindings: Array<{ level: string }> = [];

  for (const finding of findingsList) {
    if (finding.level === "error") errorCount += 1;
    else if (finding.level === "warning") warningCount += 1;
    else if (finding.level === "note") noteCount += 1;

    byTool[finding.sourceTool] = (byTool[finding.sourceTool] ?? 0) + 1;
    byFile[finding.location.uri] = (byFile[finding.location.uri] ?? 0) + 1;

    const effort =
      typeof finding.properties?.effortMinutes === "number"
        ? finding.properties.effortMinutes
        : 0;
    remediationMinutes += effort;

    if (SECURITY_RULE_PATTERN.test(finding.ruleId)) {
      securityFindings.push({ level: finding.level });
    } else {
      reliabilityFindings.push({ level: finding.level });
    }
  }

  const findings: FindingsSummary = {
    total: findingsList.length,
    error: errorCount,
    warning: warningCount,
    note: noteCount,
    byTool,
    byFile,
  };

  // ---- Maintainability (TDR) ----
  // Guard against an empty workspace; the TDR formula divides by LOC.
  const safeLoc = Math.max(input.workspace.physicalLoc, 1);
  const developmentCostMinutes = input.minutesPerLoc * safeLoc;
  const tdrPercent = (remediationMinutes / developmentCostMinutes) * 100;
  const tdrRating = classifyTdr(tdrPercent);

  const maintainability: MaintainabilityScore = {
    rating: tdrRating,
    tdrPercent: Number(tdrPercent.toFixed(4)),
    remediationMinutes,
    developmentCostMinutes,
  };

  // ---- Reliability and security dimensions ----
  const reliability = scoreDimension(reliabilityFindings);
  const security = scoreDimension(securityFindings);

  // ---- Overall = the worst of the three ----
  const overallRating = worstOf(maintainability.rating, reliability.rating, security.rating);
  const passes = !ratingIsWorseThan(overallRating, input.tdrMaxRating);

  return {
    generatedAt: new Date().toISOString(),
    workspaceRoot: input.workspaceRoot,
    loc: { physical: input.workspace.physicalLoc, files: input.workspace.fileCount },
    findings,
    maintainability,
    reliability,
    security,
    overall: {
      rating: overallRating,
      passes,
      policyRating: input.tdrMaxRating,
    },
    location: {
      dashboardUrl: input.dashboardUrl,
      sarifReportPath: input.sarifReportPath,
    },
  };
}

/**
 * Filter an in-memory list of {@link IngestedFinding} records so only
 * those that live underneath `prefix` survive. Used by
 * {@link computeProjectScore} when a caller passes `filterPathPrefix`
 * (set by `score_project --scope <project>`).
 *
 * The SARIF store already normalizes URIs to workspace-relative form
 * on ingest, but this helper re-normalizes defensively so legacy
 * reports written before that fix, or findings produced by a third
 * party, still filter correctly. The comparison is anchored on
 * directory boundaries (`apps/mob` never matches `apps/mobile-web`).
 *
 * An empty / undefined prefix returns the list unchanged so the
 * whole-workspace score path stays zero-cost.
 *
 * @param findings      Full finding list from the SARIF store.
 * @param prefix        Optional workspace-relative path prefix.
 * @param workspaceRoot Absolute workspace root used to normalize any
 *                      absolute URIs stored in legacy reports.
 * @returns             Filtered list (same reference when prefix empty).
 */
function filterFindingsByPrefix(
  findings: ReadonlyArray<IngestedFinding>,
  prefix: string | undefined,
  workspaceRoot: string,
): ReadonlyArray<IngestedFinding> {
  if (!prefix) return findings;
  const normalizedPrefix = prefix.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!normalizedPrefix) return findings;
  const root = resolve(workspaceRoot);
  return findings.filter((f) => {
    const uri = relativizeForMatch(f.location.uri, root);
    return uri === normalizedPrefix || uri.startsWith(`${normalizedPrefix}/`);
  });
}

/**
 * Rewrite a SARIF URI to a POSIX-style workspace-relative path for
 * prefix matching. Mirrors `normalizeSarifUri` in the SARIF store but
 * is intentionally duplicated here so the score engine stays pure and
 * has no circular dependency on the store internals.
 */
function relativizeForMatch(uri: string, workspaceRoot: string): string {
  let path = uri;
  if (path.startsWith("file://")) {
    try {
      path = new URL(path).pathname;
    } catch {
      // Leave the raw string alone on malformed URLs.
    }
  }
  if (isAbsolute(path)) {
    const rel = relative(workspaceRoot, path);
    if (rel && !rel.startsWith("..")) {
      path = rel;
    }
  }
  return path.replace(/\\/g, "/");
}

/**
 * Score a single dimension (reliability or security) from its findings.
 *
 * The mapping is intentionally coarse and maps directly from SARIF
 * levels to letter ratings:
 *
 *   - 0 findings                    → A
 *   - only `note` findings          → B
 *   - 1+ `warning`, 0 `error`       → C
 *   - 1–2 `error`                   → D
 *   - 3+ `error`                    → E
 *
 * Projects that stamp explicit blocker / major / minor categories on
 * their SARIF properties can wrap this function with their own
 * taxonomy-aware classifier.
 *
 * @param findings Findings classified into this dimension.
 */
function scoreDimension(findings: ReadonlyArray<{ level: string }>): DimensionScore {
  let errorCount = 0;
  let warningCount = 0;
  let noteCount = 0;
  for (const f of findings) {
    if (f.level === "error") errorCount += 1;
    else if (f.level === "warning") warningCount += 1;
    else if (f.level === "note") noteCount += 1;
  }
  let rating: SeverityRating;
  if (errorCount >= 3) rating = "E";
  else if (errorCount >= 1) rating = "D";
  else if (warningCount >= 1) rating = "C";
  else if (noteCount >= 1) rating = "B";
  else rating = "A";

  return {
    rating,
    findings: findings.length,
    errorFindings: errorCount,
    warningFindings: warningCount,
    noteFindings: noteCount,
  };
}

/**
 * Return the worst (alphabetically highest) of an arbitrary number of
 * letter ratings. Used to collapse the three dimension ratings into the
 * overall project rating.
 *
 * @param ratings Two or more letter ratings.
 * @returns       The worst rating.
 */
function worstOf(...ratings: ReadonlyArray<SeverityRating>): SeverityRating {
  let worst: SeverityRating = "A";
  for (const r of ratings) {
    if (ratingIsWorseThan(r, worst)) worst = r;
  }
  return worst;
}

/**
 * Render a project score as a compact Markdown summary suitable for
 * display directly in a chat session. Keep it under ~30 lines so it
 * does not dominate the conversation context.
 *
 * @param score The score to render.
 */
export function renderProjectScoreMarkdown(score: ProjectScore): string {
  const verdict = score.overall.passes ? "✅ passes policy" : "❌ FAILS policy";
  const dashboardLine = score.location.dashboardUrl
    ? `📊 Dashboard:   ${score.location.dashboardUrl}`
    : `📊 Dashboard:   <not running — start the MCP server to enable>`;

  return [
    `## claude-crap :: project score`,
    ``,
    `**Overall: ${score.overall.rating}** (${verdict}, policy ceiling = ${score.overall.policyRating})`,
    ``,
    `| Dimension       | Rating | Detail                                              |`,
    `| --------------- | :----: | --------------------------------------------------- |`,
    `| Maintainability |   ${score.maintainability.rating}    | TDR ${score.maintainability.tdrPercent}% (${score.maintainability.remediationMinutes} min over ${score.loc.physical} LOC) |`,
    `| Reliability     |   ${score.reliability.rating}    | ${score.reliability.errorFindings} error · ${score.reliability.warningFindings} warning · ${score.reliability.noteFindings} note |`,
    `| Security        |   ${score.security.rating}    | ${score.security.errorFindings} error · ${score.security.warningFindings} warning · ${score.security.noteFindings} note |`,
    ``,
    `Workspace: **${score.loc.physical} LOC** across **${score.loc.files} files**`,
    `Findings:  **${score.findings.total} total** (${score.findings.error} error · ${score.findings.warning} warning · ${score.findings.note} note)`,
    `Tools:     ${Object.keys(score.findings.byTool).join(", ") || "<none ingested>"}`,
    ``,
    dashboardLine,
    `📄 Report:      ${score.location.sarifReportPath}`,
  ].join("\n");
}
