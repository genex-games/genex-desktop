/**
 * A rolling memory a game hands its calls (`memory: chronicle`): the last few things worth
 * remembering, as short lines, that a call carries as its `memory` text. It keeps at most `keep`
 * lines, can be compacted into one summary line by the model between turns, and saves as plain
 * JSON with the game's own save. A restored snapshot is read as hostile input: a save file is the
 * player's to edit.
 */
import { isPlainRecord } from "../../shared/game-ai.ts";

/** How many lines a memory keeps when the game names no number. */
export const MEMORY_DEFAULT_KEEP = 12;
/** The most lines a memory may keep. */
export const MEMORY_MAX_KEEP = 64;
/** The longest one remembered line, in characters; longer is cut. */
export const MEMORY_MAX_LINE_CHARS = 2000;
/** The longest a role (who said it) may be. */
export const MEMORY_MAX_ROLE_CHARS = 40;
/** A memory's name: the same shape as a call site's. */
export const MEMORY_NAME_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
/** The snapshot's version. */
const SNAPSHOT_VERSION = 1;

/** One remembered line. */
export interface AiMemoryLine {
  role: string;
  text: string;
}

/** A memory as it saves. */
export interface AiMemorySnapshot {
  v: typeof SNAPSHOT_VERSION;
  name: string;
  lines: AiMemoryLine[];
}

/** A rolling memory: what the game remembers, carried by the calls it is given to. */
export interface AiMemory {
  readonly name: string;
  readonly keep: number;
  /** Remember one line; the oldest goes once there are more than `keep`. */
  remember(role: string, text: string): void;
  lines(): readonly AiMemoryLine[];
  /** The memory as a call carries it, or null when it holds nothing. */
  text(): string | null;
  snapshot(): AiMemorySnapshot;
  /** Put a saved snapshot back; a snapshot that does not read leaves the memory as it was and answers false. */
  restore(snapshot: unknown): boolean;
  /** Ask the model to fold everything into one line, delivered and applied on a later `drain()`. */
  compact(site: string): void;
  clear(): void;
}

/** A role and a line, bounded. */
function line(role: string, text: string): AiMemoryLine | null {
  const who = String(role).trim().slice(0, MEMORY_MAX_ROLE_CHARS);
  const said = String(text).trim().slice(0, MEMORY_MAX_LINE_CHARS);
  return who && said ? { role: who, text: said } : null;
}

/** A snapshot's lines as the memory accepts them, or null. */
function readSnapshotLines(raw: unknown, name: string): AiMemoryLine[] | null {
  if (!isPlainRecord(raw) || raw.v !== SNAPSHOT_VERSION || raw.name !== name) return null;
  const rows = raw.lines;
  if (!Array.isArray(rows) || rows.length > MEMORY_MAX_KEEP) return null;
  const lines: AiMemoryLine[] = [];
  for (const row of rows) {
    if (!isPlainRecord(row) || typeof row.role !== "string" || typeof row.text !== "string") return null;
    const read = line(row.role, row.text);
    if (read) lines.push(read);
  }
  return lines;
}

/** The keep a game asked for, within bounds. */
export function keepOf(keep: unknown): number {
  if (typeof keep !== "number" || !Number.isFinite(keep)) return MEMORY_DEFAULT_KEEP;
  return Math.min(MEMORY_MAX_KEEP, Math.max(1, Math.floor(keep)));
}

/** A memory, with what it asks of the SDK to compact itself. */
export function createMemory(name: string, keep: number, compact: (memory: AiMemory, site: string) => void): AiMemory {
  let lines: AiMemoryLine[] = [];
  const memory: AiMemory = {
    name,
    keep,
    remember(role, text) {
      const read = line(role, text);
      if (!read) return;
      lines = [...lines, read].slice(-keep);
    },
    lines: () => lines,
    text: () => (lines.length ? lines.map((entry) => `${entry.role}: ${entry.text}`).join("\n") : null),
    snapshot: () => ({ v: SNAPSHOT_VERSION, name, lines: lines.map((entry) => ({ ...entry })) }),
    restore(snapshot) {
      const read = readSnapshotLines(snapshot, name);
      if (!read) return false;
      lines = read.slice(-keep);
      return true;
    },
    compact: (site) => compact(memory, site),
    clear() {
      lines = [];
    },
  };
  return memory;
}

/**
 * Fold a compaction's summary in: the lines it summarized go, the summary takes their place, and
 * whatever was remembered since stays after it.
 */
export function applyCompaction(
  memory: AiMemory,
  summarized: readonly AiMemoryLine[],
  summary: string,
  role: string,
): void {
  const kept = memory.lines().filter((entry) => !summarized.includes(entry));
  memory.clear();
  memory.remember(role, summary);
  for (const entry of kept) memory.remember(entry.role, entry.text);
}
