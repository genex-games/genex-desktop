import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type {
  PluginActivation,
  PluginContext,
  PluginHookContext,
  PluginManifest,
} from "../../src/plugin-sdk/index.d.ts";
import { createUnityBackend, systemBackendDeps, UnityAction, UnityTool } from "../../src/plugins/unity/backend.ts";
import { rememberedProject } from "../../src/plugins/unity/project-folder.ts";
import { HookEvent, LockScope } from "../../src/shared/plugin-hooks.ts";
import {
  CORE_FACT_RULES,
  CoreFact,
  FactSource,
  type FactRef,
  factsOfFiles,
  pluginFactSource,
} from "../../src/shared/project-facts.ts";
import { kindKey, pluginWebBuilds } from "../../src/harness-seed/loop/web-build.ts";
import { ENGINE_PLAY_TOOLS } from "../../src/shared/engine-play.ts";
import { validateManifest } from "../../src/substrate/plugins/manifest.ts";
import { PluginRegistry } from "../../src/substrate/plugins/registry.ts";
import { coreLite } from "../helpers/core-lite.ts";
import { makeResources } from "../helpers/resources.ts";
import { tmpDir } from "../helpers/tmp.ts";
import { unityProject } from "../helpers/unity-editor-stand-in.ts";

const NOW = () => new Date("2026-10-13T10:00:00.000Z");
const UNITY_GAME: FactRef[] = [{ id: CoreFact.UnityProject, path: "." }];
const WEB_GAME: FactRef[] = [{ id: CoreFact.WebGame, path: "." }];
const SKILL = "unity/unity-editor";

const bundledManifest = () =>
  validateManifest(JSON.parse(readFileSync("src/plugins/unity/plugin.json", "utf8")) as PluginManifest);

/** A call's binding as the host hands it over: the game, its folder and the plugin's storage. */
function contextFor(
  storage: string,
  binding: { project?: string; directory?: string; hook?: PluginHookContext } = {},
): PluginContext {
  return {
    ...binding,
    signal: new AbortController().signal,
    callId: 1,
    host: (async (method: string) => {
      assert.equal(method, "storage.root");
      return storage;
    }) as PluginContext["host"],
  };
}

const findProject = (backend: PluginActivation, context: PluginContext) =>
  backend.tool?.(UnityTool.FindProject, {}, context);

/** The backend on this computer's own editors and network, which `find-project` never reaches, on the test's clock. */
const backendAt = (now: () => Date) => createUnityBackend({ ...systemBackendDeps(), now });

