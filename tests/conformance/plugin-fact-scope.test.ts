/**
 * A plugin's tools, skills and connectors reach a session only for the facts of its game; a skill
 * follows its tools. A tool, a skill or a plugin's MCP server may name the facts it is for
 * (`facts`, API 3); a skill may name the tools it explains (`tools`); a tool may say which facts it
 * makes in the game's folder (`makes`). The registry's snapshot narrows by the game's facts (a
 * game with no kind yet is served as a web game), lists the kinds its tools make, and never hands
 * an agent the scope fields; the connector registry never starts a server that does not reach the
 * game, and a session never calls a connector it was not handed.
 */
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import type { Writable } from "node:stream";
import { GameEngine } from "../../src/shared/game-engine.ts";
import { CoreFact, type FactRef, FolderHolds, type GameKind } from "../../src/shared/project-facts.ts";
import { PluginToolAudience } from "../../src/shared/plugins.ts";
import { UiEvent } from "../../src/shared/ui-events.ts";
import type { DelegateRequest } from "../../src/substrate/engines/types.ts";
import { McpRegistry } from "../../src/substrate/mcp/registry.ts";
import { validateManifest } from "../../src/substrate/plugins/manifest.ts";
import { PluginRegistry } from "../../src/substrate/plugins/registry.ts";
import type { ToolOffered } from "../../src/substrate/plugins/tool-allow.ts";
import { coreLite } from "../helpers/core-lite.ts";
import { copyOfExample, EXAMPLE_PLUGIN, PLUGIN_SDK_BACKEND } from "../helpers/plugins.ts";
import { tmpDir } from "../helpers/tmp.ts";

// biome-ignore lint/suspicious/noExplicitAny: a hostile manifest is any shape a writer may send.
type RawManifest = any;

const exampleManifest: RawManifest = JSON.parse(await readFile(path.join(EXAMPLE_PLUGIN, "plugin.json"), "utf8"));

const TOY = "toy-project";
const at = (id: string, where = "."): FactRef => ({ id, path: where });
const PENDING: FactRef[] = [];
const WEB = [at(CoreFact.WebGame)];
const UNREAL = [at(CoreFact.UnrealProject)];
const TOY_GAME = [at(TOY)];

/** A tool for the example manifest, with `fields` added. */
const tool = (name: string, fields: Record<string, unknown> = {}) => ({
  name,
  description: `The ${name} tool.`,
  parameters: { type: "object", properties: {} },
  ...fields,
});

/** The example manifest on API 3 with the given tools and skills. */
const manifestWith = (tools: unknown[], skills: unknown[] = [], apiVersion = 3): RawManifest => ({
  ...structuredClone(exampleManifest),
  apiVersion,
  tools,
  skills,
});

/** A registry whose only plugin is the example with `tools` and `skills`, a bundled seed and so enabled. */
async function registryWith(tools: unknown[], skills: unknown[] = []) {
  const root = await tmpDir("studio-fact-scope-");
  const seeds = path.join(root, "seeds");
  await mkdir(seeds);
  await copyOfExample(seeds, "example", (m) => Object.assign(m, manifestWith(tools, skills)));
  const registry = new PluginRegistry(path.join(root, "installed"), seeds, PLUGIN_SDK_BACKEND, async () => null);
  await registry.init();
  return registry;
}

const names = (registry: PluginRegistry, facts: FactRef[] | GameKind | GameEngine, offered?: ToolOffered) =>
  registry.snapshot(facts, offered).tools.map((t) => t.name);

test("a tool scoped to a fact reaches only games with it; an unscoped tool reaches every game", async () => {
  const registry = await registryWith([
    tool("greet"),
    tool("shout", { facts: [CoreFact.UnrealProject] }),
    tool("build", { facts: [TOY] }),
  ]);
  try {
    assert.deepEqual(names(registry, PENDING), ["example__greet"], "a game with no kind yet: a web game's tools");
    assert.deepEqual(names(registry, WEB), ["example__greet"]);
    assert.deepEqual(names(registry, UNREAL), ["example__greet", "example__shout"]);
    assert.deepEqual(names(registry, TOY_GAME), ["example__greet", "example__build"]);
    assert.deepEqual(names(registry, GameEngine.Unreal), names(registry, UNREAL), "an engine reads as its fact");
    assert.deepEqual(
      names(registry, [at(CoreFact.UnrealProject), at(CoreFact.WebGame, "site")]),
      ["example__greet", "example__shout"],
      "a fact anywhere in the folder reaches",
    );
    assert.deepEqual(registry.tools(), registry.snapshot(PENDING).tools, "tools() is a game with no kind yet");
  } finally {
    registry.cancel();
  }
});

