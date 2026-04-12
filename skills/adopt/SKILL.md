---
name: adopt
description: Interactive onboarding walkthrough for teams introducing claude-sonar on an existing codebase. Use this skill whenever the user asks "how do I install claude-sonar on my project", "we're adopting claude-sonar for our team", "how should I roll claude-sonar out", "what strictness mode should I pick", "we have a lot of legacy code, can we ease into this gradually", "our project has a bunch of existing errors, how do I avoid getting blocked", or is otherwise looking for guidance on gradual rollout strategy instead of just dropping a strict quality gate on a messy codebase. The skill asks a short three-question assessment about test coverage, existing findings, and appetite for hard enforcement, recommends one of three strictness modes (advisory / warn / strict), and emits a copy-pasteable .claude-sonar.json snippet for the workspace root so the team can commit the policy in a single step.
---

# Help a team adopt claude-sonar gradually

Walk the user through picking the right initial strictness mode for claude-sonar on their workspace, then hand them the exact `.claude-sonar.json` to commit. The whole interaction should take under two minutes — it is an onboarding assistant, not a full quality audit.

## Interview

Ask the user these three questions, one at a time. Wait for each answer before moving to the next so the user is not overwhelmed.

1. **"How much existing test coverage does your workspace have — would you call it green (80%+, most modules are tested), patchy (some well-tested, some bare), or near-zero?"**
2. **"Have you run any SAST or quality scanners on the workspace recently — Semgrep, ESLint with security rules, Bandit, Stryker, anything like that? Roughly how many `error`-level findings would a fresh scan produce: zero, a handful (say 1–5), or more than that?"**
3. **"Does the team want claude-sonar to hard-block task closures from day one, or would you rather see the quality verdict for a week first and decide to enforce it later?"**

## Recommendation logic

Pick the strictness using this table. The principle is simple: if the project would immediately red-light under strict mode, don't start there — the team will just disable the plugin. Start at the loosest mode that still surfaces the findings, and tighten over time.

| Test coverage | Existing error findings | Wants hard block from day one? | Recommend   |
| :------------ | :---------------------- | :----------------------------- | :---------- |
| Green         | 0                       | Yes                            | `strict`    |
| Green         | 0                       | No / unsure                    | `warn`      |
| Green         | 1–5                     | Either                         | `warn`      |
| Patchy        | 0                       | Either                         | `warn`      |
| Patchy        | 1–5                     | Either                         | `advisory`  |
| Patchy        | 6+                      | Either                         | `advisory`  |
| Near-zero     | Any                     | Any                            | `advisory`  |

If the user's answers fall outside the table exactly, lean toward the looser mode. Rolling out tight and loosening is painful; rolling out loose and tightening is natural.

## Produce the config

Output the recommended `.claude-sonar.json` in a fenced JSON code block. Use this exact shape, substituting `<recommended-mode>` with the actual value from the table (`strict`, `warn`, or `advisory`):

```jsonc
// .claude-sonar.json — commit this to the workspace root
{
  "$schema": "https://raw.githubusercontent.com/ahernandez-developer/claude-sonar/main/schemas/sonar-config.json",
  "strictness": "<recommended-mode>"
}
```

Then explain what happens in the mode you picked, in one sentence per mode:

- **strict**: The Stop hook exits 2 on any policy failure. The full verdict is injected into the agent's context via stderr, and the task cannot close until the rules are satisfied. Use this when you want claude-sonar to enforce the same way CI would.
- **warn**: The Stop hook exits 0 but writes the full verdict to stdout so the agent still sees every failing rule in its hook transcript. The task is allowed to close, and the agent can choose to remediate voluntarily on the next turn. Use this when you want pressure without blocking.
- **advisory**: The Stop hook exits 0 and writes a one-line summary to stdout. Minimal pressure on the agent — the task closes with a soft nudge. Use this when you're just collecting data and want the team to see the quality readings before enforcing anything.

## Follow-up roadmap

End with a one-paragraph gradual-adoption roadmap tailored to the mode you picked:

1. **Commit `.claude-sonar.json`** to the workspace root so the whole team picks up the policy.
2. **Let the team run for 1–2 weeks** in that mode, reviewing the local Vue dashboard at `http://127.0.0.1:5117` to see the SARIF findings accumulate.
3. **Tighten the mode by one step** (`advisory` → `warn` → `strict`) once the team is comfortable with what they're seeing and the finding count is trending down.
4. **Advanced tip**: any team member can override per-session with `CLAUDE_SONAR_STRICTNESS=<mode> claude` — useful for a one-off lenient run during an emergency, without changing the committed policy.

## Why this skill exists

Adopting a deterministic quality gate on an existing codebase is a change-management problem more than a technical one. Teams that jump straight to `strict` mode without checking their baseline tend to hit a wall the first time the Stop hook blocks a task close, get frustrated, and disable the plugin — losing all the benefit of the PreToolUse gatekeeper and the PostToolUse verifier too, which would have worked fine at their current codebase.

This skill turns the adoption question into a 30-second assessment and a ready-to-commit config. The three questions are deliberately minimal: they capture the only signals that actually matter for picking an initial mode (coverage, baseline findings, enforcement appetite), and they avoid the overhead of running a full scan before the team has even installed the plugin.

The gradual-adoption roadmap is the other half of the value: most teams never pick the "right" strictness on the first try, and the skill's job is to leave them with a clear path to tighten over time instead of a one-shot recommendation they'll regret in a month.

## Do not

- Do not recommend `strict` mode to a team that has any unresolved `error`-level findings in a recent scan. That is a guaranteed rage-quit on the first task close.
- Do not skip the interview questions. The whole point is that the recommendation matches the team's actual situation, not some default assumption about what they "should" want.
- Do not output a placeholder like `<recommended-mode>` in the JSON code block. Fill it with the actual value from the table so the user can copy-paste directly without editing.
- Do not run `score_project` as part of this skill. The interview is faster and gives the team more control over the recommendation than a baseline scan would. Reach for `/claude-sonar:score` separately if they ask for hard numbers.
