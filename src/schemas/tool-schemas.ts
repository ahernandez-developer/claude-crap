/**
 * JSON Schema (Draft-07) definitions for every tool exposed by the MCP server.
 *
 * Each schema uses `enum`, `pattern`, `minimum`, `maximum`, `oneOf` and
 * `additionalProperties: false` to eliminate schema hallucinations from the
 * LLM. The MCP SDK automatically validates tool-call inputs against these
 * schemas before invoking the handler — any drift produces a deterministic
 * error that the agent can consume and correct.
 *
 * These `description` fields are read by the LLM at tool-listing time and
 * become part of the agent's context, so they must be precise, imperative,
 * and never speculative. Keep them short but actionable.
 *
 * @module schemas/tool-schemas
 */

// The MCP SDK consumes these as the `inputSchema` field of a Tool. We type
// them with `as const` so TypeScript infers literal types and the MCP SDK
// accepts them without runtime casting.

/**
 * Schema for the `compute_crap` tool. Returns a CRAP score for a single
 * function and a block decision against the configured threshold.
 */
export const computeCrapSchema = {
  type: "object",
  description:
    "Compute the CRAP (Change Risk Anti-Patterns) index for a single function. Returns the score and whether it exceeds the configured threshold. A blocked result means the function must be decomposed or covered by more tests before the Stop quality gate will pass.",
  properties: {
    cyclomaticComplexity: {
      type: "integer",
      minimum: 1,
      maximum: 1000,
      description: "Cyclomatic complexity of the function (number of linearly independent paths).",
    },
    coveragePercent: {
      type: "number",
      minimum: 0,
      maximum: 100,
      description: "Test coverage percentage for the function, in the range [0, 100].",
    },
    functionName: {
      type: "string",
      pattern: "^[A-Za-z_$][A-Za-z0-9_$.:<>]*$",
      minLength: 1,
      maxLength: 256,
      description: "Fully qualified name of the function under analysis, used for SARIF traceability.",
    },
    filePath: {
      type: "string",
      minLength: 1,
      maxLength: 4096,
      description: "Absolute or workspace-relative path to the source file that contains the function.",
    },
  },
  required: ["cyclomaticComplexity", "coveragePercent", "functionName", "filePath"],
  additionalProperties: false,
} as const;

/**
 * Schema for the `compute_tdr` tool. Returns a Technical Debt Ratio and a
 * maintainability letter rating for a scope (project, module, or file).
 */
export const computeTdrSchema = {
  type: "object",
  description:
    "Compute the Technical Debt Ratio (TDR) for a scope and return the maintainability letter rating (A..E). Rating E always halts the workflow regardless of the configured tolerance. Use this after aggregating remediation estimates from SARIF findings.",
  properties: {
    remediationMinutes: {
      type: "number",
      minimum: 0,
      maximum: 10_000_000,
      description: "Total estimated remediation effort in minutes, summed across every finding in the scope.",
    },
    totalLinesOfCode: {
      type: "integer",
      minimum: 1,
      maximum: 100_000_000,
      description: "Physical lines of code in the scope (project, module, or file).",
    },
    scope: {
      type: "string",
      enum: ["project", "module", "file"],
      description: "Aggregation scope for the TDR computation.",
    },
  },
  required: ["remediationMinutes", "totalLinesOfCode", "scope"],
  additionalProperties: false,
} as const;

/**
 * Schema for the `analyze_file_ast` tool. Returns deterministic AST
 * metrics (LOC, cyclomatic complexity, node counts) for a source file.
 */
export const analyzeFileAstSchema = {
  type: "object",
  description:
    "Parse a source file with tree-sitter and return deterministic metrics (lines of code, cyclomatic complexity per function, top-level node counts). Prefer this tool over reading the file directly — it is faster and will not bloat the agent context.",
  properties: {
    filePath: {
      type: "string",
      minLength: 1,
      maxLength: 4096,
      // The lookahead pattern rejects any path traversal (`../`) to prevent
      // the LLM from reading files outside the workspace. Any absolute path
      // that does not contain `../` is still allowed.
      pattern: "^(?!.*\\.\\./).*$",
      description: "Path to the file to analyze. Paths containing `../` are rejected to prevent workspace escape.",
    },
    language: {
      type: "string",
      enum: ["csharp", "javascript", "typescript", "python", "java"],
      description: "Source language of the file. Determines which tree-sitter grammar to load.",
    },
  },
  required: ["filePath", "language"],
  additionalProperties: false,
} as const;

/**
 * Schema for the `score_project` tool. Aggregates the latest SARIF
 * report and the workspace size into a single project score with
 * Maintainability / Reliability / Security letter grades, an overall
 * grade, the dashboard URL (when running), and the SARIF report path.
 */
