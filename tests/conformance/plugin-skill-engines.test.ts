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
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { GameEngine } from "../../src/shared/game-engine.ts";
import type { PluginInfo, PluginManifest } from "../../src/shared/plugins.ts";
import { CoreFact, type FactRef } from "../../src/shared/project-facts.ts";
import { validateManifest } from "../../src/substrate/plugins/manifest.ts";
import { PluginRegistry } from "../../src/substrate/plugins/registry.ts";
import { planningCapabilities } from "../../src/main/planning-capabilities.ts";
import { coreLite } from "../helpers/core-lite.ts";
import { capabilityFactsOf, copyOfExample, EXAMPLE_PLUGIN, PLUGIN_SDK_BACKEND } from "../helpers/plugins.ts";
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
    const text = planningCapabilities(1, plugins, { sources: [] } as never, [], engine);
    const facts = JSON.parse(text.split("\n\n")[2] ?? "{}") as { plugins: Array<{ skills: Array<{ name: string }> }> };
    return facts.plugins[0]?.skills.map((s) => s.name);
  };
  assert.deepEqual(skillsIn(GameEngine.Unreal), ["any", "editor", "both"]);
  assert.deepEqual(skillsIn(GameEngine.Web), ["any", "page", "both"]);
  assert.deepEqual(skillsIn(), skillsIn(GameEngine.Web));
});

/** The bundled plugins whose skills a game's brief can carry, all turned on. */
const BUNDLED = ["blender", "genex", "roblox", "unreal"];
/** The web-only skills of the bundled plugins: three.js multiplayer, embed sign-in, Genex's web publishing and play-time lanes. */
const WEB_ONLY = [
  "genex/genex-threejs-multiplayer",
  "genex/genex-threejs-embed-auth",
  "genex/publishing",
  "genex/genex-tool-publish",
  "genex/genex-llm-in-games",
  "genex/genex-tool-llm",
  "genex/genex-monetization",
];

async function bundledRegistry(seeds: string, on: readonly string[] = BUNDLED) {
  const root = await tmpDir("studio-skill-engines-bundled-");
  const registry = new PluginRegistry(
    path.join(root, "installed"),
    seeds,
    path.join(path.dirname(seeds), "plugin-sdk", "backend.mjs"),
    async () => null,
  );
  await registry.init();
  for (const id of on) await registry.setEnabled(id, true);
  return registry;
}

/** Every bundled plugin with tools for a game's session, all turned on. */
const ALL_ON = ["blender", "genex", "unity", "godot", "roblox", "unreal"];
/** A game of each engine: its facts, its engine's plugin and fact, and a tool only that engine's games get. */
const ENGINE_GAMES = [
  { label: "Unity", facts: [{ id: CoreFact.UnityProject, path: "unity" }], plugin: "unity", own: "unity__open-editor" },
  {
    label: "Unity with its WebGL build",
    facts: [
      { id: CoreFact.UnityProject, path: "unity" },
      { id: CoreFact.WebGame, path: "web" },
    ],
    plugin: "unity",
    own: "unity__open-editor",
  },
  { label: "Godot", facts: [{ id: CoreFact.GodotProject, path: "godot" }], plugin: "godot", own: "godot__check" },
  {
    label: "Roblox",
    facts: [{ id: CoreFact.RobloxProject, path: "." }],
    plugin: "roblox",
    own: "roblox__check-scripts",
  },
  {
    label: "Unreal",
    facts: [{ id: CoreFact.UnrealProject, path: "unreal" }],
    plugin: "unreal",
    own: "unreal__blueprint-guide",
  },
];
/** The fact each engine's plugin makes a game of. */
const ENGINE_FACT_OF: Record<string, string> = {
  unity: CoreFact.UnityProject,
  godot: CoreFact.GodotProject,
  roblox: CoreFact.RobloxProject,
  unreal: CoreFact.UnrealProject,
};

