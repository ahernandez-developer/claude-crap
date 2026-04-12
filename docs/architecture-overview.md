# Architecture overview

`claude-crap` turns Claude Code into a disciplined QA engineer by
wrapping every tool call and every task closure with deterministic
rails. The rails are **not** implemented as extra prompts — they are
out-of-process scripts and servers that the LLM cannot reason its way
past. The thesis behind the design is called **Fat Platform / Thin
Agent**: the agent stays an efficient generative worker, while the
platform enforces mathematical, unforgiving policies.

## Five subsystems

```
┌──────────────────────────────────────────────────────────────────────────┐
│                              Claude Code                                  │
│                                                                           │
│   ┌─────────┐                                                             │
│   │  Agent  │                                                             │
│   │  (LLM)  │                                                             │
│   └────┬────┘                                                             │
│        │ proposes a Write/Edit/Bash/...                                    │
│        ▼                                                                   │
│   ┌───────────────────┐ exit 0  ┌─────────────┐  exit 0  ┌──────────────┐ │
│   │   PreToolUse      │────────▶│   Filesystem│─────────▶│  PostToolUse │ │
│   │   gatekeeper      │  exit 2 │   or Bash   │          │   verifier   │ │
│   └─────────┬─────────┘    │    └──────┬──────┘          └──────┬───────┘ │
│             │              │           │                         │        │
│             │              ▼           │                         ▼        │
│             │         stderr →         │                   stderr →       │
│             │      agent context       │                agent warnings   │
│             │                          │                                  │
│             └──────────────────────────┘                                  │
│                                                                           │
│   ┌───────────────────────────────────────────────────────────────────┐  │
│   │                   Stop / SubagentStop quality gate                │  │
│   │   (CRAP + TDR + SARIF errors checked via plugin/hooks/lib/quality-gate) │  │
│   └───────────────────────────────────────────────────────────────────┘  │
│                                    ▲                                      │
│                                    │ reads                                 │
│                                    │                                      │
│   ┌──────────────────────────────────────────────────────────────────┐   │
│   │                   claude-crap MCP server (stdio)                │   │
│   │                                                                    │   │
│   │   Tools:                                                           │   │
│   │     - compute_crap                                                 │   │
│   │     - compute_tdr                                                  │   │
│   │     - analyze_file_ast (tree-sitter WASM)                          │   │
│   │     - ingest_sarif                                                 │   │
│   │     - ingest_scanner_output (Semgrep / ESLint / Bandit / Stryker)  │   │
│   │     - require_test_harness                                         │   │
│   │     - score_project                                                │   │
│   │                                                                    │   │
│   │   Resources:                                                       │   │
│   │     - sonar://metrics/current                                      │   │
│   │     - sonar://reports/latest.sarif                                 │   │
│   │                                                                    │   │
│   │   Side-processes:                                                  │   │
│   │     - Fastify dashboard on 127.0.0.1:5117                          │   │
│   │     - On-disk SarifStore with finding deduplication                │   │
│   └──────────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────────┘
```

Five subsystems, each deliberately small:

1. **Hooks** (`plugin/hooks/`) — ~700 lines of plain Node.js. No TypeScript,
   no dependencies. Receives a JSON payload on stdin, evaluates a
   handful of pure rules, exits with an appropriate code. Every
   decision travels through stderr into the agent's next turn.
2. **MCP server** (`src/index.ts` + `src/ast/` + `src/metrics/` +
   `src/sarif/` + `src/adapters/`) — TypeScript source built to
   `dist/` for the npm library surface and bundled to
   `plugin/bundle/mcp-server.mjs` for the git plugin distribution.
   Exposes seven stdio-transported tools and two resources. Imports
   never have side effects — only `main()` at the bottom does.
3. **Dashboard** (`src/dashboard/`) — Fastify HTTP server bound to
   `127.0.0.1` only, plus a single-file Vue 3 SPA served statically.
   Boots in the same process as the MCP server so the score tool
   always reports a live URL.
