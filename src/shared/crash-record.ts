/**
 * A game's crash record, `genex-crash/1` (game-systems PROFILE): what a Rust game's panic hook, the
 * web shell, a phone's platform reader or the host itself writes when a run crashes, so an agent
 * reads the kind, the place, the seed, the tick and the input tail as data and replays the crash.
 * A game sends its record as the `crash` event before it exits; the host persists it under the
 * game's `.studio/crashes/`, announces it as `game_crashed` and answers `game.crashes`.
 *
 * Every record comes from the game (or a file it could write), so `parseCrashRecord` reads it as
 * hostile input: size, depth, vocabularies, hex addresses and caps are checked, unknown fields are
 * dropped, overlong text is cut (and named in `trimmed`), and it answers null, never throws.
 */
import { CustomEvent, customEvent } from "./custom-events.ts";
import type { EventEnvelope } from "./event-log.ts";
import { jsonWithin, type ProfileSummaryV1, parseProfileSummary } from "./frame-profile.ts";

/** The record's format line. */
export const CRASH_RECORD_FORMAT = "genex-crash/1";
/** The most bytes a record takes as JSON. */
export const CRASH_RECORD_MAX_BYTES = 64 * 1024;
/** The most bytes of the panic message, the GPU error's description and a WASM trap's text. */
export const CRASH_MESSAGE_MAX_BYTES = 2 * 1024;
/** The most stack frames a record keeps (the top ones). */
export const CRASH_FRAMES_MAX = 128;
/** The most bytes of the replay track (base64 of at most 24 KiB of InputTrack rows). */
export const CRASH_REPLAY_MAX_BYTES = 24 * 1024;
/** The most characters of a source path (a compile-time string, never opened). */
export const CRASH_PATH_MAX_CHARS = 512;
/** The most debug images a platform record names, and hitch frames a record lists. */
export const CRASH_IMAGES_MAX = 64;
export const CRASH_HITCHES_MAX = 16;
/** The deepest JSON nesting a record may have. */
export const CRASH_JSON_DEPTH_MAX = 12;
/** The most records `game.crashes` answers (newest first), and keeps per game. */
export const GAME_CRASHES_MAX = 32;

/** What crashed. Wire values: never rename one. */
export const CrashKind = {
  /** A Rust panic (fatal, or handled when it was caught). */
  Panic: "panic",
  /** An uncaptured wgpu error on a live device. */
  GpuValidation: "gpu-validation",
  /** The GPU device was lost (not fatal: recovery runs). */
  DeviceLost: "device-lost",
  /** A WebAssembly trap with no Rust panic (made by the web shell). */
  WasmTrap: "wasm-trap",
  /** SIGSEGV, SIGBUS or EXC_BAD_ACCESS (made by the platform's reader). */
  NativeFault: "native-fault",
  /** A low-memory kill (made by the platform's reader). */
  OutOfMemory: "out-of-memory",
  /** The host killed a run that stopped answering (made by the host). */
  Hang: "hang",
  /** An abnormal exit with no record (made by the host: code and signal). */
  ProcessExit: "process-exit",
} as const;
export type CrashKind = (typeof CrashKind)[keyof typeof CrashKind];

/** Who wrote the record. Wire values. */
export const CrashSource = {
  Game: "game",
  Shell: "shell",
  Platform: "platform",
  Host: "host",
} as const;
export type CrashSource = (typeof CrashSource)[keyof typeof CrashSource];

/** The kinds a game's own panic hook writes: a `crash` event naming any other is a violation. */
export const GAME_CRASH_KINDS: readonly CrashKind[] = Object.freeze([
  CrashKind.Panic,
  CrashKind.GpuValidation,
  CrashKind.DeviceLost,
]);

/** The class of an uncaptured wgpu error. Wire values. */
export const GpuErrorClass = {
  Validation: "validation",
  OutOfMemory: "out-of-memory",
  Internal: "internal",
} as const;
export type GpuErrorClass = (typeof GpuErrorClass)[keyof typeof GpuErrorClass];

