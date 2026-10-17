/**
 * Live shows what the folder holds: the web preview, a plugin's view, or the latest pictures.
 *
 * The view comes from the folder's observers (`shared/observers.ts`): the game's root first, and in
 * one folder the Unreal card, then Genex's preview, then a plugin's pictures. An Unreal project
 * shows the Unreal card whatever the plugin list says, a web game or one with no kind yet shows its
 * preview, which no plugin's pictures take over. A folder no observer draws (Godot, Blender, files
 * of its own) shows the latest pictures its runs kept, from an earlier run when the stage's run took
 * none. The card's shot is the viewport's newest capture, else the newest save point's still. The
 * stage's flags follow the view: only the preview has web controls, a page probe and the native view.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { unservedPreviews, type CoreInternals } from "../../src/main/core/internals.ts";
import { PreviewService } from "../../src/main/core/previews.ts";
import type { StudioCore } from "../../src/main/studio-core.ts";
import {
  chosenLiveView,
  latestCaptures,
  latestShot,
  liveViewFor,
  liveViewLabel,
  liveViewsFor,
  picturesGraph,
} from "../../src/renderer/live-views.ts";
import { stageFlags } from "../../src/renderer/panels/stage/stage-flags.ts";
import { activeStageTab, stageTabs, tabChoice } from "../../src/renderer/panels/stage/stage-tabs.ts";
import { buildRunGraph } from "../../src/renderer/run-graph.ts";
import { StageView } from "../../src/renderer/stage.ts";
import { STAGE_WORDS } from "../../src/renderer/words.ts";
import { CustomEvent } from "../../src/shared/custom-events.ts";
import { type EventData, type EventEnvelope, EventKind } from "../../src/shared/event-log.ts";
import { ObserverLive, ObserverSource, PREVIEW_OBSERVER, UNREAL_PLUGIN_ID } from "../../src/shared/observers.ts";
import type { PluginManifest } from "../../src/shared/plugins.ts";
import { CoreFact, FactSource, FolderHolds, type ProjectFact } from "../../src/shared/project-facts.ts";
import { tmpDir } from "../helpers/tmp.ts";

const UNREAL_MANIFEST = JSON.parse(
  readFileSync(new URL("../../src/plugins/unreal/plugin.json", import.meta.url), "utf8"),
) as PluginManifest;
const VIEWPORT = `${UNREAL_PLUGIN_ID}/viewport`;

const fact = (id: string, at = "."): ProjectFact => ({ id, path: at, source: FactSource.Core });
const game = (...facts: ProjectFact[]) => ({ facts });
const unreal = (enabled: boolean) => ({ manifest: UNREAL_MANIFEST, enabled, removed: false });

let seq = 0;
/** One record of the chat's log, a second after the one before. */
function logged(data: EventData): EventEnvelope {
  seq += 1;
  return {
    id: `e${String(seq).padStart(4, "0")}`,
    thread_id: "t1",
    session_id: null,
    turn_id: null,
    created_at: new Date(Date.UTC(2026, 0, 1, 9, 0, seq)).toISOString(),
    data,
  } as EventEnvelope;
}
const record = (eventType: string, payload: Record<string, unknown>) =>
  logged({ type: EventKind.Custom, event_type: eventType, payload });
const started = (runId: string) => record(CustomEvent.RunStarted, { runId, goal: "Make it", project: "game" });
const capture = (runId: string, observer: string, files: unknown[], extra: Record<string, unknown> = {}) =>
  record(CustomEvent.ObserverCapture, {
    runId,
    observer,
    label: observer,
    source: ObserverSource.Plugin,
    images: files.map((file, n) => ({ name: `shot ${n + 1}`, file })),
    ...extra,
  });
const savePoint = (runId: string, round: number, shot: string) =>
  record(CustomEvent.FacetIteration, {
    runId,
    facetId: "lead",
    facetTitle: "Lead",
    iteration: round,
    winner: "challenger",
    verdictSource: "lead",
    satisfied: false,
    shots: [
      { camera: "hero", path: shot },
      { camera: "default", path: shot },
    ],
  });

