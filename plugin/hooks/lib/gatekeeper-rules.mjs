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
 * Canonical AWS-published example access keys. These values appear in
 * AWS's own documentation, SDK fixtures, and thousands of tutorials; they
 * are guaranteed *not* to authenticate against any real AWS account. The
 * gatekeeper allowlists them so the plugin can still edit its own docs
 * and tests that mention the rule itself.
 *
 * Entries are assembled from split literals so this source file does not
 * itself match the AKIA regex and trip the gatekeeper when loaded.
 */
const AWS_BENIGN_EXAMPLES = new Set([
  "AKIA" + "IOSFODNN7" + "EXAMPLE",  // AWS docs / SDK fixtures
  "AKIA" + "I44QH8DHB" + "EXAMPLE",  // AWS SRA sample
  "AKIA" + "IOSFODNN7" + "EXAMPL2",  // AWS sample v2
]);

/**
 * Heuristic signatures of secrets that should never be committed to source.
 * This list is intentionally conservative — the gatekeeper is a speed bump,
 * not a replacement for a real secret scanner. Deeper detection runs in
 * PostToolUse via the MCP `ingest_sarif` tool.
 *
 * Rule IDs here carry no category prefix — the emitter adds exactly one
 * `SONAR-SEC-` prefix via {@link formatSecretRuleId}. Keeping the prefix
 * out of the rule table avoids double-prefixed SARIF ruleIds, which break
 * dedup keys and downstream SIEM correlation.
 */
export const HARDCODED_SECRET_PATTERNS = [
  { id: "AWS", re: /AKIA[0-9A-Z]{16}/g },
  { id: "PRIVKEY", re: /-----BEGIN (RSA |OPENSSH |EC |DSA |PGP )?PRIVATE KEY-----/ },
  { id: "SLACKTOKEN", re: /xox[baprs]-[0-9A-Za-z-]{10,}/ },
  { id: "GHTOKEN", re: /gh[pousr]_[A-Za-z0-9]{36,}/ },
  { id: "JWT", re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
];

/**
 * Destructive shell patterns evaluated by regex. `rm -rf`-style commands
 * are handled separately by {@link findDestructiveBashHit}, which
 * tokenises the command line so quoted strings (e.g. `echo 'rm -rf /'`)
 * do not false-positive.
 *
 * Rule IDs carry no category prefix — the emitter adds a single
 * `SONAR-BASH-` prefix via {@link formatBashRuleId}.
 */
export const DESTRUCTIVE_BASH_PATTERNS = [
  { id: "DD", re: /\bdd\s+.*of=\/dev\/(sd|nvme|disk)/ },
  { id: "GITFORCE", re: /\bgit\s+push\s+.*--force(?!-with-lease)/ },
  { id: "GITRESET", re: /\bgit\s+reset\s+--hard\s+origin/ },
  { id: "CURLSUDO", re: /\bcurl\s+[^|]*\|\s*(sudo\s+)?(bash|sh|zsh|fish)/ },
];

/**
 * System directories whose recursive deletion would brick the host or
 * destroy another user's data. Matched as the first path component of
 * the target argument after a recursive/force `rm`.
 */
const RM_SYSTEM_DIRS = new Set([
  "usr", "etc", "var", "bin", "sbin", "lib", "boot",
  "System", "Applications", "Library", "opt", "root", "home",
]);

/**
 * Build a SARIF rule ID for a secret pattern. Keeps the single source of
 * truth for the `SONAR-SEC-*` namespace in the emitter.
 *
 * @param {{ id: string }} pattern
 * @returns {string}
 */
export function formatSecretRuleId(pattern) {
  return `SONAR-SEC-${pattern.id}`;
}

/**
 * Build a SARIF rule ID for a destructive-bash pattern.
 *
 * @param {{ id: string }} pattern
 * @returns {string}
 */
export function formatBashRuleId(pattern) {
  return `SONAR-BASH-${pattern.id}`;
}

/**
 * Tokenise a shell command into argv-like tokens that distinguish
 * quoted strings from bare words. Intentionally minimal — handles
 * single and double quotes, ignores backslash escapes, and does not
 * expand variables. Sufficient for gatekeeper intent detection.
 *
 * @param {string} cmd
 * @returns {Array<{ text: string, quoted: boolean }>}
 */
function tokenizeBash(cmd) {
  const tokens = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(cmd)) !== null) {
    if (m[1] !== undefined) tokens.push({ text: m[1], quoted: true });
    else if (m[2] !== undefined) tokens.push({ text: m[2], quoted: true });
    else tokens.push({ text: /** @type {string} */ (m[3]), quoted: false });
  }
  return tokens;
}

/**
 * True when a flag token requests recursive or force semantics. Accepts
 * long forms (`--recursive`, `--force`) and short-flag clusters that
 * include any of `r`, `R`, `f` (`-rf`, `-Rf`, `-rfv`, ...).
 *
 * @param {string} token
 * @returns {boolean}
 */
function isRecursiveOrForceFlag(token) {
  if (token === "--recursive" || token === "--force") return true;
  return /^-[a-zA-Z]*[rRf][a-zA-Z]*$/.test(token);
}