/** What a WebAssembly trap was. Wire values. */
export const WasmTrap = {
  Unreachable: "unreachable",
  Memory: "memory",
  Stack: "stack",
  Other: "other",
} as const;
export type WasmTrap = (typeof WasmTrap)[keyof typeof WasmTrap];

/** The build the crash came from. Wire values. */
export const CrashFlavour = {
  Dev: "dev",
  Export: "export",
} as const;
export type CrashFlavour = (typeof CrashFlavour)[keyof typeof CrashFlavour];

/** What a record over its caps gave up, oldest rule first. Wire values. */
export const CrashTrimmed = {
  Profile: "profile",
  ReplayTrack: "replay.track",
  Frames: "frames",
  Message: "message",
  LocationFile: "location.file",
} as const;
export type CrashTrimmed = (typeof CrashTrimmed)[keyof typeof CrashTrimmed];

/** Why the host has no crash records to give. Wire values. */
export const GameCrashesUnavailableReason = {
  /** This host does not keep crash records yet. */
  NotServed: "not-served",
} as const;
export type GameCrashesUnavailableReason =
  (typeof GameCrashesUnavailableReason)[keyof typeof GameCrashesUnavailableReason];

/** Where in the source the crash happened. */
export interface CrashLocation {
  file: string;
  line: number;
  column: number;
}

/** One stack frame: a runtime address (`0x…`), or an offset into a named debug image (platform records). */
export type CrashFrame = { ip: string } | { image: number; offset: string };

/** A debug image a platform record's frames point into (a MetricKit binary UUID, an Android build id). */
export interface CrashImage {
  name: string;
  id: string;
}

/** The GPU's side of a `gpu-validation` or `device-lost` record. */
export interface CrashGpu {
  class: GpuErrorClass | null;
  reason: string | null;
  description: string;
  backend: string | null;
  adapter: string | null;
}

/** A web trap's side: what trapped and the engine's `wasm-function[N]:0xOFF` frames. */
export interface CrashWasm {
  trap: WasmTrap;
  stack: Array<{ func: number; offset: number }>;
}

/** Where the game was: every field the writer knew. */
export interface CrashContext {
  seed?: number;
  tick?: number;
  frame?: number;
  simulatedMs?: number;
  running?: boolean;
  destination?: string;
  flavour?: CrashFlavour;
  build?: string;
  contract?: number;
  genex?: string;
}

/** The input since the last seed or snapshot anchor, to replay the crash with `seed`, `input` and `step`. */
export interface CrashReplay {
  seed: number;
  fromTick: number;
  toTick: number;
  /** False when the ring was busy or overflowed (then `fromTick` moved). */
  complete: boolean;
  /** Base64 of the InputTrack tail. */
  track: string;
}

/** A `genex-crash/1` record as the host keeps it. */
export interface CrashRecordV1 {
  format: "genex-crash/1";
  kind: CrashKind;
  source: CrashSource;
  fatal: boolean;
  handled: boolean;
  message: string;
  location: CrashLocation | null;
  thread: { name: string; main: boolean } | null;
  frames: CrashFrame[];
  /** The runtime address of `genex_crash::anchor`, from which the host computes the image's slide. */
  anchor: string | null;
  images: CrashImage[];
  gpu: CrashGpu | null;
  wasm: CrashWasm | null;
  context: CrashContext;
  replay: CrashReplay | null;
  profile: ProfileSummaryV1 | null;
  hitches: number[];
  /** Always null in what a game sends; the host's symbolication is the kept entry's `symbols`. */
  symbols: null;
  trimmed: CrashTrimmed[];
}

/** One record `game.crashes` lists: the host's id for it, the run it came from, and how often it recurred. */
export interface GameCrashEntry {
  crashId: string;
  runId: string | null;
  /** When the host persisted it (ISO 8601). */
  at: string;
  /** How many runs crashed with the same signature. */
  repeat: number;
  symbolicated: boolean;
  record: CrashRecordV1;
  /** The host's names for the record's frames, when it symbolicated them (`symbolicated`). */
  symbols?: CrashSymbols;
}

