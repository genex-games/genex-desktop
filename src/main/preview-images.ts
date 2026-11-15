/**
 * Image operations on stills the preview already took or was handed: crop, diff, stats, resize
 * and the side-by-side pair a judge compares. Plain functions over Electron's `nativeImage`;
 * {@link GamePreview} exposes them as methods.
 */
import { type NativeImage, nativeImage } from "electron";
import {
  computePixelDiff,
  computePixelStats,
  hasTransparency,
  type PixelDiff,
  type PixelStats,
} from "../substrate/pixel-stats.ts";
import type { CropRect } from "../substrate/preview-port.ts";
import { DEFAULT_PAIR_HEIGHT, DEFAULT_STILL_QUALITY, PAIR_QUALITY } from "./core/capture.ts";

/** Why an image operation cannot run: its input could not be decoded. */
const MESSAGE = {
  unreadableImage: (file: string) => `cannot read image ${file}`,
  unreadableDiffFrame: "cannot read one of the frames to diff",
  undecodableImage: "cannot decode the image",
  undecodablePairImage: "cannot decode an image for the pair",
} as const;

/** The heatmap grid of a diff: one cell per 40×40 px of a 1920×1080 frame. */
const DIFF_CELLS = { x: 48, y: 27 };
/** How many pixels a diff samples at most. */
const DIFF_MAX_SAMPLES = 400_000;
/** The mean channel difference that paints a heatmap cell at full heat. */
const DIFF_FULL_HEAT = 64;
/** How much a heatmap cell is scaled up, so the grid reads as blocks. */
const HEATMAP_SCALE = 10;
/** The least height of each half of a pair image. */
const PAIR_MIN_HEIGHT = 64;
/** Each half of a pair is a 16:9 box. */
const PAIR_ASPECT = 16 / 9;
/** The divider between the halves of a pair, in pixels, and its BGRA colour. */
const PAIR_DIVIDER_PX = 4;
const PAIR_DIVIDER_BGRA = [40, 40, 200, 255] as const;

/** A diff of two frames that are not the same size: nothing is compared. */
function emptyDiff(): PixelDiff {
  return { diffFraction: 0, meanAbsDiff: 0, grid: new Array(9).fill(0), compared: 0 };
}

interface Bitmap {
  bitmap: Buffer;
  width: number;
  height: number;
}

/**
 * A `vision` check looks at one crop of the exact frame that was judged, so the crop is cut
 * from the saved JPEG rather than re-captured — two captures could straddle a render.
 */
export function cropImageFile(
  file: string,
  crop: CropRect,
  quality = DEFAULT_STILL_QUALITY,
): { jpeg: Buffer; width: number; height: number } {
  const image = nativeImage.createFromPath(file);
  if (image.isEmpty()) throw new Error(MESSAGE.unreadableImage(file));
  const size = image.getSize();
  const [x0, y0, x1, y1] = crop.map((v) => Math.min(1, Math.max(0, Number(v) || 0))) as CropRect;
  const rect = {
    x: Math.floor(Math.min(x0, x1) * size.width),
    y: Math.floor(Math.min(y0, y1) * size.height),
    width: Math.max(1, Math.ceil(Math.abs(x1 - x0) * size.width)),
    height: Math.max(1, Math.ceil(Math.abs(y1 - y0) * size.height)),
  };
  const cropped = image.crop(rect);
  return { jpeg: cropped.toJPEG(quality), width: rect.width, height: rect.height };
}

/**
 * Challenger-vs-incumbent difference on the same camera: the number that says "nothing
 * visibly changed" before a judge is paid to look, plus a heatmap of where it did.
 */
export function diffImageFiles(fileA: string, fileB: string): { diff: PixelDiff; heatmap: Buffer | null } {
  const a = nativeImage.createFromPath(fileA);
  const b = nativeImage.createFromPath(fileB);
  if (a.isEmpty() || b.isEmpty()) throw new Error(MESSAGE.unreadableDiffFrame);
  const sizeA = a.getSize();
  const sizeB = b.getSize();
  if (sizeA.width !== sizeB.width || sizeA.height !== sizeB.height) {
    return { diff: emptyDiff(), heatmap: null };
  }
  const result = computePixelDiff(a.toBitmap(), b.toBitmap(), sizeA.width, sizeA.height, {
    cells: DIFF_CELLS,
    maxSamples: DIFF_MAX_SAMPLES,
  });
  const heatmap = result.cells ? heatmapPng(result.cells.values) : null;
  const { cells: _cells, ...diff } = result;
  return { diff, heatmap };
}

/** One BGRA pixel per cell: dark where nothing moved, hot where the frames diverge. */
function heatmapPng(values: number[]): Buffer {
  const bitmap = Buffer.alloc(DIFF_CELLS.x * DIFF_CELLS.y * 4);
  values.forEach((value, index) => {
    const heat = Math.min(255, Math.round((value / DIFF_FULL_HEAT) * 255));
    bitmap[index * 4] = Math.round(heat * 0.2); // B
    bitmap[index * 4 + 1] = Math.round(heat * 0.6); // G
    bitmap[index * 4 + 2] = heat; // R
    bitmap[index * 4 + 3] = 255;
  });
  const small = nativeImage.createFromBitmap(bitmap, { width: DIFF_CELLS.x, height: DIFF_CELLS.y });
  return small
    .resize({ width: DIFF_CELLS.x * HEATMAP_SCALE, height: DIFF_CELLS.y * HEATMAP_SCALE, quality: "good" })
    .toPNG();
}

