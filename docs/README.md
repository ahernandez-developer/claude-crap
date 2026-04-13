# claude-crap documentation

Deep reference for every subsystem of the `claude-crap` plugin.
The top-level [README](../README.md) is the landing page and covers
installation, install paths, and a high-level tour. The files in this
directory go one level deeper and stay there.

Read them in this order if you are ramping up:

1. [Supported languages & scanners](./supported-languages.md) — every
   language, how it is detected, which scanner runs, monorepo
   auto-discovery, and how to add a new scanner.
2. [Architecture overview](./architecture-overview.md) — the "Fat
   Platform / Thin Agent" thesis, the boot sequence, and how hooks,
   the MCP server, the dashboard, and the SARIF store fit together.
3. [Hooks reference](./hooks.md) — every Claude Code lifecycle hook
   the plugin registers, their contract with stdin/stderr/exit codes,
   and how to extend them.
4. [MCP tools reference](./mcp-tools.md) — schemas, inputs, outputs,
   and error semantics for all MCP tools.
5. [Quality gate and math](./quality-gate.md) — CRAP, Technical Debt
   Ratio, letter ratings, and how the Stop hook decides whether to
   block task completion.
6. [Project score](./scoring.md) — how `score_project` aggregates
   Maintainability / Reliability / Security into a single letter
   grade, including the Markdown renderer used for chat summaries.
7. [Scanner adapters](./scanner-adapters.md) — Semgrep, ESLint,
   Bandit, Stryker, Dart analyzer, dotnet format normalizers.
8. [SDK reference](./sdk.md) — every symbol exposed under
   `claude-crap` and its subpaths, with usage examples.
9. [Contributing](./contributing.md) — dev loop, test layout, release
   scripts, coding conventions.

## Quick cross-reference

| I want to... | Read |
| --- | --- |
| See which languages and scanners are supported | [supported-languages.md](./supported-languages.md) |
| Understand monorepo auto-discovery | [supported-languages.md](./supported-languages.md#monorepo-auto-discovery) |
| Understand why claude-crap exists | [architecture-overview.md](./architecture-overview.md) |
| Know what every hook does and when it fires | [hooks.md](./hooks.md) |
| Look up an MCP tool's schema or error codes | [mcp-tools.md](./mcp-tools.md) |
| Derive a CRAP score by hand | [quality-gate.md](./quality-gate.md) |
| Understand the project's A..E grade | [scoring.md](./scoring.md) |
| Ingest output from a SAST tool | [scanner-adapters.md](./scanner-adapters.md) |
| Add support for a new language | [supported-languages.md](./supported-languages.md#adding-support-for-a-new-language) |
| Use the metrics engines in another tool | [sdk.md](./sdk.md) |
| Open a pull request | [contributing.md](./contributing.md) |
