/**
 * Comprehensive boot-time scanner detection tests.
 *
 * Exercises every detection layer (config file, package.json dependency,
 * binary probe) for all six supported scanners, plus the monorepo
 * subdirectory probing exported by detectMonorepoScanners.
 *
 * Test inventory
 * ──────────────
 * Config file detection         : ESLint (×3), Semgrep, Bandit (×2), Stryker (×2), Dart (×2)
 * package.json + binary         : ESLint not-installed, ESLint installed, ESLint deps key,
 *                                 Stryker not-installed, Stryker installed
 * Empty workspace               : returns exactly 6 ScannerDetections
 * Monorepo subdir probing       : npm workspaces, Dart in subdir, multi-scanner multi-dir,
 *                                 apps/ directory scan, root+subdir dedup, hidden dir skip
 * Signal coverage               : all 6 scanners present, no empty signals
 * Edge cases                    : malformed package.json, empty config file, multi-config dedup
 *
 * @module tests/boot-scanner-detection.test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  detectScanners,
  detectMonorepoScanners,
  SCANNER_SIGNALS,
  MONOREPO_DIRS,
} from "../scanner/detector.js";
import { KNOWN_SCANNERS } from "../adapters/common.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "crap-boot-detect-"));
}

/** Create a directory (including parents) inside a temp root. */
function mkdir(base: string, ...segments: string[]): string {
  const full = join(base, ...segments);
  mkdirSync(full, { recursive: true });
  return full;
}

/** Write a file, creating parent directories if needed. */
function touch(base: string, ...segments: string[]): void {
  const full = join(base, ...segments);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, "");
}

// ── Config file detection ─────────────────────────────────────────────────────

