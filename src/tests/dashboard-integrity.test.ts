/**
 * Supply-chain integrity tests for the local dashboard SPA.
 *
 * F-A03-01: the dashboard used to load Vue 3 from `unpkg.com` with NO
 * Subresource Integrity attribute, while the surrounding HTML comment
 * lied about it being "pinned". The fix bundles Vue under
 * `src/dashboard/public/vendor/vue.global.prod.js` and rewrites the
 * HTML to reference that local path. These tests pin both the
 * characterization invariants (exactly one Vue runtime is loaded,
 * dashboard HTML still contains the Vue entry point it expects) and
 * the attack invariants (no external CDN reference anywhere in the
 * file, no lingering "integrity hash is pinned" claim).
 *
 * @module tests/dashboard-integrity.test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(HERE, "..", "dashboard", "public");
const INDEX_HTML = resolve(PUBLIC_DIR, "index.html");
const VENDOR_VUE = resolve(PUBLIC_DIR, "vendor", "vue.global.prod.js");

describe("dashboard HTML — characterization (still a Vue 3 SPA)", () => {
  it("index.html exists and is non-trivial", async () => {
    const stat = await fs.stat(INDEX_HTML);
    assert.ok(stat.isFile());
    assert.ok(stat.size > 1000, "index.html should not be empty");
  });

  it("still declares exactly one Vue runtime <script> tag", async () => {
    const html = await fs.readFile(INDEX_HTML, "utf8");
    const matches = html.match(/<script[^>]*vue\.global\.prod\.js[^>]*>/g) ?? [];
    assert.equal(matches.length, 1, "exactly one Vue runtime script tag must be present");
  });

  it("still mounts the Vue app with createApp + #app (characterization)", async () => {
    const html = await fs.readFile(INDEX_HTML, "utf8");
    assert.match(html, /createApp\(\{/);
    assert.match(html, /mount\("#app"\)/);
  });
});

describe("dashboard HTML — F-A03-01 attack invariants", () => {
  it("does NOT fetch Vue from any external http(s) CDN", async () => {
    const html = await fs.readFile(INDEX_HTML, "utf8");
    // Any <script src="http(s)://..."> that points at a Vue file is a CDN load.
    const external = html.match(
      /<script[^>]*src=["']https?:\/\/[^"']*vue[^"']*["'][^>]*>/gi,
    );
    assert.equal(
      external,
      null,
      `the dashboard must not fetch Vue from a CDN (found: ${JSON.stringify(external)})`,
    );
  });

  it("does NOT contain any <script> element sourced from unpkg.com", async () => {
    const html = await fs.readFile(INDEX_HTML, "utf8");
    // Only flag actual <script src="...unpkg.com..."> loads; documentation
    // strings inside HTML comments (e.g. a pointer to where to refresh the
    // vendored Vue file from) are explicitly allowed.
    const externalScript = html.match(
      /<script[^>]*src=["'][^"']*unpkg\.com[^"']*["'][^>]*>/gi,
    );
    assert.equal(
      externalScript,
      null,
      `no <script> element may load from unpkg.com (found: ${JSON.stringify(externalScript)})`,
    );
  });

  it("does NOT claim the integrity hash is pinned (old lying comment gone)", async () => {
    const html = await fs.readFile(INDEX_HTML, "utf8");
    // The pre-fix comment said: "The script integrity hash is pinned so
    // an upstream CDN cannot silently swap the file." — that claim was
    // false because the <script> tag had no `integrity=` attribute.
    assert.equal(
      html.includes("integrity hash is pinned"),
      false,
      "the old CDN integrity claim must not survive the bundle-locally fix",
    );
  });
});

describe("dashboard HTML — F-A03-01 vendored Vue runtime", () => {
  it("bundles vue.global.prod.js under the vendor directory", async () => {
    const stat = await fs.stat(VENDOR_VUE);
    assert.ok(stat.isFile(), "vue.global.prod.js must exist under src/dashboard/public/vendor/");
    // The production Vue 3 runtime is ~50-170 KB depending on version;
    // a sanity lower bound catches an accidentally-empty or truncated
    // vendor file.
    assert.ok(
      stat.size > 50_000,
      `expected Vue runtime > 50KB, got ${stat.size} bytes`,
    );
  });

  it("the vendored Vue file actually exports a Vue runtime", async () => {
    const content = await fs.readFile(VENDOR_VUE, "utf8");
    // The production global build exposes `Vue` on the window object and
    // contains its own copyright banner; both are stable markers across
    // the 3.x minor versions we care about.
    assert.match(
      content,
      /Vue/,
      "the vendored file does not look like a Vue runtime",
    );
    assert.match(
      content,
      /createApp/,
      "the vendored Vue runtime must expose createApp",
    );
  });

  it("index.html references the local vendor path", async () => {
    const html = await fs.readFile(INDEX_HTML, "utf8");
    assert.match(
      html,
      /src=["'](\.\/)?vendor\/vue\.global\.prod\.js["']/,
      "index.html must reference vendor/vue.global.prod.js locally",
    );
  });
});
