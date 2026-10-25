/**
 * The Roblox game's publishing card as data: the strip shows its Publish only for a game holding a
 * Roblox place with the Roblox plugin on, and the card shows the stage `publish-status` puts it at,
 * a publish under way until it ends and an ended one for a while, then the next press.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  IDLE_POLL_MS,
  PUBLISHING_POLL_MS,
  pollAfterMs,
  RESULT_SHOWN_MS,
  RobloxCardStage,
  robloxCardView,
  robloxPublishShown,
} from "../../src/renderer/panels/plugins/roblox/roblox-publish-view.ts";
import { ROBLOX_PLUGIN_ID } from "../../src/shared/observers.ts";
import type { PluginInfo } from "../../src/shared/plugins.ts";
import { CoreFact } from "../../src/shared/project-facts.ts";
import { RobloxPublishKind, RobloxPublishPhase, type RobloxPublishState } from "../../src/shared/roblox-publish.ts";
import { StepState } from "../../src/renderer/ui/step-bar.ts";

const NOW = 10_000_000;
const PLACE_ID = "7781440219";
const ROBLOX_FACTS = [{ id: CoreFact.RobloxProject, path: "sky-race.rbxlx" }];

const roblox = (over: Partial<PluginInfo> = {}) =>
  ({ manifest: { id: ROBLOX_PLUGIN_ID }, enabled: true, removed: false, ...over }) as PluginInfo;
const published = (over: Partial<RobloxPublishState> = {}): RobloxPublishState => ({
  linked: true,
  published: true,
  canClick: true,
  placeId: PLACE_ID,
  ...over,
});

describe("the strip's Publish for a Roblox game", () => {
  it("shows only for a game holding a Roblox place with the Roblox plugin on", () => {
    assert.equal(robloxPublishShown([roblox()], "sky-race", ROBLOX_FACTS), true);
    const hidden: Array<[string, PluginInfo[], string | null, typeof ROBLOX_FACTS]> = [
      ["no game", [roblox()], null, ROBLOX_FACTS],
      ["no Roblox place", [roblox()], "sky-race", []],
      ["plugin off", [roblox({ enabled: false })], "sky-race", ROBLOX_FACTS],
      ["plugin removed", [roblox({ removed: true })], "sky-race", ROBLOX_FACTS],
      ["no plugin", [], "sky-race", ROBLOX_FACTS],
    ];
    for (const [why, plugins, project, facts] of hidden)
      assert.equal(robloxPublishShown(plugins, project, facts), false, why);
  });
});

describe("the publishing card", () => {
  it("waits for the first answer, then offers setup, Studio's clicks or the press", () => {
    assert.equal(robloxCardView(null, NOW).stage, RobloxCardStage.Loading);
    assert.equal(robloxCardView(published({ linked: false }), NOW).stage, RobloxCardStage.NoPlace);
    assert.equal(robloxCardView(published({ canClick: false }), NOW).stage, RobloxCardStage.ByHand);
    const update = robloxCardView(published(), NOW);
    assert.deepEqual(
      { stage: update.stage, first: update.first, url: update.url },
      { stage: RobloxCardStage.Ready, first: false, url: `https://www.roblox.com/games/${PLACE_ID}` },
    );
    const first = robloxCardView({ linked: true, published: false, canClick: true, name: "Sky Race" }, NOW);
    assert.deepEqual(
      { stage: first.stage, first: first.first, name: first.name, url: first.url },
      { stage: RobloxCardStage.Ready, first: true, name: "Sky Race", url: undefined },
    );
  });

  it("follows a publish under way however long it runs, with its steps and the faster read", () => {
    const attempt = { phase: RobloxPublishPhase.Publishing, kind: RobloxPublishKind.First, at: 0, name: "Sky Racers" };
    const view = robloxCardView(published({ published: false, attempt }), NOW + RESULT_SHOWN_MS);
    assert.equal(view.stage, RobloxCardStage.Publishing);
    assert.equal(view.first, true);
    assert.equal(view.name, "Sky Racers");
    assert.deepEqual(
      view.steps.map((step) => step.state),
      [StepState.Done, StepState.Current, StepState.Next],
    );
    assert.equal(pollAfterMs(view), PUBLISHING_POLL_MS);
  });

  it("shows how a publish ended for a while, then offers the next one", () => {
    const stopped = {
      phase: RobloxPublishPhase.Stopped,
      kind: RobloxPublishKind.Update,
      at: NOW,
      detail: "Roblox asks for an age check.",
    };
    const shown = robloxCardView(published({ attempt: stopped }), NOW + RESULT_SHOWN_MS);
    assert.equal(shown.stage, RobloxCardStage.Stopped);
    assert.equal(shown.detail, "Roblox asks for an age check.");
    assert.equal(pollAfterMs(shown), IDLE_POLL_MS);
    const done = { phase: RobloxPublishPhase.Published, kind: RobloxPublishKind.Update, at: NOW };
    assert.equal(robloxCardView(published({ attempt: done }), NOW + 1).stage, RobloxCardStage.Published);
    const later = robloxCardView(published({ attempt: stopped }), NOW + RESULT_SHOWN_MS + 1);
    assert.equal(later.stage, RobloxCardStage.Ready);
    assert.equal(later.detail, undefined);
  });
});
