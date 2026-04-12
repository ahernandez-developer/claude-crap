# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-04-11

Initial public release of `claude-sonar` — a deterministic Quality Assurance
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
- **Workspace strictness config.** A single `.claude-sonar.json`
  file at the workspace root controls how the Stop quality gate and
  the `score_project` MCP tool react to a failing verdict. Three
  modes are supported: `strict` (default, hard-blocks the task
  close — same as previous behavior), `warn` (exits 0 but writes
  the full verdict to the hook transcript so the agent can
  voluntarily remediate), and `advisory` (exits 0 with a single-line
  note for the lightest possible pressure). `CLAUDE_SONAR_STRICTNESS`
  env var overrides the file for a single session. The PreToolUse
  security rules are **not** affected by this setting — security is
  always strict. Teams can adopt claude-sonar in stages without
  having to bypass the plugin.

  **Compliance note.** The Claude Code [plugins reference](https://code.claude.com/docs/en/plugins-reference#user-configuration)
  documents `userConfig` in `plugin.json` as the canonical channel
  for collecting plugin-level user configuration, with values
  stored in `.claude/settings.json` under `pluginConfigs[<plugin-id>].options`.
  `claude-sonar` deliberately reads `.claude-sonar.json` from the
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
- **CLI.** `claude-sonar install` / `doctor` / `status` / `bug-report`
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
  (`hooks/pre-tool-use.mjs`, `src/tests/pre-tool-use-hook.test.ts`.)
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
  The validator covers exactly the fields claude-sonar actually reads
  (`version`, `runs[].tool.driver.name`, and the per-result shape),
  with passthrough allowed for every other field so real-world SARIF
  extensions are not rejected. (`src/sarif/sarif-validator.ts`,
  `src/tests/sarif-validator.test.ts`.)

[0.1.0]: https://github.com/ahernandez-developer/claude-sonar/releases/tag/v0.1.0
