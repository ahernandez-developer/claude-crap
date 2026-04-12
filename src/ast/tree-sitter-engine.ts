/**
 * Tree-sitter based AST analysis engine.
 *
 * This module wraps `web-tree-sitter` (the WASM build of tree-sitter) to
 * parse source files and extract deterministic per-function metrics. The
 * WASM variant is used instead of the native bindings so that `npm install`
 * never has to invoke a C compiler — matching the plugin's "zero install
 * friction" promise.
 *
 * The engine is lazy:
 *
 *   - `web-tree-sitter` is initialized only on first use.
 *   - Grammar WASM files are loaded on demand and cached per language.
 *
 * This keeps MCP server startup fast (crucial because Claude Code will
 * spin the server up and tear it down across sessions).
 *
 * Usage:
 *
 * ```ts
 * const engine = new TreeSitterEngine();
 * const result = await engine.analyzeFile({
 *   filePath: "src/foo.ts",
 *   language: "typescript",
 * });
 * console.log(result.functions);
 * ```
 *
 * @module ast/tree-sitter-engine
 */

import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { computeCyclomaticComplexity, type AstNode } from "./cyclomatic.js";
import { LANGUAGE_TABLE, type LanguageConfig, type SupportedLanguage } from "./language-config.js";

/**
 * Minimal typed view of the `web-tree-sitter` Parser class and its
 * static helpers. The npm package uses `export = Parser` (a CommonJS
 * default export), so under ESM interop `await import('web-tree-sitter')`
 * returns `{ default: Parser }` where `Parser`:
 *
 *   - is a constructable class (`new Parser()`)
 *   - exposes `static init(moduleOptions)` to bootstrap the WASM runtime
 *   - exposes the nested `Parser.Language.load(pathOrBytes)` static
 *     to load a grammar from a `.wasm` file or a raw byte buffer
 *
 * We model that surface here so downstream consumers of this engine are
 * not forced to import `web-tree-sitter` types directly.
 */
interface ParserInstance {
  setLanguage(language: unknown): void;
  parse(source: string): { rootNode: AstNode };
}

interface ParserCtor {
  new (): ParserInstance;
  init(options?: { locateFile?: (name: string) => string }): Promise<void>;
  Language: { load(path: string | Uint8Array): Promise<unknown> };
}

/**
 * Per-function metrics returned by the engine.
 */
export interface FunctionMetrics {
  /** Human-readable function name, or `"<anonymous>"` when not available. */
  readonly name: string;
  /** 1-based line where the function body starts. */
  readonly startLine: number;
  /** 1-based line where the function body ends. */
  readonly endLine: number;
  /** McCabe cyclomatic complexity (always ≥ 1). */
  readonly cyclomaticComplexity: number;
  /** Physical lines of code covered by the function (endLine - startLine + 1). */
  readonly lineCount: number;
}

/**
 * File-level metrics returned by the engine.
 */
export interface FileMetrics {
  /** File path that was analyzed, echoed from the request for traceability. */
  readonly filePath: string;
  /** Language the file was parsed as. */
  readonly language: SupportedLanguage;
  /** Total physical lines in the file, including blanks and comments. */
  readonly physicalLoc: number;
  /** Physical lines that contain at least one non-whitespace character. */
  readonly logicalLoc: number;
  /** Per-function metrics sorted by starting line. */
  readonly functions: ReadonlyArray<FunctionMetrics>;
}

/**
 * Request accepted by {@link TreeSitterEngine.analyzeFile}.
 */
export interface AnalyzeFileRequest {
  readonly filePath: string;
  readonly language: SupportedLanguage;
}

/**
 * Options accepted by the engine constructor. All fields are optional and
 * safe defaults are used when omitted.
 */
export interface TreeSitterEngineOptions {
  /**
   * Directory where the language grammar WASM files live (one per
   * language, e.g. `tree-sitter-typescript.wasm`). Defaults to the
   * `tree-sitter-wasms/out` directory inside `node_modules`.
   */
  readonly grammarsDir?: string;
  /**
   * Directory where the `web-tree-sitter` runtime WASM (`tree-sitter.wasm`)
   * lives. This is a different package from the grammars — the runtime
   * ships with `web-tree-sitter` itself. Defaults to that package's
   * install directory inside `node_modules`.
   */
  readonly runtimeDir?: string;
  /**
   * Override the WASM loader for tests. Receives the grammar filename
   * and must return the raw bytes.
   */
  readonly loadGrammar?: (wasmPath: string) => Promise<Uint8Array>;
}

/**
 * High-level AST engine. Instances are meant to be long-lived — create
 * one at server startup and reuse it for every analysis request.
 */
