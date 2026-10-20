/**
 * A Report of what a game's AI wrote (owner decision D9): one AI-native replay bundle, the same for
 * a player's Report and for the automatic bundle of a reply that failed the game's shape even after
 * its repair. It goes to genex.games moderation, to the game's creator as a "Player report" their
 * agent can replay with `ai.replay` and fix, and into the counts-only fit-from-play rows.
 *
 * It carries every AI call of the session up to the reported moment, the tape and input log a
 * deterministic replay needs, state digests, the game's `state().ai`, console errors, one frame
 * and the model check's row for the model. It never carries an account id; emails, phone numbers
 * and keys are redacted (`redactReportBundle`); an automatic bundle carries no player text unless
 * the player opted in (`withoutPlayerText`).
 *
 * A bundle arrives back in the creator's Studio from genex.games, so `readAiReportBundle` reads it
 * as hostile input under hard bounds. Browser-safe; pure.
 */
import {
  AiDoor,
  AiErrorCode,
  AiFunding,
  type AiGameKey,
  AiOp,
  AiProvenance,
  type AiUsage,
  AI_SITE_RE,
  type JsonBounds,
  isBoundedJson,
  isPlainRecord,
  readAiGameKey,
  readMember,
} from "./game-ai.ts";
import { AiCheckFit, type AiCheckRow, AiCostLevel } from "./game-ai-check.ts";
import { readTapeLine, type TapeLine } from "./game-ai-tape.ts";
import { redactContacts, redactDeep, redactSecrets } from "./redact.ts";

/** The wire version of a bundle. */
export const AI_REPORT_WIRE_VERSION = 1;
/** The most calls one bundle carries; the newest are kept. */
export const AI_REPORT_MAX_CALLS = 200;
/** The longest note a player adds. */
export const AI_REPORT_NOTE_MAX_CHARS = 500;
/** The most recorded inputs one bundle carries. */
export const AI_REPORT_MAX_INPUTS = 5_000;
/** The most state digests one bundle carries. */
export const AI_REPORT_MAX_DIGESTS = 64;
/** The most console errors one bundle carries, and the longest kept. */
export const AI_REPORT_MAX_CONSOLE = 50;
export const AI_REPORT_CONSOLE_MAX_CHARS = 500;
/** The largest frame one bundle carries, in base64 characters (about 768 KiB of JPEG). */
export const AI_REPORT_FRAME_MAX_CHARS = 1024 * 1024;
/** The bounds of a whole bundle as a reader takes it. */
export const AI_REPORT_BOUNDS: JsonBounds = { nodes: 400_000, depth: 40, chars: 24 * 1024 * 1024 };
/**
 * genex.games' ingest for a bundle: `POST` the bundle itself as the JSON body, with no account
 * (a Report needs no sign-in and carries none); it answers `{ id }` with the id it stored the
 * bundle under, 413 for a body over {@link AI_REPORT_MAX_BODY_CHARS}, and refuses a bundle its
 * reader refuses or one of a game it does not publish (a `create:` key).
 */
export const AI_REPORT_ROUTE = "/api/runtime/ai-reports";
/** The longest JSON body a bundle is sent as; Studio drops the oldest calls until it fits. */
export const AI_REPORT_MAX_BODY_CHARS = 20 * 1024 * 1024;

/** Why a player reports. Wire values: never rename one (the moderation queue reads them). */
export const AiReportReason = {
  Harmful: "harmful",
  Sexual: "sexual",
  Hateful: "hateful",
  Other: "other",
} as const;
export type AiReportReason = (typeof AiReportReason)[keyof typeof AiReportReason];

/** Who made the bundle. Wire values: never rename one. */
export const AiReportKind = {
  /** A player's Report. */
  Player: "player",
  /** Made by main for a reply that failed the game's shape after its repair. */
  Automatic: "automatic",
} as const;
export type AiReportKind = (typeof AiReportKind)[keyof typeof AiReportKind];

/** How a call's reply fared against the game's shape. Wire values: never rename one. */
export const AiValidation = {
  Valid: "valid",
  /** Valid after the one repair. */
  Repaired: "repaired",
  /** Still invalid after the repair: never charged (D7). */
  Invalid: "invalid",
  /** No reply text at all (refused, timed out, canceled). */
  NoReply: "no-reply",
} as const;
export type AiValidation = (typeof AiValidation)[keyof typeof AiValidation];

/** A frame's picture format. */
export const AiReportImage = { Jpeg: "image/jpeg", Png: "image/png" } as const;
export type AiReportImage = (typeof AiReportImage)[keyof typeof AiReportImage];

