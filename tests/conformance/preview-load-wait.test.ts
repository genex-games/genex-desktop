/**
 * A page whose own script never yields (a start-up loop that cannot end) never fires `load`, and
 * Electron's `loadURL` then never settles. Live's load queue, an agent's `preview.load` and the
 * person's Stop all waited on it for good: the stage said "Loading game" forever and every later
 * load queued behind the stuck one. The wait is bounded, on a clock the test holds.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PageLoadWait, waitForLoad } from "../../src/main/preview-load-failure.ts";

/** Timers that fire only when the test says so. */
function heldTimers() {
  const pending = new Map<number, () => void>();
  let next = 1;
  return {
    timers: {
      setTimeout: (callback: () => void, _ms: number) => {
        const handle = next++;
        pending.set(handle, callback);
        return handle;
      },
      clearTimeout: (handle: unknown) => void pending.delete(handle as number),
    },
    /** Run every timer still armed. */
    expire: () => {
      const due = [...pending.values()];
      pending.clear();
      for (const callback of due) callback();
    },
    armed: () => pending.size,
  };
}

/** A load the test settles by hand, or never. */
function deferredLoad() {
  let resolve: () => void = () => {};
  let reject: (error: Error) => void = () => {};
  const loading = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { loading, resolve, reject };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("waiting for a page's load", () => {
  it("answers Stalled once the deadline passes on a load that never settles", async () => {
    const clock = heldTimers();
    const load = deferredLoad();
    const waiting = waitForLoad(load.loading, 60_000, clock.timers);
    await flush();
    clock.expire();
    assert.equal(await waiting, PageLoadWait.Stalled);
  });

  it("answers Finished for a load that ends in time, and leaves no timer behind", async () => {
    const clock = heldTimers();
    const load = deferredLoad();
    const waiting = waitForLoad(load.loading, 60_000, clock.timers);
    load.resolve();
    assert.equal(await waiting, PageLoadWait.Finished);
    assert.equal(clock.armed(), 0);
  });

  it("still throws a load that fails in time", async () => {
    const clock = heldTimers();
    const load = deferredLoad();
    const waiting = waitForLoad(load.loading, 60_000, clock.timers);
    load.reject(new Error("ERR_FILE_NOT_FOUND (-6)"));
    await assert.rejects(waiting, /ERR_FILE_NOT_FOUND/);
    assert.equal(clock.armed(), 0);
  });

  it("drops the failure of a load given up on, without an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", listener);
    try {
      const clock = heldTimers();
      const load = deferredLoad();
      const waiting = waitForLoad(load.loading, 60_000, clock.timers);
      clock.expire();
      assert.equal(await waiting, PageLoadWait.Stalled);
      // The next navigation aborts the stuck one long after anyone waited for it.
      load.reject(new Error("ERR_ABORTED (-3)"));
      await flush();
      await flush();
      assert.deepEqual(unhandled, []);
    } finally {
      process.off("unhandledRejection", listener);
    }
  });
});
