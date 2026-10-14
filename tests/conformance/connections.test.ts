/**
 * The tool registry's applied record, per thread, engine and session: what plugins and skills a
 * builder session was last handed once it answered. It is read back from the thread's log, so it
 * outlives the app, and a record that carries no set (a revision alone, a local model's
 * completion) never erases one that does.
 */
import assert from "node:assert/strict";
import { cp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, test } from "node:test";
import { ConnectionService } from "../../src/main/core/connections.ts";
import { CapabilityAudience } from "../../src/main/planning-capabilities.ts";
import { CustomEvent } from "../../src/shared/custom-events.ts";
import { EventKind } from "../../src/shared/event-log.ts";
import { BuildTarget, GameStack, ProjectKind } from "../../src/shared/game-project.ts";
import { EventStore } from "../../src/substrate/event-store.ts";
import { GameWorkspaces, ScaffoldCaller } from "../../src/substrate/game-workspace.ts";
import { tmpDir } from "../helpers/tmp.ts";
import { coreLite, type CoreLite } from "../helpers/core-lite.ts";
import { EXAMPLE_PLUGIN, installLocalOn, PLUGIN_SDK_BACKEND, personAllowsLocalTools } from "../helpers/plugins.ts";
import { PluginRegistry } from "../../src/substrate/plugins/registry.ts";
import { validateManifest } from "../../src/substrate/plugins/manifest.ts";
import type { PluginInfo } from "../../src/shared/plugins.ts";
import type { DelegateRequest, DelegateResult } from "../../src/substrate/engines/types.ts";
import type { StudioCore } from "../../src/main/studio-core.ts";

type ConnectionsCore = ConstructorParameters<typeof ConnectionService>[0];

/** A ConnectionService over `store`: only the log is real, since only the log is read back. */
function service(store: EventStore): ConnectionService {
  const core = {
    store,
    append: async (batch: Parameters<EventStore["appendEvents"]>[1], threadId: string) => {
      await store.appendEvents(threadId, batch);
      return "";
    },
    emit: () => {},
  } as unknown as ConnectionsCore;
  return new ConnectionService(core, () => false);
}

const BLENDER = { plugins: ["blender"], skills: ["blender/local-modeling"] };

test("a session's delivered plugins and skills are read back from its thread's log after a restart", async () => {
  const root = await tmpDir("connections-");
  const first = await EventStore.open(root);
  const threadId = await first.createThread();
  const before = service(first);
  await before.recordDelivered(threadId, "claude-code", "ses1", BLENDER);
  await before.recordDelivered(threadId, "codex", "ses1", { plugins: [], skills: [] });
  await before.recordApplied(threadId, "local", 3);

  const after = service(await EventStore.open(root));
  assert.deepEqual(await after.lastApplied(threadId, "claude-code", "ses1"), BLENDER);
  assert.deepEqual(await after.lastApplied(threadId, "codex", "ses1"), { plugins: [], skills: [] }, "per engine");
  assert.equal(await after.lastApplied(threadId, "local", "ses1"), undefined, "a revision record is no set");

  await after.recordApplied(threadId, "claude-code", 4);
  assert.deepEqual(await after.lastApplied(threadId, "claude-code", "ses1"), BLENDER, "and never erases a known one");
  await after.recordDelivered(threadId, "claude-code", "ses2", { plugins: [], skills: [] });
  assert.deepEqual(await after.lastApplied(threadId, "claude-code", "ses1"), BLENDER, "another session keeps its own");
  await after.recordDelivered(threadId, "claude-code", "ses1", { plugins: [], skills: [] });
  assert.deepEqual(
    await after.lastApplied(threadId, "claude-code", "ses1"),
    { plugins: [], skills: [] },
    "the session's newest set wins",
  );
});

