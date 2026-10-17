/**
 * Live's embedded Mac build, pure: the size Live's canvas asks the game for and backs itself with,
 * where a pointer lands on the game, which frames the canvas draws (the shown run's, one at a
 * time), what captured input becomes on its way to `nativeInput` (one move and one wheel sum per
 * frame, committed text clipped, gamepads on change only, every held key let go on release), and
 * what the canvas says about the run. `NativeLiveCanvas.tsx` wires these to the DOM; the
 * conformance tests hold them without one.
 */
import {
  BootStage,
  NATIVE_FRAME_SIDE_MAX,
  NATIVE_GAMEPAD_AXES_MAX,
  NATIVE_GAMEPAD_BUTTONS_MAX,
  NATIVE_GAMEPADS_MAX,
  NATIVE_INPUT_ACTIONS_MAX,
  NATIVE_NO_RUN_ID,
  NATIVE_TEXT_MAX_UNITS,
  type NativeEmbedSize,
  type NativeFrameMeta,
  type NativeGamepadAction,
  type NativeInputAction,
  NativeCanvasPhase,
  NativeInputKind,
  NativeRefusal,
  NativeRunState,
  type NativeRunStatus,
  type NativeTextAction,
  deviceSideFits,
  ringSizeFor,
} from "../../../shared/native-contract.ts";
import { NATIVE_WORDS } from "../../words.ts";

/** The device-pixel ratio Live sends at most and at least (`parseNativeEmbedSize`'s range). */
const DPR_MIN = 1;
const DPR_MAX = 4;

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

/**
 * The size Live's canvas asks the game for: the slot's whole CSS pixels and the screen's ratio,
 * with the slot's exact `device` pixels (`devicePixelContentBoxSize`) when the browser reported
 * them and they still cover the CSS size (a report from before a resize is left out); null while
 * the slot has no area.
 */
export function embedSizeOf(
  rect: { width: number; height: number },
  dpr: number,
  device?: { width: number; height: number },
): NativeEmbedSize | null {
  const width = Math.round(rect.width);
  const height = Math.round(rect.height);
  if (!(width >= 1 && height >= 1)) return null;
  const size = {
    width: Math.min(width, NATIVE_FRAME_SIDE_MAX),
    height: Math.min(height, NATIVE_FRAME_SIDE_MAX),
    dpr: Number.isFinite(dpr) ? clamp(dpr, DPR_MIN, DPR_MAX) : DPR_MIN,
  };
  if (!device || !coversSlot(device, size)) return size;
  return { ...size, device: { width: device.width, height: device.height } };
}

/** Whether `device` pixels are a whole-pixel box that covers `size`'s CSS sides at its ratio. */
function coversSlot(device: { width: number; height: number }, size: NativeEmbedSize): boolean {
  const whole =
    Number.isInteger(device.width) && Number.isInteger(device.height) && device.width >= 1 && device.height >= 1;
  return (
    whole && deviceSideFits(device.width, size.width, size.dpr) && deviceSideFits(device.height, size.height, size.dpr)
  );
}

/** The canvas's backing store before the first frame says otherwise: the ring the game makes for `size`. */
export const canvasBacking = (size: NativeEmbedSize): { width: number; height: number } => ringSizeFor(size);

/**
 * Where a pointer at `client` lands on Live's surface: fractions of it from the top-left, held to
 * its edges. The ring fills the slot at the slot's aspect, so the place is the same whatever the
 * ring-to-CSS scale.
 */
export function pointerOnSurface(
  client: { x: number; y: number },
  rect: { left: number; top: number; width: number; height: number },
): { x: number; y: number } {
  if (rect.width <= 0 || rect.height <= 0) return { x: 0.5, y: 0.5 };
  return { x: clamp((client.x - rect.left) / rect.width, 0, 1), y: clamp((client.y - rect.top) / rect.height, 0, 1) };
}

/**
 * Where a pointer at `client` lands in the game's ring, in ring pixels (`px: true`): the game
 * draws its world letterboxed into the ring and maps these through that letterbox, so a place on
 * a bar is held to the world's edge. Fractions of the slot would be read as fractions of the world.
 */
export function pointerOnRing(
  client: { x: number; y: number },
  rect: { left: number; top: number; width: number; height: number },
  ring: { width: number; height: number },
): { x: number; y: number; px: true } {
  const at = pointerOnSurface(client, rect);
  return { x: at.x * ring.width, y: at.y * ring.height, px: true };
}