4. **Score engine** (`src/metrics/score.ts`) — pure aggregator. Takes
   the live `SarifStore`, walks the workspace with a bounded LOC
   walker, and returns a `ProjectScore` with letter grades for
   Maintainability / Reliability / Security / Overall.
5. **SDK surface** (`src/sdk.ts` + the barrel files) — the
   programmatic API, exported via `package.json#exports`. Downstream
   tools can embed CRAP, TDR, and SARIF logic without booting the
   MCP server.

## Boot sequence

1. User runs `npx claude-crap install`, then
   `/plugin install <path>` inside Claude Code.
2. Claude Code reads `.claude-plugin/plugin.json` → discovers the
   hook wiring in `plugin/hooks/hooks.json` and the MCP server launch
   command in `.mcp.json`.
3. On the next Claude Code session, two things happen in parallel:
   - The `SessionStart` hook runs, collects baseline metrics via
     `plugin/hooks/lib/quality-gate.mjs`, and prints a Markdown briefing to
     stdout that Claude Code injects into the agent's opening context.
   - Claude Code spawns `node plugin/bundle/mcp-server.mjs --transport stdio`
     (as declared in `plugin/.mcp.json`), which boots the MCP server
     and (in the same process) the Fastify dashboard on `127.0.0.1:5117`.
4. Every subsequent `Write` / `Edit` / `MultiEdit` / `NotebookEdit` /
   `Bash` call goes through `plugin/hooks/pre-tool-use.mjs` first. Most of
   the time the hook exits 0. When it exits 2, Claude Code forwards
   the stderr text to the agent, which has to revise its approach.
5. After any successful mutation, `plugin/hooks/post-tool-use.mjs` runs and
   emits warnings (test harness missing, TODO markers, suppressions).
6. When the agent announces it is done, `plugin/hooks/stop-quality-gate.mjs`
   reads the consolidated SARIF report, runs the bounded LOC walker,
   and evaluates the Stop policies. If anything fails, the gate
   returns exit 2 and Claude Code tells the agent to keep working.

## Data flow

```
  scanner output         agent Write call          session close
       │                         │                        │
       ▼                         ▼                        ▼
  ingest_sarif  /       PreToolUse gatekeeper      Stop quality gate
  ingest_scanner_output  (synchronous, in-process)  (reads disk, uses MCP)
       │                         │                        │
       ▼                         ▼                        ▼
  SarifStore  ◀──── hydrate ──── Claude Code ────── evaluate ──▶ verdict
       │                                                         │
       ├──── GET /api/sarif ──────────────────────▶ dashboard     │
       │                                                         │
       ├──── GET /api/score ──────▶ computeProjectScore ──────────┤
       │                                                         │
       └──── sonar://reports/latest.sarif ────▶ MCP tool response │
                                                                  │
                                                                  ▼
                                                          exit 0 → close
                                                          exit 2 → agent
                                                                   revises
```

The single source of truth for findings is the on-disk SARIF file at
`.claude-crap/reports/latest.sarif` in the user's workspace. Every
other view (the dashboard JSON, the `sonar://` resource, the Stop
gate's verdict, the `score_project` output) is derived from it.

## Why stdio for the MCP server

The stdio transport has two properties we wanted:

- **Every instance is per-session.** Claude Code spawns a fresh
  server for each agent session and kills it on close. The server
  never has to manage multi-tenancy or persistent connections.
- **stdout is JSON-RPC only.** That means logs have to go to stderr
  (we use `pino` piped to fd 2) and any stray `console.log` breaks
  the wire protocol. This catches accidental leaks immediately
  during development.

## Why loopback-only for the dashboard

The dashboard binds `127.0.0.1` (never `0.0.0.0`) so it cannot be
reached from another machine on the network. No auth is required for
a local process. This matches what Claude Code itself does for its
own web views.

## Related reading

- [Hooks reference](./hooks.md)
- [MCP tools reference](./mcp-tools.md)
- [Quality gate math](./quality-gate.md)
- [SDK reference](./sdk.md)
