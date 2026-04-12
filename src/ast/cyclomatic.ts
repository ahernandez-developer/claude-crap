/**
 * Deterministic cyclomatic complexity walker.
 *
 * Given a tree-sitter subtree rooted at a function node, this module walks
 * the tree and returns the McCabe cyclomatic complexity number. The
 * algorithm is the standard "1 + (branching nodes + short-circuit operators)"
 * formulation:
 *
 *   CC = 1
 *      + count of branching-statement nodes (if, while, for, case, catch, ...)
 *      + count of short-circuit operators (&&, ||, ??, `and`, `or`)
 *      + count of ternary expressions (counted as branching nodes)
 *
 * The baseline of 1 represents the straight-line path through the function.
 * Every additional branching point multiplies the set of reachable paths.
 *
 * The walker is deliberately language-agnostic: it consults the
 * {@link LanguageConfig} passed in to decide which node types to count.
 * Nested functions inside the subtree are **skipped** — each function's
 * complexity is reported independently by {@link TreeSitterEngine}.
 *
 * @module ast/cyclomatic
 */

import type { LanguageConfig } from "./language-config.js";

/**
 * Minimal structural contract of a tree-sitter node. We intentionally
 * avoid importing `web-tree-sitter` types here so this module stays
 * unit-testable with a hand-rolled mock tree.
 */
export interface AstNode {
  /** Node type name from the grammar (e.g. `"if_statement"`). */
  readonly type: string;
  /** Raw source text for operator detection. May be large — do not log. */
  readonly text: string;
  /** Zero-based child count. */
  readonly childCount: number;
  /** Retrieve a child by index. Returns `null` if out of range. */
  child(index: number): AstNode | null;
}

/**
 * Compute the cyclomatic complexity of a function subtree.
 *
 * @param root           Node rooted at the function (method, arrow, lambda, ...).
 * @param languageConfig Language classification tables for node types.
 * @returns              The McCabe cyclomatic complexity (always ≥ 1).
 */
export function computeCyclomaticComplexity(root: AstNode, languageConfig: LanguageConfig): number {
  let complexity = 1;
  walk(root, languageConfig, true, (node) => {
    if (languageConfig.branchingNodeTypes.has(node.type)) {
      complexity += 1;
      return;
    }
    // Boolean / short-circuit operators are usually represented as
    // "binary_expression" nodes with an operator token child. To avoid
    // coupling to a specific grammar's node shape, we inspect the raw
    // text of the node's direct operator child.
    if (isBooleanExpression(node, languageConfig)) {
      complexity += 1;
      return;
    }
  });
  return complexity;
}

/**
 * Depth-first walk that skips any nested function subtree so that its
 * complexity is not attributed to the enclosing function.
 *
 * @param node           Current node being visited.
 * @param languageConfig Language tables used to detect nested functions.
 * @param isRoot         `true` for the starting node (we do not skip it).
 * @param visit          Callback invoked for every non-function descendant.
 */
function walk(
  node: AstNode,
  languageConfig: LanguageConfig,
  isRoot: boolean,
  visit: (n: AstNode) => void,
): void {
  if (!isRoot && languageConfig.functionNodeTypes.has(node.type)) {
    // Nested function — stop the walk here. Its complexity is reported
    // separately when the engine iterates the top-level function list.
    return;
  }
  visit(node);
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) walk(child, languageConfig, false, visit);
  }
}

/**
 * Return `true` when `node` is a boolean / short-circuit expression that
 * should add one to the cyclomatic complexity. We inspect the node's
 * immediate children for an operator token whose text matches one of the
 * language's short-circuit operators.
 *
 * This is a heuristic — grammars differ in how they represent operators
 * — but it is stable enough for the five supported languages because:
 *
 *   - JavaScript / TypeScript / Java: binary expression with `"&&"` or `"||"` token child.
 *   - Python: `boolean_operator` node with `"and"` / `"or"` token child.
 *   - C#: binary expression with `"&&"`, `"||"`, or `"??"` token child.
 *
 * @param node           Candidate node.
 * @param languageConfig Tables with the language's boolean operator set.
 * @returns              `true` when the node is a counted boolean expression.
 */
function isBooleanExpression(node: AstNode, languageConfig: LanguageConfig): boolean {
  // Common type names across supported grammars. We check the type first
  // to avoid scanning text for every node in the tree.
  if (
    node.type !== "binary_expression" &&
    node.type !== "boolean_operator" &&
    node.type !== "logical_expression"
  ) {
    return false;
  }
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (languageConfig.booleanOperators.includes(child.text)) {
      return true;
    }
  }
  return false;
}