/** Pixel stats of an encoded still (JPEG/PNG/WebP/GIF) — a reference gets the same numbers a capture does. */
export function encodedImageStats(data: Buffer): { stats: PixelStats; width: number; height: number } {
  const image = nativeImage.createFromBuffer(data);
  if (image.isEmpty()) throw new Error(MESSAGE.undecodableImage);
  const size = image.getSize();
  const stats = computePixelStats(image.toBitmap(), size.width, size.height);
  return { stats, width: size.width, height: size.height };
}

/** An encoded image decoded and scaled down so its long side is at most `maxPx`. */
function shrunk(data: Buffer, maxPx: number): NativeImage {
  const image = nativeImage.createFromBuffer(data);
  if (image.isEmpty()) throw new Error(MESSAGE.undecodableImage);
  const { width, height } = image.getSize();
  const long = Math.max(width, height);
  if (long <= maxPx) return image;
  const scale = maxPx / long;
  return image.resize({
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    quality: "good",
  });
}

/** Re-encode as JPEG with the long side capped — a play shot at the play view's width. */
export function resizeToJpeg(data: Buffer, maxPx: number, quality = DEFAULT_STILL_QUALITY): Buffer {
  return shrunk(data, maxPx).toJPEG(quality);
}

/**
 * Re-encode with the long side capped — reference stills at judge/builder size, thumbnails: a
 * JPEG, or a PNG when any pixel is see-through, so a sprite never lands on black.
 */
export function resizeStill(data: Buffer, maxPx: number, quality = DEFAULT_STILL_QUALITY): Buffer {
  const image = shrunk(data, maxPx);
  return hasTransparency(image.toBitmap()) ? image.toPNG() : image.toJPEG(quality);
}

/**
 * LEFT | RIGHT composite: both images fitted into `height`-tall boxes of the same width,
 * on black, with a 4-px divider — the pair image a judge or builder compares.
 */
export function pairJpeg(left: Buffer, right: Buffer, opts: { height?: number; quality?: number } = {}): Buffer {
  const height = Math.max(PAIR_MIN_HEIGHT, Math.round(opts.height ?? DEFAULT_PAIR_HEIGHT));
  const boxWidth = Math.round(height * PAIR_ASPECT);
  const totalWidth = boxWidth * 2 + PAIR_DIVIDER_PX;
  const out = Buffer.alloc(totalWidth * height * 4);
  for (let i = 3; i < out.length; i += 4) out[i] = 255;
  const canvas = { out, totalWidth, boxWidth, height };
  blitCentred(canvas, fitInBox(left, boxWidth, height), 0);
  blitCentred(canvas, fitInBox(right, boxWidth, height), boxWidth + PAIR_DIVIDER_PX);
  paintDivider(canvas);
  return nativeImage.createFromBitmap(out, { width: totalWidth, height }).toJPEG(opts.quality ?? PAIR_QUALITY);
}

interface PairCanvas {
  out: Buffer;
  totalWidth: number;
  boxWidth: number;
  height: number;
}

/** Decode `data` and scale it to fit a `boxWidth`×`height` box, keeping its aspect. */
function fitInBox(data: Buffer, boxWidth: number, height: number): Bitmap {
  const image = nativeImage.createFromBuffer(data);
  if (image.isEmpty()) throw new Error(MESSAGE.undecodablePairImage);
  const size = image.getSize();
  const scale = Math.min(boxWidth / size.width, height / size.height);
  const w = Math.max(1, Math.round(size.width * scale));
  const h = Math.max(1, Math.round(size.height * scale));
  const resized = image.resize({ width: w, height: h, quality: "good" });
  const bitmap = resized.toBitmap();
  // toBitmap may be device-scaled; derive the real row width from the buffer.
  const rowPixels = bitmap.length / 4 / h;
  const realWidth = Number.isInteger(rowPixels) ? rowPixels : w;
  return { bitmap, width: realWidth, height: Math.floor(bitmap.length / 4 / realWidth) };
}

/** Copy `src` into its box at `offsetX`, centred. */
function blitCentred(canvas: PairCanvas, src: Bitmap, offsetX: number): void {
  const { out, totalWidth, boxWidth, height } = canvas;
  const x0 = offsetX + Math.floor((boxWidth - Math.min(boxWidth, src.width)) / 2);
  const y0 = Math.floor((height - Math.min(height, src.height)) / 2);
  const copyWidth = Math.min(boxWidth, src.width);
  for (let y = 0; y < Math.min(height, src.height); y++) {
    src.bitmap.copy(out, ((y0 + y) * totalWidth + x0) * 4, y * src.width * 4, y * src.width * 4 + copyWidth * 4);
  }
}

function paintDivider(canvas: PairCanvas): void {
  const { out, totalWidth, boxWidth, height } = canvas;
  for (let y = 0; y < height; y++) {
    for (let x = boxWidth; x < boxWidth + PAIR_DIVIDER_PX; x++) {
      const i = (y * totalWidth + x) * 4;
      out.set(PAIR_DIVIDER_BGRA, i);
    }
  }
}
