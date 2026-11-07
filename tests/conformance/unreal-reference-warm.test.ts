/**
 * The engine's node reference exported ahead of the first lookup (`reference-warm.ts`): one export
 * per engine at a time, shared by every caller; a background start skips an engine whose last
 * export failed until a while later, while a lookup may start one at once; and a caller waits for
 * the export only so long, leaving it running.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { createReferenceExports, endWithin, REFERENCE_RETRY_MS } from "../../src/plugins/unreal/reference-warm.ts";

const KEY = "storage\u00005.8";

/** An export the test ends: `runs` counts each one started. */
function exports() {
  let at = 0;
  let runs = 0;
  const ends: Array<{ resolve(): void; reject(error: Error): void }> = [];
  const run = () => {
    runs += 1;
    return new Promise<unknown>((resolve, reject) => ends.push({ resolve: () => resolve(runs), reject }));
  };
  const made = createReferenceExports(() => at);
  return {
    ...made,
    run,
    runs: () => runs,
    end: (failure?: Error) => {
      const last = ends.shift();
      if (failure) last?.reject(failure);
      else last?.resolve();
    },
    pass: (ms: number) => {
      at += ms;
    },
  };
}

describe("the node reference's exports", () => {
  it("share one running export: a background start and lookups never start a second", async () => {
    const e = exports();
    e.warm(KEY, e.run);
    e.warm(KEY, e.run);
    const looking = e.start(KEY, e.run);
    assert.equal(e.runs(), 1);
    e.end();
    assert.equal(await looking, 1, "the lookup reads the background export's end");
    e.warm("other\u00005.8", e.run);
    assert.equal(e.runs(), 2, "each engine and storage has its own");
  });

  it("start again in the background only a while after one failed; a lookup may start one at once", async () => {
    const e = exports();
    e.warm(KEY, e.run);
    e.end(new Error("Unreal is playing"));
    await nextTurn();
    e.pass(REFERENCE_RETRY_MS - 1);
    e.warm(KEY, e.run);
    assert.equal(e.runs(), 1, "not again right after a failure");
    const looking = e.start(KEY, e.run);
    assert.equal(e.runs(), 2, "a lookup asks for it itself");
    e.end(new Error("still playing"));
    await assert.rejects(looking, /still playing/);
    e.pass(REFERENCE_RETRY_MS);
    e.warm(KEY, e.run);
    assert.equal(e.runs(), 3);
    e.end();
    await nextTurn();
    e.warm(KEY, e.run);
    assert.equal(e.runs(), 4, "an export that ended holds the engine no longer");
  });

  it("are waited for only so long: the caller hears it still runs, how it ended, or why it failed", async () => {
    const never = new AbortController().signal;
    const waitEnds = (_ms: number) => Promise.resolve();
    const waitStops = (_ms: number, signal: AbortSignal) =>
      new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
    const running = new Promise<unknown>(() => undefined);
    assert.equal(await endWithin(running, waitEnds, 90_000, never), undefined);
    assert.deepEqual(await endWithin(Promise.resolve(1), waitStops, 90_000, never), {});
    const failure = new Error("refused");
    assert.deepEqual(await endWithin(Promise.reject(failure), waitStops, 90_000, never), { failure });
    const asked = new AbortController();
    const stopped = endWithin(running, waitStops, 90_000, asked.signal);
    asked.abort();
    assert.equal(await stopped, undefined, "the caller's own stop ends its wait");
  });
});
