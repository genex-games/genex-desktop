/**
 * Pixel statistics over a raw BGRA bitmap — the cheapest possible answer to "is anything
 * actually drawn?", and since the v2 loop also the arithmetic behind
 * every `pixel` check: luminance bands, lit fraction, histogram, region means, saturation,
 * contrast, and the frame-to-frame diff that catches an invisible change before a judge is
 * paid to look at it. A build whose probes all pass can still render nothing, and a vision
 * model politely describes whatever it imagines in a black JPEG. Counting pixels is not fooled.
 *
 * Pure math, zero Electron imports, so the conformance suite can prove the arithmetic —
 * including the byte order — under plain node.
 */
import type { PixelDiff, PixelStats, StillExposure } from "../shared/preview-contract.ts";

/** Below-or-equal is "unlit": luma 8 of 255 is the preview's own #05070d backdrop territory. */
export const LUMA_THRESHOLD = 8;

/** Stride-sampling cap: a 4K capture is ~8M pixels and the answer does not need all of them. */
export const MAX_SAMPLES = 200_000;

/** Histogram resolution: 32 bins over luma 0–255, so `fractionAbove(0.9)` resolves to 1/32. */
export const HISTOGRAM_BINS = 32;

/** A pixel counts as changed between two frames when its luma moved by more than this (0–255). */
export const DIFF_THRESHOLD = 12;

/** A sample darker than this luma (0–1) counts as near black in a still's exposure. */
export const NEAR_BLACK_LUMA = 0.1;

export type { PixelDiff, PixelStats };

export const HUE_BINS = 12;
export const PALETTE_SIZE = 6;
export const PROFILE_ROWS = 16;
/** Lab samples kept for the palette; more buys nothing a 6-centroid k-means can use. */
const PALETTE_SAMPLES = 2_048;

/** Lloyd steps the palette's k-means runs at most. */
const PALETTE_ITERATIONS = 10;

/** The 3×3 grid a frame diff reports its changed fraction on. */
const DIFF_GRID_SIDE = 3;

type Lab = [number, number, number];
type Band = "top" | "middle" | "bottom" | "left" | "center" | "right";

/** Rec.709 luma of the pixel at byte offset `i` of a BGRA buffer (B, G, R at 0, 1, 2). */
function lumaAt(bgra: Buffer, i: number): number {
  return 0.0722 * (bgra[i] ?? 0) + 0.7152 * (bgra[i + 1] ?? 0) + 0.2126 * (bgra[i + 2] ?? 0);
}

/** The frame a statistics pass reads: its bytes, its geometry and the sampling it was given. */
interface StatsFrame {
  bgra: Buffer;
  pixelCount: number;
  rowPixels: number;
  rows: number;
  threshold: number;
  labStride: number;
}

/** Running sums over the sampled pixels, one per statistic `computePixelStats` reports. */
interface StatsSums {
  sampled: number;
  lumaSum: number;
  lumaSquares: number;
  lit: number;
  saturationSum: number;
  edgeSum: number;
  edgeCount: number;
  histogram: number[];
  hueHistogram: number[];
  hueWeight: number;
  labSum: Lab;
  labSquares: Lab;
  labSamples: Lab[];
  profileSum: number[];
  profileCount: number[];
  bandSum: Record<Band, number>;
  bandCount: Record<Band, number>;
}

function emptyStatsSums(): StatsSums {
  return {
    sampled: 0,
    lumaSum: 0,
    lumaSquares: 0,
    lit: 0,
    saturationSum: 0,
    edgeSum: 0,
    edgeCount: 0,
    histogram: new Array<number>(HISTOGRAM_BINS).fill(0),
    hueHistogram: new Array<number>(HUE_BINS).fill(0),
    hueWeight: 0,
    labSum: [0, 0, 0],
    labSquares: [0, 0, 0],
    labSamples: [],
    profileSum: new Array<number>(PROFILE_ROWS).fill(0),
    profileCount: new Array<number>(PROFILE_ROWS).fill(0),
    bandSum: { top: 0, middle: 0, bottom: 0, left: 0, center: 0, right: 0 },
    bandCount: { top: 0, middle: 0, bottom: 0, left: 0, center: 0, right: 0 },
  };
}

/** Add one to a counter array's slot. */
function bump(counts: number[], index: number, by = 1): void {
  counts[index] = (counts[index] ?? 0) + by;
}

/** Which third of the frame a row falls in. */
function verticalBand(row: number, rows: number): Band {
  if (row * 3 < rows) return "top";
  if (row * 3 < rows * 2) return "middle";
  return "bottom";
}