// Flipped: a game of each engine was offered its own engine's kind, read as for a game with no kind
// yet, while the seed read the kinds as which plugins are on. A snapshot's kinds are the kind tools
// that reach its game: an engine's way in reaches a game with no kind yet (and a web game), never a
// game that already has an engine's kind.
test("a game of each engine is offered no kind and handed its own engine's tools; a game with no kind yet each engine's", async () => {
  const resources = await makeResources({ tsc: false });
  const registry = await bundledRegistry(path.join(resources, "plugins"), ALL_ON);
  try {
    for (const row of ENGINE_GAMES) {
      const { kinds, tools } = registry.snapshot(row.facts);
      assert.deepEqual(
        kinds.map((kind) => kind.tool),
        [],
        `${row.label}: no kind`,
      );
      assert.ok(
        tools.some((tool) => tool.name === row.own),
        `${row.label}: ${row.own}`,
      );
    }
    assert.deepEqual(
      registry.snapshot().kinds.map((kind) => [kind.tool, kind.makes]),
      [
        ["godot__new-game", [CoreFact.GodotProject]],
        ["roblox__new-game", [CoreFact.RobloxProject]],
        ["unity__new-game", [CoreFact.UnityProject]],
        ["unreal__new-game", [CoreFact.UnrealProject]],
        ["unreal__new-plugin", [CoreFact.UnrealProject, CoreFact.UnrealPlugin]],
      ],
      "a game with no kind yet is offered each engine's",
    );
  } finally {
    registry.cancel();
  }
});

test("a game of one engine is handed none of another engine's tools", async () => {
  const resources = await makeResources({ tsc: false });
  const registry = await bundledRegistry(path.join(resources, "plugins"), ALL_ON);
  try {
    for (const row of ENGINE_GAMES) {
      const { tools, applied } = registry.snapshot(row.facts);
      const others = Object.keys(ENGINE_FACT_OF).filter((plugin) => plugin !== row.plugin);
      for (const { name } of tools) {
        assert.ok(!others.some((plugin) => name.startsWith(`${plugin}__`)), `${row.label}: ${name}`);
        assert.ok(!/__new-(game|plugin)$/.test(name), `${row.label}: ${name} makes a game of a kind it already has`);
      }
      assert.ok(!tools.some((tool) => tool.name === "genex__package"), `${row.label}: packaging is a web game's`);
      assert.ok(applied.plugins.includes(row.plugin), `${row.label}: its own engine's plugin`);
      for (const plugin of others)
        assert.ok(!applied.plugins.includes(plugin), `${row.label}: ${plugin} is not handed`);
    }
  } finally {
    registry.cancel();
  }
});

/** Each engine's way in: what a game with no kind yet gets to make, link or set up a game of it. */
const WAYS_IN = [
  "unity__new-game",
  "godot__new-game",
  "roblox__new-game",
  "roblox__finish-setup",
  "roblox__get-studio",
  "roblox__setup",
  "roblox__restart-studio",
  "roblox__open-studio",
  "roblox__do-it-for-me",
  "roblox__use-project",
  "unreal__new-game",
  "unreal__install-unreal",
];
/** Tools that work on a game of their engine's own kind, which a game with no kind yet does not have (Roblox's: `ROBLOX_ONLY_TOOLS`). */
const GAME_TOOLS = ["godot__class-reference"];

test("a game with no kind yet is handed each engine's way in and none of its game tools", async () => {
  const resources = await makeResources({ tsc: false });
  const registry = await bundledRegistry(path.join(resources, "plugins"), ALL_ON);
  try {
    const names = registry.snapshot().tools.map((tool) => tool.name);
    for (const name of WAYS_IN) assert.ok(names.includes(name), name);
    for (const name of GAME_TOOLS) assert.ok(!names.includes(name), name);
  } finally {
    registry.cancel();
  }
});

