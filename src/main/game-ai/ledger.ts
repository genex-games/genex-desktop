/**
 * Play-time AI's ledger: one JSON line per settled call in `userData/game-ai/ledger.jsonl`, each
 * also recorded as a `CustomEvent.GameAiCall`. A line holds ids, counts and money, never prompt or
 * answer text: it is rebuilt field by field, so nothing a caller adds reaches the file. The file is
 * append-only and rotated past its cap (one older file kept), and read back as hostile input line by
 * line, so a damaged line is dropped and never thrown. Settings' Games list reads a month's spend
 * per game from it, on the injected clock.
 */
import { appendFile, rename, stat } from "node:fs/promises";
import path from "node:path";
import {
  AiDoor,
  AiErrorCode,
  type AiGameKey,
  AiProvenance,
  type AiUsage,
  isPlainRecord,
  readAiGameKey,
  readMember,
  AI_SITE_RE,
} from "../../shared/game-ai.ts";
import { AsyncLock, readRegularFile } from "../../substrate/fsx.ts";
import { gameAiCallRecord } from "./events.ts";
import type { AiLedgerEntry, GameAiClock, GameAiLedger } from "./types.ts";

/** The ledger's file, and the one older file rotation keeps, in `userData/game-ai/`. */
export const LEDGER_FILE = "ledger.jsonl";
const ROTATED_FILE = "ledger.1.jsonl";
/** The most bytes one ledger file grows to before it rotates. */
const LEDGER_MAX_BYTES = 4 * 1024 * 1024;
/** The longest model id a line keeps. */
const MODEL_MAX_CHARS = 200;
/** A grant id as the grants store makes them. */
const GRANT_ID_RE = /^[A-Za-z0-9_-]{8,100}$/;

/** What the ledger runs on. */
export interface GameAiLedgerOptions {
  /** `userData/game-ai`. */
  dir: string;
  clock: GameAiClock;
  /** Record a call's event in the event log; a refusal there never loses the line. */
  record(event: ReturnType<typeof gameAiCallRecord>): Promise<void> | void;
  /** Bytes per file before it rotates (tests hold it small). */
  maxBytes?: number | undefined;
}

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function readUsage(raw: unknown): AiUsage | null | undefined {
  if (raw === null) return null;
  if (!isPlainRecord(raw) || !isCount(raw.inputTokens) || !isCount(raw.outputTokens)) return undefined;
  return { inputTokens: raw.inputTokens, outputTokens: raw.outputTokens };
}

const readModel = (raw: unknown): string | null | undefined => {
  if (raw === null) return null;
  return typeof raw === "string" && raw.length <= MODEL_MAX_CHARS && !/\p{Cc}/u.test(raw) ? raw : undefined;
};

const readGrantId = (raw: unknown): string | null | undefined => {
  if (raw === null) return null;
  return typeof raw === "string" && GRANT_ID_RE.test(raw) ? raw : undefined;
};

/** One ledger line as untrusted input, rebuilt field by field; null when any field is off. */
export function readLedgerEntry(raw: unknown): AiLedgerEntry | null {
  if (!isPlainRecord(raw)) return null;
  const game = readAiGameKey(raw.game);
  const door = readMember(AiDoor, raw.door);
  const provenance = readMember(AiProvenance, raw.provenance);
  const code = raw.code === null ? null : readMember(AiErrorCode, raw.code);
  const usage = readUsage(raw.usage);
  const model = readModel(raw.model);
  const grantId = readGrantId(raw.grantId);
  const { at, site, repaired, costMicros, latencyMs } = raw;
  if (!game || !door || !provenance || code === undefined || (raw.code !== null && code === null)) return null;
  if (usage === undefined || model === undefined || grantId === undefined) return null;
  if (typeof at !== "string" || !Number.isFinite(Date.parse(at))) return null;
  if (typeof site !== "string" || !AI_SITE_RE.test(site) || typeof repaired !== "boolean") return null;
  if (!isCount(costMicros) || !isCount(latencyMs)) return null;
  return { at, game, grantId, site, door, model, provenance, code, repaired, usage, costMicros, latencyMs };
}

/** The lines of a ledger file's text, oldest first, the damaged ones dropped. */
function readLines(text: string): AiLedgerEntry[] {
  const entries: AiLedgerEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = readLedgerEntry(JSON.parse(line));
      if (entry) entries.push(entry);
    } catch {
      // A damaged line (a crash mid-append, a hand edit) is skipped.
    }
  }
  return entries;
}

/** The ledger over `options.dir`. */
export function createGameAiLedger(options: GameAiLedgerOptions): GameAiLedger {
  return new Ledger(options);
}

/** The append-only, rotated ledger. */
class Ledger implements GameAiLedger {
  readonly #options: GameAiLedgerOptions;
  readonly #maxBytes: number;
  readonly #lock = new AsyncLock();

  constructor(options: GameAiLedgerOptions) {
    this.#options = options;
    this.#maxBytes = options.maxBytes ?? LEDGER_MAX_BYTES;
  }

  async append(raw: AiLedgerEntry): Promise<void> {
    const entry = readLedgerEntry(raw);
    if (!entry) return;
    const line = `${JSON.stringify(entry)}\n`;
    await this.#lock.run(async () => {
      const file = path.join(this.#options.dir, LEDGER_FILE);
      const size = (await stat(file).catch(() => null))?.size ?? 0;
      if (size > 0 && size + Buffer.byteLength(line) > this.#maxBytes) {
        await rename(file, path.join(this.#options.dir, ROTATED_FILE));
      }
      await appendFile(file, line, { mode: 0o600 });
    });
    try {
      await this.#options.record(gameAiCallRecord(entry));
    } catch {
      // The line is the record that counts; the event log may be closing.
    }
  }

  async recent(limit: number, game?: AiGameKey): Promise<AiLedgerEntry[]> {
    if (!(limit > 0)) return [];
    const all = await this.#all();
    const mine = game === undefined ? all : all.filter((entry) => entry.game === game);
    return mine.reverse().slice(0, limit);
  }

  async monthByGame(): Promise<Map<AiGameKey, number>> {
    const month = new Date(this.#options.clock.now()).toISOString().slice(0, 7);
    const spent = new Map<AiGameKey, number>();
    for (const entry of await this.#all()) {
      if (entry.costMicros === 0 || new Date(entry.at).toISOString().slice(0, 7) !== month) continue;
      spent.set(entry.game, (spent.get(entry.game) ?? 0) + entry.costMicros);
    }
    return spent;
  }

  /** Every line of both files, oldest first. */
  async #all(): Promise<AiLedgerEntry[]> {
    const texts = await this.#lock.run(() =>
      Promise.all([ROTATED_FILE, LEDGER_FILE].map((name) => this.#read(path.join(this.#options.dir, name)))),
    );
    return texts.flatMap(readLines);
  }

  /** A ledger file's text, never through a link and never past its cap; a missing file is empty. */
  async #read(file: string): Promise<string> {
    const bytes = await readRegularFile(file, this.#maxBytes).catch(() => null);
    return bytes ? bytes.toString("utf8") : "";
  }
}
