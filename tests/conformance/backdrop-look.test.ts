/**
 * What stands out when a made background is drawn, told to the model that improves it: nothing
 * drawn, nothing moving, most of the screen lit, a middle busier than the edges, a slow frame. It
 * reads light as distance from the page, so a dark page and a light one read alike.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LookFinding } from "../../src/shared/backdrop-shader.ts";
import { lookFindings, SLOW_FRAME_MS } from "../../src/renderer/home-backdrop/look-findings.ts";
import type { Rgba } from "../../src/renderer/home-backdrop/readable-color.ts";

const SIZE: [number, number] = [80, 50];
const DARK: Rgba = [0.08, 0.08, 0.09, 1];
const LIGHT: Rgba = [0.98, 0.98, 0.98, 1];

/** A moment where `light(x, y)` (0..1, away from the page) is drawn over `page`. */
function moment(page: Rgba, light: (x: number, y: number) => number): Uint8ClampedArray {
  const [width, height] = SIZE;
  const pixels = new Uint8ClampedArray(width * height * 4);
  const dark = page[0] < 0.5;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const value = Math.min(1, Math.max(0, light(x / width, y / height)));
      const level = dark ? page[0] + value * (1 - page[0]) : page[0] - value * page[0];
      pixels.set([level * 255, level * 255, level * 255, 255], (y * width + x) * 4);
    }
  return pixels;
}

/** A soft band drifting across the bottom, phase `t`: something drawn, moving, calm in the middle. */
const band = (t: number) => (x: number, y: number) =>
  y > 0.75 ? 0.3 + 0.3 * Math.sin(x * 12 + t) : 0.02 * Math.sin(x * 3 + t);
const moments = (page: Rgba, light: (t: number) => (x: number, y: number) => number) =>
  [0, 1, 2].map((t) => moment(page, light(t)));

describe("what stands out in a made background", () => {
  it("finds nothing in a calm moving background, on either page", () => {
    for (const page of [DARK, LIGHT]) assert.deepEqual(lookFindings(moments(page, band), SIZE, page, 1), []);
  });

  it("finds a background that draws almost nothing empty", () => {
    for (const page of [DARK, LIGHT])
      assert.deepEqual(
        lookFindings(
          moments(page, () => () => 0),
          SIZE,
          page,
          1,
        ),
        [LookFinding.Empty],
      );
  });

  it("finds a background whose moments look the same still", () => {
    assert.deepEqual(
      lookFindings(
        moments(DARK, () => band(0)),
        SIZE,
        DARK,
        1,
      ),
      [LookFinding.Still],
    );
  });

  it("finds a background that lights most of the screen glaring", () => {
    const found = lookFindings(
      moments(LIGHT, (t) => (x) => 0.8 + 0.1 * Math.sin(x * 4 + t)),
      SIZE,
      LIGHT,
      1,
    );
    assert.deepEqual(found, [LookFinding.Glaring]);
  });

  it("finds detail packed into the middle, behind home's title and prompt", () => {
    const busy = (t: number) => (x: number, y: number) =>
      Math.abs(x - 0.5) < 0.2 && Math.abs(y - 0.5) < 0.2 ? (Math.floor(x * 80 + t) % 2) * 0.6 : band(t)(x, y);
    assert.deepEqual(lookFindings(moments(DARK, busy), SIZE, DARK, 1), [LookFinding.BusyCentre]);
  });

  it("finds a frame slower than a laptop can spare slow", () => {
    assert.deepEqual(lookFindings(moments(DARK, band), SIZE, DARK, SLOW_FRAME_MS + 1), [LookFinding.Slow]);
    assert.deepEqual(lookFindings(moments(DARK, band), SIZE, DARK, 0), []);
  });
});
