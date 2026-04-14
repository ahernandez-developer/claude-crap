// @ts-check
/**
 * Workspace-level sonar configuration loader (JS twin).
 *
 * This is the hook-side copy of `src/crap-config.ts`. Hooks live
 * outside the TypeScript `rootDir` and cannot import the compiled
 * `dist/` engine at the top of the module graph (the hook needs to
 * work even when `dist/` is stale or missing), so we keep a
 * zero-dependency JS twin that implements the same algorithm.
 *
 * See `src/crap-config.ts` for the full rationale. The two copies
 * are validated against the same behavior table in
 * `src/tests/crap-config.test.ts` and in
 * `src/tests/stop-quality-gate-strictness.test.ts`.
 *
 * Resolution order (most specific wins):
 *
 *   1. `CLAUDE_CRAP_STRICTNESS` environment variable
 *   2. `.claude-crap.json` at the workspace root
 *   3. Hardcoded default `"strict"`
 *
 * @module hooks/lib/crap-config
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * @typedef {"strict" | "warn" | "advisory"} Strictness
 */

/**
 * Exhaustive list of valid strictness values. Keep in sync with the
 * TypeScript twin at `src/crap-config.ts`.
 */
export const STRICTNESS_VALUES = Object.freeze(["strict", "warn", "advisory"]);

/**
 * Default strictness when neither the env var nor the file provides
 * a value. `"strict"` preserves the hard-failing Stop gate as the
 * out-of-the-box experience.
 *
 * @type {Strictness}
 */
export const DEFAULT_STRICTNESS = "warn";

/**
 * Error thrown by {@link loadCrapConfig} when the configuration is
 * rejected. Hook callers catch this and fall back to the default so
 * a busted config file never deadlocks the user.
 */
export class CrapConfigError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "CrapConfigError";
  }
}

/**
 * Resolve the effective sonar configuration for a given workspace.
 * Pure function except for the one synchronous file read on
 * `<workspaceRoot>/.claude-crap.json` and the single env lookup.
 *
 * @param {{ workspaceRoot: string }} options
 * @returns {{ strictness: Strictness, strictnessSource: "env" | "file" | "default" }}
 * @throws  {CrapConfigError} on any invalid input.
 */
export function loadCrapConfig(options) {
  const envRaw = process.env["CLAUDE_CRAP_STRICTNESS"];
  if (typeof envRaw === "string" && envRaw.trim() !== "") {
    const normalized = envRaw.trim().toLowerCase();
    if (!isStrictness(normalized)) {
      throw new CrapConfigError(
        `[crap-config] CLAUDE_CRAP_STRICTNESS="${envRaw}" is not a valid strictness. ` +
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
 * Attempt to read and validate `.claude-crap.json` at the workspace
 * root. Returns `null` when the file is missing (the common case for
 * fresh installs). Throws {@link CrapConfigError} on malformed JSON,
 * a non-object root, a wrong-type `strictness` field, or an unknown
 * enum value — so the caller cannot silently drop into the default
 * on a typo.
 *
 * @param {string} workspaceRoot
 * @returns {Strictness | null}
 */
function readFromFile(workspaceRoot) {
  const filePath = join(workspaceRoot, ".claude-crap.json");
  let raw;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (err) {
    const error = /** @type {NodeJS.ErrnoException} */ (err);
    if (error.code === "ENOENT") return null;
    throw new CrapConfigError(
      `[crap-config] Failed to read ${filePath}: ${error.message}`,
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new CrapConfigError(
      `[crap-config] ${filePath} is not valid JSON: ${/** @type {Error} */ (err).message}`,
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CrapConfigError(
      `[crap-config] ${filePath} must be a JSON object at the top level`,
    );
  }
  if (!("strictness" in parsed)) return null;

  const value = parsed.strictness;
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
  return /** @type {Strictness} */ (normalized);
}

/**
 * Runtime type guard for the Strictness union.
 *
 * @param {string} value
 * @returns {value is Strictness}
 */
function isStrictness(value) {
  return STRICTNESS_VALUES.includes(value);
}
