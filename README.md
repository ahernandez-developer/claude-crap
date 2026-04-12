# claude-crap

[![npm version](https://img.shields.io/npm/v/claude-crap.svg)](https://www.npmjs.com/package/claude-crap)
[![CI](https://github.com/ahernandez-developer/claude-crap/actions/workflows/ci.yml/badge.svg)](https://github.com/ahernandez-developer/claude-crap/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org/)
[![Bun](https://img.shields.io/badge/bun-%3E%3D1-black.svg)](https://bun.sh/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

> **Deterministic Quality Assurance plugin for Claude Code.**
> Forces the agent through mathematical hooks, CRAP / TDR thresholds,
> and SARIF 2.1.0 reports before a single line of code is allowed to
> ship.

`claude-crap` turns Claude Code into a disciplined QA engineer. It
sits underneath your existing Claude Code session as a plugin and
wraps every `Write`, `Edit`, and `Bash` call with deterministic
validation: a synchronous **PreToolUse gatekeeper**, a retrospective
**PostToolUse verifier**, and a final **Stop quality gate** that
refuses to close a task until the project's maintainability,
reliability, and security ratings are inside the configured policy.

The agent's probabilistic reasoning is never trusted by itself. Every
decision that touches source code, tests, or configuration must be
backed by a result from one of the deterministic engines exposed by
the plugin's MCP server — `compute_crap`, `compute_tdr`,
`analyze_file_ast`, `ingest_sarif`, `ingest_scanner_output`,
`require_test_harness`, and `score_project`.

This is the **Fat Platform / Thin Agent** thesis: the LLM is an
efficient worker, but the rails are mathematical, unforgiving, and
outside the model's reach.

> **CRAP** stands for **Change Risk Anti-Patterns** — a mildly offensive
> acronym to protect you from deeply offensive code. The metric was
> originally developed by Alberto Savoia and Bob Evans at Google in 2007.
> Read the original post:
> [This Code is CRAP](https://testing.googleblog.com/2011/02/this-code-is-crap.html).

[Quick Start](#quick-start) • [Configuration](#configuration) • [Documentation](#documentation) • [How It Works](#how-it-works) • [MCP Tools](#mcp-tools) • [System Requirements](#system-requirements) • [Development](#development) • [Bug Reports](#bug-reports) • [Contributing](#contributing)

---

## Quick Start

`claude-crap` ships as a single npm package. One command prepares
the workspace and prints the Claude Code slash command you need to
run next:

```bash
npx @sr-herz/claude-crap install
```

`npx` downloads the package, the `postinstall` step compiles `dist/`
from source, and then `claude-crap install` creates
`.claude-crap/reports/` in the current project, marks every hook
script executable, and prints the exact Claude Code command to
register the plugin:

```
✓ claude-crap is ready to register with Claude Code.

  Plugin root: /.../claude-crap

  Next steps — pick ONE of the following:

  1. Native Claude Code install from this directory:
       /plugin install /.../claude-crap

  2. Marketplace install (Claude Code pulls the published npm tarball):
       /plugin marketplace add https://github.com/ahernandez-developer/claude-crap
       /plugin install claude-crap@herz
```

Once Claude Code reports the plugin as active, open any new session
in your workspace. The **SessionStart** hook will print a one-line
briefing showing the plugin version, the active thresholds, and the
local dashboard URL. From that point on the PreToolUse gatekeeper
runs on every tool call and the Stop quality gate runs on every
task close — no further setup required.

> **Two install channels are live:**
>
> - **npm** — `npx @sr-herz/claude-crap install` (direct, works anywhere `npx` does)
> - **Claude Code marketplace** — `/plugin marketplace add https://github.com/ahernandez-developer/claude-crap` followed by `/plugin install claude-crap@herz`. Claude Code resolves the marketplace entry's `source` to `@sr-herz/claude-crap@0.1.0` on the npm registry, so both routes unpack the **same tarball** and get the same SHA.

---

## Configuration

> **Default: `strict`.** You don't need to create a config file or
> set any environment variables. A fresh install hard-fails the Stop
> quality gate on any policy violation — same behavior the plugin
> has always had. The rest of this section only matters if you want
> to loosen that enforcement while adopting the plugin gradually.

The `strictness` value controls how the **Stop quality gate** and
the **`score_project` MCP tool** react when a policy fails. The
PreToolUse security gatekeeper (blocked paths, destructive Bash,
hardcoded secrets) is **always** strict regardless of this setting —
security is not a quality gradient.

| Mode         | Stop hook exit | Verdict sink | Agent experience                                                                                                                                                |
| :----------- | :------------: | :----------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `strict`     |       `2`      | **stderr**   | The full `BLOCKED` box is injected into the agent's context. The task cannot close until the rules are satisfied. **Default — nothing to configure.**          |
| `warn`       |       `0`      | **stdout**   | The full `WARNING` box lands in the hook transcript so the agent still sees every failing rule, but the task is allowed to close. Agent can remediate voluntarily. |
| `advisory`   |       `0`      | **stdout**   | A single-line `ADVISORY` note is emitted. Minimal pressure on the agent — the task closes with a soft nudge only.                                              |

### How to override the default

Teams adopting the plugin on an existing codebase can dial the
default back with a single file at the workspace root:

```jsonc
// .claude-crap.json — commit this to git for team-wide policy
{
  "$schema": "https://raw.githubusercontent.com/ahernandez-developer/claude-crap/main/schemas/crap-config.json",
  "strictness": "warn"  // "strict" | "warn" | "advisory"
}
```

Or override for a single session from the shell:

```bash
CLAUDE_CRAP_STRICTNESS=advisory claude
```

**Precedence** (most specific wins):

1. `CLAUDE_CRAP_STRICTNESS` environment variable — session-level
   override. Useful for a one-off lenient run without editing the
   committed policy.
2. `.claude-crap.json` at the workspace root — team-committed
   default. Everyone who clones the repo gets the same policy.
3. Hardcoded default `"strict"` — applies when neither source is
   present. **You don't need to create either the file or the env
   var to get strict mode.**

### How to adopt gradually

Start in `advisory` so the agent simply annotates its sessions with
a quality reading. Once the team is comfortable, bump to `warn` so
the full verdict lands in the hook transcript and the agent sees
every failing rule. When the project is clean enough to ship under
policy, delete the file (or switch it to `strict`) and let CI catch
any regression.

The `.claude-crap.json` file is a plain JSON document designed to
be committed alongside the code. It is intentionally **not** matched
by the `.claude-crap/` gitignore rule (which only covers the
runtime state directory), so `git add .claude-crap.json` just works.

### Compliance with Claude Code's plugin recommendations

The [Claude Code plugins reference](https://code.claude.com/docs/en/plugins-reference#user-configuration)
documents exactly one canonical pattern for collecting plugin user
configuration:

> The `userConfig` field declares values that Claude Code prompts
> the user for when the plugin is enabled. Use this instead of
> requiring users to hand-edit `settings.json`.

**`claude-crap` deliberately deviates from that pattern** and reads
`.claude-crap.json` from the workspace root instead. We chose this
knowingly, not by accident. The trade-off:

- The canonical `userConfig` pattern prompts every user at
  `/plugin install` time, stores the answer in Claude Code's own
  `.claude/settings.json` under `pluginConfigs[claude-crap].options`,
  and exposes it as `${user_config.KEY}` or `CLAUDE_PLUGIN_OPTION_KEY`.
  It is the right channel for per-user secrets like API tokens.
- For an **enum policy with a sensible default** (`strict`), an
  install-time prompt is friction with no upside: 99% of users will
  just accept the default, and the 1% who want to tune it are
  better served by committing a JSON file to git alongside the rest
  of their project's quality config (`.eslintrc.json`,
  `.prettierrc.json`, `biome.json`, `tsconfig.json`, etc.).
- The workspace file also lets us ship a proper JSON schema under
  [`schemas/crap-config.json`](./schemas/crap-config.json) for
  IDE autocompletion and CI validation — `userConfig` has no
  equivalent surface.

So the honest answer to "are we in compliance with the Claude Code
recommendations?" is: **we comply with every other part of the
plugin spec** (manifest schema, hook events, MCP server location,
substitution tokens, directory layout) and **we deviate from one**:
user configuration, where we read a workspace file instead of
declaring a `userConfig` prompt. The deviation is documented here
and in `CHANGELOG.md`.

---

## Documentation

Deep reference lives under [`docs/`](./docs/README.md). Everything
below is indexed from the [docs README](./docs/README.md) so you can
navigate there if you prefer browsing by chapter.

### Getting Started

- [Architecture Overview](./docs/architecture-overview.md) — the Fat
  Platform / Thin Agent thesis, boot sequence, data flow, and the
  design decisions behind stdio-only transport and loopback-only
  dashboard.
- [Quick install walk-through](./docs/README.md) — the step-by-step
  version of the [Quick Start](#quick-start) above, including first
  run expectations and the `claude-crap doctor` diagnostic.

### Architecture & Concepts

- [Quality gate and math](./docs/quality-gate.md) — CRAP formula,
  TDR formula, letter ratings, Stop hook policies.
- [Project score](./docs/scoring.md) — how Maintainability /
  Reliability / Security / Overall A..E grades are aggregated and
  rendered to chat.
- [Hooks reference](./docs/hooks.md) — every Claude Code lifecycle
  hook, contract, rule catalog, and extension points.

### Reference

- [MCP tools reference](./docs/mcp-tools.md) — schemas, inputs,
  outputs, and error semantics for every MCP tool and resource.
- [Scanner adapters](./docs/scanner-adapters.md) — Semgrep, ESLint,
  Bandit, Stryker — mapping rules, effort tables, how to add a new
  adapter.
- [SDK reference](./docs/sdk.md) — every symbol exported from
  `@sr-herz/claude-crap`, `@sr-herz/claude-crap/metrics`,
  `@sr-herz/claude-crap/sarif`, `@sr-herz/claude-crap/ast`,
  `@sr-herz/claude-crap/tools`, `@sr-herz/claude-crap/adapters`.

### Contributing & Releases

- [Contributing guide](./docs/contributing.md) — dev loop, test
  layout, coding conventions, release process.
- [Changelog](./CHANGELOG.md) — Keep-a-Changelog-formatted release
  history, with the security subsection documenting every OWASP
  Top 10:2025 finding that shipped fixed in `v0.1.0`.
- [Agent contract (CLAUDE.md)](./plugin/CLAUDE.md) — the Golden Rule that is
  auto-injected into every Claude Code session where the plugin is
  active.

---

## How It Works

**Core components:**

1. **PreToolUse gatekeeper** (`plugin/hooks/pre-tool-use.mjs`). A
   synchronous, zero-I/O speed bump that inspects the proposed
   `tool_input` before the tool runs. Sensitive paths, destructive
   Bash, hardcoded secrets, and path-traversal attempts trigger
   `exit 2`, which Claude Code converts into an injection into the
   agent's context — the model then rethinks the approach with the
   exact corrective message in hand. For the high-risk tool
   allowlist (`Write`, `Edit`, `MultiEdit`, `NotebookEdit`, `Bash`),
   any failure to evaluate the rules fails **closed**, so the gate
   cannot be bypassed by crashing a rule.

2. **PostToolUse verifier** (`plugin/hooks/post-tool-use.mjs`). Runs
   immediately after a file-mutating tool call and scans the
   just-written artifact for a missing test harness, inline
   suppression markers (`eslint-disable`, `@ts-ignore`, `# nosec`,
   `# type: ignore`), and fresh TODO / FIXME / HACK markers.
   Warnings are emitted on stderr — non-blocking, but the Stop gate
   will enforce the strict verdict later.

3. **Stop / SubagentStop quality gate**
   (`plugin/hooks/stop-quality-gate.mjs`). When the agent declares a task
   done, this hook reads the consolidated SARIF report, computes
   CRAP / TDR / reliability / security ratings against the entire
   workspace, and refuses to let the task close if any metric is
   outside policy. The corrective message lists every failing rule
   so the agent can remediate on the next turn.

4. **Deterministic MCP server** (`src/index.ts`). A Node.js
   stdio-transport MCP server that exposes the math engines
   (CRAP, TDR, tree-sitter AST, SARIF store with deduplication) as
   first-class tools. Everything is a pure function or a small
   class; no engine performs I/O outside the SARIF store's on-disk
   persistence.

5. **SARIF 2.1.0 store** (`src/sarif/sarif-store.ts`). On-disk
   consolidated report with finding deduplication by
   `(ruleId, uri, startLine, startColumn)`. Loading tolerates
   malformed entries (per-run and per-result try/catch) so a
   tampered `latest.sarif` cannot DoS the MCP server boot. Every
   incoming document is validated against a minimal AJV 2.1.0
   schema before it is persisted.

6. **Per-scanner adapters** (`src/adapters/`). Semgrep (SARIF
   passthrough with enrichment), ESLint (native JSON), Bandit
   (native JSON), Stryker (JSON mutation report). Every adapter
   stamps `properties.effortMinutes` on each finding so the Stop
   gate and the project score engine can compute a uniform
   Technical Debt Ratio across scanner families.

7. **Local dashboard** (`src/dashboard/server.ts`). A Fastify HTTP
   server that binds to `127.0.0.1` only — never `0.0.0.0` — and
   serves a Vue 3 SPA from `src/dashboard/public/`. The Vue runtime
   is vendored under `src/dashboard/public/vendor/` so the
   dashboard works offline after install and is not exposed to
   CDN-compromise or first-boot-MITM attacks.

All findings are normalized to **SARIF 2.1.0** before the agent ever
sees them. One vocabulary, exact file / line / column coordinates,
and no walls of grep output polluting the context window.

See [Architecture Overview](./docs/architecture-overview.md) for the
boot sequence, the full data-flow diagram, and the design decisions
behind each component.

---

## MCP Tools

The MCP server exposes seven deterministic tools and two resources.
Every tool has a strict JSON Schema (Draft-07) with
`additionalProperties: false`, `enum`, `pattern`, and numeric bounds,
so any drift from the contract produces a deterministic error the
agent can consume and correct.

**The three-layer workflow.** For any non-trivial quality task the
agent follows the same three-step pattern, mirroring how the
platform is designed to be used:

1. **Analyze** — `analyze_file_ast` for per-function metrics, or
   `compute_crap` / `compute_tdr` when coverage and LOC are already
   known.
2. **Ingest** — `ingest_sarif` or `ingest_scanner_output` to fold
   external scanner output (Semgrep, ESLint, Bandit, Stryker) into
   the consolidated SARIF store with deduplication.
3. **Score** — `score_project` to aggregate everything into a
   single Markdown + JSON verdict with A..E grades per dimension.

**Available MCP tools:**

| Tool                    | Purpose                                                                                                                                       | Key inputs                                                                          |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `compute_crap`          | CRAP index for a single function plus a block verdict against the configured threshold.                                                      | `cyclomaticComplexity`, `coveragePercent`, `functionName`, `filePath`               |
| `compute_tdr`           | Technical Debt Ratio and A..E maintainability rating for a project / module / file scope.                                                    | `remediationMinutes`, `totalLinesOfCode`, `scope`                                   |
| `analyze_file_ast`      | Tree-sitter AST metrics: physical and logical LOC plus per-function cyclomatic complexity. Supports TypeScript, JavaScript, Python, Java, C#. | `filePath`, `language`                                                              |
| `ingest_sarif`          | Merge a raw SARIF 2.1.0 document into the store with deduplication. Validated against a minimal AJV schema before persistence.                | `sarifDocument`, `sourceTool`                                                       |
| `ingest_scanner_output` | Route a scanner's native output through the matching adapter, enrich each finding with an `effortMinutes` estimate, and persist as SARIF.    | `scanner` (`semgrep` / `eslint` / `bandit` / `stryker`), `rawOutput`                |
| `require_test_harness`  | Check whether a production source file has an accompanying test file in any of the supported conventions.                                    | `filePath`                                                                          |
| `score_project`         | Aggregate the entire workspace into Maintainability / Reliability / Security / Overall A..E grades with Markdown and JSON output.            | `format` (`markdown` / `json` / `both`)                                             |

**Available MCP resources:**

| URI                            | MIME                     | Description                                                           |
| ------------------------------ | ------------------------ | --------------------------------------------------------------------- |
| `sonar://metrics/current`      | `application/json`       | Live CRAP / TDR / rating snapshot derived from the in-memory store.   |
| `sonar://reports/latest.sarif` | `application/sarif+json` | Last consolidated SARIF document produced by the Stop quality gate.   |

**Example usage.** From an agent session, the tool call a typical
pre-publication audit lands on:

```ts
// Fold a Semgrep SARIF report into the store.
await tools.ingest_scanner_output({
  scanner: "semgrep",
  rawOutput: readFileSync("./semgrep.sarif", "utf8"),
});

// Ask for the final verdict as Markdown + JSON.
const score = await tools.score_project({ format: "both" });
// score.isError === true  ⇒  the agent must remediate before closing
```

And from a consumer that wants to embed the engines directly without
running the MCP server:

```ts
import {
  computeCrap,
  computeTdr,
  computeProjectScore,
  SarifStore,
  TreeSitterEngine,
} from "@sr-herz/claude-crap";
```

Full details — including every schema, every error shape, and the
per-scanner effort tables — live in
[docs/mcp-tools.md](./docs/mcp-tools.md) and
[docs/scanner-adapters.md](./docs/scanner-adapters.md).

---

## System Requirements

- **Node.js ≥ 20.0.0** — the only runtime requirement. No .NET, no
  JDK, no Python toolchain.
- **Bun ≥ 1.0** is also supported as an alternative runtime:
  `bun run build`, `bun test`, and `bun ./dist/index.js` all work
  out of the box. CI runs against both Node and Bun.
- **Claude Code** with local plugin support. The plugin registers
  itself via the native `/plugin install` slash command — no manual
  `settings.json` surgery required.
- **A POSIX-compatible shell** for the hook scripts (Bash, Zsh, or
  any POSIX `/bin/sh`). On Windows, WSL or Git Bash works.
- **Zero native dependencies.** The MCP server ships as pure
  Node.js with WASM-backed tree-sitter, so `npm install` never
  invokes a C compiler or a linker.

### Windows Setup Notes

On native Windows (no WSL), the hook scripts rely on a POSIX shell.
If you hit `'./plugin/hooks/pre-tool-use.mjs' is not recognized as an
internal or external command`, install [Git for Windows](https://gitforwindows.org/)
and make sure its `usr/bin` directory is on your `PATH` so `bash`
and `env` are available to Node's `child_process.spawn`. Using WSL
2 sidesteps the issue entirely and is the recommended path for
Windows developers who run Claude Code locally.

---

## Development

All commands run from the repo root — there is no nested package.

```bash
# Type-check only
npm run typecheck

# Canonical build with full type-checking + declaration files (the
# build CI and `np release` both call).
npm run build

# Fast dev build via esbuild — 10-20x faster than tsc, but no type
# check and no .d.ts files. Pair with `npm run typecheck` in watch
# mode for the fastest feedback loop.
npm run build:fast

# Watch mode for hot rebuilds during source edits
npm run build:watch

# Run in dev mode (tsx, no build step)
npm run dev

# Full native test suite — 155 tests across 27 suites
npm test

# Narrow the feedback loop to one domain while iterating
npm run test:metrics     # CRAP, TDR, score
npm run test:sarif       # SARIF store + dedup + validator
npm run test:ast         # Cyclomatic walker
npm run test:harness     # Test-file resolver
npm run test:adapters    # Semgrep, ESLint, Bandit, Stryker
npm run test:integration # End-to-end MCP stdio round trips

# Clean build artifacts
npm run clean
```

CLI shortcuts are exposed as npm scripts too:

```bash
npm run doctor        # node ./bin/claude-crap.mjs doctor
npm run status        # node ./bin/claude-crap.mjs status
npm run bug-report    # writes claude-crap-bug-report-<ts>.md to the cwd
```

### Releases

Publishing goes through [`np`](https://github.com/sindresorhus/np)
so every release runs `clean + build + test + audit` before tagging
and pushing to npm:

```bash
npm run release          # interactive — prompts for patch/minor/major
npm run release:patch    # non-interactive patch bump
npm run release:minor    # non-interactive minor bump
npm run release:major    # non-interactive major bump
```

`prepublishOnly` runs `npm run clean && npm run build && npm test &&
npm audit --omit=dev --audit-level=high` automatically. A broken
test OR a new high-severity advisory in a runtime dependency blocks
`np` before any tag lands.

### Running the MCP server standalone

For debugging, the MCP server can be run outside Claude Code:

```bash
node ./dist/index.js --transport stdio
```

Paste an MCP `initialize` request on stdin to exercise the JSON-RPC
framing. The dashboard auto-boots at `http://127.0.0.1:5117` when
the server starts — change `CLAUDE_PLUGIN_OPTION_DASHBOARD_PORT` to
move it to a different port.

---

## Bug Reports

The `claude-crap` CLI ships a `bug-report` subcommand that collects
every piece of information a maintainer typically asks for when
triaging an issue and writes it to a single Markdown bundle:

```bash
npx @sr-herz/claude-crap bug-report
# writes ./claude-crap-bug-report-<timestamp>.md
```

The bundle includes the plugin version, Node / npm / platform
versions, plugin file presence, the build state of `dist/`, the
resolved `CLAUDE_PLUGIN_OPTION_*` environment variables (with every
secret-looking variable automatically redacted by name), the
`claude-crap doctor` output, and a summary of the consolidated
SARIF report if one exists.

Pass `--stdout` to print the bundle instead of writing a file, or
`-o <path>` to choose the filename. Review the output for anything
sensitive that slipped past the redactor, then open a new issue at
[github.com/ahernandez-developer/claude-crap/issues](https://github.com/ahernandez-developer/claude-crap/issues)
and paste the bundle as the issue body.

---

## Contributing

1. **Fork** [ahernandez-developer/claude-crap](https://github.com/ahernandez-developer/claude-crap)
   and create a feature branch off `main`.
2. **Write the test first.** The CLAUDE.md Golden Rule forbids
   writing functional code before a test safety net exists, and the
   PreToolUse hook will block you if you try. Add a characterization
   test that pins the current behavior, then the attack test that
   demonstrates the bug, then the patch.
3. **Run `npm test`.** The full suite must stay at 177 / 177 green.
   If you add new tests, update the count in the
   [Development](#development) section and in `CHANGELOG.md`.
4. **Update the `CHANGELOG.md`** with an entry describing your
   change. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
   and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
5. **Open a pull request** describing the change in the rigid
   deduction format from `CLAUDE.md` (`Coupled dependency / Risk /
   Required test / Blocking metric / Proposed change`). CI will run
   typecheck, the full test suite, and `npm audit` on every push.

Full dev loop, test layout, coding conventions, and the release
process live in [docs/contributing.md](./docs/contributing.md).

---

## License

MIT. See [LICENSE](./LICENSE) for the full text.

Copyright (c) 2026 Alan Hernandez.
