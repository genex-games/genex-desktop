/**
 * Scripted play — seed, then drive controls, then step.
 *
 * The critic cannot feel a game that only ticks the clock. A short WASD/look/jump script is how
 * two builds are compared on the same inputs.
 */
import { HostMethod } from "./host-methods.ts";
import { PageMethod } from "./page-contract.ts";
import { MAX_ACTION_MS, MAX_PLAY_SCRIPT } from "./config.ts";
import { isRecord } from "./json.ts";
import type { AnyRecord, CallParams, HarnessCtx } from "../types/harness.d.ts";
import type {
  HarnessHostMethod,
  MessageImage,
  PreviewInputAction,
  PreviewTouchAction,
  TouchPhase,
} from "../types/host-api.d.ts";
// A type only: native-contract.ts reaches back to this module through spec.ts and kinds.ts.
import { NativeRefusal } from "./native-refusal.ts";

/**
 * One control the harness drives: keys held or tapped, a look, a click, a drag, a pointer move,
 * a scroll, a wait, a camera switch, a finger's touch (a tap at `x`/`y` in world pixels, held for
 * `ms`, or a swipe to `toX`/`toY`; contract v2). A declared script is normalised to these (`kinds.ts`).
 */
export interface PlayAction {
  type: string;
  keys?: string[];
  ms?: number;
  dx?: number;
  dy?: number;
  x?: number;
  y?: number;
  fromX?: number;
  fromY?: number;
  toX?: number;
  toY?: number;
  id?: number;
  px?: boolean;
  button?: string;
  name?: string;
}

/** A finger's steps, spelled as the wire spells them (`TouchPhase`). */
const TouchStep = { Start: "start", Move: "move", End: "end" } as const satisfies Record<string, TouchPhase>;

/**
 * A play script plays a Rust · wgpu game's touch controls (`touch` taps, holds and swipes), skips a
 * touch only on the host's own `touch-not-taken`, and says how many it skipped; run-dispatch.ts
 * refuses a Rust night on a kept copy without this mark (`RUST_PARTS`).
 */
export const SERVES_RUST = true;

/** The finger a script's touch is when it names none: touch 0 is the one a desktop's Mouse1 emulates. */
const SCRIPT_TOUCH_ID = 1;
/** The largest finger id (contract v2: a uint32). */
const TOUCH_ID_MAX = 0xffff_ffff;
/** The moves a swipe glides through on its way from where it went down to where it lifts. */
const SWIPE_MOVES = 4;
/** How long a swipe lasts when it says nothing. */
const SWIPE_DEFAULT_MS = 240;

export const CONTROL_EXERCISE: PlayAction[] = [
  { type: "hold", keys: ["w"], ms: 1600 },
  { type: "look", dx: 56, dy: -8 },
  { type: "tap", keys: ["space"] },
  { type: "hold", keys: ["a"], ms: 800 },
  // The primary verb: a held Mouse1 reaches the game as `Mouse1` in ctx.keys through the
  // same path a human's click takes (studio.js records mouse buttons as keys). Without it
  // a judge once reported "shotsFired stay 0 across the whole run" as a defect of the game.
  { type: "hold", keys: ["Mouse1"], ms: 320 },
];

/** The frame a stepped tap, look, click or drag is given to land in. */
const INPUT_FRAME_MS = 48;

/** What every action of a script drives through: the preview (on its lease), the clock, and the pictures taken. */
interface Drive {
  call: HarnessCtx["call"];
  stepped: boolean;
  runId?: string;
  images: MessageImage[];
  /** Actions the preview refused because it cannot take them (a touch on a page). */
  refused: number;
}

/** A declared action, as a script carries it: any fields, read loosely. */
type ScriptAction = AnyRecord;

/** Under the stepped clock, advance the game by one input frame. */
async function stepFrame(drive: Drive): Promise<void> {
  if (drive.stepped) await drive.call(HostMethod.PreviewCall, { method: PageMethod.Step, arg: INPUT_FRAME_MS });
}

/** Let the game run for `ms`: stepped, or a wall-clock wait. */
async function runFor(drive: Drive, ms: number): Promise<void> {
  if (drive.stepped) await drive.call(HostMethod.PreviewCall, { method: PageMethod.Step, arg: ms });
  else await drive.call(HostMethod.PreviewInput, { actions: [{ type: "wait", ms }] });
}

/** One input action, then a frame for it under the stepped clock. */
async function inputThenFrame(drive: Drive, input: PreviewInputAction | PreviewTouchAction): Promise<void> {
  await drive.call(HostMethod.PreviewInput, { actions: [input] });
  await stepFrame(drive);
}

/** A frame budget on an input the page steps itself, under the stepped clock only. */
const frameOf = (drive: Drive): { stepMs?: number } => (drive.stepped ? { stepMs: INPUT_FRAME_MS } : {});