export class TreeSitterEngine {
  private parserCtor: ParserCtor | null = null;
  private readonly loadedLanguages = new Map<SupportedLanguage, unknown>();
  private readonly grammarsDir: string;
  private readonly runtimeDir: string;
  private readonly loadGrammar: (wasmPath: string) => Promise<Uint8Array>;
  private initPromise: Promise<void> | null = null;

  constructor(options: TreeSitterEngineOptions = {}) {
    this.grammarsDir = options.grammarsDir ?? resolveDefaultGrammarsDir();
    this.runtimeDir = options.runtimeDir ?? resolveDefaultRuntimeDir();
    this.loadGrammar = options.loadGrammar ?? ((path) => fs.readFile(path));
  }

  /**
   * Analyze a source file and return per-function and file-level metrics.
   *
   * @param req The analysis request.
   * @returns   A {@link FileMetrics} snapshot ready to be serialized.
   * @throws    When the file cannot be read or the grammar cannot be loaded.
   */
  async analyzeFile(req: AnalyzeFileRequest): Promise<FileMetrics> {
    const languageConfig = LANGUAGE_TABLE[req.language];
    if (!languageConfig) {
      throw new Error(`[tree-sitter-engine] Unsupported language: ${req.language}`);
    }

    const source = await fs.readFile(req.filePath, "utf8");
    const parser = await this.ensureParserFor(languageConfig);
    const tree = parser.parse(source);

    const functions = collectFunctionMetrics(tree.rootNode, languageConfig);
    const { physicalLoc, logicalLoc } = countLines(source);

    return {
      filePath: req.filePath,
      language: languageConfig.id,
      physicalLoc,
      logicalLoc,
      functions,
    };
  }

  /**
   * Ensure a parser with the requested language grammar bound is ready.
   * Both the Parser class and the grammar are initialized lazily and
   * cached on first use.
   *
   * @param config Language configuration for the requested grammar.
   * @returns      A fresh parser instance configured for the language.
   */
  private async ensureParserFor(config: LanguageConfig): Promise<ParserInstance> {
    if (!this.parserCtor) {
      if (!this.initPromise) {
        this.initPromise = this.initParserModule();
      }
      await this.initPromise;
    }
    const Parser = this.parserCtor;
    if (!Parser) {
      throw new Error("[tree-sitter-engine] Parser class failed to initialize");
    }

    let language = this.loadedLanguages.get(config.id);
    if (!language) {
      const wasmPath = join(this.grammarsDir, config.wasmName);
      const bytes = await this.loadGrammar(wasmPath);
      language = await Parser.Language.load(bytes);
      this.loadedLanguages.set(config.id, language);
    }

    const parser = new Parser();
    parser.setLanguage(language);
    return parser;
  }

  /**
   * Import and initialize `web-tree-sitter`. Isolated in its own method
   * so the dynamic import runs exactly once per engine instance.
   *
   * `web-tree-sitter` uses `export = Parser` so under ESM interop the
   * Parser class arrives on the `default` property of the imported
   * namespace. `Parser.init()` is a STATIC method on the class, not a
   * top-level module function.
   */
  private async initParserModule(): Promise<void> {
    const imported = (await import("web-tree-sitter")) as { default: ParserCtor };
    const Parser = imported.default;
    if (!Parser || typeof Parser.init !== "function") {
      throw new Error(
        "[tree-sitter-engine] web-tree-sitter did not expose the expected Parser class",
      );
    }
    // Emscripten calls `locateFile` to resolve the runtime WASM during
    // `Parser.init()`. The runtime file (`tree-sitter.wasm`) lives inside
    // the `web-tree-sitter` package itself, NOT alongside the grammars,
    // so we route requests for that exact filename to `runtimeDir`.
    // Anything else falls back to `grammarsDir` for the per-language
    // grammar files loaded later by `Parser.Language.load()`.
    await Parser.init({
      locateFile: (name: string) =>
        name === "tree-sitter.wasm"
          ? join(this.runtimeDir, name)
          : join(this.grammarsDir, name),
    });
    this.parserCtor = Parser;
  }
}

/**
 * Resolve the default grammar directory to `tree-sitter-wasms/out` inside
 * `node_modules`. Uses `createRequire` so the lookup works regardless of
 * whether the caller is running from source (`tsx`) or from the built
 * `dist/` directory.
 */
function resolveDefaultGrammarsDir(): string {
  try {
    const requireFromHere = createRequire(import.meta.url);
    // `tree-sitter-wasms` exposes its grammar files under `out/`.
    const pkgJsonPath = requireFromHere.resolve("tree-sitter-wasms/package.json");
    return join(dirname(pkgJsonPath), "out");
  } catch {
    // Fall back to a sibling `grammars/` directory if the npm package
    // is not installed — useful for repo-local grammars.
    const here = dirname(fileURLToPath(import.meta.url));
    return resolve(here, "..", "..", "grammars");
  }
}

