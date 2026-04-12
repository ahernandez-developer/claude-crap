---
name: check-test
description: Check whether a production source file has an accompanying characterization test using claude-crap's deterministic test-harness resolver. Use this skill whenever the user asks "is this file tested", "does foo.ts have a test", "where's the test for bar.py", "check test coverage for this file", "do I have a test harness for src/baz.java", or is about to modify a source file and wants to know if the CLAUDE.md Golden Rule test prerequisite is already satisfied. Use it proactively at the start of any work on a .ts / .tsx / .js / .jsx / .mjs / .cjs / .py / .java / .cs file to verify a characterization test exists — this is required by CLAUDE.md and claude-crap's PostToolUse hook will flag the violation later if you skip the check. The skill takes a single file-path argument after the skill name.
---

# Check the test harness for a file

Run the `require_test_harness` MCP tool from the claude-crap server against a user-supplied file path and report whether a matching test exists.

## Arguments

The user supplies a file path as the argument, typed after the skill name:

```
/claude-crap:check-test src/foo/bar.ts
/claude-crap:check-test pkg/mod.py
/claude-crap:check-test app/src/main/java/com/example/Service.java
```

Pass `$ARGUMENTS` verbatim as the `filePath` argument to the MCP tool. Do not normalize, strip quotes, or resolve the path yourself — the server's workspace guard handles that.

## Steps

1. Invoke the MCP tool `require_test_harness` with `filePath: "$ARGUMENTS"`.
2. If the tool returns `hasTest: true`:
   - Tell the user the test file path from the `testFile` field, formatted as a clickable relative path.
   - If `isTestFile: true`, note that the user's input was itself already a test file — the resolver short-circuited. This usually means the user meant to ask about a different file; suggest they re-run the skill with the production file path.
3. If the tool returns `hasTest: false`:
   - Tell the user no matching test was found.
   - Remind them that CLAUDE.md's Golden Rule forbids writing functional code in this file until a characterization test exists — that's the plugin's core contract.
   - List the first 3 paths from the `candidates` array as suggested locations for the new test. These are ordered by the resolver's convention priority: sibling `<name>.test.<ext>` first, then `__tests__/<name>.test.<ext>`, then mirror-tree layouts under `tests/`, `test/`, and `__tests__/` at the workspace root, then the nearest-ancestor flat `tests/` directory, then Python `test_<name>.py` variants. Suggest the highest-priority candidate that matches the project's existing conventions — if you can see other test files in the repo, pick the layout that matches them.
4. If the tool returns an error (`status: "error"`):
   - The most common cause is a path that escapes the workspace root. Tell the user to use a workspace-relative path (e.g. `src/foo.ts`, not `../other-repo/foo.ts`).
   - The second-most-common cause is a typo in the file path. Ask them to double-check the path exists.

## What the user will see

A one-line verdict ("Test found: `src/foo.test.ts`" or "No test found") followed by guidance on what to do next. For the "no test" case, the list of candidate paths is the most valuable thing — it tells the user exactly where the plugin's resolver expects the test to live, without them having to read the resolver source.

## Why this skill exists

The Golden Rule in CLAUDE.md forbids writing functional code before a characterization test exists. The `require_test_harness` tool is the deterministic check for that prerequisite, and it is wired into the PostToolUse hook to catch violations after the fact. But a pre-flight check before starting work on a file is cheaper than fighting the PostToolUse warning later — the user can decide up front whether to write the test first or pick a different file.

The resolver understands seven conventions (sibling, `__tests__`, mirror tree, nearest-ancestor flat `tests/`, Python `test_` prefix, and two more) so it works across the five languages the plugin supports without requiring the user to configure anything.

## Do not

- Do not guess at test file locations. The resolver enumerates every convention claude-crap supports — if it returns `hasTest: false`, a matching test genuinely does not exist yet.
- Do not suggest the user rename an existing spec file to match the convention. Instead, create a new test file at the highest-priority candidate path so the existing test remains in place if other tooling depends on its name.
- Do not invoke the skill with an absolute path that points outside the workspace. The workspace guard will reject it, and the user will be confused about why.
