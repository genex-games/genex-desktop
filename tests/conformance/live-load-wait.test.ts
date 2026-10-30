/**
 * Live never keeps a game hidden behind its loader longer than 45 s, whatever the page does. A load
 * the stage started itself is `pending` until main answers it, and main's answer never came for a
 * page whose start-up never ended: the 45 s were only counted once it had, so "Loading game" stayed
 * on the stage for good. A pending load gives up on the same clock, and says it timed out.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { freshSettle, type LiveLoad, settledLoad } from "../../src/renderer/panels/stage/live-load.ts";
import { LiveOutcome, LiveTrigger } from "../../src/renderer/analytics/events/builds.ts";

const T0 = Date.parse("2026-10-30T14:30:00.000Z");
const SECOND = 1000;

/** What the stage's probe hears while main is still loading the page: nothing of it yet. */
const probeAt = (now: number) => ({ live: null, current: false, broken: false, now });

describe("a load the stage is still waiting for main to answer", () => {
  const pending: LiveLoad = { project: "drifting-rocks", pending: true, since: T0, trigger: LiveTrigger.GameStarted };

  it("keeps the loader while there is time left", () => {
    assert.equal(settledLoad(pending, "drifting-rocks", freshSettle(), probeAt(T0 + 10 * SECOND)), null);
    assert.equal(settledLoad(pending, "drifting-rocks", freshSettle(), probeAt(T0 + 45 * SECOND)), null);
  });

  it("gives up as timed out once Live has kept the game hidden 45 s, though main never answered", () => {
    assert.deepEqual(settledLoad(pending, "drifting-rocks", freshSettle(), probeAt(T0 + 46 * SECOND)), {
      load: pending,
      outcome: LiveOutcome.TimedOut,
    });
  });

  it("is not this game's to end when it loads another one", () => {
    assert.equal(settledLoad(pending, "orchard", freshSettle(), probeAt(T0 + 46 * SECOND)), null);
  });
});
