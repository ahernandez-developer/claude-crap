// @ts-check
/**
 * Deterministic prophylactic rules for the claude-crap PreToolUse gatekeeper.
 *
 * Each rule is a pure function (input → verdict). Rules never perform I/O:
 * rules that would need a deep analysis instead trigger an MCP tool call
 * from a later hook (PostToolUse or Stop). The PreToolUse hook itself must
 * respond within Claude Code's 15-second timeout window — anything that
 * could block for longer than a few hundred milliseconds belongs elsewhere.
 *
 * Each rule returns a verdict of the shape:
 *
 *   { blocked: boolean, ruleId: string, reason: string }
 *
 * When `blocked === true`, the hook will exit with code 2 and write the
 * `reason` text to stderr. Claude Code forwards stderr from a blocking
 * hook straight into the agent's context window, so the reason text is
 * effectively a prompt to the LLM — it must be imperative and corrective.
 *
 * All reason strings are in English because they are injected into the
 * agent's context and the plugin is distributed publicly.
 *
 * @module hooks/lib/gatekeeper-rules
 */

/**
 * Minimal shape of the JSON payload Claude Code sends on stdin to a hook.
 * See https://code.claude.com/docs/en/hooks for the full spec.
 *
 * @typedef {Object} HookInput
 * @property {string} [session_id]        - Current session identifier.
 * @property {string} [transcript_path]   - Path to the conversation transcript.
 * @property {string} [hook_event_name]   - "PreToolUse" for this hook.
 * @property {string} tool_name           - Name of the tool about to be invoked.
 * @property {Record<string, unknown>} tool_input - Raw arguments proposed by the LLM.
 */

/**
 * Verdict returned by each rule. Rules that do not trigger return `null`
 * instead of a verdict — the runner uses that signal to short-circuit.
 *
 * @typedef {Object} Verdict
 * @property {boolean} blocked - `true` if the hook should abort the tool call.
 * @property {string}  ruleId  - Stable identifier for this rule (SONAR-XXX-NNN).
 * @property {string}  reason  - Imperative, corrective message for the LLM.
 */

/**
 * Default blocklist regex for sensitive paths. This is replaced at runtime
 * by whatever the user configured via `CLAUDE_PLUGIN_OPTION_BLOCKED_PATH_PATTERNS`.
 */
const DEFAULT_BLOCKED_PATH_REGEX =
  /(^|\/)(\.git|\.env|\.env\..*|node_modules|\.venv|secrets?|credentials?|id_rsa|\.ssh)(\/|$)/i;

/**
 * Heuristic signatures of secrets that should never be committed to source.
 * This list is intentionally conservative — the gatekeeper is a speed bump,
 * not a replacement for a real secret scanner. Deeper detection runs in
 * PostToolUse via the MCP `ingest_sarif` tool.
 */
