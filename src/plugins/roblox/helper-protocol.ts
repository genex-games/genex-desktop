/**
 * What the Genex helper inside Roblox Studio and the plugin's backend say to each other over the
 * helper link (`helper-socket.ts`, `helper-link.ts`): one JSON object per WebSocket text frame.
 *
 * - Every message carries the protocol version `v`, an `id` and a `type`. A side's ids only grow:
 *   an id at or below one already seen is refused, so a message can't be replayed.
 * - The helper sends events (`hello`, `scripts.changed`, `activity`, `team`, `data.chunk`) and
 *   answers; the backend sends requests and reads each answer by the request it names (`re`).
 *   `activity` and `team` are also requests: an event from a connection not yet bound to a game is
 *   dropped, so the backend asks for the present state when it needs it.
 * - Every field is checked here, once: a message with an unknown type, a missing or extra field, a
 *   value of the wrong shape, an answer to nothing asked, or a place part that could leave the
 *   game's `.genex/place/` folder is refused before anything acts on it.
 * - A script is named the way Studio holds it: the instance names from its service down, its class
 *   and, for a Script, its run context ({@link ScriptRef}). Which file under `src/` that is, is the
 *   backend's own mapping; the helper never names a file.
 * - Place parts and models travel as `data.chunk`s of base64, {@link CHUNK_BYTES} raw bytes each,
 *   whose `transfer` is the id of the request they belong to. Both sides hash bytes with
 *   {@link helperHash}, FNV-1a over 32 bits, which the helper computes in Luau.
 *
 * The helper (`src/plugins/roblox/helper/*.luau`) is built with these values: its `constants`
 * module is generated from this file, so the two sides can't disagree on a port or a name.
 */

/** The protocol both sides speak; the helper built from the same tree sends it as `v`. */
export const HELPER_PROTOCOL = 1;
/**
 * The localhost ports the backend listens on, the first free one taken; the helper tries them in
 * the same order. Studio allows a plugin a few stream connections, so the range stays short.
 */
export const HELPER_PORTS = [47_301, 47_302, 47_303, 47_304] as const;
/** The largest message either side sends, as UTF-8 bytes. */
export const MAX_HELPER_FRAME_BYTES = 4 * 1024 * 1024;
/** The largest script source the link carries, as UTF-8 bytes. */
export const MAX_SCRIPT_SOURCE_BYTES = 1024 * 1024;
/** The non-archivable StringValue in CoreGui through which the helper proves which Studio it is in. */
export const SESSION_MARKER = "GenexHelperSession";
/** The longest part path, and its longest segment. */
const MAX_PATH_CHARS = 1024;
const MAX_SEGMENT_CHARS = 255;
/** The most instance names from a script's service down to the script. */
const MAX_SCRIPT_DEPTH = 64;
/** The longest instance name the link carries (Studio's own names are far shorter). */
const MAX_INSTANCE_NAME_CHARS = 1_000;
/** The most scripts one list or read carries. */
const MAX_SCRIPTS = 10_000;
/** The most parts a place export has. */
export const MAX_PLACE_PARTS = 2_000;
/** A chunk's base64 text at most, and the most chunks one part has. */
export const MAX_CHUNK_CHARS = 2 * 1024 * 1024;
export const MAX_CHUNKS = 1_024;
/** The raw bytes in one chunk: base64 makes them {@link MAX_CHUNK_CHARS} characters. */
export const CHUNK_BYTES = (MAX_CHUNK_CHARS / 4) * 3;
/**
 * The largest place part the helper writes as one file. A container whose children serialize past
 * it is split into one part per child. It stays below the host's 50 MB checkpoint file cap, which
 * leaves a larger file out of a save point and says so.
 */