/** How each action type is driven; an unknown type does nothing. */
const ACTION_STEPS = new Map<string, (drive: Drive, action: ScriptAction) => Promise<void>>([
  [
    "hold",
    async (drive, action) => {
      const keys = asKeys(action.keys ?? action.key);
      await drive.call(HostMethod.PreviewInput, { actions: [{ type: "down", keys }] });
      await runFor(drive, clamp(action.ms ?? 400, 16, MAX_ACTION_MS));
      await drive.call(HostMethod.PreviewInput, { actions: [{ type: "up", keys }] });
    },
  ],
  [
    "tap",
    // `stepMs` straddles the press and the release with a frame: a game that reads a key on
    // the frame it was pressed used to see the down and the up inside one frame and nothing
    // between them, so a tap reached nothing.
    (drive, action) =>
      inputThenFrame(drive, { type: "tap", keys: asKeys(action.keys ?? action.key), ...frameOf(drive) }),
  ],
  [
    "look",
    (drive, action) => inputThenFrame(drive, { type: "look", dx: Number(action.dx) || 0, dy: Number(action.dy) || 0 }),
  ],
  [
    "click",
    (drive, action) =>
      inputThenFrame(drive, {
        type: "click",
        x: action.x,
        y: action.y,
        button: action.button,
        ...(action.px === true ? { px: true } : {}),
        ...frameOf(drive),
      }),
  ],
  [
    "drag",
    // A board is dragged, not walked, and so is a builder's camera: the drag glides through
    // intermediate moves, which is what an orbit control or a dragged piece listens for.
    (drive, action) =>
      inputThenFrame(drive, {
        type: "drag",
        fromX: action.fromX,
        fromY: action.fromY,
        x: action.x ?? action.toX,
        y: action.y ?? action.toY,
        ...(action.button ? { button: action.button } : {}),
        ...(action.px === true ? { px: true } : {}),
      }),
  ],
  [
    "move",
    async (drive, action) => {
      await drive.call(HostMethod.PreviewInput, { actions: [{ type: "move", x: action.x, y: action.y }] });
    },
  ],
  [
    "scroll",
    async (drive, action) => {
      await drive.call(HostMethod.PreviewInput, { actions: [{ type: "scroll", dx: action.dx, dy: action.dy }] });
    },
  ],
  [
    "step",
    async (drive, action) => {
      await drive.call(HostMethod.PreviewCall, {
        method: PageMethod.Step,
        arg: clamp(action.ms ?? 16, 16, MAX_ACTION_MS),
      });
    },
  ],
  // Under the stepped clock the game is paused: a wall-clock wait advances nothing while the
  // GAME line tells the judge the game waited. Wait means "let the game run", so it steps the
  // clock by the same milliseconds.
  ["wait", (drive, action) => runFor(drive, clamp(action.ms ?? 100, 0, MAX_ACTION_MS))],
  [
    "pause",
    async (drive) => {
      await drive.call(HostMethod.PreviewCall, { method: PageMethod.Pause });
    },
  ],
  [
    "start",
    async (drive) => {
      await drive.call(HostMethod.PreviewCall, { method: PageMethod.Start });
    },
  ],
  [
    "camera",
    async (drive, action) => {
      if (action.name)
        await drive.call(HostMethod.PreviewCall, { method: PageMethod.DebugCamera, arg: String(action.name) });
    },
  ],
  ["screenshot", screenshotStep],
  ["touch", touchStep],
]);

/** Where a script's finger goes down and lifts, and which finger it is. */
interface Finger {
  id: number;
  from: [number, number];
  to: [number, number] | null;
  ms: number | null;
}

/** A declared touch as a finger, or null when it cannot be placed (every coordinate a finite number, a lift whole). */
function fingerOf(action: ScriptAction): Finger | null {
  const { x, y, toX, toY } = action;
  if (!isFiniteNumber(x) || !isFiniteNumber(y)) return null;
  const lifts = toX !== undefined || toY !== undefined;
  if (lifts && !(isFiniteNumber(toX) && isFiniteNumber(toY))) return null;
  const named = action.id;
  const id = Number.isInteger(named) && named >= 0 && named <= TOUCH_ID_MAX ? named : SCRIPT_TOUCH_ID;
  return {
    id,
    from: [x, y],
    to: lifts ? [toX, toY] : null,
    ms: action.ms === undefined ? null : clamp(action.ms, INPUT_FRAME_MS, MAX_ACTION_MS),
  };
}

/** One step of a finger on the preview. */
const touchInput = (finger: Finger, phase: TouchPhase, [x, y]: [number, number]): PreviewTouchAction => ({
  type: "touch",
  phase,
  id: finger.id,
  x,
  y,
});

