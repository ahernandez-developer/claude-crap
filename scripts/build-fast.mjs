// @ts-check
/**
 * `npm run build:fast` — fast dev build using esbuild.
 *
 * `tsc` remains the canonical build tool (it produces `.d.ts`
 * declaration files, runs the full type checker, and is the one the
 * CI pipeline + `np release` call) — but for the inner loop it is
 * slow to feel. esbuild compiles the entire `src/` tree to `dist/`
 * in under 100 ms on a modern laptop, which matters when you're
 * rebuilding after every keystroke.
 *
 * Trade-offs vs. `tsc`:
 *
 *   - ✅ 10-20x faster
 *   - ❌ No type checking (run `npm run typecheck` separately)
 *   - ❌ No `.d.ts` files (so `exports` with `types` would not work)
 *   - ❌ No declaration maps
 *
 * The script walks `src/` for all `.ts` files (excluding tests and
 * declaration files), then hands them to esbuild as the entry point
 * list so every file gets its own output mirror. That matches what
 * `tsc` does and keeps the `exports` map working.
 *
 * This build mode is strictly for local dev feedback — never use it
 * to publish an npm release. `prepublishOnly` always calls `tsc`.
 *
 * Skip this build with `CLAUDE_CRAP_SKIP_FAST_BUILD=1` to short-circuit.
 *
 * @module scripts/build-fast
 */

import { build } from "esbuild";
import { promises as fs } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(HERE, "..");
const SRC_DIR = join(PLUGIN_ROOT, "src");
const DIST_DIR = join(PLUGIN_ROOT, "dist");

/**
 * Recursively walk a directory and yield every `.ts` file path that
 * should be compiled. Mirrors the `tsconfig.json` include/exclude
 * lists so the two build modes produce the same output set.
 *
 * @param {string} dir Absolute directory to walk.
 * @returns {AsyncGenerator<string>}
 */
async function* walkSources(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Tests are compiled by tsc and run via tsx, never by esbuild.
      if (entry.name === "tests") continue;
      yield* walkSources(full);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".ts")) continue;
    if (entry.name.endsWith(".d.ts")) continue;
    if (entry.name.endsWith(".test.ts")) continue;
    yield full;
  }
}

/**
 * Replace the trailing `.ts` of an absolute source path with `.js`
 * and relocate it from `src/` to `dist/`. Mirrors exactly what `tsc`
 * does with `outDir: "./dist"` and `rootDir: "./src"`.
 *
 * @param {string} srcPath Absolute path inside `src/`.
 * @returns {string}
 */
function srcToDist(srcPath) {
  const rel = relative(SRC_DIR, srcPath);
  return join(DIST_DIR, rel).replace(/\.ts$/, ".js");
}

async function main() {
  const started = Date.now();
  const entryPoints = [];
  for await (const src of walkSources(SRC_DIR)) {
    entryPoints.push(src);
  }

  // Clean dist/ so stale output from a previous `tsc` run cannot
  // mask a missing file in the fast build. Full-tree rebuild is
  // still under 200 ms in total.
  await fs.rm(DIST_DIR, { recursive: true, force: true });
  await fs.mkdir(DIST_DIR, { recursive: true });

  await build({
    entryPoints,
    outdir: DIST_DIR,
    outbase: SRC_DIR,
    bundle: false,
    format: "esm",
    platform: "node",
    target: ["node20"],
    sourcemap: "linked",
    logLevel: "warning",
    // Preserve the existing directory layout in dist/ so the
    // `exports` field in package.json still resolves correctly.
    // `outbase: SRC_DIR` is what makes this work.
  });

  const durationMs = Date.now() - started;
  const outCount = entryPoints.length;
  process.stdout.write(
    `claude-crap: fast build complete (${outCount} files → ${srcToDist(entryPoints[0] ?? SRC_DIR)
      .split("/")
      .slice(-3, -1)
      .join("/")}, ${durationMs}ms)\n`,
  );
  process.stdout.write(
    `claude-crap: NOTE — this build skipped type checking and declaration files.\n` +
      `  Run \`npm run typecheck\` before committing, and use \`npm run build\` for releases.\n`,
  );
}

if (process.env.CLAUDE_CRAP_SKIP_FAST_BUILD) {
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`claude-crap fast build failed: ${err?.message ?? err}\n`);
  process.exit(1);
});
