/**
 * When a live background draws and how far its clock moves: a moving canvas keeps one clock across
 * every change to what it draws (a slider being dragged never holds it still), new colours let its
 * trails go once they hold rather than at every change, and a still canvas runs up to its moment
 * only when changes pause, drawing one cheap frame for each change in a stream of them. The
 * Background button glints until the panel is first opened.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  changeStage,
  frameStep,
  RECOLOUR_SETTLE_MS,
  recolourDue,
  STILL_SETTLE_MS,
  StillDraw,
  stageClock,
  stillSettled,
  stopClock,
} from "../../src/renderer/home-backdrop/stage-clock.ts";
import { backdropButtonFound, markBackdropButtonFound } from "../../src/renderer/home-backdrop/store.ts";
import type { KeyValueStorage } from "../../src/renderer/storage.ts";

const FRAME_MS = 1000 / 60;
const moving = (now: number, recoloured = false) => ({ moving: true, recoloured, now });
const still = (now: number) => ({ moving: false, recoloured: false, now });

describe("a live background's clock", () => {
  it("keeps moving while what it draws changes: a change never restarts the loop or its clock", () => {
    const clock = stageClock(60);
    assert.equal(changeStage(clock, moving(0)).start, true);
    assert.equal(frameStep(clock, 1000), 0);
    let time = 0;
    for (let frame = 1; frame <= 30; frame++) {
      // A slider dragged: a change before every frame.
      assert.deepEqual(changeStage(clock, moving(1000 + frame * FRAME_MS - 4)), { start: false, still: null });
      time += frameStep(clock, 1000 + frame * FRAME_MS) ?? 0;
    }
    assert.ok(Math.abs(time - 0.5) < 0.001, `the clock moved ${time} s in half a second`);
  });

  it("draws at most at its rate, and a long pause moves it a tenth of a second", () => {
    const clock = stageClock(30);
    changeStage(clock, moving(0));
    assert.equal(frameStep(clock, 100), 0);
    assert.equal(frameStep(clock, 100 + FRAME_MS), null);
    assert.ok(Math.abs((frameStep(clock, 100 + 2 * FRAME_MS) ?? 0) - 2 / 60) < 1e-9);
    assert.equal(frameStep(clock, 5000), 0.1);
  });

  it("starts from its first frame again after it stops", () => {
    const clock = stageClock(60);
    changeStage(clock, moving(0));
    frameStep(clock, 100);
    stopClock(clock);
    assert.equal(changeStage(clock, moving(900)).start, true);
    assert.equal(frameStep(clock, 1000), 0);
  });

  it("lets the frame before go once new colours have held, once for a stream of them", () => {
    const clock = stageClock(60);
    changeStage(clock, moving(0));
    for (const at of [10, 60, 110]) changeStage(clock, moving(at, true));
    assert.equal(recolourDue(clock, 110 + RECOLOUR_SETTLE_MS - 1), false);
    assert.equal(recolourDue(clock, 110 + RECOLOUR_SETTLE_MS), true);
    assert.equal(recolourDue(clock, 110 + RECOLOUR_SETTLE_MS + 50), false);
  });

  it("runs a still canvas up at once, draws cheaply while changes stream, and runs up when they pause", () => {
    const clock = stageClock(30);
    assert.deepEqual(changeStage(clock, still(0)), { start: false, still: StillDraw.RunUp });
    assert.equal(changeStage(clock, still(40)).still, StillDraw.Quick);
    assert.equal(changeStage(clock, still(80)).still, StillDraw.Quick);
    assert.equal(stillSettled(clock, 80 + STILL_SETTLE_MS - 1), false);
    assert.equal(stillSettled(clock, 80 + STILL_SETTLE_MS), true);
    assert.equal(changeStage(clock, still(80 + 3 * STILL_SETTLE_MS)).still, StillDraw.RunUp);
  });

  it("stops moving when it is asked to hold still", () => {
    const clock = stageClock(60);
    changeStage(clock, moving(0));
    assert.equal(changeStage(clock, still(500)).start, false);
    assert.equal(clock.running, false);
  });
});

describe("the Background button's glint", () => {
  const storage = (): KeyValueStorage => {
    const kept = new Map<string, string>();
    return {
      getItem: (key) => kept.get(key) ?? null,
      setItem: (key, value) => void kept.set(key, value),
      removeItem: (key) => void kept.delete(key),
    };
  };

  it("glints until the panel is first opened, and never again on this Mac", () => {
    const mac = storage();
    assert.equal(backdropButtonFound(mac), false);
    markBackdropButtonFound(mac);
    assert.equal(backdropButtonFound(mac), true);
    assert.equal(backdropButtonFound(storage()), false);
  });

  it("stops glinting when nothing can be remembered", () => {
    assert.equal(backdropButtonFound(null), true);
  });
});
