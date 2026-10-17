/**
 * The stage strip's tabs: Live, Builds once there is a build, Assets and a file opened beside, as
 * they always were for a folder with one Live view; a folder with more than one (a web game and an
 * Unreal project) gets a tab per view in Live's place, each named by what it shows.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LiveView } from "../../src/renderer/live-views.ts";
import {
  activeStageTab,
  liveViewForBuild,
  stageTabs,
  tabChoice,
  webBuildView,
} from "../../src/renderer/panels/stage/stage-tabs.ts";
import { StageView } from "../../src/renderer/stage.ts";
import { ObserverLive, PREVIEW_OBSERVER, UNREAL_VIEWPORT_OBSERVER } from "../../src/shared/observers.ts";

const preview: LiveView = { live: ObserverLive.Preview, at: ".", observer: PREVIEW_OBSERVER };
const card: LiveView = { live: ObserverLive.UnrealCard, at: "unreal", observer: UNREAL_VIEWPORT_OBSERVER };
const stills: LiveView = { live: ObserverLive.Stills, at: ".", observer: null };
const plugins: never[] = [];

describe("the stage strip's tabs", () => {
  it("a folder with one view keeps the bar as it is", () => {
    for (const view of [preview, card, stills]) {
      const tabs = (hasBuilds: boolean, buildsLive: boolean) =>
        stageTabs({ views: [view], plugins, hasBuilds, buildsLive, beside: null });
      assert.deepEqual(tabs(false, false), [
        { key: "live", label: "Live" },
        { key: "assets", label: "Assets" },
      ]);
      assert.deepEqual(tabs(true, false), [
        { key: "live", label: "Live" },
        { key: "builds", label: "Builds" },
        { key: "assets", label: "Assets" },
      ]);
      assert.deepEqual(tabs(true, true)[1], { key: "builds", label: "Builds ●" });
    }
    const beside = (target: Parameters<typeof stageTabs>[0]["beside"]) =>
      stageTabs({ views: [preview], plugins, hasBuilds: false, buildsLive: false, beside: target }).at(-1);
    assert.deepEqual(beside({ kind: "file", path: "src/game/main.js" }), {
      key: "file",
      label: "main.js",
      icon: "file",
    });
    assert.deepEqual(beside({ kind: "image", name: "hero.png", src: "data:," }), {
      key: "file",
      label: "hero.png",
      icon: "image",
    });
    assert.deepEqual(beside({ kind: "file", path: "a-very-long-file-name-that-keeps-going.js" }), {
      key: "file",
      label: "a-very-long-fi…s-going.js",
      icon: "file",
    });
  });

  it("a folder with two views gets a tab for each, named by what it shows, before Builds and Assets", () => {
    const tabs = stageTabs({ views: [preview, card], plugins, hasBuilds: true, buildsLive: false, beside: null });
    assert.deepEqual(tabs, [
      { key: "live", label: "Web game" },
      { key: "live-unreal-card", label: "Unreal" },
      { key: "builds", label: "Builds" },
      { key: "assets", label: "Assets" },
    ]);
    const unrealFirst = stageTabs({
      views: [card, preview],
      plugins,
      hasBuilds: false,
      buildsLive: false,
      beside: null,
    });
    assert.deepEqual(
      unrealFirst.map((tab) => [tab.key, tab.label]),
      [
        ["live", "Unreal"],
        ["live-preview", "Web game"],
        ["assets", "Assets"],
      ],
    );
    assert.ok(!tabs.some((tab) => tab.label === "Live"), "no tab says Live");
  });

  it("the active tab is the chosen view's while Live is on stage, else the stage view's", () => {
    assert.equal(activeStageTab(StageView.Live, [preview, card], card), "live-unreal-card");
    assert.equal(activeStageTab(StageView.Live, [preview, card], preview), "live");
    assert.equal(activeStageTab(StageView.Builds, [preview, card], card), "builds");
    assert.equal(activeStageTab(StageView.File, [preview, card], card), "file");
    assert.equal(activeStageTab(StageView.Live, [card], card), "live", "one view: the Live tab");
  });

  it("a tab press says which stage view and which Live view it means", () => {
    const views = [preview, card];
    assert.deepEqual(tabChoice("live", views), { view: StageView.Live, live: PREVIEW_OBSERVER });
    assert.deepEqual(tabChoice("live-unreal-card", views), { view: StageView.Live, live: UNREAL_VIEWPORT_OBSERVER });
    assert.deepEqual(tabChoice("live", [stills]), { view: StageView.Live, live: null });
    assert.deepEqual(tabChoice("builds", views), { view: StageView.Builds });
    assert.deepEqual(tabChoice("assets", views), { view: StageView.Assets });
    assert.deepEqual(tabChoice("file", views), { view: StageView.File });
    for (const unknown of ["live-stills", "live-preview", "theatre", "", "live-"])
      assert.equal(tabChoice(unknown, views), null, unknown);
  });

  it("putting a web build on the stage chooses the Web game view", () => {
    assert.deepEqual(liveViewForBuild([card, preview]), preview);
    assert.deepEqual(liveViewForBuild([preview, card]), preview);
    assert.equal(liveViewForBuild([card]), null, "a folder with no web game keeps its view");
  });

  it("a web build shown for a game remembers its Web game view: the stage's game by its views, another by the preview", () => {
    assert.equal(webBuildView("garden", "garden", [card, preview]), PREVIEW_OBSERVER);
    assert.equal(webBuildView("garden", "garden", [card]), null, "the stage's folder with no web game keeps its view");
    assert.equal(webBuildView("other", "garden", [card]), PREVIEW_OBSERVER, "another game's views aren't read here");
    assert.equal(webBuildView("other", null, []), PREVIEW_OBSERVER, "with no game on the stage");
    for (const garbage of [undefined, null, "", 7, {}])
      assert.equal(webBuildView(garbage, "garden", [card, preview]), null, String(garbage));
  });
});
