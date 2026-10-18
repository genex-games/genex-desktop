/**
 * A native run's input as timed steps. The runtime takes one `input` message per call and applies
 * it at its next tick; it leaves the timed kinds (`hold`, `wait`, `drag`) to the host. This module
 * turns a checked action list into the messages to send and the pauses between them, the way the
 * web preview's driver plays the same list against a page.
 */
import type { NativeInputAction } from "../shared/native-contract.ts";
import { clampHoldMs, MAX_HOLD_KEY_MS } from "./preview-input.ts";

/** About one simulation tick (the runtime steps at 60 Hz): long enough for an edge to land on its own tick. */
export const NATIVE_INPUT_TICK_MS = 17;
/** Intermediate moves of a drag: a slider or an orbit control needs the glide, not the jump. */
export const NATIVE_DRAG_STEPS = 6;

/** One step of a plan: a message for the `input` op, or a pause before the next one. */
export type NativeInputStep = { send: NativeInputAction[] } | { waitMs: number };

type ActionOf<T extends NativeInputAction["type"]> = Extract<NativeInputAction, { type: T }>;

/** How long a `hold` keeps its keys down: as the web driver reads it (a computer-use hold may be long). */
function holdMs(ms: number | undefined): number {
  const asked = Math.min(MAX_HOLD_KEY_MS, Math.max(0, Math.round(Number(ms) || 0)));
  return asked || clampHoldMs(ms);
}

const pause = (ms: number): NativeInputStep => ({ waitMs: ms });

/** Whether a coordinate is a fraction of the frame (0..1), as the web preview reads one. */
const isFraction = (value: number): boolean => value >= 0 && value <= 1;

/**
 * Whether a position is in pixels: `px` says so, or a coordinate falls outside 0..1, as
 * `pointInView` reads it on the web. The runtime clamps an unmarked position to 0..1, so without
 * the mark a pixel click would land on the frame's edge.
 */
const inPixels = (px: boolean | undefined, ...coordinates: number[]): boolean =>
  px === true || !coordinates.every(isFraction);

const pixelMark = (pixels: boolean) => (pixels ? { px: true as const } : {});

function holdSteps(action: ActionOf<"hold">): NativeInputStep[] {
  return [
    { send: [{ type: "down", keys: action.keys }] },
    pause(holdMs(action.ms)),
    { send: [{ type: "up", keys: action.keys }] },
  ];
}

/** A point `i` of `steps` along the drag, in the drag's own units (fractions, or pixels with `px`). */
function along(action: ActionOf<"drag">, i: number): { x: number; y: number } {
  const t = i / NATIVE_DRAG_STEPS;
  return { x: action.fromX + (action.x - action.fromX) * t, y: action.fromY + (action.y - action.fromY) * t };
}

function dragSteps(action: ActionOf<"drag">): NativeInputStep[] {
  // One mark for the whole glide: a drag with either end in pixels is in pixels.
  const px = pixelMark(inPixels(action.px, action.fromX, action.fromY, action.x, action.y));
  const button = action.button === undefined ? {} : { button: action.button };
  const steps: NativeInputStep[] = [
    { send: [{ type: "move", x: action.fromX, y: action.fromY, ...px }] },
    pause(NATIVE_INPUT_TICK_MS),
    { send: [{ type: "mousedown", ...button }] },
  ];
  for (let i = 1; i <= NATIVE_DRAG_STEPS; i++) {
    steps.push(pause(NATIVE_INPUT_TICK_MS), { send: [{ type: "move", ...along(action, i), ...px }] });
  }
  steps.push(pause(NATIVE_INPUT_TICK_MS), { send: [{ type: "mouseup", ...button }] });
  return steps;
}

/** A positioned click: the pointer moves on one tick (a hover a widget sees) and the button taps on the next. */
function clickSteps(action: ActionOf<"click">): NativeInputStep[] | null {
  if (action.x === undefined || action.y === undefined) return null;
  const { x, y, px, ...press } = action;
  return [
    { send: [{ type: "move", x, y, ...pixelMark(inPixels(px, x, y)) }] },
    pause(NATIVE_INPUT_TICK_MS),
    { send: [{ ...press, type: "click" }] },
  ];
}

/** A move the runtime takes as is, marked `px` when its position is in pixels. */
function asSent(action: NativeInputAction): NativeInputAction {
  if (action.type !== "move" || !inPixels(action.px, action.x, action.y)) return action;
  return { ...action, px: true };
}

/** The steps a timed or positioned action expands into, or null for one the runtime takes as is. */
function expand(action: NativeInputAction): NativeInputStep[] | null {
  switch (action.type) {
    case "hold":
      return holdSteps(action);
    case "wait":
      return [pause(clampHoldMs(action.ms))];
    case "drag":
      return dragSteps(action);
    case "click":
      return clickSteps(action);
    default:
      return null;
  }
}

/**
 * The messages and pauses that play `actions` on a native run. Actions the runtime takes as is
 * travel together in one message until a timed one needs its own steps.
 */
export function planNativeInput(actions: readonly NativeInputAction[]): NativeInputStep[] {
  const steps: NativeInputStep[] = [];
  let batch: NativeInputAction[] = [];
  const flush = () => {
    if (batch.length > 0) steps.push({ send: batch });
    batch = [];
  };
  for (const action of actions) {
    const expanded = expand(action);
    if (!expanded) {
      batch.push(asSent(action));
      continue;
    }
    flush();
    steps.push(...expanded);
  }
  flush();
  return steps;
}
