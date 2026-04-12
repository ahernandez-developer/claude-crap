#!/usr/bin/env node
/**
 * claude-crap MCP server — entrypoint.
 *
 * Transport: stdio. The server is launched by `.mcp.json` with the
 * arguments `--transport stdio` and it never opens sockets or listens
 * on the network: all communication with Claude Code happens over
 * stdin/stdout as JSON-RPC messages.
 *
 * What this file wires together:
 *
 *   Tools:
 *     - compute_crap            (CRAP index for one function)
 *     - compute_tdr             (Technical Debt Ratio for a scope)
 *     - analyze_file_ast        (tree-sitter AST metrics for a source file)
 *     - ingest_sarif            (normalize + dedupe an external SARIF report)
 *     - ingest_scanner_output   (route Semgrep/ESLint/Bandit/Stryker native output through an adapter and persist the normalized SARIF)
 *     - require_test_harness    (check that a production source file has a matching test)
 *     - score_project           (aggregate the workspace into Maintainability / Reliability / Security / Overall ratings)
 *
 *   Resources:
 *     - sonar://metrics/current       (live CRAP / TDR / rating snapshot)
 *     - sonar://reports/latest.sarif  (last consolidated SARIF document)
 *
 * The handlers delegate to pure engines in `./metrics`, `./ast` and
 * `./sarif`, so the index file stays focused on routing and
 * cross-cutting concerns (configuration, logging, error boundaries).
 *
 * @module index
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import pino from "pino";

import { adaptScannerOutput, type KnownScanner } from "./adapters/index.js";
import { TreeSitterEngine } from "./ast/tree-sitter-engine.js";
import type { SupportedLanguage } from "./ast/language-config.js";
import { loadConfig, type CrapConfig } from "./config.js";
import { startDashboard, type DashboardHandle } from "./dashboard/server.js";
import { computeCrap } from "./metrics/crap.js";
import {
  computeProjectScore,
  renderProjectScoreMarkdown,
  type ProjectScore,
} from "./metrics/score.js";
import { computeTdr, classifyTdr } from "./metrics/tdr.js";
import { estimateWorkspaceLoc } from "./metrics/workspace-walker.js";
import { SarifStore, type PersistedSarif } from "./sarif/sarif-store.js";
import { validateSarifDocument } from "./sarif/sarif-validator.js";
import { loadCrapConfig, CrapConfigError } from "./crap-config.js";
import { findTestFile } from "./tools/test-harness.js";
import { resolveWithinWorkspace } from "./workspace-guard.js";
import { autoScan } from "./scanner/auto-scan.js";
import { bootstrapScanner } from "./scanner/bootstrap.js";
import {
  autoScanSchema,
  bootstrapScannerSchema,
  computeCrapSchema,
  computeTdrSchema,
  analyzeFileAstSchema,
  ingestSarifSchema,
  ingestScannerOutputSchema,
  requireTestHarnessSchema,
  scoreProjectSchema,
} from "./schemas/tool-schemas.js";

// IMPORTANT: the MCP stdio transport uses stdout for JSON-RPC framing.
// Anything the server logs MUST go to stderr (fd 2) to avoid corrupting
// the wire format. We configure pino explicitly to write to fd 2.
const logger = pino(
  { level: process.env.CLAUDE_CRAP_LOG_LEVEL ?? "info" },
  pino.destination(2),
);

/**
 * Server bootstrap. Loads configuration, instantiates the long-lived
 * engines (tree-sitter, SARIF store), registers tool and resource
 * handlers, and connects the stdio transport. Exits with a non-zero code
 * on fatal startup errors so that Claude Code surfaces the failure to
 * the user instead of silently running without the plugin.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  logger.info(
    { config: { ...config, pluginRoot: "<redacted>" } },
    "claude-crap MCP server starting",
  );

  // Long-lived engines. Created once at boot and reused for every call.
  const astEngine = new TreeSitterEngine();
  const sarifStore = new SarifStore({
    workspaceRoot: config.pluginRoot,
    outputDir: config.sarifOutputDir,
  });
  await sarifStore.loadLatest();
  logger.info(
    { findings: sarifStore.size(), path: sarifStore.consolidatedReportPath },
    "SARIF store ready",
  );

  // Try to start the local Vue.js dashboard. Failures here are
  // intentionally non-fatal — the MCP server still works without it.
  let dashboard: DashboardHandle | null = null;
  try {
    dashboard = await startDashboard({
      config,
      sarifStore,
      workspaceStatsProvider: () => estimateWorkspaceLoc(config.pluginRoot),
      logger,
    });
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, port: config.dashboardPort },
      "claude-crap dashboard failed to start — continuing without it",
    );
  }
  // Make sure the dashboard is closed when the process exits so the TCP
  // port is freed promptly. SIGINT/SIGTERM may arrive from Claude Code's
  // MCP supervisor, from a developer hitting Ctrl-C, or from the test
  // harness in our integration suite.
  //
  // IMPORTANT: installing a custom signal handler overrides Node's
  // default (which exits the process), so we have to call
  // `process.exit()` ourselves once cleanup finishes. Without this the
  // MCP stdio transport would keep reading stdin forever and the
  // Fastify dashboard would keep its listener open, leaving the whole
  // process alive even after SIGTERM.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void (async () => {
        try {
          await dashboard?.close();
        } catch {
          /* best effort — dashboard may already be down */
        }
        // 130 is the conventional exit code for SIGINT, 143 for SIGTERM.
        const exitCode = signal === "SIGINT" ? 130 : 143;
        process.exit(exitCode);
      })();
    });
  }

  const server = new Server(
    {
      name: "claude-crap",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
    },
  );

  // ------------------------------------------------------------------
  // Tools — declaration (list)
  // ------------------------------------------------------------------
  // The tool list is what the LLM sees when it introspects the server.
  // Keep the descriptions short, imperative and fact-based.
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "compute_crap",
        description:
          "Compute the CRAP (Change Risk Anti-Patterns) index for a function and block when the score exceeds the configured threshold.",
        inputSchema: computeCrapSchema,
      },
      {
        name: "compute_tdr",
        description:
          "Compute the Technical Debt Ratio for a scope and return the maintainability rating (A..E).",
        inputSchema: computeTdrSchema,
      },
      {
        name: "analyze_file_ast",
        description:
          "Analyze a source file with tree-sitter and return deterministic metrics (LOC, cyclomatic complexity, function topology).",
        inputSchema: analyzeFileAstSchema,
      },
      {
        name: "ingest_sarif",
        description:
          "Ingest a raw SARIF 2.1.0 report from an external scanner (Semgrep, ESLint, Bandit, ...), deduplicate it, and persist the consolidated view.",
        inputSchema: ingestSarifSchema,
      },
      {
        name: "ingest_scanner_output",
        description:
          "Ingest a scanner's native output (Semgrep, ESLint, Bandit, Stryker), route it through the matching adapter, enrich each finding with an effort estimate, and persist the normalized SARIF report.",
        inputSchema: ingestScannerOutputSchema,
      },
      {
        name: "require_test_harness",
        description:
          "Check whether a production source file has an accompanying test file. Required by the Golden Rule before any functional code is written.",
        inputSchema: requireTestHarnessSchema,
      },
      {
        name: "score_project",
        description:
          "Aggregate the project score across Maintainability, Reliability, Security and Overall, returning a chat-friendly Markdown summary, the structured JSON, the local dashboard URL, and the consolidated SARIF report path.",
        inputSchema: scoreProjectSchema,
      },
      {
        name: "auto_scan",
        description:
          "Auto-detect available scanners (ESLint, Semgrep, Bandit, Stryker) in the workspace, run them, and ingest findings into the SARIF store.",
        inputSchema: autoScanSchema,
      },
      {
        name: "bootstrap_scanner",
        description:
          "Detect project type, install the right scanner (ESLint for JS/TS, Bandit for Python, Semgrep for Java/C#), create minimal config, and run auto_scan to verify.",
        inputSchema: bootstrapScannerSchema,
      },
    ],
  }));

  // ------------------------------------------------------------------
  // Tools — call dispatch
  // ------------------------------------------------------------------
  // The MCP SDK has already validated `args` against the tool's JSON
  // Schema by the time this handler runs, so we cast to the expected
  // shape without re-validating. Each branch delegates to a pure engine.
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    logger.info({ tool: name }, "Tool call received");

    switch (name) {
      case "compute_crap": {
        const typed = args as {
          cyclomaticComplexity: number;
          coveragePercent: number;
          functionName: string;
          filePath: string;
        };
        const result = computeCrap(
          { cyclomaticComplexity: typed.cyclomaticComplexity, coveragePercent: typed.coveragePercent },
          config.crapThreshold,
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { tool: "compute_crap", function: typed.functionName, file: typed.filePath, ...result },
                null,
                2,
              ),
            },
          ],
          // Setting isError=true tells the LLM this call should be treated
          // as a failure, which pushes it toward corrective action rather
          // than assuming the score was acceptable.
          isError: result.exceedsThreshold,
        };
      }

      case "compute_tdr": {
        const typed = args as {
          remediationMinutes: number;
          totalLinesOfCode: number;
          scope: "project" | "module" | "file";
        };
        const result = computeTdr({
          remediationMinutes: typed.remediationMinutes,
          totalLinesOfCode: typed.totalLinesOfCode,
          minutesPerLoc: config.minutesPerLoc,
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ tool: "compute_tdr", scope: typed.scope, ...result }, null, 2),
            },
          ],
        };
      }

      case "analyze_file_ast": {
        const typed = args as { filePath: string; language: SupportedLanguage };
        const absolutePath = resolveWithinWorkspace(config.pluginRoot, typed.filePath);
        try {
          const metrics = await astEngine.analyzeFile({
            filePath: absolutePath,
            language: typed.language,
          });
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ tool: "analyze_file_ast", ...metrics }, null, 2),
              },
            ],
          };
        } catch (err) {
          logger.error(
            { err, filePath: absolutePath, language: typed.language },
            "analyze_file_ast failed",
          );
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    tool: "analyze_file_ast",
                    status: "error",
                    message: (err as Error).message,
                    filePath: typed.filePath,
                    language: typed.language,
                  },
                  null,
                  2,
                ),
              },
            ],
            isError: true,
          };
        }
      }

      case "score_project": {
        const typed = (args ?? {}) as { format?: "markdown" | "json" | "both" };
        const format = typed.format ?? "both";
        try {
          const workspace = await estimateWorkspaceLoc(config.pluginRoot);
          const score: ProjectScore = computeProjectScore({
            workspaceRoot: config.pluginRoot,
            minutesPerLoc: config.minutesPerLoc,
            tdrMaxRating: config.tdrMaxRating,
            workspace: { physicalLoc: workspace.physicalLoc, fileCount: workspace.fileCount },
            sarifStore,
            dashboardUrl: dashboard?.url ?? null,
            sarifReportPath: sarifStore.consolidatedReportPath,
          });

          const blocks: Array<{ type: "text"; text: string }> = [];
          if (format === "markdown" || format === "both") {
            blocks.push({ type: "text", text: renderProjectScoreMarkdown(score) });
          }
          if (format === "json" || format === "both") {
            blocks.push({ type: "text", text: JSON.stringify(score, null, 2) });
          }

          // Respect the workspace strictness setting: only `strict`
          // mode should flag a failing project as an MCP tool error
          // and push the agent toward remediation. In `warn` and
          // `advisory` modes the Stop hook lets the task close, so
          // `score_project` must stay consistent and return the
          // score as plain content.
          const strictness = safeLoadStrictness(config.pluginRoot, logger);
          const shouldFlagError = strictness === "strict" && !score.overall.passes;

          return {
            content: blocks,
            isError: shouldFlagError,
          };
        } catch (err) {
          logger.error({ err }, "score_project failed");
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  { tool: "score_project", status: "error", message: (err as Error).message },
                  null,
                  2,
                ),
              },
            ],
            isError: true,
          };
        }
      }

      case "require_test_harness": {
        const typed = args as { filePath: string };
        const absolutePath = resolveWithinWorkspace(config.pluginRoot, typed.filePath);
        try {
          const resolution = await findTestFile(config.pluginRoot, absolutePath);
          const hasTest = resolution.testFile !== null;
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    tool: "require_test_harness",
                    filePath: typed.filePath,
                    hasTest,
                    isTestFile: resolution.isTestFile,
                    testFile: resolution.testFile,
                    candidates: resolution.candidates,
                    ...(hasTest
                      ? {}
                      : {
                          corrective:
                            "No test file found. Per the CLAUDE.md Golden Rule, create a characterization " +
                            "test at one of the candidate paths before writing any functional code for this file.",
                        }),
                  },
                  null,
                  2,
                ),
              },
            ],
            // The Golden Rule says "no code without a test", so the absence
            // of a test is a blocking condition. Surface it as an error.
            isError: !hasTest,
          };
        } catch (err) {
          logger.error({ err, filePath: absolutePath }, "require_test_harness failed");
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    tool: "require_test_harness",
                    status: "error",
                    message: (err as Error).message,
                    filePath: typed.filePath,
                  },
                  null,
                  2,
                ),
              },
            ],
            isError: true,
          };
        }
      }

      case "ingest_scanner_output": {
        const typed = args as { scanner: KnownScanner; rawOutput: unknown };
        try {
          const adapted = adaptScannerOutput(typed.scanner, typed.rawOutput);
          // F-A05-01: validate the adapter's output against the same
          // schema used by `ingest_sarif`. Adapters are internal and
          // should already emit conformant documents, but this catches
          // regressions before they reach the store or the dashboard.
          validateSarifDocument(adapted.document);
          const stats = sarifStore.ingestRun(adapted.document, adapted.sourceTool);
          await sarifStore.persist();
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    tool: "ingest_scanner_output",
                    status: "accepted",
                    scanner: typed.scanner,
                    findingsParsed: adapted.findingCount,
                    totalEffortMinutes: adapted.totalEffortMinutes,
                    accepted: stats.accepted,
                    duplicates: stats.duplicates,
                    total: stats.total,
                    storeSize: sarifStore.size(),
                    reportPath: sarifStore.consolidatedReportPath,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        } catch (err) {
          logger.error({ err, scanner: typed.scanner }, "ingest_scanner_output failed");
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    tool: "ingest_scanner_output",
                    status: "error",
                    scanner: typed.scanner,
                    message: (err as Error).message,
                  },
                  null,
                  2,
                ),
              },
            ],
            isError: true,
          };
        }
      }

      case "ingest_sarif": {
        const typed = args as { sarifDocument: PersistedSarif; sourceTool: string };
        try {
          // F-A05-01: validate the caller-supplied document against a
          // minimal SARIF 2.1.0 schema BEFORE touching the store. The
          // MCP SDK already validated the outer tool-call shape, but
          // the inner `sarifDocument` is declared as `type: "object"`
          // in tool-schemas.ts and would otherwise flow through
          // un-checked.
          validateSarifDocument(typed.sarifDocument);
          const stats = sarifStore.ingestRun(typed.sarifDocument, typed.sourceTool);
          await sarifStore.persist();
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    tool: "ingest_sarif",
                    status: "accepted",
                    sourceTool: typed.sourceTool,
                    accepted: stats.accepted,
                    duplicates: stats.duplicates,
                    total: stats.total,
                    storeSize: sarifStore.size(),
                    reportPath: sarifStore.consolidatedReportPath,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        } catch (err) {
          logger.error({ err, sourceTool: typed.sourceTool }, "ingest_sarif failed");
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  { tool: "ingest_sarif", status: "error", message: (err as Error).message },
                  null,
                  2,
                ),
              },
            ],
            isError: true,
          };
        }
      }

      case "bootstrap_scanner": {
        logger.info({ tool: "bootstrap_scanner" }, "Tool call received");
        try {
          const result = await bootstrapScanner(config.pluginRoot, sarifStore, logger);
          const markdown = renderBootstrapMarkdown(result);
          return {
            content: [
              { type: "text", text: markdown },
              { type: "text", text: JSON.stringify(result, null, 2) },
            ],
            isError: !result.success,
          };
        } catch (err) {
          logger.error({ err }, "bootstrap_scanner failed");
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  { tool: "bootstrap_scanner", status: "error", message: (err as Error).message },
                  null,
                  2,
                ),
              },
            ],
            isError: true,
          };
        }
      }

      case "auto_scan": {
        logger.info({ tool: "auto_scan" }, "Tool call received");
        try {
          const result = await autoScan(config.pluginRoot, sarifStore, logger);
          const markdown = renderAutoScanMarkdown(result);
          return {
            content: [
              { type: "text", text: markdown },
              { type: "text", text: JSON.stringify(result, null, 2) },
            ],
          };
        } catch (err) {
          logger.error({ err }, "auto_scan failed");
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  { tool: "auto_scan", status: "error", message: (err as Error).message },
                  null,
                  2,
                ),
              },
            ],
            isError: true,
          };
        }
      }

      default:
        throw new Error(`[claude-crap] Unknown tool: ${name}`);
    }
  });

  // ------------------------------------------------------------------
  // Resources — topology and reports
  // ------------------------------------------------------------------
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        uri: "sonar://metrics/current",
        name: "Current project metrics",
        mimeType: "application/json",
        description: "Snapshot of CRAP, TDR, and Reliability / Security ratings.",
      },
      {
        uri: "sonar://reports/latest.sarif",
        name: "Latest consolidated SARIF 2.1.0 report",
        mimeType: "application/sarif+json",
        description: "Unified SARIF document produced by the most recent Stop quality-gate run.",
      },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;
    if (uri === "sonar://reports/latest.sarif") {
      const doc = sarifStore.toSarifDocument();
      return {
        contents: [
          {
            uri,
            mimeType: "application/sarif+json",
            text: JSON.stringify(doc, null, 2),
          },
        ],
      };
    }
    if (uri === "sonar://metrics/current") {
      const snapshot = await buildMetricsSnapshot(config, sarifStore);
      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(snapshot, null, 2),
          },
        ],
      };
    }
    throw new Error(`[claude-crap] Unknown resource URI: ${uri}`);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("claude-crap MCP server ready (stdio)");

  // Fire-and-forget: auto-scan runs in background, doesn't block tool calls.
  // If the agent calls score_project before scanning finishes, it gets
  // whatever is in the SARIF store so far. The next call after completion
  // reflects all findings.
  autoScan(config.pluginRoot, sarifStore, logger)
    .then((result) => {
      const scanners = result.results
        .filter((r) => r.success)
        .map((r) => r.scanner);
      logger.info(
        {
          scannersRun: scanners,
          totalFindings: result.totalFindings,
          durationMs: result.totalDurationMs,
        },
        "auto-scan completed",
      );
    })
    .catch((err) => {
      logger.warn(
        { err: (err as Error).message },
        "auto-scan failed — continuing without it",
      );
    });
}