/** One AI call of the session. */
export interface AiReportCall {
  site: string;
  op: AiOp;
  /** The rendered system prompt, or null when it is the same as an earlier call's (`systemSha256` names it). */
  system: string | null;
  systemSha256: string | null;
  prompt: string;
  /** Player-typed fields; empty in an automatic bundle unless the player opted in. */
  untrusted: Record<string, string>;
  schema: unknown;
  rawOutput: string | null;
  value: unknown;
  validation: AiValidation;
  code: AiErrorCode | null;
  model: string | null;
  door: AiDoor;
  provenance: AiProvenance;
  usage: AiUsage | null;
  costMicros: number;
  latencyMs: number;
  /** The frame the call was made on, and the game's tick when it counts them. */
  frame: number | null;
  tick: number | null;
}

/** What a deterministic `ai.replay` needs. */
export interface AiReportReplay {
  seed: number | null;
  commit: string | null;
  engine: string;
  templateVersion: string | null;
  /** The recorded inputs, as the game's input log wrote them. */
  inputs: unknown[];
  tape: TapeLine[];
}

/** A digest of the game's state at a frame. */
export interface AiReportDigest {
  frame: number;
  digest: string;
}

/** One frame from Studio's own capture. */
export interface AiReportFrame {
  mime: AiReportImage;
  /** base64. */
  data: string;
}

/** The whole bundle. */
export interface AiReportBundle {
  v: typeof AI_REPORT_WIRE_VERSION;
  id: string;
  kind: AiReportKind;
  createdAt: string;
  game: { key: AiGameKey; title: string };
  /** Null for an automatic bundle. */
  reason: AiReportReason | null;
  note: string | null;
  calls: AiReportCall[];
  replay: AiReportReplay;
  digests: AiReportDigest[];
  /** The game's `state().ai`. */
  aiState: unknown;
  consoleErrors: string[];
  frame: AiReportFrame | null;
  modelCheck: AiCheckRow | null;
  /** Player-typed text is in it (a player's own Report, or an automatic one they opted in to). */
  playerText: boolean;
}

/** What a send came to. Wire values: never rename one. */
export const AiReportFailure = {
  Offline: "offline",
  Refused: "refused",
  TooLarge: "too-large",
} as const;
export type AiReportFailure = (typeof AiReportFailure)[keyof typeof AiReportFailure];

/** A Report's send. */
export type AiReportOutcome = { ok: true; id: string } | { ok: false; failure: AiReportFailure };

/** What a player sends with a Report. */
export interface AiReportRequest {
  game: AiGameKey;
  reason: AiReportReason;
  note: string | null;
}

// ── readers ────────────────────────────────────────────────────────────────────────────────

const ID_RE = /^[A-Za-z0-9_-]{8,100}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const TITLE_MAX_CHARS = 200;
const SHORT_MAX_CHARS = 150;

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const countOrNull = (value: unknown): number | null | undefined => {
  if (value === null) return null;
  return isCount(value) ? value : undefined;
};
const isText = (value: unknown, shape: RegExp): value is string => typeof value === "string" && shape.test(value);
const shortOrNull = (value: unknown): string | null | undefined => {
  if (value === null) return null;
  return typeof value === "string" && value.length > 0 && value.length <= SHORT_MAX_CHARS ? value : undefined;
};
const textOrNull = (value: unknown): string | null | undefined =>
  value === null || typeof value === "string" ? value : undefined;

/** Exactly these own keys. */
function exactly(raw: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (!isPlainRecord(raw)) return null;
  const own = Object.keys(raw);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(raw, key)) ? raw : null;
}

function readUsage(raw: unknown): AiUsage | null | undefined {
  if (raw === null) return null;
  const usage = exactly(raw, ["inputTokens", "outputTokens"]);
  if (!usage || !isCount(usage.inputTokens) || !isCount(usage.outputTokens)) return undefined;
  return { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens };
}

function readStrings(raw: unknown): Record<string, string> | null {
  if (!isPlainRecord(raw)) return null;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!AI_SITE_RE.test(key) || typeof value !== "string") return null;
    out[key] = value;
  }
  return out;
}

const CALL_KEYS = [
  "site",
  "op",
  "system",
  "systemSha256",
  "prompt",
  "untrusted",
  "schema",
  "rawOutput",
  "value",
  "validation",
  "code",
  "model",
  "door",
  "provenance",
  "usage",
  "costMicros",
  "latencyMs",
  "frame",
  "tick",
] as const satisfies readonly (keyof AiReportCall)[];

