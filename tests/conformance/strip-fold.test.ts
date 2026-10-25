/**
 * The stage strip makes room in steps instead of letting its first row run under the window's
 * controls: the views fold into one button, then the plugin buttons move to a second row, then
 * Sound and Full screen join them. `nextFold` takes the next step while the first row overflows;
 * `useStripFold` starts again from one row whenever the strip grows, so the step depends only on
 * the width (the narrowing and widening passes of `tests/e2e/run-stage-strip-fit.mjs`).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { nextFold, STRIP_STEPS, StripFoldStep } from "../../src/renderer/panels/stage/strip-fold.ts";

test("a first row that fits takes no step", () => {
  assert.equal(nextFold(StripFoldStep.Full, { row: 600, room: 600 }), StripFoldStep.Full);
  assert.equal(nextFold(StripFoldStep.Full, { row: 320, room: 900 }), StripFoldStep.Full);
  assert.equal(nextFold(StripFoldStep.Views, { row: 480, room: 482 }), StripFoldStep.Views);
  assert.equal(
    nextFold(StripFoldStep.Full, { row: 600.6, room: 600 }),
    StripFoldStep.Full,
    "a fraction past the room is rounding",
  );
});

test("an overflowing first row folds the views first, then moves the plugin buttons, then Sound and Full screen", () => {
  assert.deepEqual(STRIP_STEPS, [StripFoldStep.Full, StripFoldStep.Views, StripFoldStep.Plugins, StripFoldStep.Game]);
  assert.equal(nextFold(StripFoldStep.Full, { row: 586, room: 482 }), StripFoldStep.Views);
  assert.equal(nextFold(StripFoldStep.Views, { row: 561, room: 482 }), StripFoldStep.Plugins);
  assert.equal(nextFold(StripFoldStep.Plugins, { row: 258, room: 249 }), StripFoldStep.Game);
});

test("the last step stays when even its first row overflows", () => {
  assert.equal(nextFold(StripFoldStep.Game, { row: 220, room: 200 }), StripFoldStep.Game);
});

test("from one row, the steps a width needs are the ones whose first row overflowed", () => {
  // The first row's reach at each step for a game with two views, Play/Stop, Reload, Sound, Full
  // screen, Make multiplayer and Publish, as measured in the app.
  const reach = { full: 586, views: 561, plugins: 258, game: 178 } as const;
  const settle = (room: number) => {
    let step: StripFoldStep = StripFoldStep.Full;
    for (const _ of STRIP_STEPS) {
      const next = nextFold(step, { row: reach[step], room });
      if (next === step) break;
      step = next;
    }
    return step;
  };
  assert.equal(settle(609), StripFoldStep.Full);
  assert.equal(settle(570), StripFoldStep.Views);
  assert.equal(settle(489), StripFoldStep.Plugins);
  assert.equal(settle(249), StripFoldStep.Game);
});
