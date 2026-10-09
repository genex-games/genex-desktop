/**
 * The studio's native computer-use tool — one vocabulary for every worker's hands.
 *
 * Why the studio has its own instead of borrowing the vendors': Claude Code's computer use
 * needs an interactive session and takes a machine-wide lock ("only one session at a time can
 * use your computer"); Codex's is desktop-app only, and its Chrome extension refuses CLI
 * sessions. Six headless builders on one Mac cannot share one real screen. Each worker gets a
 * pooled hidden preview window instead — its own tab — and this tool drives it with Electron
 * input events and reads it with `capturePage`, the way a player and their eyes would.
 *
 * The action vocabulary is Anthropic's `computer_toolset_20260801` (screenshot, zoom,
 * left_click …, key, type, scroll, wait) so both models already know how to hold it, plus the
 * studio verbs a game needs: `camera` (a named studio viewpoint), `state` (the game's own
 * numbers), `reload` (rebuild + reload after edits), `console` (errors since load).
 *
 * Electron-free: this file parses the flat arguments the bridge shim and the MCP schema
 * deliver and maps an action onto {@link PreviewInputAction}s. The port that executes them
 * lives in the Electron layer; the tool host (studio-core) owns screenshots and files.
 */
import {
  capActions,
  clampRepeat,
  clickModifiers,
  MAX_HOLD_KEY_MS,
  MAX_KEYS,
  parseCombo,
  typedText,
  type PreviewInputAction,
} from "./preview-input.ts";
import type { PreviewSetup } from "../shared/preview-contract.ts";
import { BROWSER_CAPABILITIES, canPoint, hasState, type TargetCapabilities } from "../shared/computer-target.ts";
import { SECOND_MS } from "../shared/duration.ts";
import { type ScreenAct, ScreenDeed } from "../shared/agent-screen.ts";
import {
  COMPUTER_ARG_PROBLEM,
  COMPUTER_PARAMETER_TEXT,
  computerToolDescription,
  type ComputerToolRole,
  knownCamerasLine,
} from "./computer-tool-prompts.ts";

export const COMPUTER_TOOL_NAME = "computer";

/** Actions that become input events on the preview. */
export const COMPUTER_INPUT_ACTIONS = [
  "left_click",
  "right_click",
  "middle_click",
  "double_click",
  "triple_click",
  "left_click_drag",
  "mouse_move",
  "left_mouse_down",
  "left_mouse_up",
  "scroll",
  "type",
  "key",
  "hold_key",
] as const;

/** Actions the tool host answers itself: looking, waiting, and the studio verbs. */
export const COMPUTER_HOST_ACTIONS = [
  "screenshot",
  "zoom",
  "cursor_position",
  "wait",
  "camera",
  "state",
  "reload",
  "console",
] as const;

export type ComputerInputAction = (typeof COMPUTER_INPUT_ACTIONS)[number];
export type ComputerHostAction = (typeof COMPUTER_HOST_ACTIONS)[number];
export type ComputerAction = ComputerInputAction | ComputerHostAction;

export const COMPUTER_ACTIONS: readonly ComputerAction[] = [...COMPUTER_INPUT_ACTIONS, ...COMPUTER_HOST_ACTIONS];

export type Point = [number, number];
export type Region = [number, number, number, number];

/**
 * Which picture a look takes (M4.5): `screen` is the whole page — a DOM menu, an HTML HUD, a
 * loading screen, everything the user sees — and `canvas` is only what the game draws. A game
 * whose car-select and pause screen live outside the canvas is invisible to a canvas-only eye,
 * which is why a worker can ask. Absent means the studio picks.
 */
export type ComputerSurface = "screen" | "canvas";

/** Only these actions take a picture; every other action accepts a surface and ignores it. */
export const COMPUTER_SURFACE_ACTIONS: readonly ComputerAction[] = ["screenshot", "camera", "zoom"];

/** Which way a scroll turns the wheel. */
export type ScrollDirection = "up" | "down" | "left" | "right";

