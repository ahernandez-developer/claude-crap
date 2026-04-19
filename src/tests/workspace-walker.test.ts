/**
 * Integration tests for the workspace walker's default exclusions.
 *
 * The LOC denominator of the Technical Debt Ratio must reflect code
 * the team actually writes, not build outputs. Real repositories
 * commonly host Electron-builder outputs (`dist-electron/`,
 * `release/`), .NET outputs (`bin/`, `obj/`, `publish/`), CI outputs
 * (`artifacts/`), and Xcode caches (`DerivedData/`, `Pods/`,
 * `Carthage/`) — all of which would inflate LOC if walked.
 *
 * This suite creates a scratch workspace that seeds a single real
 * source file (`src/app.ts`) alongside populated build-artefact
 * directories, then asserts the walker only counts the real source.
 *
 * @module tests/workspace-walker.test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { estimateWorkspaceLoc } from "../metrics/workspace-walker.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "crap-walker-"));
}

function touch(absPath: string, content = ""): void {
  mkdirSync(join(absPath, ".."), { recursive: true });
  writeFileSync(absPath, content, "utf8");
}

describe("estimateWorkspaceLoc — default skip dirs exclude common build artefacts", () => {
  it("skips Electron/Xcode/.NET/CI build outputs by default", async () => {
    const dir = makeTmpDir();
    try {
      // Single real source file — the only thing that must count.
      touch(join(dir, "src/app.ts"), "export const x = 1;\n");

      // Noise that prior versions would have counted.
      touch(join(dir, "dist-electron/main.js"), "console.log('electron');\n");
      touch(join(dir, "release/MyApp/contents.js"), "console.log('release');\n");
      touch(join(dir, "artifacts/build.js"), "console.log('ci');\n");
      touch(join(dir, "publish/netcoreapp.dll.js"), "// dotnet publish\n");
      touch(join(dir, "bin/Debug/net8.0/app.cs"), "// stale bin output\n");
      touch(join(dir, "obj/project.assets.ts"), "export {};\n");
      touch(join(dir, "Pods/PodStub.swift"), "struct S {}\n");
      touch(join(dir, "DerivedData/ModuleCache/foo.swift"), "struct F {}\n");
      touch(join(dir, "Carthage/Build/cache.swift"), "struct C {}\n");

      const result = await estimateWorkspaceLoc(dir);

      assert.equal(
        result.fileCount,
        1,
        `expected only src/app.ts to count, got fileCount=${result.fileCount}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips generated test coverage report bundles", async () => {
    // Regression: the dashboard flagged GanttLite.Server/coverage-report/main.js
    // (ReportGenerator output) as the hottest file in the project with
    // four CC-80+ errors, all coming from minified `main.js` / `class.js`.
    // The walker must not descend into any coverage-report variant.
    const dir = makeTmpDir();
    try {
      touch(join(dir, "src/real.ts"), "export const x = 1;\n");

      touch(join(dir, "coverage-report/main.js"), "function gG(){return 1}\n");
      touch(join(dir, "coverage-report/class.js"), "function N(){return 1}\n");
      touch(join(dir, "CoverageReport/index.js"), "function a(){}\n");
      touch(join(dir, "coveragereport/bundle.js"), "function b(){}\n");
      touch(join(dir, "TestResults/report.js"), "function c(){}\n");
      touch(join(dir, "cobertura/cobertura.js"), "function d(){}\n");
      touch(join(dir, "lcov-report/prettify.js"), "function e(){}\n");
      touch(join(dir, "htmlcov/pycov.js"), "function f(){}\n");

      const result = await estimateWorkspaceLoc(dir);

      assert.equal(
        result.fileCount,
        1,
        `coverage-report bundles leaked into walk — fileCount=${result.fileCount}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
