/**
 * The `open-projects` dev fixture: the looks of projects that aren't web games, for a rendered look
 * at each. Before the window opens: a Godot-shaped game whose earlier timed Loop closed with no
 * claim checked, an Unreal plugin project (the sidebar's kind label), a plugin loaded from a folder
 * with one tool the person always allowed, and the web game's chat holding the card that offers the
 * Unreal plugin, which is off; and a folder that is both a web game and an Unreal project. Once the
 * app has started: the Godot game's Loop going in place with a worker whose question waits in the
 * chat, and the plugin project's Loop, sent back once by the reviewer, waiting for the person to
 * finish in Unreal. Read through a real core, as the window reads them. Seeding again writes nothing.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { MESSAGE as OPEN_END } from "../../src/harness-seed/loop/director/open/finish.ts";
import { TIME_CAP_WORDS } from "../../src/harness-seed/loop/time-cap-prompts.ts";
import {
  OPEN_PROJECTS,
  openLoopWaitNotice,
  seedOpenLoops,
  seedOpenProjects,
} from "../../src/main/dev/fixture-open-projects.ts";
import { FixtureName, isFixtureName } from "../../src/main/dev/fixture-kit.ts";
import { buildRunGraph, FinishCheckState, GraphNodeKind } from "../../src/renderer/run-graph.ts";
import { EntryAction, EntryKind, toEntries } from "../../src/renderer/chat-entries.ts";
import { liveViewFor, liveViewLabel, liveViewsFor } from "../../src/renderer/live-views.ts";
import { partRows } from "../../src/renderer/run-steps.ts";
import { projectKindLabel } from "../../src/renderer/project-kind.ts";
import { initialThreads, personFirstLabel, personFirstReported } from "../../src/renderer/state/threads.ts";
import { PERSON_FIRST_WORDS } from "../../src/renderer/words.ts";
import { CustomEvent, customPayload } from "../../src/shared/custom-events.ts";
import type { EventEnvelope } from "../../src/shared/event-log.ts";
import { ObserverLive, UNREAL_PLUGIN_ID } from "../../src/shared/observers.ts";
import { CoreFact, LoopProfile } from "../../src/shared/project-facts.ts";
import { PluginSourceKind } from "../../src/shared/plugins.ts";
import { PluginOffer } from "../../src/shared/project-tools.ts";
import { ToolPermissionState } from "../../src/shared/permissions.ts";
import { HOUR_MS } from "../../src/shared/duration.ts";
import { AppLookAccessKind } from "../../src/shared/jobs.ts";
import { type CoreLite, coreLite } from "../helpers/core-lite.ts";

const GAME = "fixture-game";
/** The in-place Loop's close when its time ran out with no reviewer's yes, as the seed writes it. */
const OPEN_TIME_UP = OPEN_END.timeUpNoClaim;

