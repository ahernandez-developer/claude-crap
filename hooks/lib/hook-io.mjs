// @ts-check
/**
 * Shared I/O helpers for every claude-sonar hook script.
 *
 * Every hook in the plugin shares the same stdin/stdout/stderr contract
 * with Claude Code (see https://code.claude.com/docs/en/hooks):
 *
 *   - stdin  : JSON payload with `session_id`, `tool_name`, `tool_input`,
 *              `tool_response`, `hook_event_name`, ...
 *   - stdout : Free-form text, stored in the hooks transcript.
 *   - stderr : Injected into the agent's context when the hook exits
 *              with code 2 (blocking) or captured for diagnostics when
 *              the hook exits with any non-zero code.
 *
 * This module factors that contract out so individual hooks can focus
 * on their rules and not re-implement stdin parsing or error framing.
 *
 * @module hooks/lib/hook-io
 */

/**
 * Exit codes accepted by Claude Code hooks.
 *
 * - `ALLOW` (0)   — hook passed, tool call proceeds.
 * - `BLOCK` (2)   — hook blocks the tool call; stderr goes to the agent.
 * - `INTERNAL` (1) — hook itself errored; fail-open semantics applied.
 */
export const ExitCodes = Object.freeze({
  ALLOW: 0,
  INTERNAL: 1,
  BLOCK: 2,
});

/**
 * Read stdin to EOF and parse it as JSON.
 *
 * @returns {Promise<object>} The parsed JSON payload.
 * @throws  When stdin is empty or not valid JSON.
 */
export async function readStdinJson() {
  /** @type {Buffer[]} */
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(/** @type {Buffer} */ (chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    throw new Error("stdin was empty — claude-sonar hook expected a JSON payload");
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`stdin is not valid JSON: ${/** @type {Error} */ (err).message}`);
  }
}

/**
 * Render a blocking message framed in the same box style used by the
 * PreToolUse hook. The agent sees this text on stderr when a blocking
 * hook exits with code 2, so it must be imperative and corrective.
 *
 * @param {Object} opts
 * @param {string} opts.title   - Short hook identifier (e.g. `"PostToolUse"`, `"Stop gate"`).
 * @param {string} opts.ruleId  - Stable rule identifier.
 * @param {string} opts.tool    - The tool call being evaluated (or `"-"`).
 * @param {string} opts.reason  - The corrective message for the agent.
 * @returns {string}             A multi-line formatted box.
 */
export function formatBlockingMessage({ title, ruleId, tool, reason }) {
  return [
    `╭─ claude-sonar :: ${title} BLOCKED ───────────────────────────────`,
    `│ rule : ${ruleId}`,
    `│ tool : ${tool}`,
    `│`,
    ...reason.split("\n").map((line) => `│ ${line}`),
    `╰──────────────────────────────────────────────────────────────────`,
  ].join("\n");
}

/**
 * Render a non-blocking warning. PostToolUse emits these on stderr; the
 * LLM reads them but the tool call is not aborted. The format is
 * intentionally different from a block so the agent can tell them apart.
 *
 * @param {Object} opts
 * @param {string} opts.title
 * @param {string} opts.ruleId
 * @param {string} opts.tool
 * @param {string} opts.reason
 * @returns {string}
 */
export function formatWarningMessage({ title, ruleId, tool, reason }) {
  return [
    `┌─ claude-sonar :: ${title} WARNING ───────────────────────────────`,
    `│ rule : ${ruleId}`,
    `│ tool : ${tool}`,
    `│`,
    ...reason.split("\n").map((line) => `│ ${line}`),
    `└──────────────────────────────────────────────────────────────────`,
  ].join("\n");
}

/**
 * Print a blocking message to stderr and exit with code 2.
 * Does not return.
 *
 * @param {Object} opts
 * @param {string} opts.title
 * @param {string} opts.ruleId
 * @param {string} opts.tool
 * @param {string} opts.reason
 * @returns {never}
 */
export function blockAndExit(opts) {
  process.stderr.write(formatBlockingMessage(opts) + "\n");
  process.exit(ExitCodes.BLOCK);
}

/**
 * Print a warning to stderr without blocking. Returns so the caller
 * can keep processing additional findings.
 *
 * @param {Object} opts
 * @param {string} opts.title
 * @param {string} opts.ruleId
 * @param {string} opts.tool
 * @param {string} opts.reason
 */
export function warnNonBlocking(opts) {
  process.stderr.write(formatWarningMessage(opts) + "\n");
}

/**
 * Wrap a hook's `main` function in a uniform failure harness. When the
 * user code throws, we log the error to stderr and exit with the
 * INTERNAL code — the user is never deadlocked by a broken hook.
 *
 * @param {string} hookName         Human-readable hook identifier for logs.
 * @param {() => Promise<void>} fn  Async entrypoint.
 */
export async function runHook(hookName, fn) {
  try {
    await fn();
  } catch (err) {
    process.stderr.write(
      `[claude-sonar] ${hookName}: internal error: ${/** @type {Error} */ (err).message}\n` +
        `[claude-sonar] falling back to permissive mode (fail-open).\n`,
    );
    process.exit(ExitCodes.INTERNAL);
  }
}
