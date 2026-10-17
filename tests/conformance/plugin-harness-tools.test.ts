/**
 * A plugin tool only Genex's harness calls (`tools[].audience: "harness"`, API 3), such as the
 * Unreal Loop runner's editor-queue steps. No agent is handed it: not a chat's or a builder's
 * delegated session, not the local harness's tool registry, not the capability facts a plan or a
 * chat reads, not the composer's tool count. An agent that names it anyway is refused, and the
 * harness's own `plugins.invoke` step (`step: true`) still reaches it. The field is typed, checked where a
 * manifest is parsed, and refused in any other shape.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { UnrealLivePluginTool, UnrealLoopTool } from "../../src/harness-seed/loop/unreal/live-contract.ts";
import { MotionToolName } from "../../src/plugins/unreal/motion-tools.ts";
import { type PluginManifest, PluginToolAudience } from "../../src/shared/plugins.ts";
import type { DelegateRequest } from "../../src/substrate/engines/types.ts";
import { validateManifest } from "../../src/substrate/plugins/manifest.ts";
import { PluginRegistry } from "../../src/substrate/plugins/registry.ts";
import { coreLite } from "../helpers/core-lite.ts";
import { copyOfExample, EXAMPLE_PLUGIN, PLUGIN_SDK_BACKEND } from "../helpers/plugins.ts";
import { tmpDir } from "../helpers/tmp.ts";

// biome-ignore lint/suspicious/noExplicitAny: a hostile manifest is any shape a writer may send.
type RawManifest = any;

const exampleManifest: RawManifest = JSON.parse(await readFile(path.join(EXAMPLE_PLUGIN, "plugin.json"), "utf8"));

/** The example manifest on `apiVersion` with its `shout` tool given `fields`. */
function withShout(fields: Record<string, unknown>, apiVersion = 3): RawManifest {
  const manifest = structuredClone(exampleManifest);
  manifest.apiVersion = apiVersion;
  manifest.tools = manifest.tools.map((t: { name: string }) => (t.name === "shout" ? { ...t, ...fields } : t));
  return manifest;
}
const shoutOf = (m: PluginManifest) => m.tools.find((t) => t.name === "shout");

test("a tool may say only the harness calls it, on API 3; agents is the default and never written", () => {
  assert.equal(shoutOf(validateManifest(withShout({ audience: PluginToolAudience.Harness })))?.audience, "harness");
  const agents = validateManifest(withShout({ audience: PluginToolAudience.Agents }));
  assert.equal(Object.hasOwn(shoutOf(agents) ?? {}, "audience"), false, "the default is not written");
  assert.deepEqual(agents, validateManifest(withShout({})), "naming the default changes nothing");
});

test("a tool whose audience is anything else is refused, and so is the field below API 3", () => {
  const hostile: unknown[] = [
    "Harness",
    "HARNESS",
    "harness ",
    "",
    "agent",
    "builders",
    "chat",
    true,
    false,
    0,
    1,
    null,
    [],
    [PluginToolAudience.Harness],
    { harness: true },
  ];
  for (const audience of hostile)
    assert.throws(() => validateManifest(withShout({ audience })), /audience/, JSON.stringify(audience));
  for (const audience of Object.values(PluginToolAudience))
    assert.throws(() => validateManifest(withShout({ audience }, 2)), /apiVersion 3/, `API 2: ${audience}`);
});

/** A registry whose only plugin is the example on API 3, its `shout` for the harness only. */
async function harnessShoutRegistry() {
  const root = await tmpDir("studio-harness-tools-");
  const seeds = path.join(root, "seeds");
  await mkdir(seeds);
  await copyOfExample(seeds, "example", (m) => {
    Object.assign(m, withShout({ audience: PluginToolAudience.Harness }));
  });
  const registry = new PluginRegistry(path.join(root, "installed"), seeds, PLUGIN_SDK_BACKEND, async () => null);
  await registry.init();
  return { registry, binding: { project: "game", directory: root } };
}

test("the registry hands agents every tool but a harness one, and still runs that one by name", async () => {
  const { registry, binding } = await harnessShoutRegistry();
  try {
    const names = registry.snapshot().tools.map((t) => t.name);
    assert.deepEqual(names, ["example__greet"]);
    assert.deepEqual(
      registry.tools().map((t) => t.name),
      names,
    );
    const harness = PluginToolAudience.Harness;
    await assert.rejects(
      registry.tool("example__shout", { text: "hi" }, binding, undefined, harness),
      /consent/,
      "its confirmation stays",
    );
    registry.consent = async () => ({ approved: true, by: "user" });
    assert.deepEqual(await registry.tool("example__shout", { text: "hi" }, binding, undefined, harness), {
      text: "HI",
      project: "game",
    });
  } finally {
    registry.cancel();
  }
});

