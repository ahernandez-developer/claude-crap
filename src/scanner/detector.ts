/**
 * Auto-detect which scanners are available in the current workspace.
 *
 * For each of the four supported scanners (ESLint, Semgrep, Bandit,
 * Stryker) the detector probes three signal layers in order:
 *
 *   1. Config file existence (fastest — a single `fs.stat`)
 *   2. Package.json dependency (for JS-ecosystem scanners)
 *   3. Binary availability via `which` (slowest — spawns a child process)
 *
 * Detection short-circuits on the first hit, so a project that has an
 * `eslint.config.mjs` will never shell out to `which eslint`.
 *
 * The module is side-effect-free beyond filesystem reads and one
 * `child_process.execFile` per binary probe.
 *
 * @module scanner/detector
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import type { KnownScanner } from "../adapters/common.js";

// ── Types ──────────────────────────────────────────────────────────

/**
 * Result of probing a single scanner's availability.
 */
export interface ScannerDetection {
  /** Which scanner was probed. */
  scanner: KnownScanner;
  /** Whether the scanner is available and can be executed. */
  available: boolean;
  /** Human-readable reason for the verdict. */
  reason: string;
  /** Path to the config file that triggered detection, if any. */
  configPath?: string;
  /** Working directory to run the scanner from (defaults to workspace root). */
  workingDir?: string;
}

// ── Detection signals ──────────────────────────────────────────────

/**
 * Config file globs and package.json keys per scanner. Order matters:
 * the first matching config file short-circuits further probes.
 */
interface ScannerSignals {
  configFiles: string[];
  packageJsonKeys: string[];
  binaryNames: string[];
}

const SCANNER_SIGNALS: Record<KnownScanner, ScannerSignals> = {
  eslint: {
    configFiles: [
      "eslint.config.js",
      "eslint.config.mjs",
      "eslint.config.cjs",
      "eslint.config.ts",
      "eslint.config.mts",
      "eslint.config.cts",
      ".eslintrc.js",
      ".eslintrc.cjs",
      ".eslintrc.yaml",
      ".eslintrc.yml",
      ".eslintrc.json",
    ],
    packageJsonKeys: ["eslint"],
    binaryNames: ["eslint"],
  },
  semgrep: {
    configFiles: [
      ".semgrep.yml",
      ".semgrep.yaml",
      ".semgrep.json",
    ],
    packageJsonKeys: [],
    binaryNames: ["semgrep"],
  },
  bandit: {
    configFiles: [
      ".bandit",
      "bandit.yaml",
      "bandit.yml",
    ],
    packageJsonKeys: [],
    binaryNames: ["bandit"],
  },
  stryker: {
    configFiles: [
      "stryker.conf.js",
      "stryker.conf.mjs",
      "stryker.conf.cjs",
      "stryker.conf.json",
      ".strykerrc",
      ".strykerrc.json",
    ],
    packageJsonKeys: ["@stryker-mutator/core"],
    binaryNames: ["stryker"],
  },
  dart_analyze: {
    configFiles: [
      "analysis_options.yaml",
      "pubspec.yaml",
    ],
    packageJsonKeys: [],
    binaryNames: ["dart"],
  },
  dotnet_format: {
    configFiles: [],
    packageJsonKeys: [],
    binaryNames: ["dotnet"],
  },
};

// ── Probes ──────────────────────────────────────────────────────────

/**
 * Check if any of the scanner's config files exist in the workspace.
 */
function probeConfigFiles(
  workspaceRoot: string,
  scanner: KnownScanner,
): { found: boolean; path?: string } {
  const signals = SCANNER_SIGNALS[scanner];
  for (const file of signals.configFiles) {
    const fullPath = join(workspaceRoot, file);
    if (existsSync(fullPath)) {
      return { found: true, path: fullPath };
    }
  }
  return { found: false };
}

/**
 * Check if the scanner appears in package.json deps or devDeps.
 */
function probePackageJson(
  workspaceRoot: string,
  scanner: KnownScanner,
): boolean {
  const signals = SCANNER_SIGNALS[scanner];
  if (signals.packageJsonKeys.length === 0) return false;

  const pkgPath = join(workspaceRoot, "package.json");
  if (!existsSync(pkgPath)) return false;

  try {
    const raw = readFileSync(pkgPath, "utf-8");
    const pkg = JSON.parse(raw) as Record<string, unknown>;
    const deps = {
      ...(typeof pkg.dependencies === "object" && pkg.dependencies !== null
        ? (pkg.dependencies as Record<string, string>)
        : {}),
      ...(typeof pkg.devDependencies === "object" && pkg.devDependencies !== null
        ? (pkg.devDependencies as Record<string, string>)
        : {}),
    };
    return signals.packageJsonKeys.some((key) => key in deps);
  } catch {
    return false;
  }
}

/**
 * Check if a binary is available on PATH via `which`.
 */