test("malformed applied records in a log are ignored, never folded into a set", async () => {
  const store = await EventStore.open(await tmpDir("connections-hostile-"));
  const threadId = await store.createThread();
  const applied = (payload: unknown) => ({
    type: EventKind.Custom,
    event_type: CustomEvent.ToolRegistryApplied,
    payload,
  });
  await service(store).recordDelivered(threadId, "claude-code", "ses", BLENDER);
  await store.appendEvents(threadId, [
    applied({ engine: "claude-code", session: "ses", plugins: "blender" }),
    applied({ engine: "claude-code", session: "ses", plugins: [7], skills: [] }),
    applied({ engine: "claude-code", session: "ses", plugins: [], skills: [null] }),
    applied({ engine: "claude-code", plugins: [], skills: [] }),
    applied({ engine: "claude-code", session: 7, plugins: [], skills: [] }),
    applied({ engine: 42, session: "ses", plugins: [], skills: [] }),
    applied({ engine: "__proto__", session: "__proto__", plugins: ["x"], skills: [] }),
    applied(null),
  ] as never);
  const reader = service(store);
  assert.deepEqual(await reader.lastApplied(threadId, "claude-code", "ses"), BLENDER);
  // An engine or session name is only a key: `__proto__` is kept as a name like any other and reaches no prototype.
  assert.deepEqual(await reader.lastApplied(threadId, "__proto__", "__proto__"), { plugins: ["x"], skills: [] });
  assert.equal(await reader.lastApplied(threadId, "toString", "ses"), undefined);
  assert.equal(await reader.lastApplied(threadId, "codex", "ses"), undefined);
});

/** The sentence that hands builders the Studio template's vendored Three.js: a browser game's capability only. */
const TEMPLATE_THREE = /This project uses the Studio template: Three\.js/;

test("a C++ · raylib game's planning text offers no Three.js template capability; a template game's does", async () => {
  const base = await tmpDir("connections-games-");
  const games = new GameWorkspaces({
    root: path.join(base, "library"),
    templateDir: path.resolve(import.meta.dirname, "../../src/game-template"),
    vendorDir: path.join(base, "vendor"),
    indexFile: path.join(base, "projects.json"),
    userData: path.join(base, "userData"),
    homeDir: base,
  });
  await games.scaffold("arena");
  // A C++ game as the studio writes one: CMake through genex_add_game, and its studio.json.
  const pong = path.join(base, "library", "pong");
  await mkdir(path.join(pong, "src"), { recursive: true });
  await writeFile(path.join(pong, "CMakeLists.txt"), "project(game CXX C)\ngenex_add_game(SOURCES src/*.cpp)\n");
  await writeFile(path.join(pong, "src", "main.cpp"), "int main() { studio::install({}); }\n");
  await writeFile(
    path.join(pong, "studio.json"),
    JSON.stringify({
      name: "pong",
      title: "Pong",
      contractVersion: 1,
      stack: GameStack.RaylibCpp,
      targets: [BuildTarget.Web, BuildTarget.Mac],
      entry: "index.html",
      main: "src/main.cpp",
      build: null,
      own: false,
      kind: ProjectKind.RaylibCpp,
      serve: ".",
      native: { lock: null },
    }),
  );
  const store = await EventStore.open(await tmpDir("connections-store-"));
  const threadId = await store.createThread();
  const core = {
    games,
    store,
    mcp: { list: async () => [], planningToolNames: () => [] },
    plugins: { list: () => [], accountState: async () => undefined },
    append: async () => "",
    emit: () => {},
  } as unknown as ConnectionsCore;
  const connections = new ConnectionService(core, () => false);
  const facts = (project: string) => connections.capabilityFacts(threadId, project, CapabilityAudience.Planning);
  assert.match((await facts("arena")).text, TEMPLATE_THREE);
  assert.doesNotMatch((await facts("pong")).text, TEMPLATE_THREE);
});

/**
 * Skills that name `stacks` serve only those games. The two Genex cards for Three.js are the
 * bundled case: a C++ · raylib game's builders, its planning and its conversation are never handed
 * them, and never the sentence about the Studio template's vendored Three.js either. A skill that
 * names no stack serves every game.
 */
const THREE_ONLY_SKILL = /genex-threejs-|three-card|three-tip/;
const VENDOR_SENTENCE = /\/vendor\//;