describe("the open-projects dev fixture", () => {
  let lite: CoreLite;
  let gameThread: string;
  before(async () => {
    lite = await coreLite();
    await lite.core.games.scaffold(GAME, { title: "Fixture Game" });
    gameThread = await lite.core.threadForGame(GAME);
    await seedOpenProjects(lite.core, GAME, gameThread);
    await seedOpenLoops(lite.core);
  });
  after(() => lite.close());

  const listed = async (name: string) => {
    const game = (await lite.core.games.list()).find((known) => known.name === name);
    assert.ok(game, `${name} is in the library`);
    return game;
  };
  const chat = async (name: string): Promise<EventEnvelope[]> =>
    lite.core.store.listEvents(await lite.core.threadForGame(name));

  it("is a named fixture", () => {
    assert.equal(FixtureName.OpenProjects, "open-projects");
    assert.ok(isFixtureName(FixtureName.OpenProjects));
  });

  it("a Godot-shaped game with no plugin shows its runs' pictures in Live", async () => {
    const godot = await listed(OPEN_PROJECTS.godot);
    assert.deepEqual(
      godot.facts?.map((fact) => fact.id),
      [CoreFact.GodotProject],
    );
    assert.equal(liveViewFor(godot, lite.core.plugins.list()).live, ObserverLive.Stills);
    assert.equal(projectKindLabel(godot), null, "a game shows no kind label");
  });

  it("a folder that is both a web game and an Unreal project gets a tab for each, the web game first", async () => {
    const both = await listed(OPEN_PROJECTS.webAndUnreal);
    const plugins = lite.core.plugins.list();
    assert.deepEqual(
      liveViewsFor(both, plugins).map((view) => liveViewLabel(view, plugins)),
      ["Web game", "Unreal"],
    );
  });

  it("an Unreal plugin project made by the plugin's scaffold shows its kind beside its name", async () => {
    assert.equal(projectKindLabel(await listed(OPEN_PROJECTS.plugin)), "Unreal plugin");
  });

  it("a plugin loaded from a folder runs one tool without asking, which the person can take back", () => {
    const local = lite.core.plugins.list().find((plugin) => plugin.source === PluginSourceKind.Local);
    assert.ok(local, "a local plugin is installed");
    assert.equal(local.enabled, true);
    assert.deepEqual(local.allowedTools, [OPEN_PROJECTS.allowedTool]);
  });

  it("the web game's chat offers the Unreal plugin, which is off", async () => {
    const unreal = lite.core.plugins.list().find((plugin) => plugin.manifest.id === UNREAL_PLUGIN_ID);
    assert.equal(unreal?.enabled, false);
    const cards = toEntries(await chat(GAME)).flatMap((entry) =>
      entry.kind === EntryKind.PluginSuggestion ? [entry.suggestion] : [],
    );
    assert.deepEqual(
      cards.map((card) => [card.pluginId, card.offer]),
      [[UNREAL_PLUGIN_ID, PluginOffer.TurnOn]],
    );
  });

  it("the Godot game's earlier timed Loop closed in place with no claim checked, and says so", async () => {
    const closes = (await chat(OPEN_PROJECTS.godot)).flatMap((event) => {
      const finished = customPayload(event.data, CustomEvent.RunFinished);
      return finished ? [finished] : [];
    });
    assert.equal(closes.length, 1);
    assert.equal(closes[0]?.profile, LoopProfile.Open);
    assert.deepEqual(closes[0]?.notDone, [TIME_CAP_WORDS.notChecked]);
    const result = toEntries(await chat(OPEN_PROJECTS.godot)).find((entry) => entry.kind === EntryKind.Morning);
    assert.ok(result?.kind === EntryKind.Morning);
    assert.ok(result.summary?.includes(TIME_CAP_WORDS.notChecked), "the result card says no reviewer read a claim");
    // As the in-place Loop writes it: timed in `budgets`, closed in its own words with its lead's row.
    assert.equal(closes[0]?.stoppedBecause, OPEN_TIME_UP);
    assert.deepEqual(Object.keys((closes[0] as { facets?: object } | undefined)?.facets ?? {}), ["lead"]);
    const graph = buildRunGraph(await chat(OPEN_PROJECTS.godot), String(closes[0]?.runId));
    const run = graph?.nodes.find((node) => node.kind === GraphNodeKind.Run);
    assert.equal(run?.kind === GraphNodeKind.Run ? run.durationMs : undefined, HOUR_MS, "the graph reads it as timed");
  });

  it("the Godot game's Loop going in place draws its worker and the finish check, and the worker's question waits", async () => {
    const events = await chat(OPEN_PROJECTS.godot);
    const graph = buildRunGraph(events);
    assert.ok(graph);
    assert.equal(graph.tree, true);
    assert.ok(
      graph.nodes.some((node) => node.kind === GraphNodeKind.Lead),
      "the lead",
    );
    assert.ok(
      partRows(graph, null).some((row) => row.facet.title === OPEN_PROJECTS.askingWorker),
      "the worker's row",
    );
    const check = graph.nodes.find((node) => node.kind === GraphNodeKind.FinishCheck);
    assert.ok(check?.kind === GraphNodeKind.FinishCheck);
    assert.equal(check.state, FinishCheckState.NotYet);
    const asks = toEntries(events).filter(
      (entry) => entry.kind === EntryKind.Action && entry.action === EntryAction.Permission && entry.pending,
    );
    assert.equal(asks.length, 1, "one question waits");
    const ask = asks[0];
    assert.ok(ask?.kind === EntryKind.Action);
    assert.equal(ask.permission?.state, ToolPermissionState.Pending);
    assert.equal(ask.permission?.worker?.title, OPEN_PROJECTS.askingWorker);
  });

  it("the plugin project's Loop, sent back once by the reviewer, waits for the person to finish in Unreal", async () => {
    const threadId = await lite.core.threadForGame(OPEN_PROJECTS.plugin);
    const graph = buildRunGraph(await chat(OPEN_PROJECTS.plugin));
    assert.ok(graph, "a Loop is going there");
    const check = graph.nodes.find((node) => node.kind === GraphNodeKind.FinishCheck);
    assert.ok(check?.kind === GraphNodeKind.FinishCheck);
    assert.deepEqual([check.state, check.round, check.reasons.length], [FinishCheckState.NotYet, 1, 2]);
    const notice = openLoopWaitNotice(lite.core, threadId);
    const state = personFirstReported(initialThreads(), notice);
    assert.equal(
      PERSON_FIRST_WORDS.waiting(personFirstLabel(state, threadId) ?? ""),
      "Waiting for you to finish in Unreal",
    );
  });

  it("a web game ported to Unreal: its chat holds the port's turn, and the web files no longer count as a kind", async () => {
    const ported = await listed(OPEN_PROJECTS.ported);
    assert.deepEqual(
      ported.facts?.map((fact) => fact.id),
      [CoreFact.UnrealProject],
      "the web game it replaced stays as the reference only",
    );
    const entries = toEntries(await chat(OPEN_PROJECTS.ported));
    const text = entries.map((entry) => ("text" in entry ? String(entry.text ?? "") : "")).join("\n");
    assert.match(text, /Port this game to Unreal/);
    assert.match(text, /snapshot/i, "the reply says the game was saved first");
  });

  it("a chat where app_look can't see app windows yet shows the access line with a button per pane", async () => {
    const access = toEntries(await chat(OPEN_PROJECTS.ported)).flatMap((entry) =>
      entry.kind === EntryKind.Action && entry.action === EntryAction.AppAccess ? [entry.appAccess] : [],
    );
    assert.deepEqual(access, [[AppLookAccessKind.Screen, AppLookAccessKind.Accessibility]]);
  });

  it("seeding again writes nothing", async () => {
    const counts = async () =>
      Promise.all(
        [GAME, OPEN_PROJECTS.godot, OPEN_PROJECTS.plugin, OPEN_PROJECTS.ported].map(
          async (name) => (await chat(name)).length,
        ),
      );
    const before = await counts();
    await seedOpenProjects(lite.core, GAME, gameThread);
    await seedOpenLoops(lite.core);
    assert.deepEqual(await counts(), before);
  });
});