/**
 * Classify the destination argument of a recursive `rm` into one of the
 * high-severity categories we block, or `null` if the target is benign.
 *
 * @param {string} target
 * @returns {"RMROOT" | "RMSYSDIR" | "RMHOME" | null}
 */
function classifyRmTarget(target) {
  if (target === "/" || target === "/*") return "RMROOT";
  if (target === "$HOME" || target === "~" || target === "~/") return "RMHOME";
  // Any path whose first component is a protected system directory.
  const m = /^\/([A-Za-z]+)(\/|$)/.exec(target);
  if (m && RM_SYSTEM_DIRS.has(/** @type {string} */ (m[1]))) return "RMSYSDIR";
  return null;
}

/**
 * Scan a command line for destructive operations. Returns the first hit
 * or `null` when the command is safe. A hit is `{ id, match, ruleId }`
 * where `ruleId` is the fully-formatted SARIF identifier.
 *
 * Handles two modes:
 *   1. rm with `-r`/`-R`/`-f`/`--recursive`/`--force` targeting root,
 *      a system directory, or `$HOME` / `~` — via token-aware walk so
 *      strings inside quotes (e.g. `echo 'rm -rf /'`) do not trigger.
 *   2. Other destructive commands (`dd of=/dev/...`, `git push --force`,
 *      `git reset --hard origin`, `curl ... | sh`) — via regex, which
 *      is good enough for these patterns and cheaper than tokenisation.
 *
 * @param {string | null | undefined} command
 * @returns {{ id: string, ruleId: string, match: string } | null}
 */
export function findDestructiveBashHit(command) {
  if (!command) return null;

  // Mode 1 — token walk for rm invocations.
  const tokens = tokenizeBash(command);
  for (let i = 0; i < tokens.length; i++) {
    const t = /** @type {{ text: string, quoted: boolean }} */ (tokens[i]);
    if (t.quoted) continue;
    if (t.text !== "rm") continue;

    // Collect flags + targets until end or a command separator.
    const flags = [];
    const targets = [];
    for (let j = i + 1; j < tokens.length; j++) {
      const next = /** @type {{ text: string, quoted: boolean }} */ (tokens[j]);
      if (!next.quoted && /^[;&|]+$/.test(next.text)) break;
      if (!next.quoted && next.text.startsWith("-")) flags.push(next.text);
      else targets.push(next.text);
    }

    if (!flags.some(isRecursiveOrForceFlag)) continue;
    for (const target of targets) {
      const category = classifyRmTarget(target);
      if (category !== null) {
        return {
          id: category,
          ruleId: formatBashRuleId({ id: category }),
          match: target,
        };
      }
    }
  }

  // Mode 2 — other destructive patterns by regex.
  for (const pat of DESTRUCTIVE_BASH_PATTERNS) {
    if (pat.re.test(command)) {
      return {
        id: pat.id,
        ruleId: formatBashRuleId(pat),
        match: command,
      };
    }
  }

  return null;
}

/**
 * Scan text for hardcoded-secret signatures. Canonical AWS example
 * keys are allowlisted so the plugin can edit its own docs/tests.
 *
 * @param {string} text
 * @returns {Array<{ id: string, ruleId: string, match: string }>}
 */
export function findSecretHits(text) {
  if (typeof text !== "string" || text.length === 0) return [];
  const hits = [];
  for (const pat of HARDCODED_SECRET_PATTERNS) {
    // Reset stateful /g regexes between invocations.
    if (pat.re.global) pat.re.lastIndex = 0;
    if (pat.id === "AWS") {
      for (const m of text.matchAll(/AKIA[0-9A-Z]{16}/g)) {
        if (AWS_BENIGN_EXAMPLES.has(m[0])) continue;
        hits.push({ id: "AWS", ruleId: formatSecretRuleId({ id: "AWS" }), match: m[0] });
      }
      continue;
    }
    const m = pat.re.exec(text);
    if (m) {
      hits.push({ id: pat.id, ruleId: formatSecretRuleId(pat), match: m[0] });
    }
  }
  return hits;
}

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
    const hits = findSecretHits(text);
    if (hits.length === 0) continue;
    const hit = /** @type {{ id: string, ruleId: string, match: string }} */ (hits[0]);
    return {
      blocked: true,
      ruleId: hit.ruleId,
      reason:
        `A likely hardcoded secret (${hit.id}) was detected in the proposed content. ` +
        `Per the Golden Rule in CLAUDE.md, credentials must never be embedded in source code. ` +
        `Corrective action: move the value to an environment variable or a managed secret; ` +
        `do not commit tokens, private keys, or JWTs to the source tree under any circumstance.`,
    };
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

  const hit = findDestructiveBashHit(command);
  if (!hit) return null;

  return {
    blocked: true,
    ruleId: hit.ruleId,
    reason:
      `The proposed Bash command matched the destructive pattern ${hit.id}: '${command}'. ` +
      `claude-crap blocks operations that can wipe the project tree, rewrite published git history, ` +
      `or execute remote code without review. ` +
      `Corrective action: if this operation is truly intended, ask the user to confirm and run it ` +
      `manually from their own terminal instead of through the agent.`,
  };
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
