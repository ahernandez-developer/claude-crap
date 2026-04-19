/**
 * Centralized file and directory exclusion system.
 *
 * Every filesystem walker in the codebase (workspace-walker,
 * complexity-scanner, dashboard file-detail) imports from this module
 * instead of maintaining its own `SKIP_DIRS` constant. This
 * guarantees all subsystems agree on what to exclude.
 *
 * User-configurable exclusions from `.claude-crap.json` are layered
 * on top of the defaults via {@link createExclusionFilter}.
 *
 * @module shared/exclusions
 */

import picomatch from "picomatch";

// ── Default exclusions ──────────────────────────────────────────

/**
 * Directories excluded by name at any depth. A walker that encounters
 * a directory entry whose name is in this set should skip the entire
 * subtree. The set covers package managers, VCS, build outputs for
 * all major frameworks, language-specific caches, and plugin state.
 */
export const DEFAULT_SKIP_DIRS: ReadonlySet<string> = new Set([
  // Package managers / vendored deps
  "node_modules",
  "vendor",

  // Version control
  ".git",

  // Build outputs (general)
  "dist",
  "build",
  "bundle",
  "out",
  "target",
  "coverage",
  "artifacts",    // CI artefact staging, Maven
  "publish",      // `dotnet publish` output

  // Test coverage report bundles (generated HTML/JS from coverage tools;
  // walking them floods the complexity scanner with synthetic minified
  // functions like `coverage-report/main.js::gG` at CC 80+).
  "coverage-report",  // ReportGenerator default (.NET)
  "CoverageReport",   // ReportGenerator PascalCase variant
  "coveragereport",   // ReportGenerator lowercase fallback
  "TestResults",      // `dotnet test` default output
  "cobertura",        // Cobertura XML reporter
  "lcov-report",      // Istanbul HTML reporter
  "htmlcov",          // coverage.py HTML output

  // Desktop / mobile packaging outputs
  "dist-electron",// Electron-builder
  "release",      // Electron-builder, Tauri

  // .NET per-project build outputs (conventional at any depth)
  "bin",
  "obj",

  // iOS / macOS dependency + build caches
  "Pods",         // CocoaPods
  "DerivedData",  // Xcode
  "Carthage",     // Swift

  // Framework build outputs
  ".next",        // Next.js
  ".nuxt",        // Nuxt 2
  ".output",      // Nuxt 3
  ".vercel",      // Vercel
  ".svelte-kit",  // SvelteKit
  ".astro",       // Astro
  ".angular",     // Angular
  ".turbo",       // Turborepo
  ".parcel-cache",// Parcel
  ".expo",        // Expo / React Native

  // Language-specific caches
  ".venv",
  "venv",
  "__pycache__",
  ".cache",
  ".dart_tool",   // Dart / Flutter
  ".gradle",      // Gradle

  // IDE state
  ".idea",

  // Plugin infrastructure (excluded so the plugin's own hook/bundle
  // files don't pollute workspace metrics when developing the plugin
  // itself, and don't appear in scans of any project)
  "plugin",
  "hooks",
  "skills",

  // Plugin state
  ".claude-crap",
  ".claude-plugin",
  ".claude-sonar",
  ".codesight",
]);

/**
 * Filename-level glob patterns that match generated or minified files
 * regardless of which directory they live in. Matched against the
 * bare filename (not the full path).
 */
export const DEFAULT_SKIP_PATTERNS: ReadonlyArray<string> = [
  "*.min.js",
  "*.min.css",
  "*.min.mjs",
  "*.min.cjs",
  "*.bundle.js",
  "*.chunk.js",
];

// ── Exclusion filter ────────────────────────────────────────────

/**
 * Stateless, pre-compiled filter that every filesystem walker uses
 * to decide whether to skip a directory or file.
 */
export interface ExclusionFilter {
  /** Returns `true` when the directory should be skipped entirely. */
  shouldSkipDir(dirName: string): boolean;
  /** Returns `true` when the file should be excluded from analysis. */
  shouldSkipFile(relativePath: string, fileName: string): boolean;
}

/**
 * Create an {@link ExclusionFilter} that combines the built-in
 * defaults with optional user-defined patterns from `.claude-crap.json`.
 *
 * User patterns follow `.gitignore`-style conventions:
 *   - `apps/legacy/`   → trailing `/` means directory exclusion
 *   - `*.proto.ts`     → glob matched against workspace-relative path
 *   - `src/generated/**` → path-prefix glob
 *
 * Picomatch matchers are compiled once at construction, so per-file
 * checks are O(1) set lookups plus O(n) matcher calls where n is
 * the small number of user patterns (typically < 20).
 *
 * @param userExclusions Optional patterns from `.claude-crap.json`.
 */
export function createExclusionFilter(
  userExclusions?: ReadonlyArray<string>,
): ExclusionFilter {
  // Split user patterns into directory exclusions and file globs
  const extraDirs = new Set<string>();
  const fileGlobs: string[] = [];

  for (const pattern of userExclusions ?? []) {
    if (pattern.endsWith("/")) {
      // Directory exclusion — strip trailing slash
      extraDirs.add(pattern.slice(0, -1));
    } else {
      fileGlobs.push(pattern);
    }
  }

  // Compile filename-level matchers once
  const defaultFileMatchers = DEFAULT_SKIP_PATTERNS.map((p) =>
    picomatch(p, { dot: true }),
  );
  const userFileMatchers = fileGlobs.map((p) =>
    picomatch(p, { dot: true }),
  );

  return {
    shouldSkipDir(dirName: string): boolean {
      // Hidden directories are always skipped except .claude-plugin
      if (dirName.startsWith(".") && dirName !== ".claude-plugin") {
        return DEFAULT_SKIP_DIRS.has(dirName) || true;
      }
      return DEFAULT_SKIP_DIRS.has(dirName) || extraDirs.has(dirName);
    },

    shouldSkipFile(relativePath: string, fileName: string): boolean {
      // Check filename against default minified/bundled patterns
      for (const matcher of defaultFileMatchers) {
        if (matcher(fileName)) return true;
      }
      // Check against user-defined globs (matched on relative path)
      for (const matcher of userFileMatchers) {
        if (matcher(relativePath) || matcher(fileName)) return true;
      }
      return false;
    },
  };
}
