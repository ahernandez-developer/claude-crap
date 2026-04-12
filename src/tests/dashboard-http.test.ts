import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promises as fs, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(HERE, "..", "..");
const SERVER_ENTRY = process.env.SONAR_MCP_ENTRY
  ? resolve(process.env.SONAR_MCP_ENTRY)
  : join(PLUGIN_ROOT, "plugin", "bundle", "mcp-server.mjs");

let serverBuilt = false;
try {
  statSync(SERVER_ENTRY);
  serverBuilt = true;
} catch {
}

describe("dashboard HTTP characterization test", { skip: !serverBuilt }, () => {
  let workspace = "";
  let child: ChildProcessWithoutNullStreams | null = null;
  let dashboardUrl = "";
  let dashboardPromise: Promise<string>;

  before(async () => {
    workspace = await mkdtemp(join(tmpdir(), "claude-crap-dashboard-"));

    const dashboardPort = 5700 + Math.floor(Math.random() * 300);

    child = spawn(process.execPath, [SERVER_ENTRY, "--transport", "stdio"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        CLAUDE_CRAP_LOG_LEVEL: "info",
        CLAUDE_CRAP_PLUGIN_ROOT: workspace,
        CLAUDE_CRAP_DASHBOARD_PORT: String(dashboardPort),
      },
    });

    dashboardPromise = new Promise((resolvePromise, rejectPromise) => {
      let stderrBuffer = "";
      child!.stderr.setEncoding("utf8");
      child!.stderr.on("data", (chunk: string) => {
        stderrBuffer += chunk;
        const lines = stderrBuffer.split("\n");
        stderrBuffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line);
            if (parsed.msg === "claude-crap dashboard listening" && parsed.url) {
              resolvePromise(parsed.url);
            }
          } catch {
            // ignore non-JSON or other logs
          }
        }
      });
      child!.on("error", rejectPromise);
      setTimeout(() => rejectPromise(new Error("Timeout waiting for dashboard URL")), 5000);
    });

    // Send initialized handshake so MCP server allows the dashboard to hum along
    const initReq = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "integration-test", version: "0.0.1" },
      },
    };
    child.stdin.write(JSON.stringify(initReq) + "\n");
    
    dashboardUrl = await dashboardPromise;
  });

  after(async () => {
    if (child && !child.killed) {
      child.kill("SIGTERM");
      let killed = false;
      child.once("exit", () => { killed = true; });
      await new Promise(r => setTimeout(r, 100)); // give it a moment
      if (!killed) child.kill("SIGKILL");
    }
    if (workspace) await rm(workspace, { recursive: true, force: true });
  });

  it("fetches the dashboardUrl and asserts 200 OK + text/html", async () => {
    assert.ok(dashboardUrl, "dashboardUrl missing");
    const res = await fetch(dashboardUrl);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
  });

  it("fetches the dashboardUrl + /api/score and asserts 200 OK + JSON response", async () => {
    const res = await fetch(dashboardUrl + "/api/score");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
    const data = await res.json() as Record<string, unknown>;
    assert.ok(data.overall);
  });
});
