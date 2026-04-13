/**
 * Boot-time monorepo discovery tests.
 *
 * Exercises {@link discoverProjectMap}, {@link persistProjectMap}, and
 * {@link loadProjectMap} across the full range of workspace layouts the
 * plugin supports at boot: npm workspaces (array, object, and glob
 * forms), pnpm-style directory conventions, user-configured projectDirs,
 * polyglot monorepos, project-type detection priority, persistence
 * round-trips, and edge cases such as hidden directories and duplicates.
 *
 * Every test uses a fresh `mkdtempSync` directory and removes it in a
 * `finally` block so failures leave no artefacts on disk.
 *
 * @module tests/boot-monorepo.test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  discoverProjectMap,
  persistProjectMap,
  loadProjectMap,
  type ProjectMap,
  type ProjectEntry,
} from "../monorepo/project-map.js";

// ── Helpers ────────────────────────────────────────────────────────────────

/** Create and return a fresh temporary directory for one test. */
function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "crap-boot-monorepo-"));
}

/**
 * Write `content` to `absPath`, creating every ancestor directory first.
 * Passing no content produces an empty file (sufficient for marker detection).
 */
function touch(absPath: string, content = ""): void {
  mkdirSync(join(absPath, ".."), { recursive: true });
  writeFileSync(absPath, content, "utf8");
}

/**
 * Return the ProjectEntry whose `path` equals `relPath`, or throw an
 * assertion error listing all discovered paths to help diagnose failures.
 */
function findProject(map: ProjectMap, relPath: string): ProjectEntry {
  const entry = map.projects.find((p) => p.path === relPath);
  assert.ok(
    entry,
    `expected project at "${relPath}" — found: [${map.projects.map((p) => p.path).join(", ")}]`,
  );
  return entry;
}

// ── npm workspaces layouts ─────────────────────────────────────────────────

