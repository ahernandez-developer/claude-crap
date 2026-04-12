#!/usr/bin/env node
// @ts-check
/**
 * claude-crap :: Stop / SubagentStop hook — final quality gate.
 *
 * When the agent (or a subagent) declares it is done with a task,
 * this hook has the last word. It reads the consolidated SARIF
 * report, estimates workspace LOC, computes the Technical Debt
 * Ratio, and checks every configured policy:
 *
 *   - `SONAR-GATE-TDR`     — project TDR rating must not exceed
 *                             the configured `TDR_MAX_RATING`.
 *   - `SONAR-GATE-ERRORS`  — no SARIF finding at level "error" may
 *                             survive.
 *
 * Strictness (v0.1.0):
 *
 *   The behavior on a failing verdict is controlled by the
 *   workspace sonar configuration. Teams can adopt claude-crap in
 *   stages by editing `.claude-crap.json` at their workspace root
 *   or setting the `CLAUDE_CRAP_STRICTNESS` environment variable.
 *   Three modes are supported:
 *
 *   - `strict` (default) — exit 2 with the full BLOCKED box on
 *     stderr. Claude Code injects stderr into the agent's context,
 *     so the agent must remediate before retrying the Stop hook.
 *     This is the original, hard-failing behavior of the plugin.
 *   - `warn`              — exit 0 with the full WARNING box on
 *     stdout. The task is allowed to close, but the hook transcript
 *     still carries every failing rule so the agent can choose to
 *     remediate on its next turn.
 *   - `advisory`          — exit 0 with a single-line ADVISORY note
 *     on stdout. Minimal pressure on the agent.
 *
 *   A passing verdict always exits 0 and emits the same JSON status
 *   line regardless of strictness.
 *
 * This hook deliberately lives outside the MCP server process so
 * that it runs deterministically even if the server is momentarily
 * disconnected. It imports the TDR classification functions
 * directly from the compiled MCP server's `dist/` so the math is
 * the single source of truth.
 *
 * @module hooks/stop-quality-gate
 */

import { ExitCodes, readStdinJson, runHook } from "./lib/hook-io.mjs";
import { evaluateQualityGate, loadQualityGateConfig } from "./lib/quality-gate.mjs";
import {
  DEFAULT_STRICTNESS,
  loadCrapConfig,
  CrapConfigError,
} from "./lib/crap-config.mjs";

/**
 * Resolve the effective strictness for this Stop hook invocation.
 * Falls back to {@link DEFAULT_STRICTNESS} on any loader error so a
 * busted `.claude-crap.json` never deadlocks the user — the file
 * error is logged to stderr for diagnostics but the gate still
 * runs.
 *
 * @param {string} workspaceRoot Absolute path to the user's workspace.
 * @returns {{strictness: import("./lib/crap-config.mjs").Strictness, source: "env" | "file" | "default" | "fallback"}}
 */
function resolveStrictness(workspaceRoot) {
  try {
    const config = loadCrapConfig({ workspaceRoot });
    return { strictness: config.strictness, source: config.strictnessSource };
  } catch (err) {
    if (err instanceof CrapConfigError) {
      process.stderr.write(
        `[claude-crap] Stop hook: ${err.message}\n` +
          `[claude-crap] falling back to strictness='${DEFAULT_STRICTNESS}' for this run.\n`,
      );
      return { strictness: DEFAULT_STRICTNESS, source: "fallback" };
    }
    throw err;
  }
}

/**
 * Render the failing verdict as the existing BLOCKED box used by
 * `strict` mode. Keeps the shape stable so strict-mode users see
 * exactly the same output as before this feature landed.
 *
 * @param {import("./lib/quality-gate.mjs").GateVerdict} verdict
 * @returns {string}
 */
function renderBlockedBox(verdict) {
  return renderVerdictBox(verdict, "BLOCKED");
}

/**
 * Render the failing verdict as a WARNING box. Same information
 * density as the BLOCKED box, but the header changes so agents and
 * humans can distinguish a blocking gate from an advisory one.
 *
 * @param {import("./lib/quality-gate.mjs").GateVerdict} verdict
 * @returns {string}
 */
function renderWarningBox(verdict) {
  return renderVerdictBox(verdict, "WARNING");
}

