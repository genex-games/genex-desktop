/**
 * A Play read that failed (a tab's games, a game's page, a profile, the asset catalog or library) is
 * tried again by itself: after a wait that grows with each failure in a row, at once when the Mac
 * comes back online or Genex comes forward, and never on a timer while the Mac is offline. Its
 * failure stays out of sight (the screen loading) until its first tries are spent.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { failedRead, failureShown, QUIET_TRIES, type TryAgainClock } from "../../src/renderer/ui/use-online.ts";

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

describe("A failed Play read out of sight", () => {
  it("keeps a failure out of sight while its first tries run, and shows it with Try again after", () => {
    const hand = handClock();
    const counted: number[] = [];
    const reads = failedRead(hand.clock, WAITS, (tries) => counted.push(tries));
    const shown: boolean[] = [failureShown(0, true)];
    for (let failure = 0; failure < QUIET_TRIES + 1; failure++) {
      const stop = reads.watch(() => {});
      hand.fire();
      stop();
      shown.push(failureShown(counted.at(-1) ?? 0, true));
    }
    const expected = shown.map((_, tries) => tries >= QUIET_TRIES);
    assert.deepEqual(shown, expected);
    assert.equal(shown.at(0), false, "the first failure stays out of sight");
    assert.equal(shown.at(-1), true, "a failure past its quiet tries shows");
    reads.reset();
    assert.equal(counted.at(-1), 0, "a read that succeeds hides the next failure again");
  });

  it("starts over, out of sight again, when another read (a tab, a search) takes the failed one's place", () => {
    const hand = handClock();
    const counted: number[] = [];
    const reads = failedRead(hand.clock, WAITS, (tries) => counted.push(tries));
    reads.readOf("popular");
    for (let failure = 0; failure < QUIET_TRIES + 1; failure++) {
      const stop = reads.watch(() => {});
      hand.fire();
      stop();
    }
    assert.equal(failureShown(counted.at(-1) ?? 0, true), true, "the first tab's failure shows");
    reads.readOf("popular");
    assert.equal(failureShown(counted.at(-1) ?? 0, true), true, "the same read keeps its count");
    reads.readOf("new");
    assert.equal(failureShown(counted.at(-1) ?? 0, true), false, "the other tab's first failure stays out of sight");
    reads.watch(() => {});
    assert.deepEqual(hand.pending(), [WAITS[0]], "and waits the first wait");
  });

  it("shows a failure at once while the Mac is offline, where the offline notice says why", () => {
    assert.equal(failureShown(0, false), true);
  });
});
