/**
 * Unit tests for the cyclomatic complexity walker.
 *
 * These tests use a hand-built mock AST that conforms to the minimal
 * {@link AstNode} contract. That keeps the test hermetic — we do not
 * have to load any WASM grammars or spin up the real tree-sitter engine.
 *
 * @module tests/cyclomatic.test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { computeCyclomaticComplexity, type AstNode } from "../ast/cyclomatic.js";
import { LANGUAGE_TABLE } from "../ast/language-config.js";

/**
 * Build a tiny AST node. Used only by the tests to construct synthetic
 * trees without depending on tree-sitter. Both `type` and `children`
 * must match what the walker expects; `text` is mostly for operator
 * detection on `binary_expression` children.
 */
function node(type: string, text = "", children: AstNode[] = []): AstNode {
  return {
    type,
    text,
    childCount: children.length,
    child(index: number): AstNode | null {
      return children[index] ?? null;
    },
  };
}

describe("computeCyclomaticComplexity", () => {
  const ts = LANGUAGE_TABLE.typescript;
  const python = LANGUAGE_TABLE.python;

  it("returns 1 for a straight-line function", () => {
    const root = node("function_declaration", "", [
      node("return_statement", "return 1;"),
    ]);
    assert.equal(computeCyclomaticComplexity(root, ts), 1);
  });

  it("adds 1 per branching node", () => {
    // Function with one `if` and one `for` → 1 + 2 = 3
    const root = node("function_declaration", "", [
      node("if_statement"),
      node("for_statement"),
    ]);
    assert.equal(computeCyclomaticComplexity(root, ts), 3);
  });

  it("counts short-circuit operators", () => {
    // Function with a binary_expression child whose operator is "&&"
    const andOperator = node("&&", "&&");
    const binary = node("binary_expression", "a && b", [
      node("identifier", "a"),
      andOperator,
      node("identifier", "b"),
    ]);
    const root = node("function_declaration", "", [binary]);
    assert.equal(computeCyclomaticComplexity(root, ts), 2);
  });

  it("does not count nested functions against the parent", () => {
    // Outer function with one `if`, plus a nested function containing
    // another `if`. The nested function's complexity must NOT bleed
    // into the parent count (the parent should be 2, not 3).
    const nestedIf = node("if_statement");
    const nested = node("function_declaration", "", [nestedIf]);
    const parentIf = node("if_statement");
    const root = node("function_declaration", "", [parentIf, nested]);
    assert.equal(computeCyclomaticComplexity(root, ts), 2);
  });

  it("recognizes python `and` and `or`", () => {
    const andOp = node("and", "and");
    const boolean = node("boolean_operator", "x and y", [
      node("identifier", "x"),
      andOp,
      node("identifier", "y"),
    ]);
    const root = node("function_definition", "", [boolean]);
    assert.equal(computeCyclomaticComplexity(root, python), 2);
  });
});
