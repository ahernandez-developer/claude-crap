/**
 * Local Vue.js dashboard for claude-sonar — Fastify HTTP server.
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

import { promises as fs } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import type { Logger } from "pino";

import type { SonarConfig } from "../config.js";
import {
  computeProjectScore,
  type ProjectScore,
  type WorkspaceStats,
} from "../metrics/score.js";
import type { SarifStore } from "../sarif/sarif-store.js";

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
  readonly config: SonarConfig;
  /** Live SARIF store the dashboard reads findings from. */
  readonly sarifStore: SarifStore;
  /** Function that returns up-to-date LOC + file count for the workspace. */
  readonly workspaceStatsProvider: WorkspaceStatsProvider;
  /** Pino logger from the MCP server (writes to stderr). */
  readonly logger: Logger;
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
    decorateReply: false,
  });

  // ------------------------------------------------------------------
  // /api/health — liveness probe
  // ------------------------------------------------------------------
  fastify.get("/api/health", async () => ({ status: "ok", server: "claude-sonar", version: "0.1.0" }));

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
  // / — static SPA fallback (Fastify-static handles index.html)
  // ------------------------------------------------------------------

  await fastify.listen({ port: config.dashboardPort, host: "127.0.0.1" });
  const url = `http://127.0.0.1:${config.dashboardPort}`;
  logger.info({ url, publicRoot }, "claude-sonar dashboard listening");

  return {
    url,
    async close() {
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
    `[claude-sonar] dashboard: index.html not found in any of ${candidates.join(", ")}`,
  );
}

/**
 * Resolve the canonical dashboard URL using the live Fastify address
 * info. Falls back to the configured port when the address info is
 * not yet available (e.g. on the very first request during startup).
 */
function urlOf(fastify: FastifyInstance, config: SonarConfig): string {
  const addresses = fastify.addresses?.() ?? [];
  const first = addresses[0];
  if (first) {
    const host = first.address === "::" || first.address === "0.0.0.0" ? "127.0.0.1" : first.address;
    return `http://${host}:${first.port}`;
  }
  return `http://127.0.0.1:${config.dashboardPort}`;
}

/**
 * Wrap {@link computeProjectScore} so the dashboard endpoint can call
 * it with the live store and provide consistent location metadata.
 */
async function buildScore(
  config: SonarConfig,
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
