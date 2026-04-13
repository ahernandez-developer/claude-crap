/**
 * Boot-flow integration tests — one per supported single-project language type.
 *
 * Each test in this suite verifies that the MCP server starts cleanly for a
 * given project layout, correctly identifies the project type via the
 * `list_projects` tool, and successfully scores it via `score_project` without
 * crashing. The focus is on:
 *
 *   - Project discovery (marker-file detection, `isMonorepo` flag)
 *   - LOC counting (workspace walker picks up source files)
 *   - Crash-free execution (server returns valid JSON-RPC for every tool call)
 *
 * Scanner execution is deliberately NOT tested here — the scanners (eslint,
 * bandit, semgrep, dart, dotnet) may not be installed in CI. The tests validate
 * the boot path and project-detection layer only.
 *
 * Supported project types covered:
 *   1. TypeScript   — package.json + tsconfig.json
 *   2. JavaScript   — package.json only, with src/index.js
 *   3. Python       — pyproject.toml + src/main.py
 *   4. Java         — pom.xml + src/Main.java
 *   5. C# / .NET    — MyApp.csproj + Program.cs
 *   6. Dart/Flutter — pubspec.yaml + lib/main.dart
 *   7. Empty        — no source files, should gracefully return LOC = 0
 *
 * The test suite skips entirely when the bundled MCP server entry
 * (`plugin/bundle/mcp-server.mjs`) has not been built yet — consistent with
 * the approach used by `src/tests/integration/mcp-server.integration.test.ts`.
 *
 * @module tests/boot-single-project.test
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Resolve the bundled server entry relative to this test file so the path
// survives both `tsx`-based dev runs and compiled `dist/tests/` executions.
// ---------------------------------------------------------------------------
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
  // The bundle has not been compiled yet — skip the entire suite.
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Thin JSON-RPC client that writes newline-delimited frames to a server
 * process's stdin and dispatches responses from its stdout by request id.
 * Mirrors the `StdioClient` in `mcp-server.integration.test.ts` so both
 * suites stay consistent without a shared module dependency.
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
        continue; // discard non-JSON lines (should not appear on stdout)
      }
      const id = (msg as { id?: number }).id;
      if (typeof id === "number" && this.pending.has(id)) {
        const resolver = this.pending.get(id)!;
        this.pending.delete(id);
        resolver(msg);
      }
    }
  }

  notify(method: string, params?: Record<string, unknown>): void {
    const frame = { jsonrpc: "2.0", method, ...(params ? { params } : {}) };
    this.child.stdin.write(JSON.stringify(frame) + "\n");
  }

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
      this.child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
      );
    });
  }
}

/**
 * Extract the text of the first content block in a `tools/call` response and
 * parse it as JSON. All claude-crap tools return their primary payload as a
 * stringified JSON text block.
 */
function parseFirstContentAsJson(response: unknown): Record<string, unknown> {
  const r = response as {
    result?: { content?: Array<{ type: string; text: string }> };
  };
  const first = r.result?.content?.[0];
  assert.ok(first, "tool call returned no content block");
  assert.equal(first.type, "text", "first content block must be text");
  return JSON.parse(first.text) as Record<string, unknown>;
}

/**
 * Spawn the MCP server process pointing at the given workspace directory.
 * Returns both the raw child process and a `StdioClient` that has already
 * completed the mandatory `initialize` / `notifications/initialized` handshake.
 *
 * @param workspace Absolute path that becomes `CLAUDE_CRAP_PLUGIN_ROOT`.
 */
async function spawnServer(
  workspace: string,
): Promise<{ child: ChildProcessWithoutNullStreams; client: StdioClient }> {
  // Use a random high port to avoid colliding with running plugin instances.
  const dashboardPort = 5300 + Math.floor(Math.random() * 500);

  const child = spawn(process.execPath, [SERVER_ENTRY, "--transport", "stdio"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      CLAUDE_CRAP_LOG_LEVEL: "error",
      CLAUDE_CRAP_PLUGIN_ROOT: workspace,
      CLAUDE_CRAP_DASHBOARD_PORT: String(dashboardPort),
    },
  });

  // Drain stderr to prevent the child's output buffer from filling up and
  // blocking the process. We discard the content — only crashes matter and
  // those surface as JSON-RPC errors or timeouts.
  child.stderr.resume();

  const client = new StdioClient(child);

  await client.request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "boot-single-project-test", version: "0.0.1" },
  });
  client.notify("notifications/initialized");

  return { child, client };
}

