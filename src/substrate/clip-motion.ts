/**
 * How much a clip moves: a few frames sampled while it recorded, each a small BGRA downscale, and
 * the share of neighbouring pairs that differ visibly. A frozen recording scores about 0, a game
 * that keeps moving about 1; noise from the encoder or a blinking cursor stays under the bar.
 */

/** One sampled frame: a small BGRA bitmap (`NativeImage.toBitmap()`) and its size. */
export interface MotionFrame {
  bgra: Buffer;
  width: number;
  height: number;
}

/** A pixel changed when its luma moved by more than this many of 255. */
const MOTION_LUMA_STEP = 8;
/** A pair of frames differs visibly when at least this share of its pixels changed. */
const MOTION_PIXEL_SHARE = 0.005;

/** Rec.709 luma of the pixel at byte offset `i` of a BGRA buffer. */
const lumaAt = (bgra: Buffer, i: number) =>
  0.0722 * (bgra[i] ?? 0) + 0.7152 * (bgra[i + 1] ?? 0) + 0.2126 * (bgra[i + 2] ?? 0);

/** Whether two frames of one size differ visibly; frames of different sizes are never compared. */
export function framesDiffer(a: MotionFrame, b: MotionFrame): boolean | null {
  const pixels = a.width * a.height;
  const sameSize = a.width === b.width && a.height === b.height;
  if (!sameSize || pixels <= 0 || a.bgra.length < pixels * 4 || b.bgra.length < pixels * 4) return null;
  let changed = 0;
  for (let i = 0; i < pixels * 4; i += 4)
    if (Math.abs(lumaAt(a.bgra, i) - lumaAt(b.bgra, i)) > MOTION_LUMA_STEP) changed++;
  return changed / pixels >= MOTION_PIXEL_SHARE;
}

/** 0–1: the share of neighbouring sampled frames that differ visibly; 0 with fewer than two comparable frames. */
export function clipMotion(frames: readonly MotionFrame[]): number {
  let pairs = 0;
  let differing = 0;
  for (let i = 1; i < frames.length; i++) {
    const before = frames[i - 1];
    const after = frames[i];
    const differs = before && after ? framesDiffer(before, after) : null;
    if (differs === null) continue;
    pairs++;
    if (differs) differing++;
  }
  return pairs ? differing / pairs : 0;
}