/** Which third of the frame a column falls in. */
function horizontalBand(col: number, rowPixels: number): Band {
  if (col * 3 < rowPixels) return "left";
  if (col * 3 < rowPixels * 2) return "center";
  return "right";
}

/** The colour half of one sample: saturation, hue weight and the Lab moments and samples. */
function addColour(sums: StatsSums, frame: StatsFrame, r: number, g: number, b: number): void {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const saturation = max > 0 ? (max - min) / max : 0;
  sums.saturationSum += saturation;
  if (max > min) {
    bump(sums.hueHistogram, hueBin(r, g, b, max, min), saturation);
    sums.hueWeight += saturation;
  }
  const lab = rgbToLab(r, g, b);
  for (const k of [0, 1, 2] as const) {
    sums.labSum[k] += lab[k];
    sums.labSquares[k] += lab[k] * lab[k];
  }
  if (sums.sampled % frame.labStride === 1 || frame.labStride === 1) sums.labSamples.push(lab);
}

/** The position half of one sample: its profile row, its edge to the right, and its bands. */
function addPlacement(sums: StatsSums, frame: StatsFrame, pixel: number, luma: number): void {
  const { rowPixels, rows } = frame;
  const row = Math.floor(pixel / rowPixels);
  const col = pixel - row * rowPixels;
  const profileRow = Math.min(PROFILE_ROWS - 1, Math.floor((row * PROFILE_ROWS) / rows));
  bump(sums.profileSum, profileRow, luma);
  bump(sums.profileCount, profileRow);
  if (col + 1 < rowPixels && pixel + 1 < frame.pixelCount) {
    const next = lumaAt(frame.bgra, pixel * 4 + 4);
    sums.edgeSum += Math.abs(next - luma);
    sums.edgeCount++;
  }
  const vertical = verticalBand(row, rows);
  const horizontal = horizontalBand(col, rowPixels);
  sums.bandSum[vertical] += luma;
  sums.bandCount[vertical]++;
  sums.bandSum[horizontal] += luma;
  sums.bandCount[horizontal]++;
}

function addPixel(sums: StatsSums, frame: StatsFrame, pixel: number): void {
  const i = pixel * 4;
  const b = frame.bgra[i] ?? 0;
  const g = frame.bgra[i + 1] ?? 0;
  const r = frame.bgra[i + 2] ?? 0;
  const luma = 0.0722 * b + 0.7152 * g + 0.2126 * r;
  sums.lumaSum += luma;
  sums.lumaSquares += luma * luma;
  if (luma > frame.threshold) sums.lit++;
  sums.sampled++;
  bump(sums.histogram, Math.min(HISTOGRAM_BINS - 1, Math.floor((luma / 256) * HISTOGRAM_BINS)));
  addColour(sums, frame, r, g, b);
  addPlacement(sums, frame, pixel, luma);
}

/** The statistics the sums add up to. */
function statsFrom(sums: StatsSums, width: number, height: number): PixelStats {
  const { sampled } = sums;
  const meanLuma = sums.lumaSum / sampled;
  const variance = Math.max(0, sums.lumaSquares / sampled - meanLuma * meanLuma);
  const band = (name: Band): number =>
    sums.bandCount[name] > 0 ? sums.bandSum[name] / sums.bandCount[name] : meanLuma;
  const labMean = (k: 0 | 1 | 2): number => sums.labSum[k] / sampled;
  const labStd = (k: 0 | 1 | 2): number => Math.sqrt(Math.max(0, sums.labSquares[k] / sampled - labMean(k) ** 2));
  return {
    width,
    height,
    sampled,
    meanLuma,
    litFraction: sums.lit / sampled,
    histogram: sums.histogram.map((count) => count / sampled),
    bands: {
      top: band("top"),
      middle: band("middle"),
      bottom: band("bottom"),
      left: band("left"),
      center: band("center"),
      right: band("right"),
    },
    saturation: sums.saturationSum / sampled,
    contrast: Math.sqrt(variance),
    edgeDensity: sums.edgeCount > 0 ? sums.edgeSum / sums.edgeCount : 0,
    hueHistogram: sums.hueHistogram.map((weight) => (sums.hueWeight > 0 ? weight / sums.hueWeight : 0)),
    lab: {
      mean: [labMean(0), labMean(1), labMean(2)],
      std: [labStd(0), labStd(1), labStd(2)],
    },
    palette: labPalette(sums.labSamples, PALETTE_SIZE),
    lumaProfile: sums.profileSum.map((sum, index) => {
      const count = sums.profileCount[index] ?? 0;
      return count > 0 ? sum / count : meanLuma;
    }),
  };
}