function probeBinary(binaryName: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("which", [binaryName], { timeout: 5_000 }, (err) => {
      resolve(err === null);
    });
  });
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Detect which supported scanners are available in the given workspace.
 * Probes config files, package.json, and binary availability in order,
 * short-circuiting on first match.
 *
 * @param workspaceRoot Absolute path to the project root.
 * @returns One {@link ScannerDetection} per known scanner.
 */
export async function detectScanners(
  workspaceRoot: string,
): Promise<ScannerDetection[]> {
  const scanners: KnownScanner[] = ["eslint", "semgrep", "bandit", "stryker", "dart_analyze", "dotnet_format"];

  const results = await Promise.all(
    scanners.map(async (scanner): Promise<ScannerDetection> => {
      // 1. Config file probe (fastest)
      const configProbe = probeConfigFiles(workspaceRoot, scanner);
      if (configProbe.found && configProbe.path) {
        return {
          scanner,
          available: true,
          reason: `config file found: ${configProbe.path.replace(workspaceRoot + "/", "")}`,
          configPath: configProbe.path,
        };
      }

      // 2. Package.json probe — declared in deps/devDeps, but is it
      //    actually installed? Check node_modules/.bin/ for the binary.
      if (probePackageJson(workspaceRoot, scanner)) {
        const binName = SCANNER_SIGNALS[scanner].binaryNames[0];
        const binPath = binName ? join(workspaceRoot, "node_modules", ".bin", binName) : null;
        const installed = binPath !== null && existsSync(binPath);
        return {
          scanner,
          available: installed,
          reason: installed
            ? "found in package.json and installed"
            : `found in package.json but not installed (run \`npm install\`)`,
        };
      }

      // 3. Binary probe (slowest)
      const signals = SCANNER_SIGNALS[scanner];
      for (const bin of signals.binaryNames) {
        if (await probeBinary(bin)) {
          return {
            scanner,
            available: true,
            reason: `binary "${bin}" found on PATH`,
          };
        }
      }

      return {
        scanner,
        available: false,
        reason: "no config file, package.json entry, or binary found",
      };
    }),
  );

  return results;
}

// ── Monorepo subdirectory probing ────────────────────────────────

/**
 * Common monorepo directory names that may contain workspace
 * subdirectories. Checked one level deep only.
 */
const MONOREPO_DIRS = ["apps", "packages", "libs", "modules", "services"];

/**
 * Detect scanners in monorepo subdirectories. Probes first-level
 * children of common monorepo directories (apps/, packages/, etc.)
 * and npm workspaces for scanner config files. Returns detections
 * with a `workingDir` pointing to the subdirectory.
 *
 * This catches e.g. `apps/mobile/pubspec.yaml` in a polyglot monorepo
 * where the root-level detector only finds ESLint.
 *
 * @param workspaceRoot Absolute path to the project root.
 * @returns Additional detections from subdirectories (may be empty).
 */
export async function detectMonorepoScanners(
  workspaceRoot: string,
): Promise<ScannerDetection[]> {
  const subdirs = new Set<string>();

  // 1. Read npm workspaces from package.json
  try {
    const pkgPath = join(workspaceRoot, "package.json");
    const raw = readFileSync(pkgPath, "utf-8");
    const pkg = JSON.parse(raw) as Record<string, unknown>;
    if (Array.isArray(pkg.workspaces)) {
      for (const ws of pkg.workspaces) {
        if (typeof ws === "string" && !ws.includes("*")) {
          const full = resolve(workspaceRoot, ws);
          if (existsSync(full)) subdirs.add(full);
        }
      }
    }
  } catch {
    // No package.json or not parseable — continue
  }

  // 2. Scan common monorepo directories one level deep
  for (const dir of MONOREPO_DIRS) {
    const full = join(workspaceRoot, dir);
    try {
      const entries = readdirSync(full, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith(".")) {
          subdirs.add(join(full, entry.name));
        }
      }
    } catch {
      // Directory doesn't exist — skip
    }
  }

  if (subdirs.size === 0) return [];

  // 3. Probe each subdirectory for scanner config files
  const detections: ScannerDetection[] = [];
  const scanners: KnownScanner[] = ["eslint", "semgrep", "bandit", "stryker", "dart_analyze", "dotnet_format"];

  for (const subdir of subdirs) {
    for (const scanner of scanners) {
      const configProbe = probeConfigFiles(subdir, scanner);
      if (!configProbe.found) continue;

      // For dart_analyze, also verify the binary is on PATH
      if (scanner === "dart_analyze") {
        const hasBinary = await probeBinary("dart");
        if (!hasBinary) continue;
      }

      const relDir = subdir.replace(workspaceRoot + "/", "");
      detections.push({
        scanner,
        available: true,
        reason: `config file found in ${relDir}/`,
        ...(configProbe.path ? { configPath: configProbe.path } : {}),
        workingDir: subdir,
      });
    }
  }

  return detections;
}

// Exported for testing
export { SCANNER_SIGNALS, MONOREPO_DIRS };