/** A registry holding the example plugin on API 3 with a skill for each case: Three.js only, C++ only, both. */
async function stackedRegistry(): Promise<{ registry: PluginRegistry; game: string }> {
  const root = await tmpDir("connections-stacks-");
  const seeds = path.join(root, "seeds");
  const dir = path.join(seeds, "cards");
  await cp(EXAMPLE_PLUGIN, dir, { recursive: true });
  await mkdir(path.join(dir, "skills"), { recursive: true });
  await writeFile(path.join(dir, "skills", "three.md"), "# Three\n\nFor a Three.js page.\n");
  await writeFile(path.join(dir, "skills", "cpp.md"), "# C++\n\nFor a raylib game.\n");
  const manifest = JSON.parse(await readFile(path.join(dir, "plugin.json"), "utf8"));
  manifest.id = "cards";
  manifest.apiVersion = 3;
  manifest.skills = [
    { name: "everyone", text: "For every game." },
    { name: "three-tip", text: "Only for a Three.js page.", stacks: [GameStack.ThreeJs] },
    { name: "three-card", summary: "A Three.js card.", file: "skills/three.md", stacks: [GameStack.ThreeJs] },
    { name: "cpp-card", summary: "A C++ card.", file: "skills/cpp.md", stacks: [GameStack.RaylibCpp] },
  ];
  await writeFile(path.join(dir, "plugin.json"), JSON.stringify(manifest));
  const registry = new PluginRegistry(path.join(root, "installed"), seeds, PLUGIN_SDK_BACKEND, async () => ({}));
  await registry.init();
  after(() => registry.cancel());
  const game = path.join(root, "game");
  await mkdir(game);
  return { registry, game };
}

test("the registry hands a skill only to the stacks it names, and one that names none to every stack", async () => {
  const { registry, game } = await stackedRegistry();
  const cpp = registry.snapshot([], undefined, GameStack.RaylibCpp);
  const three = registry.snapshot([], undefined, GameStack.ThreeJs);
  const unknown = registry.snapshot();
  const skillTool = (snapshot: typeof cpp) => snapshot.tools.find((t) => t.name === "cards__skill")?.description ?? "";
  assert.doesNotMatch(cpp.guidance, THREE_ONLY_SKILL, "a C++ game's brief");
  assert.doesNotMatch(skillTool(cpp), THREE_ONLY_SKILL, "and its skill tool");
  assert.deepEqual(cpp.applied.skills, ["cards/everyone", "cards/cpp-card"], "and what it is recorded as handed");
  assert.match(cpp.guidance, /\[cards\/everyone\]/, "a skill without stacks reaches C++");
  assert.match(three.guidance, /\[cards\/everyone\]/, "and Three.js");
  assert.match(three.guidance, /\[cards\/three-tip\]/);
  assert.match(skillTool(three), /three-card/);
  assert.doesNotMatch(three.guidance, /cpp-card/, "a C++ card is withheld from a Three.js game");
  assert.match(unknown.guidance, /three-tip/, "no stack named: every skill, as before");
  // Asked by name anyway, a withheld card is refused to a C++ game's call and read for a Three.js one.
  const binding = { project: "game", directory: game };
  await assert.rejects(
    registry.tool("cards__skill", { name: "three-card" }, { ...binding, stack: GameStack.RaylibCpp }),
    /three-card/,
  );
  const page = (await registry.tool("cards__skill", { name: "three-card" }, binding)) as { text: string };
  assert.match(page.text, /For a Three\.js page/);
});

test("a call that names no stack is answered for the game its folder is: a C++ folder's call is refused the Three.js card", async () => {
  const { registry } = await stackedRegistry();
  const base = await tmpDir("connections-folder-stack-");
  const games = new GameWorkspaces({
    root: path.join(base, "library"),
    templateDir: path.resolve(import.meta.dirname, "../../src/game-template"),
    vendorDir: path.join(base, "vendor"),
    indexFile: path.join(base, "projects.json"),
    userData: path.join(base, "userData"),
    homeDir: base,
  });
  await twoStacks(games);
  const bound = (project: string) => ({ project, directory: games.dirFor(project) });
  await assert.rejects(
    registry.tool("cards__skill", { name: "three-card" }, bound("pong")),
    /not for this game's stack/,
  );
  const page = (await registry.tool("cards__skill", { name: "three-card" }, bound("arena"))) as { text: string };
  assert.match(page.text, /For a Three\.js page/, "a Three.js folder still reads it");
  const cpp = (await registry.tool("cards__skill", { name: "cpp-card" }, bound("pong"))) as { text: string };
  assert.match(cpp.text, /For a raylib game/, "and a C++ folder its own card");
});

