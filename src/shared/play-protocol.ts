/**
 * The Genex Play Protocol (docs/play-protocol.md): how the studio drives a game that runs as its
 * own process — a native build, a Godot, Unity or Unreal player — through newline-delimited JSON
 * on the game's stdin and stdout. This module is the protocol's vocabulary and wire shapes, and
 * the readers that turn an engine's untrusted reply into a typed value or nothing.
 *
 * Browser-safe: no Node imports. The client lives in `substrate/play-protocol-client.ts`, the
 * computer target over it in `main/core/game-bridge-target.ts`.
 */
import { ClockLevel, PointerLevel, StateLevel, type TargetCapabilities, TargetRuntime } from "./computer-target.ts";

/** The protocol version this studio speaks; `hello` answers the engine's. */
export const PLAY_PROTOCOL_VERSION = 3;

/** The core ops every engine answers. Game-specific ops are listed in `hello.ops`, never added here. */
export const PlayOp = {
  Hello: "hello",
  Screenshot: "screenshot",
  Pointer: "pointer",
  Key: "key",
  Type: "type",
  Look: "look",
  Wheel: "wheel",
  Act: "act",
  Pause: "pause",
  Play: "play",
  Step: "step",
  Reset: "reset",
  State: "state",
  Quit: "quit",
} as const;
export type PlayOp = (typeof PlayOp)[keyof typeof PlayOp];

/** Why an engine refused a request: the `code` of an `{ok: false}` reply. */
export const PlayErrorCode = {
  UnknownOp: "unknown-op",
  BadArgs: "bad-args",
  Unsupported: "unsupported",
} as const;
export type PlayErrorCode = (typeof PlayErrorCode)[keyof typeof PlayErrorCode];

/** Why a call failed on the studio's side of the pipe, before or without an engine's answer. */
export const PlayFailure = {
  /** No ready line arrived before the handshake's deadline. */
  NotReady: "not-ready",
  /** The engine said `{"event":"fatal"}` instead of ready. */
  Fatal: "fatal",
  /** The call's deadline passed without a reply. */
  Timeout: "timeout",
  /** The process exited (or its pipes closed) with the call pending, or before it was made. */
  Exited: "exited",
  /** The reply was longer than the studio reads. */
  Oversize: "oversize",
  /** The reply was not a usable answer to the op that was asked. */
  BadReply: "bad-reply",
} as const;
export type PlayFailure = (typeof PlayFailure)[keyof typeof PlayFailure];

/** The id-less lines an engine prints about itself; the first stdout line is one of the first two. */
export const PlayEvent = {
  Ready: "ready",
  Fatal: "fatal",
} as const;
export type PlayEvent = (typeof PlayEvent)[keyof typeof PlayEvent];

/** The picture formats `screenshot` may answer in. */
export const PlayImageFormat = {
  Jpeg: "jpeg",
  Png: "png",
} as const;
export type PlayImageFormat = (typeof PlayImageFormat)[keyof typeof PlayImageFormat];

/** How a named game action is applied: once for a tick, held for `ticks`, or let go. */
export const PlayActionState = {
  Press: "press",
  Hold: "hold",
  Release: "release",
} as const;
export type PlayActionState = (typeof PlayActionState)[keyof typeof PlayActionState];

/** A pointer button by name, as `pointer` takes it. */
export const PlayButton = {
  Left: "left",
  Middle: "middle",
  Right: "right",
} as const;
export type PlayButton = (typeof PlayButton)[keyof typeof PlayButton];

/** One named game action in an `act` list. */
export interface PlayActionInput {
  action: string;
  state: PlayActionState;
  ticks?: number;
}

/** The arguments each core op takes (beside `op` and `id`). */
export interface PlayRequestArgs {
  hello: Record<string, never>;
  screenshot: { format?: PlayImageFormat; quality?: number };
  pointer: { x: number; y: number; button?: PlayButton; down?: boolean; click?: number };
  key: { code: string; down?: boolean };
  type: { text: string };
  look: { dx: number; dy: number };
  wheel: { dx: number; dy: number };
  act: { list: PlayActionInput[] };
  pause: Record<string, never>;
  play: Record<string, never>;
  step: { ms: number };
  reset: { seed: number };
  state: Record<string, never>;
  quit: Record<string, never>;
}

