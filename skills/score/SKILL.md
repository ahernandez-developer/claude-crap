---
name: score
description: Run claude-sonar's deterministic project quality gate and display the A..E letter grade across Maintainability, Reliability, Security, and Overall. Use this skill whenever the user asks "how's the code quality", "what's my CRAP index", "is this project shippable", "show me the technical debt ratio", "run the quality gate", "score the project", or wants a one-glance read on whether the current workspace passes its policy ceiling. Also use this skill proactively at the start of a refactoring session or before a release to establish a quality baseline, and after a substantial refactor to verify the grade has not regressed. Do NOT use it for incident debugging or per-file analysis — for a single file, reach for /claude-sonar:analyze instead.
---

# Score the project

Run the `score_project` MCP tool from the claude-sonar server and display the result.

## Steps

1. Invoke the MCP tool `score_project` with `format: "both"` so you get both the Markdown summary and the JSON snapshot in one call.
2. Display the Markdown summary verbatim. Do not paraphrase, round, or reorder the dimension ratings — they are deterministic, they come directly from the CRAP / TDR / rating engines, and they must be shown exactly as the engine produced them so the user can verify against the dashboard.
3. If the tool response has `isError: true`, the overall rating is worse than the configured policy ceiling under strict mode. Explicitly tell the user their workspace **FAILS** the policy, surface the rule IDs from the failures array (e.g. `SONAR-GATE-TDR`, `SONAR-GATE-ERRORS`), and recommend they drill into the dashboard URL or the consolidated SARIF report to see the underlying findings.
4. If the tool succeeds, tell the user the dashboard URL from the Markdown content so they can open it in a browser for per-file hot spots, and the SARIF report path so they can grep it with other tools if they prefer.

## What the user will see

The output includes four A..E letter grades (one per dimension plus an overall), the TDR percent, per-level finding counts, workspace LOC, the scanners that have already ingested findings, the dashboard URL, and the SARIF report path. The overall grade is the worst of the three dimension grades by policy, so a single E-rated security finding drops the whole score to E regardless of maintainability.

## Why this skill exists

The `score_project` MCP tool is the canonical "is this project shippable?" reading for claude-sonar. It gets run automatically at the Stop quality gate on every task close, but users often want an ad-hoc read mid-session — to know whether a refactor actually improved the grade, to get a baseline before starting new work, or to decide whether to open a PR now or keep iterating. Making it a single slash command instead of a three-step MCP tool invocation removes the friction from those workflows.

The engine is deterministic: given the same SARIF store and the same workspace, `score_project` always returns the same grade. That is a feature, not a limitation — it means two developers on the same branch will see identical readings, and it means the grade is safe to cite in PR descriptions and commit messages without the usual LLM caveats about reproducibility.

## Do not

- Do not compute CRAP or TDR by hand, or estimate the grade "based on what you've seen of the codebase". The only valid answer is what `score_project` returns.
- Do not suggest remediations that aren't grounded in the SARIF findings the tool reports. If the Security dimension is D, open the SARIF file and read the rule IDs before recommending fixes — do not speculate.
- Do not hide the dashboard URL. Users rely on it to drill into the detail the Markdown summary necessarily elides.
