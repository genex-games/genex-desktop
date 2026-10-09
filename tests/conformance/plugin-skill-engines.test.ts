/**
 * A plugin skill may name the engines it is for (`engines`, API 3): a web-only skill — loading a
 * model with three.js's GLTFLoader, Genex's three.js multiplayer and embed sign-in — never reaches
 * the brief of a game that builds in Unreal. The rule is typed (GameEngine values), checked where a
 * manifest is parsed, and applied where a session's plugin guidance is put together: the registry's
 * `snapshot(engine)` and the capability facts a session without plugin tools reads. `engines` is the
 * older spelling of `facts` (plugin-fact-scope.test.ts). A web game's guidance is byte for byte what
 * it was before skills could name an engine, but the Unreal editor's skill, which reaches an
 * Unreal project only.
 */
import assert from "node:assert/strict";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { GameEngine } from "../../src/shared/game-engine.ts";
import type { PluginInfo, PluginManifest } from "../../src/shared/plugins.ts";
import { validateManifest } from "../../src/substrate/plugins/manifest.ts";
import { PluginRegistry } from "../../src/substrate/plugins/registry.ts";
import { CapabilityAudience, planningCapabilities } from "../../src/main/planning-capabilities.ts";
import { offersUnrealGame } from "../../src/harness-seed/loop/unreal-prompts.ts";
import { copyOfExample, EXAMPLE_PLUGIN, PLUGIN_SDK_BACKEND } from "../helpers/plugins.ts";
import { makeResources } from "../helpers/resources.ts";
import { tmpDir } from "../helpers/tmp.ts";

// biome-ignore lint/suspicious/noExplicitAny: a hostile manifest is any shape a writer may send.
type RawManifest = any;

const exampleManifest: RawManifest = JSON.parse(await readFile(path.join(EXAMPLE_PLUGIN, "plugin.json"), "utf8"));

/** One skill for every engine, one per engine, and one for both, in that order. */
const SKILLS = [
  { name: "any", text: "Works in every engine." },
  { name: "page", text: "Load the model with GLTFLoader.", engines: [GameEngine.Web] },
  { name: "editor", text: "Place the model in the open level.", engines: [GameEngine.Unreal] },
  { name: "both", text: "Either engine.", engines: [GameEngine.Web, GameEngine.Unreal] },
];

/** The example manifest on API 3 with `skills`. */
const withSkills = (skills: unknown[], apiVersion = 3): RawManifest => ({
  ...structuredClone(exampleManifest),
  apiVersion,
  skills,
});

test("a skill may name the engines it is for, as GameEngine values, on API 3", () => {
  for (const engines of [[GameEngine.Web], [GameEngine.Unreal], [GameEngine.Web, GameEngine.Unreal]]) {
    const inline = validateManifest(withSkills([{ name: "s", text: "t", engines }]));
    assert.deepEqual(inline.skills, [{ name: "s", text: "t", engines }]);
    const file = validateManifest(withSkills([{ name: "f", summary: "s", file: "skills/f.md", engines }]));
    assert.deepEqual(file.skills, [{ name: "f", summary: "s", file: "skills/f.md", engines }]);
  }
  const unnamed = validateManifest(withSkills([{ name: "s", text: "t" }]));
  assert.deepEqual(unnamed.skills, [{ name: "s", text: "t" }], "no engines: every engine, and no field invented");
});

test("a manifest whose skill names engines any other way is refused", () => {
  const hostile: unknown[] = [
    [],
    ["three"],
    ["Web"],
    ["unity"],
    [GameEngine.Web, GameEngine.Web],
    [1],
    [null],
    "web",
    null,
    { web: true },
    [GameEngine.Web, GameEngine.Unreal, GameEngine.Web],
  ];
  for (const engines of hostile)
    assert.throws(
      () => validateManifest(withSkills([{ name: "s", text: "t", engines }])),
      /engines/,
      JSON.stringify(engines),
    );
});

test("an API 2 skill keeps its old leniency: an engines key is ignored, never refused", () => {
  const m = validateManifest(withSkills([{ name: "s", text: "t", engines: ["three"] }], 2));
  assert.deepEqual(m.skills, [{ name: "s", text: "t" }]);
});

/** A registry whose only plugin is the example on API 3 with `skills`, a bundled seed and so enabled. */
async function registryWith(skills: unknown[]) {
  const root = await tmpDir("studio-skill-engines-");
  const seeds = path.join(root, "seeds");
  await mkdir(seeds);
  await copyOfExample(seeds, "example", (m) => {
    m.apiVersion = 3;
    m.skills = skills;
  });
  const registry = new PluginRegistry(path.join(root, "installed"), seeds, PLUGIN_SDK_BACKEND, async () => null);
  await registry.init();
  return registry;
}

test("a session's plugin guidance carries only the skills for its game's engine; its unscoped tools reach both", async () => {
  const registry = await registryWith(SKILLS);
  try {
    const web = registry.snapshot(GameEngine.Web);
    const unreal = registry.snapshot(GameEngine.Unreal);
    assert.deepEqual(web.applied.skills, ["example/any", "example/page", "example/both"]);
    assert.deepEqual(unreal.applied.skills, ["example/any", "example/editor", "example/both"]);
    assert.match(web.guidance, /\[example\/page\]/);
    assert.doesNotMatch(unreal.guidance, /\[example\/page\]/);
    assert.match(unreal.guidance, /\[example\/editor\]/);
    assert.doesNotMatch(web.guidance, /\[example\/editor\]/);
    assert.deepEqual(unreal.tools, web.tools, "a tool that names no facts reaches every game");
    assert.deepEqual(registry.snapshot(), web, "a session that names no game reads the web game's guidance");
    assert.equal(registry.guidance(), web.guidance);
  } finally {
    registry.cancel();
  }
});