export const PLACE_PART_MAX_BYTES = 40 * 1024 * 1024;
/** The services whose scripts the helper lists and watches; a script's path starts with one. */
export const SCRIPT_SERVICES = [
  "Workspace",
  "ReplicatedFirst",
  "ReplicatedStorage",
  "ServerScriptService",
  "ServerStorage",
  "StarterGui",
  "StarterPack",
  "StarterPlayer",
] as const;
/** The services a place export saves, each as one or more parts. */
export const PLACE_SERVICES = [
  "Workspace",
  "Lighting",
  "MaterialService",
  "ReplicatedFirst",
  "ReplicatedStorage",
  "ServerScriptService",
  "ServerStorage",
  "StarterGui",
  "StarterPack",
  "StarterPlayer",
  "Teams",
  "SoundService",
  "TextChatService",
] as const;
/** The place part that holds the services' own saved properties. */
export const SERVICES_PART = "services.json";
/** The place part that holds the terrain's voxels. */
export const TERRAIN_PART = "terrain.rbxm";
/** The part name a model's mesh travels under, and the mesh format's first four bytes. */
export const MODEL_PART = "mesh.bin";
export const MODEL_MAGIC = "GXM1";
/** The most other people a Team Create note names, and the longest name. */
const MAX_OTHERS = 50;
const MAX_NAME_CHARS = 200;
/** The most elements a GUI layout reports. */
const MAX_GUI_ELEMENTS = 5_000;
/** The largest coordinate a GUI layout may report, in pixels. */
const MAX_COORDINATE = 1_000_000;
const MAX_ERROR_CHARS = 2_000;
const MAX_HASH_CHARS = 128;
const MAX_ID = 2 ** 31 - 1;
/** The most players a multiplayer test starts (Studio's own limit is higher; Genex plays eight). */
const MAX_PLAYERS = 8;
/** A published place's id as Studio reports it: decimal digits, 0 for a place never published. */
const PLACE_ID = /^(0|[1-9]\d{0,19})$/;
/** Text a person reads: no control characters. */
const CONTROL = /[\u0000-\u001f\u007f]/;
/** What a path segment may not hold: separators, a drive or stream colon, control characters. */
const UNSAFE_IN_PATH = /[\\:\u0000-\u001f\u007f]/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const HASH = /^[\x21-\x7e]+$/;
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/**
 * The hash both sides give bytes: FNV-1a over 32 bits, as eight lowercase hex digits. A string is
 * hashed as its UTF-8 bytes. It names content for echo checks and transfers; it is no defence.
 */
export function helperHash(data: Uint8Array | string): string {
  const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  let hash = FNV_OFFSET;
  for (const byte of bytes) hash = Math.imul(hash ^ byte, FNV_PRIME) >>> 0;
  return hash.toString(16).padStart(8, "0");
}

/** Every message type on the link. Wire values: never rename. */
export const HelperMessage = {
  Hello: "hello",
  Answer: "answer",
  SessionMark: "session.mark",
  ScriptsList: "scripts.list",
  ScriptsRead: "scripts.read",
  ScriptsWrite: "scripts.write",
  ScriptsRemove: "scripts.remove",
  ScriptsChanged: "scripts.changed",
  PlaceExport: "place.export",
  PlaceLoad: "place.load",
  DataChunk: "data.chunk",
  PlayMultiplayer: "play.multiplayer",
  PlayPause: "play.pause",
  PlayEnd: "play.end",
  Activity: "activity",
  Team: "team",
  DeviceSet: "device.set",
  GuiLayout: "gui.layout",
  ModelImport: "model.import",
} as const;
export type HelperMessage = (typeof HelperMessage)[keyof typeof HelperMessage];

/** Why a message from the helper was refused. Wire values: never rename. */
export const HelperRefusal = {
  /** Not one JSON object. */
  Malformed: "malformed",
  /** Larger than a frame, or a script source past its cap. */
  Oversize: "oversize",
  /** Another protocol version. */
  Version: "version",
  /** A type the helper doesn't send. */
  UnknownType: "unknown-type",
  BadId: "bad-id",
  /** An id at or below one already seen. */
  RepeatedId: "repeated-id",
  /** An answer or a chunk for a request the backend isn't waiting on. */
  UnknownAnswer: "unknown-answer",
  /** A field missing, extra or of the wrong shape. */
  BadField: "bad-field",
  /** A script or part path that isn't a plain path under its folder. */
  BadPath: "bad-path",
} as const;
export type HelperRefusal = (typeof HelperRefusal)[keyof typeof HelperRefusal];

