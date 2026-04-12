#!/usr/bin/env node
// @ts-check
/**
 * claude-sonar :: PostToolUse hook — retrospective verifier.
 *
 * This hook runs immediately AFTER a Write / Edit / MultiEdit / NotebookEdit
 * call has mutated a file on disk. Its job is to inspect the artifact the
 * agent just produced and surface anything that the PreToolUse gatekeeper
 * could not catch without the finished file:
 *
 *   - Missing test harness for a production source file
 *     (Golden Rule enforcement from CLAUDE.md).
 *   - Crude "silenced warning" signatures (`eslint-disable`, `// @ts-ignore`,
 *     `# nosec`, `# type: ignore`). These often hide real issues.
 *   - TODO / FIXME / XXX markers in newly committed code.
 *
 * PostToolUse is **non-blocking** by design: every finding is emitted on
 * stderr as a warning and the tool call is allowed to proceed. The agent
 * is expected to read the warnings and remediate on its next turn, and
 * the Stop quality gate will block the task close if any violation
 * persists all the way to the end.
 *
 * The hook is intentionally cheap: only the artifact's path and raw
 * bytes are examined. Deep SAST / CRAP / TDR analysis is deferred to the
 * Stop hook which calls the MCP server.
 *
 * @module hooks/post-tool-use
 */

import { promises as fs } from "node:fs";
import { resolve } from "node:path";

import { ExitCodes, readStdinJson, runHook, warnNonBlocking } from "./lib/hook-io.mjs";
import { findTestFile, isTestFile } from "./lib/test-harness.mjs";

const WORKSPACE_ROOT = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();

/**
 * Source extensions we care about for the test-harness rule. Files
 * outside this list (README, YAML, JSON, etc.) are skipped silently.
 */
const PRODUCTION_SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".java",
  ".cs",
]);

/**
 * Inline suppression patterns. Each entry is a regex we look for in the
 * just-written file. When matched, the hook emits a warning naming the
 * suppression and asking the agent to remove it.
 */
