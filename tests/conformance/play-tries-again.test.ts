/**
 * A Play read that failed (a tab's games, a game's page, a profile, the asset catalog or library) is
 * tried again by itself: after a wait that grows with each failure in a row, at once when the Mac
 * comes back online or Genex comes forward, and never on a timer while the Mac is offline.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { failedRead, type TryAgainClock } from "../../src/renderer/ui/use-online.ts";

/** A clock whose timers and events the test runs by hand. */
function handClock() {
  const timers: Array<{ ms: number; run: () => void; live: boolean }> = [];
  const listeners = new Map<string, Set<() => void>>();
  let online = true;
  const clock: TryAgainClock = {
    after: (ms, run) => {
      const timer = { ms, run, live: true };
      timers.push(timer);
      return () => {
        timer.live = false;
      };
    },
    on: (event, run) => {
      const set = listeners.get(event) ?? new Set();
      set.add(run);
      listeners.set(event, set);
      return () => set.delete(run);
    },
    online: () => online,
  };
  return {
    clock,
    /** The waits of the timers still set. */
    pending: () => timers.filter((timer) => timer.live).map((timer) => timer.ms),
    /** Run every live timer once. */
    fire: () => {
      for (const timer of timers.filter((t) => t.live)) {
        timer.live = false;
        timer.run();
      }
    },
    emit: (event: string) => {
      for (const run of listeners.get(event) ?? []) run();
    },
    listening: () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0),
    goOffline: () => {
      online = false;
    },
  };
}

const WAITS = [3, 10, 30];

describe("A failed Play read tried again", () => {
  it("waits longer after each failure in a row, then keeps the last wait", () => {
    const hand = handClock();
    const reads = failedRead(hand.clock, WAITS);
    let tried = 0;
    const seen: number[] = [];
    for (let failure = 0; failure < 5; failure++) {
      const stop = reads.watch(() => tried++);
      seen.push(...hand.pending());
      hand.fire();
      stop();
    }
    assert.deepEqual(seen, [3, 10, 30, 30, 30]);
    assert.equal(tried, 5);
  });

  it("starts over from the first wait once a read succeeds", () => {
    const hand = handClock();
    const reads = failedRead(hand.clock, WAITS);
    reads.watch(() => {})();
    hand.fire();
    reads.watch(() => {});
    hand.fire();
    reads.reset();
    reads.watch(() => {});
    assert.deepEqual(hand.pending(), [3]);
  });

  it("tries at once when the Mac is back online or Genex comes forward", () => {
    const hand = handClock();
    let tried = 0;
    failedRead(hand.clock, WAITS).watch(() => tried++);
    hand.emit("online");
    hand.emit("focus");
    assert.equal(tried, 2);
  });

  it("never tries on its timer while the Mac is offline", () => {
    const hand = handClock();
    let tried = 0;
    failedRead(hand.clock, WAITS).watch(() => tried++);
    hand.goOffline();
    hand.fire();
    assert.equal(tried, 0);
  });

  it("leaves no timer or listener behind once the read no longer fails", () => {
    const hand = handClock();
    let tried = 0;
    const stop = failedRead(hand.clock, WAITS).watch(() => tried++);
    stop();
    hand.fire();
    hand.emit("online");
    hand.emit("focus");
    assert.equal(tried, 0);
    assert.deepEqual(hand.pending(), []);
    assert.equal(hand.listening(), 0);
  });
});