/**
 * A finger's tap, press or swipe: down, then a frame (a tap), its `ms` (a press) or a frame and
 * the moves a swipe glides through over its `ms`, then up where it ends and a frame for the lift. A
 * start the preview refuses as one it cannot take is skipped and counted; any other failure ends
 * the script, as any other action's would.
 */
async function touchStep(drive: Drive, action: ScriptAction): Promise<void> {
  const finger = fingerOf(action);
  if (!finger) return;
  if (!(await touchStarted(drive, finger))) return;
  if (finger.to) {
    await stepFrame(drive);
    await swipe(drive, finger, finger.to);
  } else if (finger.ms !== null) await runFor(drive, finger.ms);
  else await stepFrame(drive);
  await inputThenFrame(drive, touchInput(finger, TouchStep.End, finger.to ?? finger.from));
}

/**
 * The finger goes down; false when the preview cannot take a touch. Only the host's own answer
 * (`touch-not-taken`: a page other than a Rust web build, a protocol 1 game) is skipped, so one
 * control a page cannot feel does not cost the judges every other one; a game's own refusal ends
 * the script like any other failure.
 */
async function touchStarted(drive: Drive, finger: Finger): Promise<boolean> {
  try {
    await drive.call(HostMethod.PreviewInput, { actions: [touchInput(finger, TouchStep.Start, finger.from)] });
    return true;
  } catch (error) {
    if (refusalOf(error) !== NativeRefusal.TouchNotTaken) throw error;
    drive.refused += 1;
    return false;
  }
}

/** The moves of a swipe, evenly from where it went down to `to`, each given its share of the swipe's time. */
async function swipe(drive: Drive, finger: Finger, to: [number, number]): Promise<void> {
  const slice = (finger.ms ?? SWIPE_DEFAULT_MS) / SWIPE_MOVES;
  const [fromX, fromY] = finger.from;
  for (let move = 1; move <= SWIPE_MOVES; move++) {
    const t = move / SWIPE_MOVES;
    const at: [number, number] = [fromX + (to[0] - fromX) * t, fromY + (to[1] - fromY) * t];
    await drive.call(HostMethod.PreviewInput, { actions: [touchInput(finger, TouchStep.Move, at)] });
    await runFor(drive, slice);
  }
}

/** The typed refusal a host error carries, directly or in its RPC `data`. */
function refusalOf(error: unknown): unknown {
  if (!isRecord(error)) return null;
  const data = isRecord(error.data) ? error.data : {};
  return error.refusal ?? data.refusal ?? null;
}

const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** A screenshot, from a named camera when the action names one, kept as a picture for the judge. */
async function screenshotStep(drive: Drive, action: ScriptAction): Promise<void> {
  if (action.camera)
    await drive.call(HostMethod.PreviewCall, { method: PageMethod.DebugCamera, arg: String(action.camera) });
  const shot = await drive.call(HostMethod.PreviewScreenshot, {
    ...(drive.runId ? { runId: drive.runId } : {}),
    ...(action.label ? { label: String(action.label) } : {}),
  });
  const image = shotToImage(shot, action.label || action.camera || "play");
  if (image) drive.images.push(image);
}

/**
 * Drive a play script against the preview and hand back the screenshots it took, and how many of
 * its actions the preview refused as ones it cannot take (a touch on a page).
 */
export async function applyPlayScript(
  ctx: HarnessCtx,
  script: unknown,
  options: { clock?: string; handle?: string; runId?: string } = {},
): Promise<{ images: MessageImage[]; refused: number }> {
  const actions = Array.isArray(script) ? script.slice(0, MAX_PLAY_SCRIPT) : [];
  // Autopilot facets drive a pooled observation port; no handle = the live view, as ever.
  const h = options.handle ? { handle: options.handle } : {};
  const baseCall = ctx.call;
  const drive: Drive = {
    call: <M extends HarnessHostMethod>(method: M, payload = {} as CallParams<M>) =>
      baseCall(method, (method.startsWith("preview.") ? { ...payload, ...h } : payload) as CallParams<M>),
    stepped: options.clock !== "wall",
    runId: options.runId,
    images: [],
    refused: 0,
  };
  for (const action of actions) {
    const step = typeof action?.type === "string" ? ACTION_STEPS.get(action.type) : undefined;
    if (step) await step(drive, action);
  }
  return { images: drive.images, refused: drive.refused };
}

export function shotToImage(shot: { base64?: string } | null | undefined, label: unknown): MessageImage | null {
  if (!shot?.base64) return null;
  return { mimeType: "image/jpeg", data: shot.base64, label: String(label || "screenshot") };
}

function asKeys(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
  if (raw == null || raw === "") return [];
  return [String(raw)];
}

function clamp(value: unknown, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}