/**
 * Render a human-readable Markdown summary of a bootstrap result.
 */
function renderBootstrapMarkdown(result: import("./scanner/bootstrap.js").BootstrapResult): string {
  const lines: string[] = ["## claude-crap :: bootstrap scanner\n"];

  lines.push(`**Project type:** ${result.projectType}`);

  if (result.alreadyConfigured) {
    lines.push(`**Status:** Scanner(s) already configured: ${result.existingScanners.join(", ")}`);
    lines.push("\nNo installation needed. Run `auto_scan` to ingest findings.");
    return lines.join("\n");
  }

  lines.push("");

  if (result.steps.length > 0) {
    lines.push("### Steps\n");
    lines.push("| Action | Status | Detail |");
    lines.push("| ------ | :----: | ------ |");
    for (const s of result.steps) {
      const status = s.success ? "ok" : "failed";
      lines.push(`| ${s.action} | ${status} | ${s.detail} |`);
    }
    lines.push("");
  }

  if (result.autoScanResult) {
    const r = result.autoScanResult;
    const scanners = r.results.filter((s) => s.success).map((s) => s.scanner);
    lines.push(
      `**Auto-scan:** ${r.totalFindings} finding(s) ingested from ${scanners.join(", ") || "no scanners"} in ${(r.totalDurationMs / 1000).toFixed(1)}s`,
    );
    lines.push("");
  }

  lines.push(`**Summary:** ${result.summary}`);
  return lines.join("\n");
}

