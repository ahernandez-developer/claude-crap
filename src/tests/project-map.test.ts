/**
 * Unit tests for the project-map discovery module.
 *
 * Covers workspace classification (single-project vs monorepo),
 * per-project language detection across all supported project types,
 * deduplication when a workspace appears in both npm workspaces and
 * directory scan results, and the persist/load round-trip.
 *
 * Each test creates a fresh temporary directory tree and removes it in
 * a `finally` block so failures leave no artefacts on disk.
 *
 * @module tests/project-map.test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  discoverProjectMap,
  persistProjectMap,
  loadProjectMap,
  type ProjectMap,
  type ProjectEntry,
} from "../monorepo/project-map.js";

// ── Helpers ──────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "crap-projmap-"));
}

/**
 * Write a file at `absPath`, creating all parent directories first.
 */
function touch(absPath: string, content = ""): void {
  mkdirSync(join(absPath, ".."), { recursive: true });
  writeFileSync(absPath, content, "utf8");
}

/**
 * Return the ProjectEntry for the given relative path, or throw if absent.
 */
function findProject(map: ProjectMap, relPath: string): ProjectEntry {
  const entry = map.projects.find((p) => p.path === relPath);
  assert.ok(entry, `expected project at path "${relPath}" — found: ${map.projects.map((p) => p.path).join(", ")}`);
  return entry;
}

// ── discoverProjectMap ────────────────────────────────────────────────