/** Why the helper couldn't do what it was asked. Wire values: never rename. */
export const HelperErrorCode = {
  /** This Studio has no API for it. */
  Unsupported: "unsupported",
  /** The helper refuses it (a rule of its own, such as a script Script Sync owns). */
  Refused: "refused",
  /** Studio is busy with something that can't be interrupted. */
  Busy: "busy",
  /** The script isn't what the request expected: someone changed it in Studio since. */
  Conflict: "conflict",
  Failed: "failed",
} as const;
export type HelperErrorCode = (typeof HelperErrorCode)[keyof typeof HelperErrorCode];

/** The script classes the helper keeps in step. Wire values: never rename. */
export const ScriptClass = {
  Script: "Script",
  LocalScript: "LocalScript",
  ModuleScript: "ModuleScript",
} as const;
export type ScriptClass = (typeof ScriptClass)[keyof typeof ScriptClass];

/** A Script's run context, by its Studio name. Wire values: never rename. */
export const RunContext = {
  Legacy: "Legacy",
  Server: "Server",
  Client: "Client",
  Plugin: "Plugin",
} as const;
export type RunContext = (typeof RunContext)[keyof typeof RunContext];

/**
 * A script as Studio holds it: the instance names from its service (one of
 * {@link SCRIPT_SERVICES}) down to the script, its class and, for a Script, its run context.
 */
export interface ScriptRef {
  path: string[];
  class: ScriptClass;
  runContext?: RunContext;
}

/** A listed script: its source's hash, and whether Studio's Script Sync keeps it in a file of its own. */
export type ScriptEntry = ScriptRef & { hash: string; synced: boolean };

/** A place export's part: a path under `.genex/place/`, its hash and size. */
export interface PlacePart {
  name: string;
  hash: string;
  bytes: number;
}

/** A part the backend already holds, by its name and hash. */
export interface KnownPart {
  name: string;
  hash: string;
}

/** A GUI element's box on the device screen, for the phone judge. */
export interface GuiElement {
  path: string;
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
}

/** What each backend request carries to the helper. */
export interface HelperRequestBodies {
  [HelperMessage.SessionMark]: { session: string };
  [HelperMessage.ScriptsList]: Record<string, never>;
  [HelperMessage.ScriptsRead]: { scripts: ScriptRef[] };
  /** `base`, when given, is the hash Studio's source must still have: otherwise a `conflict`. */
  [HelperMessage.ScriptsWrite]: { script: ScriptRef; source: string; base?: string };
  /** Removed only while Studio's source still has `hash`: otherwise a `conflict`. */
  [HelperMessage.ScriptsRemove]: { script: ScriptRef; hash: string };
  /**
   * `known` is what the backend holds; the helper sends each part whose bytes differ from it, or
   * every part when `full`.
   */
  [HelperMessage.PlaceExport]: { full: boolean; known: KnownPart[] };
  /** The parts were sent before as `data.chunk`s of this request's transfer. */
  [HelperMessage.PlaceLoad]: { parts: PlacePart[] };
  [HelperMessage.PlayMultiplayer]: { players: number };
  [HelperMessage.PlayPause]: { paused: boolean };
  [HelperMessage.PlayEnd]: Record<string, never>;
  [HelperMessage.DeviceSet]: { device: string };
  [HelperMessage.GuiLayout]: Record<string, never>;
  /** Whether the person is working in Studio now (the helper also says so unasked). */
  [HelperMessage.Activity]: Record<string, never>;
  /** Who else is in a Team Create place now (the helper also says so unasked). */
  [HelperMessage.Team]: Record<string, never>;
  /** The model's checked file was sent before as `data.chunk`s of this request's transfer. */
  [HelperMessage.ModelImport]: { name: string; bytes: number };
}

/** A request the backend sends. */
export type HelperRequest = keyof HelperRequestBodies;