export const scoreProjectSchema = {
  type: "object",
  description:
    "Compute the aggregate project score (Maintainability / Reliability / Security / Overall A..E), and return both a chat-friendly Markdown summary and a structured JSON snapshot. Includes the local dashboard URL and the consolidated SARIF report path so the user can drill in without opening any extra tooling.",
  properties: {
    format: {
      type: "string",
      enum: ["markdown", "json", "both"],
      description:
        "Output format. `markdown` returns only the chat summary, `json` returns only the structured snapshot, `both` (default) returns both as separate content blocks.",
    },
  },
  required: [],
  additionalProperties: false,
} as const;

/**
 * Schema for the `require_test_harness` tool. Checks whether a production
 * source file has an accompanying test file in any of the conventional
 * locations the resolver supports (sibling `.test.`, `__tests__/`, mirror
 * tree, Python `test_` prefix).
 */
export const requireTestHarnessSchema = {
  type: "object",
  description:
    "Check whether a production source file has a matching test file. Returns the first existing test path, or the full list of paths the resolver probed when none exists. Use this BEFORE writing any functional code — the CLAUDE.md Golden Rule requires a test harness to exist first.",
  properties: {
    filePath: {
      type: "string",
      minLength: 1,
      maxLength: 4096,
      pattern: "^(?!.*\\.\\./).*$",
      description:
        "Path to the production file. Paths containing `../` are rejected to prevent workspace escape.",
    },
  },
  required: ["filePath"],
  additionalProperties: false,
} as const;

/**
 * Schema for the `ingest_scanner_output` tool. Accepts a scanner
 * identifier (Semgrep, ESLint, Bandit, Stryker) plus that scanner's
 * native output (SARIF or JSON), routes the input through the
 * matching adapter in `src/adapters/`, and persists the normalized
 * SARIF 2.1.0 document in the store.
 *
 * This tool is the preferred path for ingesting scanner output that
 * is not already SARIF — `ingest_sarif` remains the right choice
 * when you already have a SARIF document and just need deduplication.
 */
export const ingestScannerOutputSchema = {
  type: "object",
  description:
    "Ingest a scanner's native output (Semgrep SARIF, ESLint JSON, Bandit JSON, or Stryker JSON), route it through the matching adapter, enrich every finding with an effort estimate, and persist the normalized SARIF 2.1.0 document. Prefer this tool over `ingest_sarif` whenever the scanner does not emit SARIF natively.",
  properties: {
    scanner: {
      type: "string",
      enum: ["semgrep", "eslint", "bandit", "stryker", "dart_analyze"],
      description: "Identifier of the producing scanner.",
    },
    rawOutput: {
      description:
        "The scanner's native output. Accepts either a JSON string (as produced by the scanner's CLI) or a pre-parsed JSON object / array.",
      oneOf: [{ type: "string" }, { type: "object" }, { type: "array" }],
    },
  },
  required: ["scanner", "rawOutput"],
  additionalProperties: false,
} as const;

/**
 * Schema for the `ingest_sarif` tool. Accepts a raw SARIF 2.1.0 document
 * from an external scanner, deduplicates against the internal store, and
 * normalizes the output into claude-crap's canonical format.
 */
/**
 * Schema for the `auto_scan` tool. Auto-detects available scanners
 * in the workspace, runs them, and ingests findings into the SARIF store.
 */
/**
 * Schema for the `bootstrap_scanner` tool. Detects project type,
 * installs the appropriate scanner, creates config files, and runs
 * auto_scan to verify.
 */
export const bootstrapScannerSchema = {
  type: "object",
  description:
    "Detect the project type (JavaScript, TypeScript, Python, Java, C#), install the appropriate scanner (ESLint for JS/TS, Bandit for Python, Semgrep for Java/C#), create a minimal config file, and run auto_scan to verify. Skips installation if a scanner is already configured. Use this when auto_scan finds no scanners and quality grades are vacuously A.",
  properties: {},
  required: [],
  additionalProperties: false,
} as const;

export const autoScanSchema = {
  type: "object",
  description:
    "Auto-detect available scanners (ESLint, Semgrep, Bandit, Stryker) in the workspace, execute them, and ingest findings into the SARIF store. Returns detection results, per-scanner execution stats, and total findings ingested. Call this to populate findings without manual scanner invocation.",
  properties: {},
  required: [],
  additionalProperties: false,
} as const;

export const ingestSarifSchema = {
  type: "object",
  description:
    "Ingest a raw SARIF 2.1.0 report produced by an external scanner (Semgrep, ESLint, Bandit, Stryker, etc.), deduplicate it against the internal store, and return the normalized document. The agent should call this once per scanner invocation, not once per finding.",
  properties: {
    sarifDocument: {
      type: "object",
      description: "A full SARIF 2.1.0 document with `version` and `runs` keys.",
      properties: {
        version: { type: "string", enum: ["2.1.0"] },
        $schema: { type: "string" },
        runs: { type: "array", minItems: 1 },
      },
      required: ["version", "runs"],
    },
    sourceTool: {
      type: "string",
      pattern: "^[a-zA-Z0-9._-]{1,64}$",
      description: "Stable identifier of the tool that produced the report (`semgrep`, `eslint`, `bandit`, ...).",
    },
  },
  required: ["sarifDocument", "sourceTool"],
  additionalProperties: false,
} as const;