/** The fields of a call that are names from a vocabulary, or null when one is not. */
function callNames(raw: Record<string, unknown>) {
  const op = readMember(AiOp, raw.op);
  const validation = readMember(AiValidation, raw.validation);
  const door = readMember(AiDoor, raw.door);
  const provenance = readMember(AiProvenance, raw.provenance);
  const code = raw.code === null ? null : readMember(AiErrorCode, raw.code);
  if (!op || !validation || !door || !provenance || code === undefined) return null;
  if (raw.code !== null && code === null) return null;
  return { op, validation, door, provenance, code };
}

function readCall(raw: unknown): AiReportCall | null {
  const call = exactly(raw, CALL_KEYS);
  const names = call ? callNames(call) : null;
  if (!call || !names) return null;
  const { site, prompt, systemSha256, costMicros, latencyMs } = call;
  const system = textOrNull(call.system);
  const rawOutput = textOrNull(call.rawOutput);
  const model = shortOrNull(call.model);
  const usage = readUsage(call.usage);
  const frame = countOrNull(call.frame);
  const tick = countOrNull(call.tick);
  const untrusted = readStrings(call.untrusted);
  const known = [system, rawOutput, model, usage, frame, tick].every((field) => field !== undefined);
  if (!known || !untrusted || !isText(site, AI_SITE_RE) || typeof prompt !== "string") return null;
  if (systemSha256 !== null && !isText(systemSha256, SHA_RE)) return null;
  if (!isCount(costMicros) || !isCount(latencyMs)) return null;
  return {
    site,
    ...names,
    system: system ?? null,
    systemSha256,
    prompt,
    untrusted,
    schema: call.schema,
    rawOutput: rawOutput ?? null,
    value: call.value,
    model: model ?? null,
    usage: usage ?? null,
    costMicros,
    latencyMs,
    frame: frame ?? null,
    tick: tick ?? null,
  };
}

const REPLAY_KEYS = ["seed", "commit", "engine", "templateVersion", "inputs", "tape"] as const;

function readReplay(raw: unknown): AiReportReplay | null {
  const replay = exactly(raw, REPLAY_KEYS);
  if (!replay) return null;
  const seed = replay.seed === null || Number.isSafeInteger(replay.seed) ? replay.seed : undefined;
  const commit = shortOrNull(replay.commit);
  const templateVersion = shortOrNull(replay.templateVersion);
  const { engine, inputs, tape } = replay;
  if (typeof seed !== "number" && seed !== null) return null;
  if (commit === undefined || templateVersion === undefined || typeof engine !== "string" || !engine) return null;
  if (!Array.isArray(inputs) || inputs.length > AI_REPORT_MAX_INPUTS || !Array.isArray(tape)) return null;
  const lines = tape.map(readTapeLine);
  if (lines.some((line) => line === null)) return null;
  return { seed, commit, engine, templateVersion, inputs: [...inputs], tape: lines.filter((line) => line !== null) };
}

function readDigests(raw: unknown): AiReportDigest[] | null {
  if (!Array.isArray(raw) || raw.length > AI_REPORT_MAX_DIGESTS) return null;
  const digests: AiReportDigest[] = [];
  for (const item of raw) {
    const row = exactly(item, ["frame", "digest"]);
    if (!row || !isCount(row.frame) || typeof row.digest !== "string" || row.digest.length > SHORT_MAX_CHARS)
      return null;
    digests.push({ frame: row.frame, digest: row.digest });
  }
  return digests;
}

function readFrame(raw: unknown): AiReportFrame | null | undefined {
  if (raw === null) return null;
  const frame = exactly(raw, ["mime", "data"]);
  const mime = frame ? readMember(AiReportImage, frame.mime) : null;
  const data = frame?.data;
  if (!mime || typeof data !== "string" || data.length > AI_REPORT_FRAME_MAX_CHARS || !BASE64_RE.test(data))
    return undefined;
  return { mime, data };
}

function readConsole(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length > AI_REPORT_MAX_CONSOLE) return null;
  const ok = raw.every((line) => typeof line === "string" && line.length <= AI_REPORT_CONSOLE_MAX_CHARS);
  return ok ? raw.filter((line): line is string => typeof line === "string") : null;
}

const CHECK_KEYS = [
  "model",
  "label",
  "funding",
  "moments",
  "fitted",
  "fit",
  "cost",
  "medianLatencyMs",
  "note",
] as const;

