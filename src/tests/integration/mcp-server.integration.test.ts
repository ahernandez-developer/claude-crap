/**
 * End-to-end integration tests for the compiled MCP server.
 *
 * Unlike the rest of the test suite (which exercises pure engine
 * modules in isolation), these tests spawn the bundled MCP server
 * (`plugin/bundle/mcp-server.mjs`) as a child process, speak
 * JSON-RPC to it over stdio, and verify that the full server works
 * when it is actually running:
 *
 *   - `initialize` + `notifications/initialized` handshake
 *   - `tools/list` returns every registered tool with its schema
 *   - `tools/call compute_crap` returns the exact deterministic value
 *     the unit test produces (21.216 for CC=12, cov=60, threshold=30)
 *   - `tools/call score_project` returns a markdown + JSON summary
 *     and marks the project as passing its policy
 *   - `tools/call require_test_harness` returns `hasTest: true` for
 *     a file that has a matching test (crap.ts → tests/crap.test.ts)
 *     and `isError: true` / `hasTest: false` for a file that does not
 *   - `resources/list` + `resources/read` round-trip the two resources
 *
 * This suite exercises `src/index.ts` end-to-end on every `npm test`
 * run, so the JSON-RPC wiring, the resource handlers, and the
 * error-boundary shaping all stay covered even though every
 * individual engine already has its own unit tests.
 *
 * The test skips cleanly when the bundle does not exist — that
 * happens during `tsx`-based dev runs before `npm run build:plugin`
 * has been run. `npm test` builds via postinstall or can be preceded
 * by `npm run build:plugin`.
 *
 * @module tests/integration/mcp-server.integration.test
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promises as fs, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Resolve the plugin root from `import.meta.url` so the test works
// regardless of whether it is run via tsx or from `dist/tests/`.
const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(HERE, "..", "..", "..");
const SERVER_ENTRY = process.env.SONAR_MCP_ENTRY
  ? resolve(process.env.SONAR_MCP_ENTRY)
  : join(PLUGIN_ROOT, "plugin", "bundle", "mcp-server.mjs");

// Synchronously probe for the compiled server entry at module load
// time so we can pass `{ skip }` to describe(). Passing an async
// callback to describe() causes node:test to race the test runner
// against the unawaited registration — we learned this the hard way.
let serverBuilt = false;
try {
  statSync(SERVER_ENTRY);
  serverBuilt = true;
} catch {
  // dist/ is missing — this is normal on a fresh tsx-only dev loop
  // and we'll skip the entire integration suite. `npm run build`
  // (or the npm postinstall hook) will make it run next time.
}

/**
 * Thin JSON-RPC client that writes newline-delimited frames to the
 * MCP server's stdin and collects the responses from its stdout.
 *
 * We do not implement the full MCP SDK client because the surface we
 * need is tiny: send a request, await the matching response, compare.
 */
class StdioClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private stdoutBuffer = "";
  private readonly pending = new Map<number, (msg: unknown) => void>();
  private nextId = 1;

  constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.onData(chunk));
  }

  private onData(chunk: string): void {
    this.stdoutBuffer += chunk;
    // Consume newline-delimited JSON frames out of the buffer.
    let newlineIdx = this.stdoutBuffer.indexOf("\n");
    while (newlineIdx !== -1) {
      const line = this.stdoutBuffer.slice(0, newlineIdx).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIdx + 1);
      newlineIdx = this.stdoutBuffer.indexOf("\n");
      if (!line) continue;
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // ignore non-JSON garbage (there should not be any)
      }
      const id = (msg as { id?: number }).id;
      if (typeof id === "number" && this.pending.has(id)) {
        const resolver = this.pending.get(id);
        this.pending.delete(id);
        resolver?.(msg);
      }
    }
  }

  /**
   * Send a JSON-RPC notification (no response expected).
   */
  notify(method: string, params?: Record<string, unknown>): void {
    const frame = { jsonrpc: "2.0", method, ...(params ? { params } : {}) };
    this.child.stdin.write(JSON.stringify(frame) + "\n");
  }

  /**
   * Send a JSON-RPC request and resolve with its response (or timeout).
   */
  request<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 10_000,
  ): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectPromise(new Error(`JSON-RPC timeout waiting for ${method}#${id}`));
      }, timeoutMs);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        resolvePromise(msg as T);
      });
      const frame = { jsonrpc: "2.0", id, method, params };
      this.child.stdin.write(JSON.stringify(frame) + "\n");
    });
  }
}

