# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - 2026-04-13

### Added

- **Monorepo project map** — auto-discovers sub-projects at session boot
  by probing npm workspaces and `apps/`, `packages/`, `libs/` directories.
  Persisted to `.claude-crap/projects.json`.
- **`list_projects` MCP tool** — returns all sub-projects with type, path,
  recommended scanner, and availability.
- **Scoped `score_project`** — optional `scope` parameter to score a
  single sub-project instead of the entire monorepo.
- **Dart analyzer scanner** — `dart analyze --format=json` → SARIF 2.1.0.
  Auto-detected in monorepo subdirectories via `pubspec.yaml`.
- **`dotnet format` scanner** — built-in Roslyn analyzer for C# projects.
  No extra install needed when .NET SDK is present.
- **Centralized file exclusions** — shared module replaces 3 independent
  `SKIP_DIRS` sets. Covers `bundle/`, `vendor/`, `.astro`, `.svelte-kit`,
  `.dart_tool`, `.expo`, `.angular`, `.turbo`, and 15+ more.
- **User-configurable `exclude`** — `.claude-crap.json` now supports an
  `exclude` array with glob patterns and directory exclusions.
- **Auto-bootstrap ESLint** in monorepos — detects JS/TS sub-projects
  and installs ESLint at root automatically.
- **Auto-sync plugin cache** — `npm run build:plugin` syncs to all
  cached versions under `~/.claude/plugins/cache/`.

### Changed

- C# projects now use `dotnet format` instead of Semgrep.
- Scanner detector validates `node_modules/.bin/` binary exists before
  marking a package.json dependency as available.
- Workspace LOC excludes bundle/vendor files (dropped from ~25K to ~15K
  for the claude-crap repo itself).

## [0.3.6] - 2026-04-12

### Fixed

- **Auto-sync plugin cache on build** — `npm run build:plugin` now
  detects cached versions under `~/.claude/plugins/cache/` and syncs
  the freshly built files in-place. Eliminates the stale-cache problem
  where rebuilding had no effect until manual `/plugin install`.
- **PID file for dashboard port reuse** — dashboard writes
  `.claude-crap/dashboard.pid` and kills stale processes on startup
  so the port is always reclaimed (no more drift to 5118/5119).
- **Unused import** — removed leftover `createTcpServer` import.

## [0.3.5] - 2026-04-12

### Fixed

- **MCP server workspace root** — removed `CLAUDE_CRAP_PLUGIN_ROOT`
  env var from `.mcp.json` so `score_project` scans the user's
  workspace instead of the plugin cache directory.
- **ESLint false positives** — added Node.js globals for `.mjs`/`.cjs`,
  disabled `no-undef` for TypeScript files, downgraded stylistic rules
  from error to warn. Result: 0 error-level findings.

### Changed

- **README slimmed from 571 to 215 lines** — verbose sections moved to
  `docs/quality-gate.md` and `docs/contributing.md`.

## [0.3.4] - 2026-04-12

### Fixed

- **Out-of-the-box MCP server startup** — added `launcher.mjs` bootstrap
  wrapper that auto-installs runtime dependencies on first run. Fresh
  git-based installs no longer fail with `ERR_MODULE_NOT_FOUND`.
- **Dashboard port conflict across sessions** — when port 5117 is
  occupied by a stale process, the dashboard now probes up to 4
  consecutive fallback ports (5118–5121) before giving up.
- **Deterministic installs** — `plugin/package-lock.json` is now
  generated during `build:plugin` so all users resolve identical
  dependency versions.

### Changed

- MCP server entry point in `.mcp.json` changed from `mcp-server.mjs`
  to `launcher.mjs` (the launcher dynamically imports `mcp-server.mjs`
  after ensuring dependencies exist).

## [0.3.3] - 2026-04-12

### Fixed

- **npm OIDC Trusted Publishing** — upgrade npm to >= 11.5.1 before
  publishing. GitHub Actions runners ship an older npm that doesn't
  support OIDC token exchange, causing E404 on PUT.

## [0.3.2] - 2026-04-12

### Fixed

- **Dashboard 404 on root route** — the Vue SPA now loads on `GET /`
  via explicit route handler. Removed `decorateReply: false` from
  fastify-static registration which was preventing `sendFile`.
  Updated health endpoint version to `0.3.2`.