export interface ComputerRequest {
  action: ComputerAction;
  coordinate?: Point;
  start_coordinate?: Point;
  region?: Region;
  text?: string;
  repeat?: number;
  /** Seconds (wait, hold_key). */
  duration?: number;
  scroll_direction?: ScrollDirection;
  scroll_amount?: number;
  /** Which surface a screenshot, camera or zoom photographs; absent lets the studio choose. */
  surface?: ComputerSurface;
  /** What to tell the model when it asked for a surface nobody has — never a refusal. */
  surfaceNote?: string;
}

export type ParsedComputer = { ok: true; request: ComputerRequest } | { ok: false; error: string };

/** Wheel pixels per notch — what a physical wheel click delivers to a page. */
export const SCROLL_NOTCH_PX = 120;
export const MAX_SCROLL_NOTCHES = 50;
export const MAX_WAIT_S = 300;
/** Size of a worker's window — inside Anthropic's recommended band, so no coordinate scaling. */
export const COMPUTER_VIEW = { width: 960, height: 600 } as const;
/** Wheel notches a scroll turns when it names none. */
const DEFAULT_SCROLL_NOTCHES = 3;
/** Seconds a wait or a held key lasts when it names none. */
const DEFAULT_DURATION_S = 1;
/** How many camera names the tool description lists. */
const MAX_LISTED_CAMERAS = 12;
/** How much of an unknown surface word the note quotes back. */
const MAX_QUOTED_SURFACE_CHARS = 40;
/** How much of typed text a caption quotes. */
const MAX_CAPTION_TEXT_CHARS = 40;

/** Nothing given: absent, null or an empty string. */
function isBlank(value: unknown): boolean {
  return value === null || value === undefined || value === "";
}

function num(value: unknown): number | null {
  if (isBlank(value)) return null;
  const n = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isFinite(n) ? n : null;
}

/** Two coordinates as a point, when both are numbers. */
function pointOf(x: unknown, y: unknown): Point | null {
  const px = num(x);
  const py = num(y);
  return px !== null && py !== null ? [px, py] : null;
}

/** `[x, y]`, `"x,y"`, `"x y"`, `"[x, y]"` or `{x, y}` → a pixel point. */
export function parsePoint(value: unknown): Point | null {
  if (isBlank(value)) return null;
  if (Array.isArray(value) && value.length >= 2) return pointOf(value[0], value[1]);
  if (typeof value === "object") {
    const o = value as { x?: unknown; y?: unknown };
    return pointOf(o.x, o.y);
  }
  return parsePointText(String(value).trim());
}

/** A point written as text: JSON, or two numbers split by a comma or spaces. */
function parsePointText(text: string): Point | null {
  if (text.startsWith("[") || text.startsWith("{")) {
    try {
      return parsePoint(JSON.parse(text));
    } catch {
      return null;
    }
  }
  const parts = text.split(/[,\s]+/).filter(Boolean);
  if (parts.length < 2) return null;
  return pointOf(parts[0], parts[1]);
}

/** `[x0, y0, x1, y1]` or `"x0,y0,x1,y1"` → a region; corners are ordered for the caller. */
export function parseRegion(value: unknown): Region | null {
  if (isBlank(value)) return null;
  let parts: unknown[] | null = null;
  if (Array.isArray(value)) parts = value;
  else {
    const text = String(value).trim();
    if (text.startsWith("[")) {
      try {
        parts = JSON.parse(text) as unknown[];
      } catch {
        return null;
      }
    } else parts = text.split(/[,\s]+/).filter(Boolean);
  }
  if (!parts || parts.length < 4) return null;
  const nums = parts.slice(0, 4).map(num);
  if (nums.some((n) => n === null)) return null;
  const [a, b, c, d] = nums as number[];
  return [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)];
}

/** The words a model actually writes for each surface, and the ones that mean "you choose". */
const SURFACE_WORDS: Record<string, ComputerSurface> = {
  screen: "screen",
  page: "screen",
  dom: "screen",
  html: "screen",
  window: "screen",
  ui: "screen",
  full: "screen",
  fullpage: "screen",
  canvas: "canvas",
  webgl: "canvas",
  webgl2: "canvas",
  webgpu: "canvas",
  gl: "canvas",
  gpu: "canvas",
  game: "canvas",
  render: "canvas",
  scene: "canvas",
};
const SURFACE_AUTO = new Set(["auto", "any", "both", "default", "either", "studio"]);