// ── frames ──────────────────────────────────────────────────────────────────────────────────

/** What the canvas did with one frame. */
export const FrameVerdict = {
  Draw: "draw",
  /** Another game's, another run's, or no run is shown: never this canvas's. */
  Foreign: "foreign",
  /** A frame arrived while one was being drawn: dropped, so one is in flight at most. */
  Busy: "busy",
} as const;
export type FrameVerdict = (typeof FrameVerdict)[keyof typeof FrameVerdict];

/** The run Live's canvas shows. */
export interface ShownRun {
  project: string;
  runId: string;
}

/** Whether `meta` is a frame of the shown run (a run with no id yet shows nothing). */
const ofShownRun = (meta: NativeFrameMeta, shown: ShownRun | null): boolean =>
  shown !== null && shown.runId !== NATIVE_NO_RUN_ID && meta.project === shown.project && meta.runId === shown.runId;

/** The canvas's frame gate: draws the shown run's frames, one at a time, and counts what it dropped. */
export interface FrameGate {
  /** Paint `meta`'s frame now, synchronously, unless it is not the shown run's or one is being drawn. */
  draw(meta: NativeFrameMeta, shown: ShownRun | null, paint: () => void): FrameVerdict;
  counts(): { drawn: number; dropped: number };
}

/** A gate with nothing drawn yet. A paint that throws frees the gate before the error goes on. */
export function createFrameGate(): FrameGate {
  let busy = false;
  let drawn = 0;
  let dropped = 0;
  return {
    draw(meta, shown, paint) {
      const verdict = busy ? FrameVerdict.Busy : FrameVerdict.Draw;
      const outcome = ofShownRun(meta, shown) ? verdict : FrameVerdict.Foreign;
      if (outcome !== FrameVerdict.Draw) {
        dropped += 1;
        return outcome;
      }
      busy = true;
      try {
        drawn += 1;
        paint();
      } finally {
        busy = false;
      }
      return outcome;
    },
    counts: () => ({ drawn, dropped }),
  };
}

// ── input ───────────────────────────────────────────────────────────────────────────────────

/** A mouse button as the game names it. */
export type MouseButton = "left" | "middle" | "right";
const BUTTONS: readonly MouseButton[] = ["left", "middle", "right"];

/** `MouseEvent.button` as the game names it; a fourth button or more is none of its. */
export const mouseButtonOf = (button: number): MouseButton | null => BUTTONS[button] ?? null;

/** Keys that hand the keyboard back to Genex instead of the game: Esc, and ⌘ so app shortcuts keep working. */
const RELEASE_KEYS: ReadonlySet<string> = new Set(["Escape", "Meta"]);

/** Whether `key` (`KeyboardEvent.key`) releases Live's capture. */
export const releasesCapture = (key: string): boolean => RELEASE_KEYS.has(key);

/** Whether `action` is a `type` kind of preview action. */
function isKind<T extends NativeInputAction["type"]>(
  action: NativeInputAction | undefined,
  type: T,
): action is Extract<NativeInputAction, { type: T }> {
  return action?.type === type;
}

/**
 * `queue` with `action` added for the next flush: a move right after a move replaces it (the last
 * place wins), wheel turns right after each other are summed, and a full queue takes nothing more.
 */
export function queueAction(queue: readonly NativeInputAction[], action: NativeInputAction): NativeInputAction[] {
  const last = queue.at(-1);
  const rest = queue.slice(0, -1);
  if (isKind(last, "move") && isKind(action, "move")) return [...rest, action];
  if (isKind(last, "scroll") && isKind(action, "scroll"))
    return [...rest, { type: "scroll", dx: (last.dx ?? 0) + (action.dx ?? 0), dy: (last.dy ?? 0) + (action.dy ?? 0) }];
  if (queue.length >= NATIVE_INPUT_ACTIONS_MAX) return [...queue];
  return [...queue, action];
}

/** `text` cut to the most UTF-16 units one text action carries, never through the middle of a character. */
export function clipText(text: string): string {
  if (text.length <= NATIVE_TEXT_MAX_UNITS) return text;
  const cut = text.slice(0, NATIVE_TEXT_MAX_UNITS);
  const lastUnit = cut.charCodeAt(cut.length - 1);
  const highSurrogate = lastUnit >= 0xd800 && lastUnit <= 0xdbff;
  return highSurrogate ? cut.slice(0, -1) : cut;
}

