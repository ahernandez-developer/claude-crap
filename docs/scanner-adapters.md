# Scanner adapters

claude-sonar ships four per-scanner adapters that convert a scanner's
native output into a normalized SARIF 2.1.0 document the `SarifStore`
can ingest directly. Every adapter enriches each finding with a
stable `effortMinutes` value on the `properties` bag so the Stop
quality gate and the project score engine can compute a Technical
Debt Ratio.

Adapter source lives under `src/adapters/`. The shared types and the
dispatcher live in `src/adapters/common.ts` and `src/adapters/index.ts`.

## Preferred entry point

From inside an MCP session, call the `ingest_scanner_output` tool:

```json
{
  "name": "ingest_scanner_output",
  "arguments": {
    "scanner": "eslint",
    "rawOutput": "... JSON string or parsed object ..."
  }
}
```

From TypeScript or Node.js code, import the dispatcher from the SDK:

```ts
import { adaptScannerOutput } from "@sr-herz/claude-sonar/adapters";

const result = adaptScannerOutput("eslint", rawJsonFromEslint);
// result.document    → PersistedSarif (SARIF 2.1.0)
// result.findingCount → number of findings parsed
// result.totalEffortMinutes → sum of effort across findings
sarifStore.ingestRun(result.document, result.sourceTool);
```

## Supported scanners

### Semgrep

- **Native format:** SARIF 2.1.0 (via `semgrep --sarif`)
- **Adapter role:** enrichment only. Normalizes `tool.driver.name`
  to `"semgrep"` and stamps every finding with an `effortMinutes`
  estimate derived from the rule id.
- **Effort overrides:**
  - `security.*` → 90 min
  - `sqli|xss|ssrf|rce|deserial|crypto` → 120 min
  - `style.*` → 5 min
  - `formatting.*` → 3 min
  - anything else → severity default (60 / 30 / 10 / 5)
- **Mutates caller's document?** No — the adapter deep-clones via
  JSON round-trip before stamping.

### ESLint

- **Native format:** JSON (via `eslint -f json`)
- **Adapter role:** full translation to SARIF 2.1.0. Flattens every
  file report into a single SARIF run.
- **Severity mapping:**
  - `severity: 2` → `"error"` (60 min default)
  - `severity: 1` → `"warning"` (30 min default)
  - `severity: 0` → `"note"` (10 min default)
- **Location preservation:** the full `line` / `column` / `endLine` /
  `endColumn` region is propagated, so the dashboard hot-spot table
  shows precise ranges.

### Bandit

- **Native format:** JSON (via `bandit -f json`)
- **Adapter role:** full translation to SARIF 2.1.0. Every finding
  is treated as a security issue for downstream classification.
- **Severity mapping:**
  - `HIGH` → `"error"` (120 min override)
  - `MEDIUM` → `"warning"` (60 min override)
  - `LOW` → `"note"` (20 min override)
- **Rule id format:** `bandit.<test_id>` (e.g. `bandit.B608` for
  hardcoded SQL expressions). The raw `issue_cwe.id` and
  `issue_confidence` are propagated to the `properties` bag.
- **Column offset:** Bandit is 0-based, SARIF is 1-based. The
  adapter adds 1 to `col_offset` before emitting.

### Stryker

- **Native format:** JSON (via `npx stryker run` with the JSON reporter)
- **Adapter role:** full translation to SARIF 2.1.0.
- **Status mapping:**
  - `Survived` → `"error"` (45 min override — a test is needed and
    possibly a patch too)
  - `NoCoverage` → `"warning"` (15 min override)
  - `Timeout` → `"note"`
  - `Killed` / `Ignored` / `CompileError` / `RuntimeError` → suppressed
- **Rule id format:** `stryker.<mutatorName>` (e.g.
  `stryker.ConditionalExpression`).
- **Properties:** the mutant id, mutator name, and raw status are
  preserved so the dashboard can surface them as tags.

## Severity defaults

When an adapter does not supply an override, it falls back to the
table in `src/adapters/common.ts`:

| SARIF level | Default effort (min) |
| --- | ---: |
| `error` | 60 |
| `warning` | 30 |
| `note` | 10 |
| `none` | 5 |

## Deduplication

After an adapter emits its normalized document, the caller must pass
it through `SarifStore.ingestRun()`. The store deduplicates by the
tuple `(ruleId, uri, startLine, startColumn)` — identical findings
from repeated runs collapse to a single entry and the latest metadata
wins.

## Adding a new adapter

1. Create `src/adapters/<scanner>.ts` that exports an
   `adapt<Scanner>(input: unknown): AdapterResult` function.
2. Add the scanner name to `KNOWN_SCANNERS` in `src/adapters/common.ts`.
3. Register the dispatch case in `src/adapters/index.ts#adaptScannerOutput`.
4. Extend the `ingestScannerOutputSchema` in
   `src/schemas/tool-schemas.ts` to include the new scanner in its
   `enum`.
5. Add unit tests under `src/tests/adapters/<scanner>.test.ts`.
6. Update this document and the README's tool reference.

The dispatcher uses a `never` exhaustiveness check, so forgetting
step 3 is a compile-time error.

## Related reading

- [MCP tools reference](./mcp-tools.md#ingest_scanner_output)
- [Quality gate math](./quality-gate.md)
- [SDK reference](./sdk.md)
