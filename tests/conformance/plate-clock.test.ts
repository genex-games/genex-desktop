/**
 * The nameplate painter's clock: a plate draws nothing until it lights, moves only while lit on
 * screen as a GPU piece, paints once when a frame is owed, and the clock sleeps when nothing is due.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  FRAME_MS,
  frameDue,
  type PlateClockState,
  plateDue,
  plateMoves,
} from "../../src/renderer/nameplate/plate-clock.ts";

const LIT: PlateClockState = {
  visible: true,
  dirty: false,
  animating: true,
  still: false,
  reduced: false,
  resting: false,
  covered: false,
};

describe("nameplate clock", () => {
  it("moves a lit GPU plate on screen, and nothing else", () => {
    assert.equal(plateMoves(LIT), true);
    for (const change of [
      { animating: false },
      { visible: false },
      { still: true },
      { reduced: true },
      { resting: true },
      { covered: true },
    ] as const)
      assert.equal(plateMoves({ ...LIT, ...change }), false, JSON.stringify(change));
  });

  it("paints an owed frame once on screen, and sleeps when nothing is due", () => {
    const unlit = { ...LIT, animating: false };
    assert.equal(plateDue(unlit), false, "an unlit plate with no frame owed sleeps");
    assert.equal(plateDue({ ...unlit, dirty: true }), true, "an owed frame paints");
    assert.equal(plateDue({ ...unlit, dirty: true, visible: false }), false, "off screen it waits");
    assert.equal(plateDue({ ...LIT, still: true }), false, "a lit 2D still does not redraw every frame");
    assert.equal(plateDue({ ...LIT, reduced: true, dirty: true }), true, "under Reduce Motion it still paints once");
  });

  it("paces frames at about 30 a second, tolerating the display's jitter", () => {
    assert.equal(frameDue(1000, 0), true, "the first frame");
    assert.equal(frameDue(1000 + FRAME_MS - 1, 1000), true, "a frame a little early, on a 60 Hz beat");
    assert.equal(frameDue(1000 + 16.7, 1000), false, "one 60 Hz beat later is too soon");
  });
});
