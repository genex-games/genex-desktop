/**
 * Preview input, applied: how one {@link PreviewInputAction} becomes Chromium input events plus
 * the page-side copies (synthetic DOM events), so a paused `step()`
 * playthrough still sees WASD. `substrate/preview-input.ts` owns the mapping and the caps; this
 * module owns the order of events a player's hands would produce. {@link GamePreview} supplies
 * the target: its view's `sendInputEvent`, its page dispatch, its clock and its pointer.
 */
import {
  clampHoldMs,
  clampLook,
  clampRepeat,
  MAX_HOLD_KEY_MS,
  mouseButton,
  type NormalizedKey,
  normalizeKeys,
  type PreviewInputAction,
  parseCombo,
  pointInView,
  studioAliases,
  typedText,
} from "../substrate/preview-input.ts";
import { setTimeout as delay } from "node:timers/promises";

/** How long a tap or a chord stays down when no simulated frame is stepped between. */
const KEY_STROKE_MS = 16;
/** The gap between two strokes of a repeated chord. */
const REPEAT_GAP_MS = 24;
/** The gap between keydown and keyup of one typed character. */
const TYPED_CHAR_MS = 8;
/** Intermediate moves of a drag: a slider or an orbit control needs the glide, not the jump. */
const DRAG_STEPS = 6;
/** The pause between two moves of a drag: about one frame. */
const DRAG_STEP_MS = 16;
/** Most clicks one click action makes (3 = triple click). */
const MAX_CLICKS = 3;
/** A wheel delta in pixels; a computer-use scroll of 50 notches is 6000 px, a real gesture. */
const MAX_SCROLL_PX = 6_000;
/** The modifiers Chromium carries on a mouse event while they are held. */
const HELD_MODIFIERS = new Set(["shift", "control", "alt", "meta"]);

/** What the page receives for one beat of input: the studio's own injection and DOM copies. */
export interface PageDispatch {
  studio?: { down?: string[]; up?: string[]; look?: { dx: number; dy: number } };
  dom?: Array<Record<string, unknown>>;
  /** Native delivery is proven for this page: the page drops the copies it already heard. */
  native?: boolean;
}

/** A Chromium input event the driver sends through the view. */
export type NativeInputEvent = Electron.MouseInputEvent | Electron.MouseWheelInputEvent | Electron.KeyboardInputEvent;

interface Point {
  x: number;
  y: number;
}

/** The preview the driver acts on. `send` never throws: a view that will not take it drops it. */
export interface InputTarget {
  width: number;
  height: number;
  send(event: NativeInputEvent): void;
  dispatch(payload: PageDispatch): Promise<void>;
  /** Advance the page's own loop by hand — the frozen-clock stand-in for a real sleep. */
  stepClock(ms: number): Promise<void>;
  pointer(): Point;
  movePointer(point: Point): void;
}

type ActionOf<T extends PreviewInputAction["type"]> = Extract<PreviewInputAction, { type: T }>;
type InputHandlers = {
  [T in PreviewInputAction["type"]]: (target: InputTarget, action: ActionOf<T>) => Promise<void>;
};

const INPUT_HANDLERS: InputHandlers = {
  wait: (_target, action) => sleep(clampHoldMs(action.ms)),
  look: applyLook,
  move: applyMove,
  click: applyClick,
  drag: applyDrag,
  mousedown: (target, action) => applyButton(target, action.button, "down"),
  mouseup: (target, action) => applyButton(target, action.button, "up"),
  type: applyType,
  press: applyPress,
  scroll: applyScroll,
  down: (target, action) => keysDown(target, normalizeKeys(action.keys)),
  up: (target, action) => keysUp(target, normalizeKeys(action.keys)),
  tap: applyTap,
  hold: applyHold,
};

/** Apply one input action to the preview, the way a player's hands would. */
export async function applyInputAction(target: InputTarget, action: PreviewInputAction): Promise<void> {
  const handler = INPUT_HANDLERS[action.type] as
    | ((target: InputTarget, action: PreviewInputAction) => Promise<void>)
    | undefined;
  if (!handler) return;
  await handler(target, action);
}

async function applyLook(target: InputTarget, action: ActionOf<"look">): Promise<void> {
  const dx = clampLook(action.dx);
  const dy = clampLook(action.dy);
  const pointer = target.pointer();
  const next = {
    x: Math.max(0, Math.min(target.width - 1, pointer.x + dx)),
    y: Math.max(0, Math.min(target.height - 1, pointer.y + dy)),
  };
  target.send({ type: "mouseMove", x: next.x, y: next.y, movementX: dx, movementY: dy });
  await target.dispatch({
    studio: { look: { dx, dy } },
    dom: [{ kind: "mouse", type: "mousemove", x: next.x, y: next.y, movementX: dx, movementY: dy }],
  });
  target.movePointer(next);
}