/**
 * Render a single-line advisory note. Used by `advisory` mode so
 * the agent is informed of the quality state without being pushed
 * into a remediation loop.
 *
 * @param {import("./lib/quality-gate.mjs").GateVerdict} verdict
 * @returns {string}
 */
function renderAdvisoryLine(verdict) {
  const { summary, failures } = verdict;
  const ruleIds = failures.map((f) => f.ruleId).join(", ") || "<none>";
  return (
    `claude-crap :: Stop quality gate ADVISORY — ${failures.length} policy note(s). ` +
    `TDR ${summary.tdrPercent}% (rating ${summary.tdrRating}), ` +
    `${summary.errorFindings} error / ${summary.warningFindings} warning / ${summary.noteFindings} note, ` +
    `rules: ${ruleIds}. This was an advisory run — the task may close.`
  );
}

/**
 * Shared renderer for the BLOCKED and WARNING variants. The only
 * difference between them is the header label and the explanatory
 * sentence at the top.
 *
 * @param {import("./lib/quality-gate.mjs").GateVerdict} verdict
 * @param {"BLOCKED" | "WARNING"} label
 * @returns {string}
 */
function renderVerdictBox(verdict, label) {
  const { summary, failures } = verdict;
  const header = [
    `╭─ claude-crap :: Stop quality gate ${label} ─────────────────────`,
    `│ total findings      : ${summary.totalFindings}`,
    `│   error / warn / note: ${summary.errorFindings} / ${summary.warningFindings} / ${summary.noteFindings}`,
    `│ remediation minutes : ${summary.remediationMinutes}`,
    `│ workspace LOC       : ${summary.physicalLoc}`,
    `│ TDR                 : ${summary.tdrPercent}%  →  rating ${summary.tdrRating}`,
    `│ tools seen          : ${summary.toolsSeen.join(", ") || "<none>"}`,
    `│`,
    `│ ${failures.length} policy failure(s):`,
    `│`,
  ];
  /** @type {string[]} */
  const body = [];
  failures.forEach((f, idx) => {
    body.push(`│ [${idx + 1}] ${f.ruleId}`);
    for (const line of f.message.split("\n")) {
      body.push(`│     ${line}`);
    }
    body.push(`│`);
  });
  const footer = [`╰──────────────────────────────────────────────────────────────────`];
  return [...header, ...body, ...footer].join("\n");
}

async function main() {
  // We read stdin so hook consumers see we honored the contract,
  // but the Stop hook does not actually need per-call state — the
  // verdict is entirely derived from the on-disk SARIF and the
  // workspace.
  await readStdinJson().catch(() => ({}));

  const gateConfig = loadQualityGateConfig();
  const verdict = await evaluateQualityGate(gateConfig);

  // A passing verdict always exits 0 with the same status line
  // regardless of strictness — the feature only changes the FAILING
  // path.
  if (verdict.passed) {
    process.stdout.write(
      JSON.stringify({
        status: "passed",
        gate: "stop",
        summary: verdict.summary,
      }) + "\n",
    );
    process.exit(ExitCodes.ALLOW);
    return;
  }

  const { strictness } = resolveStrictness(gateConfig.workspaceRoot);

  if (strictness === "strict") {
    // Hard block: render the BLOCKED box to stderr so Claude Code
    // injects it into the agent's context, then exit 2.
    process.stderr.write(renderBlockedBox(verdict) + "\n");
    process.exit(ExitCodes.BLOCK);
    return;
  }

  if (strictness === "warn") {
    // Soft nudge: render the WARNING box to stdout so it lands in
    // the hook transcript and the agent still sees every failing
    // rule, then exit 0 so the task is allowed to close.
    process.stdout.write(renderWarningBox(verdict) + "\n");
    process.stdout.write(
      JSON.stringify({
        status: "warning",
        gate: "stop",
        strictness: "warn",
        summary: verdict.summary,
      }) + "\n",
    );
    process.exit(ExitCodes.ALLOW);
    return;
  }

  // strictness === "advisory"
  // Minimal pressure: single-line note on stdout, then exit 0.
  process.stdout.write(renderAdvisoryLine(verdict) + "\n");
  process.stdout.write(
    JSON.stringify({
      status: "advisory",
      gate: "stop",
      strictness: "advisory",
      summary: verdict.summary,
    }) + "\n",
  );
  process.exit(ExitCodes.ALLOW);
}

runHook("Stop quality gate", main);
