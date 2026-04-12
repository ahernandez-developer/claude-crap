#!/usr/bin/env node
// @ts-check
/**
 * Portable test runner for the `npm test` family of scripts.
 *
 * Why this exists: `node --test` on Node 20.x does NOT expand `**`
 * recursive globs. It treats the literal pattern as a file path and
 * fails with `Could not find '.../src/tests/**\/*.test.ts'`. Node
 * 22+ handles the glob, which is why the suite passes locally on a
 * developer machine running Node 22 but fails on the GitHub Actions
 * Node 20 matrix job.
 *
 * Rather than pin Node 22 in CI (which would lock the `engines` floor
 * at 22 and drop Node 20 support), this runner does the glob expansion
 * in userland using `fast-glob` (already a runtime dependency) and
 * hands the discovered file list to `node --test` as explicit paths.
 * The result works on every Node release since 18.x, on every shell
 * (bash / zsh / sh / Windows cmd), and on every OS.
 *
 * Usage from `package.json#scripts`:
 *
 *   "test":             "node ./scripts/run-tests.mjs \"./src/tests/**\/*.test.ts\"",
 *   "test:adapters":    "node ./scripts/run-tests.mjs \"./src/tests/adapters/**\/*.test.ts\"",
 *   "test:integration": "node ./scripts/run-tests.mjs \"./src/tests/integration/**\/*.test.ts\"",
 *
 * Multiple patterns can be passed as separate arguments. Explicit
 * file paths are accepted too — fast-glob returns them verbatim when
 * no glob characters are present, so mixing files and patterns works.
 *
 * Exits with the subprocess exit code so CI reports test failures
 * correctly. Exits non-zero immediately when no patterns are given
 * or when a pattern matches zero files (both signal a misconfigured
 * script, never a flaky runner).
 *
 * @module scripts/run-tests
 */

import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import fastGlob from "fast-glob";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(HERE, "..");

const patterns = process.argv.slice(2);
if (patterns.length === 0) {
  process.stderr.write(
    "[run-tests] no patterns supplied — usage: node ./scripts/run-tests.mjs <glob> [<glob>...]\n",
  );
  process.exit(1);
}

// fast-glob returns forward-slash POSIX paths even on Windows, which
// is exactly what `node --test` wants, so we do not normalize.
const files = await fastGlob(patterns, {
  cwd: PLUGIN_ROOT,
  absolute: false,
  onlyFiles: true,
  // `**` is fast-glob's default recursive matcher, matching the
  // pattern shape we had in the previous `node --test` invocation.
  // We keep `dot: false` so hidden files are not considered.
});

if (files.length === 0) {
  process.stderr.write(
    `[run-tests] no test files matched any of: ${patterns.join(", ")}\n` +
      `[run-tests] cwd: ${PLUGIN_ROOT}\n`,
  );
  process.exit(1);
}

const child = spawn(
  process.execPath,
  ["--import", "tsx", "--test", ...files],
  {
    stdio: "inherit",
    cwd: PLUGIN_ROOT,
  },
);

child.on("error", (err) => {
  process.stderr.write(`[run-tests] failed to spawn node --test: ${err.message}\n`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.stderr.write(`[run-tests] node --test killed by signal ${signal}\n`);
    process.exit(1);
    return;
  }
  process.exit(code ?? 1);
});