async function applyMove(target: InputTarget, action: ActionOf<"move">): Promise<void> {
  const point = pointInView(action.x, action.y, target.width, target.height, { exact: action.px === true });
  const pointer = target.pointer();
  const movementX = point.x - pointer.x;
  const movementY = point.y - pointer.y;
  target.send({ type: "mouseMove", x: point.x, y: point.y, movementX, movementY });
  await target.dispatch({
    studio: { look: { dx: movementX, dy: movementY } },
    dom: [{ kind: "mouse", type: "mousemove", x: point.x, y: point.y, movementX, movementY }],
  });
  target.movePointer(point);
}

async function applyClick(target: InputTarget, action: ActionOf<"click">): Promise<void> {
  const point = pointInView(action.x, action.y, target.width, target.height, { exact: action.px === true });
  const clicks = Math.max(1, Math.min(MAX_CLICKS, Math.round(Number(action.clicks) || 1)));
  const modifiers = normalizeKeys(action.modifiers ?? []);
  const held = heldModifiers(modifiers);
  await pressModifiers(target, modifiers);
  target.send({ type: "mouseMove", x: point.x, y: point.y, movementX: 0, movementY: 0, ...held });
  const click: ClickStroke = {
    point,
    button: mouseButton(action.button),
    held,
    stepMs: stepBetweenPressAndRelease(action),
    dom: [{ kind: "mouse", type: "mousemove", x: point.x, y: point.y, movementX: 0, movementY: 0 }],
  };
  for (let n = 1; n <= clicks; n++) await clickOnce(target, click, n);
  await target.dispatch({ studio: {}, dom: click.dom });
  await releaseModifiers(target, modifiers);
  target.movePointer(point);
}

/** One click of a (multi-)click: its native press and release, and its DOM copies queued on `dom`. */
interface ClickStroke {
  point: Point;
  button: ReturnType<typeof mouseButton>;
  held: { modifiers?: Electron.InputEvent["modifiers"] };
  stepMs: number;
  dom: Array<Record<string, unknown>>;
}

async function clickOnce(target: InputTarget, click: ClickStroke, n: number): Promise<void> {
  const { point, button, held, dom } = click;
  const mouse = { x: point.x, y: point.y, button: button.name, clickCount: n, ...held };
  const page = { kind: "mouse", x: point.x, y: point.y, button: button.index, detail: n };
  target.send({ type: "mouseDown", ...mouse });
  dom.push({ ...page, type: "mousedown", buttons: buttonsMask(button.index) });
  if (click.stepMs) {
    // A frozen clock makes press and release the same instant, and a game that samples
    // input once a frame never sees the button down. Straddle a simulated frame instead.
    await target.dispatch({ studio: {}, dom: dom.splice(0, dom.length) });
    await target.stepClock(click.stepMs);
  }
  target.send({ type: "mouseUp", ...mouse });
  dom.push({ ...page, type: "mouseup", buttons: 0 }, { ...page, type: "click", buttons: 0 });
  if (n === 2) dom.push({ ...page, type: "dblclick", buttons: 0 });
}

async function applyDrag(target: InputTarget, action: ActionOf<"drag">): Promise<void> {
  const exact = { exact: action.px === true };
  const from = pointInView(action.fromX, action.fromY, target.width, target.height, exact);
  const to = pointInView(action.x, action.y, target.width, target.height, exact);
  const button = mouseButton(action.button);
  const buttons = buttonsMask(button.index);
  const pointer = target.pointer();
  target.send({
    type: "mouseMove",
    x: from.x,
    y: from.y,
    movementX: from.x - pointer.x,
    movementY: from.y - pointer.y,
  });
  target.send({ type: "mouseDown", x: from.x, y: from.y, button: button.name, clickCount: 1 });
  await target.dispatch({
    studio: {},
    dom: [
      { kind: "mouse", type: "mousemove", x: from.x, y: from.y, movementX: 0, movementY: 0 },
      { kind: "mouse", type: "mousedown", x: from.x, y: from.y, button: button.index, buttons },
    ],
  });
  await glide(target, from, to, button);
  target.send({ type: "mouseUp", x: to.x, y: to.y, button: button.name, clickCount: 1 });
  await target.dispatch({
    studio: {},
    dom: [{ kind: "mouse", type: "mouseup", x: to.x, y: to.y, button: button.index, buttons: 0 }],
  });
  target.movePointer(to);
}