/**
 * Gracefully terminate a spawned server process, sending SIGTERM and waiting
 * for the `exit` event (with a SIGKILL safety net after 1.5 s).
 */
async function killServer(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (!child || child.killed) return;
  const exited = new Promise<void>((res) => {
    child.once("exit", () => res());
  });
  child.kill("SIGTERM");
  const killTimer = setTimeout(() => {
    if (!child.killed) child.kill("SIGKILL");
  }, 1_500);
  await exited;
  clearTimeout(killTimer);
}

// ---------------------------------------------------------------------------
// Per-test workspace factories
// ---------------------------------------------------------------------------

/** TypeScript project: package.json + tsconfig.json + src/index.ts */
function makeTypeScriptWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "ccrap-ts-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "ts-project", version: "1.0.0" }),
  );
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } }));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(
    join(dir, "src", "index.ts"),
    [
      "export interface Greeter {",
      "  greet(name: string): string;",
      "}",
      "",
      "export class HelloGreeter implements Greeter {",
      "  greet(name: string): string {",
      '    return `Hello, ${name}!`;',
      "  }",
      "}",
    ].join("\n") + "\n",
  );
  return dir;
}

/**
 * JavaScript project: package.json (no tsconfig) + src/index.js with
 * exactly 10 non-blank, non-comment source lines.
 */
function makeJavaScriptWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "ccrap-js-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "js-project", version: "1.0.0" }),
  );
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(
    join(dir, "src", "index.js"),
    [
      "const PI = Math.PI;",
      "function circleArea(r) {",
      "  return PI * r * r;",
      "}",
      "function circlePerimeter(r) {",
      "  return 2 * PI * r;",
      "}",
      "function add(a, b) { return a + b; }",
      "function sub(a, b) { return a - b; }",
      "module.exports = { circleArea, circlePerimeter, add, sub };",
    ].join("\n") + "\n",
  );
  return dir;
}

/** Python project: pyproject.toml + src/main.py */
function makePythonWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "ccrap-py-"));
  writeFileSync(
    join(dir, "pyproject.toml"),
    [
      "[project]",
      'name = "my-python-project"',
      'version = "0.1.0"',
    ].join("\n") + "\n",
  );
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(
    join(dir, "src", "main.py"),
    [
      "def greet(name: str) -> str:",
      '    return f"Hello, {name}!"',
      "",
      'if __name__ == "__main__":',
      '    print(greet("World"))',
    ].join("\n") + "\n",
  );
  return dir;
}

/** Java project: pom.xml + src/Main.java */
function makeJavaWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "ccrap-java-"));
  writeFileSync(
    join(dir, "pom.xml"),
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<project xmlns="http://maven.apache.org/POM/4.0.0"',
      '         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
      '         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">',
      "  <modelVersion>4.0.0</modelVersion>",
      "  <groupId>com.example</groupId>",
      "  <artifactId>demo</artifactId>",
      "  <version>1.0.0</version>",
      "</project>",
    ].join("\n") + "\n",
  );
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(
    join(dir, "src", "Main.java"),
    [
      "public class Main {",
      "    public static void main(String[] args) {",
      '        System.out.println("Hello, World!");',
      "    }",
      "}",
    ].join("\n") + "\n",
  );
  return dir;
}

/** C# project: MyApp.csproj + Program.cs */
function makeCSharpWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "ccrap-cs-"));
  writeFileSync(
    join(dir, "MyApp.csproj"),
    [
      "<Project Sdk=\"Microsoft.NET.Sdk\">",
      "  <PropertyGroup>",
      "    <OutputType>Exe</OutputType>",
      "    <TargetFramework>net8.0</TargetFramework>",
      "  </PropertyGroup>",
      "</Project>",
    ].join("\n") + "\n",
  );
  writeFileSync(
    join(dir, "Program.cs"),
    [
      "using System;",
      "",
      "class Program {",
      "    static void Main(string[] args) {",
      '        Console.WriteLine("Hello, World!");',
      "    }",
      "}",
    ].join("\n") + "\n",
  );
  return dir;
}

