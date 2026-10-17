/**
 * Finding a Genex plugin and suggesting it: only installed-but-off plugins and Genex's catalog, and
 * only the person turns one on. The agent's own search (`plugins_find`) never decides anything for
 * the person; `plugins_suggest` shows a card in the chat, whose button is the only way on.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { findPlugins } from "../../src/main/core/plugin-finder.ts";
import {
  PLUGINS_FIND_TOOL,
  PLUGINS_SUGGEST_ANSWER,
  PLUGINS_SUGGEST_TOOL,
} from "../../src/main/core/project-tools-prompts.ts";
import { EntryKind, toEntries } from "../../src/renderer/chat-entries.ts";
import { SuggestionState, suggestionShown, suggestionState } from "../../src/renderer/chat/plugin-suggestion.ts";
import { CustomEvent, type CustomEventName, customEvent, customEventData } from "../../src/shared/custom-events.ts";
import type { EventData, EventEnvelope } from "../../src/shared/event-log.ts";
import { HostMethod } from "../../src/shared/harness-api.ts";
import { PermissionMode } from "../../src/shared/permissions.ts";
import type { PluginCatalogEntry, PluginManifest } from "../../src/shared/plugins.ts";
import { FindNext, PluginOffer, ProjectTool } from "../../src/shared/project-tools.ts";
import type { DelegateRequest } from "../../src/substrate/engines/types.ts";
import { validateManifest } from "../../src/substrate/plugins/manifest.ts";
import { tools as finderTools } from "../../src/harness-seed/tools/plugin-finder.ts";
import { type CoreLite, coreLite } from "../helpers/core-lite.ts";
import { ctxRecorder } from "../helpers/ctx-recorder.ts";
import { copyProject, Project, TOY_PLUGIN } from "../helpers/project-fixtures.ts";
import { tmpDir } from "../helpers/tmp.ts";
import { closeWorkerChats, RUN_ID, workerChat } from "../helpers/worker-chat.ts";

/** The fixture engine every delegation here runs on. */
const ENGINE = "claude-code";
/** The bundled plugins as they ship: Unreal off, Blender on. */
const UNREAL = "unreal";
const BLENDER = "blender";

/** A plugin manifest as Genex keeps it, read from its package. */
const manifestAt = (file: string): PluginManifest => validateManifest(JSON.parse(readFileSync(file, "utf8")));
const UNREAL_MANIFEST = manifestAt(new URL("../../src/plugins/unreal/plugin.json", import.meta.url).pathname);
const BLENDER_MANIFEST = manifestAt(new URL("../../src/plugins/blender/plugin.json", import.meta.url).pathname);
const TOY_MANIFEST = manifestAt(path.join(TOY_PLUGIN, "plugin.json"));

/** A plugin in Genex's catalog that knows Godot projects by their files. */
const GODOT_ENTRY: PluginCatalogEntry = {
  manifest: validateManifest({
    apiVersion: 3,
    id: "godot-tools",
    version: "1.0.0",
    name: "Godot Tools",
    publisher: "Genex tests",
    description: "Build and run Godot games.",
    backend: "backend.mjs",
    capabilities: [],
    tools: [],
    skills: [],
    panels: [],
    settings: [],
    actions: [],
    detect: [{ fact: "godot-project", files: ["**/project.godot"] }],
  }),
  url: "https://example.invalid/godot-tools.zip",
  sha256: "0".repeat(64),
};

/** An installed plugin as the registry lists it. */
const installed = (
  manifest: PluginManifest,
  enabled: boolean,
  extra: { removed?: boolean; unlisted?: boolean } = {},
) => ({
  manifest,
  enabled,
  removed: extra.removed ?? false,
  ...(extra.unlisted ? { unlisted: true } : {}),
});

