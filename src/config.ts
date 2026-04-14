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
 * but the loader NEVER invents stochastic values and NEVER performs I/O.
 * This module is the single source of truth for runtime configuration.
 *
 * @module config
 */

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
  /** Absolute path to the user's workspace. Resolved from `CLAUDE_PROJECT_DIR` → `CLAUDE_CRAP_PLUGIN_ROOT` → `process.cwd()`. */
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
    // CLAUDE_PROJECT_DIR is set by Claude Code to the user's workspace.
    // process.cwd() is NOT reliable — Claude Code sets it to the plugin
    // cache directory when starting MCP servers, not the user's project.
    pluginRoot: process.env.CLAUDE_PROJECT_DIR
      ?? process.env.CLAUDE_CRAP_PLUGIN_ROOT
      ?? process.cwd(),
    sarifOutputDir: process.env.CLAUDE_CRAP_SARIF_OUTPUT_DIR ?? ".claude-crap/reports",
    crapThreshold: parseNumber("CLAUDE_CRAP_CRAP_THRESHOLD", process.env.CLAUDE_CRAP_CRAP_THRESHOLD, 30),
    cyclomaticMax: parseNumber("CLAUDE_CRAP_CYCLOMATIC_MAX", process.env.CLAUDE_CRAP_CYCLOMATIC_MAX, 15),
    tdrMaxRating: parseRating(process.env.CLAUDE_CRAP_TDR_MAX_RATING, "C"),
    minutesPerLoc: parseNumber("CLAUDE_CRAP_MINUTES_PER_LOC", process.env.CLAUDE_CRAP_MINUTES_PER_LOC, 30),
    dashboardPort: parseNumber("CLAUDE_CRAP_DASHBOARD_PORT", process.env.CLAUDE_CRAP_DASHBOARD_PORT, 5117),
  };
}
