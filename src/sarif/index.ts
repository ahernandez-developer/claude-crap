/**
 * Public SDK entry point for the SARIF 2.1.0 builder and store.
 *
 * Usage:
 *
 * ```ts
 * import {
 *   SarifStore,
 *   buildSarifDocument,
 *   type SarifFinding,
 *   type SarifLevel,
 * } from "@sr-herz/claude-sonar/sarif";
 * ```
 *
 * @module sarif
 */

export { buildSarifDocument } from "./sarif-builder.js";
export type {
  SarifFinding,
  SarifLevel,
  SarifLocation,
  SarifToolInfo,
} from "./sarif-builder.js";

export { SarifStore } from "./sarif-store.js";
export type {
  IngestedFinding,
  PersistedSarif,
  SarifStoreOptions,
} from "./sarif-store.js";
