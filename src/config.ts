/**
 * Deterministic configuration loader for the claude-crap MCP server.
 *
 * Every tunable knob is read from environment variables that are injected
 * by `.mcp.json` at server startup. Those variables are themselves derived
 * from the `CLAUDE_PLUGIN_OPTION_*` values defined in the plugin manifest,
 * which means the configuration chain is:
 *
 *   user settings  →  plugin.json "options"  →  .mcp.json "env"  →  this file
 *
 * If any environment variable is missing or empty, a safe default is used,
 * but the loader NEVER invents stochastic values. This module is the
 * single source of truth for runtime configuration.
 *
 * @module config
 */

import { execFileSync } from "node:child_process";
import { readlinkSync } from "node:fs";

/**
 * Maintainability rating letter grades used throughout claude-crap.
 *
 * The ordering is strict: A is best, E is worst. Callers that need to
 * compare two ratings should use {@link ratingToRank} from `metrics/tdr.ts`
 * rather than comparing the letters directly.
 */
export type MaintainabilityRating = "A" | "B" | "C" | "D" | "E";

/**
 * Fully resolved configuration object consumed by every subsystem of the
 * MCP server. Fields are `readonly` so that downstream code cannot mutate
 * configuration at runtime — any change must go through a server restart.
 */
export interface CrapConfig {
  /** Absolute path to the user's workspace. Resolved via {@link discoverWorkspaceRoot}. */
  readonly pluginRoot: string;
  /** Directory (relative to the workspace) where consolidated SARIF reports are written. */
  readonly sarifOutputDir: string;
  /** Hard block threshold for the CRAP index. Functions above this fail the Stop quality gate. */
  readonly crapThreshold: number;
  /** Maximum cyclomatic complexity allowed per function before warnings fire. */
  readonly cyclomaticMax: number;
  /** Highest (worst) maintainability rating the project is allowed to hold. */
  readonly tdrMaxRating: MaintainabilityRating;
  /** Assumed development cost per line of code, in minutes. Used as the TDR denominator. */
  readonly minutesPerLoc: number;
  /** Local TCP port the Vue.js dashboard will bind to. */
  readonly dashboardPort: number;
}

/**
 * Detects an unexpanded `.mcp.json` variable template such as
 * `${CLAUDE_PROJECT_DIR}`. Claude Code only expands `${CLAUDE_PLUGIN_ROOT}`
 * inside `.mcp.json`; every other `${VAR}` is passed through verbatim and
 * must NOT be treated as a real filesystem path.
 */
function isLiteralVarTemplate(value: string | undefined): boolean {
  if (value === undefined) return false;
  return /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value.trim());
}

/**
 * Normalize an environment variable that is expected to contain a path.
 * Returns `undefined` if the value is missing, empty, or an unexpanded
 * `${...}` template. Any non-empty concrete string is returned as-is.
 */
function sanitizeEnvPath(value: string | undefined): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (isLiteralVarTemplate(value)) return undefined;
  return value;
}

/**
 * Read the current working directory of the parent process. Claude Code
 * spawns MCP servers with its own cwd set to the user's workspace, so the
 * parent's cwd is the most reliable fallback when `CLAUDE_PROJECT_DIR` is
 * not inherited (e.g. because Claude Code only exports it for hooks).
 *
 * Returns `undefined` on any platform or failure mode the probe cannot
 * handle — callers must be prepared for a missing result.
 */
