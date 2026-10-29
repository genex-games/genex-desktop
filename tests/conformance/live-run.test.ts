/**
 * The strip's Play/Stop is one button: Stop while the game runs, Play once it is stopped, and a
 * spinner in its place while either is under way. Full screen is offered only while the game
 * itself is on the stage, and Play/Stop and the sound only once the game has something to run.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { fullScreenOffered, gameControlsShown, LiveRun, liveRun } from "../../src/renderer/panels/stage/live-run.ts";

test("the button follows the game: running, stopping, stopped, starting", () => {
  assert.equal(liveRun({ stopped: false, stopping: false, starting: false }), LiveRun.Running);
  assert.equal(liveRun({ stopped: false, stopping: true, starting: false }), LiveRun.Stopping);
  assert.equal(liveRun({ stopped: true, stopping: false, starting: false }), LiveRun.Stopped);
  assert.equal(liveRun({ stopped: false, stopping: false, starting: true }), LiveRun.Starting);
});

test("a press under way wins over what the last probe said", () => {
  assert.equal(liveRun({ stopped: false, stopping: true, starting: true }), LiveRun.Stopping);
  assert.equal(liveRun({ stopped: true, stopping: false, starting: true }), LiveRun.Starting);
});

test("full screen is offered only while the running game is on the stage", () => {
  const shown = { run: LiveRun.Running, live: true, loading: false, empty: false };
  assert.equal(fullScreenOffered(shown), true);
  assert.equal(fullScreenOffered({ ...shown, run: LiveRun.Stopped }), false);
  assert.equal(fullScreenOffered({ ...shown, run: LiveRun.Starting }), false);
  assert.equal(fullScreenOffered({ ...shown, live: false }), false);
  assert.equal(fullScreenOffered({ ...shown, loading: true }), false);
  assert.equal(fullScreenOffered({ ...shown, empty: true }), false);
});

test("Live's Native view offers full screen while its game plays, as the web view does while it runs", () => {
  const shown = { run: LiveRun.Running, live: true, loading: false, empty: false };
  assert.equal(fullScreenOffered({ ...shown, native: { playing: true } }), true);
  assert.equal(fullScreenOffered({ ...shown, native: { playing: false } }), false, "starting, building or ended");
  assert.equal(fullScreenOffered({ ...shown, live: false, native: { playing: true } }), false, "out of sight");
  assert.equal(fullScreenOffered({ ...shown, empty: true, native: { playing: true } }), false);
  // The web page's own loader and Stop say nothing about the Native view's game.
  assert.equal(fullScreenOffered({ ...shown, loading: true, native: { playing: true } }), true);
  assert.equal(fullScreenOffered({ ...shown, run: LiveRun.Stopped, native: { playing: true } }), true);
});

test("Play/Stop and the sound wait for a game with something to run", () => {
  assert.equal(gameControlsShown({ run: LiveRun.Running, nothingYet: false }), true);
  // Planning the first build, an empty scene, a game with no kind yet: nothing runs to stop.
  assert.equal(gameControlsShown({ run: LiveRun.Running, nothingYet: true }), false);
});

test("a stopped game keeps its Play, even with nothing in it", () => {
  for (const run of [LiveRun.Stopped, LiveRun.Stopping, LiveRun.Starting])
    assert.equal(gameControlsShown({ run, nothingYet: true }), true, run);
});
