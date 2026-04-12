/**
 * Bounded workspace walker.
 *
 * Counts physical lines of code across a workspace, skipping directories
 * that should not contribute to the Technical Debt Ratio (dependency
 * caches, build artifacts, VCS metadata, etc.) and capping the file
 * count to keep the walk well under the Stop hook's 120-second budget
 * even on pathological repositories.
 *
 * This is the TypeScript twin of `hooks/lib/quality-gate.mjs#estimateWorkspaceLoc`.
 * The two are independent so neither side has to import files from outside
 * its own project tree.
 *
 * @module metrics/workspace-walker
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";

/**
 * Result returned by {@link estimateWorkspaceLoc}.
 */
export interface WorkspaceWalkResult {
  /** Total physical lines of code across every file the walker read. */
  readonly physicalLoc: number;
  /** Number of code files the walker visited. */
  readonly fileCount: number;
  /** `true` when the walker hit {@link MAX_FILES_WALKED} and stopped early. */
  readonly truncated: boolean;
}

/**
 * Directories that should never contribute to the LOC count. Dependency
 * caches, build artifacts, VCS metadata, claude-sonar's own state.
 */
const SKIP_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "target",
  ".venv",
  "venv",
  "__pycache__",
  ".cache",
  ".next",
  ".nuxt",
  ".claude-sonar",
  ".codesight",
]);

/**
 * Extensions the walker treats as "code". Anything else is ignored,
 * including markdown, JSON, YAML, lockfiles, and binaries.
 */
const CODE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".java",
  ".cs",
  ".go",
  ".rs",
  ".rb",
  ".php",
  ".swift",
  ".kt",
  ".scala",
  ".dart",
  ".vue",
]);

/**
 * Hard cap on the number of files the walker will read. Protects against
 * pathological repositories where the walk would otherwise dominate the
 * Stop hook's budget. When hit, the walker returns the partial count
 * with `truncated: true` and the caller may decide how to react.
 */
export const MAX_FILES_WALKED = 20_000;

/**
 * Walk a workspace and return its physical LOC + file count. Never
 * follows symbolic links. Skips hidden directories except `.claude-plugin`
 * (which is tiny and contains the manifest).
 *
 * @param workspaceRoot Absolute path to the workspace root.
 * @returns             A {@link WorkspaceWalkResult} snapshot.
 */
export async function estimateWorkspaceLoc(workspaceRoot: string): Promise<WorkspaceWalkResult> {
  let physicalLoc = 0;
  let fileCount = 0;
  let truncated = false;

  async function walk(dir: string): Promise<void> {
    if (truncated) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (truncated) return;
      // Skip hidden files except the plugin manifest dir.
      if (entry.name.startsWith(".") && entry.name !== ".claude-plugin") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const lower = entry.name.toLowerCase();
      const dot = lower.lastIndexOf(".");
      if (dot < 0) continue;
      const ext = lower.substring(dot);
      if (!CODE_EXTENSIONS.has(ext)) continue;
      fileCount += 1;
      if (fileCount > MAX_FILES_WALKED) {
        truncated = true;
        return;
      }
      try {
        const content = await fs.readFile(full, "utf8");
        if (content.length > 0) {
          // Subtract 1 for trailing newline, matching what most editors
          // report as the file's line count.
          const lines = content.split(/\r?\n/).length;
          physicalLoc += content.endsWith("\n") ? lines - 1 : lines;
        }
      } catch {
        // Unreadable file (permissions, binary). Skip silently.
      }
    }
  }

  await walk(workspaceRoot);
  return { physicalLoc, fileCount, truncated };
}
