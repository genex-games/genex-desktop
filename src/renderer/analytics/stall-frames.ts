/**
 * What a stalled window was doing (`ui_stall_summarized`): how long the longest frame of a summary
 * ran and how much of it was style and layout (the Long Animation Frames API; the studio window is
 * a `file:` page, so the API names none of its scripts), the work that followed the longest batch
 * of records and how many records it held, and how much memory the window's JavaScript held. A
 * long task says only that the window froze; these say on what.
 */

/** The performance entry type that carries frames. */
export const LONG_FRAME_ENTRY = "long-animation-frame";
const BYTES_PER_MB = 1024 * 1024;

/** A long frame, read down to plain fields: when it started, how long it ran, its style and layout. */
export interface LongFrame {
  startTime: number;
  duration: number;
  /** When the frame's own style and layout began, on the page's clock; 0 when it laid nothing out. */
  styleAndLayoutStart: number;
}

/** The longest frame of a summary: how long it ran and how much of it was style and layout. */
export interface FrameBlame {
  ms: number;
  layoutMs: number;
}

/** The longest batch of records of a summary: the window's work after it, and its size. */
export interface BatchBlame {
  ms: number;
  records: number;
}

/** The window's JavaScript memory, in MB. */
export interface HeapNow {
  usedMb: number;
  limitMb: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const numberOf = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/** A `long-animation-frame` entry read down to plain fields, or null when it is not one. */
export function readLongFrame(entry: unknown): LongFrame | null {
  if (!isRecord(entry) || entry.entryType !== LONG_FRAME_ENTRY) return null;
  return {
    startTime: numberOf(entry.startTime),
    duration: numberOf(entry.duration),
    styleAndLayoutStart: numberOf(entry.styleAndLayoutStart),
  };
}

/** How long a frame ran and how much of its end was style and layout. */
export function frameBlame(frame: LongFrame): FrameBlame {
  const end = frame.startTime + frame.duration;
  const laidOut = frame.styleAndLayoutStart > 0 ? end - frame.styleAndLayoutStart : 0;
  return { ms: Math.round(frame.duration), layoutMs: Math.round(Math.min(frame.duration, Math.max(0, laidOut))) };
}

/** The longer of two frames, or of two batches. */
export const longer = <T extends { ms: number }>(kept: T | null, next: T): T =>
  kept && kept.ms >= next.ms ? kept : next;

/** The window's JavaScript memory (Chromium's `performance.memory`), or null where it is not told. */
export function heapNow(source: unknown = globalThis.performance): HeapNow | null {
  const memory = isRecord(source) ? source.memory : undefined;
  if (!isRecord(memory)) return null;
  const used = numberOf(memory.usedJSHeapSize);
  const limit = numberOf(memory.jsHeapSizeLimit);
  if (used <= 0 || limit <= 0) return null;
  return { usedMb: Math.round(used / BYTES_PER_MB), limitMb: Math.round(limit / BYTES_PER_MB) };
}

/**
 * Run `then` once the current task is over (its microtasks, and the render a store's update queued
 * in them, included): a message posted to a channel of its own, which a hidden window does not
 * delay as it does a timer.
 */
export function afterTask(then: () => void): void {
  const channel = new MessageChannel();
  channel.port1.onmessage = () => {
    channel.port1.close();
    then();
  };
  channel.port2.postMessage(null);
}
