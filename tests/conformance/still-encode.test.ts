/**
 * The arithmetic behind a plugin's still (`observe` with `still`): which encoding it ships in, how
 * large it may be, and the exposure numbers that ride with it. All pure, so the ladder's order and
 * its stopping point are proved without a window.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { STILL_JPEG_QUALITIES, encodeStill, stillFit } from "../../src/main/core/capture.ts";
import { NEAR_BLACK_LUMA, exposureStats } from "../../src/substrate/pixel-stats.ts";
import { StillMimeType } from "../../src/shared/preview-contract.ts";

const LIMIT = 1000;

/** Encoders that answer buffers of the given sizes and record which encodings were asked for. */
function encoders(png: number, jpeg: Record<number, number>) {
  const asked: string[] = [];
  return {
    asked,
    png: () => {
      asked.push("png");
      return Buffer.alloc(png, 1);
    },
    jpeg: (quality: number) => {
      asked.push(`jpeg:${quality}`);
      return Buffer.alloc(jpeg[quality] ?? 0, 2);
    },
  };
}

describe("the still's encode ladder", () => {
  it("steps down 95, 90, 85 and never lower", () => {
    assert.deepEqual([...STILL_JPEG_QUALITIES], [95, 90, 85]);
  });

  const ROWS: Array<[label: string, png: number, jpeg: Record<number, number>, mime: string, asked: string[]]> = [
    ["a PNG under the limit ships as PNG", LIMIT - 1, {}, StillMimeType.Png, ["png"]],
    ["a PNG exactly at the limit ships as PNG", LIMIT, {}, StillMimeType.Png, ["png"]],
    [
      "a PNG over the limit ships as the JPEG at 95 that fits",
      LIMIT + 1,
      { 95: LIMIT },
      StillMimeType.Jpeg,
      ["png", "jpeg:95"],
    ],
    ["at 90 when 95 is over", LIMIT * 3, { 95: LIMIT + 1, 90: 900 }, StillMimeType.Jpeg, ["png", "jpeg:95", "jpeg:90"]],
    [
      "at 85 when 90 is over",
      LIMIT * 3,
      { 95: LIMIT * 2, 90: LIMIT + 1, 85: 10 },
      StillMimeType.Jpeg,
      ["png", "jpeg:95", "jpeg:90", "jpeg:85"],
    ],
  ];
  for (const [label, png, jpeg, mime, asked] of ROWS) {
    it(label, () => {
      const encode = encoders(png, jpeg);
      const encoded = encodeStill(encode, LIMIT);
      assert.ok("data" in encoded, "an encoding fit");
      assert.equal(encoded.mimeType, mime);
      assert.ok(encoded.data.length <= LIMIT);
      assert.deepEqual(encode.asked, asked, "it stops at the first encoding that fits");
    });
  }

  it("is too large when even the JPEG at 85 is over, naming the smallest it made", () => {
    const encode = encoders(LIMIT * 9, { 95: LIMIT * 4, 90: LIMIT * 3, 85: LIMIT * 2 });
    assert.deepEqual(encodeStill(encode, LIMIT), { tooLarge: { smallestBytes: LIMIT * 2 } });
    assert.deepEqual(encode.asked, ["png", "jpeg:95", "jpeg:90", "jpeg:85"], "nothing below 85 is tried");
  });
});

describe("the still's size", () => {
  const ROWS: Array<[taken: [number, number], asked: [number, number], fit: [number, number]]> = [
    // A Retina window's canvas reads at twice the size the window was given.
    [
      [3840, 2160],
      [1920, 1080],
      [1920, 1080],
    ],
    [
      [1920, 1080],
      [1920, 1080],
      [1920, 1080],
    ],
    // A game that renders smaller than its window is never blown up.
    [
      [1280, 720],
      [1920, 1080],
      [1280, 720],
    ],
    // A frame of another shape keeps its shape inside the box.
    [
      [2000, 1000],
      [1920, 1080],
      [1920, 960],
    ],
    [
      [1080, 1920],
      [1920, 1080],
      [608, 1080],
    ],
    [
      [3841, 2161],
      [1920, 1080],
      [1920, 1080],
    ],
  ];
  for (const [taken, asked, fit] of ROWS) {
    it(`fits ${taken.join("×")} into ${asked.join("×")} as ${fit.join("×")}`, () => {
      const size = stillFit({ width: taken[0], height: taken[1] }, { width: asked[0], height: asked[1] });
      assert.deepEqual(size, { width: fit[0], height: fit[1] });
      assert.ok(size.width <= asked[0] && size.height <= asked[1], "never larger than asked");
    });
  }

  it("keeps at least one pixel on each side", () => {
    assert.deepEqual(stillFit({ width: 10_000, height: 1 }, { width: 320, height: 240 }), { width: 320, height: 1 });
  });
});

/** A BGRA bitmap of `pixels`, each `[r, g, b]`. */
function bgra(pixels: Array<[number, number, number]>): Buffer {
  const out = Buffer.alloc(pixels.length * 4);
  pixels.forEach(([r, g, b], i) => {
    out[i * 4] = b;
    out[i * 4 + 1] = g;
    out[i * 4 + 2] = r;
    out[i * 4 + 3] = 255;
  });
  return out;
}

describe("the still's exposure", () => {
  it("reads a black frame as black: no light, no spread, every sample near black", () => {
    const stats = exposureStats(bgra(new Array(16).fill([0, 0, 0])), 4, 4);
    assert.deepEqual(stats, { lumaMean: 0, lumaStdDev: 0, nearBlackFraction: 1, litFraction: 0 });
  });

  it("reads half white, half black as a mean of one half with a spread of one half", () => {
    const pixels: Array<[number, number, number]> = [
      ...new Array(8).fill([255, 255, 255]),
      ...new Array(8).fill([0, 0, 0]),
    ];
    const stats = exposureStats(bgra(pixels), 4, 4);
    assert.ok(Math.abs(stats.lumaMean - 0.5) < 1e-9);
    assert.ok(Math.abs(stats.lumaStdDev - 0.5) < 1e-9);
    assert.equal(stats.nearBlackFraction, 0.5);
    assert.equal(stats.litFraction, 0.5);
  });

  it("weighs the channels as Rec.709 on the sRGB bytes, read in BGRA order", () => {
    const red = exposureStats(bgra([[255, 0, 0]]), 1, 1);
    const blue = exposureStats(bgra([[0, 0, 255]]), 1, 1);
    assert.ok(Math.abs(red.lumaMean - 0.2126) < 1e-9, `red reads ${red.lumaMean}`);
    assert.ok(Math.abs(blue.lumaMean - 0.0722) < 1e-9, `blue reads ${blue.lumaMean}`);
  });

  it("counts a sample as near black strictly below a luma of 0.10", () => {
    assert.equal(NEAR_BLACK_LUMA, 0.1);
    const justBelow = Math.floor(0.1 * 255); // 25 of 255 is 0.098
    const justAbove = Math.ceil(0.1 * 255); // 26 of 255 is 0.102
    const stats = exposureStats(
      bgra([
        [justBelow, justBelow, justBelow],
        [justAbove, justAbove, justAbove],
      ]),
      2,
      1,
    );
    assert.equal(stats.nearBlackFraction, 0.5);
    assert.equal(stats.litFraction, 1, "both are above the unlit threshold");
  });

  it("reads an empty or short bitmap as black rather than throwing", () => {
    assert.deepEqual(exposureStats(Buffer.alloc(0), 4, 4), {
      lumaMean: 0,
      lumaStdDev: 0,
      nearBlackFraction: 1,
      litFraction: 0,
    });
  });
});
