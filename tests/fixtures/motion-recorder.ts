/**
 * What a person sees move in the chat, frame by frame: the live parts' boxes, opacity and the
 * status line's words, and the jumps, pops and flashes they add up to. Runs in the page, on
 * requestAnimationFrame, so a bad frame is caught where it is drawn.
 */

/** A part of the chat the recorder follows, by its data hook. */
const LIVE_PARTS = {
  status: "[data-chat-status]",
  build: "[data-build-status]",
  streaming: "[data-streaming-reply]",
  pending: "[data-pending-send]",
  dock: "[data-pending-questions]",
  composer: "[data-promptbar]",
  // The status line's chevron, which slides as the words before it change.
  chevron: "[data-chat-status] .chat-chevron",
} as const;

/** One part as drawn in one frame: its top and height on screen, how opaque it looks, and whether it can be seen. */
export interface PartBox {
  top: number;
  left: number;
  height: number;
  opacity: number;
  seen: boolean;
}

/** One recorded frame: when it was drawn and every followed part in it. */
export interface MotionFrame {
  at: number;
  parts: Record<string, PartBox>;
  label: string | null;
  running: number;
}

/** A recording: its frames and the long tasks the main thread ran meanwhile (ms each). */
export interface Recording {
  frames: MotionFrame[];
  longTasks: number[];
}

/** A part that moved its whole way in one frame, still before and after. */
export interface Jump {
  part: string;
  at: number;
  by: number;
}

/** A part that came or went at (nearly) full opacity. */
export interface Pop {
  part: string;
  at: number;
  opacity: number;
  way: "in" | "out";
}

/** A status label that gave way to another before it could be read. */
export interface Flash {
  label: string;
  shownMs: number;
}

/**
 * How a part that should hold still kept: the frames it was gone or faded in, and its furthest move
 * from where it first was against its anchor (the composer it sits on, which grows with what is typed).
 */
export interface Held {
  part: string;
  anchor: string;
  missing: number;
  driftPx: number;
}

/** What one recorded stretch adds up to. */
export interface MotionReport {
  frames: number;
  longFrames: number;
  maxGapMs: number;
  /** Main-thread tasks over 50 ms while recording, and their total time. */
  longTasks: number;
  longTaskMs: number;
  jumps: Jump[];
  pops: Pop[];
  flashes: Flash[];
  labels: string[];
  /** Frames in which some finite animation still ran (an entrance, an exit or a resize). */
  animatedFrames: number;
}

/** Below this a move is no move; at or above `JUMP_PX` in one still-to-still frame it is a jump. */
const STILL_PX = 0.5;
const JUMP_PX = 6;
/** At or above this a part that appears or leaves in one frame has popped. */
const POP_OPACITY = 0.9;
/** A label shown for less than this before another replaced it flashed. */
const FLASH_MS = 300;
/** A frame that took longer than this was dropped. */
const LONG_FRAME_MS = 34;
/** A part that hands over to another at the same place (±px) in the same frame is one surface. */
const SWAP_PX = 2;

const opacityOf = (element: Element): number => {
  let opacity = 1;
  for (let e: Element | null = element; e && e !== document.body; e = e.parentElement)
    opacity *= Number(getComputedStyle(e).opacity);
  return Math.round(opacity * 100) / 100;
};

function boxOf(element: Element, band: { top: number; bottom: number }): PartBox {
  const rect = element.getBoundingClientRect();
  return {
    top: Math.round(rect.top * 10) / 10,
    left: Math.round(rect.left * 10) / 10,
    height: Math.round(rect.height * 10) / 10,
    opacity: opacityOf(element),
    // Rows mounted ahead of the reader, above or below the viewport, are not seen move.
    seen: rect.bottom > band.top && rect.top < band.bottom,
  };
}

/** The part of the window a person can see: the conversation's viewport and what sits below it. */
function visibleBand(): { top: number; bottom: number } {
  const scroller = document.querySelector("[data-chat-scroll]")?.getBoundingClientRect();
  return { top: scroller?.top ?? 0, bottom: window.innerHeight };
}