test("a folder of a kind Genex can't name is served by no fact: only unscoped tools and skills reach it", async () => {
  const page = { name: "page", text: "Load the model with GLTFLoader.", engines: [GameEngine.Web] };
  const registry = await registryWith([tool("greet"), tool("draw", { facts: [CoreFact.WebGame] })], [page]);
  try {
    for (const holds of [FolderHolds.Nothing, FolderHolds.Notes])
      assert.deepEqual(names(registry, { facts: [], holds }), ["example__greet", "example__draw"], holds);
    for (const holds of [FolderHolds.OwnFiles, FolderHolds.Unreadable]) {
      assert.deepEqual(names(registry, { facts: [], holds }), ["example__greet"], `${holds}: no web tool`);
      assert.deepEqual(registry.snapshot({ facts: [], holds }).applied.skills, [], `${holds}: no web skill`);
    }
  } finally {
    registry.cancel();
  }
});

test("a skill reaches only while one of its tools does", async () => {
  const skill = { name: "toy", text: "Build with example__build.", facts: [TOY], tools: ["build"] };
  const elsewhere = await registryWith([tool("greet"), tool("build", { facts: [CoreFact.UnrealProject] })], [skill]);
  const reaching = await registryWith([tool("greet"), tool("build", { facts: [TOY] })], [skill]);
  try {
    assert.deepEqual(elsewhere.snapshot(TOY_GAME).applied.skills, [], "its tool is scoped elsewhere");
    assert.doesNotMatch(elsewhere.snapshot(TOY_GAME).guidance, /\[example\/toy\]/);
    assert.deepEqual(reaching.snapshot(TOY_GAME).applied.skills, ["example/toy"], "its tool reaches");
    const withoutBuild: ToolOffered = (name) => name !== "example__build";
    assert.deepEqual(reaching.snapshot(TOY_GAME, withoutBuild).applied.skills, [], "its tool was not offered");
    assert.deepEqual(reaching.snapshot(WEB).applied.skills, [], "its own facts are not the game's");
  } finally {
    elsewhere.cancel();
    reaching.cancel();
  }
});

/** One skill for every engine, one per engine, and one for both, in that order. */
const SKILLS = [
  { name: "any", text: "Works in every engine." },
  { name: "page", text: "Load the model with GLTFLoader.", engines: [GameEngine.Web] },
  { name: "editor", text: "Place the model in the open level.", engines: [GameEngine.Unreal] },
  { name: "both", text: "Either engine.", engines: [GameEngine.Web, GameEngine.Unreal] },
];

test("engines still reads as facts", async () => {
  const registry = await registryWith([tool("greet")], SKILLS);
  try {
    assert.deepEqual(registry.snapshot(WEB), registry.snapshot(GameEngine.Web));
    assert.deepEqual(registry.snapshot(UNREAL), registry.snapshot(GameEngine.Unreal));
    assert.deepEqual(registry.snapshot(WEB).applied.skills, ["example/any", "example/page", "example/both"]);
    assert.deepEqual(registry.snapshot(UNREAL).applied.skills, ["example/any", "example/editor", "example/both"]);
    const asFacts = SKILLS.map((s) => (s.engines ? { name: s.name, text: s.text, facts: s.engines.map(factOf) } : s));
    const spelledAsFacts = await registryWith([tool("greet")], asFacts);
    try {
      assert.deepEqual(spelledAsFacts.snapshot(UNREAL).guidance, registry.snapshot(UNREAL).guidance);
    } finally {
      spelledAsFacts.cancel();
    }
  } finally {
    registry.cancel();
  }
});
const factOf = (engine: GameEngine) => (engine === GameEngine.Web ? CoreFact.WebGame : CoreFact.UnrealProject);

