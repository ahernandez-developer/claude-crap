#!/usr/bin/env node
// @ts-check
/**
 * claude-crap :: SessionStart hook — baseline context seeder.
 *
 * Runs once when Claude Code starts a new interactive session with this
 * plugin active. Its purpose is to fix the agent's opening mental model
 * without paying for it in tokens later: the hook writes a short,
 * structured briefing on stdout so Claude Code can inject it into the
 * session's system context.
 *
 * The briefing contains:
 *
 *   - A reminder of the Golden Rule and the hook contract.
 *   - The current configured thresholds (CRAP, TDR rating, LOC cost).
 *   - Baseline metrics pulled from the last consolidated SARIF report.
 *
 * Exit semantics:
 *
 *   - Exit 0 → briefing written to stdout, Claude Code appends it to
 *              the session context.
 *   - Any other exit → fail-open; the session starts with no briefing.
 *
 * The hook never blocks, never reads the filesystem beyond the SARIF
 * report, and never calls the MCP server — it must complete in under
 * 10 seconds per the `hooks.json` timeout budget.
 *
 * @module hooks/session-start
 */

import { ExitCodes, runHook } from "./lib/hook-io.mjs";
import { evaluateQualityGate, loadQualityGateConfig } from "./lib/quality-gate.mjs";

/**
 * Render the opening briefing as Markdown. The text lands in the
 * agent's system context, so it must be compact and imperative.
 *
 * @param {import("./lib/quality-gate.mjs").QualityGateConfig} config
 * @param {import("./lib/quality-gate.mjs").GateVerdict}       verdict
 * @returns {string}
 */
function renderBriefing(config, verdict) {
  const { summary } = verdict;
  return [
    "## claude-crap session briefing",
    "",
    "This session is running under the claude-crap plugin. You are bound by:",
    "",
    "- **Golden Rule** — do not write functional code until a characterization test",
    "  pins the current behavior.",
    "- **Hook contract** — PreToolUse can abort with exit 2, PostToolUse emits",
    "  warnings, Stop / SubagentStop enforce the quality gate.",
    "- **Deterministic engines** — anchor decisions in the claude-crap MCP tools",
    "  (`compute_crap`, `compute_tdr`, `analyze_file_ast`, `ingest_sarif`,",
    "  `require_test_harness`) rather than in speculative reasoning.",
    "",
    "### Current policy",
    "",
    `- CRAP threshold: **${config.crapThreshold}** (block on any function above it)`,
    `- Maintainability ceiling: **${config.tdrMaxRating}** (worse ratings halt the Stop gate)`,
    `- Cost per LOC: **${config.minutesPerLoc}** minutes (used as the TDR denominator)`,
    "",
    "### Baseline workspace metrics",
    "",
    `- Workspace LOC: **${summary.physicalLoc}**`,
    `- Total findings: **${summary.totalFindings}** ` +
      `(error: ${summary.errorFindings}, warning: ${summary.warningFindings}, note: ${summary.noteFindings})`,
    `- Remediation debt: **${summary.remediationMinutes} min**`,
    `- TDR: **${summary.tdrPercent}%** → rating **${summary.tdrRating}**`,
    summary.toolsSeen.length > 0
      ? `- Scanners already ingested: ${summary.toolsSeen.join(", ")}`
      : "- Scanners already ingested: <none>",
    "",
    verdict.passed
      ? "The baseline currently passes the quality gate. Keep it that way."
      : `⚠️ Baseline would FAIL the Stop gate (${verdict.failures.length} policy violation(s)). ` +
        "Your first priority should be remediating existing findings before introducing new code.",
  ].join("\n");
}

async function main() {
  const config = loadQualityGateConfig();
  let verdict;
  try {
    verdict = await evaluateQualityGate(config);
  } catch (err) {
    // If we cannot produce a verdict (e.g. MCP server not built yet),
    // fail open: write a stripped briefing so the session still starts.
    process.stderr.write(
      `[claude-crap] SessionStart: could not evaluate baseline: ${/** @type {Error} */ (err).message}\n`,
    );
    process.stdout.write(
      [
        "## claude-crap session briefing",
        "",
        "claude-crap is active but the baseline quality gate could not run.",
        "Run `cd src/mcp-server && npm run build` to enable deterministic metrics.",
        "The Golden Rule still applies: no functional code without a prior test.",
      ].join("\n") + "\n",
    );
    process.exit(ExitCodes.ALLOW);
    return;
  }

  process.stdout.write(renderBriefing(config, verdict) + "\n");
  process.exit(ExitCodes.ALLOW);
}

runHook("SessionStart", main);