/**
 * A surface as either transport delivers it. An unparseable value is NOT a refusal: the Codex
 * bridge turns a valueless `--surface` into the literal string `"true"`, and spending a turn
 * telling the engine that cannot see the image so would cost more than the picture is worth.
 * The studio picks instead, and the note says what happened.
 */
export function parseSurface(value: unknown): { surface: ComputerSurface | null; note: string | null } {
  if (value === null || value === undefined) return { surface: null, note: null };
  const raw = String(value).trim();
  if (!raw) return { surface: null, note: null };
  const key = raw.toLowerCase().replace(/[\s_-]/g, "");
  const known = SURFACE_WORDS[key];
  if (known) return { surface: known, note: null };
  if (SURFACE_AUTO.has(key)) return { surface: null, note: null };
  return {
    surface: null,
    note: COMPUTER_ARG_PROBLEM.unknownSurface(raw.slice(0, MAX_QUOTED_SURFACE_CHARS)),
  };
}

/** The action name as either transport spells it: trimmed, lower case, `-` read as `_`. */
function actionName(raw: Record<string, unknown>): string {
  return String(raw.action ?? "")
    .trim()
    .toLowerCase()
    .replace(/-/g, "_");
}

function isComputerAction(action: string): action is ComputerAction {
  return (COMPUTER_ACTIONS as readonly string[]).includes(action);
}

function isScrollDirection(direction: string): direction is ScrollDirection {
  return direction === "up" || direction === "down" || direction === "left" || direction === "right";
}

/** Where the pointer goes: \`coordinate\`, or \`x\` and \`y\` given apart. */
function coordinateOf(raw: Record<string, unknown>): Point | null {
  const given = parsePoint(raw.coordinate);
  if (given) return given;
  return raw.x !== undefined && raw.y !== undefined ? parsePoint({ x: raw.x, y: raw.y }) : null;
}

/** The pointer fields: where, from where, and the region a zoom looks at. */
function readPointerFields(request: ComputerRequest, raw: Record<string, unknown>): void {
  const coordinate = coordinateOf(raw);
  if (coordinate) request.coordinate = coordinate;
  const start = parsePoint(raw.start_coordinate ?? raw.startCoordinate);
  if (start) request.start_coordinate = start;
  const region = parseRegion(raw.region);
  if (region) request.region = region;
}

/** The rest: text, repeat, duration, scroll and surface, each clamped to what the port allows. */
function readOtherFields(request: ComputerRequest, raw: Record<string, unknown>): void {
  if (raw.text !== undefined && raw.text !== null) request.text = String(raw.text);
  const repeat = num(raw.repeat);
  if (repeat !== null) request.repeat = clampRepeat(repeat);
  const duration = num(raw.duration);
  if (duration !== null) request.duration = Math.max(0, Math.min(MAX_WAIT_S, duration));
  const direction = String(raw.scroll_direction ?? raw.direction ?? "")
    .trim()
    .toLowerCase();
  if (isScrollDirection(direction)) request.scroll_direction = direction;
  const amount = num(raw.scroll_amount ?? raw.amount);
  if (amount !== null) request.scroll_amount = Math.max(0, Math.min(MAX_SCROLL_NOTCHES, Math.round(amount)));
  const surface = parseSurface(raw.surface);
  if (surface.surface) request.surface = surface.surface;
  if (surface.note) request.surfaceNote = surface.note;
}

