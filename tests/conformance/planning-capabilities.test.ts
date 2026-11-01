import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CapabilityAudience, planningCapabilities } from "../../src/main/planning-capabilities.ts";
import type { PluginInfo, PluginManifest } from "../../src/shared/plugins.ts";
import type { ConnectionSnapshot } from "../../src/shared/connections.ts";

test("planning receives fresh public capabilities, not credentials or execution authority", async () => {
  const manifest = JSON.parse(await readFile("src/plugins/genex/plugin.json", "utf8"));
  const plugin = {
    manifest,
    enabled: true,
    removed: false,
    settings: { token: "must-not-leak" },
  } as unknown as PluginInfo;
  const connections = { sources: [{ id: "genex", kind: "plugin", account: "locked" }] } as ConnectionSnapshot;
  const first = planningCapabilities(1, [plugin], connections, [], true);
  assert.match(first, /genex__asset/);
  assert.match(first, /locked/);
  // Flipped (phase 5): no template or CDN advice rides the capability facts.
  assert.doesNotMatch(first, /\/vendor\/|CDN/);
  assert.doesNotMatch(first, /must-not-leak/);
  connections.sources[0]!.account = "unlocked";
  const next = planningCapabilities(
    2,
    [plugin],
    connections,
    [{ id: "docs", name: "Documentation", health: "ready", tools: ["docs__search"] }],
    true,
  );
  assert.match(next, /"revision":2/);
  assert.match(next, /unlocked/);
  assert.match(next, /docs__search/);
  assert.match(next, /planning is tool-free/);
  plugin.enabled = false;
  assert.doesNotMatch(planningCapabilities(3, [plugin], connections, [], false), /genex__asset/);
  // Flipped (phase 5): a game of its own is told nothing about dependencies either, only the inspection rule.
  assert.match(
    planningCapabilities(3, [], connections, [], false),
    /Do not claim to have inspected the project's files/,
  );
});

test("a file skill reaches the facts as an index entry naming the tool that reads it, never its body", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "studio-capabilities-"));
  try {
    const sentinel = "FILE-SKILL-BODY-SENTINEL";
    await writeFile(path.join(base, "card.md"), `# Card\n\n${sentinel}\n${"x".repeat(70 * 1024)}\n`);
    const manifest: PluginManifest = {
      ...JSON.parse(await readFile("src/plugins/example/plugin.json", "utf8")),
      id: "cards",
      apiVersion: 3,
    };
    manifest.skills = [
      ...manifest.skills,
      { name: "card", summary: "How to play the card game.", file: "card.md", references: ["ref.md"] },
    ];
    const plugin = { manifest, enabled: true, removed: false } as PluginInfo;
    const connections = { sources: [] } as unknown as ConnectionSnapshot;
    for (const audience of Object.values(CapabilityAudience)) {
      const facts = planningCapabilities(1, [plugin], connections, [], false, audience);
      const [entry] = JSON.parse(facts.split("\n\n")[2] ?? "{}").plugins;
      assert.deepEqual(
        entry.skills.at(-1),
        { name: "card", summary: "How to play the card game.", readWith: "cards__skill" },
        audience,
      );
      assert.equal(entry.skills[0].name, "greeting", "an inline skill keeps its text");
      assert.match(entry.skills[0].text, /example__greet/);
      assert.ok(
        entry.tools.some((t: { name: string }) => t.name === "cards__skill"),
        "the skill tool is listed with the builders' tools",
      );
      assert.doesNotMatch(facts, new RegExp(sentinel));
      assert.doesNotMatch(facts, /for this game/, "a plugin is enabled for every game, not this one");
    }
    const conversation = planningCapabilities(1, [plugin], connections, [], false, CapabilityAudience.Conversation);
    assert.match(conversation, /enabled for all games/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
