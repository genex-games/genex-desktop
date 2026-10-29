/**
 * What Live's status line says about the version a view shows (`src/renderer/panels/stage/live-fresh.ts`):
 * nothing while it is current; after the game folder changed under a compiled game, the background
 * build for the view the person has (Web or Mac) and its clock, then Update once it is built, or
 * Try again when it failed; for any other change, the change and Update. A newer version never
 * replaces the picture on its own while someone watches: the line says it is the earlier one.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  LiveFreshState,
  liveFreshness,
  prepareKey,
  prepareTargetFor,
} from "../../src/renderer/panels/stage/live-fresh.ts";
import type { LiveBehind } from "../../src/renderer/stage.ts";
import { LIVE_FRESH_WORDS } from "../../src/renderer/words.ts";
import { BuildTarget } from "../../src/shared/game-project.ts";
import { LiveBehindReason, LivePrepare, LiveUpdateKind } from "../../src/shared/live-behind.ts";

const CHANGED: LiveBehind = { reason: LiveBehindReason.Changed, note: null, head: null, held: true };
const NEW_BUILD: LiveBehind = { reason: LiveBehindReason.Build, note: null, head: "abc123", held: false };
const BROKEN: LiveBehind = { reason: LiveBehindReason.Broken, note: null, head: null, held: false };
const AT = 1_000_000;

describe("which change gets a background build", () => {
  it("a changed game folder of a compiled game builds for the view the person has", () => {
    assert.equal(prepareTargetFor(CHANGED, { compiled: true, native: false }), BuildTarget.Web);
    assert.equal(prepareTargetFor(CHANGED, { compiled: true, native: true }), BuildTarget.Mac);
  });

  it("nothing builds for a current view, a Three.js game, a run's build or a broken one", () => {
    assert.equal(prepareTargetFor(null, { compiled: true, native: false }), null);
    assert.equal(prepareTargetFor(CHANGED, { compiled: false, native: false }), null);
    assert.equal(prepareTargetFor(NEW_BUILD, { compiled: true, native: false }), null);
    assert.equal(prepareTargetFor(BROKEN, { compiled: true, native: true }), null);
    // A run's build main holds names its commit: Reload plays that build, not the folder.
    assert.equal(prepareTargetFor({ ...CHANGED, head: "def456" }, { compiled: true, native: false }), null);
  });

  it("each change and view is built once: a new note, view or game is a new build", () => {
    const first = prepareKey("cube", CHANGED, BuildTarget.Web);
    assert.equal(prepareKey("cube", { ...CHANGED }, BuildTarget.Web), first);
    assert.notEqual(prepareKey("cube", { ...CHANGED, note: "landed the run" }, BuildTarget.Web), first);
    assert.notEqual(prepareKey("cube", CHANGED, BuildTarget.Mac), first);
    assert.notEqual(prepareKey("pong", CHANGED, BuildTarget.Web), first);
  });
});

describe("what the line says", () => {
  it("says nothing while the view is current", () => {
    assert.equal(liveFreshness({ behind: null, prepare: null, now: AT }), null);
  });

  it("while the browser build is made: what is built, for how long, and that Live shows the earlier version", () => {
    const prepare = { target: BuildTarget.Web, since: AT - 72_000, outcome: null };
    const fresh = liveFreshness({ behind: CHANGED, prepare, now: AT });
    assert.equal(fresh?.state, LiveFreshState.Building);
    assert.equal(fresh?.title, LIVE_FRESH_WORDS.building[BuildTarget.Web]("1:12"));
    assert.equal(fresh?.note, LIVE_FRESH_WORDS.earlier);
    assert.equal(fresh?.action, null, "nothing to press until it is built");
  });

  it("the Native view's build is the Mac version, in the words the canvas uses", () => {
    const prepare = { target: BuildTarget.Mac, since: AT - 5_000, outcome: null };
    const fresh = liveFreshness({ behind: CHANGED, prepare, now: AT });
    assert.equal(fresh?.title, LIVE_FRESH_WORDS.building[BuildTarget.Mac]("0:05"));
    assert.match(fresh?.title ?? "", /Mac version/);
  });

  it("built: Update brings it in", () => {
    const prepare = { target: BuildTarget.Web, since: AT, outcome: LivePrepare.Built };
    const fresh = liveFreshness({ behind: CHANGED, prepare, now: AT });
    assert.equal(fresh?.state, LiveFreshState.Ready);
    assert.equal(fresh?.title, LIVE_FRESH_WORDS.built);
    assert.equal(fresh?.action, LIVE_FRESH_WORDS.update);
  });

  it("failed: the earlier version stays, and Try again (Reload) shows why", () => {
    const prepare = { target: BuildTarget.Mac, since: AT, outcome: LivePrepare.Failed };
    const fresh = liveFreshness({ behind: CHANGED, prepare, now: AT });
    assert.equal(fresh?.state, LiveFreshState.Failed);
    assert.equal(fresh?.title, LIVE_FRESH_WORDS.failed);
    assert.equal(fresh?.note, LIVE_FRESH_WORDS.earlier);
    assert.equal(fresh?.action, LIVE_FRESH_WORDS.tryAgain);
  });

  it("a change with nothing to build (or skipped) names the change, and Update", () => {
    for (const prepare of [null, { target: BuildTarget.Web, since: AT, outcome: LivePrepare.Skipped }]) {
      const fresh = liveFreshness({ behind: CHANGED, prepare, now: AT });
      assert.equal(fresh?.state, LiveFreshState.Ready);
      assert.equal(fresh?.title, LIVE_FRESH_WORDS.ready[LiveBehindReason.Changed]);
      assert.equal(fresh?.note, LIVE_FRESH_WORDS.earlier);
      assert.equal(fresh?.action, LIVE_FRESH_WORDS.update);
    }
    assert.equal(
      liveFreshness({ behind: NEW_BUILD, prepare: null, now: AT })?.title,
      LIVE_FRESH_WORDS.ready[LiveBehindReason.Build],
    );
  });

  it("a shown build that turned out not to run offers the way back, and is not called earlier", () => {
    const fresh = liveFreshness({ behind: BROKEN, prepare: null, now: AT });
    assert.equal(fresh?.title, LIVE_FRESH_WORDS.ready[LiveBehindReason.Broken]);
    assert.equal(fresh?.note, null);
    assert.equal(fresh?.action, LIVE_FRESH_WORDS.backToGame);
  });

  it("the line clears once the newer version shows: nothing waits any more", () => {
    const prepare = { target: BuildTarget.Web, since: AT, outcome: LivePrepare.Built };
    assert.equal(liveFreshness({ behind: null, prepare, now: AT }), null);
  });
});

describe("while a newer build is made ready for Live (PW)", () => {
  const COMMIT = "abc123def4567890abc123def4567890abc123de";
  const playing = (since: number) => ({ kind: LiveUpdateKind.Play, commit: COMMIT, since });

  it("a Play under way says it is opening the build, for how long, and that Live still shows the earlier one", () => {
    const fresh = liveFreshness({
      behind: null,
      prepare: null,
      now: AT,
      updating: playing(AT - 3_000),
      showsGame: true,
    });
    assert.equal(fresh?.state, LiveFreshState.Building);
    assert.equal(fresh?.title, LIVE_FRESH_WORDS.opening("0:03"));
    assert.equal(fresh?.note, LIVE_FRESH_WORDS.earlier);
    assert.equal(fresh?.action, null, "nothing to press: Live takes it once it is ready");
  });

  it("says nothing of an earlier version when Live shows none of this game", () => {
    const fresh = liveFreshness({
      behind: null,
      prepare: null,
      now: AT,
      updating: playing(AT - 3_000),
      showsGame: false,
    });
    assert.equal(fresh?.note, null);
  });

  it("a Play that is ready at once never flashes the line", () => {
    const fresh = liveFreshness({ behind: null, prepare: null, now: AT, updating: playing(AT - 100), showsGame: true });
    assert.equal(fresh, null);
  });

  it("the newest build made in the background says so until it is ready, then Update", () => {
    const behind = { ...NEW_BUILD, head: COMMIT };
    const prebuild = { kind: LiveUpdateKind.Prebuild, commit: COMMIT, since: AT - 41_000 };
    const building = liveFreshness({ behind, prepare: null, now: AT, updating: prebuild, showsGame: true });
    assert.equal(building?.state, LiveFreshState.Building);
    assert.equal(building?.title, LIVE_FRESH_WORDS.prebuilding("0:41"));
    assert.equal(building?.note, LIVE_FRESH_WORDS.earlier);
    const ready = liveFreshness({ behind, prepare: null, now: AT, updating: null, showsGame: true });
    assert.equal(ready?.state, LiveFreshState.Ready);
    assert.equal(ready?.action, LIVE_FRESH_WORDS.update);
  });

  it("a background build of a commit Reload would not play says nothing of it", () => {
    const prebuild = { kind: LiveUpdateKind.Prebuild, commit: COMMIT, since: AT - 41_000 };
    assert.equal(liveFreshness({ behind: null, prepare: null, now: AT, updating: prebuild, showsGame: true }), null);
    const other = liveFreshness({
      behind: { ...NEW_BUILD, head: "fff000" },
      prepare: null,
      now: AT,
      updating: prebuild,
      showsGame: true,
    });
    assert.equal(other?.state, LiveFreshState.Ready);
  });
});