/** What each action needs, said before anything is pressed: the sentence when it is missing. */
const ACTION_NEEDS: Partial<Record<ComputerAction, (request: ComputerRequest) => string | null>> = {
  left_click_drag: (r) => (r.start_coordinate && r.coordinate ? null : COMPUTER_ARG_PROBLEM.dragNeedsPoints),
  mouse_move: (r) => (r.coordinate ? null : COMPUTER_ARG_PROBLEM.moveNeedsPoint),
  zoom: (r) => (r.region ? null : COMPUTER_ARG_PROBLEM.zoomNeedsRegion),
  scroll: (r) => (r.scroll_direction ? null : COMPUTER_ARG_PROBLEM.scrollNeedsDirection),
  type: (r) => (r.text ? null : COMPUTER_ARG_PROBLEM.typeNeedsText),
  key: (r) => (r.text ? null : COMPUTER_ARG_PROBLEM.keyNeedsText(r.action)),
  hold_key: (r) => (r.text ? null : COMPUTER_ARG_PROBLEM.keyNeedsText(r.action)),
  camera: (r) => (r.text ? null : COMPUTER_ARG_PROBLEM.cameraNeedsName),
};

/** The amounts an action falls back to when it names none. */
function applyActionDefaults(request: ComputerRequest): void {
  if (request.action === "scroll" && request.scroll_amount === undefined) {
    request.scroll_amount = DEFAULT_SCROLL_NOTCHES;
  }
  const timed = request.action === "hold_key" || request.action === "wait";
  if (timed && request.duration === undefined) request.duration = DEFAULT_DURATION_S;
}

/**
 * The flat arguments as either transport delivers them (strings from the bridge shim,
 * typed values from MCP) → one validated request, or the sentence the model reads instead.
 */
export function parseComputerArgs(args: Record<string, unknown> | null | undefined): ParsedComputer {
  const raw = args ?? {};
  const action = actionName(raw);
  const actions = COMPUTER_ACTIONS.join(", ");
  if (!action) return { ok: false, error: COMPUTER_ARG_PROBLEM.noAction(actions) };
  if (!isComputerAction(action)) return { ok: false, error: COMPUTER_ARG_PROBLEM.unknownAction(action, actions) };
  const request: ComputerRequest = { action };
  readPointerFields(request, raw);
  readOtherFields(request, raw);
  const missing = ACTION_NEEDS[action]?.(request) ?? null;
  if (missing) return { ok: false, error: missing };
  applyActionDefaults(request);
  return { ok: true, request };
}

/** The click actions: which button, how many times. */
const CLICKS: Partial<Record<ComputerAction, { button: "left" | "right" | "middle"; clicks: number }>> = {
  left_click: { button: "left", clicks: 1 },
  right_click: { button: "right", clicks: 1 },
  middle_click: { button: "middle", clicks: 1 },
  double_click: { button: "left", clicks: 2 },
  triple_click: { button: "left", clicks: 3 },
};

/** The wheel's sign on each axis, per direction. */
const SCROLL_SIGN: Record<ScrollDirection, { x: number; y: number }> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

function scrollInput(request: ComputerRequest): PreviewInputAction {
  const px = (request.scroll_amount ?? DEFAULT_SCROLL_NOTCHES) * SCROLL_NOTCH_PX;
  const sign = request.scroll_direction ? SCROLL_SIGN[request.scroll_direction] : { x: 0, y: 0 };
  return {
    type: "scroll",
    dx: sign.x * px,
    dy: sign.y * px,
    ...(request.coordinate ? { x: request.coordinate[0], y: request.coordinate[1] } : {}),
  };
}

function holdKeyInput(request: ComputerRequest): PreviewInputAction[] {
  const { modifiers, key } = parseCombo(request.text);
  const keys = [...modifiers.map((k) => k.code), ...(key ? [key.code] : [])];
  const ms = Math.min(MAX_HOLD_KEY_MS, Math.round((request.duration ?? DEFAULT_DURATION_S) * SECOND_MS));
  return keys.length ? [{ type: "hold", keys, ms }] : [];
}

/** The pointer actions that are not clicks: drag, move, button down and up. */
function pointerInput(request: ComputerRequest): PreviewInputAction[] {
  const from = request.start_coordinate;
  const to = request.coordinate;
  switch (request.action) {
    case "left_click_drag":
      if (!from || !to) return [];
      return [{ type: "drag", fromX: from[0], fromY: from[1], x: to[0], y: to[1], button: "left", px: true }];
    case "mouse_move":
      if (!to) return [];
      return [{ type: "move", x: to[0], y: to[1], px: true }];
    case "left_mouse_down":
      return [{ type: "mousedown", button: "left" }];
    case "left_mouse_up":
      return [{ type: "mouseup", button: "left" }];
    default:
      return [];
  }
}

