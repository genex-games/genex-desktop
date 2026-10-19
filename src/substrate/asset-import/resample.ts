/**
 * Resampling a loose texture into its square power-of-two size class (game systems C-12, owner
 * call 7): the runtime's size-class arrays hold square, power-of-two layers, so a 1000x600 image
 * becomes 1024x1024 before it is encoded, and the receipt says so (`resampled`). Each axis is
 * filtered on its own: an axis that shrinks takes a box filter (each output texel the exact
 * area-weighted mean of the source texels it covers), one that grows a Mitchell-Netravali cubic
 * (B = C = 1/3). Colour is filtered in linear light, data as stored, and a normal map's texels are
 * renormalized to unit vectors afterwards. Our own code; pure and deterministic, so the same image
 * and usage always give the same bytes.
 */
import { TextureUsage } from "./basis-encoder.ts";

/** The largest size class: a source larger than this is filtered down to it. */
export const TEXTURE_SIDE_MAX = 4096;

/** An 8-bit RGBA image, rows top to bottom. */
export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8Array;
}

const CHANNELS = 4;
const ALPHA = 3;
/** Mitchell-Netravali's B and C, and its support either side of a sample. */
const MITCHELL_B = 1 / 3;
const MITCHELL_C = 1 / 3;
const MITCHELL_SUPPORT = 2;

/**
 * The square power-of-two side a `width` x `height` image is encoded at: the power of two nearest
 * its longer side in log steps (1000 → 1024, 700 → 512), at most {@link TEXTURE_SIDE_MAX}.
 */
export function textureSideClass(width: number, height: number): number {
  const longer = Math.max(1, width, height);
  return Math.min(TEXTURE_SIDE_MAX, 2 ** Math.round(Math.log2(longer)));
}

/** sRGB-encoded byte → linear light, by table so every run reads the same numbers. */
const SRGB_TO_LINEAR = Float64Array.from({ length: 256 }, (_, v) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});

/** Linear light → the nearest sRGB-encoded byte. */
function linearToSrgbByte(linear: number): number {
  const c = Math.min(1, Math.max(0, linear));
  const encoded = c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
  return Math.round(encoded * 255);
}

const toByte = (value: number) => Math.round(Math.min(1, Math.max(0, value)) * 255);

/** One output texel's taps along an axis: source indices and weights that sum to 1. */
interface Taps {
  at: Int32Array;
  weight: Float64Array;
}

/** Mitchell-Netravali's kernel at distance `x`. */
function mitchell(x: number): number {
  const t = Math.abs(x);
  const [b, c] = [MITCHELL_B, MITCHELL_C];
  if (t < 1) return ((12 - 9 * b - 6 * c) * t ** 3 + (-18 + 12 * b + 6 * c) * t ** 2 + (6 - 2 * b)) / 6;
  if (t < MITCHELL_SUPPORT)
    return ((-b - 6 * c) * t ** 3 + (6 * b + 30 * c) * t ** 2 + (-12 * b - 48 * c) * t + (8 * b + 24 * c)) / 6;
  return 0;
}

/** Taps for a shrinking axis: each source texel weighted by how much of the output texel it covers. */
function boxTaps(source: number, target: number): Taps[] {
  const scale = source / target;
  return Array.from({ length: target }, (_, i) => {
    const [from, to] = [i * scale, (i + 1) * scale];
    const first = Math.floor(from);
    const last = Math.min(source - 1, Math.ceil(to) - 1);
    const at: number[] = [];
    const weight: number[] = [];
    for (let s = first; s <= last; s++) {
      at.push(s);
      weight.push((Math.min(to, s + 1) - Math.max(from, s)) / scale);
    }
    return { at: Int32Array.from(at), weight: Float64Array.from(weight) };
  });
}

/** Taps for a growing axis: the Mitchell cubic around each output texel's centre, edges clamped. */
function mitchellTaps(source: number, target: number): Taps[] {
  const scale = source / target;
  return Array.from({ length: target }, (_, i) => {
    const centre = (i + 0.5) * scale - 0.5;
    const base = Math.floor(centre);
    const at: number[] = [];
    const weight: number[] = [];
    for (let s = base - MITCHELL_SUPPORT + 1; s <= base + MITCHELL_SUPPORT; s++) {
      at.push(Math.min(source - 1, Math.max(0, s)));
      weight.push(mitchell(centre - s));
    }
    const sum = weight.reduce((a, b) => a + b, 0);
    return { at: Int32Array.from(at), weight: Float64Array.from(weight, (w) => w / sum) };
  });
}