describe("finding a Genex plugin", () => {
  const list = [installed(TOY_MANIFEST, false), installed(UNREAL_MANIFEST, false), installed(BLENDER_MANIFEST, true)];
  const catalog = [GODOT_ENTRY, { ...GODOT_ENTRY, manifest: UNREAL_MANIFEST }];

  it("finds by fact or words, installed first, catalog next, never anything else", () => {
    const godot = findPlugins(list, catalog, { fact: "godot-project" });
    assert.deepEqual(
      godot.plugins.map((p) => [p.id, p.offer]),
      [["godot-tools", PluginOffer.Install]],
    );
    assert.deepEqual(godot.plugins[0]?.facts, ["godot-project"]);
    assert.equal(godot.next, FindNext.Suggest);

    const unreal = findPlugins(list, catalog, { text: "Unreal" });
    assert.deepEqual(
      unreal.plugins.map((p) => [p.id, p.offer]),
      [[UNREAL, PluginOffer.TurnOn]],
      "an installed plugin is never offered again from the catalog",
    );
    assert.ok(unreal.plugins[0]?.facts.includes("unreal-project"), "its facts say what it is for");

    const none = findPlugins(list, catalog, { fact: "made-up" });
    assert.deepEqual(none.plugins, []);
    assert.equal(none.next, FindNext.WritePlugin);
    assert.match(none.note, /Genex plugin/);

    // Everything, in order: on, then off, then the catalog's.
    const all = findPlugins(list, catalog, {});
    assert.deepEqual(
      all.plugins.map((p) => [p.id, p.offer ?? "on"]),
      [
        [BLENDER, "on"],
        ["toy-engine", PluginOffer.TurnOn],
        [UNREAL, PluginOffer.TurnOn],
        ["godot-tools", PluginOffer.Install],
      ],
    );

    // A plugin already on has nothing to suggest: its tools are the session's to use.
    const on = findPlugins(list, catalog, { text: "blender" });
    assert.deepEqual(
      on.plugins.map((p) => [p.id, p.offer]),
      [[BLENDER, undefined]],
    );
    assert.equal(on.next, FindNext.Use);

    // Blender files find Genex's own Local Blender: on, it is used; off, it is offered.
    const blendOn = findPlugins(list, catalog, { fact: "blender-assets" });
    assert.deepEqual(
      blendOn.plugins.map((p) => [p.id, p.offer]),
      [[BLENDER, undefined]],
    );
    assert.equal(blendOn.next, FindNext.Use);
    const blendOff = findPlugins([installed(BLENDER_MANIFEST, false)], [], { fact: "blender-assets" });
    assert.deepEqual(
      blendOff.plugins.map((p) => [p.id, p.offer]),
      [[BLENDER, PluginOffer.TurnOn]],
    );
    assert.equal(blendOff.next, FindNext.Suggest);

    // Code found without an install record is never suggested; a removed one is installed again.
    const odd = findPlugins(
      [installed(TOY_MANIFEST, false, { unlisted: true }), installed(UNREAL_MANIFEST, true, { removed: true })],
      [],
      {},
    );
    assert.deepEqual(
      odd.plugins.map((p) => [p.id, p.offer]),
      [[UNREAL, PluginOffer.Install]],
    );
  });

  it("an engine's name finds its plugin whatever words come with it, and words alone never name a plugin", () => {
    const ids = (query: { fact?: string; text?: string }): Array<[string, string]> =>
      findPlugins(list, catalog, query).plugins.map((p): [string, string] => [p.id, p.offer ?? "on"]);
    const rows: Array<[{ fact?: string; text?: string }, Array<[string, string]>]> = [
      [{ fact: "unreal-project", text: "Unreal Engine" }, [[UNREAL, PluginOffer.TurnOn]]],
      [{ text: "Unreal Engine 5 plugin" }, [[UNREAL, PluginOffer.TurnOn]]],
      [{ fact: "unreal-project", text: "port the scene" }, [[UNREAL, PluginOffer.TurnOn]]],
      [{ text: "Godot engine" }, [["godot-tools", PluginOffer.Install]]],
      [{ text: "the Godot editor" }, [["godot-tools", PluginOffer.Install]]],
      [{ text: "blend files" }, [[BLENDER, "on"]]],
      [{ fact: "made-up", text: "zzz" }, []],
      [{ text: "game engine plugin" }, ids({})],
    ];
    for (const [query, expected] of rows) assert.deepEqual(ids(query), expected, JSON.stringify(query));
    assert.equal(findPlugins(list, catalog, { text: "Unreal Engine" }).next, FindNext.Suggest);
  });

  it("the card offers Turn on, Install… or says On, from the live plugin list", () => {
    assert.equal(suggestionState(list, UNREAL), SuggestionState.TurnOn);
    assert.equal(suggestionState(list, BLENDER), SuggestionState.On);
    assert.equal(suggestionState(list, "godot-tools"), SuggestionState.Install);
    assert.equal(
      suggestionState([installed(UNREAL_MANIFEST, false, { removed: true })], UNREAL),
      SuggestionState.Install,
    );

    let clock = 0;
    const envelope = (data: EventData): EventEnvelope => {
      clock += 1;
      return {
        id: String(clock).padStart(6, "0"),
        thread_id: "game",
        turn_id: "turn",
        session_id: null,
        created_at: new Date(clock * 1000).toISOString(),
        data,
      };
    };
    const suggested = {
      pluginId: UNREAL,
      name: "Unreal Editor",
      description: "Agents build your game in Unreal Editor.",
      offer: PluginOffer.TurnOn,
      reason: "You asked for an Unreal game.",
      project: "lantern",
    };
    const entries = toEntries([
      envelope(customEventData(CustomEvent.PluginSuggested, suggested)),
      // An old or partial record draws nothing rather than a card with no plugin.
      envelope(customEventData(CustomEvent.PluginSuggested, { name: "nameless" })),
    ]);
    const cards = entries.filter((entry) => entry.kind === EntryKind.PluginSuggestion);
    assert.equal(cards.length, 1);
    assert.deepEqual(cards[0]?.kind === EntryKind.PluginSuggestion && cards[0].suggestion, suggested);

    // The card names the plugin its button acts on, from the live list, whatever the record says.
    const mislabelled = { ...suggested, name: "Genex plugin: Blender", description: "Makes 3D models." };
    assert.deepEqual(suggestionShown(list, mislabelled), {
      name: UNREAL_MANIFEST.name,
      description: UNREAL_MANIFEST.description,
    });
    // A plugin not installed yet keeps the record's words: Install… reviews it in Genex's own dialog.
    const fromCatalog = { ...suggested, pluginId: "godot-tools", name: "Godot Tools", description: "Godot." };
    assert.deepEqual(suggestionShown(list, fromCatalog), { name: "Godot Tools", description: "Godot." });
  });
});

