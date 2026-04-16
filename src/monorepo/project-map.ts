/**
 * Monorepo project discovery and project-map generation.
 *
 * At plugin boot the host can call {@link discoverProjectMap} to walk
 * a workspace, detect every sub-project's language/framework, pick the
 * right scanner, and probe whether that scanner binary is available on
 * the host PATH. The resulting {@link ProjectMap} is optionally written
 * to `.claude-crap/projects.json` via {@link persistProjectMap} so
 * subsequent boot cycles can skip the discovery work by calling
 * {@link loadProjectMap} first.
 *
 * Detection priority per sub-directory (first match wins):
 *   pubspec.yaml                      → dart
 *   tsconfig.json + package.json      → typescript
 *   package.json (no tsconfig)        → javascript
 *   pyproject.toml / setup.py / requirements.txt → python
 *   pom.xml / build.gradle*           → java
 *   *.csproj / *.sln / Directory.Build.props      → csharp
 *   (none of the above)               → unknown
 *
 * Scanner mapping:
 *   typescript / javascript → eslint
 *   python                  → bandit
 *   java / csharp           → semgrep
 *   dart                    → dart_analyze
 *   unknown                 → null
 *
 * @module monorepo/project-map
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { promises as fs } from "node:fs";
import { join, basename, resolve } from "node:path";
import { execFile } from "node:child_process";

// ── Types ──────────────────────────────────────────────────────────────────

/**
 * Detected language / platform for a workspace sub-project.
 * Mirrors the set supported by the tree-sitter engine plus Dart.
 */
export type ProjectType =
  | "typescript"
  | "javascript"
  | "python"
  | "java"
  | "csharp"
  | "dart"
  | "unknown";

/**
 * A discovered sub-project within a monorepo workspace.
 */
export interface ProjectEntry {
  /** Human-readable name — the directory's basename (e.g. "www", "mobile"). */
  readonly name: string;
  /** Relative path from the workspace root (e.g. "apps/www"). */
  readonly path: string;
  /** Detected project type based on marker files. */
  readonly type: ProjectType;
  /** Recommended scanner name, or null when the type is unknown. */
  readonly scanner: string | null;
  /** Whether the scanner binary is reachable on the system PATH. */
  readonly scannerAvailable: boolean;
}

/**
 * Complete snapshot of a workspace's sub-project layout.
 */
export interface ProjectMap {
  /** ISO 8601 timestamp when this map was generated. */
  readonly generatedAt: string;
  /** Absolute path to the workspace root that was scanned. */
  readonly workspaceRoot: string;
  /** True when at least one sub-project was discovered. */
  readonly isMonorepo: boolean;
  /** Discovered sub-projects. Empty for single-project workspaces. */
  readonly projects: ProjectEntry[];
}

// ── Internal constants ─────────────────────────────────────────────────────

/**
 * First-level directories that conventionally contain sub-projects in
 * popular monorepo layouts (Nx, Turborepo, Rush, Lerna, custom).
 */
const MONOREPO_DIRS = ["apps", "packages", "libs", "modules", "services"] as const;

/**
 * Scanner recommended for each project type. `null` means no scanner
 * mapping is defined for the type (only "unknown" falls here).
 */
const SCANNER_FOR_TYPE: Record<ProjectType, string | null> = {
  typescript: "eslint",
  javascript: "eslint",
  python: "bandit",
  java: "semgrep",
  csharp: "dotnet_format",
  dart: "dart_analyze",
  unknown: null,
};

/**
 * The binary name to probe for each scanner. Binary availability is
 * checked with `which` via `execFile`, the same approach used in
 * `scanner/detector.ts`.
 */
const BINARY_FOR_SCANNER: Record<string, string> = {
  eslint: "eslint",
  bandit: "bandit",
  semgrep: "semgrep",
  dart_analyze: "dart",
  dotnet_format: "dotnet",
};

// ── Binary probe ───────────────────────────────────────────────────────────

