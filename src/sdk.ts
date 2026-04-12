/**
 * Root public SDK for `@sr-herz/claude-sonar`.
 *
 * This is the module you get when you do
 * `import ... from "@sr-herz/claude-sonar"`. It is intentionally
 * **side-effect-free**: importing this file does NOT start the MCP
 * server, does NOT open the dashboard, does NOT touch the filesystem.
 * Only the executable entrypoint in `dist/index.js` boots the
 * server — that file is invoked by the `.mcp.json` command and the
 * CLI bin, never as a library.
 *
 * Structure:
 *
 *   - `./metrics` — CRAP, TDR, project score, workspace walker
 *   - `./sarif`   — SARIF 2.1.0 builder and on-disk store
 *   - `./ast`     — tree-sitter engine, cyclomatic complexity, language config
 *   - `./tools`   — test-harness resolver used by `require_test_harness`
 *
 * Prefer deep imports
 * (`import { computeCrap } from "@sr-herz/claude-sonar/metrics"`) over
 * pulling everything through the root — they give TypeScript more
 * precise type information and help tree-shakers drop unused modules.
 *
 * The symbols re-exported here are the ones most code paths need:
 *
 *   - `computeCrap`, `computeTdr`, `computeProjectScore`
 *   - `renderProjectScoreMarkdown`
 *   - `classifyTdr`, `ratingIsWorseThan`
 *   - `SarifStore`, `buildSarifDocument`
 *   - `TreeSitterEngine`
 *
 * @module claude-sonar
 */

// --- metrics ---------------------------------------------------------------
export {
  computeCrap,
  computeTdr,
  classifyTdr,
  ratingIsWorseThan,
  ratingToRank,
  computeProjectScore,
  renderProjectScoreMarkdown,
  estimateWorkspaceLoc,
} from "./metrics/index.js";
export type {
  CrapInput,
  CrapResult,
  TdrInput,
  TdrResult,
  ComputeProjectScoreInput,
  DimensionScore,
  FindingsSummary,
  MaintainabilityScore,
  ProjectScore,
  ScoreLocation,
  SeverityRating,
  WorkspaceStats,
  WorkspaceWalkResult,
} from "./metrics/index.js";

// --- sarif -----------------------------------------------------------------
export { SarifStore, buildSarifDocument } from "./sarif/index.js";
export type {
  IngestedFinding,
  PersistedSarif,
  SarifFinding,
  SarifLevel,
  SarifLocation,
  SarifStoreOptions,
  SarifToolInfo,
} from "./sarif/index.js";

// --- ast -------------------------------------------------------------------
export {
  TreeSitterEngine,
  computeCyclomaticComplexity,
  detectLanguageFromPath,
  LANGUAGE_TABLE,
} from "./ast/index.js";
export type {
  AnalyzeFileRequest,
  AstNode,
  FileMetrics,
  FunctionMetrics,
  LanguageConfig,
  SupportedLanguage,
  TreeSitterEngineOptions,
} from "./ast/index.js";

// --- tools -----------------------------------------------------------------
export { findTestFile, isTestFile, candidatePaths } from "./tools/index.js";
export type { TestFileResolution } from "./tools/index.js";

// --- adapters --------------------------------------------------------------
export {
  adaptScannerOutput,
  adaptSemgrep,
  adaptEslint,
  adaptBandit,
  adaptStryker,
  KNOWN_SCANNERS,
} from "./adapters/index.js";
export type { AdapterResult, KnownScanner } from "./adapters/index.js";

// --- configuration types ---------------------------------------------------
// We re-export the config type (not `loadConfig`) so consumers can type
// their own configs without importing the loader, which would read
// `process.env` eagerly.
export type { MaintainabilityRating, SonarConfig } from "./config.js";