/** What the helper answers to each request. */
export interface HelperResults {
  [HelperMessage.SessionMark]: Record<string, never>;
  [HelperMessage.ScriptsList]: { scripts: ScriptEntry[] };
  [HelperMessage.ScriptsRead]: { scripts: Array<ScriptRef & { source: string }> };
  [HelperMessage.ScriptsWrite]: { hash: string };
  [HelperMessage.ScriptsRemove]: { removed: boolean };
  /**
   * Every part of the place now; those named in `sent` arrived as `data.chunk`s of this request's
   * id before the answer, the rest are as the backend knows them. `ms` is how long Studio took.
   */
  [HelperMessage.PlaceExport]: { parts: PlacePart[]; sent: string[]; ms: number };
  [HelperMessage.PlaceLoad]: { loaded: number };
  [HelperMessage.PlayMultiplayer]: { players: number };
  [HelperMessage.PlayPause]: { paused: boolean };
  [HelperMessage.PlayEnd]: Record<string, never>;
  [HelperMessage.DeviceSet]: { device: string };
  [HelperMessage.GuiLayout]: { elements: GuiElement[] };
  [HelperMessage.Activity]: { editing: boolean };
  [HelperMessage.Team]: { others: string[] };
  [HelperMessage.ModelImport]: { instance: string };
}

/** The helper's first message: its own version and the place it has open. */
export interface HelloBody {
  helper: number;
  place: { id: string; name: string };
}

/** A script Studio changed: its new source, or null when it was removed. */
export type ScriptChange = ScriptRef & { source: string | null };

/** A piece of one part of a transfer: the request's id, the part, and its place among the part's chunks. */
export interface DataChunk {
  transfer: number;
  part: string;
  index: number;
  count: number;
  data: string;
}

/** What each helper event carries. */
export interface HelperEventBodies {
  [HelperMessage.Hello]: HelloBody;
  [HelperMessage.ScriptsChanged]: ScriptChange;
  /** Whether the person is editing in Studio now. */
  [HelperMessage.Activity]: { editing: boolean };
  /** The other people in a Team Create place. */
  [HelperMessage.Team]: { others: string[] };
  [HelperMessage.DataChunk]: DataChunk;
}

/** An event the helper sends unasked. */
export type HelperEventType = keyof HelperEventBodies;

/** One helper event, its body typed by its type. */
export type HelperEvent = { [T in HelperEventType]: { type: T; body: HelperEventBodies[T] } }[HelperEventType];

/** A helper's answer to a backend request: the result typed by the request, or the helper's error. */
export type HelperAnswer =
  | { [T in HelperRequest]: { ok: true; type: T; result: HelperResults[T] } }[HelperRequest]
  | { ok: false; error: { code: HelperErrorCode; message: string } };

/** A message from the helper that passed every check. */
export type HelperInbound =
  | { kind: "event"; id: number; event: HelperEvent }
  | { kind: "answer"; id: number; re: number; answer: HelperAnswer };

/** A message read: what it is, or why it was refused. */
export type HelperRead = { ok: true; message: HelperInbound } | { ok: false; refusal: HelperRefusal };

/** The request types the backend is waiting on, by request id. */
export type PendingType = (id: number) => HelperRequest | undefined;

/** Thrown inside a check and caught by the reader: the message is refused for `code`. */
class Refused extends Error {
  code: HelperRefusal;
  constructor(code: HelperRefusal) {
    super(code);
    this.code = code;
  }
}

const refuse = (code: HelperRefusal = HelperRefusal.BadField): never => {
  throw new Refused(code);
};

type Check<T> = (value: unknown) => T;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** An object with exactly these fields (the optional ones may be left out), each checked. */
function record<T>(shape: { [K in keyof T]: Check<T[K]> }, optional: ReadonlyArray<keyof T> = []): Check<T> {
  const keys = Object.keys(shape) as Array<keyof T & string>;
  return (value) => {
    if (!isObject(value)) return refuse();
    if (Object.keys(value).some((key) => !keys.includes(key as keyof T & string))) return refuse();
    const out = {} as T;
    for (const key of keys) {
      if (!(key in value)) {
        if (!optional.includes(key)) refuse();
        continue;
      }
      out[key] = shape[key](value[key]);
    }
    return out;
  };
}