/**
 * An input action → the preview's HID plan. Coordinates are pixels of the last screenshot
 * (origin top-left), clamped by the port; a click without a coordinate lands on the pointer.
 */
export function computerToInput(request: ComputerRequest, pointer: { x: number; y: number }): PreviewInputAction[] {
  const click = CLICKS[request.action];
  if (click) {
    const at = request.coordinate
      ? { x: request.coordinate[0], y: request.coordinate[1] }
      : { x: pointer.x, y: pointer.y };
    return [
      {
        type: "click",
        ...at,
        button: click.button,
        clicks: click.clicks,
        px: true,
        ...(request.text ? { modifiers: clickModifiers(request.text) } : {}),
      },
    ];
  }
  switch (request.action) {
    case "scroll":
      return [scrollInput(request)];
    case "type":
      return [{ type: "type", text: typedText(request.text) }];
    case "key":
      return [{ type: "press", combo: String(request.text), repeat: request.repeat ?? 1 }];
    case "hold_key":
      return holdKeyInput(request);
    default:
      return pointerInput(request);
  }
}

/** The pointer actions: each needs a target that can put its pointer at a point. */
const POINTED_ACTIONS: ReadonlySet<ComputerAction> = new Set([
  "left_click",
  "right_click",
  "middle_click",
  "double_click",
  "triple_click",
  "left_click_drag",
  "mouse_move",
  "left_mouse_down",
  "left_mouse_up",
]);

/** What each action asks of a target beyond pictures and keys; an action missing here every target can do. */
const ACTION_NEEDS_CAPABILITY: Partial<Record<ComputerAction, (caps: TargetCapabilities) => boolean>> = {
  zoom: (caps) => caps.zoom,
  camera: (caps) => caps.cameras,
  state: (caps) => hasState(caps),
  console: (caps) => caps.console,
  reload: (caps) => caps.reload,
};

/** Can this target carry out this action? */
function actionFits(action: ComputerAction, caps: TargetCapabilities): boolean {
  if (POINTED_ACTIONS.has(action) && !canPoint(caps)) return false;
  return ACTION_NEEDS_CAPABILITY[action]?.(caps) ?? true;
}

/** The actions a target can carry out, in the tool's own order: the only ones the model is offered. */
export function computerActionsFor(caps: TargetCapabilities): ComputerAction[] {
  return COMPUTER_ACTIONS.filter((action) => actionFits(action, caps));
}

/** The sentence for an action the target cannot carry out, or null when it can. Never a silent no-op. */
export function unsupportedAction(action: ComputerAction, caps: TargetCapabilities): string | null {
  if (actionFits(action, caps)) return null;
  return COMPUTER_ARG_PROBLEM.unsupported(action, computerActionsFor(caps).join(", "));
}

/** The flat parameter schema both transports share (the bridge prints it as flags). */
export interface ComputerToolSchema {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, { type: string; description?: string }>;
    required?: string[];
  };
}

/**
 * What the model is told. Written once, for both engines: Claude Code sees it as
 * `mcp__studio__computer`, Codex as `node .studio/bridge/tool.mjs computer --action=…`.
 */
export function computerToolDefinition(
  options: {
    role?: ComputerToolRole;
    cameras?: string[];
    capabilities?: TargetCapabilities;
    view?: { width: number; height: number };
  } = {},
): ComputerToolSchema {
  const capabilities = options.capabilities ?? BROWSER_CAPABILITIES;
  const cameras = knownCamerasLine((options.cameras ?? []).slice(0, MAX_LISTED_CAMERAS));
  const text = COMPUTER_PARAMETER_TEXT;
  const view = options.view ?? COMPUTER_VIEW;
  return {
    name: COMPUTER_TOOL_NAME,
    description: computerToolDescription({ role: options.role ?? "builder", view, cameras, capabilities }),
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", description: text.action(computerActionsFor(capabilities).join(", ")) },
        coordinate: { type: "string", description: text.coordinate },
        start_coordinate: { type: "string", description: text.start_coordinate },
        region: { type: "string", description: text.region },
        text: { type: "string", description: text.text },
        repeat: { type: "number", description: text.repeat },
        duration: { type: "number", description: text.duration },
        scroll_direction: { type: "string", description: text.scroll_direction },
        scroll_amount: { type: "number", description: text.scroll_amount },
        ...(capabilities.surfaces ? { surface: { type: "string", description: text.surface } } : {}),
      },
      required: ["action"],
    },
  };
}

