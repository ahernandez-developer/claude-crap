/**
 * Local Vue.js dashboard for claude-crap — Fastify HTTP server.
 *
 * The dashboard runs in the same Node.js process as the MCP server,
 * but on a separate TCP port (default 5117). It exposes:
 *
 *   GET /                  → static index.html (Vue 3 SPA from CDN)
 *   GET /api/score         → live ProjectScore JSON from the score engine
 *   GET /api/sarif         → consolidated SARIF 2.1.0 document
 *   GET /api/health        → simple {status:"ok"} liveness probe
 *
 * The server binds to `127.0.0.1` only — never to `0.0.0.0` — so the
 * dashboard cannot be reached from outside the developer's machine.
 *
 * If the configured port is already in use (or the bind otherwise
 * fails), `startDashboard()` rejects gracefully and the caller falls
 * back to "no dashboard". The MCP server will keep running.
 *
 * IMPORTANT: this module never writes to stdout. The MCP stdio
 * transport reserves stdout for JSON-RPC framing, so all logs and
 * errors here go through the same pino-on-stderr instance the rest of
 * the server uses.
 *
 * @module dashboard/server
 */

import { promises as fs, existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import type { Logger } from "pino";

import type { CrapConfig } from "../config.js";
import {
  computeProjectScore,
  type ProjectScore,
  type WorkspaceStats,
} from "../metrics/score.js";
import type { SarifStore } from "../sarif/sarif-store.js";
import type { TreeSitterEngine } from "../ast/tree-sitter-engine.js";
import { detectLanguageFromPath } from "../ast/language-config.js";
import { buildFileDetail } from "./file-detail.js";

/**
 * Callback used by the dashboard to refresh workspace LOC stats on
 * every score request. The MCP server provides this so the dashboard
 * does not have to know how to walk the disk itself.
 */
export type WorkspaceStatsProvider = () => Promise<WorkspaceStats>;

/**
 * Inputs accepted by {@link startDashboard}.
 */
export interface StartDashboardOptions {
  /** Fully resolved server configuration. */
  readonly config: CrapConfig;
  /** Live SARIF store the dashboard reads findings from. */
  readonly sarifStore: SarifStore;
  /** Function that returns up-to-date LOC + file count for the workspace. */
  readonly workspaceStatsProvider: WorkspaceStatsProvider;
  /** Pino logger from the MCP server (writes to stderr). */
  readonly logger: Logger;
  /** Tree-sitter engine for the /api/complexity endpoint. */
  readonly astEngine?: TreeSitterEngine;
}

/**
 * Handle returned by {@link startDashboard}. Use `url` to build the
 * link the user clicks; call `close()` during shutdown.
 */
export interface DashboardHandle {
  readonly url: string;
  close(): Promise<void>;
}

/**
 * Boot the Fastify dashboard server. Resolves with a {@link DashboardHandle}
 * once the server is listening, or rejects when the bind fails (caller
 * should treat that as a non-fatal degradation).
 *
 * @param options Configuration, store, and provider callback.
 */
export async function startDashboard(options: StartDashboardOptions): Promise<DashboardHandle> {
  const { config, sarifStore, workspaceStatsProvider, logger } = options;

  // Resolve the public/ directory. After `npm run build` the compiled
  // server lives in `dist/dashboard/server.js`, but we keep the static
  // SPA assets in `src/dashboard/public/` so we don't need a postbuild
  // copy step. We probe both candidate locations in priority order.
  const publicRoot = await resolvePublicRoot(logger);

  const fastify: FastifyInstance = Fastify({
    logger: false, // we route everything through pino-on-stderr ourselves
    disableRequestLogging: true,
  });

  await fastify.register(fastifyStatic, {
    root: publicRoot,
    prefix: "/",
  });

  // ------------------------------------------------------------------
  // /api/health — liveness probe
  // ------------------------------------------------------------------
  fastify.get("/api/health", async () => ({ status: "ok", server: "claude-crap", version: "0.3.6" }));

  // ------------------------------------------------------------------
  // /api/score — live project score
  // ------------------------------------------------------------------
  fastify.get("/api/score", async () => {
    const stats = await workspaceStatsProvider();
    const score = await buildScore(config, sarifStore, stats, urlOf(fastify, config));
    return score;
  });

  // ------------------------------------------------------------------
  // /api/sarif — consolidated SARIF 2.1.0 document
  // ------------------------------------------------------------------
  fastify.get("/api/sarif", async () => sarifStore.toSarifDocument());

  // ------------------------------------------------------------------
  // /api/complexity — top complex functions across the workspace
  // ------------------------------------------------------------------
  fastify.get("/api/complexity", async () => {
    if (!options.astEngine) {
      return { threshold: config.cyclomaticMax, totalFunctions: 0, violationCount: 0, topFunctions: [] };
    }
    return buildComplexityReport(config, options.astEngine, logger);
  });

  // ------------------------------------------------------------------
  // /api/file-detail — per-file source, metrics, and findings
  // ------------------------------------------------------------------
  fastify.get("/api/file-detail", async (request, reply) => {
    const { path: filePath } = request.query as { path?: string };
    if (!filePath) {
      return reply.status(400).send({ error: "Missing required query parameter: path" });
    }
    try {
      const detail = await buildFileDetail({
        relativePath: filePath,
        workspaceRoot: config.pluginRoot,
        astEngine: options.astEngine,
        sarifStore,
        cyclomaticMax: config.cyclomaticMax,
      });
      return detail;
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes("ENOENT") || msg.includes("not found")) {
        return reply.status(404).send({ error: `File not found: ${filePath}` });
      }
      if (msg.includes("escapes the workspace")) {
        return reply.status(400).send({ error: msg });
      }
      logger.error({ err: msg, filePath }, "file-detail endpoint error");
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // ------------------------------------------------------------------
  // / — explicit SPA fallback for index.html
  // ------------------------------------------------------------------
  // @fastify/static sometimes doesn't serve index.html on GET / when
  // API routes are registered on the same prefix. Explicit fallback
  // ensures the dashboard always loads.
  fastify.get("/", async (_request, reply) => {
    return reply.sendFile("index.html");
  });

  // Kill any stale dashboard from a previous session so we always
  // bind to the configured port. This mirrors claude-mem's PID file
  // pattern: write a PID file when alive, check + kill on next boot.
  const pidFilePath = resolvePidFilePath(config);
  await killStaleDashboard(pidFilePath, config.dashboardPort, logger);

  await fastify.listen({ port: config.dashboardPort, host: "127.0.0.1" });

  const url = `http://127.0.0.1:${config.dashboardPort}`;
  logger.info({ url, publicRoot }, "claude-crap dashboard listening");

  // Write PID file so the next session can find and kill us.
  writePidFile(pidFilePath, config.dashboardPort);

  return {
    url,
    async close() {
      removePidFile(pidFilePath);
      await fastify.close();
    },
  };
}

/**
 * Probe the candidate public/ directories in priority order and return
 * the first one that contains an `index.html`. Throws when none of the
 * candidates exist — that points at a packaging mistake the developer
 * should fix immediately.
 *
 * @param logger Pino instance for diagnostics.
 */
async function resolvePublicRoot(logger: Logger): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // 0. Bundled layout: plugin/bundle/mcp-server.mjs → ./dashboard/public
    resolve(here, "dashboard", "public"),
    // 1. Compiled layout: dist/dashboard/server.js → ./public next to it
    //    (only present if a build step copies the assets — not used
    //    today, but accepted so a future copy step does not break us).
    resolve(here, "public"),
    // 2. Source-relative layout: dist/dashboard/server.js → ../../src/dashboard/public
    //    This is the default — no copy step required because we resolve
    //    upward from `dist/` into `src/` at runtime.
    resolve(here, "..", "..", "src", "dashboard", "public"),
  ];
  for (const candidate of candidates) {
    try {
      await fs.access(resolve(candidate, "index.html"));
      return candidate;
    } catch {
      // probe next
    }
  }
  logger.error({ candidates }, "dashboard public/ directory not found");
  throw new Error(
    `[claude-crap] dashboard: index.html not found in any of ${candidates.join(", ")}`,
  );
}

/**
 * Resolve the canonical dashboard URL using the live Fastify address
 * info. Falls back to the configured port when the address info is
 * not yet available (e.g. on the very first request during startup).
 */
function urlOf(fastify: FastifyInstance, config: CrapConfig): string {
  const addresses = fastify.addresses?.() ?? [];
  const first = addresses[0];
  if (first) {
    const host = first.address === "::" || first.address === "0.0.0.0" ? "127.0.0.1" : first.address;
    return `http://${host}:${first.port}`;
  }
  return `http://127.0.0.1:${config.dashboardPort}`;
}

// ------------------------------------------------------------------
// PID file management — mirrors claude-mem's worker.pid pattern
// ------------------------------------------------------------------

/**
 * Shape of the PID file written by the dashboard process.
 */
interface DashboardPidFile {
  pid: number;
  port: number;
  startedAt: string;
}

/**
 * Resolve the path to the PID file. Stored under
 * `.claude-crap/dashboard.pid` in the workspace so it survives
 * across sessions but is gitignored with the rest of `.claude-crap/`.
 */
function resolvePidFilePath(config: CrapConfig): string {
  return join(config.pluginRoot, ".claude-crap", "dashboard.pid");
}

/**
 * Write the PID file atomically after the dashboard has started.
 */
function writePidFile(path: string, port: number): void {
  const data: DashboardPidFile = {
    pid: process.pid,
    port,
    startedAt: new Date().toISOString(),
  };
  try {
    writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
  } catch {
    /* best effort — dashboard still works without a PID file */
  }
}

/**
 * Remove the PID file during graceful shutdown.
 */
function removePidFile(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* already gone or never written */
  }
}

