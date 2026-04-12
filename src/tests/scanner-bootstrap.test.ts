/**
 * Unit tests for the scanner bootstrap module.
 *
 * Tests project type detection, ESLint config generation, and the
 * bootstrap orchestrator's short-circuit and error paths.
 *
 * @module tests/scanner-bootstrap.test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { detectProjectType, generateEslintConfig } from "../scanner/bootstrap.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "crap-bootstrap-"));
}

describe("detectProjectType", () => {
  it("returns typescript when package.json and tsconfig.json exist", () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, "package.json"), "{}");
      writeFileSync(join(dir, "tsconfig.json"), "{}");
      assert.equal(detectProjectType(dir), "typescript");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns javascript when only package.json exists", () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, "package.json"), "{}");
      assert.equal(detectProjectType(dir), "javascript");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns python when pyproject.toml exists", () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, "pyproject.toml"), "[project]");
      assert.equal(detectProjectType(dir), "python");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns python when setup.py exists", () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, "setup.py"), "from setuptools import setup");
      assert.equal(detectProjectType(dir), "python");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns python when requirements.txt exists", () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, "requirements.txt"), "flask==2.0");
      assert.equal(detectProjectType(dir), "python");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns java when pom.xml exists", () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, "pom.xml"), "<project></project>");
      assert.equal(detectProjectType(dir), "java");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns java when build.gradle exists", () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, "build.gradle"), "plugins {}");
      assert.equal(detectProjectType(dir), "java");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns java when build.gradle.kts exists", () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, "build.gradle.kts"), "plugins {}");
      assert.equal(detectProjectType(dir), "java");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns csharp when .csproj file exists", () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, "MyApp.csproj"), "<Project />");
      assert.equal(detectProjectType(dir), "csharp");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns csharp when .sln file exists", () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, "MyApp.sln"), "");
      assert.equal(detectProjectType(dir), "csharp");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns csharp when Directory.Build.props exists", () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, "Directory.Build.props"), "<Project />");
      assert.equal(detectProjectType(dir), "csharp");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns unknown for an empty directory", () => {
    const dir = makeTmpDir();
    try {
      assert.equal(detectProjectType(dir), "unknown");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("typescript wins over python when both signals present", () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, "package.json"), "{}");
      writeFileSync(join(dir, "tsconfig.json"), "{}");
      writeFileSync(join(dir, "requirements.txt"), "flask");
      assert.equal(detectProjectType(dir), "typescript");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("generateEslintConfig", () => {
  it("TypeScript config includes typescript-eslint import", () => {
    const config = generateEslintConfig(true);
    assert.ok(config.includes('import tseslint from "typescript-eslint"'));
    assert.ok(config.includes("tseslint.config"));
    assert.ok(config.includes("tseslint.configs.recommended"));
  });

  it("JavaScript config uses plain array export", () => {
    const config = generateEslintConfig(false);
    assert.ok(config.includes("export default ["));
    assert.ok(!config.includes("typescript-eslint"));
  });

  it("both configs include standard ignores", () => {
    for (const isTS of [true, false]) {
      const config = generateEslintConfig(isTS);
      assert.ok(config.includes('"dist/"'), `${isTS ? "TS" : "JS"} should ignore dist/`);
      assert.ok(config.includes('"node_modules/"'), `${isTS ? "TS" : "JS"} should ignore node_modules/`);
      assert.ok(config.includes('"coverage/"'), `${isTS ? "TS" : "JS"} should ignore coverage/`);
    }
  });

  it("both configs import @eslint/js", () => {
    for (const isTS of [true, false]) {
      const config = generateEslintConfig(isTS);
      assert.ok(config.includes('import js from "@eslint/js"'));
      assert.ok(config.includes("js.configs.recommended"));
    }
  });
});
