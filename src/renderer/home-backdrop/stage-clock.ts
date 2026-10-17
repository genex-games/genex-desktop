/**
 * When a live background's canvas draws and how far its clock moves (`shader-stage.ts` draws). A
 * moving canvas keeps one clock across every change to what it draws, so a slider being dragged
 * never holds it still; new colours let the frame before go once they have held, not at every
 * change of a colour being picked; a still canvas runs up to its moment only when changes pause,
 * drawing one cheap frame for each change in a stream of them.
 */
import { SECOND_MS } from "../../shared/duration.ts";

/** The most time one frame advances by: a hidden window coming back does not jump ahead. */
const MAX_STEP_SECONDS = 0.1;
/** A frame this much early is still taken, in seconds: rAF times jitter around the cap. */
const FRAME_SLACK_SECONDS = 0.002;
/** New colours hold this long before the frame drawn in the old ones is let go. */
export const RECOLOUR_SETTLE_MS = 200;
/** Changes to a still canvas this close together are a stream: it runs up once they pause this long. */
export const STILL_SETTLE_MS = 200;

/** How a still canvas draws a change: running up to its moment, or one frame on what it holds. */
export const StillDraw = {
  RunUp: "run-up",
  Quick: "quick",
} as const;
export type StillDraw = (typeof StillDraw)[keyof typeof StillDraw];

/** A canvas's clock between frames. */
export interface StageClock {
  fps: number;
  /** Whether frames are being asked for one after another. */
  running: boolean;
  /** The last frame's time in ms, 0 when the next frame starts the clock. */
  last: number;
  /** When the colours last changed while moving, in ms; null when the frame before is in them. */
  recolouredAt: number | null;
  /** When a still canvas last changed, in ms. */
  stillAt: number | null;
}

/** A change to what a canvas draws: whether it moves now, whether its colours changed, and when. */
export interface StageChange {
  moving: boolean;
  recoloured: boolean;
  now: number;
}

/** A canvas's clock, drawing at most `fps` frames a second. */
export function stageClock(fps: number): StageClock {
  return { fps, running: false, last: 0, recolouredAt: null, stillAt: null };
}

/**
 * What a change asks of the canvas: to start moving, or a still frame drawn one way. A canvas
 * already moving needs nothing: its next frame draws what changed, on the same clock.
 */
export function changeStage(clock: StageClock, change: StageChange): { start: boolean; still: StillDraw | null } {
  if (change.moving) {
    if (change.recoloured) clock.recolouredAt = change.now;
    clock.stillAt = null;
    if (clock.running) return { start: false, still: null };
    clock.running = true;
    clock.last = 0;
    return { start: true, still: null };
  }
  clock.running = false;
  clock.recolouredAt = null;
  const streaming = clock.stillAt !== null && change.now - clock.stillAt < STILL_SETTLE_MS;
  clock.stillAt = change.now;
  return { start: false, still: streaming ? StillDraw.Quick : StillDraw.RunUp };
}

/** The seconds a frame at `now` moves the clock by: 0 for the first, null when it comes too soon. */
export function frameStep(clock: StageClock, now: number): number | null {
  const seconds = (now - clock.last) / SECOND_MS;
  if (clock.last && seconds < 1 / clock.fps - FRAME_SLACK_SECONDS) return null;
  const step = clock.last ? Math.min(seconds, MAX_STEP_SECONDS) : 0;
  clock.last = now;
  return step;
}

/** Whether the frame drawn in the old colours goes now: the new ones have held long enough. Once per change. */
export function recolourDue(clock: StageClock, now: number): boolean {
  if (clock.recolouredAt === null || now - clock.recolouredAt < RECOLOUR_SETTLE_MS) return false;
  clock.recolouredAt = null;
  return true;
}

/** Whether a still canvas's changes have paused since `now - STILL_SETTLE_MS`, so it runs up. */
export function stillSettled(clock: StageClock, now: number): boolean {
  return clock.stillAt !== null && now - clock.stillAt >= STILL_SETTLE_MS;
}

/** The canvas stops asking for frames (hidden, or gone); the next moving change starts the clock again. */
export function stopClock(clock: StageClock): void {
  clock.running = false;
  clock.last = 0;
}