const HARDCODED_SECRET_PATTERNS = [
  { id: "SEC-AWS", re: /AKIA[0-9A-Z]{16}/ },
  { id: "SEC-PRIVKEY", re: /-----BEGIN (RSA |OPENSSH |EC |DSA |PGP )?PRIVATE KEY-----/ },
  { id: "SEC-SLACKTOKEN", re: /xox[baprs]-[0-9A-Za-z-]{10,}/ },
  { id: "SEC-GHTOKEN", re: /gh[pousr]_[A-Za-z0-9]{36,}/ },
  { id: "SEC-JWT", re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
];

/**
 * Destructive shell patterns. These commands can silently destroy work,
 * overwrite published git history, or execute remote code without review.
 * The gatekeeper refuses them outright — if the user really needs to run
 * one of these, they should do it from their own terminal.
 */
const DESTRUCTIVE_BASH_PATTERNS = [
  { id: "BASH-RMROOT", re: /\brm\s+(-[frR]+\s+|--force\s+|--recursive\s+).*(\s|^)\/($|\s)/ },
  { id: "BASH-RMHOME", re: /\brm\s+-[frR]+\s+.*\$HOME\b/ },
  { id: "BASH-DD", re: /\bdd\s+.*of=\/dev\/(sd|nvme|disk)/ },
  { id: "BASH-GITFORCE", re: /\bgit\s+push\s+.*--force(?!-with-lease)/ },
  { id: "BASH-GITRESET", re: /\bgit\s+reset\s+--hard\s+origin/ },
  { id: "BASH-CURLSUDO", re: /\bcurl\s+[^|]*\|\s*(sudo\s+)?(bash|sh|zsh|fish)/ },
];

/**
 * Compile the user-configured blocked-path regex. Falls back to the default
 * pattern if the configured value is missing or malformed — we never let a
 * broken regex disable the gatekeeper entirely.
 *
 * @param {string | undefined} value Raw regex source from the environment.
 * @returns {RegExp}                 A compiled, case-insensitive regex.
 */
function compileBlockedPathRegex(value) {
  if (!value) return DEFAULT_BLOCKED_PATH_REGEX;
  try {
    return new RegExp(value, "i");
  } catch {
    return DEFAULT_BLOCKED_PATH_REGEX;
  }
}

/**
 * Rule 1 — blocked destination path.
 *
 * Fires when the LLM tries to Write, Edit or NotebookEdit any file that
 * matches the blocklist regex. This is the first line of defense against
 * accidental edits to `.env`, `.git`, `node_modules`, SSH keys, etc.
 *
 * @param {HookInput} input Parsed hook payload.
 * @returns {Verdict | null} A blocking verdict, or `null` to pass.
 */
export function checkBlockedPath(input) {
  const filePath =
    typeof input.tool_input.file_path === "string"
      ? input.tool_input.file_path
      : typeof input.tool_input.notebook_path === "string"
        ? input.tool_input.notebook_path
        : undefined;
  if (!filePath) return null;

  const regex = compileBlockedPathRegex(process.env.CLAUDE_PLUGIN_OPTION_BLOCKED_PATH_PATTERNS);
  if (regex.test(filePath)) {
    return {
      blocked: true,
      ruleId: "SONAR-PATH-001",
      reason:
        `Path '${filePath}' matches BLOCKED_PATH_PATTERNS. ` +
        `claude-crap refuses to write or edit sensitive paths such as secrets, .git, node_modules, or .env files. ` +
        `Corrective action: pick a file outside those directories. If this change is legitimate, ` +
        `ask the user to relax CLAUDE_PLUGIN_OPTION_BLOCKED_PATH_PATTERNS before retrying.`,
    };
  }
  return null;
}

/**
 * Rule 2 — hardcoded secrets in proposed content.
 *
 * Scans `content` (Write), `new_string` (Edit) and every element of
 * `edits[]` (MultiEdit) for well-known secret signatures. Does NOT run
 * full entropy analysis — that is the job of a secret scanner plugged in
 * via PostToolUse / `ingest_sarif`.
 *
 * @param {HookInput} input Parsed hook payload.
 * @returns {Verdict | null} A blocking verdict, or `null` to pass.
 */
export function checkHardcodedSecrets(input) {
  const candidates = [];
  if (typeof input.tool_input.content === "string") {
    candidates.push(input.tool_input.content);
  }
  if (typeof input.tool_input.new_string === "string") {
    candidates.push(input.tool_input.new_string);
  }
  if (Array.isArray(input.tool_input.edits)) {
    for (const edit of input.tool_input.edits) {
      if (edit && typeof edit === "object" && typeof (/** @type {any} */ (edit).new_string) === "string") {
        candidates.push(/** @type {any} */ (edit).new_string);
      }
    }
  }
  if (candidates.length === 0) return null;

  for (const text of candidates) {
    for (const pat of HARDCODED_SECRET_PATTERNS) {
      if (pat.re.test(text)) {
        return {
          blocked: true,
          ruleId: `SONAR-SEC-${pat.id}`,
          reason:
            `A likely hardcoded secret (${pat.id}) was detected in the proposed content. ` +
            `Per the Golden Rule in CLAUDE.md, credentials must never be embedded in source code. ` +
            `Corrective action: move the value to an environment variable or a managed secret; ` +
            `do not commit tokens, private keys, or JWTs to the source tree under any circumstance.`,
        };
      }
    }
  }
  return null;
}

/**
 * Rule 3 — destructive Bash commands.
 *
 * Only fires when `tool_name === "Bash"`. Refuses commands that can
 * recursively delete the workspace, overwrite published git history,
 * write raw bytes to a block device, or pipe a remote script into a shell.
 *
 * @param {HookInput} input Parsed hook payload.
 * @returns {Verdict | null} A blocking verdict, or `null` to pass.
 */
export function checkDestructiveBash(input) {
  if (input.tool_name !== "Bash") return null;
  const command =
    typeof input.tool_input.command === "string" ? input.tool_input.command : undefined;
  if (!command) return null;

  for (const pat of DESTRUCTIVE_BASH_PATTERNS) {
    if (pat.re.test(command)) {
      return {
        blocked: true,
        ruleId: `SONAR-BASH-${pat.id}`,
        reason:
          `The proposed Bash command matched the destructive pattern ${pat.id}: '${command}'. ` +
          `claude-crap blocks operations that can wipe the project tree, rewrite published git history, ` +
          `or execute remote code without review. ` +
          `Corrective action: if this operation is truly intended, ask the user to confirm and run it ` +
          `manually from their own terminal instead of through the agent.`,
      };
    }
  }
  return null;
}

/**
 * Rule 4 — test harness presence (no-op in PreToolUse by design).
 *
 * The CLAUDE.md Golden Rule forbids writing functional code before a
 * test safety net exists. Enforcing that strictly requires reading
 * the workspace to check for an accompanying test file, which is too
 * slow for the 15 s PreToolUse budget. The full check therefore runs
 * in PostToolUse via the MCP `require_test_harness` tool — this rule
 * stays in the pipeline purely as the registered slot for rule ID
 * `SONAR-TEST-001`, so the rule count the hook reports on stdout
 * stays stable and downstream consumers can correlate the slot with
 * its PostToolUse counterpart.
 *
 * @param {HookInput} _input Parsed hook payload (unused; always returns null).
 * @returns {Verdict | null} Always `null`; enforcement happens in PostToolUse.
 */
export function checkTestHarnessPresence(_input) {
  return null;
}

/**
 * Run every rule in order, cheapest first, and return the first blocking
 * verdict found. Returns `null` when the proposed action passes every rule.
 *
 * Ordering matters: path checks are nearly free, destructive-bash checks
 * run a handful of regexes, and secret checks iterate a longer pattern
 * list. Keeping cheap rules first minimizes the common-case latency.
 *
 * @param {HookInput} input Parsed hook payload.
 * @returns {Verdict | null} First blocking verdict, or `null` to pass.
 */
export function runAllRules(input) {
  const rules = [
    checkBlockedPath,
    checkDestructiveBash,
    checkHardcodedSecrets,
    checkTestHarnessPresence,
  ];
  for (const rule of rules) {
    const verdict = rule(input);
    if (verdict && verdict.blocked) return verdict;
  }
  return null;
}