/** Each engine's guide, with the game it reaches. */
const ENGINE_GUIDES: Array<{ plugin: string; skill: string; facts: FactRef[] }> = [
  { plugin: "unity", skill: "unity-editor", facts: [{ id: CoreFact.UnityProject, path: "unity" }] },
  { plugin: "godot", skill: "godot", facts: [{ id: CoreFact.GodotProject, path: "godot" }] },
  { plugin: "roblox", skill: "roblox-studio", facts: [{ id: CoreFact.RobloxProject, path: "." }] },
  { plugin: "unreal", skill: "unreal-editor", facts: [{ id: CoreFact.UnrealProject, path: "unreal" }] },
  { plugin: "unreal", skill: "unreal-web", facts: [{ id: CoreFact.UnrealProject, path: "unreal" }] },
  {
    plugin: "unreal",
    skill: "unreal-plugin",
    facts: [
      { id: CoreFact.UnrealProject, path: "unreal" },
      { id: CoreFact.UnrealPlugin, path: "unreal/Plugins/Stamp" },
    ],
  },
];

test("an engine's guide is read on demand, not carried whole in every brief", async () => {
  const resources = await makeResources({ tsc: false });
  const registry = await bundledRegistry(path.join(resources, "plugins"), ALL_ON);
  const directory = await tmpDir("studio-skill-engines-guide-");
  try {
    for (const { plugin, skill, facts } of ENGINE_GUIDES) {
      const text = await registry.skillText(plugin, skill);
      const { guidance } = registry.snapshot(facts);
      assert.ok(guidance.includes(`[${plugin}/${skill}] `), `${plugin}/${skill} has an index line`);
      assert.ok(
        guidance.includes(`${plugin}__skill ${JSON.stringify({ name: skill })}`),
        `${plugin}/${skill}'s reader`,
      );
      assert.ok(!guidance.includes(text), `${plugin}/${skill}'s text is not in the brief`);
      const page = (await registry.tool(`${plugin}__skill`, { name: skill }, { project: "guide", directory })) as {
        text: string;
      };
      assert.ok(page.text.length > 0 && text.startsWith(page.text), `${plugin}/${skill} reads as its file`);
    }
  } finally {
    registry.cancel();
  }
});

test("a plugin's skill tool names only the skills that reach the game", async () => {
  const resources = await makeResources({ tsc: false });
  const registry = await bundledRegistry(path.join(resources, "plugins"), ALL_ON);
  try {
    const reader = (facts: FactRef[]) =>
      registry.snapshot(facts).tools.find((tool) => tool.name === "genex__skill")?.description ?? "";
    const unity = reader([{ id: CoreFact.UnityProject, path: "unity" }]);
    assert.doesNotMatch(unity, /genex-threejs-multiplayer/, "a Unity game reads no three.js skill");
    assert.match(unity, /genex-tool-model/);
    const web = reader([at(CoreFact.WebGame)]);
    assert.match(web, /genex-threejs-multiplayer/);
    assert.match(web, /genex-tool-model/);
  } finally {
    registry.cancel();
  }
});

