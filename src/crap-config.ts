/**
 * Workspace-level sonar configuration loader.
 *
 * Every subsystem that can be made stricter or looser (the Stop
 * quality gate, the `score_project` tool's `isError` flag) consults
 * this loader to decide how hard to push back when a policy fails.
 * Teams adopt claude-crap in stages:
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
 *   1. `CLAUDE_CRAP_STRICTNESS` environment variable
 *   2. `.claude-crap.json` at the workspace root
 *   3. Hardcoded default `"strict"` (zero behavior change for
 *      installs that never create the file)
 *
 * The loader is intentionally tiny — it does a single synchronous
 * file read, one optional env probe, and validates the string
 * against the enum. A hook script can call it from inside its
 * 15-second budget without breaking a sweat.
 *
 * @module crap-config
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
 * {@link CrapConfig} to branch on the mode without dealing with
 * arbitrary strings.
 */
export type Strictness = (typeof STRICTNESS_VALUES)[number];

/**
 * Hardcoded default used when neither the environment variable nor
 * `.claude-crap.json` provides a value. Chosen as `"strict"` so the
 * plugin's hard-failing Stop gate stays the default experience.
 */
export const DEFAULT_STRICTNESS: Strictness = "strict";

/**
 * Thrown by {@link loadCrapConfig} when the configuration is
 * rejected. Callers in the hook layer fall back to the default on a
 * throw so a busted config never deadlocks the user, while callers
 * in the MCP server surface the error verbatim.
 */
export class CrapConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CrapConfigError";
  }
}

/**
 * Structure of the resolved sonar configuration returned by
 * {@link loadCrapConfig}. The shape is deliberately minimal for
 * v0.1.0; future releases may add threshold overrides under the
 * same `.claude-crap.json` file.
 */
export interface CrapConfig {
  /** Final strictness, after env override, file, and default fallback. */
  readonly strictness: Strictness;
  /** Where the strictness value actually came from. Useful for diagnostics. */
  readonly strictnessSource: "env" | "file" | "default";
  /** User-defined exclusion patterns (directories with trailing `/`, or file globs). */
  readonly exclude: ReadonlyArray<string>;
  /** Relative paths to directories containing sub-projects (e.g. `["apps", "packages"]`). */
  readonly projectDirs: ReadonlyArray<string>;
}

/**
 * Options accepted by {@link loadCrapConfig}. The only required
 * field is the workspace root the loader should search for
 * `.claude-crap.json`.
 */
export interface LoadCrapConfigOptions {
  /**
   * Absolute path to the workspace root. The loader reads
   * `.claude-crap.json` from this directory only — it does not
   * walk parent directories.
   */
  readonly workspaceRoot: string;
}

/**
 * Resolve the effective sonar configuration for a given workspace
 * root. Pure function except for the one synchronous file read on
 * `<workspaceRoot>/.claude-crap.json` and the two env lookups.
 *
 * @param options Search options. Only `workspaceRoot` is required.
 * @returns       The resolved {@link CrapConfig}.
 * @throws        {@link CrapConfigError} on any invalid input.
 */
export function loadCrapConfig(options: LoadCrapConfigOptions): CrapConfig {
  // Always read the file to extract `exclude`, even when strictness
  // comes from the environment variable.
  const fileResult = readFromFile(options.workspaceRoot);
  const exclude = fileResult?.exclude ?? [];
  const projectDirs = fileResult?.projectDirs ?? [];

  const envRaw = process.env["CLAUDE_CRAP_STRICTNESS"];
  if (typeof envRaw === "string" && envRaw.trim() !== "") {
    const normalized = envRaw.trim().toLowerCase();
    if (!isStrictness(normalized)) {
      throw new CrapConfigError(
        `[crap-config] CLAUDE_CRAP_STRICTNESS="${envRaw}" is not a valid strictness. ` +
          `Expected one of: ${STRICTNESS_VALUES.join(", ")}.`,
      );
    }
    return { strictness: normalized, strictnessSource: "env", exclude, projectDirs };
  }

  if (fileResult?.strictness) {
    return { strictness: fileResult.strictness, strictnessSource: "file", exclude, projectDirs };
  }

  return { strictness: DEFAULT_STRICTNESS, strictnessSource: "default", exclude, projectDirs };
}

/**
 * Attempt to read and validate `.claude-crap.json` at the
 * workspace root. Returns `null` when the file is missing (which
 * is the common case for fresh installs). Throws
 * {@link CrapConfigError} on any other failure mode — a malformed
 * JSON file, a non-object root, a missing or wrong-type
 * `strictness` field, or an unknown enum value — so the caller
 * cannot accidentally drop into the default on a typo.
 *
 * @param workspaceRoot Absolute workspace root.
 * @returns             The validated strictness, or `null` when no
 *                      file is present.
 */
interface FileResult {
  strictness: Strictness | null;
  exclude: string[];
  projectDirs: string[];
}

function readFromFile(workspaceRoot: string): FileResult | null {
  const filePath = join(workspaceRoot, ".claude-crap.json");
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    if (error.code === "ENOENT") return null;
    throw new CrapConfigError(
      `[crap-config] Failed to read ${filePath}: ${error.message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new CrapConfigError(
      `[crap-config] ${filePath} is not valid JSON: ${(err as Error).message}`,
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CrapConfigError(
      `[crap-config] ${filePath} must be a JSON object at the top level`,
    );
  }
  const doc = parsed as Record<string, unknown>;

  // Parse strictness
  let strictness: Strictness | null = null;
  if ("strictness" in doc) {
    const value = doc["strictness"];
    if (typeof value !== "string") {
      throw new CrapConfigError(
        `[crap-config] ${filePath}: 'strictness' must be a string, got ${typeof value}`,
      );
    }
    const normalized = value.trim().toLowerCase();
    if (!isStrictness(normalized)) {
      throw new CrapConfigError(
        `[crap-config] ${filePath}: 'strictness' is "${value}"; ` +
          `expected one of ${STRICTNESS_VALUES.join(", ")}.`,
      );
    }
    strictness = normalized;
  }

  // Parse exclude
  let exclude: string[] = [];
  if ("exclude" in doc) {
    const raw = doc["exclude"];
    if (!Array.isArray(raw)) {
      throw new CrapConfigError(
        `[crap-config] ${filePath}: 'exclude' must be an array of strings`,
      );
    }
    for (const item of raw) {
      if (typeof item !== "string") {
        throw new CrapConfigError(
          `[crap-config] ${filePath}: every entry in 'exclude' must be a string, got ${typeof item}`,
        );
      }
    }
    exclude = raw as string[];
  }

  // Parse projectDirs
  let projectDirs: string[] = [];
  if ("projectDirs" in doc) {
    const raw = doc["projectDirs"];
    if (!Array.isArray(raw)) {
      throw new CrapConfigError(
        `[crap-config] ${filePath}: 'projectDirs' must be an array of strings`,
      );
    }
    for (const item of raw) {
      if (typeof item !== "string") {
        throw new CrapConfigError(
          `[crap-config] ${filePath}: every entry in 'projectDirs' must be a string, got ${typeof item}`,
        );
      }
    }
    projectDirs = raw as string[];
  }

  return { strictness, exclude, projectDirs };
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