describe("Live's view, from the folder's observers", () => {
  it("a web game's Live is its preview; a game with no kind yet is too", () => {
    const plugins = [unreal(true)];
    assert.deepEqual(liveViewFor(game(fact(CoreFact.WebGame)), plugins), {
      live: ObserverLive.Preview,
      at: ".",
      observer: PREVIEW_OBSERVER,
    });
    assert.equal(liveViewFor(game(), plugins).live, ObserverLive.Preview, "no kind yet");
    assert.equal(liveViewFor(null, plugins).live, ObserverLive.Preview, "no game on the stage");
    assert.equal(liveViewFor({ facts: [], holds: FolderHolds.Notes }, []).live, ObserverLive.Preview);
  });

  it("an Unreal game's Live is the Unreal card, from the plugin's observer, also while the plugin is off", () => {
    for (const enabled of [true, false])
      assert.deepEqual(liveViewFor(game(fact(CoreFact.UnrealProject)), [unreal(enabled)]), {
        live: ObserverLive.UnrealCard,
        at: ".",
        observer: VIEWPORT,
      });
    const card = { live: ObserverLive.UnrealCard, at: ".", observer: VIEWPORT };
    const removed = { ...unreal(true), removed: true };
    const older = { manifest: { ...UNREAL_MANIFEST, observers: undefined }, enabled: true, removed: false };
    for (const [what, plugins] of [
      ["a removed plugin", [removed]],
      ["an installed plugin from before observers", [older]],
      ["a plugin list not read yet", []],
    ] as const)
      assert.deepEqual(liveViewFor(game(fact(CoreFact.UnrealProject)), plugins), card, what);
    assert.deepEqual(
      liveViewFor(game(fact(CoreFact.UnrealProject, "/Users/me/Unreal/Tower")), []),
      { ...card, at: "/Users/me/Unreal/Tower" },
      "a linked project outside the folder",
    );
  });

  it("no plugin's pictures take Live from a web game or the Unreal card", () => {
    const viewOf = (facts: string[], enabled: boolean, extra: Record<string, unknown> = {}) => ({
      manifest: { id: "snaps", observers: [{ id: "view", facts, tool: "shot", live: ObserverLive.Stills }] },
      enabled,
      removed: false,
      ...extra,
    });
    for (const enabled of [true, false]) {
      const web = liveViewFor(game(fact(CoreFact.WebGame)), [viewOf([CoreFact.WebGame], enabled)]);
      assert.equal(web.live, ObserverLive.Preview, `a web game keeps its preview (plugin on: ${enabled})`);
      assert.equal(liveViewFor(game(), [viewOf([CoreFact.WebGame], enabled)]).live, ObserverLive.Preview);
    }
    const card = liveViewFor(game(fact(CoreFact.UnrealProject)), [
      viewOf([CoreFact.UnrealProject], true),
      unreal(true),
    ]);
    assert.equal(card.live, ObserverLive.UnrealCard, "the card wins over a plugin's pictures");
    const godot = game(fact(CoreFact.GodotProject));
    assert.deepEqual(liveViewFor(godot, [viewOf([CoreFact.GodotProject], true)]), {
      live: ObserverLive.Stills,
      at: ".",
      observer: "snaps/view",
    });
    assert.equal(
      liveViewFor(godot, [viewOf([CoreFact.GodotProject], false)]).observer,
      null,
      "an off plugin's pictures don't count",
    );
    assert.equal(
      liveViewFor(godot, [viewOf([CoreFact.GodotProject], false, { unlisted: true })]).observer,
      null,
      "nor do an unlisted package's",
    );
    assert.equal(
      liveViewFor(godot, [viewOf([CoreFact.GodotProject], true, { unlisted: true })]).observer,
      null,
      "an unlisted package is never Live's, on or not",
    );
  });

  it("a web game at the root keeps its preview beside an Unreal project in a folder", () => {
    const rootWeb = game(fact(CoreFact.WebGame), fact(CoreFact.UnrealProject, "ref"));
    assert.deepEqual(liveViewFor(rootWeb, [unreal(true)]), {
      live: ObserverLive.Preview,
      at: ".",
      observer: PREVIEW_OBSERVER,
    });
  });

  it("a new run that took no pictures yet shows the newest earlier run's", () => {
    const view = { live: ObserverLive.Stills, at: ".", observer: null };
    const log = [
      started("run_a"),
      capture("run_a", "proof", ["/runs/run_a/crate.png"], { source: ObserverSource.Proof }),
      started("run_b"),
    ];
    const graphOf = (runId: string) => buildRunGraph(log, runId);
    const shown = graphOf("run_b");
    const used = picturesGraph(shown, ["run_a", "run_b"], graphOf, view);
    assert.deepEqual(
      latestCaptures(used).map((picture) => picture.file),
      ["/runs/run_a/crate.png"],
    );
    const card = { live: ObserverLive.UnrealCard, at: ".", observer: VIEWPORT };
    const unrealLog = [started("run_u"), capture("run_u", VIEWPORT, ["/runs/run_u/v1.png"]), started("run_v")];
    const unrealOf = (runId: string) => buildRunGraph(unrealLog, runId);
    assert.equal(
      latestShot(picturesGraph(unrealOf("run_v"), ["run_u", "run_v"], unrealOf, card), VIEWPORT),
      "/runs/run_u/v1.png",
    );
    assert.equal(picturesGraph(shown, ["run_b"], graphOf, view), shown, "none earlier: the stage's run");
  });

  it("an Unreal game with a web site shows the Unreal card", () => {
    const both = game(fact(CoreFact.UnrealProject), fact(CoreFact.WebGame, "site"));
    assert.equal(liveViewFor(both, [unreal(true)]).live, ObserverLive.UnrealCard);
    assert.equal(liveViewFor(both, []).live, ObserverLive.UnrealCard, "also before the plugin list is read");
  });

  it("a game made in Genex with its Unreal project in a folder shows the Unreal card, whatever its site's folder is named", () => {
    const linked = (at: string): ProjectFact => ({ id: CoreFact.UnrealProject, path: at, source: FactSource.Link });
    for (const site of ["site", "docs", "promo", "web"]) {
      const made = game(linked("unreal"), fact(CoreFact.WebGame, site));
      assert.deepEqual(
        liveViewFor(made, [unreal(true)]),
        { live: ObserverLive.UnrealCard, at: "unreal", observer: VIEWPORT },
        `a site in ${site}/`,
      );
      assert.equal(
        liveViewFor(made, []).live,
        ObserverLive.UnrealCard,
        `${site}/: also before the plugin list is read`,
      );
    }
    const unlinked = game(fact(CoreFact.UnrealProject, "unreal"), fact(CoreFact.WebGame, "site"));
    assert.equal(
      liveViewFor(unlinked, [unreal(true)]).live,
      ObserverLive.UnrealCard,
      "with no fact at the root, the Unreal card comes before a preview in another folder",
    );
  });

  it("a folder with no view of its own shows its latest pictures", () => {
    for (const kind of [
      game(fact(CoreFact.GodotProject)),
      game(fact(CoreFact.BlenderAssets)),
      { facts: [], holds: FolderHolds.OwnFiles },
    ])
      assert.deepEqual(liveViewFor(kind, [unreal(true)]), { live: ObserverLive.Stills, at: ".", observer: null });
    const graph = buildRunGraph([
      started("run_a"),
      capture("run_a", "proof", ["/runs/run_a/old.png"], { source: ObserverSource.Proof }),
      started("run_b"),
      capture("run_b", "proof", ["/runs/run_b/crate.png", "/runs/run_b/lamp.png"], { source: ObserverSource.Proof }),
    ]);
    assert.deepEqual(
      latestCaptures(graph).map((picture) => picture.file),
      ["/runs/run_b/crate.png", "/runs/run_b/lamp.png"],
    );
    assert.deepEqual(latestCaptures(null), []);
  });

  it("the Unreal card's shot is the viewport's newest capture, else the newest save point's still", () => {
    const saves = [
      started("run_u"),
      savePoint("run_u", 1, "/runs/run_u/s1.png"),
      savePoint("run_u", 2, "/runs/run_u/s2.png"),
    ];
    assert.equal(latestShot(buildRunGraph(saves), VIEWPORT), "/runs/run_u/s2.png", "the newest save point's still");
    const captured = [
      ...saves,
      capture("run_u", VIEWPORT, ["/runs/run_u/v1.png"]),
      capture("run_u", "other/view", ["/runs/run_u/o1.png"]),
      capture("run_u", VIEWPORT, [], { problem: "the editor didn't answer" }),
    ];
    assert.equal(
      latestShot(buildRunGraph(captured), VIEWPORT),
      "/runs/run_u/v1.png",
      "a capture with no picture is skipped",
    );
    assert.equal(latestShot(null, VIEWPORT), null);
    assert.equal(latestShot(buildRunGraph([started("run_e")]), VIEWPORT), null);
  });

  it("ignores captures it cannot show", async () => {
    const root = await tmpDir("live-views-");
    const runs = path.join(root, "runs");
    await mkdir(runs);
    const outside = path.join(root, "outside.png");
    await writeFile(outside, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(24).fill(0)]));
    const graph = buildRunGraph([
      started("run_h"),
      record(CustomEvent.ObserverCapture, {
        observer: VIEWPORT,
        source: ObserverSource.Plugin,
        images: [{ name: "a", file: "/x.png" }],
      }),
      capture("run_other", VIEWPORT, ["/runs/run_other/b.png"]),
      capture("run_h", VIEWPORT, [42, { file: "/y.png" }, null]),
      record(CustomEvent.ObserverCapture, { runId: "run_h", observer: VIEWPORT, source: "nowhere", images: [] }),
      capture("run_h", VIEWPORT, [outside]),
    ]);
    assert.deepEqual(
      graph?.captures.map((info) => info.files.map((file) => file.file)),
      [[outside]],
      "only this run's capture with pictures named by text is kept",
    );
    // The graph carries the path as recorded; reading it is the run folder's gate.
    assert.equal(latestShot(graph, VIEWPORT), outside);
    const core = { layout: { runs }, options: { previewPoolMax: 0 } } as unknown as StudioCore;
    const service = new PreviewService(core, unservedPreviews() as CoreInternals);
    assert.equal(await service.readRunStill(outside), null, "a picture outside the runs folder is never read");
  });

  it("keeps at most the newest eight captures of each observer", () => {
    const many = Array.from({ length: 10 }, (_, n) => capture("run_m", VIEWPORT, [`/runs/run_m/${n}.png`]));
    const graph = buildRunGraph([started("run_m"), ...many]);
    const files = graph?.captures.map((info) => info.files[0]?.file);
    assert.equal(files?.length, 8);
    assert.equal(files?.[0], "/runs/run_m/2.png");
    assert.equal(files?.at(-1), "/runs/run_m/9.png");
  });
});