/**
 * Resolve whether the given binary name is reachable on the system
 * PATH. Uses `which` via `execFile` with a short timeout so boot
 * latency stays bounded.
 *
 * @param binaryName The executable name to look up (e.g. "eslint").
 * @returns          True when `which` exits with code 0.
 */
function probeBinary(binaryName: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("which", [binaryName], { timeout: 5_000 }, (err) => {
      resolve(err === null);
    });
  });
}

// ── Project type detection ─────────────────────────────────────────────────

/**
 * Detect the dominant project type of a single directory by inspecting
 * well-known marker files. Checks are ordered so the most specific
 * signal wins (pubspec.yaml before tsconfig.json, tsconfig.json before
 * bare package.json, etc.).
 *
 * The function is synchronous because it only performs `existsSync` and
 * one `readdirSync` call (for C# extension scanning), keeping the
 * discovery loop fast and free of unnecessary Promise allocation.
 *
 * @param dir Absolute path to the directory to inspect.
 * @returns   The detected {@link ProjectType}.
 */
function detectProjectType(dir: string): ProjectType {
  const has = (file: string): boolean => existsSync(join(dir, file));

  // Dart / Flutter — check before JS because some Flutter projects also
  // have a package.json for web sub-packages.
  if (has("pubspec.yaml")) return "dart";

  // JS / TS — tsconfig.json implies TypeScript superset.
  if (has("package.json")) {
    if (has("tsconfig.json")) return "typescript";
    return "javascript";
  }

  // Python
  if (has("pyproject.toml") || has("setup.py") || has("requirements.txt")) {
    return "python";
  }

  // Java (Gradle and Maven)
  if (has("pom.xml") || has("build.gradle") || has("build.gradle.kts")) {
    return "java";
  }

  // C# — check the well-known single-file marker first, then scan for
  // per-project extension files (.csproj / .sln / .slnx) at this level
  // only. .slnx is the XML solution format introduced with .NET 9.
  if (has("Directory.Build.props")) return "csharp";
  try {
    const entries = readdirSync(dir);
    if (
      entries.some(
        (e) =>
          e.endsWith(".csproj") || e.endsWith(".sln") || e.endsWith(".slnx"),
      )
    ) {
      return "csharp";
    }
  } catch {
    // Permission error or symlink loop — treat as unknown.
  }

  return "unknown";
}

// ── Subdirectory collection ────────────────────────────────────────────────

/**
 * Normalise an npm workspaces value (which can be a plain string array
 * or an object `{ packages: string[] }`) into a flat array of patterns.
 *
 * @param workspaces The raw value of `package.json#workspaces`.
 * @returns          Array of workspace glob patterns (may be empty).
 */
function extractWorkspacePatterns(workspaces: unknown): string[] {
  if (Array.isArray(workspaces)) {
    return workspaces.filter((v): v is string => typeof v === "string");
  }
  if (
    workspaces !== null &&
    typeof workspaces === "object" &&
    "packages" in workspaces &&
    Array.isArray((workspaces as { packages: unknown }).packages)
  ) {
    return ((workspaces as { packages: unknown[] }).packages).filter(
      (v): v is string => typeof v === "string",
    );
  }
  return [];
}

/**
 * Parse a minimal pnpm-workspace.yaml into a list of package patterns.
 *
 * Supports the shape the pnpm CLI actually emits and documents:
 *
 *   packages:
 *     - "apps/*"
 *     - 'clients/mobile'
 *     - tooling/cli
 *
 * Deliberately a bespoke parser: a full YAML engine is a large
 * dependency for a single configuration file, and pnpm's own format is
 * a narrow subset. Unsupported constructs (anchors, flow sequences,
 * nested mappings) fall through as "no patterns", which in turn lets
 * the caller fall back to the conventional directory scan.
 *
 * @param yaml Raw contents of a pnpm-workspace.yaml file.
 * @returns    Array of package patterns, or an empty array.
 */
/**
 * Strip a `#` inline comment from a YAML line while respecting single-
 * and double-quoted scalars. Anchors, block scalars, and escape sequences
 * beyond `\"` are out of scope — pnpm-workspace.yaml never uses them.
 */
function stripYamlComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "\\" && inDouble && i + 1 < line.length) {
      i++; // skip the escaped character inside a double-quoted scalar
      continue;
    }
    if (!inDouble && ch === "'") {
      inSingle = !inSingle;
    } else if (!inSingle && ch === '"') {
      inDouble = !inDouble;
    } else if (!inSingle && !inDouble && ch === "#") {
      return line.slice(0, i);
    }
  }
  return line;
}

function parsePnpmWorkspaceYaml(yaml: string): string[] {
  const patterns: string[] = [];
  const lines = yaml.split(/\r?\n/);
  let inPackages = false;

  for (const rawLine of lines) {
    // Strip inline comments — but only when `#` is outside quotes, so a
    // valid entry like `"packages/#tools"` survives.
    const line = stripYamlComment(rawLine).replace(/\s+$/, "");
    if (line.length === 0) continue;

    // Top-level key "packages:" starts the list.
    if (/^packages\s*:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }

    // Any other top-level key ends the packages block.
    if (inPackages && /^[^\s-]/.test(line)) {
      inPackages = false;
      continue;
    }

    if (!inPackages) continue;

    // List item: "  - value" with optional single/double quotes. The
    // bare-word branch can now safely include `#`, because inline
    // comments are already stripped by stripYamlComment() above.
    const m = /^\s*-\s*("([^"]*)"|'([^']*)'|(\S+))\s*$/.exec(line);
    if (m) {
      const value = m[2] ?? m[3] ?? m[4] ?? "";
      if (value.length > 0) patterns.push(value);
    }
  }

  return patterns;
}

/**
 * Expand a single workspace glob pattern into matching absolute paths.
 *
 * Only supports the common `dir/*` form (one trailing `*`) and plain
 * paths (no glob at all). Full glob engines are deliberately avoided to
 * keep the module dependency-free.
 *
 * @param workspaceRoot Absolute workspace root.
 * @param pattern       A workspace pattern such as `"packages/*"` or `"apps/web"`.
 * @returns             Absolute paths of matching directories that exist on disk.
 */
function expandWorkspacePattern(
  workspaceRoot: string,
  pattern: string,
): string[] {
  if (pattern.endsWith("/*")) {
    // Glob: list one level of the parent directory.
    const parentDir = join(workspaceRoot, pattern.slice(0, -2));
    try {
      const entries = readdirSync(parentDir, { withFileTypes: true });
      return entries
        .filter((e) => e.isDirectory() && !e.name.startsWith("."))
        .map((e) => join(parentDir, e.name));
    } catch {
      return [];
    }
  }

  // Plain path — verify it exists and is a directory.
  const full = resolve(workspaceRoot, pattern);
  try {
    const entries = readdirSync(full, { withFileTypes: true });
    // readdirSync succeeds only for directories; if we got here it exists.
    void entries; // suppress unused-variable lint
    return [full];
  } catch {
    return [];
  }
}

/**
 * Collect all candidate sub-project absolute paths for the given
 * workspace root. Sources (deduplicated):
 *
 *   1. npm `workspaces` field in root `package.json` (both array and
 *      object-with-packages formats; glob patterns are expanded one
 *      level deep with `readdirSync`).
 *   2. One-level-deep subdirectories of conventional monorepo folders
 *      (`apps/`, `packages/`, `libs/`, `modules/`, `services/`).
 *
 * Hidden directories (names starting with `.`) are always skipped.
 *
 * @param workspaceRoot Absolute path to the workspace root.
 * @returns             De-duplicated set of absolute sub-project paths.
 */
