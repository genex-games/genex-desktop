/**
 * A plugin page's setup steps: plain one-line text its author writes and Genex draws itself. The
 * manifest, the marketplace index and the catalog's own check take the same rule, so markup,
 * control characters, text direction overrides and oversized lists never reach the page.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { isPluginSetup, PLUGIN_SETUP_STEP_CHARS, PLUGIN_SETUP_STEPS } from "../../src/shared/plugins.ts";
import { validateManifest } from "../../src/substrate/plugins/manifest.ts";
import { validateIndex } from "../../src/substrate/plugins/marketplace.ts";

const STEPS = ["Install it.", "Open its page and paste your API key."];

/** Shapes a setup list must never take, each with why. */
const HOSTILE: Array<[string, unknown]> = [
  ["not a list", "Install it."],
  ["an empty list", []],
  ["too many steps", Array.from({ length: PLUGIN_SETUP_STEPS + 1 }, (_, i) => `Step ${i + 1}`)],
  ["a step over the cap", ["x".repeat(PLUGIN_SETUP_STEP_CHARS + 1)]],
  ["an empty step", [""]],
  ["a blank step", ["   "]],
  ["a step that is not text", [42]],
  ["a second line", ["Install it.\nThen run this."]],
  ["a control character", ["Install\u0007 it."]],
  ["a right-to-left override", ["Install ‮ti."]],
  ["an isolate", ["Install ⁦it⁩."]],
];

describe("setup steps", () => {
  it("accepts short plain lines, up to the cap", () => {
    assert.equal(isPluginSetup(STEPS), true);
    const full = Array.from({ length: PLUGIN_SETUP_STEPS }, () => "x".repeat(PLUGIN_SETUP_STEP_CHARS));
    assert.equal(isPluginSetup(full), true);
    assert.equal(isPluginSetup(["<b>Markup is only text here</b>"]), true, "drawn as text, never as markup");
  });
  for (const [what, value] of HOSTILE)
    it(`refuses ${what}`, () => {
      assert.equal(isPluginSetup(value), false);
    });
});

describe("the manifest carries them", () => {
  const example = JSON.parse(readFileSync("src/plugins/example/plugin.json", "utf8"));
  it("keeps valid steps in the canonical manifest, and leaves the field out when absent", () => {
    assert.deepEqual(validateManifest({ ...example, setup: STEPS }).setup, STEPS);
    assert.equal("setup" in validateManifest(example), false);
  });
  for (const [what, value] of HOSTILE)
    it(`refuses a manifest whose steps are ${what}`, () => {
      assert.throws(() => validateManifest({ ...example, setup: value }), /setup/);
    });
});

describe("the marketplace index carries them", () => {
  const entry = {
    id: "acme-tool",
    name: "Tool",
    publisher: "Acme",
    description: "A tool.",
    category: "tools",
    tier: "community",
    repo: "acme/tool",
    sha: "a".repeat(40),
    version: "1.0.0",
    capabilities: [],
  };
  const index = (setup: unknown) => ({
    version: 1,
    updatedAt: "2026-10-15T00:00:00.000Z",
    plugins: [{ ...entry, setup }],
  });
  it("keeps valid steps on the entry", () => {
    assert.deepEqual(validateIndex(index(STEPS)).plugins[0]?.setup, STEPS);
  });
  for (const [what, value] of HOSTILE)
    it(`refuses an entry whose steps are ${what}`, () => {
      assert.throws(() => validateIndex(index(value)), /setup/);
    });
});