test("the capability facts a session without plugin tools reads carry only the skills for its game's engine", async () => {
  const manifest = validateManifest(withSkills(SKILLS));
  const plugins = [{ manifest, enabled: true, removed: false } as PluginInfo];
  const skillsIn = (engine?: GameEngine) => {
    const text = planningCapabilities(
      1,
      plugins,
      { sources: [] } as never,
      [],
      true,
      CapabilityAudience.Planning,
      engine,
    );
    const facts = JSON.parse(text.split("\n\n")[2] ?? "{}") as { plugins: Array<{ skills: Array<{ name: string }> }> };
    return facts.plugins[0]?.skills.map((s) => s.name);
  };
  assert.deepEqual(skillsIn(GameEngine.Unreal), ["any", "editor", "both"]);
  assert.deepEqual(skillsIn(GameEngine.Web), ["any", "page", "both"]);
  assert.deepEqual(skillsIn(), skillsIn(GameEngine.Web));
});

/** The bundled plugins whose skills a game's brief can carry, all turned on. */
const BUNDLED = ["blender", "genex", "unreal"];
/** The web-only skills of the bundled plugins: three.js loading, multiplayer, embed sign-in, Genex's web publishing and play-time lanes. */
const WEB_ONLY = [
  "blender/local-modeling",
  "genex/genex-threejs-multiplayer",
  "genex/genex-threejs-embed-auth",
  "genex/publishing",
  "genex/genex-tool-publish",
  "genex/genex-llm-in-games",
  "genex/genex-tool-llm",
  "genex/genex-monetization",
];

async function bundledRegistry(seeds: string) {
  const root = await tmpDir("studio-skill-engines-bundled-");
  const registry = new PluginRegistry(
    path.join(root, "installed"),
    seeds,
    path.join(path.dirname(seeds), "plugin-sdk", "backend.mjs"),
    async () => null,
  );
  await registry.init();
  for (const id of BUNDLED) await registry.setEnabled(id, true);
  return registry;
}

/** The Unreal plugin's tools for a game that holds an Unreal project only. */
const UNREAL_EDITOR_TOOLS = ["unreal__blueprint-guide", "unreal__find-nodes", "unreal__check-part"];
const UNREAL_SKILL = "unreal/unreal-editor";

/** A manifest as it was before skills could name engines or facts: every scope field taken out. */
function unscoped(manifest: PluginManifest): void {
  for (const skill of manifest.skills) {
    delete (skill as { engines?: unknown }).engines;
    delete (skill as { facts?: unknown }).facts;
    delete (skill as { tools?: unknown }).tools;
  }
  for (const tool of manifest.tools) {
    delete tool.facts;
    delete tool.makes;
    // A readiness answers for a tool that makes a kind, so it goes with `makes`.
    delete tool.ready;
  }
  for (const server of manifest.mcpServers ?? []) delete server.facts;
}

test("the bundled plugins' web guidance is what it was before skills named engines, but the Unreal editor's skill and tools; an Unreal game's drops the web-only skills", async () => {
  const resources = await makeResources({ tsc: false });
  // The same packages as they were before `engines` and `facts` existed: every scope field taken out.
  const before = path.join(await tmpDir("studio-skill-engines-before-"), "resources");
  for (const folder of ["plugins", "plugin-sdk"])
    await cp(path.join(resources, folder), path.join(before, folder), { recursive: true });
  for (const id of BUNDLED) {
    const file = path.join(before, "plugins", id, "plugin.json");
    const manifest = JSON.parse(await readFile(file, "utf8")) as PluginManifest;
    unscoped(manifest);
    await writeFile(file, JSON.stringify(manifest, null, 2));
  }
  const now = await bundledRegistry(path.join(resources, "plugins"));
  const old = await bundledRegistry(path.join(before, "plugins"));
  try {
    const web = now.snapshot(GameEngine.Web);
    const was = old.snapshot();
    // A web game no longer gets the Unreal editor's skill and tools: they reach an Unreal project only.
    assert.deepEqual(
      web.tools,
      was.tools.filter((tool) => !UNREAL_EDITOR_TOOLS.includes(tool.name)),
      "a web game's tools",
    );
    assert.deepEqual(
      web.applied,
      { ...was.applied, skills: was.applied.skills.filter((skill) => skill !== UNREAL_SKILL) },
      "a web game's plugins and skills",
    );
    const unrealBlock = was.guidance.split("\n\n").filter((part) => !part.startsWith(`[${UNREAL_SKILL}]`));
    assert.equal(web.guidance, unrealBlock.join("\n\n"), "a web game's guidance, byte for byte but the Unreal skill");
    const unreal = now.snapshot(GameEngine.Unreal);
    for (const skill of WEB_ONLY) assert.ok(!unreal.applied.skills.includes(skill), `${skill} is the web's only`);
    for (const skill of WEB_ONLY) assert.ok(web.applied.skills.includes(skill), skill);
    assert.ok(unreal.applied.skills.includes(UNREAL_SKILL), "the Unreal plugin's own skill stays");
    assert.ok(unreal.applied.skills.includes("genex/asset-preference"), "assets are any engine's");
    assert.deepEqual(
      unreal.tools.map((tool) => tool.name).filter((name) => !web.tools.some((tool) => tool.name === name)),
      UNREAL_EDITOR_TOOLS,
      "an Unreal game has the editor tools a web game lacks",
    );
    // The seed reads the plugin as offering a new Unreal game exactly while it is on.
    assert.equal(offersUnrealGame(now.snapshot().tools), true);
    await now.setEnabled("unreal", false);
    assert.equal(offersUnrealGame(now.snapshot().tools), false);
  } finally {
    now.cancel();
    old.cancel();
  }
});
