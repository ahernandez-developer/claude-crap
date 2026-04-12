/**
 * Public SDK entry point for the deterministic metrics engines.
 *
 * Everything re-exported from this barrel is part of the stable public
 * API of `@sr-herz/claude-crap/metrics`. Downstream consumers can rely
 * on the shapes here remaining semver-stable — breaking changes only
 * land in major versions.
 *
 * Usage:
 *
 * ```ts
 * import {
 *   computeCrap,
 *   computeTdr,
 *   computeProjectScore,
 *   classifyTdr,
 *   ratingIsWorseThan,
 * } from "@sr-herz/claude-crap/metrics";
 * ```
 *
 * @module metrics
 */

export { computeCrap } from "./crap.js";
export type { CrapInput, CrapResult } from "./crap.js";

export {
  classifyTdr,
  computeTdr,
  ratingIsWorseThan,
  ratingToRank,
} from "./tdr.js";
export type { TdrInput, TdrResult } from "./tdr.js";

export {
  computeProjectScore,
  renderProjectScoreMarkdown,
} from "./score.js";
export type {
  ComputeProjectScoreInput,
  DimensionScore,
  FindingsSummary,
  MaintainabilityScore,
  ProjectScore,
  ScoreLocation,
  SeverityRating,
  WorkspaceStats,
} from "./score.js";

export { estimateWorkspaceLoc, MAX_FILES_WALKED } from "./workspace-walker.js";
export type { WorkspaceWalkResult } from "./workspace-walker.js";