/** The Unreal plugin's tools for a game that holds an Unreal project only. */
const UNREAL_EDITOR_TOOLS = [
  "unreal__blueprint-guide",
  "unreal__find-nodes",
  "unreal__check-part",
  "unreal__cpp-status",
  "unreal__add-cpp-module",
  "unreal__motion-status",
  "unreal__add-motion-matching",
  "unreal__multiplayer",
  "unreal__package-game",
  "unreal__package-status",
  "unreal__open-editor",
  "unreal__click-interface",
  "unreal__quit-editor",
  "unreal__editor-status",
];
const UNREAL_SKILL = "unreal/unreal-editor";
/** The Unreal plugin's tools and skill for a game that holds an Unreal plugin only. */
const UNREAL_PLUGIN_TOOLS = [
  "unreal__plugin-build",
  "unreal__plugin-test",
  "unreal__plugin-package",
  "unreal__plugin-status",
];
const UNREAL_PLUGIN_SKILL = "unreal/unreal-plugin";
/** What a web game no longer gets from the Unreal plugin: its editor's and its plugin projects' tools, their skills and the reader of those. */
const UNREAL_ONLY_TOOLS = [...UNREAL_EDITOR_TOOLS, ...UNREAL_PLUGIN_TOOLS, "unreal__skill"];
/** The Unreal plugin's multiplayer skill, for a game that holds an Unreal project only. */
const UNREAL_MULTIPLAYER_SKILL = "unreal/unreal-multiplayer";
/** The Unreal plugin's skill on a game's web version, for a game that holds an Unreal project only. */
const UNREAL_WEB_SKILL = "unreal/unreal-web";
const UNREAL_ONLY_SKILLS = [UNREAL_SKILL, UNREAL_MULTIPLAYER_SKILL, UNREAL_WEB_SKILL, UNREAL_PLUGIN_SKILL];
/** The Roblox plugin's skills, in manifest order: they reach a game that holds a Roblox place only. */
const ROBLOX_SKILLS = [
  "roblox/roblox-studio",
  "roblox/luau",
  "roblox/remotes",
  "roblox/player-data",
  "roblox/purchases",
  "roblox/ui-scale",
  "roblox/assets",
  "roblox/get-started",
  "roblox/publish",
];
/** The skills a web game never gets: those of an engine's own project. */
const ENGINE_ONLY_SKILLS = [...UNREAL_ONLY_SKILLS, ...ROBLOX_SKILLS];
/** The Roblox plugin's agent tools (the reader of its file skills, check-scripts), which reach a Roblox game only. */
const ROBLOX_ONLY_TOOLS = [
  "roblox__skill",
  "roblox__check-scripts",
  "roblox__generate-mesh",
  "roblox__generate-model",
  "roblox__generate-texture",
  "roblox__generate-material",
  "roblox__segment-mesh",
  "roblox__roblox-playtest",
  "roblox__roblox-explore",
  "roblox__upload-image",
  "roblox__store-image",
  "roblox__insert-asset",
  "roblox__check-model",
  "roblox__import-model",
  "roblox__publish-update",
  "roblox__first-publish",
  "roblox__publish-result",
  "roblox__cover-pictures",
  "roblox__places",
  "roblox__add-luau-checks",
  "roblox__quit-studio",
  "roblox__undo-setup",
];

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
    // So does the parameter a tool that makes a kind links its project by.
    delete tool.links;
  }
  for (const server of manifest.mcpServers ?? []) delete server.facts;
  // A scaffold names a tool that makes a kind, which came with facts too.
  delete manifest.scaffolds;
}

test("the bundled plugins' web guidance is what it was before skills named engines, but the engines' own skills and the Unreal editor's tools; an Unreal game's drops the web-only skills", async () => {
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
      was.tools.filter((tool) => ![...UNREAL_ONLY_TOOLS, ...ROBLOX_ONLY_TOOLS].includes(tool.name)),
      "a web game's tools",
    );
    assert.deepEqual(
      web.applied,
      {
        // Every bundled plugin takes part: Roblox's and Unreal's place tools (new-game, use-project) reach a web game.
        plugins: was.applied.plugins,
        skills: was.applied.skills.filter((skill) => !ENGINE_ONLY_SKILLS.includes(skill)),
      },
      "a web game's plugins and skills",
    );
    const engineBlock = was.guidance
      .split("\n\n")
      .filter((part) => !ENGINE_ONLY_SKILLS.some((skill) => part.startsWith(`[${skill}]`)));
    assert.equal(
      web.guidance,
      engineBlock.join("\n\n"),
      "a web game's guidance, byte for byte but the engines' skills",
    );
    const unreal = now.snapshot(GameEngine.Unreal);
    for (const skill of WEB_ONLY) assert.ok(!unreal.applied.skills.includes(skill), `${skill} is the web's only`);
    for (const skill of WEB_ONLY) assert.ok(web.applied.skills.includes(skill), skill);
    assert.ok(unreal.applied.skills.includes(UNREAL_SKILL), "the Unreal plugin's own skill stays");
    assert.ok(unreal.applied.skills.includes("genex/genex-tool-model"), "assets are any engine's");
    assert.deepEqual(
      unreal.tools.map((tool) => tool.name).filter((name) => !web.tools.some((tool) => tool.name === name)),
      [...UNREAL_EDITOR_TOOLS, "unreal__skill"],
      "an Unreal game has the editor tools a web game lacks, and the reader of its guides",
    );
    // The plugin's new-game tool is handed exactly while it is on.
    const newGame = () => now.snapshot().tools.some((tool) => tool.name === "unreal__new-game");
    assert.equal(newGame(), true);
    await now.setEnabled("unreal", false);
    assert.equal(newGame(), false);
  } finally {
    now.cancel();
    old.cancel();
  }
});

