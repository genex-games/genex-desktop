/**
 * The strip's Play/Stop is one button: Stop while the game runs, Play once it is stopped, and a
 * spinner in its place while either is under way. Full screen is offered only while the game
 * itself is on the stage, and Play/Stop and the sound only once the game has something to run. A
 * game Live does not hold (opening one never starts it) waits for Play, with the game's view out of
 * sight and no loader.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { waitsForPlay } from "../../src/renderer/panels/stage/live-load.ts";
import { fullScreenOffered, gameControlsShown, LiveRun, liveRun } from "../../src/renderer/panels/stage/live-run.ts";
import { type LiveFlagsInput, stageFlags } from "../../src/renderer/panels/stage/stage-flags.ts";
import { StageView } from "../../src/renderer/stage.ts";
import { ObserverLive } from "../../src/shared/observers.ts";

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

test("Play/Stop and the sound wait for a game with something to run", () => {
  assert.equal(gameControlsShown({ run: LiveRun.Running, nothingYet: false }), true);
  // Planning the first build, an empty scene, a game with no kind yet: nothing runs to stop.
  assert.equal(gameControlsShown({ run: LiveRun.Running, nothingYet: true }), false);
});

test("a stopped game keeps its Play, even with nothing in it", () => {
  for (const run of [LiveRun.Stopped, LiveRun.Stopping, LiveRun.Starting])
    assert.equal(gameControlsShown({ run, nothingYet: true }), true, run);
});

test("a game Live does not hold waits for Play; one it holds, or one whose load is under way, does not", () => {
  assert.equal(waitsForPlay({ project: "moss", holds: false, liveLoad: null }), true);
  assert.equal(waitsForPlay({ project: "moss", holds: true, liveLoad: null }), false);
  const pressed = { project: "moss", pending: true, since: 0 };
  assert.equal(waitsForPlay({ project: "moss", holds: false, liveLoad: pressed }), false, "Play's load is under way");
  const other = { project: "pond", pending: true, since: 0 };
  assert.equal(waitsForPlay({ project: "moss", holds: false, liveLoad: other }), true, "another game's load");
  assert.equal(waitsForPlay({ project: null, holds: false, liveLoad: null }), false, "no game on the stage");
});

test("a game waiting for Play shows Play with its view out of sight, not a loader or the Stop card", () => {
  const flags = (live: LiveFlagsInput, pending = false) =>
    stageFlags({
      view: StageView.Live,
      beside: null,
      graph: null,
      planning: false,
      project: "moss",
      liveView: ObserverLive.Preview,
      pending,
      live,
    });
  const waiting = { state: null, liveLoad: null, stopped: false, idle: true };
  const idle = flags(waiting);
  assert.equal(idle.gameIdle, true);
  assert.equal(idle.gameStopped, false, "the person did not stop it");
  assert.equal(idle.liveLoading, false, "nothing loads");
  assert.equal(idle.stopped, true, "nothing of it runs here: the native view gives the stage back");
  assert.equal(flags(waiting, true).gameIdle, false, "a game with no kind yet shows its first-idea state");
  assert.equal(flags({ ...waiting, idle: false }).gameIdle, false);
  assert.equal(flags({ ...waiting, idle: false }).stopped, false);
  const empty = { phase: "empty", drawCalls: 0 };
  assert.equal(flags({ ...waiting, state: empty }).gameIdle, false, "an empty scaffold asks for its first idea");
});