/**
 * Render a human-readable Markdown summary of an auto-scan result.
 */
function renderAutoScanMarkdown(result: import("./scanner/auto-scan.js").AutoScanResult): string {
  const lines: string[] = ["## claude-crap :: auto-scan results\n"];

  // Detection summary
  lines.push("### Detected scanners\n");
  lines.push("| Scanner | Available | Reason |");
  lines.push("| ------- | :-------: | ------ |");
  for (const d of result.detected) {
    lines.push(`| ${d.scanner} | ${d.available ? "yes" : "no"} | ${d.reason} |`);
  }
  lines.push("");

  // Execution results
  if (result.results.length > 0) {
    lines.push("### Execution results\n");
    lines.push("| Scanner | Status | Findings | Duration |");
    lines.push("| ------- | :----: | :------: | -------: |");
    for (const r of result.results) {
      const status = r.success ? "ok" : "failed";
      const duration = `${(r.durationMs / 1000).toFixed(1)}s`;
      lines.push(`| ${r.scanner} | ${status} | ${r.findingsIngested} | ${duration} |`);
    }
    lines.push("");
  }

  // Summary
  lines.push(
    `**Total findings ingested:** ${result.totalFindings} in ${(result.totalDurationMs / 1000).toFixed(1)}s`,
  );

  return lines.join("\n");
}

