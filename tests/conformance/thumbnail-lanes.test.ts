/**
 * The lanes thumbnails are made in: a lane runs a fixed number of tasks at once, in the order they
 * were asked for, and a task that fails never holds the ones behind it.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLane } from "../../src/renderer/thumbnail-lanes.ts";

/** A task the test finishes by hand, and whether it has started. */
function manual<T>() {
  let started = false;
  const settle: { resolve: (value: T) => void; reject: (error: unknown) => void } = {
    resolve: () => {},
    reject: () => {},
  };
  const task = (): Promise<T> => {
    started = true;
    return new Promise<T>((resolve, reject) => {
      settle.resolve = resolve;
      settle.reject = reject;
    });
  };
  return { task, settle, started: () => started };
}

/** Let the lane's own promise steps run. */
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("a thumbnail lane", () => {
  it("runs as many tasks at once as it is wide, and the next when one ends", async () => {
    const lane = createLane(2);
    const jobs = [manual<string>(), manual<string>(), manual<string>()];
    const results = jobs.map((job) => lane(job.task));
    await tick();
    assert.deepEqual(
      jobs.map((job) => job.started()),
      [true, true, false],
    );
    jobs[0]?.settle.resolve("a");
    await tick();
    assert.equal(jobs[2]?.started(), true, "the third starts when the first ends");
    jobs[1]?.settle.resolve("b");
    jobs[2]?.settle.resolve("c");
    assert.deepEqual(await Promise.all(results), ["a", "b", "c"]);
  });

  it("one wide runs one task at a time, in the order asked", async () => {
    const lane = createLane(1);
    const order: number[] = [];
    await Promise.all(
      [1, 2, 3].map((n) =>
        lane(async () => {
          order.push(n);
          await tick();
          order.push(-n);
        }),
      ),
    );
    assert.deepEqual(order, [1, -1, 2, -2, 3, -3]);
  });

  it("hands a failure to its own caller and goes on with the rest", async () => {
    const lane = createLane(1);
    const failed = lane(() => Promise.reject(new Error("no decoder")));
    const thrown = lane(() => {
      throw new Error("threw before a promise");
    });
    const next = lane(async () => "after");
    await assert.rejects(failed, /no decoder/);
    await assert.rejects(thrown, /threw before a promise/);
    assert.equal(await next, "after");
  });
});