/**
 * Resolve the default runtime directory to the `web-tree-sitter` package
 * root inside `node_modules`. The runtime WASM (`tree-sitter.wasm`) ships
 * with the `web-tree-sitter` package itself rather than with the grammar
 * package, so we have to look it up separately from the grammars.
 */
function resolveDefaultRuntimeDir(): string {
  try {
    const requireFromHere = createRequire(import.meta.url);
    const pkgJsonPath = requireFromHere.resolve("web-tree-sitter/package.json");
    return dirname(pkgJsonPath);
  } catch {
    // Fall back to the grammars directory — better than nothing if
    // someone is running with a custom layout.
    return resolveDefaultGrammarsDir();
  }
}

/**
 * Walk the top-level AST and collect metrics for every function node,
 * including nested functions. The caller gets a flat, line-sorted list.
 *
 * @param root           AST root node returned by tree-sitter.
 * @param languageConfig Language tables to classify nodes.
 * @returns              Flat list of function metrics sorted by start line.
 */
function collectFunctionMetrics(
  root: AstNode,
  languageConfig: LanguageConfig,
): ReadonlyArray<FunctionMetrics> {
  const out: FunctionMetrics[] = [];

  function visit(node: AstNode): void {
    if (languageConfig.functionNodeTypes.has(node.type)) {
      out.push(buildFunctionMetrics(node, languageConfig));
      // Intentionally continue the walk so nested functions are also
      // reported. Each nested function's complexity is computed against
      // its own subtree; cyclomatic.ts skips nested functions during
      // the walk so the parent's score is not inflated.
    }
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) visit(child);
    }
  }

  visit(root);
  out.sort((a, b) => a.startLine - b.startLine);
  return out;
}

/**
 * Build a {@link FunctionMetrics} record for a single function node.
 */
function buildFunctionMetrics(node: AstNode, languageConfig: LanguageConfig): FunctionMetrics {
  const name = extractFunctionName(node, languageConfig);
  const position = extractPosition(node);
  const complexity = computeCyclomaticComplexity(node, languageConfig);
  return {
    name,
    startLine: position.startLine,
    endLine: position.endLine,
    cyclomaticComplexity: complexity,
    lineCount: position.endLine - position.startLine + 1,
  };
}

/**
 * Pull the function name out of a function node. Tree-sitter exposes a
 * `childForFieldName` accessor on its real nodes; we feature-detect it
 * because our minimal {@link AstNode} contract does not require it.
 */
function extractFunctionName(node: AstNode, languageConfig: LanguageConfig): string {
  const anyNode = node as AstNode & {
    childForFieldName?: (field: string) => AstNode | null;
  };
  if (typeof anyNode.childForFieldName === "function") {
    for (const field of languageConfig.nameFieldCandidates) {
      const nameNode = anyNode.childForFieldName(field);
      if (nameNode && nameNode.text) return nameNode.text;
    }
  }
  return "<anonymous>";
}

/**
 * Extract 1-based start/end line numbers for a node. Tree-sitter nodes
 * expose `startPosition` and `endPosition` with zero-based rows.
 */
function extractPosition(node: AstNode): { startLine: number; endLine: number } {
  const anyNode = node as AstNode & {
    startPosition?: { row: number };
    endPosition?: { row: number };
  };
  const startRow = anyNode.startPosition?.row ?? 0;
  const endRow = anyNode.endPosition?.row ?? startRow;
  return { startLine: startRow + 1, endLine: endRow + 1 };
}

/**
 * Count physical and logical lines of code in a raw source string.
 *
 * - **Physical LOC**: number of newline-separated lines, matching how
 *   most IDEs report file length.
 * - **Logical LOC**: number of lines that contain at least one
 *   non-whitespace character.
 *
 * Comment detection is intentionally NOT done here; comment stripping
 * requires language-aware parsing and the caller can derive a comment
 * ratio from the AST node list if needed.
 *
 * @param source Raw source text.
 * @returns      An object with `physicalLoc` and `logicalLoc`.
 */
function countLines(source: string): { physicalLoc: number; logicalLoc: number } {
  if (source.length === 0) return { physicalLoc: 0, logicalLoc: 0 };
  const lines = source.split(/\r?\n/);
  let logical = 0;
  for (const line of lines) {
    if (line.trim().length > 0) logical += 1;
  }
  return { physicalLoc: lines.length, logicalLoc: logical };
}
