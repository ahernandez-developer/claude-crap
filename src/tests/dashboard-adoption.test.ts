/**
 * Test suite for the adopt-don't-steal dashboard lifecycle.
 *
 * GOLDEN RULE STRUCTURE
 * ─────────────────────
 * Tests 1–6 are *characterization* tests: they describe behavior that
 * already exists in the current port-steal implementation and MUST
 * continue to pass after the adopt-don't-steal rewrite lands.
 *
 * Tests 7–12 are *edge-case* tests: they describe the new adoption
 * contract that the forthcoming implementation must satisfy. They are
 * expected to FAIL against the current port-steal code and PASS once
 * the rewrite is in place.
 *
 * Every test is hermetic:
 *   - Its own mkdtemp workspace under os.tmpdir().
 *   - A random port in the 6000–6999 range (avoids the real 5117).
 *   - All handles are closed and the workspace removed in after().
 *
 * @module tests/dashboard-adoption.test
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { startDashboard, type DashboardHandle } from "../dashboard/server.js";
import {
  makeWorkspace,
  makeOptions,
  writePidFile,
  readPidFile,
  fileExists,
  findFreePort,
  type WorkspaceContext,
} from "./helpers/dashboard-test-helpers.js";

// ---------------------------------------------------------------------------
// Helper: fetch /api/health and return the HTTP status code.
// ---------------------------------------------------------------------------
async function healthStatus(url: string): Promise<number> {
  const res = await fetch(`${url}/api/health`);
  return res.status;
}

// ---------------------------------------------------------------------------
// Helper: assert that a handle has an `adopted` property.
// The property does not exist yet on the current DashboardHandle interface;
// we access it through an augmented type so TypeScript does not complain,
// but the assertion will produce a clear failure message until it is wired.
// ---------------------------------------------------------------------------
interface AugmentedHandle extends DashboardHandle {
  readonly adopted?: boolean;
}

// ===========================================================================
// Characterization tests (must pass on current AND forthcoming code)
// ===========================================================================

describe("dashboard-adoption — characterization", () => {
  // -------------------------------------------------------------------------
  // Test 1: startDashboard resolves with a handle whose url matches the port
  // -------------------------------------------------------------------------
  describe("1. handle url matches configured port", () => {
    let ws: WorkspaceContext;
    let port: number;
    let handle: DashboardHandle | null = null;

    before(async () => {
      ws = await makeWorkspace();
      port = await findFreePort();
      handle = await startDashboard(makeOptions(ws.pluginRoot, port));
    });

    after(async () => {
      await handle?.close();
      await ws.cleanup();
    });

    it("url is http://127.0.0.1:<port>", () => {
      assert.ok(handle, "startDashboard must resolve a handle");
      assert.equal(handle.url, `http://127.0.0.1:${port}`);
    });
  });

  // -------------------------------------------------------------------------
  // Test 2: GET /api/health returns 200 {status:"ok"}
  // -------------------------------------------------------------------------
  describe("2. GET /api/health returns 200 with status ok", () => {
    let ws: WorkspaceContext;
    let handle: DashboardHandle | null = null;

    before(async () => {
      ws = await makeWorkspace();
      const port = await findFreePort();
      handle = await startDashboard(makeOptions(ws.pluginRoot, port));
    });

    after(async () => {
      await handle?.close();
      await ws.cleanup();
    });

    it("responds 200", async () => {
      assert.ok(handle);
      const res = await fetch(`${handle.url}/api/health`);
      assert.equal(res.status, 200);
    });

    it("body contains status ok", async () => {
      assert.ok(handle);
      const res = await fetch(`${handle.url}/api/health`);
      const body = await res.json() as Record<string, unknown>;
      assert.equal(body["status"], "ok");
    });
  });

  // -------------------------------------------------------------------------
  // Test 3: GET /api/score returns 200 JSON with an `overall` key
  // -------------------------------------------------------------------------
  describe("3. GET /api/score returns overall key", () => {
    let ws: WorkspaceContext;
    let handle: DashboardHandle | null = null;

    before(async () => {
      ws = await makeWorkspace();
      const port = await findFreePort();
      handle = await startDashboard(makeOptions(ws.pluginRoot, port));
    });

    after(async () => {
      await handle?.close();
      await ws.cleanup();
    });

    it("responds 200", async () => {
      assert.ok(handle);
      const res = await fetch(`${handle.url}/api/score`);
      assert.equal(res.status, 200);
    });

    it("JSON body has overall key", async () => {
      assert.ok(handle);
      const res = await fetch(`${handle.url}/api/score`);
      const body = await res.json() as Record<string, unknown>;
      assert.ok(
        Object.prototype.hasOwnProperty.call(body, "overall"),
        "body must contain an 'overall' key",
      );
    });
  });

  // -------------------------------------------------------------------------
  // Test 4: handle.close() releases the port so a second startDashboard
  //         on the same port succeeds.
  // -------------------------------------------------------------------------
  describe("4. close() releases the port", () => {
    let ws: WorkspaceContext;
    let port: number;
    let handle2: DashboardHandle | null = null;

    before(async () => {
      ws = await makeWorkspace();
      port = await findFreePort();
      // First server: start and immediately close.
      const first = await startDashboard(makeOptions(ws.pluginRoot, port));
      await first.close();
      // Second server: must bind successfully after the first closed.
      handle2 = await startDashboard(makeOptions(ws.pluginRoot, port));
    });

    after(async () => {
      await handle2?.close();
      await ws.cleanup();
    });

    it("second server binds and responds 200", async () => {
      assert.ok(handle2, "second startDashboard must succeed after first close");
      const status = await healthStatus(handle2.url);
      assert.equal(status, 200);
    });
  });

  // -------------------------------------------------------------------------
  // Test 5: stale pidfile (dead PID) is removed and a fresh pidfile is written
  // -------------------------------------------------------------------------
  describe("5. stale pidfile with dead PID is replaced", () => {
    let ws: WorkspaceContext;
    let handle: DashboardHandle | null = null;

    before(async () => {
      ws = await makeWorkspace();
      const port = await findFreePort();
      // PID 999999 is virtually never alive on a developer machine.
      await writePidFile(ws.pidFilePath, 999999, port);
      handle = await startDashboard(makeOptions(ws.pluginRoot, port));
    });

    after(async () => {
      await handle?.close();
      await ws.cleanup();
    });

    it("server starts and responds 200", async () => {
      assert.ok(handle);
      assert.equal(await healthStatus(handle.url), 200);
    });

    it("pidfile now contains process.pid", async () => {
      const pf = await readPidFile(ws.pidFilePath);
      assert.ok(pf, "pidfile must exist after boot");
      assert.equal(pf.pid, process.pid);
    });
  });

  // -------------------------------------------------------------------------
  // Test 6: corrupt (non-JSON) pidfile is deleted, server boots normally
  // -------------------------------------------------------------------------
  describe("6. corrupt pidfile is deleted, server boots normally", () => {
    let ws: WorkspaceContext;
    let handle: DashboardHandle | null = null;

    before(async () => {
      ws = await makeWorkspace();
      const port = await findFreePort();
      // Write deliberate garbage.
      const { writeFile } = await import("node:fs/promises");
      await writeFile(ws.pidFilePath, "not-json{{{", "utf8");
      handle = await startDashboard(makeOptions(ws.pluginRoot, port));
    });

    after(async () => {
      await handle?.close();
      await ws.cleanup();
    });

    it("server starts successfully", async () => {
      assert.ok(handle);
      assert.equal(await healthStatus(handle.url), 200);
    });

    it("pidfile contains valid JSON with process.pid after boot", async () => {
      const pf = await readPidFile(ws.pidFilePath);
      assert.ok(pf, "a fresh pidfile must be written after boot");
      assert.equal(pf.pid, process.pid);
    });
  });
});

// ===========================================================================
// Edge-case tests (will fail on current port-steal code; must pass on adopt)
// ===========================================================================

describe("dashboard-adoption — edge cases (adopt-don't-steal)", () => {
  // -------------------------------------------------------------------------
  // Test 7: Adoption happy path
  //
  //   A is the first owner.
  //   B calls startDashboard with the same config.
  //   B must adopt A (not kill it), return adopted:true, and share A's url.
  // -------------------------------------------------------------------------
  describe("7. adoption happy path — B adopts A without killing it", () => {
    let ws: WorkspaceContext;
    let handleA: AugmentedHandle | null = null;
    let handleB: AugmentedHandle | null = null;
    let port: number;

    before(async () => {
      ws = await makeWorkspace();
      port = await findFreePort();
      handleA = await startDashboard(makeOptions(ws.pluginRoot, port)) as AugmentedHandle;
      handleB = await startDashboard(makeOptions(ws.pluginRoot, port)) as AugmentedHandle;
    });

    after(async () => {
      // Close B first (no-op), then A (real shutdown).
      await handleB?.close();
      await handleA?.close();
      await ws.cleanup();
    });

    it("B reports adopted === true", () => {
      assert.ok(handleB, "handleB must exist");
      assert.equal(
        (handleB as AugmentedHandle).adopted,
        true,
        "handle B must be an adopted handle",
      );
    });

    it("B url equals A url", () => {
      assert.ok(handleA && handleB);
      assert.equal(handleB.url, handleA.url);
    });

    it("A is still alive after B is created — was NOT SIGTERMd", async () => {
      assert.ok(handleA);
      assert.equal(
        await healthStatus(handleA.url),
        200,
        "A must still respond after B adopted it",
      );
    });

    it("pidfile PID still equals A owner's pid (process.pid)", async () => {
      const pf = await readPidFile(ws.pidFilePath);
      assert.ok(pf, "pidfile must exist");
      assert.equal(pf.pid, process.pid);
    });
  });

  // -------------------------------------------------------------------------
  // Test 8: Adopted close is a no-op
  //
  //   After handleB.close(), A's server is still alive and the pidfile
  //   still exists.
  // -------------------------------------------------------------------------
  describe("8. adopted close() is a no-op", () => {
    let ws: WorkspaceContext;
    let handleA: DashboardHandle | null = null;
    let handleB: AugmentedHandle | null = null;

    before(async () => {
      ws = await makeWorkspace();
      const port = await findFreePort();
      handleA = await startDashboard(makeOptions(ws.pluginRoot, port));
      handleB = await startDashboard(makeOptions(ws.pluginRoot, port)) as AugmentedHandle;
      // Close the adopted handle.
      await handleB.close();
    });

    after(async () => {
      await handleA?.close();
      await ws.cleanup();
    });

    it("A is still reachable after B.close()", async () => {
      assert.ok(handleA);
      assert.equal(
        await healthStatus(handleA.url),
        200,
        "A must still serve requests after adopter B closed",
      );
    });

    it("pidfile still exists on disk after B.close()", async () => {
      assert.ok(
        await fileExists(ws.pidFilePath),
        "pidfile must survive an adopted close()",
      );
    });
  });

  // -------------------------------------------------------------------------
  // Test 9: Zombie detection
  //
  //   Pidfile says pid=process.pid (alive) but the port is free (no server).
  //   startDashboard must detect the zombie, remove the pidfile, bind itself,
  //   and return adopted:false.
  // -------------------------------------------------------------------------
  describe("9. zombie detection — alive PID but dead port", () => {
    let ws: WorkspaceContext;
    let handle: AugmentedHandle | null = null;

    before(async () => {
      ws = await makeWorkspace();
      // Allocate two ports: one for the fake zombie entry, one for the
      // real server that must boot.
      const zombiePort = await findFreePort();
      const realPort = await findFreePort();
      // Write a pidfile that points to ourselves (alive) on zombiePort
      // (which nobody is actually listening on).
      await writePidFile(ws.pidFilePath, process.pid, zombiePort);
      // Now start on realPort — the implementation should use the
      // configured dashboardPort, see the stale pidfile, health-probe
      // zombiePort, find it dead, remove the file, and bind realPort.
      // We call startDashboard with a config whose dashboardPort is
      // realPort so the final server lands there.
      const opts = makeOptions(ws.pluginRoot, realPort);
      handle = await startDashboard(opts) as AugmentedHandle;
    });

    after(async () => {
      await handle?.close();
      await ws.cleanup();
    });

    it("server starts and responds 200", async () => {
      assert.ok(handle);
      assert.equal(await healthStatus(handle.url), 200);
    });

    it("handle adopted === false — we own the port", () => {
      assert.ok(handle);
      assert.equal(
        (handle as AugmentedHandle).adopted,
        false,
        "zombie detected: must become owner, not adopter",
      );
    });

    it("new pidfile contains process.pid", async () => {
      const pf = await readPidFile(ws.pidFilePath);
      assert.ok(pf, "a fresh pidfile must exist after zombie cleanup");
      assert.equal(pf.pid, process.pid);
    });
  });

  // -------------------------------------------------------------------------
  // Test 10: Concurrent boot race
  //
  //   Two startDashboard calls on the same port race simultaneously.
  //   Exactly one must be the owner (adopted:false) and one must adopt
  //   (adopted:true). Both must share the same url. Fastify's EADDRINUSE
  //   from the losing bind must be caught and converted to an adoption.
  // -------------------------------------------------------------------------
  describe("10. concurrent boot race — EADDRINUSE triggers adoption", () => {
    let ws: WorkspaceContext;
    let handles: AugmentedHandle[] = [];
    let port: number;

    before(async () => {
      ws = await makeWorkspace();
      port = await findFreePort();
      const opts = makeOptions(ws.pluginRoot, port);
      // Fire both concurrently — do not await sequentially.
      const results = await Promise.all([
        startDashboard(opts) as Promise<AugmentedHandle>,
        startDashboard(opts) as Promise<AugmentedHandle>,
      ]);
      handles = results;
    });

    after(async () => {
      for (const h of handles) await h.close();
      await ws.cleanup();
    });

    it("exactly one handle is adopted === false (owner)", () => {
      const owners = handles.filter((h) => h.adopted === false);
      assert.equal(owners.length, 1, "exactly one owner expected");
    });

    it("exactly one handle is adopted === true (adopter)", () => {
      const adopters = handles.filter((h) => h.adopted === true);
      assert.equal(adopters.length, 1, "exactly one adopter expected");
    });

    it("both handles share the same url", () => {
      assert.equal(handles[0]!.url, handles[1]!.url);
    });

    it("both handles report url http://127.0.0.1:<port>", () => {
      for (const h of handles) {
        assert.equal(h.url, `http://127.0.0.1:${port}`);
      }
    });

    it("the owner handle pid matches the pidfile", async () => {
      const pf = await readPidFile(ws.pidFilePath);
      assert.ok(pf, "pidfile must exist after race");
      // Both handles are in the same process, so pidfile.pid === process.pid.
      assert.equal(pf.pid, process.pid);
    });
  });

  // -------------------------------------------------------------------------
  // Test 11: Owner close() removes the pidfile
  //
  //   After the owner closes (with no adopters alive), the pidfile must
  //   be absent from disk.
  // -------------------------------------------------------------------------
  describe("11. owner close() removes pidfile", () => {
    let ws: WorkspaceContext;
    let pidFilePathSnapshot: string;

    before(async () => {
      ws = await makeWorkspace();
      const port = await findFreePort();
      const handle = await startDashboard(makeOptions(ws.pluginRoot, port));
      pidFilePathSnapshot = ws.pidFilePath;
      // Close the owner with no adopters around.
      await handle.close();
    });

    after(async () => {
      await ws.cleanup();
    });

    it("pidfile does not exist after owner close()", async () => {
      assert.equal(
        await fileExists(pidFilePathSnapshot),
        false,
        "pidfile must be removed when the owner closes",
      );
    });
  });

  // -------------------------------------------------------------------------
  // Test 12: Adoption when a real dashboard is already alive on port P
  //
  //   Start A on port P. Call startDashboard again on the same port.
  //   Verify adopted:true, no SIGTERM sent to A, A still alive.
  // -------------------------------------------------------------------------
  describe("12. second call on same port returns adopted handle, no steal", () => {
    let ws: WorkspaceContext;
    let handleA: DashboardHandle | null = null;
    let handleB: AugmentedHandle | null = null;
    let portP: number;

    before(async () => {
      ws = await makeWorkspace();
      portP = await findFreePort();
      handleA = await startDashboard(makeOptions(ws.pluginRoot, portP));
      // Second caller, same workspace, same port.
      handleB = await startDashboard(makeOptions(ws.pluginRoot, portP)) as AugmentedHandle;
    });

    after(async () => {
      await handleB?.close();
      await handleA?.close();
      await ws.cleanup();
    });

    it("B is adopted (adopted === true)", () => {
      assert.ok(handleB);
      assert.equal(
        (handleB as AugmentedHandle).adopted,
        true,
        "second caller must adopt, not steal",
      );
    });

    it("B url equals http://127.0.0.1:<portP>", () => {
      assert.ok(handleB);
      assert.equal(handleB.url, `http://127.0.0.1:${portP}`);
    });

    it("A is still alive — B did NOT send SIGTERM", async () => {
      assert.ok(handleA);
      assert.equal(
        await healthStatus(handleA.url),
        200,
        "A must still be reachable, adoption must never SIGTERM the owner",
      );
    });

    it("pidfile PID still points to the original owner (process.pid)", async () => {
      const pf = await readPidFile(ws.pidFilePath);
      assert.ok(pf);
      assert.equal(pf.pid, process.pid);
    });
  });
});
