/**
 * A delegation's own share of what its session spent.
 *
 * Claude Code reports a session's cost (`total_cost_usd`) and every model's tokens (`modelUsage`)
 * as running totals, and a resumed session carries them on: adding up the reports of a session's
 * turns counted each early turn again in every later one (a run read about six times its real
 * cost). Each delegation's share is its totals minus the totals the same session reported last,
 * which this ledger remembers by session id, in a file when it is given one so a restart does not
 * count a resumed session's past again. A counter that went down started again (the CLI did not
 * carry it on), so it counts from zero.
 */
import type { ModelTokenUsage, Usage } from "../../shared/event-log.ts";
import { atomicWriteJson, isJsonObject, readJsonIfExists } from "../fsx.ts";

/** How many sessions the ledger remembers; the oldest are forgotten first. */
const MAX_SESSIONS = 512;

/** What a session last reported for itself as a whole: its cost and every model's tokens. */
export type SessionTotals = Pick<Usage, "cost_usd" | "by_model">;

/** One session's totals, and when they were reported (ms since the epoch). */
type Entry = SessionTotals & { at: number };

/** The ledger file. */
interface LedgerFile {
  sessions: Record<string, Entry>;
}

/** The counts of a model's row (`Usage.by_model`): every one a later report of a session can only grow. */
export const MODEL_ROW_COUNTS = [
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "reasoning_tokens",
  "cost_usd",
] as const satisfies ReadonlyArray<keyof ModelTokenUsage>;

/** The totals a usage report holds, or null when it holds none. */
export function sessionTotals(usage: Usage): SessionTotals | null {
  const totals: SessionTotals = {
    ...(typeof usage.cost_usd === "number" ? { cost_usd: usage.cost_usd } : {}),
    ...(usage.by_model ? { by_model: usage.by_model } : {}),
  };
  return Object.keys(totals).length ? totals : null;
}

/** `now` minus `before`; `now` itself when there was no `before` or the counter went down. */
function shareOf(now: number, before: number | undefined): number {
  return before === undefined || now < before ? now : now - before;
}

/** A count a remembered row holds, or 0 when it holds none. */
const countIn = (row: ModelTokenUsage, key: (typeof MODEL_ROW_COUNTS)[number]): number => {
  const value = row[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
};

/** One model's row as this delegation's share; the whole row when any of its counts went down. */
function rowShare(now: ModelTokenUsage, before: ModelTokenUsage | undefined): ModelTokenUsage {
  if (!before) return now;
  const counted = MODEL_ROW_COUNTS.filter((key) => typeof now[key] === "number");
  if (counted.some((key) => countIn(now, key) < countIn(before, key))) return now;
  const share: ModelTokenUsage = { ...now };
  for (const key of counted) share[key] = countIn(now, key) - countIn(before, key);
  return share;
}

/** This delegation's share of `now`: the session's totals minus what it reported `before`. */
export function turnShare(before: SessionTotals | undefined, now: SessionTotals): SessionTotals {
  const byModel = now.by_model
    ? Object.fromEntries(Object.entries(now.by_model).map(([id, row]) => [id, rowShare(row, before?.by_model?.[id])]))
    : undefined;
  return {
    ...(typeof now.cost_usd === "number" ? { cost_usd: shareOf(now.cost_usd, before?.cost_usd) } : {}),
    ...(byModel ? { by_model: byModel } : {}),
  };
}

/** Each session's last totals, by session id: in memory, and in `file` when given. */
export class SessionCostLedger {
  readonly #file: string | null;
  #sessions: Map<string, Entry> | null = null;
  #writing: Promise<void> = Promise.resolve();

  constructor(file?: string) {
    this.#file = file ?? null;
  }

  /** What `sessionId` last reported, if it reported anything this ledger remembers. */
  async before(sessionId: string | undefined): Promise<SessionTotals | undefined> {
    if (!sessionId) return undefined;
    const entry = (await this.#loaded()).get(sessionId);
    if (!entry) return undefined;
    const { at: _at, ...totals } = entry;
    return totals;
  }

  /** Remember what `sessionId` reported now; bookkeeping never fails the delegation. */
  async settle(sessionId: string, totals: SessionTotals, at: number = Date.now()): Promise<void> {
    const sessions = await this.#loaded();
    sessions.delete(sessionId);
    sessions.set(sessionId, { ...totals, at });
    while (sessions.size > MAX_SESSIONS) {
      const oldest = sessions.keys().next().value;
      if (oldest === undefined) break;
      sessions.delete(oldest);
    }
    const file = this.#file;
    if (!file) return;
    const snapshot: LedgerFile = { sessions: Object.fromEntries(sessions) };
    // Serialised: two delegations ending together must not interleave their writes.
    this.#writing = this.#writing.then(() => atomicWriteJson(file, snapshot)).catch(() => {});
    await this.#writing;
  }

  /** The sessions, read from the file once; a file that cannot be read starts an empty ledger. */
  async #loaded(): Promise<Map<string, Entry>> {
    if (this.#sessions) return this.#sessions;
    const read = this.#file ? await readJsonIfExists<unknown>(this.#file).catch(() => null) : null;
    const sessions = isJsonObject(read) && isJsonObject(read.sessions) ? read.sessions : {};
    const entries = Object.entries(sessions).filter((pair): pair is [string, Entry] => isEntry(pair[1]));
    entries.sort(([, a], [, b]) => a.at - b.at);
    this.#sessions ??= new Map(entries);
    return this.#sessions;
  }
}

/** A remembered entry as the file holds it: a time, a cost or model rows, nothing else trusted. */
function isEntry(value: unknown): value is Entry {
  if (!isJsonObject(value) || typeof value.at !== "number") return false;
  const cost = value.cost_usd === undefined || typeof value.cost_usd === "number";
  const rows = value.by_model === undefined || isJsonObject(value.by_model);
  return cost && rows;
}