describe("suggesting a Genex plugin, through the core", () => {
  let lite: CoreLite;
  /** Folders beside the games folder, to open as games. */
  let places: string;
  before(async () => {
    const root = await realpath(await tmpDir("studio-plugins-find-"));
    places = path.join(root, "places");
    await mkdir(places);
    lite = await coreLite({
      gamesRoot: path.join(root, "games"),
      executionPolicy: { allowedProjectRoot: root, runBackgroundImprovement: false },
    });
    lite.core.plugins.catalog = async () => [GODOT_ENTRY, { ...GODOT_ENTRY, manifest: BLENDER_MANIFEST }];
  });
  after(async () => {
    lite.core.plugins.cancel();
    await lite.close();
  });

  const api = () => lite.api() as unknown as Record<string, (params: unknown) => Promise<unknown>>;
  /** The suggestion cards in a chat's log. */
  const cardsIn = async (threadId: string) =>
    (await lite.core.store.listEvents(threadId)).filter((event) => customEvent(event, CustomEvent.PluginSuggested));
  /** Which plugins are on, by id. */
  const enabledIds = () =>
    lite.core.plugins
      .list()
      .filter((p) => lite.core.plugins.enabled(p.manifest.id))
      .map((p) => p.manifest.id)
      .sort();

  it("suggesting shows the card for an installed-but-off or catalog plugin, and nothing else", async () => {
    const game = await lite.core.createGame("Lantern Wish");
    const threadId = await lite.core.threadForGame(game.name);
    const suggest = (plugin: unknown) =>
      api()[HostMethod.PluginsSuggest]({ project: game.name, threadId, plugin, reason: "You asked for Unreal." });

    const shown = (await suggest(UNREAL)) as { shown: boolean; message: string };
    assert.equal(shown.shown, true);
    assert.match(shown.message, /End your reply now/);
    const [card] = await cardsIn(threadId);
    assert.ok(card, "one card");
    assert.deepEqual(customEvent(card, CustomEvent.PluginSuggested), {
      pluginId: UNREAL,
      name: UNREAL_MANIFEST.name,
      description: UNREAL_MANIFEST.description,
      offer: PluginOffer.TurnOn,
      reason: "You asked for Unreal.",
      project: game.name,
    });

    const fromCatalog = (await suggest("godot-tools")) as { shown: boolean };
    assert.equal(fromCatalog.shown, true, "a catalog plugin");
    assert.equal((await cardsIn(threadId)).length, 2);

    // On already, unknown, a path, empty, not a name, and a catalog id that is installed and on.
    for (const plugin of [BLENDER, "nope", "../unreal", "", 7, null]) {
      const refused = (await suggest(plugin).catch((err: Error) => ({ shown: false, message: err.message }))) as {
        shown: boolean;
      };
      assert.equal(refused.shown, false, JSON.stringify(plugin));
    }
    assert.equal((await cardsIn(threadId)).length, 2, "a refused suggestion shows nothing");

    // Only in a chat of the named game: another game's chat, an unknown or missing chat, or the
    // studio's own thread gets no card, and neither chat changes.
    const other = await lite.core.createGame("Lantern Other");
    const otherThread = await lite.core.threadForGame(other.name);
    const elsewhere: unknown[] = [otherThread, "thread-nobody-made", "", undefined, null, 7, lite.core.mainThread];
    for (const where of elsewhere) {
      const answer = (await api()
        [HostMethod.PluginsSuggest]({ project: game.name, threadId: where, plugin: UNREAL, reason: "asked" })
        .catch((err: Error) => ({ shown: false, message: err.message }))) as { shown: boolean };
      assert.equal(answer.shown, false, JSON.stringify(where ?? null));
    }
    assert.equal((await cardsIn(threadId)).length, 2, "the game's own chat is unchanged");
    assert.deepEqual(await cardsIn(otherThread), [], "the other game's chat is unchanged");
    assert.deepEqual(await cardsIn(lite.core.mainThread), [], "the studio's own thread is unchanged");
  });

  it("the harness can't write a turn-it-on card itself: only plugins_suggest does", async () => {
    const game = await lite.core.createGame("Lantern Forged");
    const threadId = await lite.core.threadForGame(game.name);
    const forged = {
      type: "custom",
      event_type: CustomEvent.PluginSuggested,
      payload: {
        pluginId: UNREAL,
        name: "Something else",
        description: "",
        offer: PluginOffer.TurnOn,
        project: game.name,
      },
    };
    await assert.rejects(api()[HostMethod.EventsAppend]({ threadId, batch: [forged] }), /studio only/);
    const { turnId } = (await api()[HostMethod.TurnBegin]({ threadId })) as { turnId: string };
    await assert.rejects(api()[HostMethod.TurnAppend]({ turnId, batch: [forged] }), /studio only/);
    await api()[HostMethod.TurnEnd]({ turnId });
    assert.deepEqual(await cardsIn(threadId), [], "no card was written");
  });

  it("no tool turns a plugin on", async () => {
    const game = await lite.core.createGame("Lantern Again");
    const threadId = await lite.core.threadForGame(game.name);
    const before = enabledIds();
    for (let i = 0; i < 3; i++) {
      await api()[HostMethod.PluginsFind]({ project: game.name, text: "unreal" });
      await api()[HostMethod.PluginsFind]({ project: game.name, fact: "unreal-project" });
      await api()[HostMethod.PluginsSuggest]({ project: game.name, threadId, plugin: UNREAL, reason: "asked" });
    }
    assert.deepEqual(enabledIds(), before, "every plugin is on or off as it was");
    assert.equal(lite.core.plugins.enabled(UNREAL), false);
    const keys = (spec: { parameters?: unknown }) =>
      Object.keys((spec.parameters as { properties?: object } | undefined)?.properties ?? {}).sort();
    assert.deepEqual(keys(PLUGINS_FIND_TOOL), ["fact", "text"]);
    assert.deepEqual(keys(PLUGINS_SUGGEST_TOOL), ["plugin", "reason"]);
  });

  it("the chat's own session is offered both tools on every game, in Plan too; a builder is not", async (t) => {
    const sessions: Array<{ tools: string[]; found: unknown }> = [];
    lite.core.engines.register({
      id: ENGINE,
      label: "fixture",
      kind: "delegated",
      status: async () => ({ code: "ready", detail: "fixture" }),
      models: async () => [],
      delegate: async (request: DelegateRequest) => {
        const tools = (request.liveTools ?? []).map((tool) => tool.name);
        const found = tools.includes(ProjectTool.PluginsFind)
          ? await request.onLiveTool?.(ProjectTool.PluginsFind, { text: "unreal" })
          : null;
        sessions.push({ tools, found });
        return { ok: true, engine: ENGINE, summary: "fixture", turns: 1, usage: {} };
      },
    } as never);
    t.after(async () => {
      await lite.core.mcp.close().catch(() => {});
    });
    const delegate = (project: string, threadId: string, extra: Record<string, unknown> = {}) =>
      api()["engine.delegate"]({ engine: ENGINE, project, threadId, prompt: "make a game", ...extra });
    const both = (tools: string[]) =>
      [ProjectTool.PluginsFind, ProjectTool.PluginsSuggest].every((name) => tools.includes(name));

    const pending = await lite.core.createGame("Any Kind");
    const web = await lite.api()[HostMethod.GameScaffold]({ name: "web-kind", kind: "web" });
    const godotDir = await copyProject(Project.GodotGame, places);
    const godot = await lite.core.adoptProject(godotDir);
    for (const game of [pending, web, godot]) {
      const threadId = await lite.core.threadForGame(game.name);
      await delegate(game.name, threadId);
      assert.ok(both(sessions.at(-1)?.tools ?? []), `${game.name}: ${JSON.stringify(sessions.at(-1)?.tools)}`);
    }

    // In Plan the search still runs: it reads, and writes nothing.
    const threadId = await lite.core.threadForGame(pending.name);
    await lite.core.setPermissionMode(threadId, PermissionMode.Plan);
    await delegate(pending.name, threadId);
    const planned = sessions.at(-1);
    assert.ok(both(planned?.tools ?? []), "in Plan too");
    assert.match(String(planned?.found), /"id":"unreal"/);
    await lite.core.setPermissionMode(threadId, PermissionMode.Auto);

    // A builder in a worktree is never handed them.
    const worktree = path.join(lite.core.layout.scratch, "worktrees", `${pending.name}-part`);
    await mkdir(worktree, { recursive: true });
    await delegate(pending.name, threadId, { cwd: worktree });
    const builder = sessions.at(-1)?.tools ?? [];
    assert.equal(builder.includes(ProjectTool.PluginsFind), false, "a builder");
    assert.equal(builder.includes(ProjectTool.PluginsSuggest), false, "a builder");
  });
});

