/**
 * Public SDK entry point for the tool backends that sit behind
 * the `claude-crap` MCP server.
 *
 * These are the same pure functions the MCP server calls into — the
 * server layer just wraps them in JSON-RPC. Downstream consumers can
 * reuse them directly from any Node.js context without running the
 * MCP server.
 *
 * Usage:
 *
 * ```ts
 * import {
 *   findTestFile,
 *   isTestFile,
 *   candidatePaths,
 * } from "@sr-herz/claude-crap/tools";
 * ```
 *
 * @module tools
 */

export { candidatePaths, findTestFile, isTestFile } from "./test-harness.js";
export type { TestFileResolution } from "./test-harness.js";