describe("npm workspaces — array format", () => {
  it("discovers exactly the two explicitly listed workspace paths", async () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "root", workspaces: ["apps/web", "apps/api"] }),
      );

      mkdirSync(join(dir, "apps", "web"), { recursive: true });
      writeFileSync(
        join(dir, "apps", "web", "package.json"),
        JSON.stringify({ name: "web" }),
      );
      writeFileSync(join(dir, "apps", "web", "tsconfig.json"), "{}");

      mkdirSync(join(dir, "apps", "api"), { recursive: true });
      writeFileSync(
        join(dir, "apps", "api", "package.json"),
        JSON.stringify({ name: "api" }),
      );

      const map = await discoverProjectMap(dir);

      assert.equal(map.isMonorepo, true);
      assert.equal(map.projects.length, 2);

      const web = findProject(map, "apps/web");
      assert.equal(web.name, "web");
      assert.equal(web.type, "typescript");
      assert.equal(web.scanner, "eslint");

      const api = findProject(map, "apps/api");
      assert.equal(api.name, "api");
      assert.equal(api.type, "javascript");
      assert.equal(api.scanner, "eslint");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("npm workspaces — object { packages: [...] } format", () => {
  it("resolves packages listed under the 'packages' key", async () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({
          name: "root",
          workspaces: { packages: ["packages/*"] },
        }),
      );

      mkdirSync(join(dir, "packages", "ui"), { recursive: true });
      writeFileSync(
        join(dir, "packages", "ui", "package.json"),
        JSON.stringify({ name: "ui" }),
      );
      writeFileSync(join(dir, "packages", "ui", "tsconfig.json"), "{}");

      mkdirSync(join(dir, "packages", "utils"), { recursive: true });
      writeFileSync(
        join(dir, "packages", "utils", "package.json"),
        JSON.stringify({ name: "utils" }),
      );
      writeFileSync(join(dir, "packages", "utils", "tsconfig.json"), "{}");

      const map = await discoverProjectMap(dir);

      assert.equal(map.isMonorepo, true);
      assert.equal(map.projects.length, 2);
      findProject(map, "packages/ui");
      findProject(map, "packages/utils");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("npm workspaces — glob pattern 'packages/*'", () => {
  it("expands the glob and returns one entry per matching subdirectory", async () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "root", workspaces: ["packages/*"] }),
      );

      for (const pkg of ["alpha", "beta", "gamma"]) {
        mkdirSync(join(dir, "packages", pkg), { recursive: true });
        writeFileSync(
          join(dir, "packages", pkg, "package.json"),
          JSON.stringify({ name: pkg }),
        );
      }

      const map = await discoverProjectMap(dir);

      assert.equal(map.isMonorepo, true);
      assert.equal(map.projects.length, 3);
      findProject(map, "packages/alpha");
      findProject(map, "packages/beta");
      findProject(map, "packages/gamma");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("pnpm-style workspace — no package.json workspaces field", () => {
  it("falls back to built-in directory scan and finds projects in apps/", async () => {
    const dir = makeTmpDir();
    try {
      // Root package.json has no workspaces field — simulates pnpm layout
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "root" }),
      );

      mkdirSync(join(dir, "apps", "frontend"), { recursive: true });
      writeFileSync(
        join(dir, "apps", "frontend", "package.json"),
        JSON.stringify({ name: "frontend" }),
      );
      writeFileSync(join(dir, "apps", "frontend", "tsconfig.json"), "{}");

      mkdirSync(join(dir, "apps", "backend"), { recursive: true });
      writeFileSync(
        join(dir, "apps", "backend", "pyproject.toml"),
        "[project]\nname = \"backend\"\n",
      );

      const map = await discoverProjectMap(dir);

      assert.equal(map.isMonorepo, true);
      assert.ok(map.projects.length >= 2);

      const frontend = findProject(map, "apps/frontend");
      assert.equal(frontend.type, "typescript");

      const backend = findProject(map, "apps/backend");
      assert.equal(backend.type, "python");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── Built-in directory conventions ────────────────────────────────────────

describe("built-in directory scan — apps/ only", () => {
  it("discovers both subdirs under apps/", async () => {
    const dir = makeTmpDir();
    try {
      mkdirSync(join(dir, "apps", "web"), { recursive: true });
      touch(join(dir, "apps", "web", "package.json"), "{}");

      mkdirSync(join(dir, "apps", "mobile"), { recursive: true });
      touch(
        join(dir, "apps", "mobile", "pubspec.yaml"),
        "name: mobile\nenvironment:\n  sdk: '>=3.0.0 <4.0.0'\n",
      );

      const map = await discoverProjectMap(dir);

      assert.equal(map.isMonorepo, true);
      assert.equal(map.projects.length, 2);
      findProject(map, "apps/web");
      findProject(map, "apps/mobile");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("built-in directory scan — packages/ only", () => {
  it("discovers both subdirs under packages/", async () => {
    const dir = makeTmpDir();
    try {
      mkdirSync(join(dir, "packages", "core"), { recursive: true });
      touch(join(dir, "packages", "core", "package.json"), "{}");
      touch(join(dir, "packages", "core", "tsconfig.json"), "{}");

      mkdirSync(join(dir, "packages", "ui"), { recursive: true });
      touch(join(dir, "packages", "ui", "package.json"), "{}");
      touch(join(dir, "packages", "ui", "tsconfig.json"), "{}");

      const map = await discoverProjectMap(dir);

      assert.equal(map.isMonorepo, true);
      assert.equal(map.projects.length, 2);
      findProject(map, "packages/core");
      findProject(map, "packages/ui");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("built-in directory scan — libs/ only", () => {
  it("discovers the single subdir under libs/", async () => {
    const dir = makeTmpDir();
    try {
      mkdirSync(join(dir, "libs", "shared"), { recursive: true });
      touch(join(dir, "libs", "shared", "package.json"), "{}");
      touch(join(dir, "libs", "shared", "tsconfig.json"), "{}");

      const map = await discoverProjectMap(dir);

      assert.equal(map.isMonorepo, true);
      assert.equal(map.projects.length, 1);
      const shared = findProject(map, "libs/shared");
      assert.equal(shared.type, "typescript");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("built-in directory scan — modules/ and services/", () => {
  it("discovers one project per conventional directory", async () => {
    const dir = makeTmpDir();
    try {
      mkdirSync(join(dir, "modules", "auth"), { recursive: true });
      touch(join(dir, "modules", "auth", "package.json"), "{}");

      mkdirSync(join(dir, "services", "gateway"), { recursive: true });
      touch(join(dir, "services", "gateway", "package.json"), "{}");
      touch(join(dir, "services", "gateway", "tsconfig.json"), "{}");

      const map = await discoverProjectMap(dir);

      assert.equal(map.isMonorepo, true);
      assert.equal(map.projects.length, 2);
      findProject(map, "modules/auth");
      findProject(map, "services/gateway");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("built-in directory scan — mixed apps/ and packages/", () => {
  it("returns 3 projects across both conventional directories", async () => {
    const dir = makeTmpDir();
    try {
      mkdirSync(join(dir, "apps", "web"), { recursive: true });
      touch(join(dir, "apps", "web", "package.json"), "{}");
      touch(join(dir, "apps", "web", "tsconfig.json"), "{}");

      mkdirSync(join(dir, "packages", "ui"), { recursive: true });
      touch(join(dir, "packages", "ui", "package.json"), "{}");
      touch(join(dir, "packages", "ui", "tsconfig.json"), "{}");

      mkdirSync(join(dir, "packages", "utils"), { recursive: true });
      touch(join(dir, "packages", "utils", "package.json"), "{}");
      touch(join(dir, "packages", "utils", "tsconfig.json"), "{}");

      const map = await discoverProjectMap(dir);

      assert.equal(map.isMonorepo, true);
      assert.equal(map.projects.length, 3);
      findProject(map, "apps/web");
      findProject(map, "packages/ui");
      findProject(map, "packages/utils");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── Custom projectDirs ─────────────────────────────────────────────────────

describe("custom projectDirs — flat root layout", () => {
  it("discovers typescript and python projects by directory name", async () => {
    const dir = makeTmpDir();
    try {
      mkdirSync(join(dir, "frontend"), { recursive: true });
      touch(
        join(dir, "frontend", "package.json"),
        JSON.stringify({ name: "frontend" }),
      );
      touch(join(dir, "frontend", "tsconfig.json"), "{}");

      mkdirSync(join(dir, "backend"), { recursive: true });
      touch(
        join(dir, "backend", "pyproject.toml"),
        "[project]\nname = \"backend\"\n",
      );

      const map = await discoverProjectMap(dir, {
        projectDirs: ["frontend", "backend"],
      });

      assert.equal(map.isMonorepo, true);
      assert.equal(map.projects.length, 2);

      const frontend = findProject(map, "frontend");
      assert.equal(frontend.type, "typescript");
      assert.equal(frontend.scanner, "eslint");

      const backend = findProject(map, "backend");
      assert.equal(backend.type, "python");
      assert.equal(backend.scanner, "bandit");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("custom projectDirs — direct project path", () => {
  it("treats the path as a single project when it has a project marker", async () => {
    const dir = makeTmpDir();
    try {
      mkdirSync(join(dir, "tools", "cli"), { recursive: true });
      touch(
        join(dir, "tools", "cli", "package.json"),
        JSON.stringify({ name: "cli" }),
      );
      touch(join(dir, "tools", "cli", "tsconfig.json"), "{}");

      const map = await discoverProjectMap(dir, {
        projectDirs: ["tools/cli"],
      });

      assert.equal(map.isMonorepo, true);
      assert.equal(map.projects.length, 1);

      const cli = findProject(map, "tools/cli");
      assert.equal(cli.name, "cli");
      assert.equal(cli.type, "typescript");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("custom projectDirs — nested custom dirs", () => {
  it("discovers both deeply nested paths", async () => {
    const dir = makeTmpDir();
    try {
      mkdirSync(join(dir, "domain", "billing"), { recursive: true });
      touch(
        join(dir, "domain", "billing", "package.json"),
        JSON.stringify({ name: "billing" }),
      );
      touch(join(dir, "domain", "billing", "tsconfig.json"), "{}");

      mkdirSync(join(dir, "domain", "users"), { recursive: true });
      touch(
        join(dir, "domain", "users", "package.json"),
        JSON.stringify({ name: "users" }),
      );
      touch(join(dir, "domain", "users", "tsconfig.json"), "{}");

      const map = await discoverProjectMap(dir, {
        projectDirs: ["domain/billing", "domain/users"],
      });

      assert.equal(map.isMonorepo, true);
      assert.equal(map.projects.length, 2);

      const billing = findProject(map, "domain/billing");
      assert.equal(billing.type, "typescript");

      const users = findProject(map, "domain/users");
      assert.equal(users.type, "typescript");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("custom projectDirs — merged with npm workspaces", () => {
  it("includes both workspace and projectDirs entries without duplicates", async () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "root", workspaces: ["apps/web"] }),
      );

      mkdirSync(join(dir, "apps", "web"), { recursive: true });
      touch(
        join(dir, "apps", "web", "package.json"),
        JSON.stringify({ name: "web" }),
      );
      touch(join(dir, "apps", "web", "tsconfig.json"), "{}");

      mkdirSync(join(dir, "infra"), { recursive: true });
      touch(
        join(dir, "infra", "package.json"),
        JSON.stringify({ name: "infra" }),
      );
      touch(join(dir, "infra", "tsconfig.json"), "{}");

      const map = await discoverProjectMap(dir, {
        projectDirs: ["infra"],
      });

      assert.equal(map.isMonorepo, true);

      // Both must be present
      findProject(map, "apps/web");
      findProject(map, "infra");

      // Neither may be duplicated
      const webCount = map.projects.filter((p) => p.path === "apps/web").length;
      const infraCount = map.projects.filter((p) => p.path === "infra").length;
      assert.equal(webCount, 1, "apps/web appeared more than once");
      assert.equal(infraCount, 1, "infra appeared more than once");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("custom projectDirs — non-existent directory", () => {
  it("silently skips missing directories and does not throw", async () => {
    const dir = makeTmpDir();
    try {
      // The referenced directory is intentionally never created.
      const map = await discoverProjectMap(dir, {
        projectDirs: ["doesnt-exist"],
      });

      // Verify no crash — the map may be empty or have other entries.
      assert.equal(typeof map.isMonorepo, "boolean");
      assert.ok(Array.isArray(map.projects));
      const missing = map.projects.find((p) => p.path === "doesnt-exist");
      assert.equal(missing, undefined, "non-existent dir must not appear");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── Polyglot monorepo ──────────────────────────────────────────────────────

describe("polyglot monorepo — full mixed-technology workspace", () => {
  it("detects typescript, dart, and csharp projects with correct scanners", async () => {
    const dir = makeTmpDir();
    try {
      // Root declares only the JS/TS workspaces; Dart and C# are found via scan.
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({
          name: "root",
          workspaces: ["apps/www", "apps/app"],
        }),
      );

      // apps/www — TypeScript (npm workspace)
      mkdirSync(join(dir, "apps", "www"), { recursive: true });
      touch(
        join(dir, "apps", "www", "package.json"),
        JSON.stringify({ name: "www" }),
      );
      touch(join(dir, "apps", "www", "tsconfig.json"), "{}");

      // apps/app — TypeScript (npm workspace)
      mkdirSync(join(dir, "apps", "app"), { recursive: true });
      touch(
        join(dir, "apps", "app", "package.json"),
        JSON.stringify({ name: "app" }),
      );
      touch(join(dir, "apps", "app", "tsconfig.json"), "{}");

      // apps/mobile — Dart / Flutter (discovered via apps/ scan)
      mkdirSync(join(dir, "apps", "mobile"), { recursive: true });
      touch(
        join(dir, "apps", "mobile", "pubspec.yaml"),
        "name: mobile\nenvironment:\n  sdk: '>=3.0.0 <4.0.0'\n",
      );

      // apps/api — C# (discovered via apps/ scan)
      mkdirSync(join(dir, "apps", "api"), { recursive: true });
      touch(
        join(dir, "apps", "api", "MyApp.csproj"),
        "<Project Sdk=\"Microsoft.NET.Sdk\"></Project>",
      );

      const map = await discoverProjectMap(dir);

      assert.equal(map.isMonorepo, true);
      assert.equal(map.projects.length, 4);

      const www = findProject(map, "apps/www");
      assert.equal(www.type, "typescript");
      assert.equal(www.scanner, "eslint");

      const app = findProject(map, "apps/app");
      assert.equal(app.type, "typescript");
      assert.equal(app.scanner, "eslint");

      const mobile = findProject(map, "apps/mobile");
      assert.equal(mobile.type, "dart");
      assert.equal(mobile.scanner, "dart_analyze");

      const api = findProject(map, "apps/api");
      assert.equal(api.type, "csharp");
      assert.equal(api.scanner, "dotnet_format");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── Project type detection ─────────────────────────────────────────────────

describe("project type detection — dart wins over javascript", () => {
  it("returns type 'dart' when pubspec.yaml and package.json both exist", async () => {
    const dir = makeTmpDir();
    try {
      mkdirSync(join(dir, "apps", "hybrid"), { recursive: true });
      touch(
        join(dir, "apps", "hybrid", "pubspec.yaml"),
        "name: hybrid\nenvironment:\n  sdk: '>=3.0.0 <4.0.0'\n",
      );
      touch(
        join(dir, "apps", "hybrid", "package.json"),
        JSON.stringify({ name: "hybrid" }),
      );

      const map = await discoverProjectMap(dir);

      const hybrid = findProject(map, "apps/hybrid");
      assert.equal(hybrid.type, "dart");
      assert.equal(hybrid.scanner, "dart_analyze");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("project type detection — typescript wins over javascript", () => {
  it("returns type 'typescript' when both package.json and tsconfig.json are present", async () => {
    const dir = makeTmpDir();
    try {
      mkdirSync(join(dir, "apps", "ts-app"), { recursive: true });
      touch(
        join(dir, "apps", "ts-app", "package.json"),
        JSON.stringify({ name: "ts-app" }),
      );
      touch(join(dir, "apps", "ts-app", "tsconfig.json"), "{}");

      const map = await discoverProjectMap(dir);

      const tsApp = findProject(map, "apps/ts-app");
      assert.equal(tsApp.type, "typescript");
      assert.equal(tsApp.scanner, "eslint");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("project type detection — C# via .csproj file", () => {
  it("returns type 'csharp' and scanner 'dotnet_format'", async () => {
    const dir = makeTmpDir();
    try {
      mkdirSync(join(dir, "apps", "api"), { recursive: true });
      touch(
        join(dir, "apps", "api", "Server.csproj"),
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
});

describe("project type detection — C# via .sln file", () => {
  it("returns type 'csharp' when only a .sln file is present", async () => {
    const dir = makeTmpDir();
    try {
      mkdirSync(join(dir, "apps", "api"), { recursive: true });
      touch(join(dir, "apps", "api", "Server.sln"), "");

      const map = await discoverProjectMap(dir);

      const api = findProject(map, "apps/api");
      assert.equal(api.type, "csharp");
      assert.equal(api.scanner, "dotnet_format");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("project type detection — Java via build.gradle.kts", () => {
  it("returns type 'java' and scanner 'semgrep'", async () => {
    const dir = makeTmpDir();
    try {
      mkdirSync(join(dir, "apps", "backend"), { recursive: true });
      touch(join(dir, "apps", "backend", "build.gradle.kts"), "");

      const map = await discoverProjectMap(dir);

      const backend = findProject(map, "apps/backend");
      assert.equal(backend.type, "java");
      assert.equal(backend.scanner, "semgrep");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── Persistence ────────────────────────────────────────────────────────────

describe("persistProjectMap / loadProjectMap — round-trip", () => {
  it("loading a persisted map produces a value deeply equal to the original", async () => {
    const dir = makeTmpDir();
    try {
      // Build a real ProjectMap via discovery so all fields are populated.
      mkdirSync(join(dir, "apps", "web"), { recursive: true });
      touch(join(dir, "apps", "web", "package.json"), JSON.stringify({ name: "web" }));
      touch(join(dir, "apps", "web", "tsconfig.json"), "{}");

      mkdirSync(join(dir, "apps", "service"), { recursive: true });
      touch(
        join(dir, "apps", "service", "pyproject.toml"),
        "[project]\nname = \"service\"\n",
      );

      const discovered = await discoverProjectMap(dir);
      await persistProjectMap(discovered, dir);

      const loaded = loadProjectMap(dir);

      assert.ok(loaded !== null, "loadProjectMap returned null after persist");
      assert.deepEqual(loaded, discovered);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("loadProjectMap — no persisted file", () => {
  it("returns null when the .claude-crap/projects.json file does not exist", () => {
    const dir = makeTmpDir();
    try {
      const result = loadProjectMap(dir);
      assert.equal(result, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── Edge cases ─────────────────────────────────────────────────────────────

describe("edge case — hidden directories skipped", () => {
  it("does not include a directory whose name starts with '.'", async () => {
    const dir = makeTmpDir();
    try {
      // Hidden directory with a project marker — must be ignored.
      mkdirSync(join(dir, "apps", ".hidden"), { recursive: true });
      touch(
        join(dir, "apps", ".hidden", "package.json"),
        JSON.stringify({ name: "hidden" }),
      );

      // Visible directory — must be discovered normally.
      mkdirSync(join(dir, "apps", "visible"), { recursive: true });
      touch(
        join(dir, "apps", "visible", "package.json"),
        JSON.stringify({ name: "visible" }),
      );

      const map = await discoverProjectMap(dir);

      const hidden = map.projects.find((p) => p.name === ".hidden");
      assert.equal(hidden, undefined, "hidden directory must not be discovered");

      findProject(map, "apps/visible");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("edge case — empty apps/ directory", () => {
  it("returns isMonorepo false and an empty projects array", async () => {
    const dir = makeTmpDir();
    try {
      // Create apps/ but leave it empty.
      mkdirSync(join(dir, "apps"), { recursive: true });

      const map = await discoverProjectMap(dir);

      assert.equal(map.isMonorepo, false);
      assert.deepEqual(map.projects, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("edge case — duplicate detection", () => {
  it("a project listed in workspaces and also under apps/ appears exactly once", async () => {
    const dir = makeTmpDir();
    try {
      // apps/shared is declared in workspaces AND resides under apps/,
      // which the built-in directory scanner would also traverse.
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "root", workspaces: ["apps/shared"] }),
      );

      mkdirSync(join(dir, "apps", "shared"), { recursive: true });
      touch(
        join(dir, "apps", "shared", "package.json"),
        JSON.stringify({ name: "shared" }),
      );
      touch(join(dir, "apps", "shared", "tsconfig.json"), "{}");

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
