/**
 * Saved playtests ("tapes"): the AI moments of one played demo, one JSON line per answer, in the
 * game's own `ai/tapes/<demo>.jsonl`. A replay answers each call from the line whose key and
 * occurrence match, after the same number of frames it took live, so a seed and its inputs replay
 * the same frames; a miss is a typed failure, never a live call.
 *
 * A tape is agent-writable game content, so main and the page read every line as hostile input
 * (`readTape`), and a replayed answer is never verified. Browser-safe: the key is SHA-256 through
 * WebCrypto, which Node 24 and every page have.
 */
import {
  type AiCallRequest,
  type AiErrorCode,
  AiOp,
  AiSource,
  type AiTier,
  type AiUsage,
  AI_SITE_RE,
  isPlainRecord,
  readMember,
} from "./game-ai.ts";
import { canonicalJson, isAnswerJson } from "./game-ai-schema.ts";

/** The wire version of a tape line. */
export const TAPE_WIRE_VERSION = 1;
/** The most frames a replayed answer waits, however slow it was live. */
export const MAX_REPLAY_LATENCY_FRAMES = 240;
/** Where a game keeps its tapes, relative to its folder (posix). */
export const AI_TAPES_DIR = "ai/tapes";
/** A tape's file extension. */
export const AI_TAPE_EXTENSION = ".jsonl";
/** The largest tape a reader opens, in bytes; `readTape` caps its text at as many characters, which a file under the cap never reaches. */
export const AI_TAPE_MAX_BYTES = 8 * 1024 * 1024;
/** The most lines one tape holds. */
export const AI_TAPE_MAX_LINES = 10_000;
/** The longest model id a line keeps. */
export const AI_TAPE_MAX_MODEL_CHARS = 150;
/** A demo's name, which is its tape's file name without the extension. */
export const TAPE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** One saved answer. */
export interface TapeLine {
  v: typeof TAPE_WIRE_VERSION;
  /** `callKey` of the request it answers. */
  key: string;
  /** Which occurrence of that key in the demo, from 0. */
  n: number;
  site: string;
  op: AiOp;
  value: unknown;
  source: AiSource;
  model: string | null;
  /** Frames from the call to its answer, live; at least 1. */
  latencyFrames: number;
  usage: AiUsage | null;
}

/** The parts of a request a tape key covers: what decides the answer, never the ticket or the grant. */
export interface CallKeyInput {
  op: AiOp;
  site: string;
  system: string | null;
  prompt: string;
  untrusted: Record<string, string>;
  memory: string | null;
  schema: unknown;
  tier: AiTier;
}

/** What a request's key is made of. */
export const callKeyInput = (request: AiCallRequest): CallKeyInput => ({
  op: request.op,
  site: request.site,
  system: request.system,
  prompt: request.prompt,
  untrusted: request.untrusted,
  memory: request.memory,
  schema: request.schema,
  tier: request.tier,
});

const HEX = Array.from({ length: 256 }, (_, byte) => byte.toString(16).padStart(2, "0"));

/** SHA-256 of a call's canonical JSON, lowercase hex: the same request gives the same key anywhere. */
export async function callKey(input: CallKeyInput): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(input));
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => HEX[byte]).join("");
}

/** The slot a line answers: a key and its occurrence. */
export const tapeSlot = (key: string, n: number): string => `${key}#${n}`;

/** Whether a name is a demo's name. */
export const isTapeName = (value: unknown): value is string => typeof value === "string" && TAPE_NAME_RE.test(value);

/** A demo's tape, relative to the game's folder (posix). */
export const tapeFile = (name: string): string => `${AI_TAPES_DIR}/${name}${AI_TAPE_EXTENSION}`;

const KEY_RE = /^[0-9a-f]{64}$/;
const LINE_KEYS = ["v", "key", "n", "site", "op", "value", "source", "model", "latencyFrames", "usage"] as const;

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function readUsage(raw: unknown): AiUsage | null | undefined {
  if (raw === null) return null;
  if (!isPlainRecord(raw) || !isCount(raw.inputTokens) || !isCount(raw.outputTokens)) return undefined;
  return { inputTokens: raw.inputTokens, outputTokens: raw.outputTokens };
}

const isLatency = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_REPLAY_LATENCY_FRAMES;

const readModel = (raw: unknown): string | null | undefined => {
  if (raw === null) return null;
  return typeof raw === "string" && raw.length > 0 && raw.length <= AI_TAPE_MAX_MODEL_CHARS ? raw : undefined;
};

