/**
 * On-disk SARIF 2.1.0 store with finding deduplication.
 *
 * The Stop quality gate and the `ingest_sarif` MCP tool both need a
 * single, consolidated view of every finding produced across the current
 * session. This module provides:
 *
 *   - `loadLatest()` — read the consolidated SARIF document from disk,
 *                       or return an empty seed when no report exists yet.
 *   - `ingestRun()`  — merge a new SARIF run from an external scanner
 *                       (Semgrep, ESLint, Bandit, Stryker, ...) into the
 *                       in-memory store, deduplicating by
 *                       `(ruleId, uri, startLine, startColumn)`.
 *   - `persist()`    — atomically write the consolidated document back
 *                       to disk so other processes (the dashboard) can
 *                       read it.
 *
 * The store is intentionally simple: it does NOT attempt to preserve
 * per-tool run separation inside the persisted file. Instead, every
 * ingested run is flattened into a single `runs[0]` entry whose `tool.driver`
 * is claude-crap itself, and the original scanner name is recorded on
 * each finding via the `properties.sourceTool` field. This keeps the
 * consolidated document easy to diff between sessions.
 *
 * @module sarif/sarif-store
 */

import { promises as fs } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { buildSarifDocument, type SarifFinding, type SarifLevel } from "./sarif-builder.js";

/**
 * The shape of a persisted SARIF 2.1.0 document, narrowed to the fields
 * we actually read and write. The full spec has many more optional
 * fields; we ignore them on read and do not emit them on write.
 */
export interface PersistedSarif {
  readonly $schema?: string;
  readonly version: "2.1.0";
  readonly runs: ReadonlyArray<SarifRun>;
}

interface SarifRun {
  readonly tool: {
    readonly driver: {
      readonly name: string;
      readonly version: string;
      readonly informationUri?: string;
      readonly rules?: ReadonlyArray<unknown>;
    };
  };
  readonly results: ReadonlyArray<SarifResult>;
}

interface SarifResult {
  readonly ruleId: string;
  readonly level?: SarifLevel;
  readonly message: { readonly text: string };
  readonly locations?: ReadonlyArray<SarifResultLocation>;
  readonly properties?: Record<string, unknown>;
}

interface SarifResultLocation {
  readonly physicalLocation?: {
    readonly artifactLocation?: { readonly uri?: string };
    readonly region?: {
      readonly startLine?: number;
      readonly startColumn?: number;
      readonly endLine?: number;
      readonly endColumn?: number;
    };
  };
}

/**
 * Options accepted by the {@link SarifStore} constructor.
 */
export interface SarifStoreOptions {
  /** Workspace root. Used to resolve relative `outputDir`. */
  readonly workspaceRoot: string;
  /** Directory (absolute or workspace-relative) where reports are written. */
  readonly outputDir: string;
  /** Filename for the consolidated SARIF document. Defaults to `latest.sarif`. */
  readonly fileName?: string;
}

/**
 * A finding together with its deduplication key. Used internally and
 * returned by {@link SarifStore.ingestRun} so callers can see which
 * findings were accepted.
 */
export interface IngestedFinding extends SarifFinding {
  /** Stable deduplication key, shape: `ruleId|uri|line|col`. */
  readonly dedupKey: string;
  /** Name of the scanner that produced the finding (propagated from `sourceTool`). */
  readonly sourceTool: string;
}

/**
 * On-disk SARIF store.
 */
export class SarifStore {
  private readonly filePath: string;
  /** In-memory index of findings keyed by their dedup string. */
  private readonly findings = new Map<string, IngestedFinding>();
  /** Tool invocations we have already ingested, for telemetry. */
  private toolInvocations = 0;

  constructor(options: SarifStoreOptions) {
    const dir = isAbsolute(options.outputDir)
      ? options.outputDir
      : resolve(options.workspaceRoot, options.outputDir);
    this.filePath = join(dir, options.fileName ?? "latest.sarif");
  }

  /**
   * Absolute path to the consolidated SARIF file on disk.
   */
  get consolidatedReportPath(): string {
    return this.filePath;
  }