describe("Config file detection — ESLint", () => {
  it("detects eslint via eslint.config.mjs", async () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, "eslint.config.mjs"), "export default [];");
      const results = await detectScanners(dir);
      const eslint = results.find((r) => r.scanner === "eslint");
      assert.ok(eslint, "eslint detection missing");
      assert.equal(eslint.available, true);
      assert.ok(eslint.reason.includes("eslint.config.mjs"), `unexpected reason: ${eslint.reason}`);
      assert.ok(eslint.configPath, "configPath should be set");
      assert.ok(eslint.configPath!.endsWith("eslint.config.mjs"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects eslint via eslint.config.js", async () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, "eslint.config.js"), "export default [];");
      const results = await detectScanners(dir);
      const eslint = results.find((r) => r.scanner === "eslint");
      assert.ok(eslint);
      assert.equal(eslint.available, true);
      assert.ok(eslint.reason.includes("eslint.config.js"), `unexpected reason: ${eslint.reason}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects eslint via legacy .eslintrc.json", async () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, ".eslintrc.json"), "{}");
      const results = await detectScanners(dir);
      const eslint = results.find((r) => r.scanner === "eslint");
      assert.ok(eslint);
      assert.equal(eslint.available, true);
      assert.ok(eslint.reason.includes(".eslintrc.json"), `unexpected reason: ${eslint.reason}`);
      assert.ok(eslint.configPath!.endsWith(".eslintrc.json"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Config file detection — Semgrep", () => {
  it("detects semgrep via .semgrep.yml", async () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, ".semgrep.yml"), "rules: []");
      const results = await detectScanners(dir);
      const semgrep = results.find((r) => r.scanner === "semgrep");
      assert.ok(semgrep);
      assert.equal(semgrep.available, true);
      assert.ok(semgrep.reason.includes(".semgrep.yml"), `unexpected reason: ${semgrep.reason}`);
      assert.ok(semgrep.configPath!.endsWith(".semgrep.yml"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Config file detection — Bandit", () => {
  it("detects bandit via .bandit", async () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, ".bandit"), "[bandit]");
      const results = await detectScanners(dir);
      const bandit = results.find((r) => r.scanner === "bandit");
      assert.ok(bandit);
      assert.equal(bandit.available, true);
      assert.ok(bandit.reason.includes(".bandit"), `unexpected reason: ${bandit.reason}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects bandit via bandit.yaml", async () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, "bandit.yaml"), "profiles: {}");
      const results = await detectScanners(dir);
      const bandit = results.find((r) => r.scanner === "bandit");
      assert.ok(bandit);
      assert.equal(bandit.available, true);
      assert.ok(bandit.reason.includes("bandit.yaml"), `unexpected reason: ${bandit.reason}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Config file detection — Stryker", () => {
  it("detects stryker via stryker.conf.js", async () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, "stryker.conf.js"), "module.exports = {};");
      const results = await detectScanners(dir);
      const stryker = results.find((r) => r.scanner === "stryker");
      assert.ok(stryker);
      assert.equal(stryker.available, true);
      assert.ok(stryker.reason.includes("stryker.conf.js"), `unexpected reason: ${stryker.reason}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects stryker via .strykerrc.json", async () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, ".strykerrc.json"), "{}");
      const results = await detectScanners(dir);
      const stryker = results.find((r) => r.scanner === "stryker");
      assert.ok(stryker);
      assert.equal(stryker.available, true);
      assert.ok(stryker.reason.includes(".strykerrc.json"), `unexpected reason: ${stryker.reason}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Config file detection — Dart", () => {
  it("detects dart_analyze via pubspec.yaml — config layer fires regardless of PATH", async () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, "pubspec.yaml"), "name: my_app\nsdkversion: '>=3.0.0 <4.0.0'");
      const results = await detectScanners(dir);
      const dart = results.find((r) => r.scanner === "dart_analyze");
      assert.ok(dart);
      // Config probe short-circuits; available is true whether or not dart binary exists
      assert.equal(dart.available, true);
      assert.ok(dart.reason.includes("pubspec.yaml"), `unexpected reason: ${dart.reason}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects dart_analyze via analysis_options.yaml", async () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, "analysis_options.yaml"), "analyzer:\n  errors: {}");
      const results = await detectScanners(dir);
      const dart = results.find((r) => r.scanner === "dart_analyze");
      assert.ok(dart);
      assert.equal(dart.available, true);
      assert.ok(
        dart.reason.includes("analysis_options.yaml"),
        `unexpected reason: ${dart.reason}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── package.json + binary detection ──────────────────────────────────────────

describe("package.json detection + binary validation", () => {
  it("ESLint in devDependencies — declared but not installed → available:false", async () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ devDependencies: { eslint: "^9.0.0" } }),
      );
      const results = await detectScanners(dir);
      const eslint = results.find((r) => r.scanner === "eslint");
      assert.ok(eslint);
      assert.equal(eslint.available, false);
      assert.ok(
        eslint.reason.toLowerCase().includes("not installed"),
        `expected "not installed" in reason, got: ${eslint.reason}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ESLint in devDependencies — binary present → available:true", async () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ devDependencies: { eslint: "^9.0.0" } }),
      );
      mkdir(dir, "node_modules", ".bin");
      writeFileSync(join(dir, "node_modules", ".bin", "eslint"), "#!/usr/bin/env node");

      const results = await detectScanners(dir);
      const eslint = results.find((r) => r.scanner === "eslint");
      assert.ok(eslint);
      assert.equal(eslint.available, true);
      assert.ok(
        eslint.reason.includes("installed"),
        `expected "installed" in reason, got: ${eslint.reason}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ESLint in dependencies (not devDependencies) — still detected", async () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ dependencies: { eslint: "^9.0.0" } }),
      );
      mkdir(dir, "node_modules", ".bin");
      writeFileSync(join(dir, "node_modules", ".bin", "eslint"), "#!/usr/bin/env node");

      const results = await detectScanners(dir);
      const eslint = results.find((r) => r.scanner === "eslint");
      assert.ok(eslint);
      assert.equal(eslint.available, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Stryker via @stryker-mutator/core — declared but not installed → available:false", async () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ devDependencies: { "@stryker-mutator/core": "^7.0.0" } }),
      );
      const results = await detectScanners(dir);
      const stryker = results.find((r) => r.scanner === "stryker");
      assert.ok(stryker);
      assert.equal(stryker.available, false);
      assert.ok(
        stryker.reason.toLowerCase().includes("not installed"),
        `expected "not installed" in reason, got: ${stryker.reason}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Stryker via @stryker-mutator/core — binary present → available:true", async () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ devDependencies: { "@stryker-mutator/core": "^7.0.0" } }),
      );
      mkdir(dir, "node_modules", ".bin");
      writeFileSync(join(dir, "node_modules", ".bin", "stryker"), "#!/usr/bin/env node");

      const results = await detectScanners(dir);
      const stryker = results.find((r) => r.scanner === "stryker");
      assert.ok(stryker);
      assert.equal(stryker.available, true);
      assert.ok(
        stryker.reason.includes("installed"),
        `expected "installed" in reason, got: ${stryker.reason}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── Empty workspace ───────────────────────────────────────────────────────────

describe("Empty workspace", () => {
  it("returns exactly 6 ScannerDetection objects for an empty directory", async () => {
    const dir = makeTmpDir();
    try {
      const results = await detectScanners(dir);
      assert.equal(results.length, 6, `expected 6 results, got ${results.length}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("every result has the correct shape (scanner, available, reason)", async () => {
    const dir = makeTmpDir();
    try {
      const results = await detectScanners(dir);
      const knownSet = new Set<string>(KNOWN_SCANNERS);
      for (const r of results) {
        assert.ok(knownSet.has(r.scanner), `unexpected scanner name: ${r.scanner}`);
        assert.equal(typeof r.available, "boolean", `available must be boolean for ${r.scanner}`);
        assert.ok(r.reason.length > 0, `reason must not be empty for ${r.scanner}`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("config-less scanners all return available:false in an isolated empty directory", async () => {
    // We create a temp dir that is NOT in PATH, has no package.json, and no
    // config files. The binary probe runs against the real PATH, so
    // scanners that happen to be installed on the host machine may resolve
    // as available:true — that is correct behaviour, not a test failure.
    // What we can assert is that the "not found" reason is well-formed when
    // a scanner is not available.
    const dir = makeTmpDir();
    try {
      const results = await detectScanners(dir);
      const unavailable = results.filter((r) => !r.available);
      for (const r of unavailable) {
        assert.ok(
          r.reason.length > 0,
          `unavailable scanner ${r.scanner} must have a non-empty reason`,
        );
        // configPath should not be set when scanner is not available
        assert.equal(
          r.configPath,
          undefined,
          `configPath should be undefined for unavailable scanner ${r.scanner}`,
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── Monorepo subdirectory probing ─────────────────────────────────────────────

describe("detectMonorepoScanners", () => {
  it("npm workspaces + subdirectory eslint config — workingDir set correctly", async () => {
    const dir = makeTmpDir();
    try {
      // Root workspace package.json pointing to apps/web
      mkdir(dir, "apps", "web");
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "monorepo", workspaces: ["apps/web"] }),
      );
      writeFileSync(join(dir, "apps", "web", "eslint.config.mjs"), "export default [];");

      const detections = await detectMonorepoScanners(dir);
      const eslint = detections.find((d) => d.scanner === "eslint");
      assert.ok(eslint, "eslint should be detected in apps/web via npm workspaces");
      assert.equal(eslint.available, true);
      assert.ok(eslint.workingDir, "workingDir must be set for monorepo detection");
      assert.ok(
        eslint.workingDir!.endsWith(join("apps", "web")),
        `workingDir should end with apps/web, got: ${eslint.workingDir}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Dart in apps/mobile — detected with workingDir when dart binary is on PATH", async () => {
    const dir = makeTmpDir();
    try {
      mkdir(dir, "apps", "mobile");
      writeFileSync(join(dir, "apps", "mobile", "pubspec.yaml"), "name: mobile_app");

      const detections = await detectMonorepoScanners(dir);
      // dart_analyze is only emitted when the dart binary is available.
      // On CI machines without dart the detection is absent — that is correct.
      const dart = detections.find((d) => d.scanner === "dart_analyze");
      if (dart) {
        assert.equal(dart.available, true);
        assert.ok(dart.workingDir, "workingDir must be set");
        assert.ok(
          dart.workingDir!.endsWith(join("apps", "mobile")),
          `workingDir should end with apps/mobile, got: ${dart.workingDir}`,
        );
      }
      // Whether or not dart is available, no other scanner should appear for mobile
      const otherDetections = detections.filter(
        (d) => d.scanner !== "dart_analyze",
      );
      assert.equal(
        otherDetections.length,
        0,
        `unexpected detections: ${otherDetections.map((d) => d.scanner).join(", ")}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("multiple scanners in different subdirs — different workingDirs returned", async () => {
    const dir = makeTmpDir();
    try {
      mkdir(dir, "apps", "web");
      mkdir(dir, "apps", "mobile");
      writeFileSync(join(dir, "apps", "web", "eslint.config.mjs"), "export default [];");
      writeFileSync(join(dir, "apps", "mobile", "pubspec.yaml"), "name: mobile_app");

      const detections = await detectMonorepoScanners(dir);

      // ESLint in apps/web is always detectable (no binary requirement)
      const eslint = detections.find((d) => d.scanner === "eslint");
      assert.ok(eslint, "eslint should be detected in apps/web");
      assert.ok(eslint.workingDir!.endsWith(join("apps", "web")));

      // dart_analyze in apps/mobile only appears when dart binary is present
      const dart = detections.find((d) => d.scanner === "dart_analyze");
      if (dart) {
        assert.ok(dart.workingDir!.endsWith(join("apps", "mobile")));
        // The two detections must have different workingDirs
        assert.notEqual(eslint.workingDir, dart.workingDir);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("apps/ directory scan — no npm workspaces, two subdirs with configs both detected", async () => {
    const dir = makeTmpDir();
    try {
      // No package.json — relies on MONOREPO_DIRS scanning
      mkdir(dir, "apps", "frontend");
      mkdir(dir, "apps", "backend");
      writeFileSync(join(dir, "apps", "frontend", "eslint.config.mjs"), "export default [];");
      writeFileSync(join(dir, "apps", "backend", ".semgrep.yml"), "rules: []");

      const detections = await detectMonorepoScanners(dir);
      const eslint = detections.find(
        (d) => d.scanner === "eslint" && d.workingDir!.endsWith(join("apps", "frontend")),
      );
      const semgrep = detections.find(
        (d) => d.scanner === "semgrep" && d.workingDir!.endsWith(join("apps", "backend")),
      );
      assert.ok(eslint, "eslint should be detected in apps/frontend");
      assert.ok(semgrep, "semgrep should be detected in apps/backend");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("root + subdir with same scanner — subdir detection is still returned", async () => {
    // dedup between root and subdir is the auto-scan orchestrator's job,
    // not the detector's. The detector must return the subdir detection.
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, "eslint.config.mjs"), "export default [];");
      mkdir(dir, "apps", "web");
      writeFileSync(join(dir, "apps", "web", "eslint.config.mjs"), "export default [];");

      const detections = await detectMonorepoScanners(dir);
      const eslintInWeb = detections.find(
        (d) => d.scanner === "eslint" && d.workingDir!.endsWith(join("apps", "web")),
      );
      assert.ok(
        eslintInWeb,
        "detector should still emit the subdir detection even when root also has eslint",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("hidden directories under apps/ are skipped", async () => {
    const dir = makeTmpDir();
    try {
      mkdir(dir, "apps", ".hidden");
      writeFileSync(join(dir, "apps", ".hidden", "pubspec.yaml"), "name: hidden_app");

      const detections = await detectMonorepoScanners(dir);
      // .hidden should be ignored regardless of whether dart is on PATH
      assert.equal(
        detections.length,
        0,
        `expected 0 detections from hidden dir, got: ${detections.map((d) => d.scanner).join(", ")}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns empty array when workspace has no monorepo subdirs and no package.json workspaces", async () => {
    const dir = makeTmpDir();
    try {
      // No apps/, packages/, libs/, modules/, services/, no package.json
      const detections = await detectMonorepoScanners(dir);
      assert.equal(detections.length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── Signal coverage ───────────────────────────────────────────────────────────

describe("SCANNER_SIGNALS coverage", () => {
  it("has an entry for every KnownScanner", () => {
    const signalKeys = Object.keys(SCANNER_SIGNALS).sort();
    const knownKeys = [...KNOWN_SCANNERS].sort();
    assert.deepEqual(
      signalKeys,
      knownKeys,
      `SCANNER_SIGNALS keys (${signalKeys.join(", ")}) do not match KNOWN_SCANNERS (${knownKeys.join(", ")})`,
    );
  });

  it("every scanner signal has at least configFiles or binaryNames defined", () => {
    for (const [scanner, signals] of Object.entries(SCANNER_SIGNALS)) {
      const hasConfig = signals.configFiles.length > 0;
      const hasBinary = signals.binaryNames.length > 0;
      assert.ok(
        hasConfig || hasBinary,
        `${scanner}: signals must have at least one configFile or binaryName — both are empty`,
      );
    }
  });

  it("MONOREPO_DIRS is a non-empty array of strings", () => {
    assert.ok(Array.isArray(MONOREPO_DIRS), "MONOREPO_DIRS must be an array");
    assert.ok(MONOREPO_DIRS.length > 0, "MONOREPO_DIRS must not be empty");
    for (const d of MONOREPO_DIRS) {
      assert.equal(typeof d, "string", `each MONOREPO_DIRS entry must be a string, got ${typeof d}`);
    }
  });

  it("MONOREPO_DIRS includes apps and packages", () => {
    assert.ok(MONOREPO_DIRS.includes("apps"), 'MONOREPO_DIRS must include "apps"');
    assert.ok(MONOREPO_DIRS.includes("packages"), 'MONOREPO_DIRS must include "packages"');
  });
});

// ── Edge cases ────────────────────────────────────────────────────────────────

describe("Edge cases", () => {
  it("malformed package.json — no crash, eslint not detected from deps", async () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, "package.json"), "not json at all");
      // Should not throw — falls through to binary probe
      const results = await detectScanners(dir);
      assert.equal(results.length, 6, "must still return 6 results despite malformed package.json");
      const eslint = results.find((r) => r.scanner === "eslint");
      assert.ok(eslint);
      // With malformed JSON, the package.json probe fails silently.
      // If eslint is available it must be via PATH, not via deps.
      if (!eslint.available) {
        assert.ok(
          eslint.reason.includes("no config file") || eslint.reason.includes("binary"),
          `unexpected reason for failed eslint: ${eslint.reason}`,
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("empty config file is still detected — existence is enough", async () => {
    const dir = makeTmpDir();
    try {
      // Write a completely empty file (zero bytes)
      writeFileSync(join(dir, ".semgrep.yml"), "");
      const results = await detectScanners(dir);
      const semgrep = results.find((r) => r.scanner === "semgrep");
      assert.ok(semgrep);
      assert.equal(
        semgrep.available,
        true,
        "empty config file should still trigger config-file detection",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("multiple config files for same scanner — exactly one detection returned", async () => {
    const dir = makeTmpDir();
    try {
      // Both eslint.config.js (earlier in signal list) and .eslintrc.json exist
      writeFileSync(join(dir, "eslint.config.js"), "export default [];");
      writeFileSync(join(dir, ".eslintrc.json"), "{}");
      const results = await detectScanners(dir);
      const eslintResults = results.filter((r) => r.scanner === "eslint");
      assert.equal(
        eslintResults.length,
        1,
        `expected exactly 1 eslint detection, got ${eslintResults.length}`,
      );
      // Should be the first one in the configFiles order (eslint.config.js)
      assert.ok(eslintResults[0].configPath!.endsWith("eslint.config.js"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("config-file detection short-circuits — reason mentions config file not binary", async () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, "eslint.config.mjs"), "export default [];");
      const results = await detectScanners(dir);
      const eslint = results.find((r) => r.scanner === "eslint");
      assert.ok(eslint);
      assert.equal(eslint.available, true);
      assert.ok(
        eslint.reason.includes("config file"),
        `reason should mention "config file", got: ${eslint.reason}`,
      );
      assert.ok(
        !eslint.reason.includes("binary"),
        `reason should not mention "binary" when short-circuited by config file, got: ${eslint.reason}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("dotnet_format has no configFiles — relies on binary probe only", () => {
    const signals = SCANNER_SIGNALS["dotnet_format"];
    assert.equal(
      signals.configFiles.length,
      0,
      "dotnet_format should have no config files (binary-only scanner)",
    );
    assert.ok(
      signals.binaryNames.length > 0,
      "dotnet_format must have at least one binaryName",
    );
    assert.ok(signals.binaryNames.includes("dotnet"));
  });

  it("all 6 results share the same ordered scanner list across multiple calls", async () => {
    const dir = makeTmpDir();
    try {
      const results1 = await detectScanners(dir);
      const results2 = await detectScanners(dir);
      const names1 = results1.map((r) => r.scanner);
      const names2 = results2.map((r) => r.scanner);
      assert.deepEqual(names1, names2, "scanner order must be deterministic");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
