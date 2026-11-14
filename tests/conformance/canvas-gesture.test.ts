import ceilings from "../fixtures/renderer-performance-ceilings.json" with { type: "json" };
import assert from "node:assert/strict";
import { it } from "node:test";
import * as gestures from "../../src/renderer/canvas-view.ts";

it("one hundred gesture moves paint once per frame and commit only once at rest", () => {
  let frame: (() => void) | undefined;
  let paints = 0;
  let commits = 0;
  const view = { current: { k: 1, tx: 0, ty: 0 } };
  const gesture = gestures.createCanvasGesture({
    view,
    schedule: (run) => {
      frame = run;
      return 1;
    },
    cancel: () => {
      frame = undefined;
    },
    paint: () => {
      paints++;
    },
    commit: () => {
      commits++;
    },
  });
  for (let index = 1; index <= 100; index++) gesture.move({ k: 1, tx: index, ty: index });
  assert.equal(commits, ceilings.gestureMidCommitCount);
  assert.equal(paints, 0);
  frame?.();
  assert.equal(paints, ceilings.gesturePaintsPerFrame);
  assert.equal(view.current.tx, 100);
  gesture.finish();
  assert.equal(commits, ceilings.gestureSettleCommitCount);
  gesture.finish();
  assert.equal(commits, ceilings.gestureSettleCommitCount);
  gesture.move({ k: 1, tx: 200, ty: 200 });
  gesture.dispose();
  assert.equal(frame, undefined);
  assert.equal(commits, ceilings.gestureSettleCommitCount);
});

it("StrictMode cleanup and motion call browser schedulers without rebinding their receiver", () => {
  const called: string[] = [];
  const nativeSchedule = function (this: unknown): number {
    if (this !== undefined) throw new TypeError("Illegal invocation");
    called.push("schedule");
    return 1;
  };
  const nativeCancel = function (this: unknown): void {
    if (this !== undefined) throw new TypeError("Illegal invocation");
    called.push("cancel");
  };
  const gesture = gestures.createCanvasGesture({
    view: { current: { k: 1, tx: 0, ty: 0 } },
    schedule: nativeSchedule,
    cancel: nativeCancel,
    paint: () => {},
    commit: () => {},
  });
  gesture.dispose();
  gesture.move({ k: 1, tx: 10, ty: 0 });
  gesture.finish();
  assert.deepEqual(called, ["cancel", "schedule", "cancel"]);
});

it("a wheel or drag that reaches the canvas from a page glides it: held from the first move, adopted once at rest", () => {
  let settle: (() => void) | undefined;
  let moves = 0;
  let finishes = 0;
  const held: boolean[] = [];
  const glide = gestures.createCanvasGlide({
    gesture: {
      move: () => {
        moves++;
      },
      finish: () => {
        finishes++;
      },
    },
    hold: (on) => held.push(on),
    wait: (run) => {
      settle = run;
      return setTimeout(() => {}, 0);
    },
    stop: (timer) => {
      clearTimeout(timer);
      settle = undefined;
    },
  });
  for (let index = 1; index <= 30; index++) glide.move({ k: 1 + index / 100, tx: index, ty: 0 });
  assert.equal(moves, 30, "every tick moves the camera, which paints once per frame");
  assert.equal(finishes, 0, "React learns nothing mid-gesture");
  assert.deepEqual(held, [true], "the layer lets the pointer through from the first tick, once");
  settle?.();
  assert.equal(finishes, 1, "once the ticks stop, the camera is adopted");
  assert.deepEqual(held, [true, false]);
  glide.move({ k: 1, tx: 0, ty: 0 });
  glide.end();
  assert.equal(finishes, 2, "a drag's last message ends it at once");
  assert.equal(settle, undefined, "with no settle left to run");
  assert.deepEqual(held, [true, false, true, false]);
  glide.end();
  assert.equal(finishes, 2, "an end with no gesture does nothing");
  glide.move({ k: 1, tx: 5, ty: 0 });
  glide.dispose();
  assert.deepEqual(held.at(-1), false, "an unmounted canvas never stays held");
  assert.equal(settle, undefined);
});

it("puts a canvas point back in the viewport under any camera, the inverse of reading one", () => {
  const view = { k: 0.5, tx: 100, ty: -40 };
  assert.deepEqual(gestures.viewportPoint(view, { x: 200, y: 80 }), { x: 200, y: 0 });
  assert.deepEqual(gestures.viewportPoint({ k: 1, tx: 0, ty: 0 }, { x: 7, y: 9 }), { x: 7, y: 9 });
});
