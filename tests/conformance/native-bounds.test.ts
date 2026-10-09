/**
 * The native game view follows its stage slot: dragging the window's edge or the chat
 * width handle moves the slot every frame, and the game must move with it, as a browser page
 * would, rather than wait for the drag to pause. It paints over the whole page, so what floats
 * beside it keeps off it (a tooltip beside the game must never be cut off where the game begins).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { anchoredBounds } from "../../src/main/preview-anchor.ts";
import { paddingOffView } from "../../src/renderer/native-view.ts";
import { type BoundsClock, scheduleBounds } from "../../src/renderer/panels/stage/bounds-schedule.ts";

/** Virtual animation frames; `frame()` runs the callbacks one display frame brings. */
function virtualClock() {
  let nextId = 1;
  const frames = new Map<number, () => void>();
  const clock: BoundsClock = {
    requestAnimationFrame: (callback) => {
      const id = nextId++;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame: (handle) => {
      frames.delete(handle);
    },
  };
  const frame = (): void => {
    const due = [...frames.values()];
    frames.clear();
    for (const callback of due) callback();
  };
  return { clock, frame, pending: () => frames.size };
}

describe("the native view's bounds during a drag", () => {
  it("are re-read in every frame the slot moves, not after the drag pauses", () => {
    const { clock, frame } = virtualClock();
    let reads = 0;
    const layout = scheduleBounds(() => reads++, clock);
    const DRAG_FRAMES = 30;
    for (let i = 0; i < DRAG_FRAMES; i++) {
      layout.signal();
      frame();
    }
    assert.equal(reads, DRAG_FRAMES);
  });

  it("are read once per frame however many layout signals that frame brings", () => {
    const { clock, frame } = virtualClock();
    let reads = 0;
    const layout = scheduleBounds(() => reads++, clock);
    for (let i = 0; i < 5; i++) layout.signal();
    frame();
    assert.equal(reads, 1);
  });

  it("leave nothing scheduled once the slot holds still, and nothing after stop", () => {
    const { clock, frame, pending } = virtualClock();
    let reads = 0;
    const layout = scheduleBounds(() => reads++, clock);
    layout.signal();
    frame();
    frame();
    assert.equal(pending(), 0);
    layout.signal();
    layout.stop();
    frame();
    assert.equal(reads, 1);
    assert.equal(pending(), 0);
  });
});

describe("the native view's bounds as the window resizes", () => {
  const slot = { x: 420, y: 64, width: 800, height: 600 };
  const viewport = { width: 1240, height: 680 };
  it("keep the slot's right and bottom margins in the window's new size", () => {
    assert.deepEqual(anchoredBounds(slot, viewport, { width: 1300, height: 700 }), {
      x: 420,
      y: 64,
      width: 860,
      height: 620,
    });
    assert.deepEqual(anchoredBounds(slot, viewport, { width: 1000, height: 500 }), {
      x: 420,
      y: 64,
      width: 560,
      height: 420,
    });
  });

  it("are the reported rectangle when the window has not changed since it was measured", () => {
    assert.deepEqual(anchoredBounds(slot, viewport, viewport), slot);
  });

  it("never grow a hidden view, go negative, or move without a measured window", () => {
    const hidden = { x: 0, y: 0, width: 0, height: 0 };
    assert.deepEqual(anchoredBounds(hidden, viewport, { width: 1400, height: 900 }), hidden);
    assert.deepEqual(anchoredBounds(slot, viewport, { width: 100, height: 50 }), { ...slot, width: 0, height: 0 });
    assert.deepEqual(anchoredBounds(slot, null, { width: 1400, height: 900 }), slot);
    assert.deepEqual(anchoredBounds(slot, viewport, null), slot);
  });
});

describe("what floats beside the native view", () => {
  // The window and the game as the settings fixture lays them out: the chat on the left, the game
  // from x 628 and y 48 to the window's corner. What floats keeps 4px clear of the game.
  const viewport = { width: 1440, height: 900 };
  const view = { left: 628, top: 48, right: 1440, bottom: 900 };
  const cases = [
    {
      name: "a control left of the game keeps its tooltip left of the game",
      trigger: { left: 200, top: 400, right: 228, bottom: 428 },
      padding: { right: 816 },
    },
    {
      name: "a control right of a game on the left keeps it right of the game",
      at: { left: 0, top: 48, right: 812, bottom: 900 },
      trigger: { left: 1000, top: 400, right: 1028, bottom: 428 },
      padding: { left: 816 },
    },
    {
      name: "a control above the game keeps it above",
      trigger: { left: 900, top: 10, right: 928, bottom: 38 },
      padding: { bottom: 856 },
    },
    {
      name: "a control below the game keeps it below",
      trigger: { left: 900, top: 900, right: 928, bottom: 928 },
      padding: { top: 904 },
    },
    {
      name: "the chat's More actions, off the game's corner, keeps to the roomier side: left",
      trigger: { left: 589, top: 14, right: 617, bottom: 42 },
      padding: { right: 816 },
    },
    {
      name: "a control over the game is not moved: nothing would keep it clear",
      trigger: { left: 900, top: 400, right: 928, bottom: 428 },
      padding: {},
    },
  ];
  for (const { name, at = view, trigger, padding } of cases)
    it(name, () => {
      assert.deepEqual(paddingOffView(trigger, at, viewport), padding);
    });
});
