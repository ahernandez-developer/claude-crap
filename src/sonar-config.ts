/**
 * Workspace-level sonar configuration loader.
 *
 * Every subsystem that can be made stricter or looser (the Stop
 * quality gate, the `score_project` tool's `isError` flag) consults
 * this loader to decide how hard to push back when a policy fails.
 * Teams adopt claude-sonar in stages:
 *
 *   - `strict` (default) — the Stop hook exits 2 on any policy
 *     failure and the `score_project` tool returns `isError: true`.
 *     Matches the current, hard-coded behavior.
 *   - `warn`              — the Stop hook exits 0 but writes the
 *     full verdict to stdout so the agent still sees every failing
 *     rule in its hook transcript. `score_project.isError` stays
 *     false even on a failing project.
 *   - `advisory`          — the Stop hook exits 0 and writes a
 *     single-line summary. Minimal pressure on the agent.
 *
 * The loader resolves the `strictness` value in strict priority
 * order so a team's committed default can be overridden per-session
 * without editing the file:
 *
 *   1. `CLAUDE_SONAR_STRICTNESS` environment variable
 *   2. `.claude-sonar.json` at the workspace root
 *   3. Hardcoded default `"strict"` (zero behavior change for
 *      installs that never create the file)
 *
 * The loader is intentionally tiny — it does a single synchronous
 * file read, one optional env probe, and validates the string
 * against the enum. A hook script can call it from inside its
 * 15-second budget without breaking a sweat.
 *
 * @module sonar-config
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Exhaustive list of valid strictness values. Keep this in sync with
 * the `Strictness` type below — the tuple is `as const` so TypeScript
 * derives the union from the same source of truth.
 */
export const STRICTNESS_VALUES = ["strict", "warn", "advisory"] as const;

/**
 * Union of valid strictness values. Used by every consumer of
 * {@link SonarConfig} to branch on the mode without dealing with
 * arbitrary strings.
 */
export type Strictness = (typeof STRICTNESS_VALUES)[number];

/**
 * Hardcoded default used when neither the environment variable nor
 * `.claude-sonar.json` provides a value. Chosen as `"strict"` so the
 * plugin's hard-failing Stop gate stays the default experience.
 */
export const DEFAULT_STRICTNESS: Strictness = "strict";

/**
 * Thrown by {@link loadSonarConfig} when the configuration is
 * rejected. Callers in the hook layer fall back to the default on a
 * throw so a busted config never deadlocks the user, while callers
 * in the MCP server surface the error verbatim.
 */
export class SonarConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SonarConfigError";
  }
}

/**
 * Structure of the resolved sonar configuration returned by
 * {@link loadSonarConfig}. The shape is deliberately minimal for
 * v0.1.0; future releases may add threshold overrides under the
 * same `.claude-sonar.json` file.
 */
export interface SonarConfig {
  /** Final strictness, after env override, file, and default fallback. */
  readonly strictness: Strictness;
  /** Where the strictness value actually came from. Useful for diagnostics. */
  readonly strictnessSource: "env" | "file" | "default";
}

/**
 * Options accepted by {@link loadSonarConfig}. The only required
 * field is the workspace root the loader should search for
 * `.claude-sonar.json`.
 */
export interface LoadSonarConfigOptions {
  /**
   * Absolute path to the workspace root. The loader reads
   * `.claude-sonar.json` from this directory only — it does not
   * walk parent directories.
   */
  readonly workspaceRoot: string;
}

/**
 * Resolve the effective sonar configuration for a given workspace
 * root. Pure function except for the one synchronous file read on
 * `<workspaceRoot>/.claude-sonar.json` and the two env lookups.
 *
 * @param options Search options. Only `workspaceRoot` is required.
 * @returns       The resolved {@link SonarConfig}.
 * @throws        {@link SonarConfigError} on any invalid input.
 */
export function loadSonarConfig(options: LoadSonarConfigOptions): SonarConfig {
  const envRaw = process.env["CLAUDE_SONAR_STRICTNESS"];
  if (typeof envRaw === "string" && envRaw.trim() !== "") {
    const normalized = envRaw.trim().toLowerCase();
    if (!isStrictness(normalized)) {
      throw new SonarConfigError(
        `[sonar-config] CLAUDE_SONAR_STRICTNESS="${envRaw}" is not a valid strictness. ` +
          `Expected one of: ${STRICTNESS_VALUES.join(", ")}.`,
      );
    }
    return { strictness: normalized, strictnessSource: "env" };
  }

  const fromFile = readFromFile(options.workspaceRoot);
  if (fromFile) return { strictness: fromFile, strictnessSource: "file" };

  return { strictness: DEFAULT_STRICTNESS, strictnessSource: "default" };
}

/**
 * Attempt to read and validate `.claude-sonar.json` at the
 * workspace root. Returns `null` when the file is missing (which
 * is the common case for fresh installs). Throws
 * {@link SonarConfigError} on any other failure mode — a malformed
 * JSON file, a non-object root, a missing or wrong-type
 * `strictness` field, or an unknown enum value — so the caller
 * cannot accidentally drop into the default on a typo.
 *
 * @param workspaceRoot Absolute workspace root.
 * @returns             The validated strictness, or `null` when no
 *                      file is present.
 */
function readFromFile(workspaceRoot: string): Strictness | null {
  const filePath = join(workspaceRoot, ".claude-sonar.json");
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    if (error.code === "ENOENT") return null;
    throw new SonarConfigError(
      `[sonar-config] Failed to read ${filePath}: ${error.message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new SonarConfigError(
      `[sonar-config] ${filePath} is not valid JSON: ${(err as Error).message}`,
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SonarConfigError(
      `[sonar-config] ${filePath} must be a JSON object at the top level`,
    );
  }
  const doc = parsed as Record<string, unknown>;
  if (!("strictness" in doc)) return null;

  const value = doc["strictness"];
  if (typeof value !== "string") {
    throw new SonarConfigError(
      `[sonar-config] ${filePath}: 'strictness' must be a string, got ${typeof value}`,
    );
  }
  const normalized = value.trim().toLowerCase();
  if (!isStrictness(normalized)) {
    throw new SonarConfigError(
      `[sonar-config] ${filePath}: 'strictness' is "${value}"; ` +
        `expected one of ${STRICTNESS_VALUES.join(", ")}.`,
    );
  }
  return normalized;
}

/**
 * Runtime type guard for the {@link Strictness} union. Lets callers
 * narrow an arbitrary string to the union without casting.
 *
 * @param value Arbitrary string.
 * @returns     `true` when `value` is a recognized strictness.
 */
function isStrictness(value: string): value is Strictness {
  return (STRICTNESS_VALUES as ReadonlyArray<string>).includes(value);
}