function readCheckRow(raw: unknown): AiCheckRow | null | undefined {
  if (raw === null) return null;
  const row = exactly(raw, CHECK_KEYS);
  const ref = row ? exactly(row.model, ["door", "engine", "model"]) : null;
  if (!row || !ref) return undefined;
  const door = readMember(AiDoor, ref.door);
  const fit = readMember(AiCheckFit, row.fit);
  const cost = readMember(AiCostLevel, row.cost);
  const { engine, model } = ref;
  const funding = readMember(AiFunding, row.funding);
  const { label, moments, fitted } = row;
  const latency = countOrNull(row.medianLatencyMs);
  const note = shortOrNull(row.note);
  if (!door || !fit || !cost || typeof engine !== "string" || typeof model !== "string") return undefined;
  if (typeof label !== "string" || !funding || latency === undefined || note === undefined) return undefined;
  if (!isCount(moments) || !isCount(fitted) || fitted > moments) return undefined;
  return { model: { door, engine, model }, label, funding, moments, fitted, fit, cost, medianLatencyMs: latency, note };
}

const BUNDLE_KEYS = [
  "v",
  "id",
  "kind",
  "createdAt",
  "game",
  "reason",
  "note",
  "calls",
  "replay",
  "digests",
  "aiState",
  "consoleErrors",
  "frame",
  "modelCheck",
  "playerText",
] as const satisfies readonly (keyof AiReportBundle)[];

function readGame(raw: unknown): AiReportBundle["game"] | null {
  const game = exactly(raw, ["key", "title"]);
  const key = game ? readAiGameKey(game.key) : null;
  const title = game?.title;
  return key && typeof title === "string" && title.length <= TITLE_MAX_CHARS ? { key, title } : null;
}

/** A bundle's head: its version, id, kind, time, reason, note and whether player text is in it. */
type ReportHead = Pick<AiReportBundle, "v" | "id" | "kind" | "createdAt" | "reason" | "note" | "playerText">;

/** The bundle's head, or null. */
function readHead(bundle: Record<string, unknown>): ReportHead | null {
  const kind = readMember(AiReportKind, bundle.kind);
  const reason = bundle.reason === null ? null : readMember(AiReportReason, bundle.reason);
  const { v, id, createdAt, note, playerText } = bundle;
  if (v !== AI_REPORT_WIRE_VERSION || !kind || typeof playerText !== "boolean") return null;
  if (typeof id !== "string" || !ID_RE.test(id) || typeof createdAt !== "string" || !ISO_RE.test(createdAt))
    return null;
  if ((kind === AiReportKind.Player) !== (reason !== null) || (bundle.reason !== null && reason === null)) return null;
  if (note !== null && (typeof note !== "string" || note.length > AI_REPORT_NOTE_MAX_CHARS)) return null;
  return { v: AI_REPORT_WIRE_VERSION, id, kind, createdAt, reason, note, playerText };
}

/**
 * A bundle as Studio accepts it from genex.games, or null: the whole tree walked under
 * {@link AI_REPORT_BOUNDS} first, then every part rebuilt by its own reader. Never throws.
 */
export function readAiReportBundle(raw: unknown): AiReportBundle | null {
  if (!isBoundedJson(raw, AI_REPORT_BOUNDS)) return null;
  const bundle = exactly(raw, BUNDLE_KEYS);
  const head = bundle ? readHead(bundle) : null;
  if (!bundle || !head) return null;
  const game = readGame(bundle.game);
  const calls =
    Array.isArray(bundle.calls) && bundle.calls.length <= AI_REPORT_MAX_CALLS ? bundle.calls.map(readCall) : null;
  const replay = readReplay(bundle.replay);
  const digests = readDigests(bundle.digests);
  const consoleErrors = readConsole(bundle.consoleErrors);
  const frame = readFrame(bundle.frame);
  const modelCheck = readCheckRow(bundle.modelCheck);
  if (!game || !calls || calls.some((call) => call === null) || !replay || !digests || !consoleErrors) return null;
  if (frame === undefined || modelCheck === undefined) return null;
  return {
    ...head,
    game,
    calls: calls.filter((call) => call !== null),
    replay,
    digests,
    aiState: bundle.aiState,
    consoleErrors,
    frame,
    modelCheck,
  };
}

/** `text` without keys, tokens, emails or phone numbers. */
export const redactReportText = (text: string): string => redactContacts(redactSecrets(text));

/**
 * The bundle with every string redacted (keys, tokens, emails, phone numbers), the frame's picture
 * data excepted: what leaves this Mac and what "See what's sent" shows.
 */
export function redactReportBundle(bundle: AiReportBundle): AiReportBundle {
  const redacted = redactDeep({ ...bundle, frame: null }, redactReportText);
  return { ...redacted, frame: bundle.frame };
}

