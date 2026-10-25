/**
 * The Genex page's Connect band: one press turns the plugin on and signs in when needed, and the
 * band's lines run from every routed tool into the action, faster while Connect is pointed at.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GenexTool } from "../../src/shared/asset-making.ts";
import type { PluginInfo } from "../../src/shared/plugins.ts";
import manifest from "../../src/plugins/genex/plugin.json" with { type: "json" };
import {
  BAND_SPOTS,
  ConnectArtState,
  connectArtState,
  LINE_GAP,
  lineStart,
  linePoint,
  MAX_STEP_SECONDS,
  pulseHead,
  pulseSpeed,
  pulsesPerLine,
  travelAfter,
} from "../../src/renderer/panels/plugins/genex/connect-art.ts";
import { turnOnAndConnect } from "../../src/renderer/panels/plugins/genex/connect-genex.ts";
import { GenexAccountKind } from "../../src/renderer/panels/plugins/genex/genex-view.ts";
import { fakeStudioApi, installFakeStudio } from "../helpers/fake-studio-api.ts";

const genex = { manifest, enabled: false } as unknown as PluginInfo;

/** The page's one-action-at-a-time runner, keeping what failed as the page does. */
function pageRunner() {
  const failures: string[] = [];
  return {
    failures,
    act: async (fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (e) {
        failures.push(String(e));
      }
    },
  };
}

describe("Connect while the Genex plugin is off", () => {
  /** The app's account: signed in or not, with every sign-in it is asked for counted. */
  const account = (signedIn: boolean) => {
    const signIns: number[] = [];
    return { signedIn, signIns, signIn: async () => void signIns.push(signIns.length + 1) };
  };

  it("turns the plugin on, then signs in to Genex when the app is signed out", async () => {
    const studio = fakeStudioApi();
    const restore = installFakeStudio(studio);
    try {
      const page = pageRunner();
      const signedOut = account(false);
      await turnOnAndConnect(genex, page, signedOut);
      assert.deepEqual(studio.callsOf("pluginEnable"), [["genex", true]]);
      assert.equal(signedOut.signIns.length, 1);
      assert.deepEqual(page.failures, []);
    } finally {
      restore();
    }
  });

  it("only turns the plugin on when the app is already signed in: the account outlives the switch", async () => {
    const studio = fakeStudioApi();
    const restore = installFakeStudio(studio);
    try {
      const signedIn = account(true);
      await turnOnAndConnect(genex, pageRunner(), signedIn);
      assert.deepEqual(studio.callsOf("pluginEnable"), [["genex", true]]);
      assert.equal(signedIn.signIns.length, 0);
    } finally {
      restore();
    }
  });

  it("signs in to nothing when the plugin could not be turned on, and says why", async () => {
    const studio = fakeStudioApi();
    studio.stub("pluginEnable", async () => {
      throw new Error("Install the plugin first");
    });
    const restore = installFakeStudio(studio);
    try {
      const page = pageRunner();
      const signedOut = account(false);
      await turnOnAndConnect(genex, page, signedOut);
      assert.equal(signedOut.signIns.length, 0);
      assert.match(page.failures.join(), /Install the plugin first/);
    } finally {
      restore();
    }
  });
});

describe("the Connect band's lines", () => {
  it("light up for a sign-in in the browser and hold once connected; every other state waits", () => {
    assert.equal(connectArtState(GenexAccountKind.Connected), ConnectArtState.Connected);
    assert.equal(connectArtState(GenexAccountKind.SigningIn), ConnectArtState.SigningIn);
    for (const kind of [
      null,
      GenexAccountKind.Loading,
      GenexAccountKind.SignedOut,
      GenexAccountKind.Terms,
      GenexAccountKind.Checking,
      GenexAccountKind.Attention,
    ])
      assert.equal(connectArtState(kind), ConnectArtState.Waiting, String(kind));
  });

  it("give every tool in the band its own place inside the logos' field, and leave the chat app's logo out", () => {
    const spots = [...BAND_SPOTS.values()];
    for (const spot of spots) {
      assert.ok(spot.x > 0 && spot.x < 1 && spot.y > 0 && spot.y < 1, JSON.stringify(spot));
    }
    assert.equal(new Set(spots.map((spot) => `${spot.x},${spot.y}`)).size, spots.length);
    assert.equal(BAND_SPOTS.has(GenexTool.GptImage), false);
    assert.equal(BAND_SPOTS.size, Object.values(GenexTool).length - 1);
  });

  it("start just clear of each logo's edge", () => {
    const from = { x: 40, y: 60 };
    const to = { x: 520, y: 120 };
    const clearance = 11 + LINE_GAP;
    const start = lineStart(from, to, clearance);
    const at = linePoint(from, to, start);
    const distance = Math.hypot(at.x - from.x, at.y - from.y);
    assert.ok(distance >= clearance && distance < clearance + 12, String(distance));
    assert.equal(lineStart(from, { x: 45, y: 62 }, clearance), 1, "an action inside the logo's room draws no line");
  });

  it("run from the logo to the action", () => {
    const from = { x: 20, y: 40 };
    const to = { x: 500, y: 120 };
    assert.deepEqual(linePoint(from, to, 0), from);
    assert.deepEqual(linePoint(from, to, 1), to);
    const middle = linePoint(from, to, 0.5);
    assert.ok(middle.x > from.x && middle.x < to.x && middle.y > from.y && middle.y < to.y);
  });

  it("carry light faster while Connect is pointed at, quickest in the browser, steady once connected", () => {
    const resting = pulseSpeed(ConnectArtState.Waiting, 0);
    const pointed = pulseSpeed(ConnectArtState.Waiting, 1);
    assert.ok(pointed > resting);
    assert.equal(pulseSpeed(ConnectArtState.Waiting, 5), pointed, "heat stops at fully pointed at");
    assert.ok(pulseSpeed(ConnectArtState.SigningIn, 0) > resting);
    assert.ok(pulseSpeed(ConnectArtState.Connected, 0) > resting);
    assert.equal(pulsesPerLine(ConnectArtState.Connected), 2);
    assert.equal(pulsesPerLine(ConnectArtState.Waiting), 1);
  });

  it("never send two lines' light in step", () => {
    for (const travel of [0, 0.5, 11.2]) {
      const heads = Object.values(GenexTool).map((_, index) => pulseHead(travel, index, 0, 1));
      for (const head of heads) assert.ok(head >= 0 && head < 1, String(head));
      assert.equal(new Set(heads.map((head) => head.toFixed(4))).size, heads.length);
    }
  });

  it("speed the light up where it is when Connect is pointed at, after a long wait too", () => {
    const frame = 1 / 30;
    let travel = travelAfter(0, pulseSpeed(ConnectArtState.Waiting, 0), 600);
    assert.ok(travel <= MAX_STEP_SECONDS, "a paused band picks up where it was");
    let heat = 0;
    for (let step = 0; step < 90; step++) {
      heat += (1 - heat) * 0.08;
      const next = travelAfter(travel, pulseSpeed(ConnectArtState.Waiting, heat), frame);
      for (const index of Object.values(GenexTool).keys()) {
        const moved = (pulseHead(next, index, 0, 1) - pulseHead(travel, index, 0, 1) + 1) % 1;
        assert.ok(moved < 0.03, `line ${index} jumped ${moved.toFixed(3)} at step ${step}`);
      }
      travel = next;
    }
  });
});
