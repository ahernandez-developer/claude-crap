/**
 * File detail builder for the dashboard.
 *
 * Given a workspace-relative file path, this module produces a rich
 * detail payload combining source code, per-function AST metrics, and
 * SARIF findings filtered to that file. The dashboard uses this to
 * render a ReportGenerator-style annotated code view.
 *
 * The builder is extracted into its own module (rather than inlined in
 * `server.ts`) so that:
 *   - The logic is unit-testable without booting the HTTP server.
 *   - The types are importable by both the Fastify route and tests.
 *
 * @module dashboard/file-detail
 */

import { promises as fs } from "node:fs";
import { resolveWithinWorkspace } from "../workspace-guard.js";
import { detectLanguageFromPath, type SupportedLanguage } from "../ast/language-config.js";
import type { TreeSitterEngine, FunctionMetrics } from "../ast/tree-sitter-engine.js";
import type { SarifStore, IngestedFinding } from "../sarif/sarif-store.js";

// ── Types ─────────────────────────────────────────────────────────

/** Per-function entry in the detail response. */
export interface FileDetailFunction {
  readonly name: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly cyclomaticComplexity: number;
  readonly lineCount: number;
}

/** Per-finding entry in the detail response. */
export interface FileDetailFinding {
  readonly ruleId: string;
  readonly level: string;
  readonly message: string;
  readonly sourceTool: string;
  readonly startLine: number;
  readonly startColumn: number;
  readonly endLine: number;
  readonly endColumn: number;
  readonly effortMinutes: number;
}

/** Summary statistics for the file. */
export interface FileDetailSummary {
  readonly totalFindings: number;
  readonly errorCount: number;
  readonly warningCount: number;
  readonly noteCount: number;
  readonly totalEffortMinutes: number;
  readonly avgComplexity: number;
  readonly maxComplexity: number;
}

/** Full response payload for the file detail endpoint. */
export interface FileDetailResponse {
  readonly filePath: string;
  readonly language: SupportedLanguage | null;
  readonly physicalLoc: number;
  readonly logicalLoc: number;
  readonly cyclomaticMax: number;
  readonly sourceLines: string[];
  readonly functions: FileDetailFunction[];
  readonly findings: FileDetailFinding[];
  readonly summary: FileDetailSummary;
}

/** Input accepted by {@link buildFileDetail}. */
export interface BuildFileDetailInput {
  readonly relativePath: string;
  readonly workspaceRoot: string;
  readonly astEngine?: TreeSitterEngine | undefined;
  readonly sarifStore: SarifStore;
  readonly cyclomaticMax: number;
}

// ── Builder ───────────────────────────────────────────────────────

/**
 * Build the file detail payload. Pure function aside from the file
 * read and the tree-sitter analysis (both deterministic for a given
 * file).
 *
 * @throws When the file does not exist or the path escapes the workspace.
 */
export async function buildFileDetail(
  input: BuildFileDetailInput,
): Promise<FileDetailResponse> {
  const { relativePath, workspaceRoot, astEngine, sarifStore, cyclomaticMax } = input;

  // 1. Guard against path traversal
  const absolutePath = resolveWithinWorkspace(workspaceRoot, relativePath);

  // 2. Read source
  const source = await fs.readFile(absolutePath, "utf8");
  const sourceLines = source.split(/\r?\n/);
  // Remove trailing empty line from files ending with \n
  if (sourceLines.length > 0 && sourceLines[sourceLines.length - 1] === "") {
    sourceLines.pop();
  }

  const physicalLoc = sourceLines.length;
  let logicalLoc = 0;
  for (const line of sourceLines) {
    if (line.trim().length > 0) logicalLoc += 1;
  }

  // 3. AST analysis (if language is supported)
  const language = detectLanguageFromPath(relativePath);
  let functions: FileDetailFunction[] = [];

  if (language && astEngine) {
    try {
      const metrics = await astEngine.analyzeFile({
        filePath: absolutePath,
        language,
      });
      functions = metrics.functions.map((fn: FunctionMetrics) => ({
        name: fn.name,
        startLine: fn.startLine,
        endLine: fn.endLine,
        cyclomaticComplexity: fn.cyclomaticComplexity,
        lineCount: fn.lineCount,
      }));
    } catch {
      // Analysis failure is non-fatal — return empty functions
    }
  }

  // 4. Filter SARIF findings for this file
  const allFindings = sarifStore.list();
  const fileFindings = allFindings.filter(
    (f: IngestedFinding) => f.location.uri === relativePath,
  );

  const findings: FileDetailFinding[] = fileFindings.map((f: IngestedFinding) => ({
    ruleId: f.ruleId,
    level: f.level,
    message: f.message,
    sourceTool: f.sourceTool,
    startLine: f.location.startLine,
    startColumn: f.location.startColumn,
    endLine: f.location.endLine ?? f.location.startLine,
    endColumn: f.location.endColumn ?? 0,
    effortMinutes:
      typeof f.properties?.effortMinutes === "number"
        ? f.properties.effortMinutes
        : 0,
  }));

  // 5. Build summary
  let errorCount = 0;
  let warningCount = 0;
  let noteCount = 0;
  let totalEffortMinutes = 0;

  for (const f of findings) {
    if (f.level === "error") errorCount += 1;
    else if (f.level === "warning") warningCount += 1;
    else if (f.level === "note") noteCount += 1;
    totalEffortMinutes += f.effortMinutes;
  }

  const complexities = functions.map((f) => f.cyclomaticComplexity);
  const maxComplexity = complexities.length > 0 ? Math.max(...complexities) : 0;
  const avgComplexity =
    complexities.length > 0
      ? Math.round(
          (complexities.reduce((a, b) => a + b, 0) / complexities.length) * 100,
        ) / 100
      : 0;

  return {
    filePath: relativePath,
    language,
    physicalLoc,
    logicalLoc,
    cyclomaticMax,
    sourceLines,
    functions,
    findings,
    summary: {
      totalFindings: findings.length,
      errorCount,
      warningCount,
      noteCount,
      totalEffortMinutes,
      avgComplexity,
      maxComplexity,
    },
  };
}