/** One fact at the folder's root. */
const at = (id: string): FactRef => ({ id, path: "." });
/** The fact a Roblox place gives its game. */
const ROBLOX_PROJECT = "roblox-project";
/** Words the person's guidance never uses: the hours control has no time of day, and Roblox's skills never speak of Unreal. */
const BANNED_WORDS = /overnight|night|morning|tonight|Unreal/i;
/** One plugin's skills in a snapshot. */
const skillsOf = (applied: { skills: string[] }, plugin: string) =>
  applied.skills.filter((skill) => skill.startsWith(`${plugin}/`));

test("Roblox's skills reach only a game that holds a Roblox place, and Unreal's only an Unreal game", async () => {
  const resources = await makeResources({ tsc: false });
  const registry = await bundledRegistry(path.join(resources, "plugins"));
  try {
    const roblox = registry.snapshot([at(ROBLOX_PROJECT)]);
    const unreal = registry.snapshot([at(CoreFact.UnrealProject)]);
    const web = registry.snapshot([at(CoreFact.WebGame)]);
    assert.deepEqual(skillsOf(roblox.applied, "roblox"), ROBLOX_SKILLS, "a Roblox game reads every Roblox skill");
    assert.deepEqual(skillsOf(unreal.applied, "roblox"), [], "an Unreal game reads none");
    assert.deepEqual(skillsOf(web.applied, "roblox"), [], "a web game reads none");
    assert.deepEqual(registry.snapshot().applied.skills, web.applied.skills, "nor does a game with no kind yet");
    assert.deepEqual(skillsOf(roblox.applied, "unreal"), [], "a Roblox game reads no Unreal skill");
    for (const skill of UNREAL_ONLY_SKILLS)
      assert.ok(
        registry.snapshot([at(CoreFact.UnrealProject), at(CoreFact.UnrealPlugin)]).applied.skills.includes(skill),
        skill,
      );
    for (const skill of WEB_ONLY) assert.ok(!roblox.applied.skills.includes(skill), `${skill} is the web's only`);
    // The brief names each file skill with the call that reads it; only a Roblox game holds that reader.
    for (const skill of ROBLOX_SKILLS) assert.match(roblox.guidance, new RegExp(`\\[${skill}\\]`));
    assert.doesNotMatch(web.guidance, /\[roblox\//);
    assert.doesNotMatch(unreal.guidance, /\[roblox\//);
    const names = (tools: { name: string }[]) => tools.map((tool) => tool.name);
    assert.ok(names(roblox.tools).includes("roblox__skill"));
    assert.ok(!names(web.tools).includes("roblox__skill"));
    assert.ok(!names(unreal.tools).includes("roblox__skill"));
  } finally {
    registry.cancel();
  }
});

test("each Roblox skill fits a skill's 16000 characters and names no time of day", async () => {
  const resources = await makeResources({ tsc: false });
  const root = path.join(resources, "plugins", "roblox");
  const manifest = validateManifest(JSON.parse(await readFile(path.join(root, "plugin.json"), "utf8")));
  assert.deepEqual(
    manifest.skills.map((skill) => `roblox/${skill.name}`),
    ROBLOX_SKILLS,
  );
  for (const skill of manifest.skills) {
    assert.deepEqual(skill.facts, [ROBLOX_PROJECT], `${skill.name} is scoped by the Roblox fact`);
    assert.equal(skill.engines, undefined, `${skill.name} names no engine`);
    const text = "file" in skill ? await readFile(path.join(root, skill.file), "utf8") : skill.text;
    assert.ok(text.length > 0 && text.length <= 16_000, `${skill.name}: ${text.length} characters`);
    assert.doesNotMatch(text, BANNED_WORDS, skill.name);
    if ("summary" in skill) assert.doesNotMatch(skill.summary, BANNED_WORDS, skill.name);
  }
});

test("a Roblox game's chat lists the Roblox skills and a web game's does not", async (t) => {
  const { core, close } = await coreLite();
  t.after(async () => {
    // A core that was never started leaves its plugins' processes to the test.
    core.plugins.cancel();
    await close();
  });
  await core.plugins.setEnabled("roblox", true);
  const web = await core.games.scaffold("kite-skills");
  const obby = await core.games.scaffold("obby-skills");
  // A game folder that holds a Roblox place and nothing of the web template.
  await rm(path.join(obby.dir, "index.html"));
  const meta = path.join(obby.dir, "studio.json");
  const { contractVersion: _starter, ...kept } = JSON.parse(await readFile(meta, "utf8")) as Record<string, unknown>;
  await writeFile(meta, JSON.stringify(kept));
  await writeFile(path.join(obby.dir, "place.rbxl"), "");
  assert.deepEqual(
    (await core.games.factsOf(obby.name)).map((fact) => fact.id),
    [ROBLOX_PROJECT],
  );
  /** The skill names the capability facts list for the plugin `roblox`. */
  const robloxSkills = async (project: string) => {
    const text = await capabilityFactsOf(core, project);
    const facts = text
      .split("\n\n")
      .map((part) => {
        try {
          return JSON.parse(part) as { plugins?: Array<{ id: string; skills: Array<{ name: string }> }> };
        } catch {
          return {};
        }
      })
      .find((part) => part.plugins);
    return (
      facts?.plugins?.find((plugin) => plugin.id === "roblox")?.skills.map((skill) => `roblox/${skill.name}`) ?? []
    );
  };
  assert.deepEqual(await robloxSkills(obby.name), ROBLOX_SKILLS);
  assert.deepEqual(await robloxSkills(web.name), []);
});

test("a Godot or Unity game's web export in web/ is its engine's build: no web-only skill reaches the game for it", async () => {
  const resources = await makeResources({ tsc: false });
  const registry = await bundledRegistry(path.join(resources, "plugins"));
  try {
    const rows: Array<[string, FactRef[]]> = [
      [CoreFact.GodotProject, [{ id: CoreFact.GodotProject, path: "godot" }]],
      [CoreFact.UnityProject, [{ id: CoreFact.UnityProject, path: "unity" }]],
    ];
    for (const [kind, project] of rows) {
      const exported = registry.snapshot([...project, { id: CoreFact.WebGame, path: "web" }]);
      for (const skill of WEB_ONLY) assert.ok(!exported.applied.skills.includes(skill), `${kind}: ${skill}`);
      assert.ok(exported.applied.skills.includes("genex/publishing-apps"), `${kind}: its apps' publishing stays`);
    }
    const web = registry.snapshot([at(CoreFact.WebGame)]);
    for (const skill of WEB_ONLY) assert.ok(web.applied.skills.includes(skill), `a web game keeps ${skill}`);
    const beside = registry.snapshot([at(CoreFact.WebGame), { id: CoreFact.GodotProject, path: "godot" }]);
    for (const skill of WEB_ONLY)
      assert.ok(beside.applied.skills.includes(skill), `a web game at the root keeps ${skill}`);
  } finally {
    registry.cancel();
  }
});