/** Dart/Flutter project: pubspec.yaml + lib/main.dart */
function makeDartWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "ccrap-dart-"));
  writeFileSync(
    join(dir, "pubspec.yaml"),
    [
      "name: my_flutter_app",
      "description: A sample Flutter application.",
      "version: 1.0.0+1",
      "environment:",
      "  sdk: '>=3.0.0 <4.0.0'",
    ].join("\n") + "\n",
  );
  mkdirSync(join(dir, "lib"), { recursive: true });
  writeFileSync(
    join(dir, "lib", "main.dart"),
    [
      "import 'package:flutter/material.dart';",
      "",
      "void main() {",
      "  runApp(const MyApp());",
      "}",
      "",
      "class MyApp extends StatelessWidget {",
      "  const MyApp({super.key});",
      "  @override",
      "  Widget build(BuildContext context) {",
      "    return const MaterialApp(",
      "      home: Scaffold(",
      "        body: Center(child: Text('Hello')),",
      "      ),",
      "    );",
      "  }",
      "}",
    ].join("\n") + "\n",
  );
  return dir;
}

/** Empty workspace: no marker files, no source code. */
function makeEmptyWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "ccrap-empty-"));
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("MCP server boot — single-project language types", { skip: !serverBuilt }, () => {
  // -------------------------------------------------------------------------
  // 1. TypeScript
  // -------------------------------------------------------------------------
  describe("TypeScript project (package.json + tsconfig.json)", () => {
    let workspace = "";
    let child: ChildProcessWithoutNullStreams | null = null;
    let client: StdioClient | null = null;

    before(async () => {
      workspace = makeTypeScriptWorkspace();
      ({ child, client } = await spawnServer(workspace));
    });

    after(async () => {
      if (child) await killServer(child);
      if (workspace) rmSync(workspace, { recursive: true, force: true });
    });

    it("list_projects reports isMonorepo: false for a single-project workspace", async () => {
      const response = await client!.request("tools/call", {
        name: "list_projects",
        arguments: {},
      });
      const payload = parseFirstContentAsJson(response);
      assert.equal(
        payload.isMonorepo,
        false,
        "single TypeScript project root should not be detected as a monorepo",
      );
      assert.ok(
        Array.isArray(payload.projects),
        "projects field must be an array",
      );
    });

    it("score_project returns LOC > 0 and workspaceRoot matching the temp dir", async () => {
      const response = await client!.request<{
        result?: { content?: Array<{ type: string; text: string }>; isError?: boolean };
      }>("tools/call", { name: "score_project", arguments: { format: "json" } });

      // The server must not have set isError on a clean empty project.
      assert.notEqual(
        response.result?.isError,
        true,
        "score_project should not be an error for a clean TS project",
      );

      const blocks = response.result?.content ?? [];
      assert.ok(blocks.length >= 1, "score_project must return at least one content block");

      const score = JSON.parse(blocks[0]!.text) as {
        workspaceRoot: string;
        loc: { physical: number; files: number };
        overall: { passes: boolean };
      };

      assert.ok(
        score.loc.physical > 0,
        `LOC should be > 0 for a TS project with source files, got ${score.loc.physical}`,
      );
      assert.ok(
        score.loc.files > 0,
        `file count should be > 0, got ${score.loc.files}`,
      );
      assert.equal(
        score.workspaceRoot,
        workspace,
        "workspaceRoot in score must match the temp directory",
      );
    });
  });

  // -------------------------------------------------------------------------
  // 2. JavaScript
  // -------------------------------------------------------------------------
  describe("JavaScript project (package.json, no tsconfig)", () => {
    let workspace = "";
    let child: ChildProcessWithoutNullStreams | null = null;
    let client: StdioClient | null = null;

    before(async () => {
      workspace = makeJavaScriptWorkspace();
      ({ child, client } = await spawnServer(workspace));
    });

    after(async () => {
      if (child) await killServer(child);
      if (workspace) rmSync(workspace, { recursive: true, force: true });
    });

    it("list_projects reports isMonorepo: false", async () => {
      const response = await client!.request("tools/call", {
        name: "list_projects",
        arguments: {},
      });
      const payload = parseFirstContentAsJson(response);
      assert.equal(payload.isMonorepo, false);
    });

    it("score_project returns LOC >= 10 for a JS file with 10 source lines", async () => {
      const response = await client!.request<{
        result?: { content?: Array<{ type: string; text: string }> };
      }>("tools/call", { name: "score_project", arguments: { format: "json" } });

      const blocks = response.result?.content ?? [];
      assert.ok(blocks.length >= 1, "score_project must return at least one content block");

      const score = JSON.parse(blocks[0]!.text) as {
        loc: { physical: number };
      };
      assert.ok(
        score.loc.physical >= 10,
        `expected LOC >= 10 for a JS project, got ${score.loc.physical}`,
      );
    });
  });

  // -------------------------------------------------------------------------
  // 3. Python
  // -------------------------------------------------------------------------
  describe("Python project (pyproject.toml + src/main.py)", () => {
    let workspace = "";
    let child: ChildProcessWithoutNullStreams | null = null;
    let client: StdioClient | null = null;

    before(async () => {
      workspace = makePythonWorkspace();
      ({ child, client } = await spawnServer(workspace));
    });

    after(async () => {
      if (child) await killServer(child);
      if (workspace) rmSync(workspace, { recursive: true, force: true });
    });

    it("list_projects returns without error (isMonorepo: false)", async () => {
      const response = await client!.request("tools/call", {
        name: "list_projects",
        arguments: {},
      });
      // Must be a well-formed JSON-RPC result (no top-level `error` key).
      const r = response as { error?: unknown; result?: unknown };
      assert.equal(r.error, undefined, "list_projects must not return a JSON-RPC error");
      const payload = parseFirstContentAsJson(response);
      assert.equal(payload.isMonorepo, false);
    });

    it("score_project completes without crash and counts .py source file", async () => {
      const response = await client!.request<{
        result?: { content?: Array<{ type: string; text: string }>; isError?: boolean };
        error?: unknown;
      }>("tools/call", { name: "score_project", arguments: { format: "json" } });

      assert.equal(response.error, undefined, "score_project must not return a JSON-RPC error");

      const blocks = response.result?.content ?? [];
      assert.ok(blocks.length >= 1, "score_project must return at least one content block");

      const score = JSON.parse(blocks[0]!.text) as {
        loc: { physical: number; files: number };
      };
      assert.ok(
        score.loc.physical > 0,
        `LOC should be > 0 for a Python project, got ${score.loc.physical}`,
      );
      assert.ok(score.loc.files > 0, `file count should be > 0, got ${score.loc.files}`);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Java
  // -------------------------------------------------------------------------
  describe("Java project (pom.xml + src/Main.java)", () => {
    let workspace = "";
    let child: ChildProcessWithoutNullStreams | null = null;
    let client: StdioClient | null = null;

    before(async () => {
      workspace = makeJavaWorkspace();
      ({ child, client } = await spawnServer(workspace));
    });

    after(async () => {
      if (child) await killServer(child);
      if (workspace) rmSync(workspace, { recursive: true, force: true });
    });

    it("list_projects returns without error", async () => {
      const response = await client!.request("tools/call", {
        name: "list_projects",
        arguments: {},
      });
      const r = response as { error?: unknown };
      assert.equal(r.error, undefined, "list_projects must not return a JSON-RPC error");
      const payload = parseFirstContentAsJson(response);
      assert.equal(payload.isMonorepo, false);
    });

    it("score_project completes without crash and LOC counts the .java file", async () => {
      const response = await client!.request<{
        result?: { content?: Array<{ type: string; text: string }> };
        error?: unknown;
      }>("tools/call", { name: "score_project", arguments: { format: "json" } });

      assert.equal(response.error, undefined, "score_project must not return a JSON-RPC error");

      const blocks = response.result?.content ?? [];
      assert.ok(blocks.length >= 1, "score_project must return at least one content block");

      const score = JSON.parse(blocks[0]!.text) as {
        loc: { physical: number; files: number };
      };
      assert.ok(
        score.loc.physical > 0,
        `LOC should be > 0 for a Java project with Main.java, got ${score.loc.physical}`,
      );
      assert.ok(score.loc.files > 0, `file count should be > 0, got ${score.loc.files}`);
    });
  });

  // -------------------------------------------------------------------------
  // 5. C# / .NET
  // -------------------------------------------------------------------------
  describe("C# project (MyApp.csproj + Program.cs)", () => {
    let workspace = "";
    let child: ChildProcessWithoutNullStreams | null = null;
    let client: StdioClient | null = null;

    before(async () => {
      workspace = makeCSharpWorkspace();
      ({ child, client } = await spawnServer(workspace));
    });

    after(async () => {
      if (child) await killServer(child);
      if (workspace) rmSync(workspace, { recursive: true, force: true });
    });

    it("list_projects returns without error", async () => {
      const response = await client!.request("tools/call", {
        name: "list_projects",
        arguments: {},
      });
      const r = response as { error?: unknown };
      assert.equal(r.error, undefined, "list_projects must not return a JSON-RPC error");
      const payload = parseFirstContentAsJson(response);
      assert.equal(payload.isMonorepo, false);
    });

    it("score_project completes without crash and LOC counts the .cs file", async () => {
      const response = await client!.request<{
        result?: { content?: Array<{ type: string; text: string }> };
        error?: unknown;
      }>("tools/call", { name: "score_project", arguments: { format: "json" } });

      assert.equal(response.error, undefined, "score_project must not return a JSON-RPC error");

      const blocks = response.result?.content ?? [];
      assert.ok(blocks.length >= 1, "score_project must return at least one content block");

      const score = JSON.parse(blocks[0]!.text) as {
        loc: { physical: number; files: number };
      };
      assert.ok(
        score.loc.physical > 0,
        `LOC should be > 0 for a C# project with Program.cs, got ${score.loc.physical}`,
      );
      assert.ok(score.loc.files > 0, `file count should be > 0, got ${score.loc.files}`);
    });
  });

  // -------------------------------------------------------------------------
  // 6. Dart / Flutter
  // -------------------------------------------------------------------------
  describe("Dart/Flutter project (pubspec.yaml + lib/main.dart)", () => {
    let workspace = "";
    let child: ChildProcessWithoutNullStreams | null = null;
    let client: StdioClient | null = null;

    before(async () => {
      workspace = makeDartWorkspace();
      ({ child, client } = await spawnServer(workspace));
    });

    after(async () => {
      if (child) await killServer(child);
      if (workspace) rmSync(workspace, { recursive: true, force: true });
    });

    it("list_projects returns without error", async () => {
      const response = await client!.request("tools/call", {
        name: "list_projects",
        arguments: {},
      });
      const r = response as { error?: unknown };
      assert.equal(r.error, undefined, "list_projects must not return a JSON-RPC error");
      const payload = parseFirstContentAsJson(response);
      assert.equal(payload.isMonorepo, false);
    });

    it("score_project completes without crash and LOC counts the .dart file", async () => {
      const response = await client!.request<{
        result?: { content?: Array<{ type: string; text: string }> };
        error?: unknown;
      }>("tools/call", { name: "score_project", arguments: { format: "json" } });

      assert.equal(response.error, undefined, "score_project must not return a JSON-RPC error");

      const blocks = response.result?.content ?? [];
      assert.ok(blocks.length >= 1, "score_project must return at least one content block");

      const score = JSON.parse(blocks[0]!.text) as {
        loc: { physical: number; files: number };
      };
      assert.ok(
        score.loc.physical > 0,
        `LOC should be > 0 for a Dart project with lib/main.dart, got ${score.loc.physical}`,
      );
      assert.ok(score.loc.files > 0, `file count should be > 0, got ${score.loc.files}`);
    });
  });

  // -------------------------------------------------------------------------
  // 7. Empty workspace
  // -------------------------------------------------------------------------
  describe("Empty workspace (no source files)", () => {
    let workspace = "";
    let child: ChildProcessWithoutNullStreams | null = null;
    let client: StdioClient | null = null;

    before(async () => {
      workspace = makeEmptyWorkspace();
      ({ child, client } = await spawnServer(workspace));
    });

    after(async () => {
      if (child) await killServer(child);
      if (workspace) rmSync(workspace, { recursive: true, force: true });
    });

    it("list_projects returns isMonorepo: false and an empty projects array", async () => {
      const response = await client!.request("tools/call", {
        name: "list_projects",
        arguments: {},
      });
      const r = response as { error?: unknown };
      assert.equal(r.error, undefined, "list_projects must not return a JSON-RPC error");
      const payload = parseFirstContentAsJson(response);
      assert.equal(payload.isMonorepo, false);
      assert.deepEqual(
        payload.projects,
        [],
        "empty workspace should have no discovered sub-projects",
      );
    });

    it("score_project completes without crash, LOC = 0, and overall passes quality gate", async () => {
      const response = await client!.request<{
        result?: { content?: Array<{ type: string; text: string }>; isError?: boolean };
        error?: unknown;
      }>("tools/call", { name: "score_project", arguments: { format: "json" } });

      assert.equal(response.error, undefined, "score_project must not return a JSON-RPC error");

      const blocks = response.result?.content ?? [];
      assert.ok(blocks.length >= 1, "score_project must return at least one content block");

      const score = JSON.parse(blocks[0]!.text) as {
        loc: { physical: number };
        overall: { passes: boolean; rating: string };
      };

      assert.equal(
        score.loc.physical,
        0,
        `expected LOC = 0 for an empty workspace, got ${score.loc.physical}`,
      );
      assert.equal(
        score.overall.passes,
        true,
        "an empty workspace with zero findings should pass the quality gate",
      );
    });
  });
});
