/**
 * Execute a single scanner CLI and capture its raw output.
 *
 * Each scanner has a fixed invocation that produces the format its
 * adapter expects:
 *
 *   - ESLint  → `npx eslint -f json .`  (JSON array)
 *   - Semgrep → `semgrep --sarif --quiet .` (SARIF 2.1.0)
 *   - Bandit  → `bandit -f json -r . -q` (JSON object)
 *   - Stryker → `npx stryker run` then read `reports/mutation/mutation.json`
 *
 * ESLint and Bandit exit non-zero when findings exist — that is
 * expected, not an error. The runner captures stdout regardless of
 * exit code for those scanners.
 *
 * Stryker is special: it writes to a file instead of stdout, so we
 * read the output file after the process exits.
 *
 * @module scanner/runner
 */

import { execFile } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { KnownScanner } from "../adapters/common.js";

// ── Types ──────────────────────────────────────────────────────────

/**
 * Result of executing a single scanner.
 */
export interface ScannerRunResult {
  /** Which scanner was executed. */
  scanner: KnownScanner;
  /** Whether execution completed and produced parseable output. */
  success: boolean;
  /** The scanner's raw output (stdout or file contents). */
  rawOutput: string;
  /** Error message when `success` is false. */
  error?: string;
  /** Wall-clock execution time in milliseconds. */
  durationMs: number;
}

// ── Scanner command definitions ────────────────────────────────────

interface ScannerCommand {
  /** Binary or npx command. */
  command: string;
  /** CLI arguments. */
  args: string[];
  /** Maximum execution time in ms. */
  timeoutMs: number;
  /** If true, non-zero exit is expected when findings exist. */
  nonZeroIsNormal: boolean;
  /** If set, read output from this file instead of stdout. */
  outputFile?: string;
}

function getScannerCommand(
  scanner: KnownScanner,
  workspaceRoot: string,
): ScannerCommand {
  switch (scanner) {
    case "eslint":
      return {
        command: "npx",
        args: ["eslint", "-f", "json", "."],
        timeoutMs: 120_000,
        nonZeroIsNormal: true,
      };
    case "semgrep":
      return {
        command: "semgrep",
        args: ["--sarif", "--quiet", "."],
        timeoutMs: 120_000,
        nonZeroIsNormal: false,
      };
    case "bandit":
      return {
        command: "bandit",
        args: ["-f", "json", "-r", ".", "-q"],
        timeoutMs: 120_000,
        nonZeroIsNormal: true,
      };
    case "stryker":
      return {
        command: "npx",
        args: ["stryker", "run"],
        timeoutMs: 300_000,
        nonZeroIsNormal: false,
        outputFile: join(workspaceRoot, "reports", "mutation", "mutation.json"),
      };
    case "dart_analyze":
      return {
        command: "dart",
        args: ["analyze", "--format=json", "."],
        timeoutMs: 120_000,
        nonZeroIsNormal: true, // exits 3 when findings exist
      };
    case "dotnet_format":
      return {
        command: "dotnet",
        args: [
          "format",
          "--verify-no-changes",
          "--report",
          join(workspaceRoot, ".claude-crap", "dotnet-report.json"),
        ],
        timeoutMs: 120_000,
        nonZeroIsNormal: true,
        outputFile: join(workspaceRoot, ".claude-crap", "dotnet-report.json"),
      };
  }
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Execute a scanner CLI and return its raw output.
 *
 * @param scanner       Which scanner to run.
 * @param workspaceRoot Absolute path to the project root (used as cwd).
 * @param options       Optional overrides.
 * @returns             A {@link ScannerRunResult} with stdout or file output.
 */
export function runScanner(
  scanner: KnownScanner,
  workspaceRoot: string,
  options?: { workingDir?: string },
): Promise<ScannerRunResult> {
  const start = Date.now();
  const cwd = options?.workingDir ?? workspaceRoot;
  const cmd = getScannerCommand(scanner, cwd);

  return new Promise((resolve) => {
    execFile(
      cmd.command,
      cmd.args,
      {
        cwd,
        timeout: cmd.timeoutMs,
        maxBuffer: 50 * 1024 * 1024, // 50 MB — large codebases produce verbose output
        env: { ...process.env, FORCE_COLOR: "0" }, // suppress ANSI in output
      },
      (err, stdout, stderr) => {
        const durationMs = Date.now() - start;

        // For scanners where non-zero exit means "findings exist",
        // we still have valid output in stdout. But if the scanner
        // crashed (e.g. ESLint with no config file), treat it as a
        // real failure even when nonZeroIsNormal is set.
        const isFatalError = cmd.nonZeroIsNormal
          && err
          && (!stdout?.trim() || stderr?.includes("Oops!") || stderr?.includes("couldn't find"));

        if (err && (!cmd.nonZeroIsNormal || isFatalError)) {
          // Stryker: check if the output file was written despite the error
          if (cmd.outputFile && existsSync(cmd.outputFile)) {
            try {
              const fileOutput = readFileSync(cmd.outputFile, "utf-8");
              resolve({
                scanner,
                success: true,
                rawOutput: fileOutput,
                durationMs,
              });
              return;
            } catch {
              // Fall through to error path
            }
          }

          resolve({
            scanner,
            success: false,
            rawOutput: "",
            error: stderr || (err as Error).message,
            durationMs,
          });
          return;
        }

        // For file-based output (Stryker), read from file
        if (cmd.outputFile) {
          if (existsSync(cmd.outputFile)) {
            try {
              const fileOutput = readFileSync(cmd.outputFile, "utf-8");
              resolve({
                scanner,
                success: true,
                rawOutput: fileOutput,
                durationMs,
              });
              return;
            } catch (readErr) {
              resolve({
                scanner,
                success: false,
                rawOutput: "",
                error: `Failed to read output file: ${(readErr as Error).message}`,
                durationMs,
              });
              return;
            }
          }
          resolve({
            scanner,
            success: false,
            rawOutput: "",
            error: `Scanner completed but output file not found: ${cmd.outputFile}`,
            durationMs,
          });
          return;
        }

        // Stdout-based output
        const output = stdout.trim();
        if (!output) {
          resolve({
            scanner,
            success: true,
            rawOutput: "[]", // ESLint returns empty when no files match
            durationMs,
          });
          return;
        }

        resolve({
          scanner,
          success: true,
          rawOutput: output,
          durationMs,
        });
      },
    );
  });
}

// Exported for testing
export { getScannerCommand, type ScannerCommand };