/** Committed text as an action, or null when there is none. */
export function textAction(text: string): NativeTextAction | null {
  const clipped = clipText(text);
  return clipped ? { type: NativeInputKind.Text, text: clipped } : null;
}

/** What the game is holding down because Live told it so: keys by DOM code, mouse buttons, pads. */
export interface HeldInput {
  keys: readonly string[];
  buttons: readonly MouseButton[];
  pads: ReadonlyMap<number, NativeGamepadAction>;
}

/** Nothing held. */
export const NO_HELD: HeldInput = Object.freeze({ keys: [], buttons: [], pads: new Map() });

const without = <T>(list: readonly T[], gone: readonly T[]): T[] => list.filter((item) => !gone.includes(item));
const withAll = <T>(list: readonly T[], added: readonly T[]): T[] => [...without(list, added), ...added];

/** What is held after `action` reaches the game. */
export function heldAfter(held: HeldInput, action: NativeInputAction): HeldInput {
  switch (action.type) {
    case "down":
      return { ...held, keys: withAll(held.keys, action.keys) };
    case "up":
      return { ...held, keys: without(held.keys, action.keys) };
    case "mousedown":
      return { ...held, buttons: withAll(held.buttons, [action.button ?? "left"]) };
    case "mouseup":
      return { ...held, buttons: without(held.buttons, [action.button ?? "left"]) };
    case NativeInputKind.Gamepad:
      return { ...held, pads: new Map(held.pads).set(action.index, action) };
    default:
      return held;
  }
}

/** A pad at rest, with as many buttons and axes as `pad` had. */
const neutralPad = (pad: NativeGamepadAction): NativeGamepadAction => ({
  type: NativeInputKind.Gamepad,
  index: pad.index,
  buttons: pad.buttons.map(() => 0),
  axes: pad.axes.map(() => 0),
});

/** Whether a pad is at rest already. */
const atRest = (pad: NativeGamepadAction): boolean => [...pad.buttons, ...pad.axes].every((value) => value === 0);

/** What lets go of everything `held`, when Live releases the keyboard: nothing may stay pressed in the game. */
export function releaseActions(held: HeldInput): NativeInputAction[] {
  const keys: NativeInputAction[] = held.keys.length > 0 ? [{ type: "up", keys: [...held.keys] }] : [];
  const buttons: NativeInputAction[] = held.buttons.map((button) => ({ type: "mouseup", button }));
  const pads = [...held.pads.values()].filter((pad) => !atRest(pad)).map(neutralPad);
  return [...keys, ...buttons, ...pads];
}

/** A pad as the Gamepad API reports it. */
export interface GamepadLike {
  index: number;
  buttons: ArrayLike<{ value: number }>;
  axes: ArrayLike<number>;
}

/** `pad` in the standard mapping's bounds (4 pads, 17 buttons in 0…1, 4 axes in −1…1), or null past the fourth pad. */
export function padAction(pad: GamepadLike): NativeGamepadAction | null {
  if (!Number.isInteger(pad.index) || pad.index < 0 || pad.index >= NATIVE_GAMEPADS_MAX) return null;
  const unit = (value: number, low: number): number => (Number.isFinite(value) ? clamp(value, low, 1) : 0);
  return {
    type: NativeInputKind.Gamepad,
    index: pad.index,
    buttons: Array.from(pad.buttons)
      .slice(0, NATIVE_GAMEPAD_BUTTONS_MAX)
      .map((button) => unit(button.value, 0)),
    axes: Array.from(pad.axes)
      .slice(0, NATIVE_GAMEPAD_AXES_MAX)
      .map((axis) => unit(axis, -1)),
  };
}

/**
 * The pads to send after one poll: each pad whose state differs from the last one sent, and a pad
 * at rest, once, for each pad that is gone. `last` is what was sent, by pad index.
 */