/** One parsed line as a tape line, or null. Pure; never throws. */
export function readTapeLine(raw: unknown): TapeLine | null {
  if (!isPlainRecord(raw) || Object.keys(raw).length !== LINE_KEYS.length) return null;
  if (!LINE_KEYS.every((key) => Object.hasOwn(raw, key))) return null;
  const { v, key, n, site, value, latencyFrames } = raw;
  const op = readMember(AiOp, raw.op);
  const source = readMember(AiSource, raw.source);
  const model = readModel(raw.model);
  const usage = readUsage(raw.usage);
  if (v !== TAPE_WIRE_VERSION || !op || !source || model === undefined || usage === undefined) return null;
  if (typeof key !== "string" || !KEY_RE.test(key) || !isCount(n)) return null;
  if (typeof site !== "string" || !AI_SITE_RE.test(site) || !isLatency(latencyFrames) || !isAnswerJson(value))
    return null;
  return { v: TAPE_WIRE_VERSION, key, n, site, op, value, source, model, latencyFrames, usage };
}

/** A tape's text read: its usable lines by slot (a repeated slot keeps its first line), and how many were refused. */
export interface TapeRead {
  lines: TapeLine[];
  bySlot: ReadonlyMap<string, TapeLine>;
  rejected: number;
  /** The tape was over the size or line cap; nothing past the cap was read. */
  truncated: boolean;
}

function parseLine(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** A tape's text as hostile input: bounded, line by line, every refusal counted. Never throws. */
export function readTape(text: string): TapeRead {
  const truncated = text.length > AI_TAPE_MAX_BYTES;
  const rows = (truncated ? text.slice(0, AI_TAPE_MAX_BYTES) : text).split("\n");
  const lines: TapeLine[] = [];
  const bySlot = new Map<string, TapeLine>();
  let rejected = 0;
  let seen = 0;
  for (const row of rows) {
    if (!row.trim()) continue;
    seen += 1;
    if (seen > AI_TAPE_MAX_LINES) return { lines, bySlot, rejected, truncated: true };
    const line = readTapeLine(parseLine(row));
    if (!line) {
      rejected += 1;
      continue;
    }
    lines.push(line);
    const slot = tapeSlot(line.key, line.n);
    if (!bySlot.has(slot)) bySlot.set(slot, line);
  }
  return { lines, bySlot, rejected, truncated };
}

/** A tape line as written: one line of JSON with its newline. */
export const tapeLineText = (line: TapeLine): string => `${JSON.stringify(line)}\n`;

// ── harness runs on tapes (`ai.replay`, `ai.record`) ───────────────────────────────────────

/** The most seeds one `ai.replay` runs. */
export const AI_REPLAY_MAX_SEEDS = 8;
/** The most calls one `ai.record` run may make, on the host-created local-only run budget. */
export const AI_RECORD_MAX_CALLS = 200;

/** What a harness replay answers a demo's calls with. Wire values: never rename one. */
export const AiReplayAnswers = {
  /** The demo's tape: a call it has no line for is `ai_unrecorded`, and the game's fallback plays. */
  Tape: "tape",
  /** No answer at all: every call is refused `ai_off`, as when the person turns AI off (`ai.handles-no-answer`). */
  None: "none",
} as const;
export type AiReplayAnswers = (typeof AiReplayAnswers)[keyof typeof AiReplayAnswers];

/** What `ai.replay` found: whether every seed replayed the same frames, and what the tape lacked. */
export interface AiReplayResult {
  demo: string;
  deterministic: boolean;
  /** Per seed, the state digests at each checkpoint, in order. */
  stateDigests: string[][];
  /** Calls the tape had no answer for (`ai_unrecorded`). */
  misses: number;
  /** Calls answered by the game's fallback. */
  fallbacks: number;
  /** Tape lines the reader refused. */
  rejected: number;
  /** What the calls were answered with; absent: the tape. */
  answers?: AiReplayAnswers;
  /** Calls still waiting for an answer when a seed's demo ended, over every seed; absent when the host cannot tell. */
  stuck?: number;
  /**
   * Every seed's demo ended — it ran to its end, or stopped behind Studio's "needs AI" state —
   * with no crash and no console error; absent when the host cannot tell.
   */
  settled?: boolean;
  /** How many calls were refused, by code (a grant asked for outside a gesture is `no_gesture`); absent when the host cannot tell. */
  refused?: Partial<Record<AiErrorCode, number>>;
}

/** What `ai.record` saved. */
export interface AiRecordResult {
  demo: string;
  /** The tape, relative to the game's folder. */
  file: string;
  calls: number;
  /** Calls refused by the run budget or a door; the game played its fallback. */
  refused: number;
}