function collectSubdirectories(
  workspaceRoot: string,
  extraDirs?: ReadonlyArray<string>,
): Set<string> {
  const subdirs = new Set<string>();

  // 1. npm workspaces
  const pkgPath = join(workspaceRoot, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const raw = readFileSync(pkgPath, "utf-8");
      const pkg = JSON.parse(raw) as Record<string, unknown>;
      const patterns = extractWorkspacePatterns(pkg["workspaces"]);
      for (const pattern of patterns) {
        for (const absPath of expandWorkspacePattern(workspaceRoot, pattern)) {
          subdirs.add(absPath);
        }
      }
    } catch {
      // Malformed JSON or read error — skip npm workspaces source.
    }
  }

  // 1b. pnpm workspaces — package.json does not carry a `workspaces`
  //     field under pnpm; the source of truth is pnpm-workspace.yaml.
  const pnpmPath = join(workspaceRoot, "pnpm-workspace.yaml");
  if (existsSync(pnpmPath)) {
    try {
      const raw = readFileSync(pnpmPath, "utf-8");
      const patterns = parsePnpmWorkspaceYaml(raw);
      for (const pattern of patterns) {
        for (const absPath of expandWorkspacePattern(workspaceRoot, pattern)) {
          subdirs.add(absPath);
        }
      }
    } catch {
      // Read error — skip pnpm workspaces source. The parser itself
      // never throws; malformed content just yields an empty array.
    }
  }

  // 2. User-configured projectDirs from .claude-crap.json (highest priority).
  //    These can be parent directories scanned one level deep (e.g. "apps")
  //    or direct project paths (e.g. "tools/cli").
  if (extraDirs && extraDirs.length > 0) {
    for (const dir of extraDirs) {
      const absDir = resolve(workspaceRoot, dir);
      if (!existsSync(absDir)) continue;

      // If the directory itself has a project marker, treat it as a project.
      if (directoryIsProjectRoot(absDir)) {
        subdirs.add(absDir);
        continue;
      }

      // Otherwise scan one level deep (it's a parent directory like "apps").
      try {
        const entries = readdirSync(absDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() && !entry.name.startsWith(".")) {
            subdirs.add(join(absDir, entry.name));
          }
        }
      } catch {
        // Not readable — skip.
      }
    }
  }

  // 3. Conventional monorepo directories scanned one level deep.
  //    Skipped for directories already covered by user config.
  const configuredDirNames = new Set(extraDirs?.map((d) => d.split("/")[0]) ?? []);
  for (const dir of MONOREPO_DIRS) {
    if (configuredDirNames.has(dir)) continue; // User config takes precedence
    const parentDir = join(workspaceRoot, dir);
    try {
      const entries = readdirSync(parentDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith(".")) {
          subdirs.add(join(parentDir, entry.name));
        }
      }
    } catch {
      // Directory absent — skip.
    }
  }

  return subdirs;
}

/** Files that indicate a directory is a project root. */
const PROJECT_MARKERS = [
  "package.json", "pubspec.yaml", "pyproject.toml", "setup.py",
  "pom.xml", "build.gradle", "build.gradle.kts", "Directory.Build.props",
];

/** Per-project file extensions that indicate a .NET project root. */
const DOTNET_PROJECT_EXTENSIONS = [".csproj", ".sln", ".slnx"] as const;

/**
 * Return true when `absDir` looks like a project root — either because
 * it carries one of the well-known {@link PROJECT_MARKERS} single-file
 * markers, or because it contains a .NET per-project file
 * (`.csproj` / `.sln` / `.slnx`). The .NET branch is separate because
 * those markers use extensions rather than fixed filenames.
 */