/** Every followed part that can be seen now. Rows are named by their entry id. */
function snapshot(): Omit<MotionFrame, "at"> {
  const parts: Record<string, PartBox> = {};
  const band = visibleBand();
  for (const [name, selector] of Object.entries(LIVE_PARTS)) {
    const element = document.querySelector(selector);
    if (element) parts[name] = boxOf(element, band);
  }
  for (const row of document.querySelectorAll<HTMLElement>("[data-chat-entry]"))
    parts[`row:${row.dataset.chatEntry}`] = boxOf(row, band);
  const label = document.querySelector("[data-chat-status] [role=status]")?.textContent ?? null;
  // Endless motion (the status shimmer, busy dots) is ambient, and Reduce Motion's 0.01 ms
  // stand-ins end at once: only motion that takes time and ends counts.
  const running = document.getAnimations().filter((a) => {
    const timing = a.effect?.getComputedTiming();
    const takesTime = Number(timing?.activeDuration ?? 0) > 1;
    return a.playState === "running" && takesTime && timing?.iterations !== Number.POSITIVE_INFINITY;
  }).length;
  return { parts, label, running };
}

/**
 * Start recording; the returned function stops and hands back the frames. Each frame is read
 * after it was drawn (a task queued from its animation frame): inside requestAnimationFrame the
 * layout is the new one but the chat has not yet followed its newest line, a state never painted.
 */
export function recordFrames(): () => Recording {
  const frames: MotionFrame[] = [];
  const longTasks: number[] = [];
  const tasks = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) longTasks.push(Math.round(entry.duration));
  });
  tasks.observe({ type: "longtask" });
  let recording = true;
  const start = performance.now();
  const tick = (): void => {
    if (!recording) return;
    const at = Math.round(performance.now() - start);
    setTimeout(() => {
      if (recording) frames.push({ at, ...snapshot() });
    }, 0);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return () => {
    recording = false;
    tasks.disconnect();
    return { frames, longTasks };
  };
}

/** One part's move from one frame to the next, and whether it was in sight on both. */
interface Move {
  at: number;
  by: number;
  first: boolean;
  watched: boolean;
}

/** Moves of each part between frames, keyed by part. */
function movesOf(frames: MotionFrame[], part: string): Move[] {
  const moves: Move[] = [];
  for (let i = 1; i < frames.length; i++) {
    const before = frames[i - 1]?.parts[part];
    const after = frames[i]?.parts[part];
    if (!after) continue;
    // A part out of sight before or after cannot be seen jump; it moves down or across.
    const watched = Boolean(before?.seen && after.seen);
    const down = before && watched ? after.top - before.top : 0;
    const across = before && watched ? after.left - before.left : 0;
    moves.push({
      at: frames[i]?.at ?? 0,
      by: Math.abs(across) > Math.abs(down) ? across : down,
      first: !before,
      watched,
    });
  }
  return moves;
}

/** Whether a part was seen holding still across this move: one out of sight may have kept moving. */
const stillIn = (move: Move): boolean => move.watched && Math.abs(move.by) < STILL_PX;

/** Parts that moved their whole way in a single frame: seen still before, and seen still after. */
function jumpsOf(frames: MotionFrame[], parts: Set<string>): Jump[] {
  const jumps: Jump[] = [];
  for (const part of parts) {
    const moves = movesOf(frames, part);
    for (let i = 1; i < moves.length - 1; i++) {
      const move = moves[i];
      const previous = moves[i - 1];
      const next = moves[i + 1];
      if (!move || !previous || !next || move.first) continue;
      if (stillIn(previous) && stillIn(next) && Math.abs(move.by) >= JUMP_PX)
        jumps.push({ part, at: move.at, by: Math.round(move.by) });
    }
  }
  return jumps;
}

/** Does another part take this one's place in the same frame (a reply committing, a send saved)? */
function handedOver(box: PartBox, others: Record<string, PartBox>, gone: Record<string, PartBox>): boolean {
  return Object.entries(others).some(
    ([name, other]) => !(name in gone) && Math.abs(other.top - box.top) <= SWAP_PX && other.opacity >= box.opacity - 0.15,
  );
}