const empty: Check<Record<string, never>> = record<Record<string, never>>({});

const int =
  (min: number, max: number): Check<number> =>
  (value) =>
    Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max ? (value as number) : refuse();

const coordinate: Check<number> = (value) =>
  typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= MAX_COORDINATE ? value : refuse();

const bool: Check<boolean> = (value) => (typeof value === "boolean" ? value : refuse());

/** Plain text a person reads: one line, at most `max` characters. */
const text =
  (max: number): Check<string> =>
  (value) =>
    typeof value === "string" && value.length <= max && !CONTROL.test(value) ? value : refuse();

const hash: Check<string> = (value) =>
  typeof value === "string" && value.length <= MAX_HASH_CHARS && HASH.test(value) ? value : refuse();

const placeId: Check<string> = (value) => (typeof value === "string" && PLACE_ID.test(value) ? value : refuse());

const oneOf =
  <T extends string>(values: readonly T[]): Check<T> =>
  (value) =>
    values.includes(value as T) ? (value as T) : refuse();

const list =
  <T>(item: Check<T>, max: number): Check<T[]> =>
  (value) =>
    Array.isArray(value) && value.length <= max ? value.map((entry) => item(entry)) : refuse();

/** A script's source within the cap; any characters, since code may hold any. */
const source: Check<string> = (value) => {
  if (typeof value !== "string") return refuse();
  return Buffer.byteLength(value, "utf8") <= MAX_SCRIPT_SOURCE_BYTES ? value : refuse(HelperRefusal.Oversize);
};

const base64: Check<string> = (value) =>
  typeof value === "string" && value.length <= MAX_CHUNK_CHARS && value.length % 4 === 0 && BASE64.test(value)
    ? value
    : refuse();

/**
 * Whether `value` is a plain relative path ending in one of `endings`: `/`-separated, no empty,
 * `.` or `..` segment, no leading slash, backslash, colon or control character, within the caps.
 * It says nothing about links on disk: the link resolves it under its folder before any write.
 */
function plainPath(value: unknown, endings: readonly string[]): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_PATH_CHARS) return false;
  if (value.startsWith("/") || UNSAFE_IN_PATH.test(value)) return false;
  const segments = value.split("/");
  const plain = segments.every(
    (segment) => segment !== "" && segment !== "." && segment !== ".." && segment.length <= MAX_SEGMENT_CHARS,
  );
  return plain && endings.some((ending) => value.endsWith(ending) && value.length > ending.length);
}

/** The file endings of a script under `src/`. */
const SCRIPT_ENDINGS = [".luau"] as const;
/** The file endings of a place export's part under `.genex/place/`. */
const PART_ENDINGS = [".rbxm", ".json"] as const;

/** Whether `value` is a plain `.luau` path under a game's `src/`, as the backend names a script's file. */
export const isScriptPath = (value: unknown): value is string => plainPath(value, SCRIPT_ENDINGS);

/** Whether `value` is a place part's path under `.genex/place/`. */
export const isPartPath = (value: unknown): value is string => plainPath(value, PART_ENDINGS);

const partPath: Check<string> = (value) => (isPartPath(value) ? value : refuse(HelperRefusal.BadPath));

const placePart = record<PlacePart>({ name: partPath, hash, bytes: int(0, Number.MAX_SAFE_INTEGER) });

/** An instance name: any text but NUL, within the cap. The backend escapes it into a file name. */
const instanceName: Check<string> = (value) =>
  typeof value === "string" && value.length > 0 && value.length <= MAX_INSTANCE_NAME_CHARS && !value.includes("\u0000")
    ? value
    : refuse(HelperRefusal.BadPath);