/** The bundled Genex plugin as the planner sees it: enabled, its own manifest. */
async function genexInfo(): Promise<PluginInfo> {
  const manifest = validateManifest(JSON.parse(await readFile("src/plugins/genex/plugin.json", "utf8")));
  return { manifest, enabled: true, removed: false } as unknown as PluginInfo;
}

/** A C++ · raylib game and a Three.js template game in one library, scaffolded the way the studio does. */
async function twoStacks(games: GameWorkspaces): Promise<void> {
  await games.scaffold("arena");
  await games.scaffold("pong", {
    stack: GameStack.RaylibCpp,
    caller: ScaffoldCaller.Internal,
    targets: [BuildTarget.Web, BuildTarget.Mac],
  });
}

test("a C++ · raylib game's planning and conversation facts hand no Three.js card and no /vendor/ sentence", async () => {
  const base = await tmpDir("connections-genex-");
  const games = new GameWorkspaces({
    root: path.join(base, "library"),
    templateDir: path.resolve(import.meta.dirname, "../../src/game-template"),
    vendorDir: path.join(base, "vendor"),
    indexFile: path.join(base, "projects.json"),
    userData: path.join(base, "userData"),
    homeDir: base,
  });
  await twoStacks(games);
  const store = await EventStore.open(await tmpDir("connections-genex-store-"));
  const threadId = await store.createThread();
  const genex = await genexInfo();
  const core = {
    games,
    store,
    mcp: { list: async () => [], planningToolNames: () => [] },
    plugins: { list: () => [genex], accountState: async () => undefined },
    append: async () => "",
    emit: () => {},
  } as unknown as ConnectionsCore;
  const connections = new ConnectionService(core, () => false);
  for (const audience of Object.values(CapabilityAudience)) {
    const facts = async (project: string) => (await connections.capabilityFacts(threadId, project, audience)).text;
    const cpp = await facts("pong");
    assert.doesNotMatch(cpp, THREE_ONLY_SKILL, `${audience}: no Three.js card for C++`);
    assert.doesNotMatch(cpp, VENDOR_SENTENCE, `${audience}: no vendored Three.js for C++`);
    assert.match(cpp, /genex-tool-publish/, `${audience}: a card for every stack still reaches it`);
    const three = await facts("arena");
    assert.match(three, THREE_ONLY_SKILL, `${audience}: a Three.js game still gets its cards`);
    assert.match(three, VENDOR_SENTENCE, `${audience}: and the template sentence`);
  }
});

/** A delegated engine that records each request it is handed and answers at once. */
function recordingEngine(seen: DelegateRequest[]) {
  return {
    id: "claude-code",
    label: "fixture",
    kind: "delegated",
    supportsSessions: true,
    status: async () => ({ code: "ready", detail: "fixture" }),
    models: async () => [],
    delegate: async (request: DelegateRequest): Promise<DelegateResult> => {
      seen.push(request);
      return { ok: true, engine: "claude-code", sessionId: "s", turns: 1, usage: {}, summary: "" };
    },
  };
}

const lites: CoreLite[] = [];
after(async () => {
  for (const lite of lites) await lite.close();
});

/** A harness method of a core, called as the harness calls it; a method the core lacks fails the row. */
function harnessCall(core: StudioCore): (method: string, params: Record<string, unknown>) => Promise<unknown> {
  const api = core.api() as unknown as Record<
    string,
    ((params: Record<string, unknown>) => Promise<unknown>) | undefined
  >;
  return (method, params) => {
    const answer = api[method];
    assert.ok(answer, `the core answers ${method}`);
    return answer(params);
  };
}

/** The request the recording engine was handed last. */
function lastRequest(seen: readonly DelegateRequest[]): DelegateRequest {
  const request = seen.at(-1);
  assert.ok(request, "the engine was handed a request");
  return request;
}

/**
 * A copy of the example plugin whose backend answers every tool with the stack its context names:
 * what a plugin reads to pick formats raylib loads (`PluginContext.stack`).
 */