/** One function a symbolicated frame names: its demangled path and its place, each null when unknown. */
export interface CrashSymbolFunction {
  function: string | null;
  file: string | null;
  line: number | null;
  column: number | null;
}

/** A frame named by the host: inside the game's image (inlined functions first, its own last), or `foreign`. */
export type CrashSymbolFrame = { foreign: true } | { foreign: false; functions: CrashSymbolFunction[] };

/** The host's symbolication of a record: one entry per record frame, in order, and the web trap's functions. */
export interface CrashSymbols {
  frames: CrashSymbolFrame[];
  wasm: Array<{ func: number; name: string | null }>;
}

/** What `game.crashes` and `studio:game.crashes` answer once the host keeps records. */
export interface GameCrashesAnswer {
  records: GameCrashEntry[];
}

/** What they answer before that. */
export interface GameCrashesUnavailable {
  state: "unavailable";
  reason: GameCrashesUnavailableReason;
}

/** The answer for a host that keeps no crash records yet. */
export function gameCrashesUnavailable(): GameCrashesUnavailable {
  return { state: "unavailable", reason: GameCrashesUnavailableReason.NotServed };
}

/**
 * The `game_crashed` event's payload (written by the host only): what the chat and the harness
 * show without opening the record. Every field is optional, as every custom event payload is.
 */
export interface GameCrashedPayload {
  project?: string;
  runId?: string;
  crashId?: string;
  kind?: CrashKind;
  source?: CrashSource;
  fatal?: boolean;
  handled?: boolean;
  tick?: number;
  seed?: number;
  destination?: string;
  location?: CrashLocation;
  symbolicated?: boolean;
  repeat?: number;
}

// ── the parser ──────────────────────────────────────────────────────────────────────────────

const HEX = /^0x[0-9a-f]{1,16}$/;
const IMAGE_ID = /^[0-9A-Fa-f-]{1,64}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
/** Base64 length of `CRASH_REPLAY_MAX_BYTES` bytes. */
const REPLAY_TRACK_MAX_CHARS = Math.ceil(CRASH_REPLAY_MAX_BYTES / 3) * 4;
/** Short identifying text: a thread name, a backend, a build id, a version. */
const SHORT_TEXT_MAX_CHARS = 128;
/** An adapter name or a lost device's reason. */
const NAME_TEXT_MAX_CHARS = 256;
const U32_MAX = 0xffff_ffff;

/** Thrown inside the parse for a value outside its shape; caught once, by `parseCrashRecord`. */
class CrashRefused extends Error {}
const refuse = (): never => {
  throw new CrashRefused();
};
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const record = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : refuse());
const flag = (value: unknown): boolean => (typeof value === "boolean" ? value : refuse());
const count = (value: unknown): number =>
  Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : refuse();
const hex = (value: unknown): string => (typeof value === "string" && HEX.test(value) ? value : refuse());
const shortText = (value: unknown, max = SHORT_TEXT_MAX_CHARS): string =>
  typeof value === "string" && value.length <= max ? value : refuse();
const optional = <T>(value: unknown, read: (value: unknown) => T): T | undefined =>
  value === undefined ? undefined : read(value);
const nullable = <T>(value: unknown, read: (value: unknown) => T): T | null =>
  value === undefined || value === null ? null : read(value);
function word<T extends string>(vocabulary: Readonly<Record<string, T>>, value: unknown): T {
  return Object.values(vocabulary).find((member) => member === value) ?? refuse();
}

/** `text` cut to at most `maxBytes` of UTF-8, never inside a character. */
function cutUtf8(text: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength <= maxBytes) return text;
  let end = maxBytes;
  // Back off continuation bytes (10xxxxxx) so the cut lands on a character's first byte.
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return new TextDecoder().decode(bytes.subarray(0, end));
}

/** Overlong text is cut and named in `trimmed`; anything but a string refuses the record. */
function cutText(value: unknown, maxBytes: number, trimmed: Set<CrashTrimmed>, as: CrashTrimmed): string {
  if (typeof value !== "string") return refuse();
  const cut = cutUtf8(value, maxBytes);
  if (cut !== value) trimmed.add(as);
  return cut;
}