/** A script's instance path: a service the helper watches, then the names down to the script. */
const scriptPath: Check<string[]> = (value) => {
  if (!Array.isArray(value) || value.length < 2 || value.length > MAX_SCRIPT_DEPTH)
    return refuse(HelperRefusal.BadPath);
  const names = value.map((name) => instanceName(name));
  return (SCRIPT_SERVICES as readonly string[]).includes(names[0] ?? "") ? names : refuse(HelperRefusal.BadPath);
};

const SCRIPT_REF_SHAPE = {
  path: scriptPath,
  class: oneOf(Object.values(ScriptClass)),
  runContext: oneOf(Object.values(RunContext)),
};

/** A script reference with these extra fields; only a Script carries a run context. */
function scriptRecord<T extends ScriptRef>(extra: { [K in Exclude<keyof T, keyof ScriptRef>]: Check<T[K]> }): Check<T> {
  const check = record<T>({ ...SCRIPT_REF_SHAPE, ...extra } as { [K in keyof T]: Check<T[K]> }, ["runContext"]);
  return (value) => {
    const ref = check(value);
    const context = "runContext" in ref;
    return context === (ref.class === ScriptClass.Script) ? ref : refuse();
  };
}

const guiElement = record<GuiElement>({
  path: text(MAX_PATH_CHARS),
  x: coordinate,
  y: coordinate,
  width: coordinate,
  height: coordinate,
  visible: bool,
});

/** How each answer's result is checked, by the request it answers. */
const RESULTS: { [T in HelperRequest]: Check<HelperResults[T]> } = {
  [HelperMessage.SessionMark]: empty,
  [HelperMessage.ScriptsList]: record({
    scripts: list(scriptRecord<ScriptEntry>({ hash, synced: bool }), MAX_SCRIPTS),
  }),
  [HelperMessage.ScriptsRead]: record({
    scripts: list(scriptRecord<ScriptRef & { source: string }>({ source }), MAX_SCRIPTS),
  }),
  [HelperMessage.ScriptsWrite]: record({ hash }),
  [HelperMessage.ScriptsRemove]: record({ removed: bool }),
  [HelperMessage.PlaceExport]: record({
    parts: list(placePart, MAX_PLACE_PARTS),
    sent: list(partPath, MAX_PLACE_PARTS),
    ms: int(0, MAX_ID),
  }),
  [HelperMessage.PlaceLoad]: record({ loaded: int(0, MAX_PLACE_PARTS) }),
  [HelperMessage.PlayMultiplayer]: record({ players: int(1, MAX_PLAYERS) }),
  [HelperMessage.PlayPause]: record({ paused: bool }),
  [HelperMessage.PlayEnd]: empty,
  [HelperMessage.DeviceSet]: record({ device: text(MAX_NAME_CHARS) }),
  [HelperMessage.GuiLayout]: record({ elements: list(guiElement, MAX_GUI_ELEMENTS) }),
  [HelperMessage.Activity]: record({ editing: bool }),
  [HelperMessage.Team]: record({ others: list(text(MAX_NAME_CHARS), MAX_OTHERS) }),
  [HelperMessage.ModelImport]: record({ instance: text(MAX_PATH_CHARS) }),
};

/** How each event's body is checked. */
const EVENTS: { [T in HelperEventType]: Check<HelperEventBodies[T]> } = {
  [HelperMessage.Hello]: record<HelloBody>({
    helper: int(1, MAX_ID),
    place: record<HelloBody["place"]>({ id: placeId, name: text(MAX_NAME_CHARS) }),
  }),
  [HelperMessage.ScriptsChanged]: scriptRecord<ScriptChange>({
    source: (value) => (value === null ? null : source(value)),
  }),
  [HelperMessage.Activity]: record({ editing: bool }),
  [HelperMessage.Team]: record({ others: list(text(MAX_NAME_CHARS), MAX_OTHERS) }),
  [HelperMessage.DataChunk]: record<DataChunk>({
    transfer: int(1, MAX_ID),
    part: partPath,
    index: int(0, MAX_CHUNKS - 1),
    count: int(1, MAX_CHUNKS),
    data: base64,
  }),
};

const isEventType = (type: unknown): type is HelperEventType => typeof type === "string" && type in EVENTS;