/**
 * `NativeImage.toBitmap()` is **BGRA** (B, G, R at byte offsets 0, 1, 2) — reading it as RGBA
 * swaps the red and blue Rec.709 weights and a pure-red scene scores 18 instead of 54.
 *
 * The buffer is never trusted to match `width * height * 4`: `toBitmap()` returns device
 * pixels while `getSize()` reports DIPs, so on Retina the buffer is legitimately larger (rows
 * derived from length when it divides cleanly); a short buffer yields whole usable rows
 * instead of a throw, because a degraded capture must degrade the stats, not the run.
 */
export function computePixelStats(
  bgra: Buffer,
  width: number,
  height: number,
  opts: { lumaThreshold?: number; maxSamples?: number } = {},
): PixelStats {
  const threshold = opts.lumaThreshold ?? LUMA_THRESHOLD;
  const maxSamples = Math.max(1, opts.maxSamples ?? MAX_SAMPLES);
  const { pixelCount, rowPixels } = pixelGeometry(bgra, width, height);

  if (pixelCount <= 0) {
    return { width, height, sampled: 0, meanLuma: 0, litFraction: 0 };
  }

  const stride = Math.max(1, Math.ceil(pixelCount / maxSamples));
  const frame: StatsFrame = {
    bgra,
    pixelCount,
    rowPixels,
    rows: Math.max(1, Math.floor(pixelCount / rowPixels)),
    threshold,
    labStride: Math.max(1, Math.ceil(Math.ceil(pixelCount / stride) / PALETTE_SAMPLES)),
  };
  const sums = emptyStatsSums();
  for (let pixel = 0; pixel < pixelCount; pixel += stride) addPixel(sums, frame, pixel);
  return statsFrom(sums, width, height);
}

/** HSV hue bin (0–11) of an RGB triple whose max/min are already known and differ. */
function hueBin(r: number, g: number, b: number, max: number, min: number): number {
  const d = max - min;
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return Math.min(HUE_BINS - 1, Math.floor((h / 360) * HUE_BINS));
}

/** sRGB (0–255) → CIE Lab under D65. Pure arithmetic; the palette and the Lab moments use it. */
export function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  const lin = (c: number): number => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const rl = lin(r);
  const gl = lin(g);
  const bl = lin(b);
  const x = (rl * 0.4124 + gl * 0.3576 + bl * 0.1805) / 0.95047;
  const y = rl * 0.2126 + gl * 0.7152 + bl * 0.0722;
  const z = (rl * 0.0193 + gl * 0.1192 + bl * 0.9505) / 1.08883;
  const f = (t: number): number => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** The index of the centroid nearest a sample (the first one on a tie). */
function nearestCentroid(sample: Lab, centroids: Lab[]): number {
  let best = 0;
  let bestDist = Infinity;
  centroids.forEach((centroid, c) => {
    const d = labDistance(sample, centroid);
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  });
  return best;
}

/** Assign every sample to its nearest centroid; true when any assignment changed. */
function assignSamples(samples: Lab[], centroids: Lab[], assignment: number[]): boolean {
  let moved = false;
  samples.forEach((sample, s) => {
    const best = nearestCentroid(sample, centroids);
    if (assignment[s] !== best) {
      assignment[s] = best;
      moved = true;
    }
  });
  return moved;
}

/** Each centroid moved to the mean of its samples; a centroid with none stays where it was. */
function recentre(samples: Lab[], assignment: number[], centroids: Lab[]): Lab[] {
  const sums = centroids.map(() => [0, 0, 0, 0] as [number, number, number, number]);
  samples.forEach((sample, s) => {
    const target = sums[assignment[s] ?? 0];
    if (!target) return;
    target[0] += sample[0];
    target[1] += sample[1];
    target[2] += sample[2];
    target[3] += 1;
  });
  return centroids.map((old, c) => {
    const [l, a, b, count] = sums[c] ?? [0, 0, 0, 0];
    return count > 0 ? ([l / count, a / count, b / count] as Lab) : old;
  });
}

/**
 * A deterministic k-means over Lab samples: centroids seeded at evenly spaced sample indices
 * (never a random pick, so two runs over one frame agree byte for byte), ten Lloyd steps,
 * output heaviest first. Fewer distinct samples than k yields fewer centroids.
 */
