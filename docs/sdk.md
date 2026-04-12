# SDK reference

`@sr-herz/claude-sonar` ships its deterministic engines as an npm
package with a stable `exports` surface, so you can embed CRAP,
TDR, SARIF, AST analysis, and the scanner adapters in your own
tooling without running the MCP server.

Importing the package is **side-effect-free** — it does not start
the MCP server, open the dashboard, or touch the filesystem. Only
`dist/index.js` (invoked by the CLI bin and by `.mcp.json`) boots
the server.

## Entry points

| Subpath | Exports |
| --- | --- |
| `@sr-herz/claude-sonar` | Root re-export of the most common symbols plus every type |
| `@sr-herz/claude-sonar/metrics` | `computeCrap`, `computeTdr`, `classifyTdr`, `ratingIsWorseThan`, `ratingToRank`, `computeProjectScore`, `renderProjectScoreMarkdown`, `estimateWorkspaceLoc`, `MAX_FILES_WALKED` |
| `@sr-herz/claude-sonar/sarif` | `SarifStore`, `buildSarifDocument`, every `Sarif*` type |
| `@sr-herz/claude-sonar/ast` | `TreeSitterEngine`, `computeCyclomaticComplexity`, `detectLanguageFromPath`, `LANGUAGE_TABLE` |
| `@sr-herz/claude-sonar/tools` | `findTestFile`, `isTestFile`, `candidatePaths` |
| `@sr-herz/claude-sonar/adapters` | `adaptScannerOutput`, `adaptSemgrep`, `adaptEslint`, `adaptBandit`, `adaptStryker`, `KNOWN_SCANNERS`, `DEFAULT_EFFORT_BY_SEVERITY`, `wrapResultsInSarif`, `estimateEffortMinutes` |

Prefer deep imports (e.g. `@sr-herz/claude-sonar/metrics`) over the
root entry when you only need one subsystem — the barrels are
structured so tree-shakers can drop the unused ones.

## Quick examples

### Compute a CRAP score

```ts
import { computeCrap } from "@sr-herz/claude-sonar/metrics";

const result = computeCrap(
  { cyclomaticComplexity: 12, coveragePercent: 60 },
  30, // threshold
);
console.log(result.crap);             // 21.216
console.log(result.exceedsThreshold); // false
```

### Compute a TDR and classify the rating

```ts
import { computeTdr, classifyTdr } from "@sr-herz/claude-sonar/metrics";

const tdr = computeTdr({
  remediationMinutes: 240,
  totalLinesOfCode: 500,
  minutesPerLoc: 30,
});
console.log(tdr.percent); // 1.6
console.log(tdr.rating);  // "A"
console.log(classifyTdr(22)); // "D"
```

### Ingest a Semgrep report into an in-memory store

```ts
import { SarifStore } from "@sr-herz/claude-sonar/sarif";
import { adaptSemgrep } from "@sr-herz/claude-sonar/adapters";

const store = new SarifStore({
  workspaceRoot: "/project",
  outputDir: ".claude-sonar/reports",
});
await store.loadLatest();

const adapted = adaptSemgrep(rawSemgrepSarif);
const stats = store.ingestRun(adapted.document, adapted.sourceTool);
console.log(stats.accepted, stats.duplicates);
await store.persist();
```

### Build a full project score from scratch

```ts
import { SarifStore } from "@sr-herz/claude-sonar/sarif";
import {
  computeProjectScore,
  estimateWorkspaceLoc,
  renderProjectScoreMarkdown,
} from "@sr-herz/claude-sonar/metrics";

const store = new SarifStore({
  workspaceRoot: "/project",
  outputDir: ".claude-sonar/reports",
});
await store.loadLatest();

const workspace = await estimateWorkspaceLoc("/project");
const score = computeProjectScore({
  workspaceRoot: "/project",
  minutesPerLoc: 30,
  tdrMaxRating: "C",
  workspace: {
    physicalLoc: workspace.physicalLoc,
    fileCount: workspace.fileCount,
  },
  sarifStore: store,
  dashboardUrl: null,                  // or the live Fastify URL
  sarifReportPath: store.consolidatedReportPath,
});

console.log(renderProjectScoreMarkdown(score));
```

### Analyze a file with tree-sitter

```ts
import { TreeSitterEngine } from "@sr-herz/claude-sonar/ast";

const engine = new TreeSitterEngine();
const metrics = await engine.analyzeFile({
  filePath: "src/foo.ts",
  language: "typescript",
});

console.log(metrics.physicalLoc);
for (const fn of metrics.functions) {
  console.log(`${fn.name} CC=${fn.cyclomaticComplexity}`);
}
```

### Check for a matching test file

```ts
import { findTestFile } from "@sr-herz/claude-sonar/tools";

const resolution = await findTestFile("/project", "/project/src/foo.ts");
if (!resolution.testFile) {
  throw new Error(
    `No test found. Tried: ${resolution.candidates.slice(0, 3).join(", ")}`,
  );
}
```

### Dispatch a raw scanner output to the right adapter

```ts
import { adaptScannerOutput } from "@sr-herz/claude-sonar/adapters";

const result = adaptScannerOutput("bandit", rawBanditJson);
console.log(`${result.findingCount} findings, ${result.totalEffortMinutes} min of remediation`);
```

## Typed imports

Every runtime symbol in the package also exports its TypeScript
types. You can pull them directly from the same subpath:

```ts
import type {
  CrapInput,
  CrapResult,
  ProjectScore,
  SarifFinding,
  SarifLevel,
  SeverityRating,
  WorkspaceStats,
} from "@sr-herz/claude-sonar/metrics";

import type { AdapterResult, KnownScanner } from "@sr-herz/claude-sonar/adapters";
```

The root `@sr-herz/claude-sonar` entry re-exports every type too,
so a single import line works if you prefer one canonical alias.

## Versioning

The SDK surface follows semantic versioning. Breaking changes only
land in major versions. Every release is driven by `np` (see
[contributing.md](./contributing.md)) which runs `clean + build + test`
before tagging — a broken test blocks the release before any tag
lands.
