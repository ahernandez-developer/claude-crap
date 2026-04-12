// @ts-check
/**
 * Deterministic test-file resolver.
 *
 * Given a production source file (e.g. `src/foo/bar.ts`), this module
 * enumerates the conventional locations where a matching test file
 * would live and returns the first existing match — or `null` when
 * none of the candidates exist.
 *
 * The resolver is a pure function of the filesystem; it never reads
 * file contents, never invokes a test runner, and never calls the
 * MCP server. Fast enough to run inside a hook's 15-second budget.
 *
 * Supported conventions (in priority order):
 *
 *   1. Sibling `<base>.test.<ext>` / `<base>.spec.<ext>`
 *   2. Dedicated `__tests__/<base>.test.<ext>` directory
 *   3. Mirror tree under `tests/`, `test/`, or `__tests__/` at the repo root
 *   4. Python `test_<base>.py` variant
 *
 * New conventions can be added by extending the `candidatePaths` helper.
 *
 * @module hooks/lib/test-harness
 */

import { promises as fs } from "node:fs";
import { dirname, extname, basename, join, relative, resolve, sep } from "node:path";

/**
 * Result returned by {@link findTestFile}.
 *
 * @typedef {Object} TestFileResolution
 * @property {string | null} testFile    Absolute path to the first matching test file, or `null`.
 * @property {string[]}      candidates  Absolute paths of every location the resolver tried.
 * @property {boolean}       isTestFile  `true` if the input itself is a test file (resolver was a no-op).
 */

const TEST_SUFFIX_PATTERN = /\.(test|spec)\./;

/**
 * Return `true` if the given path is already a test file. Useful so the
 * PostToolUse hook does not ask "where is the test for your test file?".
 *
 * @param {string} filePath Absolute or relative source path.
 * @returns {boolean}
 */
export function isTestFile(filePath) {
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
 *   4. Nearest-ancestor flat test directory: walk up from the source
 *      file's directory toward the workspace root, and at every
 *      ancestor check for `tests/<base>.test.<ext>`. Matches layouts
 *      where tests live in a single flat directory near the source.
 *   5. Python-specific variants.
 *
 * @param {string} workspaceRoot Absolute path to the workspace root.
 * @param {string} filePath      Absolute path to the production file.
 * @returns {string[]}           Ordered list of absolute candidate paths.
 */
export function candidatePaths(workspaceRoot, filePath) {
  const absSource = resolve(filePath);
  const ext = extname(absSource);
  const base = basename(absSource, ext);
  const dir = dirname(absSource);
  const absWorkspace = resolve(workspaceRoot);
  const relFromRoot = relative(absWorkspace, absSource);
  const relDir = dirname(relFromRoot);

  const candidates = new Set();

  // 1. Sibling <base>.test.<ext> / <base>.spec.<ext>
  candidates.add(join(dir, `${base}.test${ext}`));
  candidates.add(join(dir, `${base}.spec${ext}`));

  // 2. Sibling __tests__/<base>.test.<ext>
  candidates.add(join(dir, "__tests__", `${base}.test${ext}`));
  candidates.add(join(dir, "__tests__", `${base}.spec${ext}`));

  // 3. Mirror tree under tests/, test/, __tests__ at the repo root.
  for (const testRoot of ["tests", "test", "__tests__"]) {
    candidates.add(join(absWorkspace, testRoot, relDir, `${base}.test${ext}`));
    candidates.add(join(absWorkspace, testRoot, relDir, `${base}.spec${ext}`));
    candidates.add(join(absWorkspace, testRoot, relDir, `${base}${ext}`));
  }

  // 4. Nearest-ancestor flat test directory. Walk up from the source
  //    directory to the workspace root, probing for a flat test layout
  //    at each ancestor level.
  let current = dir;
  while (current.length >= absWorkspace.length) {
    for (const testRoot of ["tests", "test", "__tests__"]) {
      candidates.add(join(current, testRoot, `${base}.test${ext}`));
      candidates.add(join(current, testRoot, `${base}.spec${ext}`));
      candidates.add(join(current, testRoot, `${base}${ext}`));
    }
    if (current === absWorkspace) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  // 5. Python: sibling test_<base>.py, and tests/test_<base>.py.
  if (ext === ".py") {
    candidates.add(join(dir, `test_${base}.py`));
    candidates.add(join(absWorkspace, "tests", `test_${base}.py`));
    candidates.add(join(absWorkspace, "tests", relDir, `test_${base}.py`));
  }

  return Array.from(candidates);
}

/**
 * Probe the filesystem and return the first candidate that exists, or
 * `null` when none of them do. Returns early with `isTestFile: true` if
 * the input path is already a test file.
 *
 * @param {string} workspaceRoot Absolute path to the workspace root.
 * @param {string} filePath      Absolute or workspace-relative path.
 * @returns {Promise<TestFileResolution>}
 */
export async function findTestFile(workspaceRoot, filePath) {
  const absolute = resolve(filePath);
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