/**
 * Load the workspace strictness without letting a busted config
 * file take down the `score_project` tool. On any loader error we
 * log to stderr via pino and fall back to `"strict"` so the tool
 * stays useful. This is the MCP-server-side counterpart to the
 * `resolveStrictness` helper in `hooks/stop-quality-gate.mjs`.
 *
 * @param workspaceRoot Absolute path the loader should probe for
 *                      `.claude-crap.json`.
 * @param logger        Pino logger used to surface recoverable
 *                      config errors.
 * @returns             The resolved strictness, or `"strict"` on
 *                      error.
 */
function safeLoadStrictness(
  workspaceRoot: string,
  logger: import("pino").Logger,
): "strict" | "warn" | "advisory" {
  try {
    return loadCrapConfig({ workspaceRoot }).strictness;
  } catch (err) {
    if (err instanceof CrapConfigError) {
      logger.warn(
        { err: err.message },
        "score_project: invalid sonar config, falling back to strict",
      );
      return "strict";
    }
    throw err;
  }
}

/**
 * Build a lightweight metrics snapshot that the LLM can read through
 * the `sonar://metrics/current` resource. This is intentionally thin
 * and side-effect free: it derives everything from the in-memory
 * SARIF store without walking the workspace. Callers that need a
 * full scoring payload (with a real LOC walk and the A..E grades per
 * dimension) should invoke the `score_project` tool, which uses the
 * bounded workspace walker and the `metrics/score.ts` engine.
 *
 * @param config     Fully resolved server configuration.
 * @param sarifStore Live SARIF store used to read the latest findings.
 */
