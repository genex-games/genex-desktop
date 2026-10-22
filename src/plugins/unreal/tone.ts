/**
 * Tone numbers for an Unreal capture, so an agent judges its own frame against numbers as well as
 * its eye: the black point (luminance p2), the white point (p98), the contrast (luminance std),
 * aerial perspective (the far band, the upper middle of the frame, should be calmer than the near
 * band, its lower third) and the mean saturation. A frame without a deep black or with flat
 * contrast reads as fog soup or noon haze, however good its models are.
 *
 * Captures are PNGs, read and written by the shared codec (`substrate/png.ts`). Numbers are taken on a copy scaled to
 * {@link ANALYSIS_WIDTH} pixels wide, so a 4K still and a 720p strip frame read alike. The module
 * also lays frames out as one contact sheet, so a motion strip reaches the agent as one picture.
 */
import { decodePng, encodePng, type RgbImage } from "../../substrate/png.ts";

export { decodePng, encodePng, type RgbImage };

/** One tone gate check, by its wire name. */
export const ToneCheck = {
  BlackPoint: "black-point",
  Contrast: "contrast",
  AerialPerspective: "aerial-perspective",
} as const;
export type ToneCheck = (typeof ToneCheck)[keyof typeof ToneCheck];

/** A frame's tone numbers, each 0 to 1 (luminance is Rec. 709 on sRGB values). */
export type Tone = {
  /** The 2nd percentile of luminance: the black point. */
  p2: number;
  /** The 98th percentile of luminance: the white point. */
  p98: number;
  mean: number;
  /** The standard deviation of luminance: the contrast. */
  std: number;
  /** The luminance std of the lower third (the near ground). */
  nearStd: number;
  /** The luminance std of the upper middle band, from a third to half way down (the distance). */
  farStd: number;
  /** The mean HSV saturation. */
  saturation: number;
  /** The share of pixels at full white. */
  clipped: number;
};

/** The tone gate: a deep black point, real contrast, and air between near and far. */
export const BLACK_POINT_MAX = 0.05;
export const CONTRAST_MIN = 0.18;
/** A frame whose white point (p98) is under this is nearly black: more likely a render gone wrong than a grade. */
export const UNLIT_WHITE_MAX = 0.1;
/** The width tone numbers are taken at. */
export const ANALYSIS_WIDTH = 480;
/** The size consecutive strip frames are compared at. */
const DIFFERENCE_SIZE = { width: 320, height: 180 } as const;
const LUMA = [0.2126, 0.7152, 0.0722] as const;
const FULL = 255;

const MESSAGE = {
  NoFrames: "There are no frames to lay out.",
} as const;

/** The source rows or columns [from, to) that target index `index` of `count` covers in `size`. */
function span(index: number, count: number, size: number): [number, number] {
  const from = Math.floor((index * size) / count);
  return [from, Math.max(from + 1, Math.floor(((index + 1) * size) / count))];
}

/** The mean colour of the source pixels in rows [top, bottom) and columns [left, right), written at `at`. */
function averageInto(image: RgbImage, rows: [number, number], columns: [number, number], out: Uint8Array, at: number) {
  const sum = [0, 0, 0];
  for (let y = rows[0]; y < rows[1]; y++)
    for (let x = columns[0]; x < columns[1]; x++) {
      const source = (y * image.width + x) * 3;
      for (let c = 0; c < 3; c++) sum[c] = (sum[c] ?? 0) + (image.rgb[source + c] ?? 0);
    }
  const count = (rows[1] - rows[0]) * (columns[1] - columns[0]);
  for (let c = 0; c < 3; c++) out[at + c] = Math.round((sum[c] ?? 0) / count);
}

/** The image scaled to `width` x `height` by averaging the source pixels each target pixel covers. */
export function resize(image: RgbImage, width: number, height: number): RgbImage {
  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    const rows = span(y, height, image.height);
    for (let x = 0; x < width; x++) averageInto(image, rows, span(x, width, image.width), rgb, (y * width + x) * 3);
  }
  return { width, height, rgb };
}

/** The image at {@link ANALYSIS_WIDTH} wide (never enlarged). */
function forAnalysis(image: RgbImage): RgbImage {
  if (image.width <= ANALYSIS_WIDTH) return image;
  const height = Math.max(1, Math.round((image.height * ANALYSIS_WIDTH) / image.width));
  return resize(image, ANALYSIS_WIDTH, height);
}

const luminance = (image: RgbImage, i: number) =>
  (LUMA[0] * (image.rgb[i * 3] ?? 0) + LUMA[1] * (image.rgb[i * 3 + 1] ?? 0) + LUMA[2] * (image.rgb[i * 3 + 2] ?? 0)) /
  FULL;

