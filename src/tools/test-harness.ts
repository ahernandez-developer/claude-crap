/**
 * Deterministic test-file resolver used by the `require_test_harness`
 * MCP tool.
 *
 * Given a production source file (for example `src/foo/bar.ts`), this
 * module enumerates the conventional locations where a matching test
 * file would live and returns the first existing match — or `null` when
 * none of the candidates exist.
 *
 * This is a TypeScript twin of `hooks/lib/test-harness.mjs`. The two
 * are intentionally independent so neither side has to import files
 * from outside its own project tree:
 *
 *   - Hooks use the `.mjs` copy (vanilla JS, zero deps, runs everywhere).
 *   - The MCP server uses this typed copy so its consumers get full
 *     type safety and so the server stays a self-contained npm package.
 *
 * Both copies implement the same conventions and are validated against
 * the same unit tests — see `src/tests/test-harness.test.ts`.
 *
 * @module tools/test-harness
 */

import { promises as fs } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * Result of probing the filesystem for a matching test file.
 */
export interface TestFileResolution {
  /** Absolute path of the first matching test file, or `null` when none exists. */
  readonly testFile: string | null;
  /** Absolute paths of every location the resolver tried. */
  readonly candidates: ReadonlyArray<string>;
  /** `true` when the input path itself is a test file. */
  readonly isTestFile: boolean;
}

/** Matches `.test.` and `.spec.` suffixes inside a file basename. */
const TEST_SUFFIX_PATTERN = /\.(test|spec)\./;

/**
 * Return `true` when the given path is already a test file. Matching is
 * done against the basename (`foo.test.ts`, `test_foo.py`) and against
 * common test directory names in the path (`__tests__`, `tests`, `test`).
 *
 * @param filePath An absolute or relative source path.
 */
export function isTestFile(filePath: string): boolean {
  const base = basename(filePath);
  if (TEST_SUFFIX_PATTERN.test(base)) return true;
  if (base.startsWith("test_") && base.endsWith(".py")) return true;
  const parts = filePath.split(sep);
  return parts.includes("__tests__") || parts.includes("tests") || parts.includes("test");
}

/**
 * Enumerate every plausible test file path for a given production source
 * file. Does not touch the filesystem — the caller is expected to probe
 * existence separately (see {@link findTestFile}).
 *
 * Supported conventions, in the order they are probed:
 *
 *   1. Sibling `<base>.test.<ext>` / `<base>.spec.<ext>`
 *   2. Sibling `__tests__/<base>.test.<ext>`
 *   3. Mirror tree under `tests/`, `test/`, or `__tests__/` at the
 *      workspace root (e.g. `tests/src/foo/bar.test.ts`)
 *   4. **Nearest-ancestor flat test directory**: walk up from the source
 *      file's directory toward the workspace root, and at every ancestor
 *      check for `tests/<base>.test.<ext>`. Matches layouts where tests
 *      live in a single flat directory near the source (this project
 *      uses it for `src/mcp-server/src/tests/`).
 *   5. Python-specific: sibling `test_<base>.py` and mirror-tree
 *      `tests/.../test_<base>.py`.
 *
 * @param workspaceRoot Absolute workspace root.
 * @param filePath      Absolute path to the production file.
 * @returns             Ordered list of absolute candidate paths.
 */
export function candidatePaths(workspaceRoot: string, filePath: string): ReadonlyArray<string> {
  const absSource = resolve(filePath);
  const ext = extname(absSource);
  const base = basename(absSource, ext);
  const dir = dirname(absSource);
  const absWorkspace = resolve(workspaceRoot);
  const relFromRoot = relative(absWorkspace, absSource);
  const relDir = dirname(relFromRoot);

  const candidates = new Set<string>();

  // 1. Sibling <base>.test.<ext> / <base>.spec.<ext>
  candidates.add(join(dir, `${base}.test${ext}`));
  candidates.add(join(dir, `${base}.spec${ext}`));

  // 2. Sibling __tests__/<base>.test.<ext>
  candidates.add(join(dir, "__tests__", `${base}.test${ext}`));
  candidates.add(join(dir, "__tests__", `${base}.spec${ext}`));

  // 3. Mirror tree under tests/, test/, or __tests__ at the workspace root.
  for (const testRoot of ["tests", "test", "__tests__"]) {
    candidates.add(join(absWorkspace, testRoot, relDir, `${base}.test${ext}`));
    candidates.add(join(absWorkspace, testRoot, relDir, `${base}.spec${ext}`));
    candidates.add(join(absWorkspace, testRoot, relDir, `${base}${ext}`));
  }

  // 4. Nearest-ancestor flat test directory. Walk up from `dir` to
  //    `absWorkspace`, and at each ancestor probe for a flat
  //    `tests/<base>.test.<ext>` (or `test/`, `__tests__/`) layout.
  let current = dir;
  while (current.length >= absWorkspace.length) {
    for (const testRoot of ["tests", "test", "__tests__"]) {
      candidates.add(join(current, testRoot, `${base}.test${ext}`));
      candidates.add(join(current, testRoot, `${base}.spec${ext}`));
      candidates.add(join(current, testRoot, `${base}${ext}`));
    }
    if (current === absWorkspace) break;
    const parent = dirname(current);
    if (parent === current) break; // reached filesystem root, stop
    current = parent;
  }

  // 5. Python-specific variants.
  if (ext === ".py") {
    candidates.add(join(dir, `test_${base}.py`));
    candidates.add(join(absWorkspace, "tests", `test_${base}.py`));
    candidates.add(join(absWorkspace, "tests", relDir, `test_${base}.py`));
  }

  return Array.from(candidates);
}

/**
 * Probe the filesystem and return the first candidate that exists, or
 * `null` when none of them do. Returns early with `isTestFile: true`
 * when the input is already a test file.
 *
 * @param workspaceRoot Absolute workspace root.
 * @param filePath      Absolute or relative path to the production file.
 */
export async function findTestFile(
  workspaceRoot: string,
  filePath: string,
): Promise<TestFileResolution> {
  const absolute = isAbsolute(filePath) ? filePath : resolve(workspaceRoot, filePath);
  if (isTestFile(absolute)) {
    return { testFile: absolute, candidates: [absolute], isTestFile: true };
  }
  const candidates = candidatePaths(workspaceRoot, absolute);
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return { testFile: candidate, candidates, isTestFile: false };
    } catch {
      // Probe next candidate.
    }
  }
  return { testFile: null, candidates, isTestFile: false };
}