export function labPalette(samples: Array<Lab>, k = PALETTE_SIZE): Array<{ lab: Lab; weight: number }> {
  const n = samples.length;
  if (n === 0) return [];
  const count = Math.min(k, n);
  let centroids: Lab[] = Array.from({ length: count }, (_, i) => {
    const seed = samples[Math.floor((i * n) / count)] ?? [0, 0, 0];
    return [...seed] as Lab;
  });
  const assignment = new Array<number>(n).fill(0);
  for (let iteration = 0; iteration < PALETTE_ITERATIONS; iteration++) {
    const moved = assignSamples(samples, centroids, assignment);
    centroids = recentre(samples, assignment, centroids);
    if (!moved && iteration > 0) break;
  }
  const weights = new Array<number>(count).fill(0);
  for (const c of assignment) weights[c] = (weights[c] ?? 0) + 1;
  return centroids
    .map((lab, c) => ({ lab, weight: (weights[c] ?? 0) / n }))
    .filter((entry) => entry.weight > 0)
    .sort((a, b) => b.weight - a.weight);
}

export function labDistance(a: readonly number[], b: readonly number[]): number {
  return Math.hypot((a[0] ?? 0) - (b[0] ?? 0), (a[1] ?? 0) - (b[1] ?? 0), (a[2] ?? 0) - (b[2] ?? 0));
}

/**
 * A still's exposure over every pixel of a small BGRA bitmap (a downscale of the still): luma mean
 * and standard deviation, the share below {@link NEAR_BLACK_LUMA} and the share above
 * {@link LUMA_THRESHOLD}, all 0–1. Rec.709 on the sRGB bytes as they are, the same reading a caller
 * judging exposure takes of a frame. A bitmap with no whole row reads as black.
 */
export function exposureStats(bgra: Buffer, width: number, height: number): StillExposure {
  const { pixelCount } = pixelGeometry(bgra, width, height);
  if (pixelCount <= 0) return { lumaMean: 0, lumaStdDev: 0, nearBlackFraction: 1, litFraction: 0 };
  let sum = 0;
  let squares = 0;
  let nearBlack = 0;
  let lit = 0;
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    const luma = lumaAt(bgra, pixel * 4);
    const unit = luma / 255;
    sum += unit;
    squares += unit * unit;
    if (unit < NEAR_BLACK_LUMA) nearBlack++;
    if (luma > LUMA_THRESHOLD) lit++;
  }
  const lumaMean = sum / pixelCount;
  // Floating-point cancellation can leave a flat frame's variance a hair below zero.
  const lumaStdDev = Math.sqrt(Math.max(0, squares / pixelCount - lumaMean * lumaMean));
  return { lumaMean, lumaStdDev, nearBlackFraction: nearBlack / pixelCount, litFraction: lit / pixelCount };
}

/** Under half a percent lit is a blank screen, whatever the probes claim. */
export function isEffectivelyBlack(stats: PixelStats): boolean {
  return stats.litFraction < 0.005;
}

/** Fraction of pixels whose luma (0–1) is above `t`, from the histogram; null without one. */
export function fractionAbove(stats: PixelStats, t: number): number | null {
  if (!stats.histogram) return null;
  const bins = stats.histogram.length;
  const firstBin = Math.min(bins, Math.max(0, Math.ceil(t * bins)));
  let sum = 0;
  for (let i = firstBin; i < bins; i++) sum += stats.histogram[i] ?? 0;
  return sum;
}

/** Fraction of pixels whose luma (0–1) is below `t`, from the histogram; null without one. */
export function fractionBelow(stats: PixelStats, t: number): number | null {
  if (!stats.histogram) return null;
  const bins = stats.histogram.length;
  const lastBin = Math.min(bins, Math.max(0, Math.floor(t * bins)));
  let sum = 0;
  for (let i = 0; i < lastBin; i++) sum += stats.histogram[i] ?? 0;
  return sum;
}

/** Running sums of a frame diff: the whole frame, the 3×3 grid, and the optional heatmap cells. */
interface DiffSums {
  compared: number;
  changed: number;
  absSum: number;
  gridChanged: number[];
  gridCount: number[];
  cells: { x: number; y: number; sum: number[]; count: number[] } | null;
}

/** The frame a diff pass reads: both bitmaps and the geometry they share. */
interface DiffFrame {
  a: Buffer;
  b: Buffer;
  rowPixels: number;
  rows: number;
  threshold: number;
}

function emptyDiffSums(cellsX: number, cellsY: number): DiffSums {
  const gridCells = DIFF_GRID_SIDE * DIFF_GRID_SIDE;
  const withCells = cellsX && cellsY;
  return {
    compared: 0,
    changed: 0,
    absSum: 0,
    gridChanged: new Array<number>(gridCells).fill(0),
    gridCount: new Array<number>(gridCells).fill(0),
    cells: withCells
      ? {
          x: cellsX,
          y: cellsY,
          sum: new Array<number>(cellsX * cellsY).fill(0),
          count: new Array<number>(cellsX * cellsY).fill(0),
        }
      : null,
  };
}

