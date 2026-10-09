/**
 * Agent screens in the Builds graph: a working node is its agent's screen. The
 * frame says what the agent did as a code, the node words it ("Pressing Space · 3s"), the step
 * joins its screen on the run and the part, and a selected node's card steps back through the
 * window's last few frames.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { coverCursor } from "../../src/renderer/panels/inspector/screen-cursor.ts";
import {
  frameReceived,
  leadFrameOf,
  partFrameOf,
  screenClosed,
  screensLoaded,
  TRAIL_FRAMES,
  trailOf,
  type AgentScreensState,
} from "../../src/renderer/state/agent-screens.ts";
import { keysWords, screenAgo, screenDoing, screenDone } from "../../src/renderer/words.ts";
import { type AgentScreenFrame, ScreenDeed } from "../../src/shared/agent-screen.ts";
import { computerAct, type ComputerRequest } from "../../src/substrate/computer-tool.ts";

const EMPTY: AgentScreensState = { frames: [], trails: {} };

function frame(overrides: Partial<AgentScreenFrame> = {}): AgentScreenFrame {
  return {
    handle: "pv-1",
    label: "Jump pad",
    project: "pond",
    runId: "run_a",
    facetId: "jump-pad",
    role: "builder",
    jpeg: "AAAA",
    width: 960,
    height: 600,
    cursor: { x: 480, y: 300 },
    caption: null,
    at: 1,
    ...overrides,
  };
}

describe("what an action shows on the agent's screen", () => {
  const act = (request: Partial<ComputerRequest> & Pick<ComputerRequest, "action">) =>
    computerAct(request as ComputerRequest);
  it("names each action's deed, and a press's keys as the agent gave them", () => {
    assert.deepEqual(act({ action: "key", text: "space" }), { deed: ScreenDeed.Press, keys: ["space"] });
    assert.deepEqual(act({ action: "hold_key", text: "ArrowRight", duration: 2 }), {
      deed: ScreenDeed.Press,
      keys: ["ArrowRight"],
    });
    assert.deepEqual(act({ action: "key" }), { deed: ScreenDeed.Press }, "a press with no keys says none");
    assert.deepEqual(act({ action: "double_click", coordinate: [1, 2] }), { deed: ScreenDeed.Click });
    assert.deepEqual(act({ action: "left_click_drag" }), { deed: ScreenDeed.Drag });
    assert.deepEqual(act({ action: "type", text: "hello" }), { deed: ScreenDeed.Type }, "typed text is not shown");
    assert.deepEqual(act({ action: "screenshot" }), { deed: ScreenDeed.Look });
    assert.deepEqual(act({ action: "camera", text: "top" }), { deed: ScreenDeed.Look });
    assert.deepEqual(act({ action: "wait", duration: 1 }), { deed: ScreenDeed.Wait });
    assert.deepEqual(act({ action: "reload" }), { deed: ScreenDeed.Reload });
  });
});

describe("the words for a screen", () => {
  it("says what the agent is doing on the node and what it did on the trail", () => {
    assert.equal(screenDoing({ deed: ScreenDeed.Press, keys: ["space"] }), "Pressing Space");
    assert.equal(screenDoing({ deed: ScreenDeed.Look }), "Looking around");
    assert.equal(screenDoing({ deed: ScreenDeed.Load }), "Opening the game");
    assert.equal(screenDone({ deed: ScreenDeed.Press, keys: ["ArrowRight"] }), "Pressed →");
    assert.equal(screenDone({ deed: ScreenDeed.Click }), "Clicked");
    assert.equal(screenDoing(undefined), "Playing", "a frame from before deeds had codes");
    assert.equal(screenDone(undefined), "Played");
    assert.equal(screenDoing({ deed: "fly" as ScreenDeed }), "Playing", "a deed this build does not know");
  });
  it("reads keys the way a player does", () => {
    assert.equal(keysWords(["space"]), "Space");
    assert.equal(keysWords(["shift+w"]), "Shift+W");
    assert.equal(keysWords(["w", "ArrowUp"]), "W+↑");
    assert.equal(keysWords(["Return"]), "Enter");
    assert.equal(keysWords(["+"]), "+");
    assert.equal(keysWords(["constructor"]), "Constructor", "a name that is also an object key");
  });
  it("gives a frame's age short on a node and long on a card", () => {
    assert.equal(screenAgo(10_000, 11_000), "now");
    assert.equal(screenAgo(10_000, 13_000), "3s");
    assert.equal(screenAgo(10_000, 13_000, { ago: true }), "3s ago");
    assert.equal(screenAgo(0, 125_000), "2m");
    assert.equal(screenAgo(20_000, 10_000), "now", "a frame stamped after the clock is now");
  });
});

describe("a window's trail", () => {
  it("keeps the last few frames of one agent, newest last", () => {
    let state = EMPTY;
    const sent = Array.from({ length: TRAIL_FRAMES + 3 }, (_, at) => frame({ at }));
    for (const item of sent) state = frameReceived(state, item);
    assert.deepEqual(
      trailOf(state, "pv-1").map((item) => item.at),
      sent.slice(-TRAIL_FRAMES).map((item) => item.at),
    );
    assert.equal(state.frames.length, 1, "one newest frame per window");
    assert.equal(trailOf(state, "pv-1"), trailOf(state, "pv-1"), "the same trail until a frame arrives");
  });
  it("starts again when a pooled window is lent to another agent, and goes when it closes", () => {
    let state = frameReceived(EMPTY, frame({ at: 1 }));
    state = frameReceived(state, frame({ at: 2 }));
    state = frameReceived(state, frame({ at: 3, label: "Coin counter", facetId: "coins" }));
    assert.deepEqual(
      trailOf(state, "pv-1").map((item) => item.at),
      [3],
    );
    state = screenClosed(state, "pv-1");
    assert.deepEqual(trailOf(state, "pv-1"), []);
    assert.equal(screenClosed(state, "pv-1"), state, "closing twice changes nothing");
  });
  it("seeds trails from what main holds after a reload", () => {
    const state = screensLoaded(EMPTY, [frame({ at: 5 }), frame({ handle: "pv-2", at: 6 })]);
    assert.equal(trailOf(state, "pv-2").length, 1);
    assert.equal(screensLoaded(state, []), state);
  });
});

describe("which screen a node shows", () => {
  const frames = [
    frame({ handle: "old", at: 1 }),
    frame({ handle: "new", role: "playtester", at: 5 }),
    frame({ handle: "lead", role: "director", facetId: "director", at: 9 }),
    frame({ handle: "other-part", facetId: "coins", at: 7 }),
    frame({ handle: "other-run", runId: "run_b", at: 8 }),
    frame({ handle: "other-game", project: "kart", at: 9 }),
  ];
  const state: AgentScreensState = { frames, trails: {} };
  it("a step shows the newest screen of its part's agent in its run and game, never the lead's", () => {
    assert.equal(partFrameOf(state, "pond", "run_a", "jump-pad")?.handle, "new");
    assert.equal(partFrameOf(state, "pond", "run_a", "coins")?.handle, "other-part");
    assert.equal(partFrameOf(state, "pond", "run_a", "director"), undefined);
    assert.equal(partFrameOf(state, "pond", "run_c", "jump-pad"), undefined);
    assert.equal(partFrameOf(state, null, "run_a", "jump-pad"), undefined);
  });
  it("the lead's node shows only the lead's", () => {
    assert.equal(leadFrameOf(state, "pond", "run_a")?.handle, "lead");
  });
});

describe("the agent's cursor on a node", () => {
  it("sits where it is when the frame and the node share a shape", () => {
    const at = coverCursor({ width: 960, height: 600, cursor: { x: 240, y: 150 } }, { w: 176, h: 110 });
    assert.ok(Math.abs(at.left - 25) < 1e-9 && Math.abs(at.top - 25) < 1e-9, JSON.stringify(at));
  });
  it("moves with the crop when the frame is wider than the node", () => {
    // A 2:1 frame covering a 1:1 node loses a quarter on each side.
    const at = coverCursor({ width: 200, height: 100, cursor: { x: 50, y: 50 } }, { w: 100, h: 100 });
    assert.deepEqual(at, { left: 0, top: 50 });
  });
});
