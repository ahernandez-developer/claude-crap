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

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
 * Detect which of the four supported scanners are available in the
 * given workspace. Probes config files, package.json, and binary
 * availability in order, short-circuiting on first match.
 *
 * @param workspaceRoot Absolute path to the project root.
 * @returns One {@link ScannerDetection} per known scanner.
 */
export async function detectScanners(
  workspaceRoot: string,
): Promise<ScannerDetection[]> {
  const scanners: KnownScanner[] = ["eslint", "semgrep", "bandit", "stryker"];

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

      // 2. Package.json probe
      if (probePackageJson(workspaceRoot, scanner)) {
        return {
          scanner,
          available: true,
          reason: `found in package.json dependencies`,
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

// Exported for testing
export { SCANNER_SIGNALS };
