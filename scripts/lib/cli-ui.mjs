// @ts-check
/**
 * Tiny CLI UI helpers shared by every `claude-crap <cmd>` subcommand.
 *
 * Provides ANSI color wrappers (with a `NO_COLOR` fallback), a unified
 * `printStep` formatter for doctor-style checklists, and a handful of
 * icon constants so the output looks consistent across subcommands.
 *
 * Zero runtime dependencies — uses only Node built-ins so it keeps the
 * CLI startup fast and works in any environment the plugin supports.
 *
 * @module scripts/lib/cli-ui
 */

/**
 * Check whether the current terminal supports ANSI color escapes. We
 * follow the `NO_COLOR` env var (https://no-color.org/) and also
 * respect the conventional `FORCE_COLOR` override for CI environments.
 */
const useColor = (() => {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return Boolean(process.stdout.isTTY);
})();

/**
 * Wrap a string in an ANSI color escape when color is enabled. Returns
 * the plain string otherwise.
 *
 * @param {string} code Numeric ANSI color code (e.g. `"32"` for green).
 * @param {string} text Text to wrap.
 * @returns {string}
 */
function color(code, text) {
  return useColor ? `\x1b[${code}m${text}\x1b[0m` : text;
}

/**
 * Color helpers. Each function takes a string and returns a potentially
 * colored version suitable for direct `process.stdout.write()` output.
 */
export const paint = Object.freeze({
  dim: (s) => color("2", s),
  bold: (s) => color("1", s),
  green: (s) => color("32", s),
  yellow: (s) => color("33", s),
  red: (s) => color("31", s),
  cyan: (s) => color("36", s),
  magenta: (s) => color("35", s),
});

/**
 * Icons used by `printStep`. Kept ASCII-safe so the output renders
 * correctly inside Claude Code's plain-text hook transcript.
 */
export const icons = Object.freeze({
  ok: "✓",
  warn: "!",
  fail: "✗",
  info: "•",
  step: "▸",
});

/**
 * Print a heading banner to stdout. Used once per subcommand to make
 * the CLI output easy to scan.
 *
 * @param {string} title Short heading text (kept under ~40 chars).
 */
export function printBanner(title) {
  const line = "─".repeat(Math.max(1, Math.min(title.length + 4, 76)));
  process.stdout.write(`\n${paint.cyan(line)}\n`);
  process.stdout.write(`  ${paint.bold(title)}\n`);
  process.stdout.write(`${paint.cyan(line)}\n\n`);
}

/**
 * Structured result from a diagnostic check, suitable for both
 * rendering with `printStep` and aggregating into a summary exit code.
 *
 * @typedef {"ok" | "warn" | "fail" | "info"} StepStatus
 *
 * @typedef {Object} StepResult
 * @property {StepStatus} status
 * @property {string}     label
 * @property {string}     [detail]
 */

/**
 * Print a single checklist step.
 *
 * @param {StepResult} step
 */
export function printStep(step) {
  const icon =
    step.status === "ok"
      ? paint.green(icons.ok)
      : step.status === "warn"
        ? paint.yellow(icons.warn)
        : step.status === "fail"
          ? paint.red(icons.fail)
          : paint.dim(icons.info);
  process.stdout.write(`  ${icon}  ${step.label}\n`);
  if (step.detail) {
    for (const line of step.detail.split("\n")) {
      process.stdout.write(`       ${paint.dim(line)}\n`);
    }
  }
}

/**
 * Print a key/value pair right-aligned at a fixed label width. Used
 * by `status` to render the "resolved paths" block.
 *
 * @param {string} label
 * @param {string} value
 * @param {number} [width]
 */
export function printKv(label, value, width = 20) {
  const padded = label.padEnd(width, " ");
  process.stdout.write(`  ${paint.dim(padded)} ${value}\n`);
}
