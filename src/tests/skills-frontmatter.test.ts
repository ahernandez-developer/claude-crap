/**
 * Frontmatter contract for claude-sonar's shipped skills.
 *
 * Every directory under `skills/` at the plugin root must contain a
 * SKILL.md file with YAML frontmatter declaring at minimum `name`
 * and `description`. The `name` has to match the directory name so
 * Claude Code's slash-command namespace (`/claude-sonar:<name>`)
 * resolves cleanly. The `description` drives model-invocation
 * triggering — the skill-creator skill's guidance is emphatic that
 * undertriggering is the common failure mode, so descriptions need
 * "pushy" language like "use this skill whenever..." to bias Claude
 * toward invoking them when context matches.
 *
 * These tests pin the shape of every SKILL.md the plugin ships so
 * a future drive-by edit that removes the `description` field or
 * renames a directory without updating the frontmatter cannot slip
 * through CI silently. They also pin the minimum substantive length
 * of descriptions (>100 chars) so terse one-liners like
 * "run a command" do not count as valid skills.
 *
 * @module tests/skills-frontmatter.test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = resolve(HERE, "..", "..", "plugin", "skills");

/**
 * Minimal YAML frontmatter parser covering the subset claude-sonar
 * actually uses: top-level string scalars only, no nested objects,
 * no arrays, no quoting edge cases. The full-fat YAML parsers in
 * the ecosystem would add 100+ KB of dependencies for something we
 * can solve in 20 lines; this stays self-contained.
 *
 * @param content Raw file contents of a SKILL.md file.
 * @returns       Parsed frontmatter fields, or `null` if the file
 *                does not start with a `---` delimited block.
 */
function parseFrontmatter(
  content: string,
): { name?: string; description?: string; body: string } | null {
  const match = content.match(/^---\r?\n([\s\S]+?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return null;
  const [, yaml, body] = match as unknown as [string, string, string];
  const result: { name?: string; description?: string; body: string } = { body };
  for (const rawLine of yaml.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const kv = line.match(/^([a-zA-Z_-]+)\s*:\s*(.+)$/);
    if (!kv) continue;
    const [, key, value] = kv as unknown as [string, string, string];
    const clean = value.replace(/^['"]|['"]$/g, "");
    if (key === "name") result.name = clean;
    if (key === "description") result.description = clean;
  }
  return result;
}

/**
 * Return every immediate subdirectory of `skills/`. If the root
 * itself does not exist, returns an empty list so the test suite
 * can still run on a fresh clone before any skills have been added.
 */
async function listSkillDirs(): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(SKILLS_DIR, { withFileTypes: true });
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

describe("claude-sonar skills — frontmatter contract", () => {
  it("ships at least one user-invocable skill", async () => {
    const dirs = await listSkillDirs();
    assert.ok(
      dirs.length > 0,
      "expected at least one skill directory under skills/ — v0.1.1 introduces /claude-sonar:score, /claude-sonar:check-test, /claude-sonar:analyze, /claude-sonar:adopt",
    );
  });

  it("every skills/<name>/ directory contains a SKILL.md file", async () => {
    const dirs = await listSkillDirs();
    for (const dir of dirs) {
      const skillMd = join(SKILLS_DIR, dir, "SKILL.md");
      const content = await readFile(skillMd, "utf8").catch(() => null);
      assert.ok(content, `skills/${dir}/SKILL.md is missing`);
    }
  });

  it("every SKILL.md starts with a --- delimited YAML frontmatter block", async () => {
    const dirs = await listSkillDirs();
    for (const dir of dirs) {
      const content = await readFile(join(SKILLS_DIR, dir, "SKILL.md"), "utf8");
      const fm = parseFrontmatter(content);
      assert.ok(
        fm,
        `skills/${dir}/SKILL.md must start with '---' ... '---' YAML frontmatter`,
      );
    }
  });

  it("every frontmatter declares a non-empty name matching the directory", async () => {
    const dirs = await listSkillDirs();
    for (const dir of dirs) {
      const content = await readFile(join(SKILLS_DIR, dir, "SKILL.md"), "utf8");
      const fm = parseFrontmatter(content);
      assert.ok(fm?.name, `skills/${dir}/SKILL.md frontmatter must have a 'name' field`);
      assert.equal(
        fm.name,
        dir,
        `skills/${dir}/SKILL.md frontmatter name '${fm.name}' must match the directory basename '${dir}'`,
      );
    }
  });

  it("every frontmatter declares a substantive description (>100 chars)", async () => {
    const dirs = await listSkillDirs();
    for (const dir of dirs) {
      const content = await readFile(join(SKILLS_DIR, dir, "SKILL.md"), "utf8");
      const fm = parseFrontmatter(content);
      assert.ok(
        fm?.description,
        `skills/${dir}/SKILL.md frontmatter must have a 'description' field`,
      );
      assert.ok(
        fm.description.length > 100,
        `skills/${dir}/SKILL.md description is only ${fm.description.length} chars; Claude Code's trigger matcher needs substantive context to invoke the skill. Rewrite it with 'use this skill whenever ...' phrasing and at least one example context.`,
      );
    }
  });

  it("every description uses 'use this skill when/whenever' trigger language", async () => {
    // Rationale: the skill-creator guidance flags undertriggering as the
    // common failure mode and recommends 'pushy' descriptions that bias
    // Claude toward invoking the skill. Enforcing a minimal version of
    // that discipline at the lint level means every future skill has to
    // at least consider when it should trigger before merging.
    const dirs = await listSkillDirs();
    for (const dir of dirs) {
      const content = await readFile(join(SKILLS_DIR, dir, "SKILL.md"), "utf8");
      const fm = parseFrontmatter(content);
      assert.ok(fm?.description);
      assert.match(
        fm.description,
        /use this skill (when|whenever)/i,
        `skills/${dir}/SKILL.md description should include 'use this skill when/whenever ...' trigger language (see the skill-creator guidance on combating undertriggering)`,
      );
    }
  });

  it("every SKILL.md body is non-empty", async () => {
    const dirs = await listSkillDirs();
    for (const dir of dirs) {
      const content = await readFile(join(SKILLS_DIR, dir, "SKILL.md"), "utf8");
      const fm = parseFrontmatter(content);
      assert.ok(fm, `${dir}/SKILL.md must parse`);
      assert.ok(
        fm.body.trim().length > 0,
        `skills/${dir}/SKILL.md must have instructions after the frontmatter`,
      );
    }
  });
});