async function stackEchoPlugin(): Promise<string> {
  const dir = path.join(await tmpDir("connections-stack-echo-"), "stackecho");
  await cp(EXAMPLE_PLUGIN, dir, { recursive: true });
  const manifest = JSON.parse(await readFile(path.join(dir, "plugin.json"), "utf8"));
  manifest.id = "stackecho";
  manifest.capabilities = [];
  manifest.settings = [];
  manifest.panels = [];
  delete manifest.toolbar;
  await writeFile(path.join(dir, "plugin.json"), JSON.stringify(manifest));
  await writeFile(
    path.join(dir, "backend.mjs"),
    "export async function activate() {\n  return { async tool(_name, _args, ctx) { return { stack: ctx.stack ?? null }; }, async action() { return {}; } };\n}\n",
  );
  return dir;
}

/**
 * A core whose games root is a real path: the local harness's binding checks the project's own path
 * against its realpath, and the system's temporary folder is a link on a Mac.
 */
async function realRootCore(): Promise<CoreLite> {
  const lite = await coreLite({ gamesRoot: await realpath(await tmpDir("connections-games-")) });
  lites.push(lite);
  return lite;
}

test("a plugin's backend is told the bound game's stack on a builder's call", async () => {
  const { core } = await realRootCore();
  await twoStacks(core.games);
  // A plugin loaded from a folder starts off and asks before each tool runs: the person turns it
  // on and allows each call.
  await installLocalOn(core.plugins, await stackEchoPlugin(), []);
  personAllowsLocalTools(core.plugins);
  // The echo's backend is a child process of its own: it ends with the test, not with the core.
  after(() => core.plugins.cancel());
  const heard: Array<{ project: string; answer: unknown }> = [];
  core.engines.register({
    ...recordingEngine([]),
    delegate: async (request: DelegateRequest): Promise<DelegateResult> => {
      const project = path.basename(request.cwd);
      heard.push({ project, answer: await request.onLiveTool?.("stackecho__greet", { name: "x" }) });
      return { ok: true, engine: "claude-code", sessionId: "s", turns: 1, usage: {}, summary: "" };
    },
  } as never);
  const call = harnessCall(core);
  for (const [project, stack] of [
    ["pong", GameStack.RaylibCpp],
    ["arena", GameStack.ThreeJs],
  ] as const) {
    const threadId = await core.threadForGame(project);
    await call("engine.delegate", { engine: "claude-code", prompt: "go", project, threadId });
    assert.equal(heard.at(-1)?.answer, JSON.stringify({ stack }), `${project}: a builder's call`);
  }
});

test("the local harness's skill tool refuses a C++ game the Three.js card and reads it for a Three.js game", async () => {
  const { core } = await realRootCore();
  await twoStacks(core.games);
  const call = harnessCall(core);
  const read = (project: string) =>
    call("plugins.invoke", { project, name: "genex__skill", args: { name: "genex-threejs-multiplayer" } });
  await assert.rejects(read("pong"), /not for this game's stack/);
  const page = (await read("arena")) as { text: string };
  assert.ok(page.text.length > 0, "a Three.js game reads the card");
});

test("a C++ · raylib game's builder is handed no Three.js card; a Three.js game's builder still is", async () => {
  const lite = await coreLite();
  lites.push(lite);
  const { core } = lite;
  const seen: DelegateRequest[] = [];
  core.engines.register(recordingEngine(seen) as never);
  await twoStacks(core.games);
  const call = harnessCall(core);
  const briefFor = async (project: string) => {
    const threadId = await core.threadForGame(project);
    await call("engine.delegate", { engine: "claude-code", prompt: "go", project, threadId });
    const request = lastRequest(seen);
    const skillTool = (request.liveTools ?? []).find((tool) => tool.name === "genex__skill");
    return { prompt: request.prompt, skillTool: skillTool?.description ?? "" };
  };
  const cpp = await briefFor("pong");
  assert.doesNotMatch(cpp.prompt, THREE_ONLY_SKILL, "the C++ builder's brief");
  assert.doesNotMatch(cpp.skillTool, THREE_ONLY_SKILL, "and the skill tool it is handed");
  assert.match(cpp.prompt, /\[genex\/genex-tool-publish\]/, "a card without stacks still reaches it");
  const three = await briefFor("arena");
  assert.match(three.prompt, /\[genex\/genex-threejs-multiplayer\]/, "the Three.js builder keeps its cards");
  assert.match(three.skillTool, /genex-threejs-embed-auth/);
});