- **Bootstrap creates ESLint config when missing** — if ESLint is in
  `package.json` but has no `eslint.config.mjs`, bootstrap now
  creates the config instead of short-circuiting. Skips `npm install`
  when ESLint is already a dependency.
- **Runner detects ESLint fatal errors** — ESLint crash (no config)
  is now treated as failure, not as "0 findings".
- **Auto-scan triggers bootstrap for config-less ESLint** — when
  ESLint is detected via `package.json` but has no config file,
  auto-scan calls bootstrap to create one before scanning.
- **Improved ESLint ignore patterns** — generated `eslint.config.mjs`
  now ignores `**/bundle/`, `**/vendor/`, and `**/*.min.js` to avoid
  flagging build artifacts.
- **npm Trusted Publishing (OIDC)** — release workflow uses OpenID
  Connect provenance instead of `NPM_TOKEN` secret. No more 90-day
  token rotation.

## [0.3.1] - 2026-04-12

### Fixed

- **auto-scan now calls bootstrap when no scanners found** — the
  boot-time auto-scan and `auto_scan` MCP tool now automatically
  trigger `bootstrapScanner` when no scanners are detected, making
  the entire flow zero-config. Previously users had to call
  `bootstrap_scanner` manually.
- **`.github/workflows/auto-tag.yml`** — automatically creates a
  version tag when `package.json` changes on main, triggering the
  release pipeline without manual tagging.

## [0.3.0] - 2026-04-12

Scanner bootstrapping and automated releases. Projects with no
scanner configured now get one installed automatically, and the
release pipeline is fully automated via GitHub Actions.

### Added

