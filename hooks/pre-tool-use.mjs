#!/usr/bin/env node
// @ts-check
/**
 * claude-sonar :: PreToolUse hook — prophylactic gatekeeper.
 *
 * Contract with Claude Code (see https://code.claude.com/docs/en/hooks):
 *
 *   stdin  : JSON payload `{ session_id, tool_name, tool_input, ... }`
 *   stdout : Free-form informational output. Never interpreted by Claude.
 *   stderr : Corrective message injected into the agent's context when
 *            the hook exits with code 2.
 *   exit 0 : Allow the tool call.
 *   exit 2 : ABORT the tool call. Claude Code forwards stderr to the LLM.
 *   exit N : Non-zero, non-2 exit. Treated by Claude Code as "allow"
 *            (fail-open). claude-sonar uses this code only for LOW-RISK
 *            tools when the hook itself errors; HIGH-RISK tools always
 *            fall back to exit 2 (fail-closed) — see the allowlist below.
 *
 * Deterministic design principles:
 *
 *   - Zero network I/O.
 *   - Zero filesystem I/O beyond reading stdin and writing stderr.
 *   - Target latency: under 200 ms in the common case.
 *   - All rules live in `./lib/gatekeeper-rules.mjs` so they can be tested
 *     in isolation without spinning up Claude Code.
 *
 * Fail-open vs fail-closed (F-A06-01):
 *
 *   The CLAUDE.md contract states that "none of your proposals bypass
 *   those filters." A fully fail-open gatekeeper would break that
 *   contract the instant any rule throws an exception or any payload
 *   fails to parse. But a fully fail-closed gatekeeper would deadlock
 *   the user whenever Claude Code sends an unusual payload, which is
 *   also unacceptable.
 *
 *   The compromise is an allowlist of HIGH-risk tool names: Write,
 *   Edit, MultiEdit, NotebookEdit, Bash. For those tools, ANY failure
 *   to evaluate the rules (parse error, rule throw, validator throw)
 *   exits 2 with a structured corrective message. For every other
 *   tool, the legacy fail-open behavior is preserved.
 *
 *   When the stdin payload is unparseable we still try to recover the
 *   tool name via a best-effort regex so the fail-closed check can
 *   trigger even in the degraded path.
 *
 * What this hook does NOT do:
 *
 *   Deep SAST, CRAP computation, tree-sitter AST parsing, coverage lookup
 *   and SARIF aggregation all live in PostToolUse (retrospective) or Stop
 *   (final quality gate). Those stages call the MCP server. The PreToolUse
 *   hook is intentionally a cheap synchronous speed bump.
 *
 * @module hooks/pre-tool-use
 */

import { runAllRules } from "./lib/gatekeeper-rules.mjs";

/** Allow the tool call to proceed. */
const EXIT_ALLOW = 0;
/** Block the tool call and inject `stderr` into the agent's context. */
const EXIT_BLOCK = 2;
/** Internal hook failure (fail-open for LOW-risk tools only). */
const EXIT_INTERNAL_ERROR = 1;

/**
 * Tool names for which the gatekeeper MUST fail closed when it cannot
 * evaluate the payload. These are exactly the tools that can mutate the
 * workspace or execute a shell, so bypassing the gatekeeper for them
 * would violate the CLAUDE.md Golden Rule.
 */
const HIGH_RISK_TOOLS = Object.freeze(
  new Set(["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash"]),
);

/**
 * Best-effort regex used to recover `tool_name` from stdin that does not
 * parse as JSON. The regex is intentionally lenient: it just looks for
 * the first `"tool_name": "<something>"` substring anywhere in the raw
 * input. When nothing matches we return `null` and the caller treats
 * the tool as unknown (which means fail-open).
 */
const TOOL_NAME_EXTRACT_RE = /"tool_name"\s*:\s*"([^"]+)"/;

/**
 * Read the full stdin stream as a raw UTF-8 string. Kept separate from
 * JSON parsing so the caller can attempt a best-effort `tool_name`
 * extraction on malformed input.
 *
 * @returns {Promise<string>} The stdin contents, trimmed of surrounding whitespace.
 */
async function readStdinRaw() {
  /** @type {Buffer[]} */
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(/** @type {Buffer} */ (chunk));
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

/**
 * Parse a raw stdin string as JSON, rethrowing with a friendly message.
 *
 * @param {string} raw Raw stdin contents.
 * @returns {object}   The parsed JSON payload.
 * @throws  When the string is empty or not valid JSON.
 */
function parseStdinJson(raw) {
  if (!raw) {
    throw new Error("stdin was empty — claude-sonar PreToolUse expected a hook JSON payload");
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`stdin is not valid JSON: ${/** @type {Error} */ (err).message}`);
  }
}

/**
 * Validate that the payload has the minimum shape of a Claude Code hook
 * and narrow its type for downstream consumers. Throws when the payload
 * is unrecognizable — the caller handles the fail-closed / fail-open
 * decision.
 *
 * @param {unknown} payload Raw parsed JSON from stdin.
 * @returns {import("./lib/gatekeeper-rules.mjs").HookInput}
 * @throws  When required fields are missing or the wrong type.
 */
function validateHookPayload(payload) {
  if (!payload || typeof payload !== "object") {
    throw new Error("payload is not an object");
  }
  const p = /** @type {Record<string, unknown>} */ (payload);
  if (typeof p.tool_name !== "string") {
    throw new Error("payload.tool_name is missing or not a string");
  }
  if (!p.tool_input || typeof p.tool_input !== "object") {
    throw new Error("payload.tool_input is missing or not an object");
  }
  return /** @type {import("./lib/gatekeeper-rules.mjs").HookInput} */ (p);
}