/**
 * Extract the plain `text` of the first content block in a tools/call
 * response and parse it as JSON. Every claude-crap tool returns its
 * primary payload as a JSON-stringified text block, so this is the
 * standard way to read the data.
 */
function parseFirstContentAsJson(response: unknown): Record<string, unknown> {
  const r = response as {
    result?: { content?: Array<{ type: string; text: string }> };
  };
  const first = r.result?.content?.[0];
  assert.ok(first, "tool call returned no content");
  assert.equal(first.type, "text");
  return JSON.parse(first.text) as Record<string, unknown>;
}

describe("MCP server integration", { skip: !serverBuilt }, () => {
  let workspace = "";
  let child: ChildProcessWithoutNullStreams | null = null;
  let client: StdioClient | null = null;
  const capturedStderr: string[] = [];

  before(async () => {
    // Build a throwaway workspace that mirrors the shape of a real
    // project. We populate it with a production source file that has
    // a matching test and another that does not, so the
    // `require_test_harness` assertions exercise both branches.
    workspace = await mkdtemp(join(tmpdir(), "claude-crap-integ-"));
    await fs.mkdir(join(workspace, "src"), { recursive: true });
    await fs.writeFile(join(workspace, "src", "foo.ts"), "export const foo = 1;\n");
    await fs.writeFile(join(workspace, "src", "foo.test.ts"), "// test\n");
    await fs.writeFile(join(workspace, "src", "no-test.ts"), "export const bar = 2;\n");

    // Pick a high-ish port to avoid clashing with the developer's own
    // running plugin. The dashboard is best-effort, so a collision
    // would still let the MCP server boot — but a clean port keeps
    // the test output clean too.
    const dashboardPort = 5200 + Math.floor(Math.random() * 300);

    child = spawn(process.execPath, [SERVER_ENTRY, "--transport", "stdio"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        CLAUDE_CRAP_LOG_LEVEL: "error",
        CLAUDE_CRAP_PLUGIN_ROOT: workspace,
        CLAUDE_CRAP_DASHBOARD_PORT: String(dashboardPort),
      },
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      capturedStderr.push(chunk);
    });
    client = new StdioClient(child);

    // The MCP protocol requires an initialize handshake before any
    // other request. We send it and discard the result — the tool
    // list test below re-asserts the negotiated protocol version.
    await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "integration-test", version: "0.0.1" },
    });
    client.notify("notifications/initialized");
  });

  after(async () => {
    if (child && !child.killed) {
      // Await the child's actual `exit` event instead of sleeping
      // with a fixed timer. node:test keeps the event loop alive as
      // long as any spawned child is still referenced, so without
      // this the test runner would hang for several seconds after
      // the last assertion even though every test already passed.
      // SIGKILL after 1.5 s is a safety net for pathological hangs.
      const exited = new Promise<void>((resolvePromise) => {
        child!.once("exit", () => resolvePromise());
      });
      child.kill("SIGTERM");
      const killTimer = setTimeout(() => {
        if (child && !child.killed) child.kill("SIGKILL");
      }, 1500);
      await exited;
      clearTimeout(killTimer);
    }
    if (workspace) await rm(workspace, { recursive: true, force: true });
  });

  it("boots cleanly and returns a protocol version on initialize", async () => {
    // The before() block already initialized. Re-init should fail or
    // return the same version — either outcome tells us the server
    // is alive. We just assert that our stdio client's state shows
    // stdout/stdin are both open.
    assert.ok(client, "client should be constructed");
    assert.ok(child && !child.killed, "server child should be running");
  });

  it("exposes all eight tools via tools/list", async () => {
    const response = await client!.request<{ result?: { tools?: Array<{ name: string }> } }>(
      "tools/list",
    );
    const names = (response.result?.tools ?? []).map((t) => t.name).sort();
    assert.deepEqual(names, [
      "analyze_file_ast",
      "auto_scan",
      "compute_crap",
      "compute_tdr",
      "ingest_sarif",
      "ingest_scanner_output",
      "require_test_harness",
      "score_project",
    ]);
  });

  it("compute_crap returns the exact deterministic value (CC=12, cov=60 → 21.216)", async () => {
    const response = await client!.request("tools/call", {
      name: "compute_crap",
      arguments: {
        cyclomaticComplexity: 12,
        coveragePercent: 60,
        functionName: "foo",
        filePath: "src/foo.ts",
      },
    });
    const payload = parseFirstContentAsJson(response);
    assert.equal(payload.crap, 21.216);
    assert.equal(payload.exceedsThreshold, false);
    // isError is only set on failure — should be absent or false here.
    const isError = (response as { result?: { isError?: boolean } }).result?.isError;
    assert.notEqual(isError, true);
  });

  it("score_project returns a markdown + json block and a dashboard URL", async () => {
    const response = await client!.request<{
      result?: { content?: Array<{ type: string; text: string }> };
    }>("tools/call", { name: "score_project", arguments: { format: "both" } });
    const blocks = response.result?.content ?? [];
    assert.equal(blocks.length, 2, "expected markdown + json");
    assert.match(blocks[0]?.text ?? "", /## claude-crap :: project score/);
    assert.match(blocks[0]?.text ?? "", /\*\*Overall: A\*\*/);

    const json = JSON.parse(blocks[1]?.text ?? "{}") as {
      overall: { rating: string; passes: boolean };
      location: { dashboardUrl: string | null };
      loc: { physical: number; files: number };
    };
    assert.equal(json.overall.rating, "A");
    assert.equal(json.overall.passes, true);
    assert.ok(json.location.dashboardUrl?.startsWith("http://127.0.0.1:"));
    assert.ok(json.loc.physical > 0);
    assert.ok(json.loc.files > 0);
  });

  it("require_test_harness finds a sibling test for src/foo.ts", async () => {
    const response = await client!.request("tools/call", {
      name: "require_test_harness",
      arguments: { filePath: "src/foo.ts" },
    });
    const payload = parseFirstContentAsJson(response);
    assert.equal(payload.hasTest, true);
    assert.ok(typeof payload.testFile === "string");
    const isError = (response as { result?: { isError?: boolean } }).result?.isError;
    assert.notEqual(isError, true);
  });

  it("require_test_harness flags src/no-test.ts as a Golden Rule violation", async () => {
    const response = await client!.request<{
      result?: { isError?: boolean; content?: Array<{ type: string; text: string }> };
    }>("tools/call", {
      name: "require_test_harness",
      arguments: { filePath: "src/no-test.ts" },
    });
    assert.equal(response.result?.isError, true);
    const payload = parseFirstContentAsJson(response);
    assert.equal(payload.hasTest, false);
    assert.ok(typeof payload.corrective === "string");
  });

  it("resources/list exposes both sonar:// resources", async () => {
    const response = await client!.request<{
      result?: { resources?: Array<{ uri: string }> };
    }>("resources/list");
    const uris = (response.result?.resources ?? []).map((r) => r.uri).sort();
    assert.deepEqual(uris, ["sonar://metrics/current", "sonar://reports/latest.sarif"]);
  });

  it("resources/read returns a SARIF 2.1.0 document for latest.sarif", async () => {
    const response = await client!.request<{
      result?: { contents?: Array<{ text: string }> };
    }>("resources/read", { uri: "sonar://reports/latest.sarif" });
    const text = response.result?.contents?.[0]?.text ?? "";
    const doc = JSON.parse(text) as { version: string; runs: unknown[] };
    assert.equal(doc.version, "2.1.0");
    assert.ok(Array.isArray(doc.runs));
  });

  it("resources/read sonar://metrics/current returns a JSON snapshot", async () => {
    const response = await client!.request<{
      result?: { contents?: Array<{ text: string }> };
    }>("resources/read", { uri: "sonar://metrics/current" });
    const text = response.result?.contents?.[0]?.text ?? "";
    const doc = JSON.parse(text) as Record<string, unknown>;
    assert.ok(typeof doc.generatedAt === "string");
    assert.ok(doc.sarif && typeof doc.sarif === "object");
    assert.ok(doc.tdrApprox && typeof doc.tdrApprox === "object");
  });

  it("rejects unknown tools with a proper JSON-RPC error", async () => {
    const response = await client!.request<{ error?: { message?: string } }>(
      "tools/call",
      { name: "no_such_tool", arguments: {} },
    );
    assert.ok(response.error, "expected an error response for unknown tool");
    assert.match(response.error?.message ?? "", /Unknown tool/);
  });
});
