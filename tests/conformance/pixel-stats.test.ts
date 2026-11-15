/**
 * Pixel arithmetic over raw BGRA bitmaps — pure math, no Electron, no GPU.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computePixelStats, hasTransparency, isEffectivelyBlack } from "../../src/substrate/pixel-stats.ts";

/** A width×height BGRA buffer with every pixel set to the same [b, g, r, a] quad. */
function bitmap(width: number, height: number, quad: [number, number, number, number]): Buffer {
  const buffer = Buffer.alloc(width * height * 4);
  for (let i = 0; i < buffer.length; i += 4) buffer.set(quad, i);
  return buffer;
}

function paint(buffer: Buffer, pixel: number, quad: [number, number, number, number]): void {
  buffer.set(quad, pixel * 4);
}

describe("pixel stats", () => {
  it("reports an all-zero frame as fully black", () => {
    const stats = computePixelStats(bitmap(64, 64, [0, 0, 0, 255]), 64, 64);
    assert.equal(stats.sampled, 4096);
    assert.equal(stats.meanLuma, 0);
    assert.equal(stats.litFraction, 0);
    assert.ok(isEffectivelyBlack(stats));
  });

  it("counts a handful of lit pixels precisely", () => {
    const buffer = bitmap(64, 64, [0, 0, 0, 255]);
    for (let pixel = 0; pixel < 41; pixel++) paint(buffer, pixel, [255, 255, 255, 255]);
    const stats = computePixelStats(buffer, 64, 64);
    assert.ok(stats.litFraction >= 0.009 && stats.litFraction <= 0.011, `litFraction ${stats.litFraction}`);
    assert.ok(!isEffectivelyBlack(stats));
  });

  it("treats luma exactly at the threshold as unlit — the comparison is strict", () => {
    // Gray 8: the Rec.709 weights sum to 1, so luma is exactly 8, not above it.
    const stats = computePixelStats(bitmap(32, 32, [8, 8, 8, 255]), 32, 32);
    assert.equal(stats.litFraction, 0);
  });

  it("reads bytes as BGRA, not RGBA", () => {
    // Pure red in BGRA is [0, 0, 255]; the RGBA misread would weight it at ~18.4.
    const stats = computePixelStats(bitmap(16, 16, [0, 0, 255, 255]), 16, 16);
    assert.ok(stats.meanLuma >= 53.5 && stats.meanLuma <= 54.7, `meanLuma ${stats.meanLuma}`);
  });

  it("stride-samples large frames without losing the answer", () => {
    const width = 1000;
    const height = 1000;
    const buffer = Buffer.alloc(width * height * 4);
    // First 30% of pixels lit — the truth the sampled estimate must stay near.
    for (let pixel = 0; pixel < width * height * 0.3; pixel++) paint(buffer, pixel, [200, 200, 200, 255]);
    const stats = computePixelStats(buffer, width, height, { maxSamples: 10_000 });
    assert.ok(stats.sampled <= 10_000, `sampled ${stats.sampled}`);
    assert.ok(Math.abs(stats.litFraction - 0.3) <= 0.02, `litFraction ${stats.litFraction}`);
  });

  it("survives a truncated buffer by measuring the rows it has", () => {
    const buffer = bitmap(64, 64, [255, 255, 255, 255]).subarray(0, 64 * 64 * 4 - 100);
    const stats = computePixelStats(buffer, 64, 64);
    assert.ok(stats.sampled > 0 && stats.sampled < 4096);
    assert.equal(stats.litFraction, 1);
  });

  it("measures every device pixel of a Retina capture reported in DIPs", () => {
    // getSize() says 100×100 but toBitmap() returned 2x device pixels.
    const buffer = bitmap(200, 200, [255, 255, 255, 255]);
    const stats = computePixelStats(buffer, 100, 100);
    assert.equal(stats.sampled, 40_000);
    assert.equal(stats.litFraction, 1);
    assert.ok(stats.meanLuma > 250);
  });

  it("tells a see-through picture from an opaque one by its alpha alone", () => {
    assert.equal(hasTransparency(bitmap(8, 8, [0, 0, 0, 255])), false, "opaque black");
    assert.equal(hasTransparency(bitmap(8, 8, [255, 255, 255, 255])), false, "opaque white");
    const sprite = bitmap(8, 8, [40, 80, 120, 255]);
    paint(sprite, 63, [0, 0, 0, 0]);
    assert.equal(hasTransparency(sprite), true, "one clear corner pixel");
    const soft = bitmap(8, 8, [40, 80, 120, 255]);
    paint(soft, 0, [40, 80, 120, 254]);
    assert.equal(hasTransparency(soft), true, "one softened pixel");
    assert.equal(hasTransparency(Buffer.alloc(0)), false, "no pixels");
    assert.equal(hasTransparency(Buffer.from([0, 0, 0])), false, "no whole pixel");
  });
});