  /**
   * Load the consolidated document from disk into memory. If the file is
   * missing, the store is initialized empty. Top-level parsing errors
   * still throw (a file that is not valid JSON, or that declares a
   * different SARIF version, is a real safety signal). However, once
   * the document is parsed, malformed individual runs and results are
   * tolerated: F-A08-01 showed that a single bad entry in `latest.sarif`
   * could crash the MCP server on boot and persistently DoS the
   * developer. Each run / result is wrapped in its own try/catch so a
   * single bad entry logs to stderr and is dropped, but the rest of
   * the file still loads.
   *
   * @throws When the file exists but is not valid SARIF 2.1.0 JSON.
   */
  async loadLatest(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as PersistedSarif;
      if (parsed.version !== "2.1.0") {
        throw new Error(`Expected SARIF 2.1.0, got ${parsed.version}`);
      }
      this.findings.clear();
      // Defensive against tampered / mis-generated files: `runs` must
      // be an array. Anything else is dropped with a stderr warning.
      if (!Array.isArray(parsed.runs)) {
        process.stderr.write(
          `[sarif-store] ${this.filePath}: 'runs' is not an array, dropping entire document\n`,
        );
        return;
      }
      for (const run of parsed.runs) {
        try {
          if (!run || typeof run !== "object" || !Array.isArray(run.results)) {
            process.stderr.write(
              `[sarif-store] ${this.filePath}: skipping run with non-iterable 'results'\n`,
            );
            continue;
          }
          for (const result of run.results) {
            try {
              const finding = hydrateFindingFromResult(result);
              if (finding) this.findings.set(finding.dedupKey, finding);
            } catch (entryErr) {
              process.stderr.write(
                `[sarif-store] ${this.filePath}: dropping malformed result: ${(entryErr as Error).message}\n`,
              );
            }
          }
        } catch (runErr) {
          process.stderr.write(
            `[sarif-store] ${this.filePath}: dropping malformed run: ${(runErr as Error).message}\n`,
          );
        }
      }
    } catch (err) {
      const error = err as NodeJS.ErrnoException;
      if (error.code === "ENOENT") {
        // No report on disk yet — normal for a fresh workspace.
        this.findings.clear();
        return;
      }
      throw new Error(
        `[sarif-store] Failed to load consolidated report at ${this.filePath}: ${error.message}`,
        { cause: err },
      );
    }
  }

  /**
   * Merge a raw SARIF document (from any external scanner) into the
   * store, deduplicating by `(ruleId, uri, startLine, startColumn)`. The
   * last writer wins for the message and level fields — later ingestions
   * can refine earlier ones.
   *
   * @param sarifDocument  The raw SARIF document as received from the tool.
   * @param sourceTool     Stable identifier of the producing scanner.
   * @returns              Stats describing what was accepted.
   */
  ingestRun(
    sarifDocument: PersistedSarif,
    sourceTool: string,
  ): { accepted: number; duplicates: number; total: number } {
    if (sarifDocument.version !== "2.1.0") {
      throw new Error(
        `[sarif-store] ingestRun received version ${sarifDocument.version}, expected 2.1.0`,
      );
    }

    this.toolInvocations += 1;
    let accepted = 0;
    let duplicates = 0;
    let total = 0;

    for (const run of sarifDocument.runs) {
      for (const result of run.results) {
        total += 1;
        const finding = hydrateFindingFromResult(result, sourceTool);
        if (!finding) continue;
        if (this.findings.has(finding.dedupKey)) {
          duplicates += 1;
          // Overwrite with the latest metadata so the consolidated view
          // reflects the most recent scanner output for this location.
          this.findings.set(finding.dedupKey, finding);
          continue;
        }
        this.findings.set(finding.dedupKey, finding);
        accepted += 1;
      }
    }

    return { accepted, duplicates, total };
  }

  /**
   * Snapshot all currently tracked findings as a plain array. Mostly
   * useful for tests and for the dashboard API.
   */
  list(): ReadonlyArray<IngestedFinding> {
    return Array.from(this.findings.values());
  }

  /**
   * Atomically write the consolidated document back to disk. Uses a
   * temporary file and `rename` so concurrent readers never observe
   * a half-written document.
   */
  async persist(): Promise<void> {
    const doc = this.toSarifDocument();
    await fs.mkdir(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(doc, null, 2), "utf8");
    await fs.rename(tmp, this.filePath);
  }

  /**
   * Build the current consolidated SARIF document from the in-memory
   * findings without touching disk.
   */
  toSarifDocument() {
    // Strip the store-only `dedupKey` and `sourceTool` fields before
    // serializing, but keep `sourceTool` in the per-finding `properties`
    // bag so consumers can still trace origin.
    const findings: SarifFinding[] = Array.from(this.findings.values()).map((f) => ({
      ruleId: f.ruleId,
      level: f.level,
      message: f.message,
      location: f.location,
      properties: {
        ...(f.properties ?? {}),
        sourceTool: f.sourceTool,
      },
    }));

    return buildSarifDocument(
      {
        name: "claude-crap",
        version: "0.1.0",
        informationUri: "https://github.com/local/claude-crap",
      },
      findings,
    );
  }

  /**
   * Number of unique findings currently tracked.
   */
  size(): number {
    return this.findings.size;
  }

  /**
   * Number of times `ingestRun` has been called on this instance.
   */
  get invocationsCount(): number {
    return this.toolInvocations;
  }
}

/**
 * Convert a raw SARIF `result` object into an {@link IngestedFinding}.
 * Returns `null` when the result is malformed (missing ruleId, message,
 * or physical location), since a finding without coordinates cannot be
 * deduplicated and is therefore useless.
 *
 * @param result     Raw SARIF `result` object from the scanner's document.
 * @param sourceTool Optional scanner identifier. If omitted, we read it
 *                   from `result.properties.sourceTool` (used when
 *                   reloading a persisted report).
 * @returns          The hydrated finding, or `null` when invalid.
 */
function hydrateFindingFromResult(
  result: SarifResult,
  sourceTool?: string,
): IngestedFinding | null {
  if (!result.ruleId || !result.message?.text) return null;
  const loc = result.locations?.[0]?.physicalLocation;
  const uri = loc?.artifactLocation?.uri;
  const region = loc?.region;
  if (!uri || region?.startLine === undefined || region.startColumn === undefined) return null;

  const resolvedSourceTool =
    sourceTool ??
    (typeof result.properties?.sourceTool === "string"
      ? (result.properties.sourceTool as string)
      : "unknown");

  const level: SarifLevel = result.level ?? "warning";
  const dedupKey = `${result.ruleId}|${uri}|${region.startLine}|${region.startColumn}`;

  return {
    ruleId: result.ruleId,
    level,
    message: result.message.text,
    location: {
      uri,
      startLine: region.startLine,
      startColumn: region.startColumn,
      ...(region.endLine !== undefined ? { endLine: region.endLine } : {}),
      ...(region.endColumn !== undefined ? { endColumn: region.endColumn } : {}),
    },
    ...(result.properties ? { properties: result.properties } : {}),
    dedupKey,
    sourceTool: resolvedSourceTool,
  };
}
