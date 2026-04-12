# Contributing

Welcome. `claude-crap` is a small, opinionated plugin with a
deliberate architecture — please read [architecture-overview.md](./architecture-overview.md)
before a large change. This document covers the dev loop, the test
layout, and the release process.

## Dev loop

```bash
git clone https://github.com/ahernandez-developer/claude-crap.git
cd claude-crap
npm install                   # postinstall builds dist/ automatically
npm test                      # 105 unit + integration tests should all pass
node ./bin/claude-crap.mjs doctor
```

You need **Node.js ≥ 20**. No other runtime is required. The
`postinstall` script builds `dist/` via `tsc`, so after the first
`npm install` you can immediately boot the MCP server with
`npm start`.

### Fast inner loop

```bash
npm run build:watch           # tsc watch mode
npm run dev                   # tsx, no build step, runs src/index.ts directly
```

Run the hooks against the current workspace without Claude Code by
invoking them directly:

```bash
CLAUDE_PROJECT_DIR=$(pwd) \
  echo '{"hook_event_name":"Stop","tool_name":"none","tool_input":{}}' \
  | node ./plugin/hooks/stop-quality-gate.mjs
```

## Test layout

```
src/tests/
├── crap.test.ts                       (7 tests — CRAP formula)
├── cyclomatic.test.ts                 (5 tests — complexity walker)
├── sarif-store.test.ts                (8 tests — store + dedup)
├── score.test.ts                      (12 tests — score engine + markdown)
├── tdr.test.ts                        (11 tests — TDR boundaries)
├── test-harness.test.ts               (16 tests — resolver conventions)
├── adapters/
│   ├── semgrep.test.ts
│   ├── eslint.test.ts
│   ├── bandit.test.ts
│   ├── stryker.test.ts
│   └── dispatch.test.ts
└── integration/
    └── mcp-server.integration.test.ts (10 tests — end-to-end stdio round trips)
```

Everything uses Node's built-in `node:test` runner with no extra
assertion library — `node:assert/strict` is sufficient.

### Narrow your test runs

```bash
npm run test:metrics      # CRAP + TDR + score
npm run test:sarif        # SARIF store
npm run test:ast          # cyclomatic walker
npm run test:harness      # test-file resolver
npm run test:adapters     # scanner adapters + dispatcher
npm run test:integration  # MCP server integration
```

## Coding conventions

- **TypeScript strict mode.** Every file in `src/` is compiled with
  `strict: true` and `exactOptionalPropertyTypes: true`. Optional
  fields use `?:` and conditional spread (`...(x ? { x } : {})`)
  rather than assigning `undefined`.
- **JSDoc on every exported symbol.** File headers explain what the
  module does. Exported functions document `@param`, `@returns`,
  `@throws`, and include a small `@example` when the contract is
  non-obvious.
- **Pure engines.** Modules in `src/metrics/` and `src/sarif/` take
  their inputs as plain values and never read `process.env` or
  `fs.*` directly. Environment reads live in `src/config.ts`.
  Filesystem I/O is concentrated in the server entrypoint and the
  hook scripts.
- **English only.** The codebase, docs, and commit messages are all
  in English. The plugin is published on npm and GitHub — keep it
  accessible to international contributors.
- **No `eslint-disable`, `@ts-ignore`, or `# nosec`.** The plugin
  flags those in its own PostToolUse hook, and we eat our own dog
  food. If you need to suppress a lint, fix the lint instead; if
  you really can't, open an issue and explain.

## Running the plugin against itself

This is the fastest way to see a change end-to-end. After an edit:

```bash
npm run build                             # compile dist/
node ./bin/claude-crap.mjs doctor        # 12 diagnostic checks
npm run test:integration                  # end-to-end MCP round trips
```

Then spawn the server manually to poke it with JSON-RPC:

```bash
node ./dist/index.js --transport stdio
```

## Release process

Publishing goes through [`np`](https://github.com/sindresorhus/np)
so every release runs `clean + build + test` before tagging and
pushing to npm:

```bash
npm run release              # interactive — prompts for patch/minor/major
npm run release:patch        # non-interactive patch bump
npm run release:minor        # non-interactive minor bump
npm run release:major        # non-interactive major bump
```

`prepublishOnly` runs `npm run clean && npm run build && npm test`
automatically, so a broken test blocks `np` before any tag lands.

## Pull request checklist

Before opening a PR:

- [ ] `npm run typecheck` passes
- [ ] `npm run build` succeeds
- [ ] `npm test` is green
- [ ] `npx claude-crap doctor` reports 0 failures
- [ ] New code has unit tests
- [ ] Changed docs in `docs/` are updated if behavior changed
- [ ] Commit message explains the **why**, not just the **what**

The GitHub Actions CI workflow (`.github/workflows/ci.yml`) runs the
same commands on every PR, so anything that passes locally should
also pass upstream.

## Reporting issues

The best way to file a bug is to run:

```bash
npx claude-crap bug-report
```

The command writes a Markdown diagnostic bundle (with secrets
automatically redacted) into the current workspace. Paste it into
the issue body and describe what you expected vs. what happened.

## Related reading

- [Architecture overview](./architecture-overview.md)
- [Hooks reference](./hooks.md)
- [MCP tools reference](./mcp-tools.md)
- [Quality gate math](./quality-gate.md)
- [SDK reference](./sdk.md)