export function padChanges(
  last: ReadonlyMap<number, NativeGamepadAction>,
  pads: readonly NativeGamepadAction[],
): { actions: NativeGamepadAction[]; last: Map<number, NativeGamepadAction> } {
  const next = new Map<number, NativeGamepadAction>();
  const actions: NativeGamepadAction[] = [];
  for (const pad of pads) {
    next.set(pad.index, pad);
    if (JSON.stringify(last.get(pad.index)) !== JSON.stringify(pad)) actions.push(pad);
  }
  for (const [index, pad] of last)
    if (!next.has(index) && !atRest(pad)) {
      const rest = neutralPad(pad);
      actions.push(rest);
      next.set(index, rest);
    }
  return { actions, last: next };
}

// ── resize ──────────────────────────────────────────────────────────────────────────────────

/** The size to send the game after a frame's observations, or null when it already has `measured` (or nothing was measured). */
export function resizeDue(sent: NativeEmbedSize | null, measured: NativeEmbedSize | null): NativeEmbedSize | null {
  if (!measured) return null;
  const sameDevice = sent?.device?.width === measured.device?.width && sent?.device?.height === measured.device?.height;
  const same =
    sent?.width === measured.width && sent.height === measured.height && sent.dpr === measured.dpr && sameDevice;
  return same ? null : measured;
}

// ── what the canvas says ────────────────────────────────────────────────────────────────────

/** Where Live's canvas stands. Wire values of `data-stage-native-canvas` (shared with the dev control). */
export const CanvasPhase = NativeCanvasPhase;
export type CanvasPhase = NativeCanvasPhase;

/** The canvas card's buttons. Wire values of `data-stage-native-canvas-action` (the window card owns `data-stage-native-action`). */
export const CanvasAction = {
  TryAgain: "try-again",
  Restart: "restart",
  PopOut: "pop-out",
} as const;
export type CanvasAction = (typeof CanvasAction)[keyof typeof CanvasAction];

const ENDED: ReadonlySet<NativeRunState> = new Set([
  NativeRunState.Stopped,
  NativeRunState.Crashed,
  NativeRunState.Killed,
]);
const PLAYING: ReadonlySet<NativeRunState> = new Set([NativeRunState.Ready, NativeRunState.Paused]);

/** Where the canvas stands for the embedded run `status` (null: not answered yet). */
export function canvasPhase(status: NativeRunStatus | null, failed: boolean, canDraw: boolean): CanvasPhase {
  if (!canDraw) return CanvasPhase.CantDraw;
  if (failed) return CanvasPhase.Failed;
  if (!status) return CanvasPhase.Starting;
  if (status.state === NativeRunState.Refused) return CanvasPhase.Refused;
  if (ENDED.has(status.state)) return CanvasPhase.Ended;
  return PLAYING.has(status.state) ? CanvasPhase.Playing : CanvasPhase.Starting;
}

/** Refusals no new embedded run gets past: the canvas offers Pop out alone. */
const FINAL_REFUSALS: ReadonlySet<NativeRefusal> = new Set([
  NativeRefusal.GamePredatesEmbedding,
  NativeRefusal.EmbedUnsupported,
  NativeRefusal.ElectronUntested,
]);

/** The canvas's own buttons, before Pop out: Try again or Restart where a new run can help. */
function retryActions(phase: CanvasPhase, status: NativeRunStatus | null): CanvasAction[] {
  if (phase === CanvasPhase.Ended) return [CanvasAction.Restart];
  if (phase === CanvasPhase.Failed) return [CanvasAction.TryAgain];
  if (phase !== CanvasPhase.Refused) return [];
  const final = status?.refusal ? FINAL_REFUSALS.has(status.refusal) : false;
  return final ? [] : [CanvasAction.TryAgain];
}

/**
 * The canvas's buttons: Pop out wherever Live cannot show the game, with Try again or Restart
 * where a new run can help. A game with no window of its own (`popOut: false`, a Rust game) never
 * offers Pop out.
 */
export function canvasActions(
  phase: CanvasPhase,
  status: NativeRunStatus | null,
  options: { popOut: boolean } = { popOut: true },
): CanvasAction[] {
  const retry = retryActions(phase, status);
  const stuck = phase !== CanvasPhase.Starting && phase !== CanvasPhase.Playing;
  return options.popOut && stuck ? [...retry, CanvasAction.PopOut] : retry;
}