function directoryIsProjectRoot(absDir: string): boolean {
  if (PROJECT_MARKERS.some((m) => existsSync(join(absDir, m)))) return true;
  try {
    const entries = readdirSync(absDir);
    return entries.some((e) =>
      DOTNET_PROJECT_EXTENSIONS.some((ext) => e.endsWith(ext)),
    );
  } catch {
    return false;
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Discover all sub-projects in the given workspace and return a fully
 * populated {@link ProjectMap}.
 *
 * The function:
 *   1. Reads `package.json#workspaces` (supports both array and object
 *      `{ packages: [...] }` formats) and resolves glob patterns.
 *   2. Also scans `apps/`, `packages/`, `libs/`, `modules/`, and
 *      `services/` one level deep (mirrors `detectMonorepoScanners`).
 *   3. De-duplicates the collected paths.
 *   4. Detects the project type for each subdirectory.
 *   5. Maps project type to a recommended scanner.
 *   6. Probes scanner binary availability via `which`.
 *
 * When no sub-projects are found (single-project workspace) `projects`
 * is an empty array and `isMonorepo` is false.
 *
 * @param workspaceRoot Absolute path to the workspace root.
 * @returns             The generated {@link ProjectMap}.
 */
export async function discoverProjectMap(
  workspaceRoot: string,
  options?: { projectDirs?: ReadonlyArray<string> },
): Promise<ProjectMap> {
  const subdirs = collectSubdirectories(workspaceRoot, options?.projectDirs);

  // Cache binary probe results so each unique scanner is only probed once.
  const binaryCache = new Map<string, Promise<boolean>>();

  const probeScanner = (scanner: string): Promise<boolean> => {
    const binaryName = BINARY_FOR_SCANNER[scanner];
    if (binaryName === undefined) return Promise.resolve(false);

    const cached = binaryCache.get(scanner);
    if (cached !== undefined) return cached;

    const probe = probeBinary(binaryName);
    binaryCache.set(scanner, probe);
    return probe;
  };

  const projectEntries = await Promise.all(
    [...subdirs].map(async (absPath): Promise<ProjectEntry> => {
      const relPath = absPath.replace(workspaceRoot + "/", "");
      const type = detectProjectType(absPath);
      const scanner = SCANNER_FOR_TYPE[type];
      const scannerAvailable =
        scanner !== null ? await probeScanner(scanner) : false;

      return {
        name: basename(absPath),
        path: relPath,
        type,
        scanner,
        scannerAvailable,
      };
    }),
  );

  // Sort deterministically by relative path so the output is stable
  // across re-runs regardless of readdirSync ordering.
  projectEntries.sort((a, b) => a.path.localeCompare(b.path));

  return {
    generatedAt: new Date().toISOString(),
    workspaceRoot,
    isMonorepo: projectEntries.length > 0,
    projects: projectEntries,
  };
}

/**
 * Write the project map to `.claude-crap/projects.json` under the given
 * workspace root. The `.claude-crap/` directory is created if it does
 * not already exist.
 *
 * The file is written atomically via `fs.writeFile` (Node's default
 * behaviour on POSIX is to truncate-and-rewrite, which is safe for the
 * sizes expected here).
 *
 * @param map           The {@link ProjectMap} to serialise.
 * @param workspaceRoot Absolute path to the workspace root.
 */
export async function persistProjectMap(
  map: ProjectMap,
  workspaceRoot: string,
): Promise<void> {
  const dir = join(workspaceRoot, ".claude-crap");
  await fs.mkdir(dir, { recursive: true });
  const filePath = join(dir, "projects.json");
  await fs.writeFile(filePath, JSON.stringify(map, null, 2) + "\n", "utf-8");
}

/**
 * Read a previously persisted {@link ProjectMap} from
 * `.claude-crap/projects.json`. Returns `null` when the file is absent
 * or cannot be parsed, so callers can fall back to
 * {@link discoverProjectMap} without special-casing errors.
 *
 * This function is intentionally synchronous so it can be called during
 * plugin boot before the async event loop is fully initialised.
 *
 * @param workspaceRoot Absolute path to the workspace root.
 * @returns             The cached {@link ProjectMap}, or `null`.
 */
export function loadProjectMap(workspaceRoot: string): ProjectMap | null {
  const filePath = join(workspaceRoot, ".claude-crap", "projects.json");
  if (!existsSync(filePath)) return null;

  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as ProjectMap;

    // Minimal structural validation — guard against truncated writes.
    if (
      typeof parsed.generatedAt !== "string" ||
      typeof parsed.workspaceRoot !== "string" ||
      typeof parsed.isMonorepo !== "boolean" ||
      !Array.isArray(parsed.projects)
    ) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}
