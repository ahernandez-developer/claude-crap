# Project score

The `score_project` MCP tool collapses the entire workspace into a
single chat-friendly verdict. This document covers what goes into
that verdict, how each dimension is computed, and how the Markdown
summary is shaped.

## `ProjectScore` shape

```ts
interface ProjectScore {
  generatedAt: string;                  // ISO timestamp
  workspaceRoot: string;

  loc: {
    physical: number;                   // total physical LOC in the scoped workspace
    files: number;                      // number of files the walker visited
  };

  findings: {
    total: number;
    error: number;
    warning: number;
    note: number;
    byTool: Record<string, number>;     // counts per sourceTool
    byFile: Record<string, number>;     // counts per file URI
  };

  maintainability: {
    rating: "A" | "B" | "C" | "D" | "E";
    tdrPercent: number;
    remediationMinutes: number;
    developmentCostMinutes: number;
  };

  reliability: {
    rating: "A" | "B" | "C" | "D" | "E";
    findings: number;
    errorFindings: number;
    warningFindings: number;
    noteFindings: number;
  };

  security: {
    rating: "A" | "B" | "C" | "D" | "E";
    findings: number;
    errorFindings: number;
    warningFindings: number;
    noteFindings: number;
  };

  overall: {
    rating: "A" | "B" | "C" | "D" | "E";
    passes: boolean;                    // true when overall <= policy ceiling
    policyRating: "A" | "B" | "C" | "D" | "E";  // echo of TDR_MAINTAINABILITY_MAX_RATING
  };

  location: {
    dashboardUrl: string | null;        // null when Fastify failed to bind
    sarifReportPath: string;
  };
}
```

## Inputs

`computeProjectScore(input)` takes exactly what it needs and nothing
more, so the engine stays pure:

```ts
interface ComputeProjectScoreInput {
  workspaceRoot: string;
  minutesPerLoc: number;
  tdrMaxRating: "A" | "B" | "C" | "D" | "E";
  workspace: { physicalLoc: number; fileCount: number };
  sarifStore: SarifStore;
  dashboardUrl: string | null;
  sarifReportPath: string;
}
```

The workspace LOC stats come from `estimateWorkspaceLoc()` in
`src/metrics/workspace-walker.ts`, which is a bounded walker that
skips `node_modules`, `.git`, `dist`, `build`, `target`, `.venv`,
`__pycache__`, `.next`, and `.claude-crap` and hard-stops at 20,000
files.

## Classification pipeline

1. **Iterate** every finding in the live `SarifStore`.
2. **Match** its `ruleId` against the security keyword regex
   (see [quality-gate.md](./quality-gate.md)) and drop it in either
   the `security` or `reliability` bucket.
3. **Sum** `properties.effortMinutes` across all findings for the
   TDR numerator.
4. **Compute** TDR% = remediation / (minutesPerLoc × LOC).
5. **Classify** each dimension independently:
   - Maintainability → `classifyTdr(tdrPercent)`
   - Reliability / Security → `scoreDimension(findings)` (see below)
6. **Collapse** to overall = worst of the three.
7. **Compare** overall against `tdrMaxRating` → `passes`.

### `scoreDimension`

Pure function of a finding list, returns a `DimensionScore`:

| Findings | Rating |
| --- | :---: |
| none | A |
| only `note` | B |
| 1+ `warning`, 0 `error` | C |
| 1–2 `error` | D |
| 3+ `error` | E |

## Markdown renderer

`renderProjectScoreMarkdown(score)` produces a compact, chat-ready
summary — the same one the `score_project` MCP tool returns as its
first content block.

```
## claude-crap :: project score

**Overall: A** (✅ passes policy, policy ceiling = C)

| Dimension       | Rating | Detail                                              |
| --------------- | :----: | --------------------------------------------------- |
| Maintainability |   A    | TDR 0% (0 min over 6501 LOC)                        |
| Reliability     |   A    | 0 error · 0 warning · 0 note                        |
| Security        |   A    | 0 error · 0 warning · 0 note                        |

Workspace: **6501 LOC** across **35 files**
Findings:  **0 total** (0 error · 0 warning · 0 note)
Tools:     <none ingested>

📊 Dashboard:   http://127.0.0.1:5117
📄 Report:      /path/to/.claude-crap/reports/latest.sarif
```

Two lines worth noting:

- **Dashboard URL** is omitted and replaced with
  `<not running — start the MCP server to enable>` when
  `dashboardUrl === null`. The Fastify server logs a warning and
  keeps running when its configured port is already in use.
- **Report path** is absolute so the user can click-copy it into a
  shell. It points at `.claude-crap/reports/latest.sarif` relative
  to the workspace root by default.

## When `isError` fires

`score_project` is the rare MCP tool that reports back `isError: true`
on a **successful** call — specifically when `overall.passes === false`.
This is intentional: a failing policy should trip the LLM's
corrective-mode behavior, not be treated as routine output.

## Related reading

- [Quality gate math](./quality-gate.md) — TDR formula and letter thresholds
- [MCP tools reference](./mcp-tools.md#score_project) — tool schema
- [Dashboard](./architecture-overview.md) — where the URL comes from
