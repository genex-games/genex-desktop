/**
 * A run's start builds the game before its lead's first turn (the harness's `prepareLoopRun`; a
 * cold Rust build takes minutes). The chat's build card says so with Live's vocabulary, counted
 * from `build.progress` of the agents' builds of that game (`src/renderer/chat/setup-build.ts`),
 * instead of a line that never moves; once the lead has parts to show, they speak instead.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setupBuildAfter, setupBuildCaption } from "../../src/renderer/chat/setup-build.ts";
import { SETUP_BUILD_WORDS } from "../../src/renderer/words.ts";
import { BuildPhase, CppBuildPurpose } from "../../src/shared/build-problem.ts";
import { BuildTarget } from "../../src/shared/game-project.ts";

const AT = 1_000_000;
const progress = (phase: BuildPhase, fields: Record<string, unknown> = {}) => ({
  project: "stormvale",
  target: BuildTarget.Web,
  purpose: CppBuildPurpose.Judging,
  phase,
  at: AT,
  ...fields,
});

describe("the build a run's start waits on", () => {
  it("starts with the agents' build of the game and ends with it, counted from its first event", () => {
    const started = setupBuildAfter(null, progress(BuildPhase.Configure), "stormvale");
    assert.deepEqual(started, { builds: 1, since: AT });
    const going = setupBuildAfter(started, progress(BuildPhase.Build, { at: AT + 5_000 }), "stormvale");
    assert.equal(going, started, "a phase within the same build changes nothing");
    assert.equal(setupBuildAfter(going, progress(BuildPhase.Done), "stormvale"), null);
    assert.equal(setupBuildAfter(going, progress(BuildPhase.Failed), "stormvale"), null, "a Stop's cancel ends it too");
  });

  it("a build seen mid-way (the chat opened during it) counts from what it saw", () => {
    assert.deepEqual(setupBuildAfter(null, progress(BuildPhase.Build, { at: AT + 9 }), "stormvale"), {
      builds: 1,
      since: AT + 9,
    });
  });

  it("two builds at once (the web page and the Mac build) last until both end", () => {
    let state = setupBuildAfter(null, progress(BuildPhase.Configure), "stormvale");
    state = setupBuildAfter(
      state,
      progress(BuildPhase.Configure, { target: BuildTarget.Mac, at: AT + 1 }),
      "stormvale",
    );
    assert.deepEqual(state, { builds: 2, since: AT });
    state = setupBuildAfter(state, progress(BuildPhase.Done), "stormvale");
    assert.deepEqual(state, { builds: 1, since: AT });
  });

  it("ignores Live's own builds, exports, printed lines and other games", () => {
    for (const event of [
      progress(BuildPhase.Configure, { purpose: CppBuildPurpose.Live }),
      progress(BuildPhase.Configure, { purpose: CppBuildPurpose.Export }),
      progress(BuildPhase.Build, { line: "Compiling rapier3d" }),
      progress(BuildPhase.Configure, { project: "pong" }),
    ])
      assert.equal(setupBuildAfter(null, event, "stormvale"), null, JSON.stringify(event));
  });
});

describe("what the build card says meanwhile", () => {
  it("names the build and its clock, in Live's words, before the lead has parts", () => {
    assert.equal(
      setupBuildCaption({ building: { builds: 1, since: AT - 72_000 }, leadStarted: false, now: AT }),
      SETUP_BUILD_WORDS.building("1:12"),
    );
    assert.match(SETUP_BUILD_WORDS.building("1:12"), /Building the game for the lead… 1:12/);
  });

  it("says nothing of its own once the lead has parts, or while nothing builds", () => {
    assert.equal(setupBuildCaption({ building: { builds: 1, since: AT }, leadStarted: true, now: AT }), null);
    assert.equal(setupBuildCaption({ building: null, leadStarted: false, now: AT }), null);
  });
});
