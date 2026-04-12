# Quality gate and math

The Stop hook refuses to close a task until every configured policy
holds against the consolidated SARIF report and the current workspace
LOC. This document explains the underlying math so you can derive
any verdict by hand.

## CRAP index

The CRAP (Change Risk Anti-Patterns) index quantifies how dangerous
it is to change a single function. The formula:

$$
\text{CRAP}(m) = \text{comp}(m)^2 \cdot \left(1 - \frac{\text{cov}(m)}{100}\right)^3 + \text{comp}(m)
$$

Where:

- $\text{comp}(m)$ is the cyclomatic complexity of function $m$.
- $\text{cov}(m)$ is the test coverage percentage in $[0, 100]$.

### Why the exponents matter

The **cubic uncovered-weight term** makes the score explode for
branchy, untested code. Examples with `CRAP_THRESHOLD = 30`:

| Complexity | Coverage | Uncovered | CRAP |
| ---: | ---: | ---: | ---: |
| 5 | 100% | 0 | 5 |
| 5 | 80% | 0.2 | 5.2 |
| 10 | 80% | 0.2 | 10.8 |
| 10 | 60% | 0.4 | 16.4 |
| 10 | 0% | 1.0 | **110** |
| 12 | 60% | 0.4 | 21.216 |
| 15 | 50% | 0.5 | 43.125 |

The **additive `+ comp(m)` tail** encodes the "no amount of tests
can save a monster function" policy. Any function with
`comp ≥ threshold` can never pass, even with 100% coverage — because
the tail alone already reaches the threshold.

### Block decision

```
exceedsThreshold = crap > CRAP_THRESHOLD
```

`CRAP_THRESHOLD` defaults to **30**. Override it via
`CLAUDE_PLUGIN_OPTION_CRAP_THRESHOLD`.

The `compute_crap` MCP tool returns `isError: true` whenever
`exceedsThreshold` is true, which pushes the agent into remediation
mode.

## Technical Debt Ratio (TDR)

The Technical Debt Ratio expresses the cost of remediating all known
issues as a percentage of the cost of writing the code in the first
place:

$$
\text{TDR} = \frac{\text{remediationMinutes}}{\text{minutesPerLoc} \cdot \text{totalLinesOfCode}}
$$

`minutesPerLoc` defaults to **30** — an industry-standard estimate
covering design, writing, and review. Override via
`CLAUDE_PLUGIN_OPTION_MINUTES_PER_LINE_OF_CODE`.

### Letter rating

The computed percentage maps to a strict letter grade:

| Rating | TDR % | Meaning |
| :---: | :--- | :--- |
| **A** | 0 – 5% | Excellent. Remediation cost is noise. |
| **B** | > 5 – 10% | Low risk. |
| **C** | > 10 – 20% | Moderate. Watch closely. |
| **D** | > 20 – 50% | Critical. Remediation plan required. |
| **E** | > 50% | Unmaintainable. **Halt feature work.** |

Rating **E** halts the workflow at the Stop gate regardless of the
configured `TDR_MAINTAINABILITY_MAX_RATING`.

### Example

A project with:

- 4000 LOC
- 10 findings × 30 min remediation each = 300 min
- `minutesPerLoc` = 30

$$
\text{TDR} = \frac{300}{30 \cdot 4000} = 0.0025 = 0.25\%
$$

That's well inside rating **A** (the 0–5% bracket). Adding 20 more
`error`-level findings of 60 min each (1200 min) brings the total to:

$$
\text{TDR} = \frac{1500}{30 \cdot 4000} = 0.0125 = 1.25\%
$$

Still an **A** — the workspace LOC denominator absorbs quite a lot.
You have to hit roughly 6000 minutes of remediation over 4000 LOC
to drop to rating **C** (20%).

## Reliability and security ratings

Unlike TDR (which averages over the whole project), the reliability
and security ratings are driven by the **worst finding** in the
scope. The `score_project` tool splits findings into two buckets by
matching the `ruleId` against a security keyword regex:

```
/(sec|sql|xss|csrf|ssrf|injection|crypt|auth|secret|password|token|cve|vuln|jwt|cors|rce|deserial|prototype-pollution)/i
```

Findings whose rule id matches go into the **security** bucket;
everything else is **reliability**. Each bucket is then graded:

| Rating | Dimension verdict |
| :---: | :--- |
| **A** | 0 findings |
| **B** | Only `note`-level findings |
| **C** | 1+ `warning`, 0 `error` |
| **D** | 1–2 `error` findings |
| **E** | 3+ `error` findings |

## Overall rating

$$
\text{overall} = \max(\text{Maintainability}, \text{Reliability}, \text{Security})
$$

Where `max` returns the **worst** (alphabetically highest) letter.
The overall rating **passes** when it is no worse than
`TDR_MAINTAINABILITY_MAX_RATING` (the policy ceiling, default `C`).

## Stop gate policies

Rule IDs emitted when the gate blocks:

| Rule ID | Condition |
| --- | --- |
| `SONAR-GATE-TDR` | Maintainability rating worse than the policy ceiling |
| `SONAR-GATE-ERRORS` | At least one SARIF finding at level `"error"` |

Each failure renders as a framed block on stderr with a corrective
message. Claude Code injects the box into the agent's context, which
tells the agent exactly what to fix before retrying the Stop hook.

## Strictness modes and gradual adoption

The `strictness` value controls how the Stop gate and `score_project`
react when a policy fails. The PreToolUse security gatekeeper is
**always** strict regardless of this setting.

| Mode       | Stop exit | Verdict sink | Agent experience |
| :--------- | :-------: | :----------- | :--------------- |
| `strict`   |    `2`    | stderr       | Full `BLOCKED` box — task cannot close. **Default.** |
| `warn`     |    `0`    | stdout       | Full `WARNING` box — agent sees failures but task closes. |
| `advisory` |    `0`    | stdout       | Single-line nudge only. |

**Override per workspace** with `.claude-crap.json` at the root:

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/ahernandez-developer/claude-crap/main/schemas/crap-config.json",
  "strictness": "warn"
}
```

Or per session: `CLAUDE_CRAP_STRICTNESS=advisory claude`

**Precedence** (most specific wins): env var > `.claude-crap.json` >
hardcoded `strict`.

### Adoption strategy

Start in `advisory` so the agent annotates sessions with a quality
reading. Bump to `warn` once the team is comfortable. When the
project is clean enough, delete the file (or switch to `strict`) and
let CI catch regressions.

### Compliance note

Claude Code's plugin spec recommends `userConfig` prompts for user
configuration. `claude-crap` deliberately reads `.claude-crap.json`
from the workspace root instead because:

- An install-time prompt for an enum with a sensible default (`strict`)
  is friction with no upside for 99% of users.
- A workspace file can be committed to git alongside `.eslintrc.json`,
  `.prettierrc.json`, etc. — team-wide policy in version control.
- A JSON schema under `schemas/crap-config.json` provides IDE
  autocompletion — `userConfig` has no equivalent surface.

We comply with every other part of the plugin spec (manifest, hooks,
MCP server, substitution tokens, directory layout).

## Related reading

- [Hooks reference](./hooks.md) — exactly when each hook runs
- [Scoring](./scoring.md) — how the dimensions are aggregated
- [MCP tools reference](./mcp-tools.md) — `compute_crap`, `compute_tdr`, `score_project`
