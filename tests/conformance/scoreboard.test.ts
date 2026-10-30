/**
 * The v2 verification layer, pure and fast:
 * the expression language behind pixel/probe/demo checks, spec normalisation and validation,
 * scoreboard comparison, the extended pixel statistics and frame diff, the technique library's
 * retrieval and outcome gate, the code reviewer's mechanical scan, and the loop's self-test.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computePixelDiff, computePixelStats, fractionAbove, fractionBelow } from "../../src/substrate/pixel-stats.ts";
import { runSelftest } from "../../src/harness-seed/loop/selftest.ts";

function bitmap(width: number, height: number, quad: [number, number, number, number]): Buffer {
  const buffer = Buffer.alloc(width * height * 4);
  for (let i = 0; i < buffer.length; i += 4) buffer.set(quad, i);
  return buffer;
}

describe("pixel statistics, extended", () => {
  it("reports a histogram, band means, saturation and contrast beside the classic numbers", () => {
    const width = 30;
    const height = 30;
    const buffer = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        // Top third white, bottom two thirds black; right third pure red.
        const white = y < 10;
        const red = x >= 20;
        buffer.set(red ? [0, 0, 255, 255] : white ? [255, 255, 255, 255] : [0, 0, 0, 255], i);
      }
    }
    const stats = computePixelStats(buffer, width, height);
    assert.ok(stats.histogram && stats.histogram.length === 32);
    assert.ok(Math.abs(stats.histogram.reduce((a, b) => a + b, 0) - 1) < 1e-9, "histogram sums to 1");
    assert.ok(stats.bands!.top > stats.bands!.bottom, "top band brighter than bottom");
    assert.ok(stats.bands!.right < stats.bands!.left, "pure red is darker than white");
    assert.ok(
      stats.saturation! > 0.3 && stats.saturation! < 0.4,
      `a third of pixels fully saturated → ${stats.saturation}`,
    );
    assert.ok(stats.contrast! > 60, `high contrast frame → ${stats.contrast}`);
    const above = fractionAbove(stats, 0.9)!;
    assert.ok(above > 0.2 && above < 0.25, `white ≈ 2/9 of pixels → ${above}`);
    assert.ok(fractionBelow(stats, 0.1)! > 0.4);
  });

  it("diffs two frames: fraction changed, mean difference, a 3×3 grid of where", () => {
    const a = bitmap(60, 30, [0, 0, 0, 255]);
    const b = bitmap(60, 30, [0, 0, 0, 255]);
    // Light up the top-left cell only.
    for (let y = 0; y < 10; y++) for (let x = 0; x < 20; x++) b.set([255, 255, 255, 255], (y * 60 + x) * 4);
    const diff = computePixelDiff(a, b, 60, 30);
    assert.ok(Math.abs(diff.diffFraction - 1 / 9) < 0.01, `one cell of nine changed → ${diff.diffFraction}`);
    assert.ok(diff.grid[0]! > 0.99 && diff.grid[8]! === 0, `grid ${diff.grid.join(",")}`);
    assert.equal(diff.compared, 1800);
    const same = computePixelDiff(a, a, 60, 30);
    assert.equal(same.diffFraction, 0);
    const mismatch = computePixelDiff(a, Buffer.alloc(0), 60, 30);
    assert.equal(mismatch.compared, 0, "an empty frame compares nothing");
    const cells = computePixelDiff(a, b, 60, 30, { cells: { x: 3, y: 3 } });
    assert.equal(cells.cells?.values.length, 9);
  });
});

describe("the loop's self-test (the architect's bar)", () => {
  it("passes on the shipped seed", async () => {
    const result = await runSelftest();
    assert.equal(result.ok, true);
    assert.ok(result.passed.length >= 9);
  });
});