/** One line for a log, a frame caption, or the run's ledger. */
/** The deed each action shows on the agent's screen; the studio's reads (state, console) count as looking. */
const ACTION_DEED: Record<ComputerAction, ScreenDeed> = {
  left_click: ScreenDeed.Click,
  right_click: ScreenDeed.Click,
  middle_click: ScreenDeed.Click,
  double_click: ScreenDeed.Click,
  triple_click: ScreenDeed.Click,
  left_mouse_down: ScreenDeed.Click,
  left_mouse_up: ScreenDeed.Click,
  left_click_drag: ScreenDeed.Drag,
  mouse_move: ScreenDeed.Move,
  scroll: ScreenDeed.Scroll,
  type: ScreenDeed.Type,
  key: ScreenDeed.Press,
  hold_key: ScreenDeed.Press,
  screenshot: ScreenDeed.Look,
  zoom: ScreenDeed.Look,
  cursor_position: ScreenDeed.Look,
  camera: ScreenDeed.Look,
  state: ScreenDeed.Look,
  console: ScreenDeed.Look,
  wait: ScreenDeed.Wait,
  reload: ScreenDeed.Reload,
};

/** A computer action as the agent's screen shows it: its deed, and the keys of a press. */
export function computerAct(request: ComputerRequest): ScreenAct {
  const deed = ACTION_DEED[request.action];
  const keys = request.text?.trim();
  return deed === ScreenDeed.Press && keys ? { deed, keys: [keys] } : { deed };
}

export function describeComputerAction(request: ComputerRequest): string {
  // A surface only ever changed what a picture shows, so only the picture-taking actions
  // carry it into the caption — a click caption stays the sentence every log already holds.
  const surface =
    request.surface && (COMPUTER_SURFACE_ACTIONS as readonly string[]).includes(request.action)
      ? ` (${request.surface})`
      : "";
  return describeAction(request) + surface;
}

function describeAction(request: ComputerRequest): string {
  const point = (p?: Point) => (p ? `${Math.round(p[0])},${Math.round(p[1])}` : "");
  if (CLICKS[request.action]) {
    return `${request.action.replace("_", " ")}${request.coordinate ? ` at ${point(request.coordinate)}` : ""}`;
  }
  switch (request.action) {
    case "left_click_drag":
      return `drag ${point(request.start_coordinate)} → ${point(request.coordinate)}`;
    case "mouse_move":
      return `move to ${point(request.coordinate)}`;
    case "scroll":
      return `scroll ${request.scroll_direction} ×${request.scroll_amount ?? DEFAULT_SCROLL_NOTCHES}`;
    case "type":
      return `type "${String(request.text ?? "").slice(0, MAX_CAPTION_TEXT_CHARS)}"`;
    case "key":
      return `key ${request.text}${(request.repeat ?? 1) > 1 ? ` ×${request.repeat}` : ""}`;
    case "hold_key":
      return `hold ${request.text} ${request.duration ?? DEFAULT_DURATION_S}s`;
    case "wait":
      return `wait ${request.duration ?? DEFAULT_DURATION_S}s`;
    case "zoom":
      return `zoom ${request.region?.map(Math.round).join(",")}`;
    case "camera":
      return `camera ${request.text}`;
    default:
      return request.action;
  }
}

// ── the requested state: what every look at the build must reach first ─────────────────────

export type { PreviewSetup };