/** The held-button moves of a drag, from `from` to `to` in {@link DRAG_STEPS} steps. */
async function glide(target: InputTarget, from: Point, to: Point, button: ReturnType<typeof mouseButton>) {
  const buttons = buttonsMask(button.index);
  const leftHeld = button.index === 0 ? { button: "left" as const } : {};
  let last = from;
  for (let i = 1; i <= DRAG_STEPS; i++) {
    const point = {
      x: Math.round(from.x + ((to.x - from.x) * i) / DRAG_STEPS),
      y: Math.round(from.y + ((to.y - from.y) * i) / DRAG_STEPS),
    };
    const movementX = point.x - last.x;
    const movementY = point.y - last.y;
    target.send({ type: "mouseMove", x: point.x, y: point.y, movementX, movementY, ...leftHeld });
    await target.dispatch({
      studio: { look: { dx: movementX, dy: movementY } },
      dom: [{ kind: "mouse", type: "mousemove", x: point.x, y: point.y, movementX, movementY, buttons }],
    });
    last = point;
    await sleep(DRAG_STEP_MS);
  }
}

/** A lone press or release of a mouse button at the pointer. */
async function applyButton(target: InputTarget, raw: unknown, edge: "down" | "up"): Promise<void> {
  const button = mouseButton(raw);
  const point = target.pointer();
  if (edge === "down") {
    target.send({ type: "mouseDown", x: point.x, y: point.y, button: button.name, clickCount: 1 });
    await target.dispatch({
      studio: {},
      dom: [
        {
          kind: "mouse",
          type: "mousedown",
          x: point.x,
          y: point.y,
          button: button.index,
          buttons: buttonsMask(button.index),
        },
      ],
    });
    return;
  }
  target.send({ type: "mouseUp", x: point.x, y: point.y, button: button.name, clickCount: 1 });
  await target.dispatch({
    studio: {},
    dom: [{ kind: "mouse", type: "mouseup", x: point.x, y: point.y, button: button.index, buttons: 0 }],
  });
}

/** Typed control characters and the key that types them. */
const TYPED_KEY: Record<string, string> = { "\n": "enter", "\t": "tab" };

async function applyType(target: InputTarget, action: ActionOf<"type">): Promise<void> {
  // Every character is one stroke: keydown, char, keyup — what a keyboard delivers, so a
  // game reading keydown and a text field reading input both hear it.
  for (const ch of typedText(action.text)) {
    const [key] = normalizeKeys([TYPED_KEY[ch] ?? ch]);
    if (!key) continue;
    target.send({ type: "keyDown", keyCode: key.keyCode });
    if (key.printable) sendChar(target, key);
    await target.dispatch({ studio: { down: studioAliases([key]) }, dom: keysToDom([key], "keydown") });
    await sleep(TYPED_CHAR_MS);
    target.send({ type: "keyUp", keyCode: key.keyCode });
    await target.dispatch({ studio: { up: studioAliases([key]) }, dom: keysToDom([key], "keyup") });
  }
}

async function applyPress(target: InputTarget, action: ActionOf<"press">): Promise<void> {
  const { modifiers, key } = parseCombo(action.combo);
  const chord: NormalizedKey[] = [...modifiers, ...(key ? [key] : [])];
  if (!chord.length) return;
  const times = clampRepeat(action.repeat ?? 1);
  for (let n = 0; n < times; n++) {
    for (const k of chord) {
      target.send({ type: "keyDown", keyCode: k.keyCode });
      if (k.printable && !modifiers.length) sendChar(target, k);
    }
    await target.dispatch({ studio: { down: studioAliases(chord) }, dom: keysToDom(chord, "keydown") });
    await sleep(KEY_STROKE_MS);
    for (const k of [...chord].reverse()) target.send({ type: "keyUp", keyCode: k.keyCode });
    await target.dispatch({ studio: { up: studioAliases(chord) }, dom: keysToDom(chord, "keyup") });
    if (times > 1) await sleep(REPEAT_GAP_MS);
  }
}

async function applyScroll(target: InputTarget, action: ActionOf<"scroll">): Promise<void> {
  const dx = clampScroll(action.dx);
  const dy = clampScroll(action.dy);
  const at = scrollPoint(target, action);
  target.send({ type: "mouseWheel", x: at.x, y: at.y, deltaX: -dx, deltaY: -dy });
  await target.dispatch({
    studio: {},
    dom: [{ kind: "wheel", dx, dy, x: at.x, y: at.y }],
  });
}

/** Where a wheel turns: at (x, y) in pixels when both are given, at the pointer otherwise. */
function scrollPoint(target: InputTarget, action: ActionOf<"scroll">): Point {
  if (action.x === undefined || action.y === undefined) return target.pointer();
  return pointInView(action.x, action.y, target.width, target.height, { exact: true });
}

