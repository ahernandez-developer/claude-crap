// @ts-check
/**
 * `claude-sonar uninstall` — clean up plugin state and print the
 * Claude Code unregister command.
 *
 * Like `install`, this subcommand does NOT try to edit Claude Code's
 * own settings file. It:
 *
 *   1. Prints the native `/plugin uninstall claude-sonar` command the
 *      user should run from inside Claude Code.
 *   2. Optionally removes the `.claude-sonar/` scratch directory from
 *      the current workspace when called with `--purge`. Without the
 *      flag we leave the SARIF reports in place so the user can diff
 *      them against a re-install.
 *
 * Always exits 0.
 *
 * @module scripts/uninstall
 */

import { promises as fs } from "node:fs";
import { resolve } from "node:path";

import { printBanner, paint, icons } from "./lib/cli-ui.mjs";

/**
 * @typedef {Object} CommandContext
 * @property {string}   pluginRoot
 * @property {string[]} argv
 */

/**
 * Uninstall entrypoint.
 *
 * @param {CommandContext} ctx
 * @returns {Promise<number>}
 */
export default async function uninstall(ctx) {
  printBanner("claude-sonar :: uninstall");

  const purge = ctx.argv.includes("--purge");
  const scratch = resolve(process.cwd(), ".claude-sonar");

  if (purge) {
    try {
      await fs.rm(scratch, { recursive: true, force: true });
      process.stdout.write(`  ${paint.green(icons.ok)} Removed ${scratch}\n`);
    } catch (err) {
      process.stdout.write(
        `  ${paint.yellow(icons.warn)} Could not remove ${scratch}: ${/** @type {Error} */ (err).message}\n`,
      );
    }
  } else {
    process.stdout.write(
      `  ${paint.dim(icons.info)} Leaving ${scratch} in place. Use ${paint.bold("claude-sonar uninstall --purge")} to remove SARIF reports.\n`,
    );
  }

  process.stdout.write(
    [
      "",
      paint.bold("  Next step — unregister from Claude Code:"),
      "",
      `    ${paint.cyan("/plugin uninstall claude-sonar")}`,
      "",
      paint.dim("  If you installed via `npx`, also remove the npm package:"),
      `    ${paint.cyan("npm uninstall -g claude-sonar")}`,
      "",
    ].join("\n"),
  );
  return 0;
}