describe("the stage's flags follow Live's view", () => {
  const flagsOf = (liveView: ObserverLive, view: StageView = StageView.Live) =>
    stageFlags({
      view,
      beside: null,
      graph: null,
      planning: view === StageView.Builds,
      project: "game",
      liveView,
      pending: false,
      live: { state: null, liveLoad: { project: "game", pending: false, since: 0 }, stopped: true },
    });
  const rows: Array<[string, ObserverLive, Record<string, boolean>]> = [
    [
      "the preview: the page loads and its controls show",
      ObserverLive.Preview,
      { previewOnStage: true, cardOnStage: false, stillsOnStage: false, liveLoading: true },
    ],
    [
      "the Unreal card: no page, no controls",
      ObserverLive.UnrealCard,
      { previewOnStage: false, cardOnStage: true, stillsOnStage: false, liveLoading: false, gameStopped: false },
    ],
    [
      "the pictures: no page, no controls",
      ObserverLive.Stills,
      { previewOnStage: false, cardOnStage: false, stillsOnStage: true, liveLoading: false, gameStopped: false },
    ],
    [
      "a plugin's card: no page, no controls",
      ObserverLive.Card,
      {
        previewOnStage: false,
        cardOnStage: false,
        pluginCardOnStage: true,
        stillsOnStage: false,
        liveLoading: false,
        gameStopped: false,
      },
    ],
  ];
  for (const [name, liveView, expected] of rows)
    it(name, () => {
      const flags = flagsOf(liveView);
      for (const [key, value] of Object.entries(expected))
        assert.equal(flags[key as keyof typeof flags], value, `${name}: ${key}`);
    });

  it("on Builds no view is on stage", () => {
    for (const liveView of Object.values(ObserverLive)) {
      const flags = flagsOf(liveView, StageView.Builds);
      const on = [flags.previewOnStage, flags.cardOnStage, flags.pluginCardOnStage, flags.stillsOnStage];
      assert.deepEqual(on, [false, false, false, false]);
    }
  });
});