test("a skill for one part of the folder names that part", async () => {
  const registry = await registryWith([tool("greet")], SKILLS);
  try {
    const { guidance } = registry.snapshot([at(CoreFact.UnrealProject), at(CoreFact.WebGame, "site")]);
    assert.match(guidance, /\[example\/page\] \(for site\/\)\nLoad the model/);
    assert.match(guidance, /\[example\/editor\]\nPlace the model/);
    assert.match(guidance, /\[example\/any\]\nWorks/);
    assert.match(guidance, /\[example\/both\]\nEither/, "a skill that also applies at the root names no part");
    assert.doesNotMatch(registry.snapshot(WEB).guidance, /\(for /, "a web game's guidance names no part");
  } finally {
    registry.cancel();
  }
});

test("the snapshot lists the kinds its tools make, and an agent never sees facts or makes", async () => {
  const registry = await registryWith([
    tool("greet"),
    tool("new-toy", { makes: [TOY] }),
    tool("build", { facts: [TOY], makes: [TOY, CoreFact.WebGame] }),
  ]);
  try {
    const kind = { plugin: "example", name: exampleManifest.name, tool: "example__new-toy", makes: [TOY] };
    assert.deepEqual(registry.snapshot(WEB).kinds, [kind]);
    assert.deepEqual(registry.snapshot(TOY_GAME).kinds, [
      kind,
      { plugin: "example", name: exampleManifest.name, tool: "example__build", makes: [TOY, CoreFact.WebGame] },
    ]);
    assert.deepEqual(registry.snapshot(WEB, (name) => name !== "example__new-toy").kinds, [], "not offered");
    for (const handed of registry.snapshot(TOY_GAME).tools) {
      assert.equal(Object.hasOwn(handed, "facts"), false, handed.name);
      assert.equal(Object.hasOwn(handed, "makes"), false, handed.name);
    }
  } finally {
    registry.cancel();
  }
});

test("a manifest keeps its scope fields, and a malformed scope is refused", () => {
  const kept = validateManifest(
    manifestWith(
      [tool("greet", { facts: [TOY], makes: [TOY] }), tool("shout")],
      [
        { name: "inline", text: "t", facts: [TOY], tools: ["greet"] },
        { name: "file", summary: "s", file: "skills/f.md", facts: [CoreFact.WebGame] },
      ],
    ),
  );
  assert.deepEqual(kept.tools[0], { ...tool("greet"), facts: [TOY], makes: [TOY] });
  assert.equal(Object.hasOwn(kept.tools[1] ?? {}, "facts"), false, "no scope: no field invented");
  assert.deepEqual(kept.skills, [
    { name: "inline", text: "t", facts: [TOY], tools: ["greet"] },
    { name: "file", summary: "s", file: "skills/f.md", facts: [CoreFact.WebGame] },
  ]);
  const badFacts: unknown[] = [[], ["Toy"], [TOY, TOY], Array.from({ length: 9 }, (_, i) => `f${i}`), TOY, [1], null];
  for (const facts of badFacts) {
    const raw = JSON.stringify(facts);
    assert.throws(() => validateManifest(manifestWith([tool("greet", { facts })])), /facts/, `tool ${raw}`);
    const skill = { name: "s", text: "t", facts };
    assert.throws(() => validateManifest(manifestWith([tool("greet")], [skill])), /facts/, `skill ${raw}`);
    assert.throws(() => validateManifest(withServer({ facts })), /facts/, `server ${raw}`);
  }
  const badMakes: unknown[] = [[], ["Toy"], [TOY, TOY], ["a", "b", "c", "d", "e"], TOY, [null]];
  for (const makes of badMakes)
    assert.throws(() => validateManifest(manifestWith([tool("greet", { makes })])), /makes/, JSON.stringify(makes));
  const harnessMakes = tool("greet", { audience: PluginToolAudience.Harness, makes: [TOY] });
  assert.throws(() => validateManifest(manifestWith([harnessMakes])), /makes/, "a harness tool makes nothing");
  const harnessOnly = tool("step", { audience: PluginToolAudience.Harness });
  const badTools: unknown[] = [[], ["nosuch"], ["greet", "greet"], ["step"], "greet", [1]];
  for (const tools of badTools) {
    const skill = { name: "s", text: "t", tools };
    assert.throws(
      () => validateManifest(manifestWith([tool("greet"), harnessOnly], [skill])),
      /tools/,
      JSON.stringify(tools),
    );
  }
  assert.throws(() => validateManifest(manifestWith([tool("greet", { facts: [TOY] })], [], 2)), /apiVersion 3/);
  assert.throws(() => validateManifest(manifestWith([tool("greet", { makes: [TOY] })], [], 2)), /apiVersion 3/);
});

/** The example manifest with one MCP server carrying `fields`. */
const withServer = (fields: Record<string, unknown>): RawManifest => ({
  ...manifestWith([tool("greet")]),
  mcpServers: [
    { id: "editor", transport: "stdio", command: "node", args: ["s.mjs"], cwd: "storage", description: "d", ...fields },
  ],
});

const SERVER = path.resolve("tests/fixtures/mcp/echo-server.mjs");

test("a plugin's connector scoped to a fact is never started for a game without it", async () => {
  const root = await tmpDir("studio-fact-scope-mcp-");
  const registry = new McpRegistry({ file: path.join(root, "connectors.json") });
  await registry.init();
  let started = 0;
  try {
    assert.deepEqual(validateManifest(withServer({ facts: [CoreFact.UnrealProject] })).mcpServers?.[0]?.facts, [
      CoreFact.UnrealProject,
    ]);
    await registry.registerPluginServer(
      "unreal",
      { id: "editor", name: "Unreal · editor", command: "ignored", args: [], facts: [CoreFact.UnrealProject] },
      {
        execPath: process.execPath,
        extraArgs: [SERVER],
        extraStdio: ["pipe"],
        stdioExtra: (child) => {
          started++;
          (child.stdio[3] as Writable).end("");
        },
      },
    );
    assert.deepEqual(await registry.toolsFor("alpha", { facts: WEB }), []);
    assert.deepEqual(await registry.toolsFor("alpha", { facts: PENDING }), [], "a game with no kind yet");
    assert.equal(started, 0, "nothing was started");
    const unreal = await registry.toolsFor("alpha", { facts: UNREAL });
    assert.ok(
      unreal.some((t) => t.name === "unreal-editor__echo"),
      JSON.stringify(unreal.map((t) => t.name)),
    );
    assert.equal(started, 1);
    // A worker is never handed the server its game's kind brings (an engine's live editor).
    assert.deepEqual(await registry.toolsFor("alpha", { facts: UNREAL, kindServers: false }), []);
  } finally {
    await registry.close();
  }
});

test("a session never calls a connector it was not handed", async (t) => {
  const consents: unknown[] = [];
  const { core, close } = await coreLite({
    // A card nobody expected fails the test as a timed-out decline instead of hanging it.
    consentTimeoutMs: 2000,
    onUiEvent: (event) => {
      if (event.type === UiEvent.PluginConsent) consents.push(event.payload);
    },
  });
  t.after(async () => {
    await core.mcp.close().catch(() => {});
    await close();
  });
  await core.mcp.registerPluginServer(
    "unreal",
    { id: "editor", name: "Unreal · editor", command: "ignored", args: [], facts: [CoreFact.UnrealProject] },
    { execPath: process.execPath, extraArgs: [SERVER] },
  );
  const web = "kite-run";
  const unreal = "harbor";
  await core.games.scaffold(web);
  const harbor = await core.games.scaffold(unreal);
  await writeFile(path.join(harbor.dir, "Harbor.uproject"), "{}");
  const sessions: Array<{ project: string; handed: boolean; refused: string }> = [];
  core.engines.register({
    id: "claude-code",
    label: "fixture",
    kind: "delegated",
    status: async () => ({ code: "ready", detail: "fixture" }),
    models: async () => [],
    delegate: async (request: DelegateRequest) => {
      const handed = (request.liveTools ?? []).some((tool) => tool.name === "unreal-editor__echo");
      let refused = "";
      if (!handed)
        await request.onLiveTool?.("unreal-editor__echo", { text: "hi" }).catch((e: Error) => {
          refused = e.message;
        });
      sessions.push({ project: request.cwd, handed, refused });
      return { ok: true, engine: "claude-code", summary: "fixture", turns: 1, usage: {} };
    },
  } as never);
  const api = core.api() as unknown as Record<string, (input: unknown) => Promise<unknown>>;
  for (const project of [web, unreal]) {
    const threadId = await core.createGameThread(project);
    await api["engine.delegate"]?.({ engine: "claude-code", project, threadId, prompt: "Build" });
  }
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0]?.handed, false, "a web game's session is not handed the Unreal connector");
  assert.match(sessions[0]?.refused ?? "", /Unknown tool: unreal-editor__echo/);
  assert.deepEqual(consents, [], "nobody was asked");
  assert.equal(sessions[1]?.handed, true, "a game holding an Unreal project is");
});

