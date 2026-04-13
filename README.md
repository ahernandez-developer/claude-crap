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
wraps every `Write`, `Edit`, and `Bash` call with a synchronous
**PreToolUse gatekeeper**, a retrospective **PostToolUse verifier**,
and a final **Stop quality gate** that refuses to close a task until
maintainability, reliability, and security ratings pass policy.

Every decision that touches source code must be backed by a result
from the deterministic MCP engines — `compute_crap`, `compute_tdr`,
`analyze_file_ast`, `ingest_sarif`, `score_project`, and others.
This is the **Fat Platform / Thin Agent** thesis: the LLM is an
efficient worker, but the rails are mathematical and outside the
model's reach.

> **CRAP** stands for **Change Risk Anti-Patterns** — a metric
> originally developed by Alberto Savoia and Bob Evans at Google (2007).
> [Read the original post.](https://testing.googleblog.com/2011/02/this-code-is-crap.html)

[Quick Start](#quick-start) · [Configuration](#configuration) · [How It Works](#how-it-works) · [MCP Tools](#mcp-tools) · [Documentation](#documentation) · [Development](#development) · [Contributing](#contributing)

---

## Quick Start

```bash
npx claude-crap install
```

This downloads the package, compiles `dist/` from source, creates
`.claude-crap/reports/` in your project, and prints the Claude Code
command to register the plugin:

```
  Next steps — pick ONE of the following:

  1. Native install:
       /plugin install /.../claude-crap

  2. Marketplace install:
       /plugin marketplace add https://github.com/ahernandez-developer/claude-crap
       /plugin install claude-crap@herz
```

Once registered, open any new session. The **SessionStart** hook
prints a briefing with thresholds and the dashboard URL. From that
point the PreToolUse gatekeeper and Stop quality gate run
automatically — no further setup required.

---

## Configuration

> **Default: `strict`.** No config file needed. The Stop gate
> hard-fails on any policy violation out of the box.

The `strictness` value controls how the Stop gate reacts to failures:

| Mode       | Stop exit | Effect                                                         |
| :--------- | :-------: | :------------------------------------------------------------- |
| `strict`   |    `2`    | Task cannot close until rules pass. **Default.**               |
| `warn`     |    `0`    | Full verdict visible to agent, but task closes.                |
| `advisory` |    `0`    | Single-line nudge only.                                        |

Override per workspace:

```jsonc
// .claude-crap.json — commit to git for team-wide policy
{
  "strictness": "warn"
}
```

Or per session: `CLAUDE_CRAP_STRICTNESS=advisory claude`

**Precedence:** env var > `.claude-crap.json` > hardcoded `strict`.

See [docs/quality-gate.md](./docs/quality-gate.md) for the full
CRAP formula, TDR formula, letter ratings, and adoption strategy.

---

## How It Works

| Component | File | Role |
| :-------- | :--- | :--- |
| **PreToolUse gatekeeper** | `plugin/hooks/pre-tool-use.mjs` | Blocks sensitive paths, destructive Bash, hardcoded secrets, path traversal — `exit 2` injects the corrective message into the agent's context. |
| **PostToolUse verifier** | `plugin/hooks/post-tool-use.mjs` | Warns on missing test harness, suppression markers (`eslint-disable`, `@ts-ignore`, `# nosec`), and TODO/FIXME/HACK. |
| **Stop quality gate** | `plugin/hooks/stop-quality-gate.mjs` | Reads the SARIF store, computes CRAP / TDR / reliability / security ratings, and blocks task close if any metric is outside policy. |
| **MCP server** | `src/index.ts` | Stdio-transport server exposing CRAP, TDR, tree-sitter AST, and SARIF engines as deterministic tools. |
| **SARIF store** | `src/sarif/sarif-store.ts` | On-disk consolidated report with finding deduplication. Tolerates malformed entries so a tampered file can't DoS the boot. |
| **Scanner adapters** | `src/adapters/` | ESLint, Semgrep, Bandit, Stryker, `dart analyze`, `dotnet format` — each stamps `effortMinutes` for uniform TDR computation. |
| **Project map** | `src/monorepo/project-map.ts` | Auto-discovers monorepo sub-projects at boot, persists to `.claude-crap/projects.json`. |
| **Dashboard** | `src/dashboard/server.ts` | Fastify on `127.0.0.1:5117` serving a Vue 3 SPA. Offline-capable (vendored runtime). PID-based port management. |

All findings are normalized to **SARIF 2.1.0** — one vocabulary,
exact coordinates, no grep walls in the context window.

See [docs/architecture-overview.md](./docs/architecture-overview.md)
for the boot sequence, data flow, and design decisions.

---

## MCP Tools

Ten deterministic tools and two resources, all with strict JSON Schema validation.

| Tool | Purpose |
| :--- | :------ |
| `compute_crap` | CRAP index for a single function + block verdict against threshold. |
| `compute_tdr` | Technical Debt Ratio and A..E maintainability rating. |
| `analyze_file_ast` | Tree-sitter AST metrics: LOC + per-function cyclomatic complexity. TypeScript, JavaScript, Python, Java, C#. |
| `ingest_sarif` | Merge a raw SARIF 2.1.0 document into the store with deduplication. |
| `ingest_scanner_output` | Route native scanner output through adapter, enrich with `effortMinutes`, persist as SARIF. Supports ESLint, Semgrep, Bandit, Stryker, `dart_analyze`, and `dotnet_format`. |
| `require_test_harness` | Check whether a source file has an accompanying test file. |
| `score_project` | Aggregate workspace into A..E grades. Optional `scope` parameter to score a single monorepo sub-project. |
| `auto_scan` | Auto-detect scanners (including monorepo subdirectories), run them, ingest findings. |
| `bootstrap_scanner` | Detect project type, install the right scanner, configure, and verify. |
| `list_projects` | List all discovered monorepo sub-projects with type, scanner, and availability. |

| Resource | Description |
| :------- | :---------- |
| `sonar://metrics/current` | Live CRAP / TDR / rating snapshot. |
| `sonar://reports/latest.sarif` | Consolidated SARIF document. |

Full schemas, inputs, outputs, and examples in
[docs/mcp-tools.md](./docs/mcp-tools.md).

---

## System Requirements

- **Node.js >= 20** — the only runtime. No .NET, JDK, or Python.
- **Bun >= 1.0** also works (`bun run build`, `bun test`).
- **Claude Code** with local plugin support.
- **Zero native deps** — WASM-backed tree-sitter, no C compiler needed.

Windows: requires a POSIX shell (Git Bash or WSL).
See [docs/contributing.md](./docs/contributing.md) for Windows setup details.

---

## Supported Languages & Scanners

| Language | Extensions | AST analysis | Scanner | Setup |
| :------- | :--------- | :----------: | :------ | :---- |
| TypeScript | `.ts` `.tsx` `.mts` `.cts` | Cyclomatic complexity | ESLint | **Auto-installed** via npm |
| JavaScript | `.js` `.jsx` `.mjs` `.cjs` | Cyclomatic complexity | ESLint | **Auto-installed** via npm |
| Python | `.py` `.pyi` | Cyclomatic complexity | Bandit | `pip install bandit` |
| Java | `.java` | Cyclomatic complexity | Semgrep | `brew install semgrep` |
| C# / .NET | `.cs` | Cyclomatic complexity | `dotnet format` | **Included in .NET SDK** |
| Dart / Flutter | `.dart` | LOC only | `dart analyze` | **Included in Dart/Flutter SDK** |
| Vue | `.vue` | LOC only | ESLint (via root config) | Auto with TypeScript |
| Go | `.go` | LOC only | — | — |
| Rust | `.rs` | LOC only | — | — |
| Ruby | `.rb` | LOC only | — | — |
| PHP | `.php` | LOC only | — | — |
| Swift | `.swift` | LOC only | — | — |
| Kotlin | `.kt` | LOC only | — | — |
| Scala | `.scala` | LOC only | — | — |

**AST analysis** = tree-sitter cyclomatic complexity per function.
**LOC only** = counted toward workspace metrics but no per-function analysis.

### Monorepo auto-discovery

In monorepos, claude-crap automatically discovers sub-projects at
session startup — no per-project configuration needed. The plugin
probes npm workspaces and common directories (`apps/`, `packages/`,
`libs/`, `modules/`, `services/`) to build a **project map**:

```
Session start
  → discover project map
  → detect sub-projects by type (TypeScript, Dart, C#, Python, etc.)
  → install missing scanners (ESLint auto-installed via npm)
  → run each scanner from its project directory
  → aggregate all findings into one SARIF store
  → score_project ready with real data
```

The project map is persisted to `.claude-crap/projects.json` and
exposed via the `list_projects` MCP tool. Use `score_project` with
the optional `scope` parameter to score a single sub-project:

```ts
// Score only one sub-project
score_project({ format: "both", scope: "frontend" })
```

See [docs/supported-languages.md](./docs/supported-languages.md) for
detailed per-language setup and behavior.

**File exclusions** are centralized and cover all major frameworks
out of the box: `dist/`, `build/`, `bundle/`, `vendor/`,
`.next`, `.nuxt`, `.astro`, `.svelte-kit`, `.dart_tool`,
`.expo`, `.angular`, `.turbo`, and more. Custom exclusions can be
added via `.claude-crap.json`:

```jsonc
{
  "strictness": "strict",
  "exclude": ["apps/legacy/", "generated/", "*.proto.ts"]
}
```

---

## Documentation

| Section | Link |
| :------ | :--- |
| Supported languages & scanners | [docs/supported-languages.md](./docs/supported-languages.md) |
| Architecture & boot sequence | [docs/architecture-overview.md](./docs/architecture-overview.md) |
| Quality gate math (CRAP, TDR, ratings) | [docs/quality-gate.md](./docs/quality-gate.md) |
| Project score aggregation | [docs/scoring.md](./docs/scoring.md) |
| Hooks reference | [docs/hooks.md](./docs/hooks.md) |
| MCP tools & resources | [docs/mcp-tools.md](./docs/mcp-tools.md) |
| Scanner adapters | [docs/scanner-adapters.md](./docs/scanner-adapters.md) |
| SDK reference | [docs/sdk.md](./docs/sdk.md) |
| Contributing & dev loop | [docs/contributing.md](./docs/contributing.md) |
| Agent contract | [plugin/CLAUDE.md](./plugin/CLAUDE.md) |
| Changelog | [CHANGELOG.md](./CHANGELOG.md) |

---

## Development

```bash
npm install          # postinstall builds dist/ automatically
npm test             # 265 tests across 46 suites
npm run build:fast   # esbuild dev build (10-20x faster than tsc)
npm run doctor       # full diagnostic
```

Release via [`np`](https://github.com/sindresorhus/np):
`npm run release:patch` / `release:minor` / `release:major`.
`prepublishOnly` runs clean + build + test + audit automatically.

Full dev loop, test commands, and standalone MCP server instructions
in [docs/contributing.md](./docs/contributing.md).

---

## Bug Reports

```bash
npx claude-crap bug-report    # writes claude-crap-bug-report-<ts>.md
npx claude-crap bug-report --stdout
```

Collects plugin version, Node/npm/platform info, doctor output,
SARIF summary, and resolved env vars (secrets auto-redacted).
Review the output, then open an issue at
[github.com/ahernandez-developer/claude-crap/issues](https://github.com/ahernandez-developer/claude-crap/issues).

---

## Contributing

1. Fork and branch off `main`.
2. **Write the test first** — the Golden Rule forbids code before a safety net.
3. Run `npm test` — full suite must stay green.
4. Update `CHANGELOG.md`.
5. Open a PR in the [rigid deduction format](./plugin/CLAUDE.md).

Full guide: [docs/contributing.md](./docs/contributing.md).

---

## License

MIT. See [LICENSE](./LICENSE). Copyright (c) 2026 Alan Hernandez.