async function applyTap(target: InputTarget, action: ActionOf<"tap">): Promise<void> {
  const keys = normalizeKeys(action.keys);
  if (keys.length === 0) return;
  const stepMs = stepBetweenPressAndRelease(action);
  await keysDown(target, keys);
  if (stepMs) await target.stepClock(stepMs);
  else await sleep(KEY_STROKE_MS);
  await keysUp(target, keys);
}

async function applyHold(target: InputTarget, action: ActionOf<"hold">): Promise<void> {
  const keys = normalizeKeys(action.keys);
  if (keys.length === 0) return;
  const ms = Math.min(MAX_HOLD_KEY_MS, Math.max(0, Math.round(Number(action.ms) || 0))) || clampHoldMs(action.ms);
  await keysDown(target, keys);
  if (ms > 0) await sleep(ms);
  await keysUp(target, keys);
}

/** Press `keys` (with their characters) natively and on the page. */
async function keysDown(target: InputTarget, keys: NormalizedKey[]): Promise<void> {
  if (keys.length === 0) return;
  for (const key of keys) {
    target.send({ type: "keyDown", keyCode: key.keyCode });
    if (key.printable) sendChar(target, key);
  }
  await target.dispatch({ studio: { down: studioAliases(keys) }, dom: keysToDom(keys, "keydown") });
}

/** Release `keys`, last pressed first, natively and on the page. */
async function keysUp(target: InputTarget, keys: NormalizedKey[]): Promise<void> {
  if (keys.length === 0) return;
  for (const key of [...keys].reverse()) target.send({ type: "keyUp", keyCode: key.keyCode });
  await target.dispatch({ studio: { up: studioAliases(keys) }, dom: keysToDom(keys, "keyup") });
}

/** Hold a click's modifiers: natively, then on the page. */
async function pressModifiers(target: InputTarget, modifiers: NormalizedKey[]): Promise<void> {
  for (const key of modifiers) target.send({ type: "keyDown", keyCode: key.keyCode });
  if (modifiers.length)
    await target.dispatch({ studio: { down: studioAliases(modifiers) }, dom: keysToDom(modifiers, "keydown") });
}

/** Let go of a click's modifiers, last held first. */
async function releaseModifiers(target: InputTarget, modifiers: NormalizedKey[]): Promise<void> {
  for (const key of [...modifiers].reverse()) target.send({ type: "keyUp", keyCode: key.keyCode });
  if (modifiers.length)
    await target.dispatch({ studio: { up: studioAliases(modifiers) }, dom: keysToDom(modifiers, "keyup") });
}

function sendChar(target: InputTarget, key: NormalizedKey): void {
  target.send({ type: "char", keyCode: key.key === " " ? "Space" : key.key });
}

/** The `modifiers` a mouse event carries while a click's modifier keys are held. */
function heldModifiers(modifiers: NormalizedKey[]): { modifiers?: Electron.InputEvent["modifiers"] } {
  const held = modifiers
    .map((key) => key.key.toLowerCase())
    .filter((name) => HELD_MODIFIERS.has(name)) as Electron.InputEvent["modifiers"];
  return held?.length ? { modifiers: held } : {};
}

/** `MouseEvent.buttons` for a pressed button index: left 1, right 2, middle 4. */
function buttonsMask(index: number): number {
  if (index === 0) return 1;
  if (index === 2) return 2;
  return 4;
}

/** Wait `ms`; a negative wait is none. */
function sleep(ms: number): Promise<void> {
  return delay(Math.max(0, ms));
}

/**
 * `stepMs` on a tap or a click: how far to advance the page's own loop between the press and
 * the release. The play script sets it when the clock is frozen; a game that reads a key inside
 * its frame never sees a press and a release delivered in the same JS turn otherwise.
 */
function stepBetweenPressAndRelease(action: PreviewInputAction): number {
  const ms = Number((action as { stepMs?: number }).stepMs);
  return Number.isFinite(ms) && ms > 0 ? Math.min(MAX_HOLD_KEY_MS, ms) : 0;
}

/** A wheel delta in pixels, capped at {@link MAX_SCROLL_PX} either way. */
function clampScroll(delta: unknown): number {
  const n = Number(delta);
  if (!Number.isFinite(n)) return 0;
  return Math.max(-MAX_SCROLL_PX, Math.min(MAX_SCROLL_PX, n));
}

function keysToDom(keys: NormalizedKey[], type: "keydown" | "keyup"): Array<Record<string, unknown>> {
  return keys.map((key) => ({
    kind: "key",
    type,
    key: key.key,
    code: key.code,
    keyCode: key.which,
  }));
}