describe("Live's views of a folder with more than one", () => {
  const card = (at: string) => ({ live: ObserverLive.UnrealCard, at, observer: VIEWPORT });
  const preview = (at: string) => ({ live: ObserverLive.Preview, at, observer: PREVIEW_OBSERVER });
  const linked = (at: string): ProjectFact => ({ id: CoreFact.UnrealProject, path: at, source: FactSource.Link });
  const snaps = (facts: string[], fields: Record<string, unknown> = {}) => ({
    manifest: {
      id: "snaps",
      name: "Snaps",
      observers: [{ id: "view", facts, tool: "shot", live: ObserverLive.Stills, ...fields }],
    },
    enabled: true,
    removed: false,
  });

  it("a web game with an Unreal project in a folder has two views, the default first", () => {
    const both = game(fact(CoreFact.WebGame), fact(CoreFact.UnrealProject, "unreal"));
    for (const plugins of [[unreal(true)], [unreal(false)], []]) {
      const views = liveViewsFor(both, plugins);
      assert.deepEqual(views, [preview("."), card("unreal")]);
      assert.deepEqual(views[0], liveViewFor(both, plugins), "the first view is the one Live showed alone");
    }
    const made = game(fact(CoreFact.WebGame), linked("unreal"));
    assert.deepEqual(
      liveViewsFor(made, [unreal(true)]),
      [card("unreal"), preview(".")],
      "the Unreal project the game's engine link names comes first",
    );
  });

  it("a single-kind folder has one view", () => {
    for (const [what, kind] of [
      ["a web game", game(fact(CoreFact.WebGame))],
      ["an Unreal game", game(fact(CoreFact.UnrealProject))],
      ["a Godot game", game(fact(CoreFact.GodotProject))],
      ["no game", null],
    ] as const) {
      const views = liveViewsFor(kind, [unreal(true)]);
      assert.deepEqual(views, [liveViewFor(kind, [unreal(true)])], what);
    }
  });

  it("one view per kind of view: two Unreal projects make one Unreal tab", () => {
    const two = game(fact(CoreFact.WebGame), fact(CoreFact.UnrealProject, "b"), fact(CoreFact.UnrealProject, "a"));
    assert.deepEqual(liveViewsFor(two, [unreal(true)]), [preview("."), card("a")]);
    const sites = game(fact(CoreFact.WebGame), fact(CoreFact.WebGame, "web"));
    assert.deepEqual(liveViewsFor(sites, []), [preview(".")], "two sites make one Web game tab");
  });

  it("a remembered view that is still there is shown, any other falls back to the default", () => {
    const both = liveViewsFor(game(fact(CoreFact.WebGame), fact(CoreFact.UnrealProject, "unreal")), [unreal(true)]);
    assert.deepEqual(chosenLiveView(both, VIEWPORT), card("unreal"));
    assert.deepEqual(chosenLiveView(both, PREVIEW_OBSERVER), preview("."));
    const unrealOnly = liveViewsFor(game(fact(CoreFact.UnrealProject)), [unreal(true)]);
    assert.deepEqual(chosenLiveView(unrealOnly, PREVIEW_OBSERVER), card("."), "a view the folder no longer has");
    for (const garbage of ["../x", "", "x".repeat(10_000), null, undefined, 7, {}])
      assert.deepEqual(chosenLiveView(both, garbage), preview("."), String(garbage).slice(0, 20));
  });

  it("two plugins' pictures of one folder are two views, each named by its own label", () => {
    const sketches = {
      manifest: {
        id: "sketches",
        name: "Sketches",
        observers: [
          { id: "board", facts: [CoreFact.GodotProject], tool: "board", live: ObserverLive.Stills, label: "Board" },
        ],
      },
      enabled: true,
      removed: false,
    };
    const plugins = [snaps([CoreFact.GodotProject], { label: "Viewport" }), sketches];
    const views = liveViewsFor(game(fact(CoreFact.GodotProject)), plugins);
    assert.deepEqual(
      views.map((view) => [view.live, view.observer, liveViewLabel(view, plugins)]),
      [
        [ObserverLive.Stills, "snaps/view", "Viewport"],
        [ObserverLive.Stills, "sketches/board", "Board"],
      ],
    );
    const tabs = stageTabs({ views, plugins, hasBuilds: false, buildsLive: false, beside: null });
    assert.deepEqual(
      tabs.map((tab) => [tab.key, tab.label]),
      [
        ["live", "Viewport"],
        ["live-stills-sketches/board", "Board"],
        ["assets", "Assets"],
      ],
    );
    assert.deepEqual(tabChoice("live-stills-sketches/board", views), { view: StageView.Live, live: "sketches/board" });
    assert.equal(activeStageTab(StageView.Live, views, views[1]!), "live-stills-sketches/board");
    assert.equal(activeStageTab(StageView.Live, views, views[0]!), "live");
  });

  it("a plugin's card is a view of its own beside another plugin's pictures, only while its plugin is on", () => {
    const godotCard = (enabled: boolean) => ({
      manifest: {
        id: "godot",
        name: "Godot",
        observers: [
          { id: "viewport", facts: [CoreFact.GodotProject], tool: "hero", live: ObserverLive.Card, status: "stage" },
        ],
      },
      enabled,
      removed: false,
    });
    const folder = game(fact(CoreFact.GodotProject));
    const plugins = [godotCard(true), snaps([CoreFact.GodotProject], { label: "Board" })];
    const views = liveViewsFor(folder, plugins);
    assert.deepEqual(
      views.map((view) => [view.live, view.observer]),
      [
        [ObserverLive.Card, "godot/viewport"],
        [ObserverLive.Stills, "snaps/view"],
      ],
      "the card comes first, as the Unreal card does",
    );
    const tabs = stageTabs({ views, plugins, hasBuilds: false, buildsLive: false, beside: null });
    assert.deepEqual(
      tabs.map((tab) => [tab.key, tab.label]),
      [
        ["live", "Godot"],
        ["live-stills-snaps/view", "Board"],
        ["assets", "Assets"],
      ],
    );
    const second = liveViewsFor(folder, [snaps([CoreFact.GodotProject], { label: "Board" }), godotCard(true)]);
    const keys = stageTabs({ views: second, plugins, hasBuilds: false, buildsLive: false, beside: null });
    assert.equal(keys[1]?.key, "live-stills-snaps/view", "the card still leads, whatever the plugins' order");
    assert.deepEqual(
      liveViewFor(folder, [godotCard(false)]),
      { live: ObserverLive.Stills, at: ".", observer: null },
      "an off plugin's card doesn't count",
    );
    const beside = liveViewsFor(game(fact(CoreFact.WebGame), fact(CoreFact.GodotProject, "godot")), [godotCard(true)]);
    const besideTabs = stageTabs({ views: beside, plugins, hasBuilds: false, buildsLive: false, beside: null });
    assert.deepEqual(besideTabs[1], { key: "live-card-godot/viewport", label: "Godot" }, "beside a web game");
    assert.deepEqual(tabChoice("live-card-godot/viewport", beside), { view: StageView.Live, live: "godot/viewport" });
  });

  it("a plugin's stills view is named by its manifest label, else by the plugin's name", () => {
    const godot = game(fact(CoreFact.GodotProject));
    assert.equal(liveViewLabel(preview("."), []), STAGE_WORDS.tabs.webGame);
    assert.equal(liveViewLabel(card("unreal"), []), STAGE_WORDS.tabs.unreal);
    const labelled = [snaps([CoreFact.GodotProject], { label: "Viewport" })];
    assert.equal(liveViewLabel(liveViewFor(godot, labelled), labelled), "Viewport");
    const plain = [snaps([CoreFact.GodotProject])];
    assert.equal(liveViewLabel(liveViewFor(godot, plain), plain), "Snaps");
    assert.equal(liveViewLabel({ live: ObserverLive.Stills, at: ".", observer: null }, []), STAGE_WORDS.tabs.live);
  });
});
