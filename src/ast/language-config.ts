/**
 * Per-language tree-sitter node classification tables.
 *
 * Every language grammar exposes a different set of node type names. To
 * keep the AST engine language-agnostic we encode, for each supported
 * language, three sets:
 *
 *   - `functionNodeTypes`  — nodes that represent a function/method/lambda.
 *                             These are the units we report metrics for.
 *   - `branchingNodeTypes` — nodes that add one independent path through
 *                             the function. Used to compute cyclomatic
 *                             complexity by counting occurrences.
 *   - `nameField`          — the tree-sitter field name that holds the
 *                             function's identifier, used to extract the
 *                             function name for reporting.
 *
 * We also define which WASM grammar file to load per language. The paths
 * are resolved at runtime against the `tree-sitter-wasms` package, but
 * can be overridden via the engine constructor if you want to ship your
 * own grammars.
 *
 * @module ast/language-config
 */

/**
 * Languages currently supported by the AST engine. This is the same
 * `enum` that appears in the `analyze_file_ast` tool schema — keep them
 * in sync when adding a new language.
 */
export type SupportedLanguage = "csharp" | "javascript" | "typescript" | "python" | "java";

/**
 * Per-language classification record. Immutable by convention.
 */
export interface LanguageConfig {
  /** Canonical language identifier (stable across releases). */
  readonly id: SupportedLanguage;
  /** WASM grammar filename inside `tree-sitter-wasms/out/`. */
  readonly wasmName: string;
  /** File extensions that should map to this language. */
  readonly extensions: ReadonlyArray<string>;
  /** Tree-sitter node types that represent callable units. */
  readonly functionNodeTypes: ReadonlySet<string>;
  /** Tree-sitter node types that add +1 to cyclomatic complexity. */
  readonly branchingNodeTypes: ReadonlySet<string>;
  /**
   * Boolean / short-circuit operator node types. These are counted only
   * when the node is an `"&&"`, `"||"`, `"??"` (etc.) operator, so the
   * walker inspects the operator text on top of the node type.
   */
  readonly booleanOperators: ReadonlyArray<string>;
  /**
   * Child-field names we try in order to extract the function name. The
   * walker reads the first non-empty match.
   */
  readonly nameFieldCandidates: ReadonlyArray<string>;
}

// -----------------------------------------------------------------------------
// C#
// -----------------------------------------------------------------------------
// Grammar: https://github.com/tree-sitter/tree-sitter-c-sharp
const CSHARP: LanguageConfig = {
  id: "csharp",
  wasmName: "tree-sitter-c_sharp.wasm",
  extensions: [".cs"],
  functionNodeTypes: new Set([
    "method_declaration",
    "local_function_statement",
    "lambda_expression",
    "anonymous_method_expression",
    "constructor_declaration",
    "destructor_declaration",
    "operator_declaration",
    "conversion_operator_declaration",
    "accessor_declaration",
  ]),
  branchingNodeTypes: new Set([
    "if_statement",
    "else_clause",
    "while_statement",
    "do_statement",
    "for_statement",
    "for_each_statement",
    "case_switch_label",
    "case_pattern_switch_label",
    "switch_expression_arm",
    "catch_clause",
    "conditional_expression",
    "conditional_access_expression",
    "when_clause",
  ]),
  booleanOperators: ["&&", "||", "??"],
  nameFieldCandidates: ["name"],
};

// -----------------------------------------------------------------------------
// JavaScript
// -----------------------------------------------------------------------------
// Grammar: https://github.com/tree-sitter/tree-sitter-javascript
const JAVASCRIPT: LanguageConfig = {
  id: "javascript",
  wasmName: "tree-sitter-javascript.wasm",
  extensions: [".js", ".jsx", ".mjs", ".cjs"],
  functionNodeTypes: new Set([
    "function_declaration",
    "function_expression",
    "arrow_function",
    "method_definition",
    "generator_function",
    "generator_function_declaration",
  ]),
  branchingNodeTypes: new Set([
    "if_statement",
    "else_clause",
    "while_statement",
    "do_statement",
    "for_statement",
    "for_in_statement",
    "for_of_statement",
    "switch_case",
    "catch_clause",
    "ternary_expression",
  ]),
  booleanOperators: ["&&", "||", "??"],
  nameFieldCandidates: ["name"],
};

// -----------------------------------------------------------------------------
// TypeScript
// -----------------------------------------------------------------------------
// Grammar: https://github.com/tree-sitter/tree-sitter-typescript
// The TypeScript grammar inherits most node types from JavaScript, so we
// extend the JS tables rather than re-declaring them from scratch.
const TYPESCRIPT: LanguageConfig = {
  id: "typescript",
  wasmName: "tree-sitter-typescript.wasm",
  extensions: [".ts", ".tsx", ".mts", ".cts"],
  functionNodeTypes: new Set([
    ...JAVASCRIPT.functionNodeTypes,
    "function_signature",
    "method_signature",
    "abstract_method_signature",
  ]),
  branchingNodeTypes: new Set([...JAVASCRIPT.branchingNodeTypes]),
  booleanOperators: [...JAVASCRIPT.booleanOperators],
  nameFieldCandidates: ["name"],
};

// -----------------------------------------------------------------------------
// Python
// -----------------------------------------------------------------------------
// Grammar: https://github.com/tree-sitter/tree-sitter-python
const PYTHON: LanguageConfig = {
  id: "python",
  wasmName: "tree-sitter-python.wasm",
  extensions: [".py", ".pyi"],
  functionNodeTypes: new Set(["function_definition", "lambda"]),
  branchingNodeTypes: new Set([
    "if_statement",
    "elif_clause",
    "else_clause",
    "while_statement",
    "for_statement",
    "try_statement",
    "except_clause",
    "conditional_expression",
    "match_statement",
    "case_clause",
  ]),
  booleanOperators: ["and", "or"],
  nameFieldCandidates: ["name"],
};

// -----------------------------------------------------------------------------
// Java
// -----------------------------------------------------------------------------
// Grammar: https://github.com/tree-sitter/tree-sitter-java
const JAVA: LanguageConfig = {
  id: "java",
  wasmName: "tree-sitter-java.wasm",
  extensions: [".java"],
  functionNodeTypes: new Set([
    "method_declaration",
    "constructor_declaration",
    "lambda_expression",
  ]),
  branchingNodeTypes: new Set([
    "if_statement",
    "while_statement",
    "do_statement",
    "for_statement",
    "enhanced_for_statement",
    "switch_label",
    "switch_rule",
    "catch_clause",
    "ternary_expression",
  ]),
  booleanOperators: ["&&", "||"],
  nameFieldCandidates: ["name"],
};

/**
 * Complete language table. Look up by {@link SupportedLanguage} identifier.
 */
export const LANGUAGE_TABLE: Readonly<Record<SupportedLanguage, LanguageConfig>> = {
  csharp: CSHARP,
  javascript: JAVASCRIPT,
  typescript: TYPESCRIPT,
  python: PYTHON,
  java: JAVA,
};

/**
 * Infer a {@link SupportedLanguage} from a file path by matching its
 * extension. Returns `null` when no known language matches. Useful when
 * the caller does not already know the language and wants the engine to
 * pick one automatically.
 *
 * @param filePath File path (absolute or relative).
 * @returns        The detected language or `null`.
 */
export function detectLanguageFromPath(filePath: string): SupportedLanguage | null {
  const lower = filePath.toLowerCase();
  for (const config of Object.values(LANGUAGE_TABLE)) {
    for (const ext of config.extensions) {
      if (lower.endsWith(ext)) return config.id;
    }
  }
  return null;
}