const MAX_SETUP_ACTIONS = 24;
/** The longest demo name a setup keeps. */
const MAX_DEMO_CHARS = 80;
/** The longest settle a setup may ask for. */
const MAX_SETTLE_MS = 10 * SECOND_MS;
/** The longest note a setup keeps. */
const MAX_SETUP_NOTE_CHARS = 300;

/** A setup's gesture: \`true\`, or where to press and which keys to hold. */
function normalizeGesture(raw: unknown): PreviewSetup["gesture"] | undefined {
  if (raw === true) return true;
  if (!raw || typeof raw !== "object") return undefined;
  const g = raw as Record<string, unknown>;
  const x = Number(g.x);
  const y = Number(g.y);
  const keys = Array.isArray(g.keys)
    ? g.keys
        .map((key) => String(key))
        .filter(Boolean)
        .slice(0, MAX_KEYS)
    : [];
  return {
    ...(Number.isFinite(x) ? { x } : {}),
    ...(Number.isFinite(y) ? { y } : {}),
    ...(keys.length ? { keys } : {}),
  };
}

/** A setup's verify: a plain dotted state path, and what it should hold. */
function normalizeVerify(raw: unknown): PreviewSetup["verify"] | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const v = raw as Record<string, unknown>;
  if (typeof v.path !== "string" || !/^[a-zA-Z_$][\w$]*(\.[a-zA-Z_$][\w$]*)*$/.test(v.path)) return undefined;
  return {
    path: v.path,
    ...("equals" in v ? { equals: v.equals } : {}),
    ...(v.truthy === true ? { truthy: true } : {}),
  };
}

/** A non-blank string, trimmed and cut to \`max\`; undefined for anything else. */
function trimmedText(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;
}

/** Untrusted JSON (a scout's answer, a journal) → a setup the studio will run, or null. */
export function normalizeSetup(raw: unknown): PreviewSetup | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const setup: PreviewSetup = {};
  const gesture = normalizeGesture(o.gesture);
  if (gesture !== undefined) setup.gesture = gesture;
  if (Array.isArray(o.actions)) {
    // Only actions the port knows: a made-up verb is dropped here, not discovered mid-run.
    const actions = capActions(o.actions).slice(0, MAX_SETUP_ACTIONS);
    if (actions.length) setup.actions = actions;
  }
  const demo = trimmedText(o.demo, MAX_DEMO_CHARS);
  if (demo) setup.demo = demo;
  const settle = Number(o.settleMs);
  if (Number.isFinite(settle) && settle > 0) setup.settleMs = Math.min(MAX_SETTLE_MS, Math.round(settle));
  const verify = normalizeVerify(o.verify);
  if (verify) setup.verify = verify;
  const note = trimmedText(o.note, MAX_SETUP_NOTE_CHARS);
  if (note) setup.note = note;
  return setup.actions || setup.demo || setup.verify || setup.gesture ? setup : null;
}

function lookupPath(state: unknown, path: string): unknown {
  let current: unknown = state;
  for (const key of path.split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** Did the state land? `null` when the state itself is unreadable (no contract, no answer). */
export function setupReached(verify: PreviewSetup["verify"], state: unknown): boolean | null {
  if (!verify) return null;
  const readable = typeof state === "object" && state !== null && !(state as { __missing?: boolean }).__missing;
  if (!readable) return null;
  const value = lookupPath(state, verify.path);
  if ("equals" in verify) return value === verify.equals || String(value) === String(verify.equals);
  if (verify.truthy) return Boolean(value);
  return value !== undefined;
}

/** The same test as a harness probe expression, so the board can carry it as a check. */
export function setupVerifyExpr(verify: PreviewSetup["verify"]): string | null {
  if (!verify) return null;
  if ("equals" in verify) {
    const v = verify.equals;
    const literal = typeof v === "number" || typeof v === "boolean" ? String(v) : JSON.stringify(String(v));
    return `has(${JSON.stringify(verify.path)}) && ${verify.path} == ${literal}`;
  }
  if (verify.truthy) return `has(${JSON.stringify(verify.path)}) && ${verify.path}`;
  return `has(${JSON.stringify(verify.path)})`;
}
