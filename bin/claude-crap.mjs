#!/usr/bin/env node
// @ts-check
/**
 * `claude-crap` CLI dispatcher.
 *
 * Installed as a `bin` entry in `package.json`, so both
 * `npx @sr-herz/claude-crap <cmd>` and a globally linked install
 * resolve to this file. The binary itself is named `claude-crap`
 * (independent of the scoped npm package name), so after a global
 * install users can just type `claude-crap <cmd>`. The CLI is
 * deliberately tiny — each subcommand lives in its own module under
 * `scripts/` so they can be tested in isolation and so new
 * subcommands can be added without touching this dispatcher.
 *
 * Supported subcommands:
 *
 *   install     Prepare the workspace and print the Claude Code
 *               `/plugin install` command the user needs to run.
 *   uninstall   Remove the plugin's scratch directory and print the
 *               matching Claude Code uninstall command.
 *   doctor      Run a full diagnostic — Node version, dist/ freshness,
 *               hook executability, tree-sitter grammars, dashboard
 *               port availability, CLAUDE.md presence, etc.
 *   status      Show version, resolved paths, and current registration
 *               state (does Claude Code know about this plugin?).
 *   version     Print the plugin version and exit.
 *   help        Print usage information and exit.
 *
 * Every subcommand exits with `0` on success and non-zero on failure
 * so the CLI plays well with shell pipelines.
 *
 * @module bin/claude-crap
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(HERE, "..");

const USAGE = `
claude-crap — deterministic QA plugin for Claude Code

Usage:
  claude-crap <command>

Commands:
  install       Prepare the workspace and print the Claude Code install command.
  uninstall     Remove the plugin's scratch directory and print the uninstall command.
  doctor        Diagnose the install (Node version, dist/, hooks, grammars, ports).
  status        Show version, paths, and registration state.
  bug-report    Write a diagnostic bundle for triage (auto-redacts secrets).
  version       Print the plugin version and exit.
  help          Show this message.

Examples:
  npx @sr-herz/claude-crap install
  npx @sr-herz/claude-crap doctor
  npx @sr-herz/claude-crap status
  npx @sr-herz/claude-crap bug-report --stdout
`.trim();

/**
 * Dynamically import a subcommand module. Keeping imports lazy means
 * `claude-crap version` or `claude-crap help` never pays the cost of
 * loading the filesystem walkers, port probes, or the MCP types.
 *
 * @param {string} name File name under ./scripts/ without the extension.
 * @returns {Promise<{default: (ctx: {pluginRoot: string, argv: string[]}) => Promise<number>}>}
 */
function loadCommand(name) {
  return import(resolve(PLUGIN_ROOT, "scripts", `${name}.mjs`));
}

/**
 * Read the plugin version from `package.json` synchronously. Used by
 * the `version` and `status` subcommands.
 *
 * @returns {Promise<string>} The version string.
 */
async function readVersion() {
  const pkgUrl = resolve(PLUGIN_ROOT, "package.json");
  const { readFile } = await import("node:fs/promises");
  const raw = await readFile(pkgUrl, "utf8");
  const pkg = /** @type {{version?: string}} */ (JSON.parse(raw));
  return pkg.version ?? "0.0.0";
}

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0] ?? "help";
  const rest = argv.slice(1);

  switch (command) {
    case "install": {
      const mod = await loadCommand("install");
      return mod.default({ pluginRoot: PLUGIN_ROOT, argv: rest });
    }
    case "uninstall": {
      const mod = await loadCommand("uninstall");
      return mod.default({ pluginRoot: PLUGIN_ROOT, argv: rest });
    }
    case "doctor": {
      const mod = await loadCommand("doctor");
      return mod.default({ pluginRoot: PLUGIN_ROOT, argv: rest });
    }
    case "status": {
      const mod = await loadCommand("status");
      return mod.default({ pluginRoot: PLUGIN_ROOT, argv: rest });
    }
    case "bug-report":
    case "report": {
      const mod = await loadCommand("bug-report");
      return mod.default({ pluginRoot: PLUGIN_ROOT, argv: rest });
    }
    case "version":
    case "--version":
    case "-v": {
      const version = await readVersion();
      process.stdout.write(`claude-crap ${version}\n`);
      return 0;
    }
    case "help":
    case "--help":
    case "-h":
    case undefined:
      process.stdout.write(USAGE + "\n");
      return 0;
    default:
      process.stderr.write(`claude-crap: unknown command '${command}'\n\n`);
      process.stderr.write(USAGE + "\n");
      return 1;
  }
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((err) => {
    process.stderr.write(`claude-crap: fatal error: ${err?.message ?? err}\n`);
    process.exit(1);
  });
