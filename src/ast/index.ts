/**
 * Public SDK entry point for the tree-sitter based AST engine and the
 * cyclomatic complexity walker.
 *
 * Usage:
 *
 * ```ts
 * import {
 *   TreeSitterEngine,
 *   computeCyclomaticComplexity,
 *   detectLanguageFromPath,
 *   type FileMetrics,
 *   type FunctionMetrics,
 *   type SupportedLanguage,
 * } from "claude-crap/ast";
 * ```
 *
 * @module ast
 */

export { TreeSitterEngine } from "./tree-sitter-engine.js";
export type {
  AnalyzeFileRequest,
  FileMetrics,
  FunctionMetrics,
  TreeSitterEngineOptions,
} from "./tree-sitter-engine.js";

export { computeCyclomaticComplexity } from "./cyclomatic.js";
export type { AstNode } from "./cyclomatic.js";

export { LANGUAGE_TABLE, detectLanguageFromPath } from "./language-config.js";
export type { LanguageConfig, SupportedLanguage } from "./language-config.js";