async function buildMetricsSnapshot(
  config: CrapConfig,
  sarifStore: SarifStore,
): Promise<Record<string, unknown>> {
  const findings = sarifStore.list();
  const totalRemediationMinutes = findings.reduce((sum, f) => {
    const effort = f.properties?.["effortMinutes"];
    return typeof effort === "number" ? sum + effort : sum;
  }, 0);

  // Cheap LOC approximation derived from the SARIF report: assume
  // ~100 physical lines per file we have at least one finding in.
  // This keeps the resource read lock-free and synchronous-feeling;
  // the `score_project` tool is the authoritative path when a real
  // workspace walk is required.
  const uniqueFiles = new Set(findings.map((f) => f.location.uri));
  const approxLoc = Math.max(uniqueFiles.size * 100, 1);

  const tdrPercent =
    totalRemediationMinutes / (config.minutesPerLoc * approxLoc) * 100;
  const rating = classifyTdr(Number.isFinite(tdrPercent) ? tdrPercent : 0);

  return {
    generatedAt: new Date().toISOString(),
    config: {
      crapThreshold: config.crapThreshold,
      tdrMaxRating: config.tdrMaxRating,
      minutesPerLoc: config.minutesPerLoc,
    },
    sarif: {
      reportPath: sarifStore.consolidatedReportPath,
      findings: findings.length,
      files: uniqueFiles.size,
      tools: Array.from(new Set(findings.map((f) => f.sourceTool))),
    },
    tdrApprox: {
      percent: Number(tdrPercent.toFixed(4)),
      rating,
      remediationMinutes: totalRemediationMinutes,
      approxLinesOfCode: approxLoc,
    },
  };
}

// Top-level await would be cleaner, but we keep main() + .catch() so
// any error during async bootstrap (engine init, store load) surfaces as
// a non-zero exit code visible to Claude Code's MCP diagnostics.
main().catch((err) => {
  // Fatal errors go to stderr to avoid corrupting the JSON-RPC channel
  // on stdout. We use `process.stderr.write` rather than `console.error`
  // so that no lint suppression is needed and so that no buffering layer
  // can swallow the message. A non-zero exit code causes Claude Code to
  // surface the failure in its MCP-server diagnostics.
  process.stderr.write(`[claude-crap] fatal error during startup: ${String(err)}\n`);
  if (err instanceof Error && err.stack) {
    process.stderr.write(err.stack + "\n");
  }
  process.exit(1);
});
