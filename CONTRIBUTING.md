# Contributing to claude-crap

Thanks for wanting to make claude-crap better. This plugin exists to keep
Claude Code honest about code quality — the same rigor applies to contributions
back to the plugin itself.

## Quick links

- **Issues & bugs**: [github.com/ahernandez-developer/claude-crap/issues](https://github.com/ahernandez-developer/claude-crap/issues)
- **Discussions**: [github.com/ahernandez-developer/claude-crap/discussions](https://github.com/ahernandez-developer/claude-crap/discussions)
- **Agent contract**: [plugin/CLAUDE.md](./plugin/CLAUDE.md)
- **Architecture**: [docs/architecture-overview.md](./docs/architecture-overview.md)
- **Quality gate math**: [docs/quality-gate.md](./docs/quality-gate.md)

---

## The Golden Rule

**No functional code before a characterization test pins current behavior.**

The Stop gate enforces this inside Claude Code sessions. Contributors do the
same by hand:

1. Write (or update) a test that captures the behavior you are about to touch.
2. Run it — it should pass (or fail in the way you intend) against the current code.
3. Make your change.
4. Run it again — it should still pass (or now pass).

PRs that introduce production code without matching tests will be closed.

---

## How to contribute

| You want to... | What to do |
| :-- | :-- |
| Fix a bug | Open a PR with a failing test + the fix. |
| Add a scanner adapter, language, or MCP tool | [Open a discussion](https://github.com/ahernandez-developer/claude-crap/discussions) first so we can align on shape. |
| Fix a typo or docs wording | Open a PR directly. |
| Land a refactor-only change | Don't. File an issue explaining the code-health problem and we will decide whether it is worth it. |
| Patch a red CI run on `main` | Don't. Known failures are tracked already. Test changes are welcome as part of a matching fix, not standalone. |
| Ask a question | [Open a discussion](https://github.com/ahernandez-developer/claude-crap/discussions) or file an issue with the `question` label. |

Keep PRs focused. One concern per PR. If you need more than one PR for a
coordinated change set, open an issue first so we can track the rollout.

---

## PR labels

Apply at least one **type** label to every PR. Labels are not decorative —
they drive triage, release notes, and automation. Add a **scope** label if
the change lives in a single area, and a **meta** label (`ai-assisted`) if
an AI agent wrote any part of the diff.

### Type — every PR needs one

Pick **exactly one** of these five base types:

| Label | When to use |
| :-- | :-- |
| `bug` | Fixing broken behavior. PR body must link to a reproducer or show the failing characterization test first. |
| `enhancement` | New feature, new scanner adapter, new MCP tool, new CLI flag, new language support. |
| `documentation` | README, `docs/`, `CONTRIBUTING.md`, JSDoc, or inline comments. No production code. |
| `refactor` | Internal cleanup with no user-visible change. **Only open if a maintainer explicitly asked for it** — see [How to contribute](#how-to-contribute). |
| `dependencies` | `package.json` / `package-lock.json` bumps, Renovate PRs, lockfile refreshes. |

Then add `breaking-change` **on top of the base type** if the PR forces a
major version bump:

| Label | When to use |
| :-- | :-- |
| `breaking-change` | Modifier — pair with one base type above. Signals a change that forces a major version bump: MCP tool signature change, hook contract change, CLI flag removal, SARIF store schema migration, etc. |

### Scope — optional, one or more

Add only when the change is narrowly confined. Skip scope labels entirely
for cross-cutting work — the type label plus a clear PR body is enough.

| Label | Code it covers |
| :-- | :-- |
| `scope:hooks` | `plugin/hooks/**` — PreToolUse, PostToolUse, Stop, SessionStart. |
| `scope:mcp` | `src/index.ts`, MCP tool registration, JSON schemas. |
| `scope:adapters` | `src/adapters/**` — scanner output parsers (ESLint, Semgrep, Bandit, Stryker, `dart analyze`, `dotnet format`). |
| `scope:engines` | `src/metrics/**`, `src/sarif/**`, `src/monorepo/**` — pure engines. |
| `scope:dashboard` | `src/dashboard/**` — Fastify server + Vue SPA. |
| `scope:cli` | `bin/**` and `src/cli/**` — installer, doctor, bug-report. |

### Meta — apply as needed

| Label | When to use |
| :-- | :-- |
| `ai-assisted` | **Required** whenever an AI coding agent wrote any part of the diff. See [AI-assisted PRs welcome](#ai-assisted-prs-welcome). |
| `good first issue` | **Maintainer-applied** on issues suitable for new contributors. Do not add it to your own PR. |
| `help wanted` | **Maintainer-applied** to signal a stalled PR that needs a second reviewer. |
| `question` | For issues, not PRs. If your PR raises an open question, open a [discussion](https://github.com/ahernandez-developer/claude-crap/discussions) instead. |

If a label you need does not exist yet, mention it in the PR body and the
maintainer will create it — do not block on missing labels.

---

## AI-assisted PRs welcome

claude-crap is built **for** AI-assisted development and dog-foods its own
quality gate on every commit. PRs generated with Claude Code, Codex, Cursor,
Copilot, or any other coding agent are **first-class contributions**. We just
want transparency so reviewers know what to look for.

If an agent touched the diff, please include in the PR description:

- [ ] **Apply the `ai-assisted` label** (and optionally prefix the title with `[ai]`)
- [ ] Which agent and model (e.g. `Claude Code + Opus 4.6`, `Codex + GPT-5`)
- [ ] Testing level — **untested** / **lightly tested** / **fully tested**
- [ ] A short summary of the prompts or session if that would help review
- [ ] Confirmation that you read the diff and understand what it does
- [ ] **The Stop quality gate is green locally.** Run the plugin against itself
      in a Claude Code session and let the Stop hook verify, or run
      `npx claude-crap score` and paste the A..E rating into the PR.

If the agent leaves bot review conversations on the PR, **resolve them
yourself** once addressed. Do not leave "fixed" bot comments for maintainers
to clean up. Instruct your agent to do the same — the hook contract in
[plugin/CLAUDE.md](./plugin/CLAUDE.md) already requires it.

Review quality is the same bar whether a human or an agent wrote the code.
The Golden Rule still applies: **no production code without a test.**

---

## Dev setup

You need **Node.js ≥ 20**. No other runtime. Bun ≥ 1 also works
(`bun run build`, `bun test`).

```bash
git clone https://github.com/ahernandez-developer/claude-crap.git
cd claude-crap
npm install                         # postinstall builds dist/ automatically
npm test                            # full suite must stay green
node ./bin/claude-crap.mjs doctor   # 12 diagnostic checks
```

The `postinstall` script compiles `dist/` via `tsc`, so after the first
`npm install` you can immediately boot the MCP server with `npm start`.

**Windows** contributors need a POSIX shell — use Git Bash or WSL. Native
`cmd.exe` / PowerShell are not supported for the dev loop because several
hook scripts assume POSIX path semantics.

### Fast inner loop

```bash
npm run build:watch   # tsc watch mode
npm run build:fast    # esbuild dev build — 10-20x faster than tsc
npm run dev           # tsx, no build step, runs src/index.ts directly
```

### Run the hooks standalone

You do not need to launch Claude Code to exercise a hook. Pipe a fake event
into it directly:

```bash
echo '{"hook_event_name":"Stop","tool_name":"none","tool_input":{}}' \
  | CLAUDE_PROJECT_DIR=$(pwd) node ./plugin/hooks/stop-quality-gate.mjs
```

The env-var prefix must sit in front of `node` — a prefix in front of `echo`
would only scope `CLAUDE_PROJECT_DIR` to the left side of the pipe, and the
hook process would not see it.

### Boot the MCP server standalone

```bash
node ./dist/index.js --transport stdio
```

Then speak JSON-RPC on stdin to poke individual tools.

### Running the plugin against itself

Fastest way to see an end-to-end change:

```bash
npm run build
node ./bin/claude-crap.mjs doctor
npm run test:integration
```

Or open Claude Code in the `claude-crap` workspace and let the hooks run
live — the Stop gate will score the plugin's own source against its own
policy. If a change regresses the grade, you will know immediately.

---

## Test layout

```text
src/tests/
├── crap.test.ts                        CRAP formula
├── cyclomatic.test.ts                  tree-sitter complexity walker
├── sarif-store.test.ts                 SARIF store + dedup
├── score.test.ts                       project score engine
├── tdr.test.ts                         Technical Debt Ratio
├── test-harness.test.ts                test-file resolver
├── project-map.test.ts                 monorepo discovery
├── adapters/                           per-scanner adapters
└── integration/
    └── mcp-server.integration.test.ts  stdio round trips
```

Everything uses Node's built-in `node:test` runner with `node:assert/strict`.
No Jest, no Vitest, no extra assertion library.

### Narrow test runs

```bash
npm run test:metrics      # CRAP + TDR + score
npm run test:sarif        # SARIF store
npm run test:ast          # cyclomatic walker
npm run test:harness      # test-file resolver
npm run test:adapters     # scanner adapters + dispatcher
npm run test:integration  # MCP server integration
```

---

## Coding conventions

- **TypeScript strict mode.** `strict: true` and `exactOptionalPropertyTypes: true`
  for everything in `src/`. Optional fields use `?:` and conditional spread
  (`...(x ? { x } : {})`) rather than assigning `undefined`.
- **JSDoc on every exported symbol.** File headers explain what the module
  does. Exported functions document `@param`, `@returns`, `@throws`, and
  include a small `@example` when the contract is non-obvious.
- **Pure engines.** Modules in `src/metrics/` and `src/sarif/` take their
  inputs as plain values and never read `process.env` or `fs.*` directly.
  Environment reads live in `src/config.ts`. Filesystem I/O is concentrated
  in the server entrypoint and the hook scripts.
- **English only.** Code, docs, commit messages — all in English. The plugin
  is published on npm and GitHub; keep it accessible to international
  contributors.
- **No suppression markers.** `eslint-disable`, `@ts-ignore`, and `# nosec`
  are flagged by the PostToolUse hook. We dog-food the plugin. If you need
  to suppress a lint, fix the lint instead; if you truly cannot, open an
  issue explaining why.

---

## Release process (maintainer only)

> **Version bumps, `CHANGELOG.md` entries, git tags, and npm publishes
> are the maintainer's responsibility — not contributors'.**
>
> Opening a PR is the end of the contributor workflow. Please **do not**
> run `npm run release:*`, edit the `version` field in `package.json`,
> or add a new section to `CHANGELOG.md` in your PR. Describe the change
> in your PR body (the *what* and the *why*) and the maintainer will
> curate release notes when cutting the next version.
>
> Maintainer: **Alan Hernandez** ([@ahernandez-developer](https://github.com/ahernandez-developer)).

For maintainer reference, releases go through
[`np`](https://github.com/sindresorhus/np), which runs `clean + build + test`
before tagging and publishing to npm:

```bash
npm run release         # interactive — prompts for patch/minor/major
npm run release:patch   # non-interactive patch bump
npm run release:minor
npm run release:major
```

`prepublishOnly` runs `npm run clean && npm run build && npm test`
automatically, so a broken test blocks `np` before any tag lands.

---

## Pull request checklist

Before asking for review:

- [ ] `npm run typecheck` passes
- [ ] `npm run build` succeeds
- [ ] `npm test` is green
- [ ] `npx claude-crap doctor` reports 0 failures
- [ ] New code has unit tests (Golden Rule)
- [ ] Commit message explains the **why**, not just the **what**
- [ ] PR description follows the [rigid deduction format](./plugin/CLAUDE.md)
      and clearly describes any user-visible change (the maintainer writes
      the `CHANGELOG.md` entry at release time)
- [ ] **At least one type label** is applied (see [PR labels](#pr-labels)),
      plus `ai-assisted` if an agent touched the diff
- [ ] `package.json` version is **not** bumped and `CHANGELOG.md` is **not**
      edited — releases are maintainer-only
- [ ] If AI-assisted, the AI-assisted PR checklist above is filled in

The GitHub Actions CI workflow (`.github/workflows/ci.yml`) runs the same
commands on every PR, so anything green locally should also pass upstream.

---

## Reporting bugs

```bash
npx claude-crap bug-report           # writes claude-crap-bug-report-<ts>.md
npx claude-crap bug-report --stdout  # or pipe it somewhere
```

The command collects plugin version, Node/npm/platform info, doctor output,
SARIF summary, and resolved env vars with secrets redacted. Paste the file
into the issue body at
[github.com/ahernandez-developer/claude-crap/issues](https://github.com/ahernandez-developer/claude-crap/issues)
and describe what you expected vs. what actually happened.

---

## Reporting a security vulnerability

**Do not open a public issue for security bugs.** Open a private advisory at
[github.com/ahernandez-developer/claude-crap/security/advisories/new](https://github.com/ahernandez-developer/claude-crap/security/advisories/new)
instead.

Please include:

1. Affected component — hook / MCP tool / adapter / dashboard / CLI
2. Severity assessment
3. Reproduction steps
4. Demonstrated impact
5. Suggested remediation

Reports without reproduction steps and demonstrated impact will be
deprioritized.

---

## Related reading

- [Architecture overview](./docs/architecture-overview.md)
- [Hooks reference](./docs/hooks.md)
- [MCP tools reference](./docs/mcp-tools.md)
- [Quality gate math](./docs/quality-gate.md)
- [Scanner adapters](./docs/scanner-adapters.md)
- [SDK reference](./docs/sdk.md)
- [Agent contract](./plugin/CLAUDE.md)