/**
 * Check whether a process is alive using the signal-0 probe.
 * Returns `true` when the process exists and is reachable.
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the PID file, kill any stale dashboard process, and free the
 * port so the current session can bind to it. This is the key
 * difference from the port-fallback approach: instead of drifting to
 * 5118, 5119, etc., we reclaim the configured port every time.
 *
 * @param pidFilePath  Absolute path to `dashboard.pid`.
 * @param port         The configured dashboard port.
 * @param logger       Pino logger for diagnostics.
 */
async function killStaleDashboard(
  pidFilePath: string,
  port: number,
  logger: Logger,
): Promise<void> {
  if (!existsSync(pidFilePath)) return;

  let stale: DashboardPidFile;
  try {
    stale = JSON.parse(readFileSync(pidFilePath, "utf8"));
  } catch {
    // Corrupted PID file — remove it and move on.
    removePidFile(pidFilePath);
    return;
  }

  if (!isPidAlive(stale.pid)) {
    logger.info({ stalePid: stale.pid }, "stale dashboard PID file found (process dead), removing");
    removePidFile(pidFilePath);
    return;
  }

  // Process is alive — kill it so we can reclaim the port.
  logger.info(
    { stalePid: stale.pid, port: stale.port, startedAt: stale.startedAt },
    "killing stale dashboard process from previous session",
  );

  try {
    process.kill(stale.pid, "SIGTERM");
  } catch {
    // Permission denied or already gone — remove PID file either way.
    removePidFile(pidFilePath);
    return;
  }

  // Wait up to 3 seconds for the process to exit.
  for (let i = 0; i < 30; i++) {
    if (!isPidAlive(stale.pid)) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  // If still alive after 3s, escalate to SIGKILL.
  if (isPidAlive(stale.pid)) {
    try {
      process.kill(stale.pid, "SIGKILL");
    } catch {
      /* best effort */
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  removePidFile(pidFilePath);

  // Give the OS a moment to release the TCP port after the process dies.
  await new Promise((r) => setTimeout(r, 300));
}

// ── Complexity report builder ──────────────────────────────────────

/** Entry in the complexity report's top-functions list. */
interface ComplexityEntry {
  filePath: string;
  name: string;
  cyclomaticComplexity: number;
  startLine: number;
  endLine: number;
  lineCount: number;
}

/** Shape returned by GET /api/complexity. */
interface ComplexityReport {
  threshold: number;
  totalFunctions: number;
  violationCount: number;
  topFunctions: ComplexityEntry[];
}

/** Directories to skip (mirrors workspace-walker.ts). */
const SKIP_DIRS: ReadonlySet<string> = new Set([
  "node_modules", ".git", "dist", "build", "out", "target",
  ".venv", "venv", "__pycache__", ".cache", ".next", ".nuxt",
  ".claude-crap", ".codesight",
]);

/**
 * Walk the workspace and collect per-function complexity metrics,
 * returning the top 20 most complex functions. This runs on demand
 * when the dashboard requests /api/complexity.
 */
async function buildComplexityReport(
  config: CrapConfig,
  engine: TreeSitterEngine,
  logger: Logger,
): Promise<ComplexityReport> {
  const threshold = config.cyclomaticMax;
  const allFunctions: ComplexityEntry[] = [];
  let totalFunctions = 0;

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".claude-plugin") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const language = detectLanguageFromPath(entry.name);
      if (!language) continue;
      try {
        const metrics = await engine.analyzeFile({ filePath: full, language });
        for (const fn of metrics.functions) {
          totalFunctions += 1;
          allFunctions.push({
            filePath: full.startsWith(config.pluginRoot)
              ? full.substring(config.pluginRoot.length + 1)
              : full,
            name: fn.name,
            cyclomaticComplexity: fn.cyclomaticComplexity,
            startLine: fn.startLine,
            endLine: fn.endLine,
            lineCount: fn.lineCount,
          });
        }
      } catch (err) {
        logger.warn(
          { filePath: full, err: (err as Error).message },
          "complexity-report: failed to analyze file",
        );
      }
    }
  }

  await walk(config.pluginRoot);

  // Sort by complexity descending and take top 20
  allFunctions.sort((a, b) => b.cyclomaticComplexity - a.cyclomaticComplexity);
  const topFunctions = allFunctions.slice(0, 20);
  const violationCount = allFunctions.filter(
    (f) => f.cyclomaticComplexity > threshold,
  ).length;

  return { threshold, totalFunctions, violationCount, topFunctions };
}

/**
 * Wrap {@link computeProjectScore} so the dashboard endpoint can call
 * it with the live store and provide consistent location metadata.
 */
async function buildScore(
  config: CrapConfig,
  sarifStore: SarifStore,
  workspace: WorkspaceStats,
  dashboardUrl: string | null,
): Promise<ProjectScore> {
  return computeProjectScore({
    workspaceRoot: config.pluginRoot,
    minutesPerLoc: config.minutesPerLoc,
    tdrMaxRating: config.tdrMaxRating,
    workspace,
    sarifStore,
    dashboardUrl,
    sarifReportPath: sarifStore.consolidatedReportPath,
  });
}