function readParentCwdDefault(): string | undefined {
  try {
    const ppid = process.ppid;
    if (!ppid || ppid === 0) return undefined;

    if (process.platform === "linux") {
      // /proc/<pid>/cwd is a symlink to the process's cwd.
      return readlinkSync(`/proc/${ppid}/cwd`);
    }

    if (process.platform === "darwin") {
      // `lsof -a -p <pid> -d cwd -F n` emits a single line starting with
      // `n<path>` for the cwd file descriptor. `-F` keeps the output
      // machine-readable.
      const output = execFileSync(
        "lsof",
        ["-a", "-p", String(ppid), "-d", "cwd", "-F", "n"],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 2000,
        },
      );
      const match = output.match(/^n(.+)$/m);
      return match?.[1];
    }

    // Windows and other platforms: no reliable no-dep probe.
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Parameters accepted by {@link discoverWorkspaceRoot}. The only field is
 * an injectable `readParentCwd` implementation so that tests can pin the
 * fallback behavior without spawning `lsof` or reading `/proc`.
 */
export interface DiscoverWorkspaceOptions {
  readParentCwd?: () => string | undefined;
}

/**
 * Resolve the user's workspace directory. Strategy, in strict priority
 * order:
 *
 *   1. `CLAUDE_PROJECT_DIR`      (sanitized — ignored if it's `${...}`)
 *   2. `CLAUDE_CRAP_PLUGIN_ROOT` (sanitized — legacy explicit override)
 *   3. Parent process cwd       (Claude Code's cwd = the workspace)
 *   4. `process.cwd()`          (last-resort fallback; usually wrong for
 *                                MCP servers because Claude Code sets
 *                                cwd to the plugin cache directory)
 *
 * This function NEVER returns an unexpanded `${...}` template; any source
 * that contains one is skipped as if it were unset.
 *
 * @param options Injection points for tests.
 * @returns       A concrete filesystem path.
 */
export function discoverWorkspaceRoot(options: DiscoverWorkspaceOptions = {}): string {
  const readParentCwd = options.readParentCwd ?? readParentCwdDefault;

  const fromProjectDir = sanitizeEnvPath(process.env.CLAUDE_PROJECT_DIR);
  if (fromProjectDir) return fromProjectDir;

  const fromPluginRoot = sanitizeEnvPath(process.env.CLAUDE_CRAP_PLUGIN_ROOT);
  if (fromPluginRoot) return fromPluginRoot;

  const fromParent = sanitizeEnvPath(readParentCwd());
  if (fromParent) return fromParent;

  return process.cwd();
}

/**
 * Parse a numeric environment variable, falling back to `fallback` when the
 * variable is undefined or empty. Throws if the value is present but not a
 * finite number — we prefer a loud startup failure over silently using a
 * wrong threshold.
 *
 * @param name     Environment variable name, used only for the error message.
 * @param raw      Raw value read from `process.env`.
 * @param fallback Default value used when `raw` is undefined/empty.
 * @returns        The parsed number.
 * @throws         When `raw` is present but not a finite number.
 */
function parseNumber(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`[claude-crap] Env ${name}="${raw}" is not a finite number`);
  }
  return value;
}

/**
 * Parse a maintainability rating from an environment variable. Accepts any
 * casing (`a`, `A`, `  a  ` all become `"A"`). Throws on invalid letters so
 * the server refuses to start rather than running with an unknown policy.
 *
 * @param raw      Raw value read from `process.env`.
 * @param fallback Default rating used when `raw` is undefined.
 * @returns        A validated {@link MaintainabilityRating}.
 * @throws         When `raw` is a non-empty string that is not A..E.
 */
function parseRating(raw: string | undefined, fallback: MaintainabilityRating): MaintainabilityRating {
  if (!raw) return fallback;
  const normalized = raw.trim().toUpperCase();
  if (!["A", "B", "C", "D", "E"].includes(normalized)) {
    throw new Error(`[claude-crap] TDR_MAX_RATING="${raw}" must be one of A, B, C, D, E`);
  }
  return normalized as MaintainabilityRating;
}

/**
 * Build the complete {@link CrapConfig} from the current process environment.
 *
 * This should be called exactly once at server startup. Subsequent callers
 * that need configuration should accept a `CrapConfig` parameter instead
 * of re-reading from `process.env`, so that tests can inject custom values.
 *
 * @returns A fully validated, immutable configuration object.
 * @throws  When any environment variable is present but malformed.
 */
export function loadConfig(): CrapConfig {
  return {
    pluginRoot: discoverWorkspaceRoot(),
    sarifOutputDir: process.env.CLAUDE_CRAP_SARIF_OUTPUT_DIR ?? ".claude-crap/reports",
    crapThreshold: parseNumber("CLAUDE_CRAP_CRAP_THRESHOLD", process.env.CLAUDE_CRAP_CRAP_THRESHOLD, 30),
    cyclomaticMax: parseNumber("CLAUDE_CRAP_CYCLOMATIC_MAX", process.env.CLAUDE_CRAP_CYCLOMATIC_MAX, 15),
    tdrMaxRating: parseRating(process.env.CLAUDE_CRAP_TDR_MAX_RATING, "C"),
    minutesPerLoc: parseNumber("CLAUDE_CRAP_MINUTES_PER_LOC", process.env.CLAUDE_CRAP_MINUTES_PER_LOC, 30),
    dashboardPort: parseNumber("CLAUDE_CRAP_DASHBOARD_PORT", process.env.CLAUDE_CRAP_DASHBOARD_PORT, 5117),
  };
}