/**
 * Best-effort extractor for `tool_name` from unparseable stdin. Used as
 * a last resort when the gatekeeper needs to decide between fail-open
 * and fail-closed but the payload never made it through `JSON.parse`.
 *
 * @param {string} raw Raw stdin contents.
 * @returns {string | null} The extracted tool name, or `null`.
 */
function extractToolNameFromRaw(raw) {
  if (!raw) return null;
  const match = TOOL_NAME_EXTRACT_RE.exec(raw);
  return match && typeof match[1] === "string" ? match[1] : null;
}

/**
 * `true` when the given tool name is in the high-risk allowlist and
 * therefore must fail closed on any internal hook error.
 *
 * @param {string | null | undefined} toolName
 * @returns {boolean}
 */
function isHighRiskTool(toolName) {
  return typeof toolName === "string" && HIGH_RISK_TOOLS.has(toolName);
}

/**
 * Render the fail-closed corrective message. Claude Code injects this
 * text into the agent's context when the hook exits with code 2, so it
 * must be imperative and actionable.
 *
 * @param {Object} opts
 * @param {string} opts.toolName   Recovered tool name (e.g. `"Write"`).
 * @param {string} opts.phase      Which phase failed — `"parse"` or `"evaluate"`.
 * @param {string} opts.detail     Short technical description of the failure.
 * @returns {string}               Multi-line box ready to write to stderr.
 */
function renderFailClosedMessage({ toolName, phase, detail }) {
  return [
    "╭─ claude-sonar :: PreToolUse BLOCKED (fail-closed) ───────────────",
    "│ rule : SONAR-GATEKEEPER-FAILCLOSED",
    `│ tool : ${toolName}`,
    `│ phase: ${phase}`,
    "│",
    "│ The gatekeeper could not evaluate this call and the tool is in",
    "│ the high-risk allowlist (Write, Edit, MultiEdit, NotebookEdit,",
    "│ Bash). Per CLAUDE.md, enforcement must not be bypassed by a hook",
    "│ failure for tools that mutate files or run a shell.",
    "│",
    "│ Corrective action: fix the gatekeeper bug surfaced by the detail",
    "│ line below, then retry. If you cannot fix it, ask the user to",
    "│ invoke a non-mutating tool (Read, Glob, Grep) to inspect the",
    "│ situation instead.",
    "│",
    `│ detail: ${detail}`,
    "╰──────────────────────────────────────────────────────────────────",
  ].join("\n");
}

/**
 * Handle a hook internal error uniformly. Decides between fail-closed
 * (exit 2, for high-risk tools) and fail-open (exit 1, for everything
 * else), writes the appropriate message to stderr, and exits. Never
 * returns.
 *
 * @param {Object} opts
 * @param {string | null} opts.toolName   Best-effort recovered tool name.
 * @param {string}        opts.phase      `"parse"` or `"evaluate"`.
 * @param {string}        opts.detail     Short technical reason.
 * @returns {never}
 */
function exitOnInternalError({ toolName, phase, detail }) {
  if (isHighRiskTool(toolName)) {
    process.stderr.write(
      renderFailClosedMessage({
        toolName: /** @type {string} */ (toolName),
        phase,
        detail,
      }) + "\n",
    );
    process.exit(EXIT_BLOCK);
  }
  process.stderr.write(
    `[claude-sonar] PreToolUse: ${phase} failure (${detail}). ` +
      `Tool '${toolName ?? "<unknown>"}' is not in the high-risk allowlist; ` +
      `falling back to permissive mode (fail-open).\n`,
  );
  process.exit(EXIT_INTERNAL_ERROR);
}

/**
 * Entrypoint. Reads the hook payload, runs every rule, and exits with
 * the appropriate code. Any unexpected failure is routed through
 * `exitOnInternalError`, which fails closed for high-risk tools.
 */
async function main() {
  /** @type {string} */
  let raw = "";
  /** @type {import("./lib/gatekeeper-rules.mjs").HookInput | null} */
  let input = null;

  try {
    raw = await readStdinRaw();
    const parsed = parseStdinJson(raw);
    input = validateHookPayload(parsed);
  } catch (err) {
    const recoveredTool = extractToolNameFromRaw(raw);
    exitOnInternalError({
      toolName: recoveredTool,
      phase: "parse",
      detail: /** @type {Error} */ (err).message,
    });
    return; // unreachable, but keeps the type checker happy
  }

  try {
    const verdict = runAllRules(input);
    if (verdict && verdict.blocked) {
      // Structured message for the LLM. Claude Code injects stderr into
      // the agent's context whenever a hook exits with code 2, so this
      // text effectively becomes a prompt. Keep it imperative and actionable.
      const message = [
        "╭─ claude-sonar :: PreToolUse BLOCKED ────────────────────────────",
        `│ rule : ${verdict.ruleId}`,
        `│ tool : ${input.tool_name}`,
        "│",
        `│ ${verdict.reason}`,
        "╰──────────────────────────────────────────────────────────────────",
      ].join("\n");
      process.stderr.write(`${message}\n`);
      process.exit(EXIT_BLOCK);
      return;
    }

    // Silent pass-through. We still emit a single JSON line on stdout so
    // that the hooks transcript can be audited after the fact.
    process.stdout.write(
      JSON.stringify({ status: "allow", tool: input.tool_name, rules_evaluated: 4 }) + "\n",
    );
    process.exit(EXIT_ALLOW);
  } catch (err) {
    exitOnInternalError({
      toolName: input.tool_name,
      phase: "evaluate",
      detail: /** @type {Error} */ (err).message,
    });
  }
}

main();