function saturationAt(image: RgbImage, i: number): number {
  const channels = [image.rgb[i * 3] ?? 0, image.rgb[i * 3 + 1] ?? 0, image.rgb[i * 3 + 2] ?? 0];
  const high = Math.max(...channels);
  return high > 0 ? (high - Math.min(...channels)) / high : 0;
}

/** The standard deviation of values. */
function deviation(values: ArrayLike<number>): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < values.length; i++) sum += values[i] ?? 0;
  const mean = sum / values.length;
  let squares = 0;
  for (let i = 0; i < values.length; i++) squares += ((values[i] ?? 0) - mean) ** 2;
  return Math.sqrt(squares / values.length);
}

/** The value at a percentile of values sorted ascending. */
const percentile = (sorted: Float64Array, share: number) =>
  sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(share * (sorted.length - 1))))] ?? 0;

const round3 = (value: number) => Math.round(value * 1000) / 1000;

/** A frame's tone numbers (see {@link Tone}). */
export function toneOf(frame: RgbImage): Tone {
  const image = forAnalysis(frame);
  const count = image.width * image.height;
  const lum = new Float64Array(count);
  let saturation = 0;
  let clipped = 0;
  for (let i = 0; i < count; i++) {
    lum[i] = luminance(image, i);
    saturation += saturationAt(image, i);
    if ((lum[i] ?? 0) >= 1) clipped++;
  }
  const band = (from: number, to: number) =>
    lum.subarray(Math.floor(from * image.height) * image.width, Math.floor(to * image.height) * image.width);
  const nearStd = deviation(band(2 / 3, 1));
  const farStd = deviation(band(1 / 3, 1 / 2));
  const std = deviation(lum);
  const sorted = Float64Array.from(lum).sort();
  const mean = lum.reduce((sum, value) => sum + value, 0) / count;
  return {
    p2: round3(percentile(sorted, 0.02)),
    p98: round3(percentile(sorted, 0.98)),
    mean: round3(mean),
    std: round3(std),
    nearStd: round3(nearStd),
    farStd: round3(farStd),
    saturation: round3(saturation / count),
    clipped: round3(clipped / count),
  };
}

/** Which tone gate checks a frame fails; it passes when it fails none. */
export function toneGate(tone: Tone): { pass: boolean; fails: ToneCheck[] } {
  const fails: ToneCheck[] = [];
  if (tone.p2 > BLACK_POINT_MAX) fails.push(ToneCheck.BlackPoint);
  if (tone.std < CONTRAST_MIN) fails.push(ToneCheck.Contrast);
  if (tone.farStd >= tone.nearStd) fails.push(ToneCheck.AerialPerspective);
  return { pass: fails.length === 0, fails };
}

/** Whether a frame is nearly black (its white point under {@link UNLIT_WHITE_MAX}). */
export const looksUnlit = (tone: Tone): boolean => tone.p98 < UNLIT_WHITE_MAX;

/**
 * How much two consecutive frames differ: the mean absolute difference (0 to 1) of their lower two
 * thirds at 320 x 180, so drifting clouds don't count as motion. A strip whose frames differ by
 * less than about 8/255 shows the same view.
 */
export function frameDifference(a: RgbImage, b: RgbImage): number {
  const [small, other] = [a, b].map((frame) => resize(frame, DIFFERENCE_SIZE.width, DIFFERENCE_SIZE.height));
  if (!small || !other) return 0;
  const from = Math.floor(DIFFERENCE_SIZE.height / 3) * DIFFERENCE_SIZE.width * 3;
  let sum = 0;
  for (let i = from; i < small.rgb.length; i++) sum += Math.abs((small.rgb[i] ?? 0) - (other.rgb[i] ?? 0));
  return sum / (small.rgb.length - from) / FULL;
}

/** Frames laid out `columns` to a row, each scaled to `cellWidth` wide at the first frame's aspect. */
export function contactSheet(frames: RgbImage[], columns: number, cellWidth: number): RgbImage {
  const [first] = frames;
  if (!first) throw new Error(MESSAGE.NoFrames);
  const cellHeight = Math.max(1, Math.round((first.height * cellWidth) / first.width));
  const across = Math.max(1, Math.min(columns, frames.length));
  const rows = Math.ceil(frames.length / across);
  const width = across * cellWidth;
  const sheet = new Uint8Array(width * rows * cellHeight * 3);
  frames.forEach((frame, n) => {
    const cell = resize(frame, cellWidth, cellHeight);
    const [left, top] = [(n % across) * cellWidth, Math.floor(n / across) * cellHeight];
    for (let y = 0; y < cellHeight; y++)
      sheet.set(cell.rgb.subarray(y * cellWidth * 3, (y + 1) * cellWidth * 3), ((top + y) * width + left) * 3);
  });
  return { width, height: rows * cellHeight, rgb: sheet };
}