describe("discoverProjectMap", () => {
  it("single-project workspace is not a monorepo and has no sub-projects", async () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "my-app" }));
      writeFileSync(join(dir, "tsconfig.json"), "{}");

      const map = await discoverProjectMap(dir);

      assert.equal(map.isMonorepo, false);
      assert.deepEqual(map.projects, []);
      assert.equal(map.workspaceRoot, dir);
      assert.equal(typeof map.generatedAt, "string");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("npm workspaces monorepo detects both sub-projects with correct types", async () => {
    const dir = makeTmpDir();
    try {
      // Root manifest declares workspaces
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "root", workspaces: ["apps/web", "apps/api"] }),
      );

      // apps/web — TypeScript project
      mkdirSync(join(dir, "apps", "web"), { recursive: true });
      writeFileSync(join(dir, "apps", "web", "package.json"), JSON.stringify({ name: "web" }));
      writeFileSync(join(dir, "apps", "web", "tsconfig.json"), "{}");

      // apps/api — plain JavaScript project (no tsconfig)
      mkdirSync(join(dir, "apps", "api"), { recursive: true });
      writeFileSync(join(dir, "apps", "api", "package.json"), JSON.stringify({ name: "api" }));

      const map = await discoverProjectMap(dir);

      assert.equal(map.isMonorepo, true);
      assert.equal(map.projects.length, 2);

      const web = findProject(map, "apps/web");
      assert.equal(web.type, "typescript");
      assert.equal(web.name, "web");

      const api = findProject(map, "apps/api");
      assert.equal(api.type, "javascript");
      assert.equal(api.name, "api");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("mixed monorepo discovers both an npm workspace and a Dart project", async () => {
    const dir = makeTmpDir();
    try {
      // Root declares only apps/web in workspaces; apps/mobile is found by scan
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "root", workspaces: ["apps/web"] }),
      );

      // apps/web — TypeScript
      mkdirSync(join(dir, "apps", "web"), { recursive: true });
      writeFileSync(join(dir, "apps", "web", "package.json"), JSON.stringify({ name: "web" }));
      writeFileSync(join(dir, "apps", "web", "tsconfig.json"), "{}");

      // apps/mobile — Dart / Flutter (discovered via directory scan, not workspaces)
      mkdirSync(join(dir, "apps", "mobile"), { recursive: true });
      writeFileSync(
        join(dir, "apps", "mobile", "pubspec.yaml"),
        "name: mobile\nenvironment:\n  sdk: '>=3.0.0 <4.0.0'\n",
      );

      const map = await discoverProjectMap(dir);

      assert.equal(map.isMonorepo, true);

      const web = findProject(map, "apps/web");
      assert.equal(web.type, "typescript");

      const mobile = findProject(map, "apps/mobile");
      assert.equal(mobile.type, "dart");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Python project is detected with type 'python' and scanner 'bandit'", async () => {
    const dir = makeTmpDir();
    try {
      // Root with no workspaces — but has a sub-directory with Python signals
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "root", workspaces: ["apps/ml"] }),
      );

      mkdirSync(join(dir, "apps", "ml"), { recursive: true });
      writeFileSync(
        join(dir, "apps", "ml", "pyproject.toml"),
        "[project]\nname = \"ml\"\n",
      );

      const map = await discoverProjectMap(dir);

      const ml = findProject(map, "apps/ml");
      assert.equal(ml.type, "python");
      assert.equal(ml.scanner, "bandit");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Java project is detected with type 'java' and scanner 'dotnet_format'", async () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "root", workspaces: ["apps/backend"] }),
      );

      mkdirSync(join(dir, "apps", "backend"), { recursive: true });
      writeFileSync(
        join(dir, "apps", "backend", "pom.xml"),
        "<project><modelVersion>4.0.0</modelVersion></project>",
      );

      const map = await discoverProjectMap(dir);

      const backend = findProject(map, "apps/backend");
      assert.equal(backend.type, "java");
      assert.equal(backend.scanner, "semgrep");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("C# project is detected with type 'csharp' and scanner 'dotnet_format'", async () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "root", workspaces: ["apps/api"] }),
      );

      mkdirSync(join(dir, "apps", "api"), { recursive: true });
      writeFileSync(
        join(dir, "apps", "api", "MyApp.csproj"),
        "<Project Sdk=\"Microsoft.NET.Sdk\"></Project>",
      );

      const map = await discoverProjectMap(dir);

      const api = findProject(map, "apps/api");
      assert.equal(api.type, "csharp");
      assert.equal(api.scanner, "dotnet_format");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("empty workspace returns isMonorepo false and an empty projects array", async () => {
    const dir = makeTmpDir();
    try {
      const map = await discoverProjectMap(dir);

      assert.equal(map.isMonorepo, false);
      assert.deepEqual(map.projects, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("project listed in npm workspaces AND found by directory scan appears only once", async () => {
    const dir = makeTmpDir();
    try {
      // apps/shared is declared in workspaces; it also lives inside apps/
      // which the directory scanner would naturally traverse
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "root", workspaces: ["apps/shared"] }),
      );

      mkdirSync(join(dir, "apps", "shared"), { recursive: true });
      writeFileSync(join(dir, "apps", "shared", "package.json"), JSON.stringify({ name: "shared" }));
      writeFileSync(join(dir, "apps", "shared", "tsconfig.json"), "{}");

      const map = await discoverProjectMap(dir);

      const matches = map.projects.filter((p) => p.path === "apps/shared");
      assert.equal(
        matches.length,
        1,
        `expected exactly 1 entry for "apps/shared", got ${matches.length}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── persistProjectMap / loadProjectMap ───────────────────────────────

describe("persistProjectMap / loadProjectMap", () => {
  it("persisted map round-trips through loadProjectMap with deep equality", async () => {
    const dir = makeTmpDir();
    try {
      const original: ProjectMap = {
        generatedAt: new Date().toISOString(),
        workspaceRoot: dir,
        isMonorepo: true,
        projects: [
          {
            name: "web",
            path: "apps/web",
            type: "typescript",
            scanner: "eslint",
            scannerAvailable: true,
          },
          {
            name: "ml",
            path: "apps/ml",
            type: "python",
            scanner: "bandit",
            scannerAvailable: false,
          },
        ],
      };

      await persistProjectMap(original, dir);
      const loaded = loadProjectMap(dir);

      assert.ok(loaded !== null, "loadProjectMap returned null after persist");
      assert.deepEqual(loaded, original);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loadProjectMap returns null when no persisted file exists", () => {
    const dir = makeTmpDir();
    try {
      const result = loadProjectMap(dir);
      assert.equal(result, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("non-monorepo map round-trips through persist + load", async () => {
    // list_projects and /api/score rely on projects.json existing after
    // a discovery run, even when the workspace has no sub-projects. The
    // persist + load pair must handle `isMonorepo: false` the same as
    // monorepo maps.
    const dir = makeTmpDir();
    try {
      const original: ProjectMap = {
        generatedAt: new Date().toISOString(),
        workspaceRoot: dir,
        isMonorepo: false,
        projects: [],
      };

      await persistProjectMap(original, dir);
      const loaded = loadProjectMap(dir);

      assert.ok(loaded !== null, "non-monorepo map did not persist");
      assert.equal(loaded.isMonorepo, false);
      assert.deepEqual(loaded, original);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── .slnx / Directory.Build.props detection ──────────────────────────

describe("discoverProjectMap — .NET project markers", () => {
  it(".slnx (.NET 9 XML solution) marks csharp", async () => {
    const dir = makeTmpDir();
    try {
      mkdirSync(join(dir, "apps", "api"), { recursive: true });
      writeFileSync(join(dir, "apps", "api", "MyApp.slnx"), "<Solution></Solution>");

      const map = await discoverProjectMap(dir);
      const api = findProject(map, "apps/api");
      assert.equal(api.type, "csharp", "expected .slnx to classify as csharp");
      assert.equal(api.scanner, "dotnet_format");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Directory.Build.props alone marks csharp", async () => {
    const dir = makeTmpDir();
    try {
      mkdirSync(join(dir, "apps", "shared-lib"), { recursive: true });
      writeFileSync(
        join(dir, "apps", "shared-lib", "Directory.Build.props"),
        "<Project></Project>",
      );

      const map = await discoverProjectMap(dir);
      const p = findProject(map, "apps/shared-lib");
      assert.equal(p.type, "csharp", "Directory.Build.props should classify as csharp");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── pnpm-workspace.yaml discovery ────────────────────────────────────

describe("discoverProjectMap — pnpm-workspace.yaml", () => {
  it("reads pnpm-workspace.yaml and discovers declared packages", async () => {
    const dir = makeTmpDir();
    try {
      // Non-conventional parent dir that the built-in apps/packages scan
      // would never find. pnpm-workspace must be the only source of truth.
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "root" }));
      writeFileSync(
        join(dir, "pnpm-workspace.yaml"),
        ["packages:", "  - \"tooling/*\"", ""].join("\n"),
      );

      mkdirSync(join(dir, "tooling", "cli"), { recursive: true });
      writeFileSync(join(dir, "tooling", "cli", "package.json"), JSON.stringify({ name: "cli" }));
      writeFileSync(join(dir, "tooling", "cli", "tsconfig.json"), "{}");

      const map = await discoverProjectMap(dir);
      const cli = findProject(map, "tooling/cli");
      assert.equal(cli.type, "typescript");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("handles plain-path entries in pnpm-workspace.yaml", async () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "root" }));
      writeFileSync(
        join(dir, "pnpm-workspace.yaml"),
        ["packages:", "  - 'clients/mobile'", ""].join("\n"),
      );

      mkdirSync(join(dir, "clients", "mobile"), { recursive: true });
      writeFileSync(
        join(dir, "clients", "mobile", "package.json"),
        JSON.stringify({ name: "mobile" }),
      );

      const map = await discoverProjectMap(dir);
      const mobile = findProject(map, "clients/mobile");
      assert.equal(mobile.type, "javascript"); // no tsconfig → js
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back gracefully when pnpm-workspace.yaml is malformed", async () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "root" }));
      writeFileSync(
        join(dir, "pnpm-workspace.yaml"),
        "this: is: not: actually: valid: yaml\n",
      );

      // Must not throw.
      const map = await discoverProjectMap(dir);
      assert.ok(Array.isArray(map.projects));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
