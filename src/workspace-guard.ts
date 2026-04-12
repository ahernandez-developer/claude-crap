/**
 * Workspace path containment guard.
 *
 * Every MCP tool that accepts a user-supplied file path routes it
 * through {@link resolveWithinWorkspace} before touching the
 * filesystem. The guard rejects any resolved absolute path that is
 * outside the configured workspace root, so the agent cannot be
 * tricked (via prompt injection through scanner output, or via its
 * own confusion) into reading files that live next to the project
 * but outside it.
 *
 * F-A01-01: the original guard in `src/index.ts` used a naive
 * `candidate.startsWith(workspace)` check, which suffers from prefix
 * confusion — for a workspace like `/Users/x/claude-crap`, an
 * absolute input path such as `/Users/x/claude-crap-evil/secret.ts`
 * would pass the check because the two share the literal prefix up
 * to the final segment. This module replaces that check with a
 * separator-aware comparison: the candidate is only accepted if it
 * equals the workspace exactly OR begins with `workspace + sep`.
 *
 * This module is intentionally pure (no I/O, no global state) so it
 * can be unit-tested without any fixtures.
 *
 * @module workspace-guard
 */

import { isAbsolute, resolve, sep } from "node:path";

/**
 * Resolve a user-supplied file path against a workspace root, returning
 * the absolute path only if it is contained inside the root. Throws a
 * descriptive error when the resolved candidate escapes the workspace.
 *
 * Rules enforced (must stay in sync with
 * `src/tests/workspace-guard.test.ts`):
 *
 *   1. Relative paths are resolved against `workspaceRoot`.
 *   2. Absolute paths are accepted as-is for resolution.
 *   3. The resolved candidate must equal `workspaceRoot` OR begin with
 *      `workspaceRoot + sep`. Sibling directories that merely share a
 *      prefix (e.g. `/tmp/workspace-evil` vs `/tmp/workspace`) are
 *      rejected.
 *   4. The comparison uses the platform's native path separator, so
 *      the guard works on both POSIX and Windows.
 *
 * @param workspaceRoot Absolute or relative path to the workspace root.
 *                      Non-absolute values are resolved against the
 *                      current working directory, which matches the
 *                      behavior of the previous in-lined guard.
 * @param filePath      User-supplied path. May be absolute or relative
 *                      to the workspace root.
 * @returns             The absolute, workspace-contained path.
 * @throws              `Error` when the candidate escapes the workspace.
 */
export function resolveWithinWorkspace(workspaceRoot: string, filePath: string): string {
  const workspace = resolve(workspaceRoot);
  const candidate = isAbsolute(filePath) ? resolve(filePath) : resolve(workspace, filePath);
  if (candidate !== workspace && !candidate.startsWith(workspace + sep)) {
    throw new Error(
      `[claude-crap] Refusing to access '${filePath}' — path escapes the workspace root`,
    );
  }
  return candidate;
}