- **`bootstrap_scanner` MCP tool** — detects the project type
  (JavaScript, TypeScript, Python, Java, C#) and installs the
  appropriate scanner:
  - JS/TS → ESLint (`npm install --save-dev` + `eslint.config.mjs`)
  - Python → Bandit (returns install instructions)
  - Java / C# → Semgrep (returns install instructions)
  - Unknown → Semgrep (polyglot fallback)
  After installation, runs `auto_scan` to immediately ingest findings.
- **`src/scanner/bootstrap.ts`** — project-type detection aligned
  with the five tree-sitter supported languages (`javascript`,
  `typescript`, `python`, `java`, `c_sharp`), ESLint flat config
  generation, and npm install orchestration.
- **`.github/workflows/release.yml`** — automated release pipeline.
  Push a `v*` tag to trigger: typecheck → build → test → npm publish
  → GitHub Release with changelog extraction. Requires `NPM_TOKEN`
  secret.
- **17 new tests** in `scanner-bootstrap.test.ts` for project-type
  detection and ESLint config generation. Suite total: 225 tests,
  37 suites.

### Changed

- MCP tools count: 8 → 9 (added `bootstrap_scanner`).
- Test counts in README updated to 225 / 37.

## [0.2.0] - 2026-04-12

Built-in scanner auto-detection and execution. Users now get real
quality grades out of the box without manually running ESLint,
Semgrep, Bandit, or Stryker.

### Added

- **`src/scanner/` module** — three-layer pipeline for automatic
  scanner discovery and execution:
  - `detector.ts` — probes config files, package.json deps, and PATH
    binaries for each of the four supported scanners.
  - `runner.ts` — executes scanner CLIs with proper flags and
    per-scanner timeouts (120s default, 300s for Stryker mutation
    testing).
  - `auto-scan.ts` — orchestrates detect → run (parallel) → adapt →
    ingest → persist. Graceful per-scanner failure.
  - `index.ts` — public SDK exports (`claude-crap/scanner`).
- **`auto_scan` MCP tool** — on-demand scanner execution available to
  the agent mid-session. Returns a Markdown summary + JSON snapshot
  with detection results, per-scanner stats, and total findings.
- **Boot-time auto-scan** — fire-and-forget after `server.connect()`
  so findings are populated by the time `score_project` is first
  called. Non-blocking: the server is ready for tool calls immediately.
- **53 new tests** across 3 new test files (`scanner-detector.test.ts`,
  `scanner-runner.test.ts`, `auto-scan.test.ts`). Suite total: 208
  tests, 35 suites.
- **`"./scanner"` export** in `package.json` for SDK consumers.
- **Marketplace cache troubleshooting** section in README.

### Changed

- MCP tools count in README: 7 → 8 (added `auto_scan`).
- Test counts in README updated to 208 / 35.

## [0.1.2] - 2026-04-12

Plugin distribution refactored from npm-source to git-source. Claude
Desktop's Directory view now renders Skills / Hooks / Connectors counts
for `claude-crap`, matching the pattern used by `claude-mem` and every
plugin in the official Anthropic marketplace.

### Added

- **`plugin/` subdirectory** — self-contained plugin artifact committed
  to git. Contains `.claude-plugin/plugin.json`, `.mcp.json`, `CLAUDE.md`,
  `hooks/`, `skills/`, `bundle/`, and a minimal `package.json` declaring
  only the un-bundleable native/WASM runtime deps.
- **`scripts/bundle-plugin.mjs`** — esbuild bundler that produces
  `plugin/bundle/mcp-server.mjs` (the MCP server entry) and
  `plugin/bundle/tdr-engine.mjs` (standalone TDR classifier for hooks).
  Also copies dashboard static assets into `plugin/bundle/dashboard/public/`.
- **`npm run build:plugin`** script in `package.json`.
- **Dashboard HTTP characterization test** (`src/tests/dashboard-http.test.ts`)
  that boots the bundled MCP server and verifies the dashboard responds
  with 200 OK + HTML and the `/api/score` endpoint returns valid JSON.
- **CI bundle drift check** — `.github/workflows/ci.yml` now rebuilds
  `plugin/bundle/` and fails the PR if the committed bundles are stale.

### Changed

- **Marketplace source** in `.claude-plugin/marketplace.json` changed
  from `{ source: "npm", package: "claude-crap" }` to
  `"./plugin"`. Claude Desktop can now filesystem-scan the plugin
  directory from the cloned marketplace repo.
- **MCP server entry** in `plugin/.mcp.json` changed from
  `dist/index.js` to `bundle/mcp-server.mjs`.
- **TDR import** in `plugin/hooks/lib/quality-gate.mjs` changed from
  `dist/metrics/tdr.js` to `../../bundle/tdr-engine.mjs`.
- **Integration tests** (`mcp-server.integration.test.ts`,
  `stop-quality-gate-strictness.test.ts`, `dashboard-http.test.ts`)
  now default to the bundled entry points and accept `SONAR_MCP_ENTRY` /
  `SONAR_TDR_ENTRY` env var overrides.
- **Hooks, skills, CLAUDE.md, .mcp.json** moved from the repo root
  into `plugin/` via `git mv` (history preserved).
- **`resolvePublicRoot()`** in `src/dashboard/server.ts` gained a new
  first-place candidate for the bundle-relative layout.
- **Diagnostic scripts** (`doctor.mjs`, `status.mjs`, `bug-report.mjs`,
  `install.mjs`) updated to check both `dist/` and `plugin/bundle/`.
- **`prepublishOnly`** now runs `npm run build:plugin` alongside `tsc`.
- **npm library surface preserved** — `main`, `types`, `exports` still
  point to `dist/`. Both distribution channels coexist (dual-track).

### Fixed

- Directory view in Claude Desktop now shows Skills / Hooks / Connectors
  counts (previously blank because the npm-source type prevented
  pre-install filesystem scanning).

## [0.1.1] - 2026-04-11

First feature release on top of the initial public drop. All the
plumbing that `v0.1.0` put in place (hooks, MCP server, dashboard,
SARIF store, scanner adapters, CLI) is unchanged — this release adds
the user-facing surface that makes those engines reachable from
Claude Code's slash-command palette.

### Added

- **Four user-invocable skills** under `plugin/skills/` at the plugin root.
  Each skill is a `SKILL.md` file with YAML frontmatter declaring a
  `name` and a "pushy" `description` (per the `skill-creator` skill's
  guidance on combating undertriggering), and Markdown instructions
  in the body that tell Claude how to invoke the underlying MCP tool
  and render the result. The four skills:
  - `/claude-crap:score` — runs the `score_project` MCP tool and
    displays the Markdown summary (Maintainability / Reliability /
    Security / Overall A..E grades, plus the live dashboard URL and
    the consolidated SARIF report path).
  - `/claude-crap:check-test` — takes a file-path argument, runs
    `require_test_harness` against it, and reports whether a matching
    characterization test exists; on `hasTest: false`, lists the top
    three resolver candidate paths so the user knows exactly where
    the new test should live per CLAUDE.md's Golden Rule.
  - `/claude-crap:analyze` — takes a file-path argument, auto-detects
    the language from the extension (`typescript`, `javascript`,
    `python`, `java`, `csharp`), runs `analyze_file_ast` against it,
    and reports per-function cyclomatic complexity ranked descending
    with refactoring candidates called out above the `cyclomaticMax`
    ceiling.
  - `/claude-crap:adopt` — interactive onboarding walkthrough that
    asks three questions about the team's test coverage, existing
    findings, and enforcement appetite, and recommends one of
    `strict` / `warn` / `advisory` for the workspace's
    `.claude-crap.json`. Produces a copy-pasteable JSON snippet and
    a gradual-adoption roadmap.
- **Frontmatter contract test** at `src/tests/skills-frontmatter.test.ts`
  validates that every `plugin/skills/<name>/SKILL.md` has YAML frontmatter
  with a `name` matching the directory, a `description` longer than
  100 characters, and the `use this skill when/whenever ...` trigger
  phrasing that the `skill-creator` guidance recommends. The test
  fires on every `npm test` run so a future drive-by edit that
  removes a field cannot slip through CI.

### Changed

- **`package.json#files` now ships `plugin/skills/`** in the npm tarball. The
  `v0.1.0` tarball did NOT include `plugin/skills/` — this is the reason a
  new version is mandatory rather than an in-place fix: Claude Code's
  marketplace installs via `npm install claude-crap@<version>`,
  not from the git repo, so the SKILL.md files only reach users after
  a new tarball is published. Consumers who already ran
  `/plugin install claude-crap@herz` against `0.1.0` need to run
  `/plugin marketplace update herz` to pick up `0.1.1`.
- **`.claude-plugin/marketplace.json` plugin version bumped** on both
  the top-level `version` field and the `source.version` pin, so the
  `herz` marketplace now delivers `0.1.1` instead of `0.1.0`.

### Fixed

- **Stale README install instructions** that were written in the
  future tense before the `v0.1.0` tag landed ("Once the plugin is
  tagged on GitHub the Claude Code marketplace path becomes a fully
  native second install route") are now replaced with the live
  commands: `npx claude-crap install` for the direct npm
  route, and `/plugin marketplace add https://github.com/ahernandez-developer/claude-crap`
  followed by `/plugin install claude-crap@herz` for the Claude Code
  marketplace route.

### Merge and publish sequence for maintainers

Because this release requires a new npm tarball to reach users via
the marketplace, the merge and publish order matters:

1. Review and merge this PR into `main` via "Squash and merge".
2. Pull the merged `main` locally: `git checkout main && git pull`.
3. Run `npm publish --otp=<6-digit-OTP>` from the repo root. The
   `prepublishOnly` script gates the publish on
   `clean + build + test + audit` — a broken test or a new HIGH
   audit finding will block the tag before any version lands.
4. Verify on the registry: `npm view claude-crap version`
   should print `0.1.1`.
5. Tag the release in git: `git tag -a v0.1.1 -m "Release v0.1.1"`
   followed by `git push origin v0.1.1`.
6. Optionally publish a GitHub release via
   `gh release create v0.1.1 --notes-file CHANGELOG.md`.

Between step 1 (merge) and step 3 (publish), the `herz` marketplace
briefly references `claude-crap@0.1.1` before that version
exists on the registry. New marketplace installs during that window
will fail with a clean npm 404 — no persistent state damage, but
running `npm publish` immediately after merging minimizes the gap.

## [0.1.0] - 2026-04-11

Initial public release of `claude-crap` — a deterministic Quality Assurance
plugin for Claude Code. Ships the full plugin shell, the MCP server, the
local Vue dashboard, the per-scanner SARIF adapters, and the publication
tooling in a single npm package.

### Added

- **Plugin shell.** Plugin manifest under `.claude-plugin/plugin.json`,
  `.mcp.json` wiring, `CLAUDE.md` Golden-Rule contract injected into
  every Claude Code session where the plugin is active, MIT `LICENSE`
  file, and `CHANGELOG.md`. Every file is validated against the
  official Claude Code [plugins-reference](https://code.claude.com/docs/en/plugins-reference)
  schema — only documented fields appear in the manifest, and every
  inline substitution uses a supported token (`${CLAUDE_PLUGIN_ROOT}`).
- **Deterministic hooks.**
  - PreToolUse gatekeeper with blocked-path, hardcoded-secret and
    destructive-bash rules (all pure regex, zero I/O, sub-200 ms latency).
  - PostToolUse verifier that flags missing test harnesses, inline
    suppression markers (`eslint-disable`, `@ts-ignore`, `# nosec`,
    `# type: ignore`), and fresh TODO / FIXME / HACK markers.
  - Stop / SubagentStop quality gate that reads the consolidated SARIF
    report, computes a project-wide Technical Debt Ratio, and — under
    `strict` mode — blocks task-close when the TDR rating or SARIF
    error count exceeds policy.
  - SessionStart briefing that prints the plugin version, the active
    thresholds, and the dashboard URL.
- **Workspace strictness config.** A single `.claude-crap.json`
  file at the workspace root controls how the Stop quality gate and
  the `score_project` MCP tool react to a failing verdict. Three
  modes are supported: `strict` (default, hard-blocks the task
  close — same as previous behavior), `warn` (exits 0 but writes
  the full verdict to the hook transcript so the agent can
  voluntarily remediate), and `advisory` (exits 0 with a single-line
  note for the lightest possible pressure). `CLAUDE_CRAP_STRICTNESS`
  env var overrides the file for a single session. The PreToolUse
  security rules are **not** affected by this setting — security is
  always strict. Teams can adopt claude-crap in stages without
  having to bypass the plugin.

  **Compliance note.** The Claude Code [plugins reference](https://code.claude.com/docs/en/plugins-reference#user-configuration)
  documents `userConfig` in `plugin.json` as the canonical channel
  for collecting plugin-level user configuration, with values
  stored in `.claude/settings.json` under `pluginConfigs[<plugin-id>].options`.
  `claude-crap` deliberately reads `.claude-crap.json` from the
  workspace root instead because (1) the canonical pattern prompts
  every user at install time and an enum policy with a sensible
  default does not warrant that friction, (2) a dedicated workspace
  file is team-committable and code-reviewable alongside
  `.eslintrc.json` / `.prettierrc.json` / `biome.json`, and (3) a
  workspace file can carry a JSON schema for IDE autocompletion.
  The deviation is called out in the `Configuration` section of
  `README.md`. Every other part of the plugin spec (manifest schema,
  hook events, MCP server location, `${CLAUDE_PLUGIN_ROOT}`
  substitution, directory layout) is fully compliant.
- **MCP server (stdio transport).**
  - `compute_crap` — Change-Risk-Anti-Patterns index for a single function.
  - `compute_tdr` — Technical Debt Ratio and A..E maintainability rating
    for a project, module, or file scope.
  - `analyze_file_ast` — tree-sitter AST metrics (physical / logical LOC,
    per-function cyclomatic complexity) for TypeScript, JavaScript,
    Python, Java, and C#.
  - `ingest_sarif` — merge a raw SARIF 2.1.0 document into the store
    with deduplication by `(ruleId, uri, startLine, startColumn)`.
  - `ingest_scanner_output` — route a scanner's native output through
    the matching adapter, enrich every finding with an `effortMinutes`
    estimate, and persist the normalized SARIF 2.1.0 document.
  - `require_test_harness` — check that a production source file has a
    matching test file in any of the supported conventions (sibling
    `.test.`, `__tests__/`, mirror tree under `tests/`, nearest-ancestor
    flat `tests/`, Python `test_` prefix).
  - `score_project` — aggregate the entire workspace into
    Maintainability, Reliability, Security and Overall letter grades
    with Markdown and JSON output.
- **MCP resources.**
  - `sonar://metrics/current` — live CRAP / TDR / rating snapshot
    derived from the in-memory SARIF store.
  - `sonar://reports/latest.sarif` — the last consolidated SARIF
    document.
- **Local dashboard.** Fastify HTTP server bound to `127.0.0.1` only
  (never `0.0.0.0`), Vue 3 SPA served from `src/dashboard/public/`,
  endpoints: `GET /api/score`, `GET /api/sarif`, `GET /api/health`.
- **Per-scanner SARIF adapters.** Semgrep (SARIF passthrough with
  effort enrichment), ESLint (native JSON), Bandit (JSON), Stryker
  (JSON mutation report). Every adapter stamps `properties.effortMinutes`
  on each finding so the Stop quality gate can compute a uniform TDR.
- **CLI.** `claude-crap install` / `doctor` / `status` / `bug-report`
  subcommands. The `bug-report` subcommand produces a Markdown
  diagnostic bundle with every sensitive environment variable
  redacted by name.
- **Packaging.** Single npm package (`@types`, `import`, `exports`
  surface), postinstall build fallback, `np` release scripts, esbuild
  fast-build path, Bun runtime supported, `docs/` deep reference.
- **CI.** GitHub Actions workflow that runs `typecheck`, `test`, and
  `audit` on every push and pull request.
- **Tests.** 155 unit / adapter / integration tests across 27 suites,
  all run on every `npm test` invocation.

### Security

The following findings from the OWASP Top 10:2025 pre-publication scan
were remediated before `v0.1.0` shipped. Each fix landed with
characterization and attack tests per the Golden Rule in `CLAUDE.md`.

- **F-A06-01 (HIGH)** — The PreToolUse hook now fails **closed**
  (exit 2) on any evaluation error when the proposed tool is in the
  high-risk allowlist (`Write`, `Edit`, `MultiEdit`, `NotebookEdit`,
  `Bash`). A best-effort `tool_name` regex recovers the tool name even
  from unparseable stdin, so a crash in `runAllRules` can no longer
  silently bypass the gatekeeper for workspace-mutating tools. Legacy
  fail-open semantics are preserved for low-risk tools so a broken
  hook does not deadlock read-only operations.
  (`plugin/hooks/pre-tool-use.mjs`, `src/tests/pre-tool-use-hook.test.ts`.)
- **F-A03-01 (HIGH)** — The dashboard no longer fetches Vue from
  `unpkg.com`. Vue 3.5.13 is now vendored locally under
  `src/dashboard/public/vendor/vue.global.prod.js` and the HTML
  comment has been rewritten to describe the vendored runtime
  accurately. Closes a missing-SRI / first-boot-MITM attack vector
  and eliminates a false claim in the source comments.
  (`src/dashboard/public/index.html`,
  `src/dashboard/public/vendor/vue.global.prod.js`,
  `src/tests/dashboard-integrity.test.ts`.)
- **F-A01-01 (MEDIUM)** — Workspace path containment is now enforced
  by a separator-aware check (`candidate === workspace ||
  candidate.startsWith(workspace + sep)`) extracted into a dedicated
  `src/workspace-guard.ts` module. The previous inlined
  `candidate.startsWith(workspace)` check was vulnerable to
  prefix confusion — a sibling directory like
  `${workspace}-evil/secret.txt` would have been accepted.
  (`src/workspace-guard.ts`, `src/tests/workspace-guard.test.ts`.)
- **F-A03-02 (LOW / process)** — The `prepublishOnly` script now
  gates on `npm audit --omit=dev --audit-level=high`, so a new
  high-severity advisory in any runtime dependency blocks
  publication until it is resolved. (`package.json`.)
- **F-A08-01 (LOW)** — `SarifStore.loadLatest` now tolerates
  malformed on-disk reports: the top-level `runs` field must be an
  array, each run is wrapped in its own try/catch, and each result is
  hydrated inside a nested try/catch. A single tampered entry drops
  with a stderr warning instead of crashing the MCP server boot.
  (`src/sarif/sarif-store.ts`, new assertions in
  `src/tests/sarif-store.test.ts`.)
- **F-A05-01 (LOW)** — Both `ingest_sarif` and `ingest_scanner_output`
  now validate the incoming SARIF document against a minimal AJV
  schema (`src/sarif/sarif-validator.ts`) before touching the store.
  The validator covers exactly the fields claude-crap actually reads
  (`version`, `runs[].tool.driver.name`, and the per-result shape),
  with passthrough allowed for every other field so real-world SARIF
  extensions are not rejected. (`src/sarif/sarif-validator.ts`,
  `src/tests/sarif-validator.test.ts`.)

[0.1.1]: https://github.com/ahernandez-developer/claude-crap/releases/tag/v0.1.1
[0.1.0]: https://github.com/ahernandez-developer/claude-crap/releases/tag/v0.1.0
