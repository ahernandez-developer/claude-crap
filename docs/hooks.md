# Hooks reference

`claude-sonar` registers five Claude Code lifecycle hooks. Each one is
a small Node.js script with no dependencies beyond `hooks/lib/`. The
rules themselves live in `hooks/lib/gatekeeper-rules.mjs`,
`hooks/lib/quality-gate.mjs`, and `hooks/lib/test-harness.mjs` so they
can be unit-tested without spinning up Claude Code.

## Contract with Claude Code

| Channel | Purpose |
| --- | --- |
| `stdin` | JSON payload with `session_id`, `tool_name`, `tool_input`, `tool_response`, `hook_event_name` |
| `stdout` | Free-form text, stored in the hooks transcript |
| `stderr` | Injected into the agent's context when the hook exits with code 2 (blocking) |
| Exit codes | `0` allow · `2` block · any other code is treated as an internal error and fails open |

Every hook wraps its entrypoint in `runHook(name, fn)` from
`hooks/lib/hook-io.mjs`, which catches thrown errors and degrades to
fail-open so a buggy hook can never deadlock the user.

## Hook catalog

### 1. `SessionStart` — `hooks/session-start.mjs`

Runs once when Claude Code starts a new session with this plugin
active. Its job is to seed the agent's opening context with a
baseline Markdown briefing.

The briefing contains:

- A reminder of the Golden Rule and the hook contract.
- The currently configured thresholds (CRAP, TDR rating, LOC cost).
- Baseline workspace metrics read from the consolidated SARIF file.

Output goes to **stdout**, which Claude Code appends to the session
context. Fail-open: if the quality gate cannot run (MCP server not
built yet), a stripped briefing is printed instead so the session
still starts.

### 2. `PreToolUse` — `hooks/pre-tool-use.mjs`

Gatekeeper for every `Write` / `Edit` / `MultiEdit` / `NotebookEdit` /
`Bash` tool call. Runs the rules in `hooks/lib/gatekeeper-rules.mjs`
and aborts with exit 2 on the first blocking verdict.

Rules, cheapest first:

| Rule ID | What it blocks |
| --- | --- |
| `SONAR-PATH-001` | Destination path matches `BLOCKED_PATH_PATTERNS` (`.git`, `.env`, `node_modules`, `secrets`, etc.) |
| `SONAR-BASH-*` | Destructive Bash commands (`rm -rf /`, `git push --force`, `curl | bash`, ...) |
| `SONAR-SEC-*` | Hardcoded secrets in the proposed content (AWS key, private key, Slack token, GitHub token, JWT) |
| `SONAR-TEST-001` | Reserved — hard enforcement lives in PostToolUse |

Target latency: under 200 ms in the common case. No network I/O, no
filesystem I/O beyond reading stdin.

### 3. `PostToolUse` — `hooks/post-tool-use.mjs`

Retrospective verifier that runs after a successful mutation.
**Non-blocking** by design — it emits warnings on stderr and exits 0.
The agent reads the warnings and is expected to remediate on the
next turn. The Stop quality gate catches anything that still lingers
at task closure time.

Rules:

| Rule ID | What it flags |
| --- | --- |
| `SONAR-TEST-MISSING` | Production source file with no accompanying test file (uses the resolver from `hooks/lib/test-harness.mjs`) |
| `SONAR-SUPP-ESLINT-DISABLE` | `eslint-disable` / `eslint-disable-next-line` |
| `SONAR-SUPP-TS-IGNORE` | `@ts-ignore` |
| `SONAR-SUPP-TS-EXPECT-ERROR` | `@ts-expect-error` |
| `SONAR-SUPP-NOSEC` | `# nosec` (Bandit) |
| `SONAR-SUPP-TYPE-IGNORE` | `# type: ignore` (mypy / pyright) |
| `SONAR-TODO-MARKER` | `TODO`, `FIXME`, `XXX`, `HACK` markers (aggregated per file) |

### 4. `Stop` and `SubagentStop` — `hooks/stop-quality-gate.mjs`

Final quality gate. When the agent (or a subagent) declares it is
done, this hook reads the consolidated SARIF file, estimates
workspace LOC with the bounded walker in `hooks/lib/quality-gate.mjs`,
computes the TDR, and evaluates every policy. Exit 2 means the agent
must continue working; the structured corrective message goes to
stderr.

Policies:

| Rule ID | When it blocks |
| --- | --- |
| `SONAR-GATE-TDR` | Maintainability rating is worse than `TDR_MAINTAINABILITY_MAX_RATING` |
| `SONAR-GATE-ERRORS` | One or more SARIF findings at level `"error"` survive to task close |

The Stop hook **imports** `classifyTdr` and `ratingIsWorseThan`
directly from the compiled MCP server's `dist/metrics/tdr.js`, so
the classification logic is the single source of truth shared
between the hook and the MCP server. See [quality-gate.md](./quality-gate.md)
for the underlying math.

## Adding a new hook

1. Create `hooks/my-hook.mjs` and wrap its entrypoint in `runHook(...)`.
2. Put its rules in `hooks/lib/my-rules.mjs` as pure functions.
3. Register the hook in `hooks/hooks.json` under the matching
   lifecycle event.
4. Add unit tests under `src/tests/` (import the pure rule module).

Keep the contract stable: never write to stdout unless you want
informational output in the transcript, always write corrective text
to stderr, and always exit 2 for blocks.

## Extending `BLOCKED_PATH_PATTERNS`

The pattern is a JavaScript regex sourced from
`CLAUDE_PLUGIN_OPTION_BLOCKED_PATH_PATTERNS`. To block an additional
directory (e.g. `infra/prod/`), override the option in your Claude
Code workspace settings:

```json
{
  "env": {
    "CLAUDE_PLUGIN_OPTION_BLOCKED_PATH_PATTERNS":
      "(^|/)(\\.git|\\.env|node_modules|\\.venv|secrets?|credentials?|infra/prod)(/|$)"
  }
}
```

The default pattern is in `.claude-plugin/plugin.json`.