/** The Unreal plugin's tools an agent is handed in any game: the chat's. */
const AGENT_TOOLS = ["unreal__use-project", "unreal__show-steps", "unreal__new-game", "unreal__new-plugin"];
/** And, once the game holds an Unreal project, a builder's gate and lookups besides, and its C++ module's tools. */
const UNREAL_PROJECT_TOOLS = [
  ...AGENT_TOOLS,
  UnrealLoopTool.BlueprintGuide,
  UnrealLoopTool.FindNodes,
  UnrealLoopTool.CheckPart,
  UnrealLoopTool.CppStatus,
  UnrealLoopTool.AddCppModule,
  `unreal__${MotionToolName.Status}`,
  `unreal__${MotionToolName.Add}`,
];
/** The steps only the Unreal Loop's runner and the live builder's checkpoint take, through the harness's own plugin calls. */
const RUNNER_TOOLS = [
  UnrealLoopTool.RunPart,
  UnrealLoopTool.PartResult,
  UnrealLoopTool.RollbackPart,
  UnrealLoopTool.ReloadLevel,
  UnrealLoopTool.ExportReference,
  UnrealLoopTool.ReopenEditor,
  UnrealLoopTool.EditorState,
  ...Object.values(UnrealLivePluginTool),
];

test("the Unreal plugin's runner-only tools reach no chat, builder, plan or count, its editor tools only an Unreal project's; the harness still runs them", async (t) => {
  const { core, close } = await coreLite();
  // A core that was only initialized stops nothing of its own: the plugin's backend and its
  // editor bridge go here.
  t.after(async () => {
    core.plugins.cancel();
    await core.mcp.close().catch(() => {});
    await close();
  });
  await core.plugins.setEnabled("unreal", true);
  const project = "dirt-track";
  await core.games.scaffold(project);
  const threadId = await core.createGameThread(project);
  const sessions: Array<{ tools: string[]; refused: string[] }> = [];
  core.engines.register({
    id: "claude-code",
    label: "fixture",
    kind: "delegated",
    status: async () => ({ code: "ready", detail: "fixture" }),
    models: async () => [],
    delegate: async (request: DelegateRequest) => {
      const tools = (request.liveTools ?? []).map((t) => t.name).filter((name) => name.startsWith("unreal__"));
      const refused: string[] = [];
      for (const name of RUNNER_TOOLS)
        await request.onLiveTool?.(name, { part: "Core", id: "x" }).catch((e: Error) => refused.push(e.message));
      sessions.push({ tools, refused });
      return { ok: true, engine: "claude-code", summary: "fixture", turns: 1, usage: {} };
    },
  } as never);
  const api = core.api() as unknown as Record<string, (input: unknown) => Promise<unknown>>;
  const delegate = (extra: Record<string, unknown>) =>
    api["engine.delegate"]?.({ engine: "claude-code", project, threadId, prompt: "Build the bike", ...extra });
  await delegate({});
  const worktree = path.join(core.layout.scratch, "worktrees", `${project}-core`);
  await mkdir(worktree, { recursive: true });
  await delegate({ cwd: worktree });
  assert.equal(sessions.length, 2);
  for (const [who, session] of [
    ["the chat", sessions[0]],
    ["a builder", sessions[1]],
  ] as const) {
    assert.deepEqual(session?.tools.sort(), [...AGENT_TOOLS].sort(), who);
    assert.deepEqual(
      session?.refused,
      RUNNER_TOOLS.map((name) => `Unknown tool: ${name}`),
      `${who}: naming a runner tool anyway is refused`,
    );
  }

  /** The Unreal tools the local harness's agents get, for `params`. */
  const localTools = async (params: unknown) => {
    const local = (await api["plugins.tools"]?.(params)) as { tools: Array<{ name: string }> };
    return local.tools.map((t) => t.name).filter((name) => name.startsWith("unreal__"));
  };
  assert.deepEqual((await localTools({ project })).sort(), [...AGENT_TOOLS].sort(), "the local harness's agents");
  assert.deepEqual((await localTools(undefined)).sort(), [...AGENT_TOOLS].sort(), "no game named: a web game's");

  const facts = String(await api["capabilities.describe"]?.({ threadId, project }));
  for (const name of AGENT_TOOLS) assert.ok(facts.includes(name), `the facts name ${name}`);
  for (const name of [...RUNNER_TOOLS, ...UNREAL_PROJECT_TOOLS.slice(AGENT_TOOLS.length)])
    assert.ok(!facts.includes(name), `a web game's facts never name ${name}`);

  const source = (await core.connectionSnapshot(threadId, project)).sources.find((s) => s.id === "unreal");
  assert.equal(source?.tools, AGENT_TOOLS.length, "the composer counts the tools agents get");

  // Once the game holds an Unreal project, its sessions get the builder's gate and lookups too.
  await writeFile(path.join(core.games.dirFor(project), "DirtTrack.uproject"), "{}");
  await delegate({});
  assert.deepEqual(sessions.at(-1)?.tools.sort(), [...UNREAL_PROJECT_TOOLS].sort(), "the chat of an Unreal project");
  assert.deepEqual((await localTools({ project })).sort(), [...UNREAL_PROJECT_TOOLS].sort());
  const unrealFacts = String(await api["capabilities.describe"]?.({ threadId, project }));
  for (const name of UNREAL_PROJECT_TOOLS) assert.ok(unrealFacts.includes(name), `the facts name ${name}`);
  for (const name of RUNNER_TOOLS) assert.ok(!unrealFacts.includes(name), `the facts never name ${name}`);
  const counted = (await core.connectionSnapshot(threadId, project)).sources.find((s) => s.id === "unreal");
  assert.equal(counted?.tools, UNREAL_PROJECT_TOOLS.length);
  await rm(path.join(core.games.dirFor(project), "DirtTrack.uproject"));

  // The runner's own path, as its own step: the call reaches run-part's handler, which refuses a
  // name that isn't a part. The same call without `step` is an agent's, and refused before it.
  const step = { project, threadId, step: true };
  await assert.rejects(
    api["plugins.invoke"]?.({ ...step, name: UnrealLoopTool.RunPart, args: { part: "../x" } }) ?? Promise.resolve(),
    /not a part name/,
  );
  await assert.rejects(
    api["plugins.invoke"]?.({ project, threadId, name: UnrealLoopTool.RunPart, args: { part: "../x" } }) ??
      Promise.resolve(),
    /Unknown tool: unreal__run-part/,
  );
  // add-cpp-module's handler is reached too, once the person confirms it (it saves and restarts
  // their editor, whoever asks): a game with no Unreal project has no module to add.
  const asked: string[] = [];
  core.plugins.consent = async (_id, declaration) => {
    asked.push(declaration.name);
    return { approved: true, by: "user" };
  };
  await assert.rejects(
    api["plugins.invoke"]?.({ ...step, name: UnrealLoopTool.AddCppModule, args: {} }) ?? Promise.resolve(),
    /isn't linked to an Unreal project/,
  );
  assert.deepEqual(asked, ["add-cpp-module"], "the person was asked first");
  // So are reopen-editor's and editor-state's: there is no Unreal to reopen, and none answers.
  await assert.rejects(
    api["plugins.invoke"]?.({ ...step, name: UnrealLoopTool.ReopenEditor, args: {} }) ?? Promise.resolve(),
    /isn't linked to an Unreal project/,
  );
  assert.deepEqual(await api["plugins.invoke"]?.({ ...step, name: UnrealLoopTool.EditorState, args: {} }), {
    answering: false,
    running: null,
    reopening: { state: "idle" },
    helper: null,
  });
  // The live builder's tools reach their handlers too: each needs a game linked to an Unreal project.
  for (const name of [
    UnrealLivePluginTool.LogErrors,
    UnrealLivePluginTool.EndEditor,
    UnrealLivePluginTool.UpdateHelper,
  ])
    await assert.rejects(
      api["plugins.invoke"]?.({ ...step, name, args: {} }) ?? Promise.resolve(),
      /isn't linked to an Unreal project/,
      name,
    );
  await assert.rejects(
    api["plugins.invoke"]?.({
      ...step,
      name: UnrealLivePluginTool.PlayCheck,
      args: { checks: { "feature:track:0": { tag: "terrain", exists: true } } },
    }) ?? Promise.resolve(),
    /queued nothing/,
  );
});
