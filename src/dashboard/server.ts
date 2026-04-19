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
import { createExclusionFilter } from "../shared/exclusions.js";
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
  /** User-defined exclusion patterns from .claude-crap.json. */
  readonly exclude?: ReadonlyArray<string>;
}

/**
 * Handle returned by {@link startDashboard}. Use `url` to build the
 * link the user clicks; call `close()` during shutdown.
 *
 * `adopted === true` means another claude-crap process already owned
 * the dashboard port when we booted, and we are piggy-backing on its
 * HTTP server. Adopted handles have a no-op `close()` because tearing
 * down the Fastify instance would strand the other MCP servers.
 */
export interface DashboardHandle {
  readonly url: string;
  readonly adopted: boolean;
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
  const pidFilePath = resolvePidFilePath(config);

  // Adopt-don't-steal: if a prior MCP server is already serving the
  // dashboard on this port AND is healthy, piggy-back on it instead of
  // killing it. This is what keeps N concurrent launchers from
  // thrashing the port in an endless SIGTERM loop.
  const adoption = await tryAdoptExisting(pidFilePath, config.dashboardPort, logger);
  if (adoption) {
    logger.info(
      { url: adoption.url, ownerPid: adoption.pid, port: config.dashboardPort },
      "adopted existing claude-crap dashboard",
    );
    return {
      url: adoption.url,
      adopted: true,
      async close() {
        // No-op: we never bound a socket of our own, so there is
        // nothing to release. Removing the pidfile here would make the
        // owner's `close()` race with our cleanup.
      },
    };
  }

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
  fastify.get("/api/health", async () => ({ status: "ok", server: "claude-crap", version: "0.4.0" }));

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
    return buildComplexityReport(config, options.astEngine, logger, options.exclude);
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

  // The pidfile was either missing, stale, or pointed at a zombie —
  // `tryAdoptExisting` has already cleaned it up. Try to bind. If we
  // lose a race against another launcher that bound between our probe
  // and our listen, fall back to adoption instead of failing.
  try {
    await fastify.listen({ port: config.dashboardPort, host: "127.0.0.1" });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EADDRINUSE") {
      await fastify.close().catch(() => { /* best effort */ });
      const raceAdoption = await tryAdoptExisting(pidFilePath, config.dashboardPort, logger);
      if (raceAdoption) {
        logger.info(
          { url: raceAdoption.url, ownerPid: raceAdoption.pid, port: config.dashboardPort },
          "dashboard bind lost race, adopted concurrent owner",
        );
        return {
          url: raceAdoption.url,
          adopted: true,
          async close() { /* no-op — see adopted branch above */ },
        };
      }
    }
    throw err;
  }

  const url = `http://127.0.0.1:${config.dashboardPort}`;
  logger.info({ url, publicRoot }, "claude-crap dashboard listening");

  // Write PID file so sibling MCP servers can find us and adopt.
  writePidFile(pidFilePath, config.dashboardPort);

  return {
    url,
    adopted: false,
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
 * Probe an existing dashboard and decide whether the current process
 * can adopt it instead of binding its own Fastify server.
 *
 * Returns `{ url, pid }` only when all four conditions hold:
 *   1. A pidfile exists and parses as JSON.
 *   2. The recorded PID is still alive (signal-0 probe).
 *   3. The pidfile's recorded port matches the configured port.
 *   4. A GET on `/api/health` responds within ~500ms.
 *
 * Returns `null` in every other case, but with a side-effect that makes
 * the call-site's next step obvious:
 *   - Missing / corrupt / dead-PID / port-mismatch  → pidfile is removed
 *     so the caller can bind cleanly.
 *   - Zombie (PID alive, port unresponsive)         → stale owner is
 *     SIGKILL'd and the pidfile is removed. This is the one case where
 *     we still have to kill something, because the socket belongs to a
 *     process that is not talking HTTP anymore.
 */
async function tryAdoptExisting(
  pidFilePath: string,
  port: number,
  logger: Logger,
): Promise<{ url: string; pid: number } | null> {
  if (!existsSync(pidFilePath)) return null;

  let stale: DashboardPidFile;
  try {
    stale = JSON.parse(readFileSync(pidFilePath, "utf8"));
  } catch {
    logger.info({ pidFilePath }, "corrupt dashboard pidfile, removing");
    removePidFile(pidFilePath);
    return null;
  }

  if (!isPidAlive(stale.pid)) {
    logger.info({ stalePid: stale.pid }, "stale dashboard pidfile (process dead), removing");
    removePidFile(pidFilePath);
    return null;
  }

  if (stale.port !== port) {
    // The recorded owner is on a different port than we want. Don't
    // adopt it, don't kill it — just treat the pidfile as unrelated.
    logger.info(
      { stalePort: stale.port, wantedPort: port },
      "dashboard pidfile points at different port, ignoring",
    );
    removePidFile(pidFilePath);
    return null;
  }

  const healthy = await probeDashboardHealth(port);
  if (healthy) {
    return { url: `http://127.0.0.1:${port}`, pid: stale.pid };
  }

  // Zombie: PID is alive but not serving HTTP. Most likely the owner
  // crashed mid-init or is stuck. Terminate it so we can take over.
  logger.warn(
    { stalePid: stale.pid, port },
    "dashboard pidfile owner is unresponsive, terminating",
  );
  try {
    process.kill(stale.pid, "SIGTERM");
  } catch {
    /* already gone */
  }
  for (let i = 0; i < 30; i++) {
    if (!isPidAlive(stale.pid)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (isPidAlive(stale.pid)) {
    try { process.kill(stale.pid, "SIGKILL"); } catch { /* best effort */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  removePidFile(pidFilePath);
  // Let the OS release the TCP port before the caller tries to bind.
  await new Promise((r) => setTimeout(r, 300));
  return null;
}

/**
 * Low-latency health probe. Resolves `true` when the dashboard replies
 * 2xx to `/api/health` within 500ms, `false` on any other outcome
 * (timeout, connection refused, 5xx, etc.).
 */
async function probeDashboardHealth(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(500),
    });
    return res.ok;
  } catch {
    return false;
  }
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

// Directory exclusions are now centralized in src/shared/exclusions.ts.

/**
 * Walk the workspace and collect per-function complexity metrics,
 * returning the top 20 most complex functions. This runs on demand
 * when the dashboard requests /api/complexity.
 */
async function buildComplexityReport(
  config: CrapConfig,
  engine: TreeSitterEngine,
  logger: Logger,
  exclude?: ReadonlyArray<string>,
): Promise<ComplexityReport> {
  const threshold = config.cyclomaticMax;
  const filter = createExclusionFilter(exclude);
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
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (filter.shouldSkipDir(entry.name)) continue;
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
