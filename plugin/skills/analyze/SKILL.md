---
name: analyze
description: Run tree-sitter AST analysis on a source file using claude-sonar's deterministic engine and report per-function cyclomatic complexity plus physical and logical lines of code. Use this skill whenever the user asks "what's the complexity of this file", "how complex is foo.ts", "show me cyclomatic complexity per function", "analyze this file's structure", "which functions in this file are too complex", "where should I refactor first in this module", or needs to pick candidates for refactoring based on complexity. Also use this skill proactively when a file feels "big" and you want a ranked list of hot-spot functions before proposing a refactor plan — the tree-sitter engine gives exact numbers instead of eyeball estimates. Supports TypeScript, JavaScript, Python, Java, and C#; the language is detected automatically from the file extension. Takes a single file path as the argument after the skill name.
---

# Analyze a source file with tree-sitter

Run the `analyze_file_ast` MCP tool from the claude-sonar server against a user-supplied file and report deterministic AST metrics.

## Arguments

The user supplies a file path as the argument, typed after the skill name:

```
/claude-sonar:analyze src/index.ts
/claude-sonar:analyze app/main.py
/claude-sonar:analyze lib/foo.cs
```

## Steps

1. **Parse the file path**. Take `$ARGUMENTS` as the path. Reject it with a friendly one-liner if it contains `../` — the server's workspace guard will reject path traversal attempts regardless, but failing fast in the skill is cleaner than surfacing a stack trace from the MCP layer.

2. **Detect the language from the extension**. Use this table:

   | Extension                                   | `language` argument |
   | :------------------------------------------ | :------------------ |
   | `.ts` / `.tsx` / `.mts` / `.cts`            | `typescript`        |
   | `.js` / `.jsx` / `.mjs` / `.cjs`            | `javascript`        |
   | `.py`                                       | `python`            |
   | `.java`                                     | `java`              |
   | `.cs`                                       | `csharp`            |

   If the extension does not map to one of those five, tell the user which languages are supported and do not invoke the tool. Claude-sonar's tree-sitter engine is language-scoped; there is no "auto-detect from content" mode.

3. **Invoke the MCP tool** `analyze_file_ast` with `filePath: "$ARGUMENTS"` and the detected `language`.

4. **Display file-level metrics first**: physical LOC (every newline-terminated line including blanks and comments) and logical LOC (lines with at least one non-whitespace character). The delta between the two is an informal "comment density" signal.

5. **Display a ranked function list**, sorted by cyclomatic complexity descending. For each function, show:
   - Function name (or `<anonymous>` if the tree-sitter grammar could not resolve a name)
   - Start line → end line
   - Cyclomatic complexity
   - Physical line count (`endLine - startLine + 1`)

6. **Flag refactoring candidates**. Any function whose cyclomatic complexity exceeds `15` (the plugin's default `cyclomaticMax`) is a Stop-gate warning candidate — call those out explicitly as "above the cyclomatic ceiling; refactor candidate". A function above `30` will fail the CRAP quality gate regardless of coverage and MUST be decomposed; those are the highest-priority targets.

7. **Handle errors gracefully**. If the tool returns `status: "error"`, the most likely cause is a tree-sitter grammar that failed to load (`Could not load wasm grammar for language X`). Tell the user they may need to reinstall the plugin via `/plugin install claude-sonar@herz` so the bundled WASM grammars are re-extracted into the plugin cache.

## What the user will see

A compact report along the lines of:

```
src/index.ts — 658 LOC (512 logical)

Functions ranked by cyclomatic complexity:
  1. handleRequest      lines 120–245  CC=22  (126 lines)   ⚠ above cyclomatic ceiling (15)
  2. parseBody           lines  48–102  CC=14  ( 55 lines)
  3. sendResponse        lines 300–340  CC= 9  ( 41 lines)
  4. init                lines  10–30   CC= 3  ( 21 lines)

⚠ `handleRequest` has CC=22 (ceiling is 15). Refactor candidate.
```

Exact formatting can vary — the important thing is that the function list is ranked and the refactoring candidates are called out explicitly.

## Why this skill exists

The `analyze_file_ast` MCP tool is the deterministic alternative to "Claude reads the file and estimates complexity." Manual complexity estimation is a known failure mode for LLMs — we overcount branches, we undercount nested constructs, and we are not self-consistent across runs. The tree-sitter engine gives exact, reproducible per-function metrics that the user can trust for refactoring decisions, and the numbers match what the Stop quality gate will eventually grade against, so using this tool up-front closes the loop between exploration and enforcement.

## Do not

- Do not invoke this skill for files outside the workspace. The workspace guard will reject them; use a workspace-relative path.
- Do not compute cyclomatic complexity by reading the file and counting branches yourself. The tree-sitter engine is the single source of truth. If the user disagrees with the number, the disagreement is almost always a misunderstanding of where a branch lives in the AST, not a bug in the engine.
- Do not refactor based on eyeball estimates of complexity when this tool is available. A refactor proposal that cites "handleRequest is too complex" without an exact CC number is not actionable.
- Do not invoke the skill on a minified file — the numbers will be meaningless (the whole file is one "function" to the parser). Minified artifacts belong in `.gitignore`, not in the analyzer.