/** Parts that came or went at full opacity, unless another took their place at once. */
function popsOf(frames: MotionFrame[], watched: (part: string) => boolean): Pop[] {
  const pops: Pop[] = [];
  for (let i = 1; i < frames.length; i++) {
    const before = frames[i - 1]?.parts ?? {};
    const after = frames[i]?.parts ?? {};
    const at = frames[i]?.at ?? 0;
    for (const [part, box] of Object.entries(after))
      if (!(part in before) && box.seen && watched(part) && box.opacity >= POP_OPACITY) {
        const tookOver = Object.entries(before).some(
          ([name, old]) => !(name in after) && Math.abs(old.top - box.top) <= SWAP_PX && box.opacity <= old.opacity + 0.15,
        );
        if (!tookOver) pops.push({ part, at, opacity: box.opacity, way: "in" });
      }
    for (const [part, box] of Object.entries(before))
      if (!(part in after) && box.seen && watched(part) && box.opacity >= POP_OPACITY && !handedOver(box, after, before))
        pops.push({ part, at, opacity: box.opacity, way: "out" });
  }
  return pops;
}

/** Labels replaced by another label before they could be read; the line leaving is not a flash. */
function flashesOf(frames: MotionFrame[]): { flashes: Flash[]; labels: string[] } {
  const shown: { label: string; from: number; to: number }[] = [];
  for (const frame of frames) {
    const last = shown.at(-1);
    if (frame.label !== null && last?.label === frame.label && last.to >= 0) last.to = frame.at;
    else if (frame.label !== null) shown.push({ label: frame.label, from: frame.at, to: frame.at });
    else if (last) last.to = -Math.abs(last.to) - 1;
  }
  const flashes: Flash[] = [];
  for (let i = 0; i < shown.length - 1; i++) {
    const item = shown[i];
    if (!item || item.to < 0) continue;
    const next = shown[i + 1];
    const replaced = next && next.from - item.from < FLASH_MS;
    if (replaced) flashes.push({ label: item.label, shownMs: next.from - item.from });
  }
  return { flashes, labels: shown.map((item) => item.label) };
}

/** How `part` held over these frames: each frame it is absent or not fully opaque, and how far it moved against `anchor`. */
export function heldStill(frames: MotionFrame[], part: string, anchor: string): Held {
  const offset = (frame: MotionFrame | undefined): number | null => {
    const box = frame?.parts[part];
    const under = frame?.parts[anchor];
    return box && under ? box.top - under.top : null;
  };
  const first = offset(frames.find((frame) => offset(frame) !== null));
  let missing = 0;
  let drift = 0;
  for (const frame of frames) {
    const now = offset(frame);
    if (now === null || (frame.parts[part]?.opacity ?? 0) < 1) missing++;
    else if (first !== null) drift = Math.max(drift, Math.abs(now - first));
  }
  return { part, anchor, missing, driftPx: Math.round(drift * 10) / 10 };
}

/**
 * The stretch's jumps, pops and flashes. `history` names the rows that were already there, which
 * neither enter nor count as pops.
 */
export function motionReport({ frames, longTasks }: Recording, history: ReadonlySet<string>): MotionReport {
  const gaps = frames.slice(1).map((frame, i) => frame.at - (frames[i]?.at ?? frame.at));
  const parts = new Set(frames.flatMap((frame) => Object.keys(frame.parts)));
  const live = (part: string): boolean => part !== "composer" && !history.has(part);
  return {
    frames: frames.length,
    longFrames: gaps.filter((gap) => gap > LONG_FRAME_MS).length,
    maxGapMs: Math.max(0, ...gaps),
    longTasks: longTasks.length,
    longTaskMs: longTasks.reduce((sum, ms) => sum + ms, 0),
    jumps: jumpsOf(frames, parts),
    pops: popsOf(frames, live),
    ...flashesOf(frames),
    animatedFrames: frames.filter((frame) => frame.running > 0).length,
  };
}
