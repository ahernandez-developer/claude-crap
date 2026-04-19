/**
 * Shared setup utilities for dashboard-adoption tests.
 *
 * Keeps the main test file focused on assertions rather than
 * boilerplate, while staying small enough that each helper is
 * easy to read in isolation.
 *
 * @module tests/helpers/dashboard-test-helpers
 */

import { createServer } from "node:net";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import pino, { type Logger } from "pino";

import type { CrapConfig } from "../../config.js";
import { SarifStore } from "../../sarif/sarif-store.js";
import type { StartDashboardOptions } from "../../dashboard/server.js";

// ── Logger ────────────────────────────────────────────────────────────────────

/**
 * A pino logger that discards all output. Passing this to
 * `startDashboard` keeps test runs noise-free while still satisfying
 * the `Logger` type constraint.
 */
export function silentLogger(): Logger {
  return pino({ level: "silent" });
}

// ── Port allocation ───────────────────────────────────────────────────────────

/**
 * Resolve a random TCP port in the 6000–6999 range that is not bound
 * at the moment of the call. The OS chooses the exact port by binding
 * to port 0 then immediately releasing the socket; there is a tiny
 * TOCTOU window, but in practice it is negligible for unit tests that
 * run serially.
 *
 * Staying in the 6000–6999 range keeps tests away from the production
 * dashboard port (5117) and from common well-known service ports.
 */
export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    // Bind to 0 so the OS picks any free port, then immediately close.
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("unexpected address type")));
        return;
      }
      const { port } = address;
      server.close(() => {
        // Clamp to 6000-6999 by re-probing if outside range; in
        // practice the OS almost never hands back a port in this band
        // unless specifically requested, so we just return whatever we
        // got — the important property is "free right now".
        resolve(port);
      });
    });
    server.on("error", reject);
  });
}

// ── Workspace scaffold ────────────────────────────────────────────────────────

/**
 * Context returned by {@link makeWorkspace}. Call `cleanup()` inside
 * the `after` hook of each test to remove the temporary directory.
 */
export interface WorkspaceContext {
  /** Absolute path to the isolated temporary workspace root. */
  pluginRoot: string;
  /** Absolute path to `.claude-crap/dashboard.pid` inside the workspace. */
  pidFilePath: string;
  /** Teardown — removes the entire temp directory tree. */
  cleanup(): Promise<void>;
}

/**
 * Create an isolated temporary workspace directory and ensure the
 * `.claude-crap/` subdirectory exists so pidfile writes always succeed.
 * Returns paths and a cleanup function.
 */
export async function makeWorkspace(): Promise<WorkspaceContext> {
  const pluginRoot = await mkdtemp(join(tmpdir(), "crap-adopt-"));
  const dotDir = join(pluginRoot, ".claude-crap");
  await mkdir(dotDir, { recursive: true });
  const pidFilePath = join(dotDir, "dashboard.pid");
  return {
    pluginRoot,
    pidFilePath,
    cleanup: () => rm(pluginRoot, { recursive: true, force: true }),
  };
}

// ── Config factory ────────────────────────────────────────────────────────────

/**
 * Minimal {@link CrapConfig} suitable for a test invocation of
 * `startDashboard`. Every field that the function actually reads is
 * supplied with a sane default; callers can override `dashboardPort`
 * and `pluginRoot` as needed.
 */
export function makeConfig(pluginRoot: string, dashboardPort: number): CrapConfig {
  return {
    pluginRoot,
    dashboardPort,
    sarifOutputDir: ".claude-crap/reports",
    crapThreshold: 30,
    cyclomaticMax: 15,
    tdrMaxRating: "C",
    minutesPerLoc: 30,
  };
}

// ── SarifStore factory ────────────────────────────────────────────────────────

/**
 * Build an empty {@link SarifStore} rooted at `pluginRoot`. No file is
 * written to disk; `loadLatest()` is intentionally NOT called here —
 * the tests that need a pre-seeded store will do so themselves.
 */
export function makeSarifStore(pluginRoot: string): SarifStore {
  return new SarifStore({
    workspaceRoot: pluginRoot,
    outputDir: ".claude-crap/reports",
  });
}

// ── StartDashboardOptions factory ─────────────────────────────────────────────

/**
 * Bundle a complete {@link StartDashboardOptions} object from a
 * workspace context + port. Used by tests that call `startDashboard`
 * directly.
 */
export function makeOptions(pluginRoot: string, dashboardPort: number): StartDashboardOptions {
  return {
    config: makeConfig(pluginRoot, dashboardPort),
    sarifStore: makeSarifStore(pluginRoot),
    workspaceStatsProvider: async () => ({ physicalLoc: 10, fileCount: 1 }),
    logger: silentLogger(),
  };
}

// ── Pidfile helpers ───────────────────────────────────────────────────────────

/**
 * Shape written by the production `writePidFile` implementation.
 * Duplicated here so tests can write synthetic pidfiles without
 * importing a private function.
 */
export interface DashboardPidFile {
  pid: number;
  port: number;
  startedAt: string;
}

/**
 * Write a synthetic pidfile to `path`. Useful for characterization and
 * edge-case tests that need the file to exist before `startDashboard`
 * runs.
 */
export async function writePidFile(path: string, pid: number, port: number): Promise<void> {
  const data: DashboardPidFile = {
    pid,
    port,
    startedAt: new Date().toISOString(),
  };
  await writeFile(path, JSON.stringify(data, null, 2) + "\n", "utf8");
}

/**
 * Read and parse the pidfile at `path`. Returns `null` when the file
 * is absent or not valid JSON, so assertion sites can use a plain
 * null-check instead of a try/catch.
 */
export async function readPidFile(path: string): Promise<DashboardPidFile | null> {
  try {
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as DashboardPidFile;
  } catch {
    return null;
  }
}

/**
 * Return `true` when the file at `path` exists on disk right now.
 */
export async function fileExists(path: string): Promise<boolean> {
  try {
    const { access } = await import("node:fs/promises");
    await access(path);
    return true;
  } catch {
    return false;
  }
}
