/**
 * The developer control's performance diagnostics: `window.resize` takes bounded
 * parameters and counts how far, and in how many steps, Live's view was behind its slot; a
 * main-process CPU profile is one at a time and answers only its own id.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { operationSchema } from "../../src/main/dev/protocol.ts";
import { MainProfiler } from "../../src/main/dev/main-profile.ts";
import { summarizeTrail, trailingPx } from "../../src/main/dev/window-resize.ts";

describe("window.resize parameters", () => {
  it("accept a bounded stepped resize", () => {
    const params = { deltaWidth: -240, deltaHeight: -120, steps: 30, durationMs: 500 };
    assert.equal(operationSchema.safeParse({ method: "window.resize", params }).success, true);
  });

  it("refuse unbounded sizes, step counts, durations and anything extra", () => {
    const valid = { deltaWidth: -240, deltaHeight: -120, steps: 30, durationMs: 500 };
    for (const params of [
      { ...valid, deltaWidth: 5000 },
      { ...valid, deltaHeight: -5000 },
      { ...valid, deltaWidth: 1.5 },
      { ...valid, steps: 1 },
      { ...valid, steps: 100000 },
      { ...valid, durationMs: 60000 },
      { ...valid, x: 0 },
      { ...valid, script: "arbitrary()" },
    ])
      assert.equal(
        operationSchema.safeParse({ method: "window.resize", params }).success,
        false,
        JSON.stringify(params),
      );
  });
});

describe("the view's trail behind its slot", () => {
  it("is the larger of the width and height differences", () => {
    assert.equal(trailingPx({ width: 800, height: 600 }, { width: 800, height: 600 }), 0);
    assert.equal(trailingPx({ width: 790, height: 600 }, { width: 800, height: 597 }), 10);
    assert.equal(trailingPx({ width: 800, height: 620 }, { width: 805, height: 600 }), 20);
  });

  it("summarizes the largest, the mean and the steps spent behind", () => {
    assert.deepEqual(summarizeTrail([0, 8, 16, 0]), { maxPx: 16, meanPx: 6, stepsBehind: 2, steps: 4 });
    assert.deepEqual(summarizeTrail([]), { maxPx: 0, meanPx: 0, stepsBehind: 0, steps: 0 });
  });
});

describe("main-process CPU profiles", () => {
  it("accept only a profile id", () => {
    assert.equal(
      operationSchema.safeParse({ method: "main.cpu.start", params: { profileId: "turn-1" } }).success,
      true,
    );
    for (const params of [
      {},
      { profileId: "../x" },
      { profileId: "a", surface: "desktop" },
      { profileId: "a", pid: 1 },
    ])
      assert.equal(
        operationSchema.safeParse({ method: "main.cpu.start", params }).success,
        false,
        JSON.stringify(params),
      );
  });

  it("record one profile at a time and hand it back only to its own id", async () => {
    const profiler = new MainProfiler();
    assert.equal(await profiler.start("one"), true);
    assert.equal(await profiler.start("two"), false);
    let sum = 0;
    for (let i = 0; i < 200_000; i++) sum += Math.sqrt(i);
    assert.ok(sum > 0);
    assert.equal(await profiler.stop("two"), null);
    const profile = await profiler.stop("one");
    assert.ok(profile && profile.nodes.length > 0 && profile.endTime > profile.startTime);
    assert.equal(profiler.active, null);
    assert.equal(await profiler.stop("one"), null);
  });
});
