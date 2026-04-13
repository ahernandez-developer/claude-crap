/**
 * Bootstrap a scanner for projects that don't have one configured.
 *
 * Detects the project type from workspace signals (package.json,
 * tsconfig.json, pyproject.toml, pom.xml, *.csproj, etc.), installs
 * the appropriate scanner, creates a minimal config file, and runs
 * `autoScan()` to verify and ingest findings immediately.
 *
 * Coverage maps to the five languages the tree-sitter engine supports:
 *
 *   - JavaScript / TypeScript → ESLint (npm install + flat config)
 *   - Python → Bandit (install instructions only — virtualenv boundary)
 *   - Java → Semgrep (install instructions)
 *   - C# → Semgrep (install instructions)
 *   - Unknown → Semgrep (polyglot fallback)
 *
 * For JS/TS projects the tool runs `npm install --save-dev` and writes
 * an `eslint.config.mjs`. For all other languages it returns manual
 * install instructions rather than executing package managers whose
 * environment assumptions may not hold.
 *
 * @module scanner/bootstrap
 */

import { existsSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import type { Logger } from "pino";
import type { KnownScanner } from "../adapters/common.js";
import { adaptScannerOutput } from "../adapters/index.js";
import { detectScanners } from "./detector.js";
import { runScanner } from "./runner.js";
import type { AutoScanResult, ScannerResult } from "./auto-scan.js";
import type { SarifStore } from "../sarif/sarif-store.js";

// ── Types ──────────────────────────────────────────────────────────

/**
 * Detected project type, aligned with tree-sitter supported languages.
 */
export type ProjectType =
  | "javascript"
  | "typescript"
  | "python"
  | "java"
  | "csharp"
  | "dart"
  | "unknown";

/**
 * A single step in the bootstrap process.
 */
export interface BootstrapStep {
  /** What was attempted (e.g. "install eslint", "create eslint.config.mjs"). */
  action: string;
  /** Whether the step completed successfully. */
  success: boolean;
  /** Human-readable detail (command output, error message, or instruction). */
  detail: string;
}

/**
 * Complete result of a bootstrap_scanner invocation.
 */
export interface BootstrapResult {
  /** Detected project type based on workspace signals. */
  projectType: ProjectType;
  /** Whether a scanner was already configured (detected by detector.ts). */
  alreadyConfigured: boolean;
  /** Which scanners were already available, if any. */
  existingScanners: string[];
  /** Steps executed (or instructions returned) during bootstrap. */
  steps: BootstrapStep[];
  /** The auto-scan result after installation (null if skipped). */
  autoScanResult: AutoScanResult | null;
  /** Whether the overall bootstrap succeeded. */
  success: boolean;
  /** Summary message suitable for display. */
  summary: string;
}

// ── Project type detection ─────────────────────────────────────────

/**
 * Detect the project type from workspace signals.
 *
 * Checks in priority order: TypeScript, JavaScript, Python, Java,
 * C#, then unknown. TypeScript wins over plain JavaScript because
 * `tsconfig.json` implies a superset.
 */
export function detectProjectType(workspaceRoot: string): ProjectType {
  const has = (file: string) => existsSync(join(workspaceRoot, file));

  // JS/TS detection — package.json is the anchor
  if (has("package.json")) {
    if (has("tsconfig.json")) return "typescript";
    return "javascript";
  }

  // Python detection
  if (has("pyproject.toml") || has("setup.py") || has("requirements.txt")) {
    return "python";
  }

  // Java detection
  if (has("pom.xml") || has("build.gradle") || has("build.gradle.kts")) {
    return "java";
  }

  // C# detection
  if (has("Directory.Build.props")) return "csharp";
  try {
    const entries = readdirSync(workspaceRoot);
    if (entries.some((e) => e.endsWith(".csproj") || e.endsWith(".sln"))) {
      return "csharp";
    }
  } catch {
    // readdirSync can fail on permissions — fall through
  }

  // Dart / Flutter detection
  if (has("pubspec.yaml")) return "dart";

  return "unknown";
}

// ── ESLint config generation ───────────────────────────────────────

/**
 * Generate a minimal ESLint flat config (ESLint 9+).
 *
 * @param isTypeScript Include typescript-eslint when true.
 * @returns The config file content as a string.
 */
export function generateEslintConfig(isTypeScript: boolean): string {
  if (isTypeScript) {
    return `import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: [
      "dist/",
      "node_modules/",
      "coverage/",
      "**/bundle/",
      "**/vendor/",
      "**/*.min.js",
    ],
  },
);
`;
  }

  return `import js from "@eslint/js";

export default [
  js.configs.recommended,
  {
    ignores: [
      "dist/",
      "node_modules/",
      "coverage/",
      "**/bundle/",
      "**/vendor/",
      "**/*.min.js",
    ],
  },
];
`;
}

// ── Installation helpers ───────────────────────────────────────────

/**
 * Run `npm install --save-dev` for the given packages.
 */
function npmInstall(
  workspaceRoot: string,
  packages: string[],
): Promise<BootstrapStep> {
  return new Promise((resolve) => {
    execFile(
      "npm",
      ["install", "--save-dev", ...packages],
      {
        cwd: workspaceRoot,
        timeout: 120_000,
        env: { ...process.env, FORCE_COLOR: "0" },
      },
      (err, stdout, stderr) => {
        if (err) {
          resolve({
            action: `npm install --save-dev ${packages.join(" ")}`,
            success: false,
            detail: stderr || (err as Error).message,
          });
          return;
        }
        resolve({
          action: `npm install --save-dev ${packages.join(" ")}`,
          success: true,
          detail: `installed ${packages.join(", ")}`,
        });
      },
    );
  });
}

/**
 * Write the ESLint config file to the workspace root.
 * Returns failure if the file already exists.
 */
function writeEslintConfigFile(
  workspaceRoot: string,
  isTypeScript: boolean,
): BootstrapStep {
  const configPath = join(workspaceRoot, "eslint.config.mjs");
  if (existsSync(configPath)) {
    return {
      action: "create eslint.config.mjs",
      success: true,
      detail: "eslint.config.mjs already exists — skipped",
    };
  }

  try {
    writeFileSync(configPath, generateEslintConfig(isTypeScript), "utf-8");
    return {
      action: "create eslint.config.mjs",
      success: true,
      detail: `created eslint.config.mjs (${isTypeScript ? "TypeScript" : "JavaScript"} template)`,
    };
  } catch (err) {
    return {
      action: "create eslint.config.mjs",
      success: false,
      detail: (err as Error).message,
    };
  }
}

// ── Scanner-to-language mapping ────────────────────────────────────

/**
 * Map project type → recommended scanner and install instructions.
 */
interface ScannerRecommendation {
  scanner: KnownScanner;
  canAutoInstall: boolean;
  installInstructions: string;
}

function getRecommendation(projectType: ProjectType): ScannerRecommendation {
  switch (projectType) {
    case "javascript":
    case "typescript":
      return {
        scanner: "eslint",
        canAutoInstall: true,
        installInstructions: "npm install --save-dev eslint @eslint/js",
      };
    case "python":
      return {
        scanner: "bandit",
        canAutoInstall: false,
        installInstructions:
          "pip install bandit  (or: pipx install bandit, poetry add --group dev bandit)",
      };
    case "java":
      return {
        scanner: "semgrep",
        canAutoInstall: false,
        installInstructions:
          "brew install semgrep  (or: pip install semgrep, pipx install semgrep)",
      };
    case "csharp":
      return {
        scanner: "dotnet_format",
        canAutoInstall: false,
        installInstructions:
          "Install the .NET SDK: https://dotnet.microsoft.com/download",
      };
    case "dart":
      return {
        scanner: "dart_analyze",
        canAutoInstall: false,
        installInstructions:
          "Install the Dart SDK: https://dart.dev/get-dart  (or Flutter SDK which includes Dart)",
      };
    case "unknown":
      return {
        scanner: "semgrep",
        canAutoInstall: false,
        installInstructions:
          "brew install semgrep  (or: pip install semgrep, pipx install semgrep)",
      };
  }
}

// ── Main orchestrator ──────────────────────────────────────────────

/**
 * Bootstrap a scanner for the current workspace.
 *
 * 1. Check if a scanner is already configured (short-circuit if so)
 * 2. Detect the project type
 * 3. Install the recommended scanner (or return instructions)
 * 4. Run auto_scan to verify and ingest findings
 *
 * @param workspaceRoot Absolute path to the project root.
 * @param sarifStore    Live SARIF store for auto-scan ingestion.
 * @param logger        Pino logger for progress reporting.
 */
export async function bootstrapScanner(
  workspaceRoot: string,
  sarifStore: SarifStore,
  logger: Logger,
): Promise<BootstrapResult> {
  // 1. Check existing scanners
  const detections = await detectScanners(workspaceRoot);
  const available = detections.filter((d) => d.available);

  // A scanner is truly "configured" only if it also has a config
  // file. ESLint in package.json without eslint.config.mjs will crash.
  const eslintNeedsConfig = available.some((d) => d.scanner === "eslint")
    && !detections.some((d) => d.scanner === "eslint" && d.configPath);

  if (available.length > 0 && !eslintNeedsConfig) {
    const existingScanners = available.map((d) => d.scanner);
    logger.info(
      { existingScanners },
      "bootstrap: scanner(s) already configured — skipping",
    );
    return {
      projectType: detectProjectType(workspaceRoot),
      alreadyConfigured: true,
      existingScanners,
      steps: [],
      autoScanResult: null,
      success: true,
      summary: `Scanner(s) already configured: ${existingScanners.join(", ")}. Run auto_scan to ingest findings.`,
    };
  }

  // 2. Detect project type
  const projectType = detectProjectType(workspaceRoot);
  const recommendation = getRecommendation(projectType);
  const steps: BootstrapStep[] = [];

  logger.info(
    { projectType, scanner: recommendation.scanner },
    "bootstrap: detected project type",
  );

  // 3. Install scanner (skip npm install if already in package.json)
  if (recommendation.canAutoInstall) {
    const isTypeScript = projectType === "typescript";
    const eslintAlreadyInstalled = available.some((d) => d.scanner === "eslint");

    if (!eslintAlreadyInstalled) {
      const packages = isTypeScript
        ? ["eslint", "@eslint/js", "typescript-eslint"]
        : ["eslint", "@eslint/js"];
      const installStep = await npmInstall(workspaceRoot, packages);
      steps.push(installStep);
      if (!installStep.success) {
        // npm install failed — skip config creation, fall through to result
        return buildResult(projectType, steps, null);
      }
    } else {
      steps.push({
        action: "npm install eslint",
        success: true,
        detail: "eslint already in package.json — skipped install",
      });
    }

    // Always create config if missing
    const configStep = writeEslintConfigFile(workspaceRoot, isTypeScript);
    steps.push(configStep);
  } else {
    // Python / Java / C# / Unknown: return instructions
    steps.push({
      action: `suggest ${recommendation.scanner} install`,
      success: true,
      detail: recommendation.installInstructions,
    });
  }

  // 4. Run scanner directly if installation succeeded (inline scan
  //    to avoid circular dependency — autoScan calls bootstrapScanner)
  const installSucceeded = steps.every((s) => s.success);
  let autoScanResult: AutoScanResult | null = null;

  if (installSucceeded && recommendation.canAutoInstall) {
    try {
      const scanStart = Date.now();
      const postDetections = await detectScanners(workspaceRoot);
      const postAvailable = postDetections.filter((d) => d.available);
      const scanResults: ScannerResult[] = [];
      let scanFindings = 0;

      const settled = await Promise.allSettled(
        postAvailable.map((d) => runScanner(d.scanner, workspaceRoot)),
      );

      for (let i = 0; i < postAvailable.length; i++) {
        const det = postAvailable[i]!;
        const res = settled[i]!;

        if (res.status === "rejected" || !res.value.success) {
          scanResults.push({
            scanner: det.scanner,
            success: false,
            findingsIngested: 0,
            durationMs: res.status === "fulfilled" ? res.value.durationMs : 0,
            error: res.status === "rejected"
              ? String(res.reason)
              : res.value.error ?? "unknown error",
          });
          continue;
        }

        const runResult = res.value;
        let parsed: unknown;
        try { parsed = JSON.parse(runResult.rawOutput); } catch { parsed = runResult.rawOutput; }
        const adapted = adaptScannerOutput(runResult.scanner, parsed);
        const stats = sarifStore.ingestRun(adapted.document, adapted.sourceTool);
        scanFindings += stats.accepted;

        scanResults.push({
          scanner: runResult.scanner,
          success: true,
          findingsIngested: stats.accepted,
          durationMs: runResult.durationMs,
        });
      }

      if (scanFindings > 0) await sarifStore.persist();

      autoScanResult = {
        detected: postDetections,
        results: scanResults,
        totalFindings: scanFindings,
        totalDurationMs: Date.now() - scanStart,
      };
    } catch (err) {
      logger.warn(
        { err: (err as Error).message },
        "bootstrap: scan after install failed",
      );
    }
  }

  // 5. Build result
  return buildResult(projectType, steps, autoScanResult, recommendation);
}

/**
 * Build a BootstrapResult from the collected steps and optional scan result.
 */
function buildResult(
  projectType: ProjectType,
  steps: BootstrapStep[],
  autoScanResult: AutoScanResult | null,
  recommendation?: { scanner: KnownScanner; canAutoInstall: boolean; installInstructions: string },
): BootstrapResult {
  const success = steps.every((s) => s.success);
  const findings = autoScanResult?.totalFindings ?? 0;
  const scanner = recommendation?.scanner ?? "unknown";

  let summary: string;
  if (success && autoScanResult) {
    summary = `Configured ${scanner} for ${projectType} project. Scan found ${findings} finding(s).`;
  } else if (success && recommendation && !recommendation.canAutoInstall) {
    summary = `Detected ${projectType} project. Install ${scanner} manually: ${recommendation.installInstructions}`;
  } else if (success) {
    summary = `Configured ${scanner} for ${projectType} project.`;
  } else {
    summary = `Failed to configure ${scanner}. Check the error details in the steps.`;
  }

  return {
    projectType,
    alreadyConfigured: false,
    existingScanners: [],
    steps,
    autoScanResult,
    success,
    summary,
  };
}