describe("a local model's plugin search and card", () => {
  it("asks the host for both, for the chat's own game, and the shown card ends the turn", async () => {
    const tool = (name: string) => {
      const found = finderTools.find((t) => t.name === name);
      assert.ok(found, name);
      return found;
    };
    const host = ctxRecorder({
      threadId: "chat-1",
      extra: { project: "lantern" },
      handlers: {
        [HostMethod.PluginsFind]: () => ({ plugins: [], next: FindNext.WritePlugin, note: "none" }),
        [HostMethod.PluginsSuggest]: (params) =>
          params.plugin === UNREAL ? { shown: true, message: "Shown." } : { shown: false, message: "No card." },
      },
    });
    const ctx = host.ctx as never;
    await tool(ProjectTool.PluginsFind).execute({ text: "Unreal", fact: 3 }, ctx);
    assert.deepEqual(host.paramsOf(HostMethod.PluginsFind), [{ project: "lantern", fact: null, text: "Unreal" }]);

    const shown = await tool(ProjectTool.PluginsSuggest).execute({ plugin: UNREAL, reason: "asked" }, ctx);
    assert.deepEqual(shown, { ok: true, content: "Shown.", stopTurn: "done" });
    assert.deepEqual(host.paramsOf(HostMethod.PluginsSuggest)[0], {
      project: "lantern",
      threadId: "chat-1",
      plugin: UNREAL,
      reason: "asked",
    });
    const refused = await tool(ProjectTool.PluginsSuggest).execute({ plugin: BLENDER, reason: "asked" }, ctx);
    assert.deepEqual(refused, { ok: false, content: "No card." }, "a refused card leaves the turn going");
  });
});