test("whether a connector reaches a game is the one rule its listing, capability facts and harness calls follow", async (t) => {
  const consents: unknown[] = [];
  let started = 0;
  const { core, close } = await coreLite({
    consentTimeoutMs: 2000,
    onUiEvent: (event) => {
      if (event.type === UiEvent.PluginConsent) consents.push(event.payload);
    },
  });
  t.after(async () => {
    await core.mcp.close().catch(() => {});
    await close();
  });
  await core.mcp.registerPluginServer(
    "unreal",
    { id: "editor", name: "Unreal · editor", command: "ignored", args: [], facts: [CoreFact.UnrealProject] },
    {
      execPath: process.execPath,
      extraArgs: [SERVER],
      extraStdio: ["pipe"],
      stdioExtra: (child) => {
        started++;
        (child.stdio[3] as Writable).end("");
      },
    },
  );
  const id = "unreal-editor";
  const rows: Array<[string, FactRef[], boolean]> = [
    ["a game with no kind yet", PENDING, false],
    ["a web game", WEB, false],
    ["an Unreal project", UNREAL, true],
    ["an Unreal project beside a site", [at(CoreFact.UnrealProject, "game"), at(CoreFact.WebGame, "site")], true],
  ];
  for (const [label, facts, reaches] of rows) assert.equal(core.mcp.reaches(id, facts), reaches, label);
  assert.equal(core.mcp.reaches("no-such-connector", UNREAL), false, "an unknown connector reaches nothing");

  const web = "kite-describe";
  const harbor = await core.games.scaffold("harbor-describe");
  const kite = await core.games.scaffold(web);
  await writeFile(path.join(harbor.dir, "Harbor.uproject"), "{}");
  const api = core.api() as unknown as Record<string, (input: unknown) => Promise<unknown>>;
  const describe = async (project: string) =>
    String(await api["capabilities.describe"]?.({ project, threadId: await core.createGameThread(project) }));
  assert.doesNotMatch(await describe(web), /Unreal · editor/, "a web game's capability facts");
  assert.match(await describe(harbor.name), /Unreal · editor/, "a game holding an Unreal project's");

  // Only a web game at the root runs on the Studio template; a shape read from a folder with no
  // page falls back to the template's, and must not make an empty or Godot game claim it.
  const TEMPLATE_CLAIM = /This project uses the Studio template/;
  assert.deepEqual(await core.games.factsOf(kite.name).then((facts) => facts.map((f) => f.id)), [CoreFact.WebGame]);
  assert.match(await describe(web), TEMPLATE_CLAIM, "a web game at its root");
  await api["game.scaffold"]?.({ name: "empty-describe" });
  assert.doesNotMatch(await describe("empty-describe"), TEMPLATE_CLAIM, "a new empty game");
  const godot = await core.games.scaffold("godot-describe");
  await rm(path.join(godot.dir, "index.html"));
  // No starter stamp either: only the Godot project is left.
  const meta = path.join(godot.dir, "studio.json");
  const { contractVersion: _starter, ...kept } = JSON.parse(await readFile(meta, "utf8")) as Record<string, unknown>;
  await writeFile(meta, JSON.stringify(kept));
  await writeFile(path.join(godot.dir, "project.godot"), "config_version=5\n");
  assert.doesNotMatch(await describe(godot.name), TEMPLATE_CLAIM, "a Godot project");

  // The harness's own connector call on a game it does not reach starts nothing and asks nobody.
  const threadId = await core.createGameThread(web);
  for (const project of [web, "../x", "no-such-game"]) {
    await assert.rejects(
      api["mcp.invoke"]?.({ project, threadId, name: "unreal-editor__echo", args: { text: "hi" } }) ??
        Promise.reject(new Error("no mcp.invoke")),
      JSON.stringify(project),
    );
  }
  assert.equal(started, 0, "no server was started for a game it does not reach");
  assert.deepEqual(consents, [], "nobody was asked");

  // A hostile or unknown game name gets the scope of a game with no kind yet, and writes nothing.
  const gamesBefore = (await readdir(core.layout.gamesRoot)).sort();
  const noKind = core.plugins.snapshot(PENDING).tools.map((t) => t.name);
  for (const project of ["../x", "/", "no-such-game", ""]) {
    const listed = (await api["plugins.tools"]?.({ project })) as { tools: Array<{ name: string }> };
    assert.deepEqual(
      listed.tools.map((t) => t.name),
      noKind,
      `plugins.tools ${JSON.stringify(project)}`,
    );
    const connectors = (await api["mcp.tools"]?.({ project })) as { tools: Array<{ name: string }> };
    assert.ok(!connectors.tools.some((t) => t.name.startsWith(`${id}__`)), `mcp.tools ${JSON.stringify(project)}`);
  }
  assert.equal(started, 0, "no server was started for a name that is no game");
  assert.deepEqual((await readdir(core.layout.gamesRoot)).sort(), gamesBefore, "nothing was written");
});
