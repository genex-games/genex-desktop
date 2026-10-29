/**
 * A game's asks for another Genex cover or clip, kept on this Mac once the chat sent them, so
 * Publish still says one is being made after it closes into the chat; and how long the last ask of
 * each kind took, from the ask to the agent's own frame, which the banner's "~2 min" comes from.
 * Pure, but for the storage reads and writes, which never throw.
 */
import { MINUTE_MS } from "../../../../shared/duration.ts";
import type { GenexCoverRecord } from "../../../../shared/genex.ts";
import { browserStorage, type KeyValueStorage, readJson, storageKeyFor, writeJson } from "../../../storage.ts";

/** How long the banner says a cover is being made after Another cover, unless the agent's frame arrives first. */
export const COVER_MAKING_MS = 15 * MINUTE_MS;

/** What Another asks the game's chat for: a new cover picture, or a new clip. */
export const CoverKind = { Picture: "picture", Clip: "clip" } as const;
export type CoverKind = (typeof CoverKind)[keyof typeof CoverKind];

const KINDS: readonly string[] = Object.values(CoverKind);

/** An ask still waiting: which kind, the kept frame it was asked over (null: none yet), and when (ms). */
export interface CoverAsk {
  kind: CoverKind;
  from: string | null;
  at: number;
}

/** One game's asks: the one still waiting, and how long the last answered ask of each kind took (ms). */
export interface CoverAskMemory {
  ask: CoverAsk | null;
  took: Partial<Record<CoverKind, number>>;
}

const NOTHING_ASKED: CoverAskMemory = { ask: null, took: {} };

/** A time the banner can count down from: after the ask, and inside the wait. */
const measurable = (ms: number): boolean => Number.isFinite(ms) && ms > 0 && ms < COVER_MAKING_MS;

/**
 * When the ask was answered (ms; NaN when the answer has no readable time), or null while it waits.
 * The agent's own frame or clip of the asked kind after the ask answers it, never Studio's own takes
 * or a publish's shot. A plugin older than `agentTook` cannot say who took a frame: there any new
 * kept frame of the kind answers.
 */
function answeredAt(ask: CoverAsk, record: GenexCoverRecord): number | null {
  const clip = ask.kind === CoverKind.Clip;
  if (record.agentTook) {
    const at = Date.parse((clip ? record.agentTook.clip : record.agentTook.shot) ?? "");
    return at > ask.at ? at : null;
  }
  const kept = clip ? record.clip : record.shot;
  return kept && kept.sha256 !== ask.from ? Date.parse(kept.takenAt) : null;
}

/**
 * The memory once the game's cover record is read at `now`: an answered ask is done, timed by the
 * answer's own time (so a late read still times it right); an ask nothing answered within the wait
 * is dropped untimed. Unchanged, it is the same object.
 */
export function settleCoverAsk(memory: CoverAskMemory, record: GenexCoverRecord, now: number): CoverAskMemory {
  const ask = memory.ask;
  if (!ask) return memory;
  const answered = answeredAt(ask, record);
  if (answered !== null) {
    const took = answered - ask.at;
    return { ask: null, took: measurable(took) ? { ...memory.took, [ask.kind]: took } : memory.took };
  }
  if (now - ask.at >= COVER_MAKING_MS) return { ask: null, took: memory.took };
  return memory;
}

/** Whole minutes left, rounded up, when the last ask of this kind took `took` and `elapsed` has passed; null untimed or overrun. */
export function coverMinutesLeft(took: number | undefined, elapsed: number): number | null {
  if (took === undefined) return null;
  const left = took - elapsed;
  return left > 0 ? Math.ceil(left / MINUTE_MS) : null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function readAsk(value: unknown): CoverAsk | null {
  if (!isRecord(value)) return null;
  const { kind, from, at } = value;
  const sound = typeof kind === "string" && KINDS.includes(kind) && typeof at === "number" && Number.isFinite(at);
  if (!sound || !(from === null || typeof from === "string")) return null;
  return { kind: kind as CoverKind, from, at };
}

function readTook(value: unknown): CoverAskMemory["took"] {
  if (!isRecord(value)) return {};
  const took: CoverAskMemory["took"] = {};
  for (const kind of Object.values(CoverKind)) {
    const ms = value[kind];
    if (typeof ms === "number" && measurable(ms)) took[kind] = ms;
  }
  return took;
}

/** The game's kept asks; anything unsound in storage reads as nothing asked. */
export function readCoverAsks(project: string, storage: KeyValueStorage | null = browserStorage()): CoverAskMemory {
  const kept: unknown = readJson(storageKeyFor.coverAsks(project), null, storage);
  if (!isRecord(kept)) return NOTHING_ASKED;
  return { ask: readAsk(kept.ask), took: readTook(kept.took) };
}

/** Keep an ask the chat sent, beside the times already kept for the game; answers what is kept now. */
export function rememberCoverAsk(
  project: string,
  ask: CoverAsk,
  storage: KeyValueStorage | null = browserStorage(),
): CoverAskMemory {
  const memory = { ...readCoverAsks(project, storage), ask };
  writeCoverAsks(project, memory, storage);
  return memory;
}

/** Keep the game's asks; a write that fails leaves the last kept ones. */
export function writeCoverAsks(
  project: string,
  memory: CoverAskMemory,
  storage: KeyValueStorage | null = browserStorage(),
): void {
  writeJson(storageKeyFor.coverAsks(project), memory, storage);
}