/** The taps that take an axis of `source` texels to `target`. */
function axisTaps(source: number, target: number): Taps[] {
  if (target === source)
    return Array.from({ length: target }, (_, i) => ({ at: Int32Array.of(i), weight: Float64Array.of(1) }));
  return target < source ? boxTaps(source, target) : mitchellTaps(source, target);
}

/** The image's channels as numbers in the space they are filtered in. */
function toWorking(image: RgbaImage, usage: TextureUsage): Float32Array {
  const out = new Float32Array(image.data.length);
  const color = usage === TextureUsage.Color;
  for (let at = 0; at < image.data.length; at++) {
    const value = image.data[at] ?? 0;
    out[at] = color && at % CHANNELS !== ALPHA ? (SRGB_TO_LINEAR[value] ?? 0) : value / 255;
  }
  return out;
}

/** `out`'s texel at `target` set to the weighted sum of `input`'s texels `stride` apart from `first`. */
function filterTexel(out: Float32Array, target: number, input: Float32Array, tap: Taps, first: number, stride: number) {
  for (let k = 0; k < tap.at.length; k++) {
    const weight = tap.weight[k] ?? 0;
    const from = (first + (tap.at[k] ?? 0) * stride) * CHANNELS;
    for (let c = 0; c < CHANNELS; c++) out[target + c] = (out[target + c] ?? 0) + weight * (input[from + c] ?? 0);
  }
}

/** One pass along rows (`horizontal`) or columns, `width` x `height` in, the axis resized by `taps`. */
function pass(input: Float32Array, width: number, height: number, taps: Taps[], horizontal: boolean): Float32Array {
  const [outWidth, outHeight] = horizontal ? [taps.length, height] : [width, taps.length];
  const out = new Float32Array(outWidth * outHeight * CHANNELS);
  for (let y = 0; y < outHeight; y++) {
    for (let x = 0; x < outWidth; x++) {
      const tap = taps[horizontal ? x : y];
      // Along a row the source texels are 1 apart from the row's start; down a column, `width` apart.
      const [first, stride] = horizontal ? [y * width, 1] : [x, width];
      if (tap) filterTexel(out, (y * outWidth + x) * CHANNELS, input, tap, first, stride);
    }
  }
  return out;
}

/** A normal map's texel as a unit vector again (a zero vector points straight out). */
function renormalize(work: Float32Array, at: number): void {
  const [x, y, z] = [0, 1, 2].map((c) => (work[at + c] ?? 0.5) * 2 - 1) as [number, number, number];
  const length = Math.hypot(x, y, z);
  const [nx, ny, nz] = length > 0 ? [x / length, y / length, z / length] : [0, 0, 1];
  work[at] = (nx + 1) / 2;
  work[at + 1] = (ny + 1) / 2;
  work[at + 2] = (nz + 1) / 2;
}

/** The filtered channels back to bytes in the usage's own encoding. */
function toBytes(work: Float32Array, usage: TextureUsage): Uint8Array {
  const out = new Uint8Array(work.length);
  const color = usage === TextureUsage.Color;
  for (let at = 0; at < work.length; at += CHANNELS) {
    if (usage === TextureUsage.Normal) renormalize(work, at);
    for (let c = 0; c < CHANNELS; c++) {
      const value = work[at + c] ?? 0;
      out[at + c] = color && c !== ALPHA ? linearToSrgbByte(value) : toByte(value);
    }
  }
  return out;
}

/**
 * `image` filtered to `side` x `side` for `usage` (see the module comment). An image already that
 * size comes back as it is: the same bytes, not a copy.
 */
export function resampleSquare(image: RgbaImage, side: number, usage: TextureUsage): RgbaImage {
  if (image.width === side && image.height === side) return image;
  const working = toWorking(image, usage);
  // Resize the axis that shrinks most first, so the intermediate image is the smaller of the two.
  const widthFirst = side / image.width <= side / image.height;
  const columns = axisTaps(image.width, side);
  const rows = axisTaps(image.height, side);
  const filtered = widthFirst
    ? pass(pass(working, image.width, image.height, columns, true), side, image.height, rows, false)
    : pass(pass(working, image.width, image.height, rows, false), image.width, side, columns, true);
  return { width: side, height: side, data: toBytes(filtered, usage) };
}
