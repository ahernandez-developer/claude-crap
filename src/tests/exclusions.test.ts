import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_SKIP_DIRS,
  DEFAULT_SKIP_PATTERNS,
  createExclusionFilter,
} from "../shared/exclusions.js";

describe("DEFAULT_SKIP_DIRS", () => {
  it("includes core directories", () => {
    for (const dir of ["node_modules", ".git", "dist", "build", "bundle", "out", "target", "coverage", "vendor"]) {
      assert.ok(DEFAULT_SKIP_DIRS.has(dir), `missing: ${dir}`);
    }
  });

  it("includes framework build outputs", () => {
    for (const dir of [".next", ".nuxt", ".output", ".vercel", ".svelte-kit", ".astro", ".angular", ".turbo", ".parcel-cache", ".expo"]) {
      assert.ok(DEFAULT_SKIP_DIRS.has(dir), `missing: ${dir}`);
    }
  });

  it("includes language-specific caches", () => {
    for (const dir of [".venv", "venv", "__pycache__", ".cache", ".dart_tool", ".gradle"]) {
      assert.ok(DEFAULT_SKIP_DIRS.has(dir), `missing: ${dir}`);
    }
  });

  it("includes plugin state dirs", () => {
    for (const dir of [".claude-crap", ".codesight"]) {
      assert.ok(DEFAULT_SKIP_DIRS.has(dir), `missing: ${dir}`);
    }
  });

  it("includes Electron/CI/iOS/.NET build outputs", () => {
    // These directories host compiled or packaged artefacts; counting
    // them inflates the LOC denominator of the TDR on every real
    // Electron, Xcode, or .NET workspace.
    for (const dir of [
      "dist-electron",  // Electron-builder
      "release",        // Electron-builder, Tauri
      "artifacts",      // CI, Maven
      "publish",        // dotnet publish
      "bin",            // .NET build
      "obj",            // .NET build
      "Pods",           // CocoaPods
      "DerivedData",    // Xcode
      "Carthage",       // Swift
    ]) {
      assert.ok(DEFAULT_SKIP_DIRS.has(dir), `missing skip dir: ${dir}`);
    }
  });

  it("includes coverage report directories emitted by test tooling", () => {
    // ReportGenerator (.NET), Istanbul (JS) and dotCover emit generated
    // HTML/JS bundles into these folders. Previously only the bare
    // `coverage` name was skipped, which leaked files like
    // `GanttLite.Server/coverage-report/main.js` into complexity scans
    // and flooded the dashboard with false-positive high-CC findings.
    for (const dir of [
      "coverage-report",  // ReportGenerator default
      "CoverageReport",   // ReportGenerator PascalCase
      "coveragereport",   // ReportGenerator lowercase fallback
      "TestResults",      // dotnet test default
      "cobertura",        // Cobertura XML output
      "lcov-report",      // Istanbul HTML reporter
      "htmlcov",          // coverage.py HTML output
    ]) {
      assert.ok(DEFAULT_SKIP_DIRS.has(dir), `missing coverage skip dir: ${dir}`);
    }
  });
});

describe("DEFAULT_SKIP_PATTERNS", () => {
  it("includes minified and bundled file patterns", () => {
    const patterns = new Set(DEFAULT_SKIP_PATTERNS);
    assert.ok(patterns.has("*.min.js"));
    assert.ok(patterns.has("*.min.css"));
    assert.ok(patterns.has("*.bundle.js"));
    assert.ok(patterns.has("*.chunk.js"));
  });
});

describe("createExclusionFilter", () => {
  describe("shouldSkipDir", () => {
    it("skips default directories", () => {
      const filter = createExclusionFilter();
      assert.equal(filter.shouldSkipDir("node_modules"), true);
      assert.equal(filter.shouldSkipDir("dist"), true);
      assert.equal(filter.shouldSkipDir("bundle"), true);
      assert.equal(filter.shouldSkipDir(".next"), true);
      assert.equal(filter.shouldSkipDir(".dart_tool"), true);
    });

    it("allows normal directories", () => {
      const filter = createExclusionFilter();
      assert.equal(filter.shouldSkipDir("src"), false);
      assert.equal(filter.shouldSkipDir("lib"), false);
      assert.equal(filter.shouldSkipDir("apps"), false);
    });

    it("skips hidden directories except .claude-plugin", () => {
      const filter = createExclusionFilter();
      assert.equal(filter.shouldSkipDir(".hidden"), true);
      assert.equal(filter.shouldSkipDir(".secret"), true);
      assert.equal(filter.shouldSkipDir(".claude-plugin"), true);
    });

    it("respects user directory exclusions with trailing slash", () => {
      const filter = createExclusionFilter(["legacy/", "generated/"]);
      assert.equal(filter.shouldSkipDir("legacy"), true);
      assert.equal(filter.shouldSkipDir("generated"), true);
      assert.equal(filter.shouldSkipDir("src"), false);
    });

    it("skips coverage report directories from every major test runner", () => {
      // Regression: the ReportGenerator bundle
      // (`coverage-report/main.js`, `class.js`, etc.) used to surface
      // in the dashboard's complexity hotspots as minified code with
      // CC ≥ 80. These directories must never be walked.
      const filter = createExclusionFilter();
      assert.equal(filter.shouldSkipDir("coverage-report"), true);
      assert.equal(filter.shouldSkipDir("CoverageReport"), true);
      assert.equal(filter.shouldSkipDir("coveragereport"), true);
      assert.equal(filter.shouldSkipDir("TestResults"), true);
      assert.equal(filter.shouldSkipDir("cobertura"), true);
      assert.equal(filter.shouldSkipDir("lcov-report"), true);
      assert.equal(filter.shouldSkipDir("htmlcov"), true);
    });
  });

  describe("shouldSkipFile", () => {
    it("skips default minified patterns", () => {
      const filter = createExclusionFilter();
      assert.equal(filter.shouldSkipFile("lib/app.min.js", "app.min.js"), true);
      assert.equal(filter.shouldSkipFile("styles/main.min.css", "main.min.css"), true);
      assert.equal(filter.shouldSkipFile("lib/vendor.bundle.js", "vendor.bundle.js"), true);
      assert.equal(filter.shouldSkipFile("lib/0.chunk.js", "0.chunk.js"), true);
    });

    it("allows normal source files", () => {
      const filter = createExclusionFilter();
      assert.equal(filter.shouldSkipFile("src/index.ts", "index.ts"), false);
      assert.equal(filter.shouldSkipFile("lib/utils.js", "utils.js"), false);
    });

    it("applies user glob patterns to filenames", () => {
      const filter = createExclusionFilter(["*.proto.ts"]);
      assert.equal(filter.shouldSkipFile("src/api/service.proto.ts", "service.proto.ts"), true);
      assert.equal(filter.shouldSkipFile("src/api/service.ts", "service.ts"), false);
    });

    it("applies user glob patterns to relative paths", () => {
      const filter = createExclusionFilter(["src/generated/**"]);
      assert.equal(filter.shouldSkipFile("src/generated/types.ts", "types.ts"), true);
      assert.equal(filter.shouldSkipFile("src/real/types.ts", "types.ts"), false);
    });

    it("works with empty user exclusions", () => {
      const filter = createExclusionFilter([]);
      assert.equal(filter.shouldSkipFile("src/index.ts", "index.ts"), false);
      assert.equal(filter.shouldSkipFile("lib/app.min.js", "app.min.js"), true);
    });

    it("works with undefined user exclusions", () => {
      const filter = createExclusionFilter();
      assert.equal(filter.shouldSkipFile("src/index.ts", "index.ts"), false);
    });
  });
});