describe("plugin search by seat", () => {
  after(closeWorkerChats);

  it("a lead may look for a plugin and show its card in the chat it answers; a worker may only look; a builder of a classic run gets neither", async () => {
    const chat = await workerChat();
    const { api, core, game, seen, threadId, worktree } = chat;
    /** What each session was handed of Genex's project tools, and what its calls answered. */
    const projectToolsOf = (index: number) =>
      (seen[index]?.liveTools ?? [])
        .map((tool) => tool.name)
        .filter((name) => (Object.values(ProjectTool) as string[]).includes(name))
        .sort();
    const answers: unknown[] = [];
    const callsDuringTurn = (calls: Array<[string, Record<string, unknown>]>) =>
      chat.whileRunning(async (request) => {
        for (const [name, args] of calls)
          answers.push(await request.onLiveTool?.(name, args).catch((err: Error) => err.message));
      });
    /** The cards of each kind in a thread's log. */
    const cardsIn = async (thread: string, kind: CustomEventName) =>
      (await core.store.listEvents(thread)).filter((event) => customEvent(event, kind)).length;
    // The thread the harness names for its run: never a chat the card may show in.
    const runThread = String(await api[HostMethod.ThreadCreate]!({ title: "run" }));
    const integration = await chat.copyOf(RUN_ID, "integration");
    const suggest: [string, Record<string, unknown>] = [
      ProjectTool.PluginsSuggest,
      { plugin: UNREAL, reason: "asked" },
    ];

    /** A search no plugin answers: its answer says how to write one. */
    const nothingFits: [string, Record<string, unknown>] = [ProjectTool.PluginsFind, { fact: "nowhere-project" }];
    /** The write-a-plugin note of the last answer: the guide, never a check the session can't call. */
    const notesWithoutCheck = (who: string) => {
      const note = String(answers.at(-1));
      assert.match(note, /plugin-author/, `${who}: names the guide`);
      assert.doesNotMatch(note, /plugin_check/, `${who}: never a tool it wasn't handed`);
    };

    // The run's lead: the plugin search and the card, shown in the chat the run was started in.
    callsDuringTurn([suggest, nothingFits]);
    await chat.delegate({
      threadId: runThread,
      cwd: integration,
      director: { runId: RUN_ID, threadId: runThread, project: game, root: integration, setup: null, tools: [] },
    });
    assert.deepEqual(projectToolsOf(0), [ProjectTool.PluginsFind, ProjectTool.PluginsSuggest].sort());
    assert.equal(await cardsIn(threadId, CustomEvent.PluginSuggested), 1, "the card is in the chat the lead answers");
    assert.equal(await cardsIn(runThread, CustomEvent.PluginSuggested), 0, "never in the thread the harness named");
    notesWithoutCheck("the lead");

    // A lead of a run nobody started in a chat shows nothing anywhere.
    const stray = await chat.copyOf("run_stray", "integration");
    callsDuringTurn([suggest]);
    await chat.delegate({
      threadId: runThread,
      cwd: stray,
      director: { runId: "run_stray", threadId, project: game, root: stray, setup: null, tools: [] },
    });
    assert.equal(answers.at(-1), PLUGINS_SUGGEST_ANSWER.noChat);
    assert.equal(await cardsIn(threadId, CustomEvent.PluginSuggested), 1, "no second card");

    // The run's worker may look, never show.
    callsDuringTurn([[ProjectTool.PluginsFind, { text: "unreal" }], nothingFits]);
    await chat.delegate(chat.runWorker("w1", worktree));
    assert.deepEqual(projectToolsOf(2), [ProjectTool.PluginsFind]);
    assert.match(String(answers.at(-2)), /"id":"unreal"/, "its search answers");
    notesWithoutCheck("a worker");
    // A typed worker, offered only its type's plugin tools, may still look.
    callsDuringTurn([]);
    await chat.delegate(chat.runWorker("w1", worktree, { toolAllow: ["blender__"] }));
    assert.deepEqual(projectToolsOf(3), [ProjectTool.PluginsFind], "a typed worker may look too");

    // A builder of a classic run (no worker grant) gets none of them.
    callsDuringTurn([]);
    await chat.delegate({
      cwd: worktree,
      selfCapture: { project: game, root: worktree, runId: RUN_ID, facetId: "f", iteration: 1, label: "f" },
    });
    assert.deepEqual(projectToolsOf(4), []);
    assert.equal(await cardsIn(threadId, CustomEvent.PluginSuggested), 1, "nothing else was shown");

    // A reviewer of the run reads and looks only: no project tool, plugin_check among them.
    callsDuringTurn([]);
    await chat.delegate({ readOnly: true, reviewer: { runId: RUN_ID, reads: chat.project.dir }, toolAllow: [] });
    assert.ok(seen[5]?.reviewer, "the reviewer was seated");
    assert.deepEqual(projectToolsOf(5), [], "a reviewer");
  });
});
