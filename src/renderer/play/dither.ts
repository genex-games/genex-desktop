/**
 * The viewer's loading cover, pure: the game's cover comes up out of black as a dimmed colour
 * ordered (Bayer) dither, cell by cell in Bayer order with the bright cells first, and holds there
 * under the title. `PlayViewerLayer.tsx` reads the cover into a {@link DitherSource} once and draws
 * {@link drawDevelop} on each frame until {@link DEVELOP_DONE_MS}.
 */

/** CSS pixels per dither cell: small, close-set dots. */
export const DITHER_CELL = 2;

/** How long the dither takes to come up out of black; after this it holds still. */
export const DEVELOP_DONE_MS = 1400;
/** How much sooner a bright cell comes up than a dark one (0: all by the Bayer order alone). */
const BRIGHT_FIRST = 0.35;

/** Colour channels' steps in the colour dither, and how far each channel is dimmed under the title. */
const COLOUR_STEPS = 4;
const DIM = { r: 0.78, g: 0.78, b: 0.84 } as const;
/** A cell not up yet. */
const BLACK = [3, 5, 14] as const;

/** The 8×8 Bayer matrix as thresholds in (0, 1), row by row. */
export const BAYER_8: readonly number[] = [
  0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54,
  22, 3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29,
  53, 21,
].map((step) => (step + 0.5) / 64);

/** The cover read once at the dither's size: each cell's colour channels and lightness, in 0..1. */
export interface DitherSource {
  width: number;
  height: number;
  red: Float32Array;
  green: Float32Array;
  blue: Float32Array;
  light: Float32Array;
}

/** A cover's RGBA pixels (`width` × `height`, as a canvas reads them) as a {@link DitherSource}. */
export function ditherSource(pixels: Uint8ClampedArray, width: number, height: number): DitherSource {
  const cells = width * height;
  const source: DitherSource = {
    width,
    height,
    red: new Float32Array(cells),
    green: new Float32Array(cells),
    blue: new Float32Array(cells),
    light: new Float32Array(cells),
  };
  for (let i = 0; i < cells; i++) {
    const red = (pixels[i * 4] ?? 0) / 255;
    const green = (pixels[i * 4 + 1] ?? 0) / 255;
    const blue = (pixels[i * 4 + 2] ?? 0) / 255;
    source.red[i] = red;
    source.green[i] = green;
    source.blue[i] = blue;
    source.light[i] = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  }
  return source;
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/** The share of the dither up `elapsed` ms in: 0 to 1, easing in and out. */
export function revealAt(elapsed: number): number {
  const t = clamp01(elapsed / DEVELOP_DONE_MS);
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}

/** One channel ordered-dithered to {@link COLOUR_STEPS} steps, as a byte. */
const step = (value: number, threshold: number): number => {
  const top = COLOUR_STEPS - 1;
  return (Math.min(top, Math.floor(value * top + threshold)) / top) * 255;
};

/** Draw the dither `elapsed` ms in, one RGBA pixel per cell of `source`, into `out`. */
export function drawDevelop(source: DitherSource, elapsed: number, out: Uint8ClampedArray): void {
  const shown = revealAt(elapsed);
  const { width, height } = source;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const threshold = BAYER_8[((y & 7) << 3) | (x & 7)] ?? 0.5;
      const at = i * 4;
      out[at + 3] = 255;
      if (threshold * (1 - BRIGHT_FIRST * (source.light[i] ?? 0)) >= shown) {
        out[at] = BLACK[0];
        out[at + 1] = BLACK[1];
        out[at + 2] = BLACK[2];
        continue;
      }
      out[at] = step((source.red[i] ?? 0) * DIM.r, threshold);
      out[at + 1] = step((source.green[i] ?? 0) * DIM.g, threshold);
      out[at + 2] = step((source.blue[i] ?? 0) * DIM.b, threshold);
    }
  }
}