/** Refusals the embed words say better than the window card's. */
const EMBED_REFUSAL_WORDS: Partial<Record<NativeRefusal, string>> = {
  [NativeRefusal.EmbedUnsupported]: NATIVE_WORDS.embed.unsupported,
  [NativeRefusal.ElectronUntested]: NATIVE_WORDS.embed.electronUntested,
  [NativeRefusal.GamePredatesEmbedding]: NATIVE_WORDS.embed.predates,
  [NativeRefusal.FramesStalled]: NATIVE_WORDS.embed.stalled,
  // A game with the ring that refused its surface (`surface-failed`, `no-frames-service`, …).
  [NativeRefusal.Unsupported]: NATIVE_WORDS.embed.failed,
};

/** Why Live cannot show the Mac build, for `refusal`: the embed words where they say it better. */
export const embedRefusalWords = (refusal: NativeRefusal): string =>
  EMBED_REFUSAL_WORDS[refusal] ?? NATIVE_WORDS.refusal[refusal];

/** Why the run was refused, in the canvas's words; a failed Mac build in the Mac's own (never Live's last-good sentence). */
function refusalWords(status: NativeRunStatus | null): { title: string; detail: string | null } {
  const refusal = status?.refusal ?? null;
  if (refusal === NativeRefusal.BuildFailed)
    return { title: NATIVE_WORDS.refusal[NativeRefusal.BuildFailed], detail: NATIVE_WORDS.buildFailed };
  const detail = refusal ? embedRefusalWords(refusal) : null;
  return { title: NATIVE_WORDS.state[NativeRunState.Refused], detail };
}

/** What a kill says: why its frames failed when it was killed for that (`NativeRuns.kill`), else that it did not quit. */
const killedWords = (status: NativeRunStatus | null): string =>
  status?.refusal ? embedRefusalWords(status.refusal) : NATIVE_WORDS.killed;

/** How an ended run ended: a crash's code or signal, a kill and why, or stopped. */
function endedWords(status: NativeRunStatus | null): { title: string; detail: string | null } {
  const state = status?.state ?? NativeRunState.Stopped;
  if (state === NativeRunState.Crashed)
    return {
      title: NATIVE_WORDS.state[state],
      detail: NATIVE_WORDS.crashed(status?.exit?.code ?? null, status?.exit?.signal ?? null),
    };
  return { title: NATIVE_WORDS.state[state], detail: state === NativeRunState.Killed ? killedWords(status) : null };
}

/** Where each counted stage's share of the bar starts and ends (the web shell's spans, from the device on). */
const BOOT_SPAN: Partial<Record<BootStage, readonly [number, number]>> = {
  [BootStage.Assets]: [0.05, 0.15],
  [BootStage.Device]: [0.15, 0.2],
  [BootStage.Pipelines]: [0.2, 0.95],
  [BootStage.Frame]: [0.95, 1],
};

/**
 * Where a starting game's boot is, as the card shows it: the stage in words (with its count) and
 * the bar's fill; null when the game named no stage (an older game, or not started yet).
 */
export function startingProgress(status: NativeRunStatus | null): { words: string; fill: number } | null {
  const progress = status?.progress;
  if (!progress) return null;
  const { stage, done, total } = progress;
  const counted = done !== null && total !== null && total > 0;
  const words = counted ? NATIVE_WORDS.boot.counted(stage, done, total) : NATIVE_WORDS.boot.stage[stage];
  const [from, to] = BOOT_SPAN[stage] ?? [0, 0];
  return { words, fill: from + (to - from) * (counted ? done / total : 0) };
}

/** What the canvas says over the game for `phase`: nothing extra while it plays. */
export function canvasWords(
  phase: CanvasPhase,
  status: NativeRunStatus | null,
): { title: string; detail: string | null } {
  switch (phase) {
    case CanvasPhase.Refused:
      return refusalWords(status);
    case CanvasPhase.Ended:
      return endedWords(status);
    case CanvasPhase.Failed:
      return { title: NATIVE_WORDS.state[NativeRunState.Refused], detail: NATIVE_WORDS.embed.failed };
    case CanvasPhase.CantDraw:
      return { title: NATIVE_WORDS.title, detail: NATIVE_WORDS.embed.cantDraw };
    case CanvasPhase.Playing:
      return { title: NATIVE_WORDS.title, detail: null };
    default:
      return {
        title: NATIVE_WORDS.state[status?.state ?? NativeRunState.Starting],
        detail: startingProgress(status)?.words ?? null,
      };
  }
}