function location(value: unknown, trimmed: Set<CrashTrimmed>): CrashLocation {
  const raw = record(value);
  if (typeof raw.file !== "string") return refuse();
  if (raw.file.length > CRASH_PATH_MAX_CHARS) trimmed.add(CrashTrimmed.LocationFile);
  return { file: raw.file.slice(0, CRASH_PATH_MAX_CHARS), line: count(raw.line), column: count(raw.column) };
}

function frame(value: unknown, images: number): CrashFrame {
  const raw = record(value);
  if (raw.ip !== undefined) return { ip: hex(raw.ip) };
  const image = count(raw.image);
  if (image >= images) refuse();
  return { image, offset: hex(raw.offset) };
}

function frames(value: unknown, images: number, trimmed: Set<CrashTrimmed>): CrashFrame[] {
  if (!Array.isArray(value)) return refuse();
  if (value.length > CRASH_FRAMES_MAX) trimmed.add(CrashTrimmed.Frames);
  return value.slice(0, CRASH_FRAMES_MAX).map((item) => frame(item, images));
}

function images(value: unknown): CrashImage[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > CRASH_IMAGES_MAX) return refuse();
  return value.map((item) => {
    const raw = record(item);
    const id = typeof raw.id === "string" && IMAGE_ID.test(raw.id) ? raw.id : refuse();
    return { name: shortText(raw.name, NAME_TEXT_MAX_CHARS), id };
  });
}

function gpu(value: unknown, trimmed: Set<CrashTrimmed>): CrashGpu {
  const raw = record(value);
  return {
    class: nullable(raw.class, (item) => word(GpuErrorClass, item)),
    reason: nullable(raw.reason, (item) => shortText(item, NAME_TEXT_MAX_CHARS)),
    description: cutText(raw.description, CRASH_MESSAGE_MAX_BYTES, trimmed, CrashTrimmed.Message),
    backend: nullable(raw.backend, (item) => shortText(item)),
    adapter: nullable(raw.adapter, (item) => shortText(item, NAME_TEXT_MAX_CHARS)),
  };
}

function wasm(value: unknown): CrashWasm {
  const raw = record(value);
  if (!Array.isArray(raw.stack) || raw.stack.length > CRASH_FRAMES_MAX) return refuse();
  return {
    trap: word(WasmTrap, raw.trap),
    stack: raw.stack.map((item) => {
      const step = record(item);
      return { func: count(step.func), offset: count(step.offset) };
    }),
  };
}

function context(value: unknown): CrashContext {
  if (value === undefined || value === null) return {};
  const raw = record(value);
  const seed = optional(raw.seed, count);
  if (seed !== undefined && seed > U32_MAX) refuse();
  const simulatedMs = optional(raw.simulatedMs, (item) =>
    typeof item === "number" && Number.isFinite(item) && item >= 0 ? item : refuse(),
  );
  const fields: CrashContext = {
    seed,
    tick: optional(raw.tick, count),
    frame: optional(raw.frame, count),
    simulatedMs,
    running: optional(raw.running, flag),
    destination: optional(raw.destination, (item) => shortText(item)),
    flavour: optional(raw.flavour, (item) => word(CrashFlavour, item)),
    build: optional(raw.build, (item) => shortText(item)),
    contract: optional(raw.contract, count),
    genex: optional(raw.genex, (item) => shortText(item)),
  };
  return Object.fromEntries(Object.entries(fields).filter(([, field]) => field !== undefined));
}

function replay(value: unknown, trimmed: Set<CrashTrimmed>): CrashReplay {
  const raw = record(value);
  const track = typeof raw.track === "string" && BASE64.test(raw.track) ? raw.track : refuse();
  const fromTick = count(raw.fromTick);
  const toTick = count(raw.toTick);
  if (fromTick > toTick) refuse();
  const fits = track.length <= REPLAY_TRACK_MAX_CHARS;
  if (!fits) trimmed.add(CrashTrimmed.ReplayTrack);
  return {
    seed: count(raw.seed),
    fromTick,
    toTick,
    complete: fits && flag(raw.complete),
    track: fits ? track : "",
  };
}

