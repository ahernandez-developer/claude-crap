/**
 * AJV-backed minimal SARIF 2.1.0 document validator.
 *
 * F-A05-01: the `ingest_sarif` MCP tool accepts a caller-supplied
 * `sarifDocument` object and, before this module existed, only
 * checked `version === "2.1.0"`. That was enough for tool-call
 * dispatch but not for the payload itself — a SARIF with a missing
 * `runs[]`, a `results` array of wrong-type entries, or a result
 * without a `ruleId` would still be accepted by the MCP tool and
 * flow through to the store, the dashboard, and any downstream
 * consumer that uploads claude-sonar's SARIF to GitHub code-scanning
 * or an IDE viewer.
 *
 * This module uses the `ajv` dependency (already in package.json) to
 * compile a minimal JSON Schema that covers exactly the fields
 * claude-sonar reads: `version`, `runs`, `runs[].tool.driver.name`,
 * and the per-result shape. Everything else (tool metadata, rule
 * definitions, snippets, etc.) is passthrough — we do not enforce
 * the full SARIF 2.1.0 spec because claude-sonar does not consume
 * those fields.
 *
 * The compiled validator is cached so the ~5 ms AJV compile cost is
 * paid once per MCP server process, not once per ingestion.
 *
 * @module sarif/sarif-validator
 */

import { Ajv, type ValidateFunction } from "ajv";

/**
 * Minimal JSON Schema covering every field claude-sonar reads from a
 * SARIF 2.1.0 document. Passthrough fields are allowed because
 * `additionalProperties` is left at the default (`true`).
 *
 * Keep this schema in sync with `hydrateFindingFromResult` in
 * `src/sarif/sarif-store.ts` — anything the store reads MUST be
 * covered here, and nothing else should be enforced.
 */
const SARIF_MINIMAL_SCHEMA = {
  type: "object",
  properties: {
    version: { type: "string", enum: ["2.1.0"] },
    $schema: { type: "string" },
    runs: {
      type: "array",
      items: {
        type: "object",
        properties: {
          tool: {
            type: "object",
            properties: {
              driver: {
                type: "object",
                properties: {
                  name: { type: "string", minLength: 1 },
                  version: { type: "string" },
                },
                required: ["name"],
              },
            },
            required: ["driver"],
          },
          results: {
            type: "array",
            items: {
              type: "object",
              properties: {
                ruleId: { type: "string", minLength: 1 },
                level: { type: "string", enum: ["none", "note", "warning", "error"] },
                message: {
                  type: "object",
                  properties: { text: { type: "string", minLength: 1 } },
                  required: ["text"],
                },
                locations: { type: "array" },
                properties: { type: "object" },
              },
              required: ["ruleId", "message"],
            },
          },
        },
        required: ["tool", "results"],
      },
    },
  },
  required: ["version", "runs"],
} as const;

/**
 * Lazily-compiled validator instance. `null` until the first call to
 * {@link validateSarifDocument}, then reused for the lifetime of the
 * process.
 */
let cachedValidator: ValidateFunction | null = null;

/**
 * Returned by {@link validateSarifDocument} when the document fails
 * schema validation. Includes the full AJV error array for callers
 * that want to surface structured diagnostics.
 */
export class SarifValidationError extends Error {
  public readonly errors: unknown;

  constructor(message: string, errors: unknown) {
    super(message);
    this.name = "SarifValidationError";
    this.errors = errors;
  }
}

/**
 * Obtain the compiled AJV validator, compiling on first use.
 *
 * The schema above intentionally allows passthrough fields on every
 * object (AJV's default `additionalProperties: true`). We disable
 * `strict` so AJV does not warn about benign constructs like the
 * `format`/`enum` combination.
 */
function getValidator(): ValidateFunction {
  if (cachedValidator) return cachedValidator;
  const ajv = new Ajv({ allErrors: false, strict: false });
  const validator = ajv.compile(SARIF_MINIMAL_SCHEMA);
  cachedValidator = validator;
  return validator;
}

/**
 * Validate a SARIF 2.1.0 document against the minimal schema. Throws
 * {@link SarifValidationError} when the document does not match.
 *
 * @param doc Document to validate. May be any value — the validator
 *            treats non-object inputs as a schema violation.
 * @throws    {@link SarifValidationError} on any validation failure.
 */
export function validateSarifDocument(doc: unknown): void {
  const validator = getValidator();
  if (validator(doc)) return;
  const first = validator.errors?.[0];
  const path = first?.instancePath?.length ? first.instancePath : "<root>";
  const message = first?.message ?? "unknown validation error";
  throw new SarifValidationError(
    `[sarif-validator] SARIF document is not valid 2.1.0: ${path} ${message}`,
    validator.errors ?? null,
  );
}