const helperError = record<{ code: HelperErrorCode; message: string }>({
  code: oneOf(Object.values(HelperErrorCode)),
  message: text(MAX_ERROR_CHARS),
});

const ENVELOPE_KEYS = ["v", "id", "type", "body"] as const;
const ANSWER_KEYS = ["v", "id", "type", "re", "ok"] as const;

const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) => {
  const names = Object.keys(value);
  return names.length === keys.length && names.every((name) => keys.includes(name));
};

/** An answer, checked against the request it names. */
function readAnswer(value: Record<string, unknown>, id: number, pending: PendingType): HelperInbound {
  const re = int(1, MAX_ID)(value.re);
  const type = pending(re);
  if (!type) return refuse(HelperRefusal.UnknownAnswer);
  if (value.ok === true && exactKeys(value, [...ANSWER_KEYS, "result"])) {
    const result = RESULTS[type](value.result);
    return { kind: "answer", id, re, answer: { ok: true, type, result } as HelperAnswer };
  }
  if (value.ok === false && exactKeys(value, [...ANSWER_KEYS, "error"]))
    return { kind: "answer", id, re, answer: { ok: false, error: helperError(value.error) } };
  return refuse();
}

/** An event, its body checked by its type; a chunk must belong to an export the backend asked for. */
function readEvent(value: Record<string, unknown>, id: number, pending: PendingType): HelperInbound {
  if (!isEventType(value.type)) return refuse(HelperRefusal.UnknownType);
  if (!exactKeys(value, ENVELOPE_KEYS)) return refuse();
  const type = value.type;
  const body = EVENTS[type](value.body);
  const chunk = type === HelperMessage.DataChunk ? (body as DataChunk) : undefined;
  if (chunk && (pending(chunk.transfer) !== HelperMessage.PlaceExport || chunk.index >= chunk.count))
    return refuse(HelperRefusal.UnknownAnswer);
  return { kind: "event", id, event: { type, body } as HelperEvent };
}

/** The envelope's id: a whole number above every id this connection's helper used before. */
function freshId(value: unknown, last: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > MAX_ID)
    return refuse(HelperRefusal.BadId);
  return (value as number) > last ? (value as number) : refuse(HelperRefusal.RepeatedId);
}

function parseObject(text: string): Record<string, unknown> {
  if (Buffer.byteLength(text, "utf8") > MAX_HELPER_FRAME_BYTES) return refuse(HelperRefusal.Oversize);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return refuse(HelperRefusal.Malformed);
  }
  return isObject(value) ? value : refuse(HelperRefusal.Malformed);
}

/** One connection's reader of the helper's messages; it remembers the last id it saw. */
export interface HelperInbox {
  /** The message `text` holds, checked, or why it was refused. `pending` names the open requests. */
  read(text: string, pending: PendingType): HelperRead;
}

/** A fresh reader for one connection. */
export function createHelperInbox(): HelperInbox {
  let last = 0;
  return {
    read(text, pending) {
      try {
        const value = parseObject(text);
        if (value.v !== HELPER_PROTOCOL) return refuse(HelperRefusal.Version);
        const id = freshId(value.id, last);
        // A well-formed fresh id is used up even when the rest is refused: it can't be sent again.
        last = id;
        const message =
          value.type === HelperMessage.Answer ? readAnswer(value, id, pending) : readEvent(value, id, pending);
        return { ok: true, message };
      } catch (error) {
        if (error instanceof Refused) return { ok: false, refusal: error.code };
        throw error;
      }
    },
  };
}

/** A backend request as its frame's text. */
export function requestFrame<T extends HelperRequest>(id: number, type: T, body: HelperRequestBodies[T]): string {
  return JSON.stringify({ v: HELPER_PROTOCOL, id, type, body });
}

/** A data chunk the backend sends ahead of one of its own requests (a place load or a model import). */
export function chunkFrame(id: number, chunk: DataChunk): string {
  return JSON.stringify({ v: HELPER_PROTOCOL, id, type: HelperMessage.DataChunk, body: chunk });
}
