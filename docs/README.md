# claude-crap documentation

Deep reference for every subsystem of the `claude-crap` plugin.
The top-level [README](../README.md) is the landing page and covers
installation, install paths, and a high-level tour. The files in this
directory go one level deeper and stay there.

Read them in this order if you are ramping up:

1. [Architecture overview](./architecture-overview.md) — the "Fat
   Platform / Thin Agent" thesis, the boot sequence, and how hooks,
   the MCP server, the dashboard, and the SARIF store fit together.
2. [Hooks reference](./hooks.md) — every Claude Code lifecycle hook
   the plugin registers, their contract with stdin/stderr/exit codes,
   and how to extend them.
3. [MCP tools reference](./mcp-tools.md) — schemas, inputs, outputs,
   and error semantics for all seven MCP tools.
4. [Quality gate and math](./quality-gate.md) — CRAP, Technical Debt
   Ratio, letter ratings, and how the Stop hook decides whether to
   block task completion.
5. [Project score](./scoring.md) — how `score_project` aggregates
   Maintainability / Reliability / Security into a single letter
   grade, including the Markdown renderer used for chat summaries.
6. [Scanner adapters](./scanner-adapters.md) — Semgrep, ESLint,
   Bandit, Stryker normalizers; how to add a new scanner.
7. [SDK reference](./sdk.md) — every symbol exposed under
   `claude-crap` and its subpaths, with usage examples.
8. [Contributing](./contributing.md) — dev loop, test layout, release
   scripts, coding conventions.

## Quick cross-reference

| I want to... | Read |
| --- | --- |
| Understand why claude-crap exists | [architecture-overview.md](./architecture-overview.md) |
| Know what every hook does and when it fires | [hooks.md](./hooks.md) |
| Look up an MCP tool's schema or error codes | [mcp-tools.md](./mcp-tools.md) |
| Derive a CRAP score by hand | [quality-gate.md](./quality-gate.md) |
| Understand the project's A..E grade | [scoring.md](./scoring.md) |
| Ingest output from a SAST tool | [scanner-adapters.md](./scanner-adapters.md) |
| Use the metrics engines in another tool | [sdk.md](./sdk.md) |
| Open a pull request | [contributing.md](./contributing.md) |