/** The bundle without what the player typed: their fields, their note and the recorded inputs. */
export function withoutPlayerText(bundle: AiReportBundle): AiReportBundle {
  return {
    ...bundle,
    note: null,
    playerText: false,
    calls: bundle.calls.map((call) => ({ ...call, untrusted: {} })),
    replay: { ...bundle.replay, inputs: [] },
  };
}

// ── the creator's inbox (D9: a "Player report" their agent can replay and fix) ──────────────

/** The most reports the inbox lists for one game; the newest are kept. */
export const AI_REPORT_INBOX_MAX = 50;
/** The most items a list from genex.games may hold before it is read at all. */
const INBOX_READ_MAX = 1_000;
/** How much of a report's id a saved playtest's name keeps, before its hash. */
const TAPE_ID_CHARS = 40;

/** One report of the creator's own published game, as Create's inbox lists it. */
export interface AiReportInboxItem {
  id: string;
  kind: AiReportKind;
  createdAt: string;
  /** Null for an automatic report. */
  reason: AiReportReason | null;
  note: string | null;
  /** The AI calls the bundle carries, and how many still failed the game's shape after their repair. */
  calls: number;
  invalid: number;
  /** The model that wrote the newest reply in it; null when none answered. */
  model: string | null;
  /** The saved playtest Fix with agent made of it (`TAPE_NAME_RE`); null until then. */
  tape: string | null;
}

/** What Fix with agent came to: the saved playtest the agent replays, or why there is none. */
export type AiReportFixOutcome = { ok: true; tape: string } | { ok: false; failure: AiReportFailure };

/** A report's id from the renderer or genex.games, or null. */
export const readAiReportId = (raw: unknown): string | null => (isText(raw, ID_RE) ? raw : null);

const MODEL_RE = /^[^\p{Cc}]{1,150}$/u;
const TAPE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ITEM_KEYS = [
  "id",
  "kind",
  "createdAt",
  "reason",
  "note",
  "calls",
  "invalid",
  "model",
  "tape",
] as const satisfies readonly (keyof AiReportInboxItem)[];

/** An inbox item as Studio accepts it from genex.games or main, or null. Never throws. */
export function readAiReportInboxItem(raw: unknown): AiReportInboxItem | null {
  const item = exactly(raw, ITEM_KEYS);
  const head = item ? readHead({ ...item, v: AI_REPORT_WIRE_VERSION, playerText: false }) : null;
  if (!item || !head) return null;
  const { calls, invalid, model, tape } = item;
  if (!isCount(calls) || !isCount(invalid) || invalid > calls) return null;
  if (model !== null && !isText(model, MODEL_RE)) return null;
  if (tape !== null && !isText(tape, TAPE_RE)) return null;
  const { id, kind, createdAt, reason, note } = head;
  return { id, kind, createdAt, reason, note, calls, invalid, model, tape };
}

/**
 * The inbox as genex.games or main lists it, newest first and at most {@link AI_REPORT_INBOX_MAX},
 * or null: one bad item, or two of the same id, refuses the whole list.
 */
export function readAiReportInbox(raw: unknown): AiReportInboxItem[] | null {
  if (!Array.isArray(raw) || raw.length > INBOX_READ_MAX) return null;
  const items: AiReportInboxItem[] = [];
  for (const entry of raw) {
    const item = readAiReportInboxItem(entry);
    if (!item || items.some((known) => known.id === item.id)) return null;
    items.push(item);
  }
  return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, AI_REPORT_INBOX_MAX);
}

/** 32-bit FNV-1a of `text` from `seed`, in base 36. */
function fnv(text: string, seed: number): string {
  let hash = seed;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

/**
 * The saved playtest Fix with agent makes of a report: `report-`, the id's first characters in
 * lower case, and a hash of the whole id, so ids that differ only in case or past the cut still
 * name different playtests. Always a name the harness accepts (`TAPE_NAME_RE`).
 */
export function reportTapeName(id: string): string {
  const slug = id
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, TAPE_ID_CHARS);
  return `report-${slug}-${fnv(id, 0x811c9dc5)}${fnv(id, 0x050c5d1f)}`;
}

/** A bundle summed up for the inbox: its calls, those still invalid after the repair, and the newest model. */
export function inboxItemOf(bundle: AiReportBundle, tape: string | null): AiReportInboxItem {
  const answered = bundle.calls.filter((call) => call.model !== null);
  return {
    id: bundle.id,
    kind: bundle.kind,
    createdAt: bundle.createdAt,
    reason: bundle.reason,
    note: bundle.note,
    calls: bundle.calls.length,
    invalid: bundle.calls.filter((call) => call.validation === AiValidation.Invalid).length,
    model: answered.at(-1)?.model ?? null,
    tape,
  };
}