describe("the bundled Unity plugin", () => {
  it("has a valid manifest whose connector and skill reach only games holding a Unity project", () => {
    const unity = bundledManifest();
    assert.equal(unity.id, "unity");
    assert.equal(unity.apiVersion, 3);
    // An engine plugin: its page reads the editor's own state, and it may show its setup card in a chat.
    assert.deepEqual(unity.capabilities, ["game-engine"]);
    const editor = unity.mcpServers?.find((server) => server.id === "editor");
    assert.deepEqual(editor?.facts, [CoreFact.UnityProject]);
    assert.deepEqual(editor?.needs, ["editor"]);
    assert.deepEqual(editor?.args, ["editor-mcp.mjs"]);
    assert.deepEqual(editor?.reads, ["list_commands", "describe_command"]);
    assert.equal(editor?.maxTools, 3);
    assert.deepEqual(unity.locks, [
      { id: "editor", label: "Unity", per: LockScope.Project, personFirst: UnityTool.EditorActivity },
    ]);
    assert.deepEqual(
      unity.skills.map((skill) => [skill.name, skill.facts]),
      [
        ["unity-multiplayer", [CoreFact.UnityProject]],
        ["unity-editor", [CoreFact.UnityProject]],
      ],
    );
    const tool = (name: string) => unity.tools.find((declared) => declared.name === name);
    assert.equal(tool(UnityTool.FindProject)?.audience, "harness", "only Genex runs it");
    assert.equal(tool(UnityTool.FindProject)?.needs, undefined, "finding the project waits for no editor");
    assert.equal(tool(UnityTool.EngineStatus)?.audience, "harness");
    assert.deepEqual(tool(UnityTool.NewGame)?.makes, [CoreFact.UnityProject]);
    assert.equal(tool(UnityTool.NewGame)?.ready, UnityTool.EngineStatus);
    assert.equal(tool(UnityTool.NewGame)?.facts, undefined, "any game may be made a Unity game");
    for (const name of [UnityTool.Setup, UnityTool.UndoSetup]) {
      assert.ok(tool(name)?.confirmation, `${name} changes the person's project, so they confirm it`);
      assert.deepEqual(tool(name)?.facts, [CoreFact.UnityProject]);
    }
    assert.equal(tool(UnityTool.OpenEditor)?.confirmation, undefined);
    assert.deepEqual(unity.scaffolds, [{ id: "game", label: "Unity game", tool: UnityTool.NewGame }]);
    assert.deepEqual(
      unity.hooks?.map((hook) => [hook.on, hook.tool]),
      [
        [HookEvent.TurnStart, UnityTool.FindProject],
        [HookEvent.RunPrepare, UnityTool.FindProject],
        [HookEvent.RunPrepare, UnityTool.OpenForRun],
        [HookEvent.RunEnd, UnityTool.AfterRun],
        [HookEvent.CheckpointBefore, UnityTool.SaveAll],
        [HookEvent.CheckpointAfter, UnityTool.SceneShots],
        [HookEvent.RestoreBefore, UnityTool.SaveAll],
        [HookEvent.RestoreBefore, UnityTool.EndEditor],
        [HookEvent.RestoreAfter, UnityTool.ReopenEditor],
        [HookEvent.Health, UnityTool.EditorState],
        [HookEvent.Crash, UnityTool.ReopenEditor],
      ],
      "a restore saves before it ends the editor, and the project is found before a run opens it",
    );
    for (const hook of unity.hooks ?? []) assert.deepEqual(hook.facts, [CoreFact.UnityProject], hook.tool);
    const needing = unity.tools
      .filter((declared) => declared.needs?.includes("editor"))
      .map((declared) => declared.name);
    assert.deepEqual(
      needing.sort(),
      [
        ...ENGINE_PLAY_TOOLS,
        UnityTool.EndEditor,
        UnityTool.OpenForRun,
        UnityTool.ReopenEditor,
        UnityTool.SaveAll,
        UnityTool.SceneShots,
      ].sort(),
    );
    for (const name of ENGINE_PLAY_TOOLS) {
      assert.equal(tool(name)?.audience, "harness");
      assert.deepEqual(tool(name)?.facts, [CoreFact.UnityProject]);
    }
    assert.equal(tool(UnityTool.EditorActivity)?.needs, undefined, "the probe asks without waiting for its own lock");
    assert.equal(tool(UnityTool.EditorState)?.needs, undefined, "a health check never waits for the editor");
    assert.ok(tool(UnityTool.RestartEditor)?.confirmation, "ending the person's editor is theirs to confirm");
    assert.equal(
      tool(UnityTool.RestartEditor)?.needs,
      undefined,
      "and once they confirm, it never waits for a lock whose probe a stalled editor can't answer",
    );
    assert.deepEqual(unity.observers, [
      { id: "viewport", facts: [CoreFact.UnityProject], tool: UnityTool.SceneShots, live: "stills" },
    ]);
  });

  it("claims its WebGL build in web/ as a build: no new kind, never a web game to edit", () => {
    const rules = [
      ...CORE_FACT_RULES.map((rule) => ({ rule, source: FactSource.Core })),
      ...(bundledManifest().detect ?? []).map((rule) => ({ rule, source: pluginFactSource("unity") })),
    ];
    const project = ["unity/ProjectSettings/ProjectVersion.txt"];
    const built = [...project, "web/index.html", "web/Build/web.loader.js", "web/Build/web.wasm"];
    const facts = factsOfFiles(built, rules);
    assert.deepEqual([...pluginWebBuilds(facts)], ["web"], "web/ is the plugin's build");
    assert.equal(kindKey(facts), kindKey(factsOfFiles(project, rules)), "building for the web keeps the game's kind");
    const site = factsOfFiles([...project, "site/index.html"], rules);
    assert.deepEqual([...pluginWebBuilds(site)], [], "a page with no WebGL build beside it is no build");
  });

  it("gives the person a toolbar button on Unity games only that opens its panel, and declares every action the panel sends", () => {
    const unity = bundledManifest();
    assert.deepEqual(unity.toolbar, [
      {
        id: "editor",
        label: "Unity",
        ariaLabel: "Unity Editor",
        icon: "unity",
        facts: [CoreFact.UnityProject],
        target: { kind: "panel", id: "editor" },
        status: UnityAction.ToolbarStatus,
      },
    ]);
    assert.deepEqual(unity.panels, [{ id: "editor", title: "Unity", file: "panel.html", placement: "settings" }]);
    const action = (name: string) => unity.actions.find((declared) => declared.name === name);
    assert.deepEqual(unity.actions.map((declared) => declared.name).sort(), Object.values(UnityAction).sort());
    for (const looks of [UnityAction.Status, UnityAction.ToolbarStatus]) {
      assert.equal(action(looks)?.confirmation, undefined, `${looks} is asked without the person`);
      assert.equal(action(looks)?.native, undefined, `${looks} only looks, so a fixture profile may ask it`);
    }
    const acting = [
      UnityAction.OpenEditor,
      UnityAction.Setup,
      UnityAction.UndoSetup,
      UnityAction.RestartEditor,
      UnityAction.GetUnity,
    ];
    for (const acts of acting)
      assert.equal(action(acts)?.native, true, `${acts} starts an app or writes in the person's project`);
    for (const asks of [UnityAction.Setup, UnityAction.UndoSetup, UnityAction.RestartEditor])
      assert.ok(action(asks)?.confirmation, `${asks} changes the person's project or ends their editor`);
    assert.match(
      String(action(UnityAction.RestartEditor)?.confirmation),
      /not saved in the editor is lost/,
      "the person is told what a restart costs before they approve it",
    );
  });

  it("keeps the game's Unity project for the connector when Genex runs find-project", async () => {
    const storage = await realpath(await tmpDir("unity-storage-"));
    const backend = backendAt(NOW);
    const game = await realpath(await tmpDir("unity-game-"));
    const root = await unityProject();
    const bound = { project: "lantern", directory: root };

    assert.deepEqual(await findProject(backend, contextFor(storage, bound)), { found: true, folder: "." });
    assert.deepEqual(await rememberedProject(storage, "lantern"), { root, game: root });

    // A game whose folder holds no project any more loses its record: the connector then says so.
    assert.deepEqual(await findProject(backend, contextFor(storage, { project: "lantern", directory: game })), {
      found: false,
    });
    assert.equal(await rememberedProject(storage, "lantern"), undefined);
  });

  it("answers a turn's start with nothing that could hold the turn, whatever it finds", async () => {
    const storage = await realpath(await tmpDir("unity-storage-"));
    const backend = backendAt(NOW);
    const hook = { on: HookEvent.TurnStart } as PluginHookContext;
    const root = await unityProject();
    const answers = [
      await findProject(backend, contextFor(storage, { project: "lantern", directory: root, hook })),
      await findProject(backend, contextFor(storage, { project: "lantern", directory: path.join(root, "gone"), hook })),
      await findProject(backend, contextFor(storage, { hook })),
      await findProject(backend, contextFor(storage, { project: "../escape", directory: root, hook })),
      await findProject(
        backend,
        contextFor(path.join(root, "ProjectSettings", "ProjectVersion.txt"), {
          project: "lantern",
          directory: root,
          hook,
        }),
      ),
    ];
    for (const answer of answers) {
      assert.ok(answer && typeof answer === "object");
      assert.equal("block" in answer, false, JSON.stringify(answer));
      assert.equal("pending" in answer, false, JSON.stringify(answer));
    }
    assert.match(String((answers[4] as { note?: string }).note), /could not keep this game's Unity project/);
  });

  it("refuses a tool or an action it does not have", async () => {
    const backend = backendAt(NOW);
    const context = contextFor(await tmpDir("unity-storage-"));
    await assert.rejects(async () => backend.tool?.("quit-editor", {}, context), /Unknown Unity tool quit-editor/);
    await assert.rejects(async () => backend.action?.("create", {}, context), /Unknown Unity action create/);
  });

  it("is off in a new profile until the person turns it on, and shows Unity's own picture", async () => {
    const lite = await coreLite({ resources: await makeResources({ tsc: false }) });
    try {
      const listed = lite.core.plugins.list().find((plugin) => plugin.manifest.id === "unity");
      assert.equal(listed?.source, "bundled");
      assert.equal(lite.core.plugins.enabled("unity"), false);
      assert.equal(listed?.manifest.icon, "icon.svg");
      assert.ok(listed?.iconUrl, "the list, the + menu and the @ picker draw its picture, not its initial");
    } finally {
      await lite.close();
    }
  });

  it("ships in the app's resources and reaches a Unity project's sessions, never a web game's", async () => {
    const resources = await makeResources({ tsc: false });
    const seed = path.join(resources, "plugins", "unity");
    for (const file of ["plugin.json", "icon.svg", "backend.mjs", "editor-mcp.mjs", "panel.html"])
      assert.ok(existsSync(path.join(seed, file)), `${file} is built`);
    const panel = readFileSync(path.join(seed, "panel.html"), "utf8");
    assert.match(panel, /window\.studioPlugin = \{/, "the panel carries the SDK it calls Genex through");
    assert.match(panel, /@font-face/, "and Genex's type, which a panel can load from nowhere else");
    assert.doesNotMatch(panel, /STUDIO_PANEL_(SDK|FONTS)/, "with neither placeholder left in it");
    const built = (await import(pathToFileURL(path.join(seed, "backend.mjs")).href)) as {
      activate: () => PluginActivation;
    };
    const storage = await realpath(await tmpDir("unity-storage-"));
    assert.deepEqual(await findProject(built.activate(), contextFor(storage)), { found: false });

    const registry = new PluginRegistry(
      path.join(await tmpDir("unity-installed-"), "installed"),
      path.join(resources, "plugins"),
      path.join(resources, "plugin-sdk", "backend.mjs"),
      async () => null,
    );
    await registry.init();
    try {
      await registry.setEnabled("unity", true);
      assert.ok(registry.snapshot(UNITY_GAME).applied.skills.includes(SKILL), "a Unity project's brief has the skill");
      assert.ok(!registry.snapshot(WEB_GAME).applied.skills.includes(SKILL), "a web game's brief does not");
      assert.ok(!registry.snapshot().applied.skills.includes(SKILL), "a game with no kind yet does not");
      const unityTools = (scope?: FactRef[]) =>
        registry
          .snapshot(scope)
          .tools.map((tool) => tool.name)
          .filter((name) => name.startsWith("unity__"));
      assert.deepEqual(
        unityTools(UNITY_GAME),
        [
          "unity__new-game",
          "unity__show-steps",
          "unity__multiplayer",
          "unity__setup",
          "unity__undo-setup",
          "unity__open-editor",
          "unity__restart-editor",
          // Its file skill (unity-multiplayer) is read through the synthetic skill tool.
          "unity__skill",
        ],
        "a Unity project's sessions get its tools, and none of Genex's own (find-project, save-all, editor-state…)",
      );
      // The setup card goes with making a Unity game: a game is made one only once Unity is installed.
      assert.deepEqual(
        unityTools(WEB_GAME),
        ["unity__new-game", "unity__show-steps"],
        "a web game can only be made a Unity game",
      );
      assert.deepEqual(unityTools(), ["unity__new-game", "unity__show-steps"], "and so can a game with no kind yet");
      const offered = registry.snapshot().kinds.filter((kind) => kind.plugin === "unity");
      assert.deepEqual(
        offered.map((kind) => [kind.label, kind.tool, kind.makes, kind.asksReady]),
        [["Unity game", "unity__new-game", [CoreFact.UnityProject], true]],
        "the new game's question offers Unity by its scaffold's label, asking engine-status first",
      );
    } finally {
      registry.cancel();
    }
  });
});
