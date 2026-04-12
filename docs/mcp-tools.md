# MCP tools reference

`claude-crap` exposes **seven** MCP tools and **two** MCP resources
over the stdio transport. Every tool input is validated against a
Draft-07 JSON Schema with `additionalProperties: false`, so malformed
calls are rejected before the handler runs.

Schema definitions live in `src/schemas/tool-schemas.ts`. The server
entrypoint in `src/index.ts` wires each schema to its handler.

## Tool index

| Tool | Purpose | Typical caller |
| --- | --- | --- |
| [`compute_crap`](#compute_crap) | CRAP index for a function + block verdict | Any turn that touches a function |
| [`compute_tdr`](#compute_tdr) | Technical Debt Ratio + letter grade | Any scope-level aggregation |
| [`analyze_file_ast`](#analyze_file_ast) | tree-sitter metrics for a source file | Before editing unfamiliar code |
| [`ingest_sarif`](#ingest_sarif) | Normalize + dedupe a SARIF 2.1.0 document | After running a SARIF-native scanner |
| [`ingest_scanner_output`](#ingest_scanner_output) | Adapt a scanner's native output to SARIF and ingest it | After running Semgrep / ESLint / Bandit / Stryker |
| [`require_test_harness`](#require_test_harness) | Check whether a production file has a matching test | BEFORE writing any functional code |
| [`score_project`](#score_project) | Aggregate Maintainability / Reliability / Security into an overall rating | When the user asks "how are we doing?" |

## Error semantics

Every tool handler returns an MCP `CallToolResult` shape. Some tools
intentionally set `isError: true` even on a successful call:

| Tool | Sets `isError: true` when... |
| --- | --- |
| `compute_crap` | CRAP score exceeds the configured threshold |
| `analyze_file_ast` | Workspace escape, unsupported language, or parser failure |
| `require_test_harness` | No matching test file exists for a production source file |
| `ingest_sarif` | The store rejected the document (wrong version) |
| `ingest_scanner_output` | The adapter threw (malformed input) |
| `score_project` | Overall rating exceeds `TDR_MAINTAINABILITY_MAX_RATING` |

The flag is a hint for the LLM to switch into remediation mode
rather than accepting the result as informational. Successful calls
never pollute `isError`.

---

## `compute_crap`

Compute the CRAP (Change Risk Anti-Patterns) index for a single
function and return a block verdict against the configured threshold.

**Input**

```ts
{
  cyclomaticComplexity: number;   // integer in [1, 1000]
  coveragePercent: number;        // number in [0, 100]
  functionName: string;           // ^[A-Za-z_$][A-Za-z0-9_$.:<>]*$
  filePath: string;               // [1, 4096] chars
}
```

**Output** (`content[0].text` → JSON)

```json
{
  "tool": "compute_crap",
  "function": "computeFoo",
  "file": "src/foo.ts",
  "crap": 21.216,
  "cyclomaticComplexity": 12,
  "coveragePercent": 60,
  "exceedsThreshold": false,
  "threshold": 30
}
```

See [quality-gate.md](./quality-gate.md) for the formula and the
threshold policy.

---

## `compute_tdr`

Compute the Technical Debt Ratio for a scope and return a letter
rating A..E.

**Input**

```ts
{
  remediationMinutes: number;    // >= 0
  totalLinesOfCode: integer;     // > 0
  scope: "project" | "module" | "file";
}
```

**Output** — same structure as `score.tdr` in `score_project`.

See [quality-gate.md](./quality-gate.md).

---

## `analyze_file_ast`

Parse a source file with tree-sitter and return deterministic metrics:
physical LOC, logical LOC, and a list of functions with their
cyclomatic complexity.

**Input**

```ts
{
  filePath: string;              // rejects `../` for workspace escape
  language: "csharp" | "javascript" | "typescript" | "python" | "java";
}
```

**Output**

```ts
{
  tool: "analyze_file_ast";
  filePath: string;
  language: SupportedLanguage;
  physicalLoc: number;
  logicalLoc: number;
  functions: Array<{
    name: string;
    startLine: number;
    endLine: number;
    cyclomaticComplexity: number;
    lineCount: number;
  }>;
}
```

Uses `web-tree-sitter` with WASM grammars bundled via
`tree-sitter-wasms`. Zero native compilation.

---

## `ingest_sarif`

Ingest a raw SARIF 2.1.0 document, deduplicate it by
`(ruleId, uri, startLine, startColumn)`, and persist the consolidated
store to disk.

**Input**

```ts
{
  sarifDocument: PersistedSarif; // version: "2.1.0" + runs[]
  sourceTool: string;            // [a-zA-Z0-9._-]{1,64}
}
```

**Output**

```ts
{
  tool: "ingest_sarif";
  status: "accepted";
  sourceTool: string;
  accepted: number;
  duplicates: number;
  total: number;
  storeSize: number;
  reportPath: string;
}
```

Prefer [`ingest_scanner_output`](#ingest_scanner_output) when the
scanner does not emit SARIF natively.

---

## `ingest_scanner_output`

Route a scanner's native output through the matching adapter, enrich
every finding with an effort estimate, and persist the normalized
SARIF 2.1.0 document.

**Input**

```ts
{
  scanner: "semgrep" | "eslint" | "bandit" | "stryker";
  rawOutput: string | object | array;   // accepts a JSON string OR a parsed value
}
```

**Output**

```ts
{
  tool: "ingest_scanner_output";
  status: "accepted";
  scanner: KnownScanner;
  findingsParsed: number;
  totalEffortMinutes: number;
  accepted: number;
  duplicates: number;
  total: number;
  storeSize: number;
  reportPath: string;
}
```

See [scanner-adapters.md](./scanner-adapters.md) for the per-scanner
mapping rules and effort-estimate tables.

---

## `require_test_harness`

Check whether a production source file has a matching test file in
any of the conventional locations the resolver supports.

**Input**

```ts
{
  filePath: string;              // rejects `../`
}
```

**Output**

```ts
{
  tool: "require_test_harness";
  filePath: string;
  hasTest: boolean;
  isTestFile: boolean;
  testFile: string | null;
  candidates: string[];
  corrective?: string;           // present only when hasTest === false
}
```

Returns `isError: true` when `hasTest === false`, because the
CLAUDE.md Golden Rule treats a missing test as a blocking condition.

Supported conventions:

1. Sibling `<base>.test.<ext>` / `<base>.spec.<ext>`
2. Sibling `__tests__/<base>.test.<ext>`
3. Mirror tree under `tests/`, `test/`, or `__tests__/` at the workspace root
4. Nearest-ancestor flat test directory (walks up to the workspace root looking for `tests/<base>.test.<ext>`)
5. Python: sibling `test_<base>.py` and `tests/test_<base>.py`

---

## `score_project`

Compute the aggregate project score across Maintainability,
Reliability, Security, and Overall, and return a chat-friendly
Markdown summary, a structured JSON snapshot, the local dashboard
URL, and the consolidated SARIF report path.

**Input**

```ts
{
  format?: "markdown" | "json" | "both";   // default "both"
}
```

**Output** — one or two content blocks depending on `format`. See
[scoring.md](./scoring.md) for the full `ProjectScore` shape and the
letter-grade boundaries.

---

## Resources

### `sonar://metrics/current`

JSON snapshot of the live score. Polled by the dashboard every 10
seconds. Contains the same data as `score_project` minus the Markdown
rendering.

### `sonar://reports/latest.sarif`

The consolidated SARIF 2.1.0 document as a single JSON payload.
Read by the dashboard's `/api/sarif` endpoint and by any agent that
prefers raw SARIF to the aggregated score.