const SUPPRESSION_PATTERNS = [
  { id: "SUPP-ESLINT-DISABLE", re: /\beslint-disable(?:-next-line)?\b/, tool: "ESLint" },
  { id: "SUPP-TS-IGNORE", re: /@ts-ignore/, tool: "TypeScript" },
  { id: "SUPP-TS-EXPECT-ERROR", re: /@ts-expect-error/, tool: "TypeScript" },
  { id: "SUPP-NOSEC", re: /#\s*nosec/, tool: "Bandit" },
  { id: "SUPP-TYPE-IGNORE", re: /#\s*type:\s*ignore/, tool: "mypy / pyright" },
];

const TODO_MARKER_REGEX = /\b(TODO|FIXME|XXX|HACK)\b/;

/**
 * @typedef {Object} HookInput
 * @property {string} [session_id]
 * @property {string} [hook_event_name]
 * @property {string} tool_name
 * @property {Record<string, unknown>} tool_input
 * @property {Record<string, unknown>} [tool_response]
 */

/**
 * Validate the minimum structural shape of a PostToolUse payload. Throws
 * with a descriptive error when the payload is unrecognizable — the
 * caller's fail-open harness will degrade gracefully.
 *
 * @param {unknown} payload
 * @returns {HookInput}
 */
function validate(payload) {
  if (!payload || typeof payload !== "object") throw new Error("payload is not an object");
  const p = /** @type {Record<string, unknown>} */ (payload);
  if (typeof p.tool_name !== "string") throw new Error("payload.tool_name missing");
  if (!p.tool_input || typeof p.tool_input !== "object") throw new Error("payload.tool_input missing");
  return /** @type {HookInput} */ (p);
}

/**
 * Extract the target file path from the tool input, if any. Returns
 * `null` when the tool does not operate on a single file (e.g. Bash).
 *
 * @param {HookInput} input
 * @returns {string | null}
 */
function extractTargetFile(input) {
  const fp = input.tool_input.file_path;
  if (typeof fp === "string") return fp;
  const np = input.tool_input.notebook_path;
  if (typeof np === "string") return np;
  return null;
}

/**
 * Is this extension one of the production source languages we guard?
 *
 * @param {string} filePath
 * @returns {boolean}
 */
function isProductionSource(filePath) {
  for (const ext of PRODUCTION_SOURCE_EXTENSIONS) {
    if (filePath.endsWith(ext)) return true;
  }
  return false;
}

/**
 * Rule: production source files must have an accompanying test file.
 *
 * Fires a `SONAR-TEST-MISSING` warning when none of the conventional
 * test locations exists. Does not block — the Stop gate enforces the
 * strict verdict.
 *
 * @param {string} filePath   Absolute path to the artifact just written.
 * @param {string} toolName   Name of the tool that wrote it (for logging).
 */
async function checkTestHarness(filePath, toolName) {
  if (isTestFile(filePath)) return;
  if (!isProductionSource(filePath)) return;

  const resolution = await findTestFile(WORKSPACE_ROOT, filePath);
  if (resolution.testFile) return;

  warnNonBlocking({
    title: "PostToolUse",
    ruleId: "SONAR-TEST-MISSING",
    tool: toolName,
    reason:
      `No test file was found for '${filePath}'. ` +
      `The Golden Rule in CLAUDE.md requires a test harness to accompany every production source file. ` +
      `Corrective action: before the Stop quality gate runs, create a test next to the file or under the ` +
      `mirror tree at 'tests/' with a name such as '${resolution.candidates[0]}'.`,
  });
}

/**
 * Rule: inline suppression markers are forbidden.
 *
 * Reads the just-written file and scans for common linter / type-checker
 * suppression annotations. When found, emits a warning naming the tool
 * whose output was being silenced.
 *
 * @param {string} filePath
 * @param {string} toolName
 */
async function checkSuppressionMarkers(filePath, toolName) {
  let content;
  try {
    content = await fs.readFile(filePath, "utf8");
  } catch {
    // File not readable (unusual: PostToolUse runs after a successful write).
    return;
  }

  for (const suppression of SUPPRESSION_PATTERNS) {
    if (!suppression.re.test(content)) continue;
    warnNonBlocking({
      title: "PostToolUse",
      ruleId: `SONAR-${suppression.id}`,
      tool: toolName,
      reason:
        `Found a suppression marker (${suppression.id}) that silences ${suppression.tool}. ` +
        `CLAUDE.md forbids silencing findings — fix the underlying issue instead. ` +
        `Corrective action: remove the suppression and address the warning it was hiding. If the warning ` +
        `is truly a false positive, add an entry to the tool's configuration file with a clear rationale.`,
    });
  }
}

/**
 * Rule: freshly committed TODO/FIXME markers are tracked.
 *
 * Not every TODO is a defect, but TODOs that slip into committed code
 * are a leading indicator of technical debt. We emit a single aggregated
 * warning per file rather than one per line.
 *
 * @param {string} filePath
 * @param {string} toolName
 */
async function checkTodoMarkers(filePath, toolName) {
  let content;
  try {
    content = await fs.readFile(filePath, "utf8");
  } catch {
    return;
  }
  const lines = content.split(/\r?\n/);
  /** @type {number[]} */
  const hits = [];
  lines.forEach((line, idx) => {
    if (TODO_MARKER_REGEX.test(line)) hits.push(idx + 1);
  });
  if (hits.length === 0) return;

  warnNonBlocking({
    title: "PostToolUse",
    ruleId: "SONAR-TODO-MARKER",
    tool: toolName,
    reason:
      `Found ${hits.length} TODO/FIXME/HACK marker(s) in '${filePath}' at line(s) ${hits.slice(0, 5).join(", ")}` +
      `${hits.length > 5 ? ", ..." : ""}. ` +
      `These are tracked by the TDR engine as debt. Either resolve them now or open a linked ticket and ` +
      `reference it in the comment so the Stop gate can audit the backlog.`,
  });
}

async function main() {
  const payload = await readStdinJson();
  const input = validate(payload);
  const filePath = extractTargetFile(input);
  if (!filePath) {
    // Tool did not write a file (e.g. Bash). Nothing to verify.
    process.exit(ExitCodes.ALLOW);
  }

  const absolute = resolve(WORKSPACE_ROOT, filePath);
  await checkTestHarness(absolute, input.tool_name);
  await checkSuppressionMarkers(absolute, input.tool_name);
  await checkTodoMarkers(absolute, input.tool_name);

  // PostToolUse never blocks — always allow. Warnings already wrote to stderr.
  process.stdout.write(
    JSON.stringify({ status: "verified", tool: input.tool_name, file: filePath }) + "\n",
  );
  process.exit(ExitCodes.ALLOW);
}

runHook("PostToolUse", main);