function addDiffPixel(sums: DiffSums, frame: DiffFrame, pixel: number): void {
  const i = pixel * 4;
  const delta = Math.abs(lumaAt(frame.a, i) - lumaAt(frame.b, i));
  sums.absSum += delta;
  sums.compared++;
  const { rowPixels, rows } = frame;
  const row = Math.floor(pixel / rowPixels);
  const col = pixel - row * rowPixels;
  const last = DIFF_GRID_SIDE - 1;
  const cell =
    Math.min(last, Math.floor((row * DIFF_GRID_SIDE) / rows)) * DIFF_GRID_SIDE +
    Math.min(last, Math.floor((col * DIFF_GRID_SIDE) / rowPixels));
  bump(sums.gridCount, cell);
  if (delta > frame.threshold) {
    sums.changed++;
    bump(sums.gridChanged, cell);
  }
  const { cells } = sums;
  if (cells) {
    const cy = Math.min(cells.y - 1, Math.floor((row * cells.y) / rows));
    const cx = Math.min(cells.x - 1, Math.floor((col * cells.x) / rowPixels));
    bump(cells.sum, cy * cells.x + cx, delta);
    bump(cells.count, cy * cells.x + cx);
  }
}

/** Each slot's sum over its count; an empty slot is 0. */
function perSlot(sums: number[], counts: number[]): number[] {
  return sums.map((sum, index) => {
    const count = counts[index] ?? 0;
    return count > 0 ? sum / count : 0;
  });
}

/**
 * Frame-to-frame difference between two BGRA bitmaps of the same nominal size. Also returns
 * a per-cell luma diff map (0–255 mean absolute difference) sized `cellsX × cellsY` when
 * asked, which is what a heatmap is drawn from. Mismatched sizes compare nothing — an honest
 * zero, never a guess.
 */
export function computePixelDiff(
  a: Buffer,
  b: Buffer,
  width: number,
  height: number,
  opts: { threshold?: number; maxSamples?: number; cells?: { x: number; y: number } } = {},
): PixelDiff & { cells?: { x: number; y: number; values: number[] } } {
  const threshold = opts.threshold ?? DIFF_THRESHOLD;
  const maxSamples = Math.max(1, opts.maxSamples ?? MAX_SAMPLES);
  const ga = pixelGeometry(a, width, height);
  const gb = pixelGeometry(b, width, height);
  const pixelCount = Math.min(ga.pixelCount, gb.pixelCount);
  if (pixelCount <= 0 || ga.rowPixels !== gb.rowPixels) {
    return { diffFraction: 0, meanAbsDiff: 0, grid: new Array(DIFF_GRID_SIDE * DIFF_GRID_SIDE).fill(0), compared: 0 };
  }
  const rowPixels = ga.rowPixels;
  const frame: DiffFrame = { a, b, rowPixels, rows: Math.max(1, Math.floor(pixelCount / rowPixels)), threshold };
  const stride = Math.max(1, Math.ceil(pixelCount / maxSamples));
  const sums = emptyDiffSums(opts.cells?.x ?? 0, opts.cells?.y ?? 0);
  for (let pixel = 0; pixel < pixelCount; pixel += stride) addDiffPixel(sums, frame, pixel);
  const { compared, cells } = sums;
  return {
    diffFraction: compared ? sums.changed / compared : 0,
    meanAbsDiff: compared ? sums.absSum / compared : 0,
    grid: perSlot(sums.gridChanged, sums.gridCount),
    compared,
    ...(cells ? { cells: { x: cells.x, y: cells.y, values: perSlot(cells.sum, cells.count) } } : {}),
  };
}

function pixelGeometry(bgra: Buffer, width: number, height: number): { pixelCount: number; rowPixels: number } {
  const rowBytes = width * 4;
  const expected = rowBytes * height;
  const hasArea = width > 0 && height > 0 && rowBytes > 0;
  if (!hasArea) return { pixelCount: 0, rowPixels: Math.max(1, width) };
  if (bgra.length >= expected) {
    if (bgra.length % rowBytes === 0) return { pixelCount: bgra.length / 4, rowPixels: width };
    // A Retina buffer that is not a whole number of DIP rows: assume square scaling.
    const scale = Math.round(Math.sqrt(bgra.length / expected));
    const rowPixels = Math.max(1, width * Math.max(1, scale));
    return { pixelCount: Math.floor(bgra.length / 4 / rowPixels) * rowPixels, rowPixels };
  }
  return { pixelCount: Math.floor(bgra.length / rowBytes) * width, rowPixels: width };
}