/** What an engine declares it can do, in the levels the studio's computer targets use. */
export interface PlayCapabilities {
  pointer: PointerLevel;
  clock: ClockLevel;
  state: StateLevel;
  seed: boolean;
  /** The named actions `act` accepts; empty when the engine has none. */
  actions: string[];
  /** The formats `screenshot` can answer in, best first. */
  screenshot: PlayImageFormat[];
}

/** `hello`'s answer: who the engine is, what it can do, and the pixel space of its pictures and pointer. */
export interface PlayHello {
  protocol: number;
  name: string | null;
  view: { width: number; height: number };
  capabilities: PlayCapabilities;
  /** Game-specific ops beyond the core ones. */
  ops: string[];
}

/** `screenshot`'s answer: the picture inline, its size and, when the engine measures them, its light. */
export interface PlayScreenshot {
  format: PlayImageFormat;
  /** The image, base64. */
  data: string;
  width: number;
  height: number;
  stats: { meanLuma: number; litFraction: number } | null;
}

/** What a conforming engine that declares everything offers: the most a bridge target can be. */
export const PLAY_PROTOCOL_CAPABILITIES: TargetCapabilities = {
  runtime: TargetRuntime.Bridge,
  pointer: PointerLevel.Absolute,
  clock: ClockLevel.Replayable,
  state: StateLevel.Game,
  seed: true,
  reload: false,
  cameras: false,
  console: false,
  zoom: false,
  surfaces: false,
  actions: true,
};

/** Is this a non-null, non-array object whose fields can be read? */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A level from `values`, or `fallback` when the engine named anything else. */
function levelOf<L extends string>(values: Record<string, L>, raw: unknown, fallback: L): L {
  return Object.values(values).find((level) => level === raw) ?? fallback;
}

/** A positive whole pixel count, or null. */
function pixels(raw: unknown): number | null {
  return typeof raw === "number" && Number.isInteger(raw) && raw > 0 ? raw : null;
}

/** The strings of a list, or none when it is not one. */
function strings(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string") : [];
}

/** An engine's declared capabilities, read field by field: anything unreadable is the safe "none". */
function capabilitiesOf(raw: unknown): PlayCapabilities {
  const caps = isRecord(raw) ? raw : {};
  const named = strings(caps.screenshot);
  const formats = Object.values(PlayImageFormat).filter((format) => named.includes(format));
  return {
    pointer: levelOf(PointerLevel, caps.pointer, PointerLevel.None),
    clock: levelOf(ClockLevel, caps.clock, ClockLevel.None),
    state: levelOf(StateLevel, caps.state, StateLevel.None),
    seed: caps.seed === true,
    actions: strings(caps.actions),
    screenshot: formats.length ? formats : [PlayImageFormat.Png],
  };
}

/** `hello`'s answer as the studio reads it, or null when it names no protocol version or view. */
export function readHello(value: unknown): PlayHello | null {
  if (!isRecord(value) || typeof value.protocol !== "number") return null;
  const view = isRecord(value.view) ? value.view : {};
  const width = pixels(view.width);
  const height = pixels(view.height);
  if (width === null || height === null) return null;
  return {
    protocol: value.protocol,
    name: typeof value.name === "string" ? value.name : null,
    view: { width, height },
    capabilities: capabilitiesOf(value.capabilities),
    ops: strings(value.ops),
  };
}

/** Light measurements an engine sent with a picture, when both numbers are there. */
function statsOf(raw: unknown): PlayScreenshot["stats"] {
  if (!isRecord(raw)) return null;
  const { meanLuma, litFraction } = raw;
  if (typeof meanLuma !== "number" || typeof litFraction !== "number") return null;
  return { meanLuma, litFraction };
}

/** `screenshot`'s answer as the studio reads it, or null when it carries no picture of a known format. */
export function readScreenshot(value: unknown): PlayScreenshot | null {
  if (!isRecord(value) || typeof value.data !== "string" || !value.data) return null;
  const format = levelOf(PlayImageFormat, value.format, PlayImageFormat.Png);
  if (value.format !== format) return null;
  const width = pixels(value.width);
  const height = pixels(value.height);
  if (width === null || height === null) return null;
  return { format, data: value.data, width, height, stats: statsOf(value.stats) };
}

/** `step`'s answer: the simulated milliseconds that ran, or null when it says none. */
export function readStep(value: unknown): number | null {
  if (!isRecord(value)) return null;
  const ran = value.simulatedMs;
  return typeof ran === "number" && Number.isFinite(ran) && ran >= 0 ? ran : null;
}