/** The record's profile summary; one outside its shape is dropped (named in `trimmed`), never the record. */
function profile(value: unknown, trimmed: Set<CrashTrimmed>): ProfileSummaryV1 | null {
  if (value === undefined || value === null) return null;
  const summary = parseProfileSummary(value);
  if (!summary) trimmed.add(CrashTrimmed.Profile);
  return summary;
}

function hitches(value: unknown): number[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return refuse();
  return value.slice(0, CRASH_HITCHES_MAX).map(count);
}

function recordOf(raw: Record<string, unknown>): CrashRecordV1 {
  if (raw.format !== CRASH_RECORD_FORMAT) refuse();
  const trimmed = new Set<CrashTrimmed>();
  // What the writer already gave up; a name this host does not know is dropped, never the record.
  const given: unknown[] = Array.isArray(raw.trimmed) ? raw.trimmed : [];
  for (const name of Object.values(CrashTrimmed)) if (given.includes(name)) trimmed.add(name);
  const imageList = images(raw.images);
  return {
    format: CRASH_RECORD_FORMAT,
    kind: word(CrashKind, raw.kind),
    source: word(CrashSource, raw.source),
    fatal: flag(raw.fatal),
    handled: flag(raw.handled),
    message: cutText(raw.message, CRASH_MESSAGE_MAX_BYTES, trimmed, CrashTrimmed.Message),
    location: nullable(raw.location, (item) => location(item, trimmed)),
    thread: nullable(raw.thread, (item) => {
      const thread = record(item);
      return { name: shortText(thread.name), main: flag(thread.main) };
    }),
    frames: frames(raw.frames ?? [], imageList.length, trimmed),
    anchor: nullable(raw.anchor, (item) => hex(record(item).ip)),
    images: imageList,
    gpu: nullable(raw.gpu, (item) => gpu(item, trimmed)),
    wasm: nullable(raw.wasm, wasm),
    context: context(raw.context),
    replay: nullable(raw.replay, (item) => replay(item, trimmed)),
    profile: profile(raw.profile, trimmed),
    hitches: hitches(raw.hitches),
    symbols: null,
    trimmed: Object.values(CrashTrimmed).filter((item) => trimmed.has(item)),
  };
}

/**
 * An untrusted `genex-crash/1` record, copied with only its known fields; null for one over
 * {@link CRASH_RECORD_MAX_BYTES} or {@link CRASH_JSON_DEPTH_MAX}, of another format, with a kind,
 * source or class outside its vocabulary, a non-boolean `fatal` or `handled`, an address that is
 * not hex, or a negative or fractional count. Overlong text and frames are cut, never refused.
 */
export function parseCrashRecord(value: unknown): CrashRecordV1 | null {
  try {
    if (!isRecord(value) || !jsonWithin(value, CRASH_RECORD_MAX_BYTES, CRASH_JSON_DEPTH_MAX)) return null;
    return recordOf(value);
  } catch (error) {
    if (error instanceof CrashRefused) return null;
    throw error;
  }
}

/** Whether a record is one a game's own process may send (its panic hook's kinds, written as the game). */
export function isGameMadeRecord(crash: CrashRecordV1): boolean {
  return crash.source === CrashSource.Game && GAME_CRASH_KINDS.includes(crash.kind);
}

/**
 * A `game_crashed` event's payload, or null for any other event. Its fields were written by the
 * host, but old or partial logs read as they are: a kind outside the vocabulary reads as absent.
 */
export function gameCrashedOf(event: EventEnvelope): GameCrashedPayload | null {
  const payload = customEvent(event, CustomEvent.GameCrashed);
  if (!payload) return null;
  const { kind, ...rest } = payload;
  const known = Object.values(CrashKind).find((member) => member === kind);
  return known === undefined ? rest : { ...rest, kind: known };
}
