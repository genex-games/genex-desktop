/**
 * Sessions & turns — the `begin_turn` durability rule, port of `basic.rs:2286`.
 *
 * The rule that makes crash-resume trivial: `session_started?` + `turn_started` + the input
 * `messages` are appended **in one batch before any model call**. By the time inference starts,
 * the intent is already durable, so a `kill -9` mid-turn loses nothing but the in-flight answer.
 *
 * A {@link TurnHandle} carries the head forward so every subsequent write inside the turn is
 * head-checked — two writers on one thread can never interleave silently.
 */
import { EventKind } from "../shared/event-log.ts";
import type { AppendResult, EventStore } from "./event-store.ts";
import { shortId } from "./ids.ts";
import { HeadMismatch, type EventData, type EventEnvelope, type Message, type Usage } from "./types.ts";

export class TurnHandle {
  readonly store: EventStore;
  readonly threadId: string;
  readonly sessionId: string;
  readonly turnId: string;
  #latestEventId: string;
  #ended = false;
  #resyncs = 0;

  constructor(store: EventStore, threadId: string, sessionId: string, turnId: string, head: string) {
    this.store = store;
    this.threadId = threadId;
    this.sessionId = sessionId;
    this.turnId = turnId;
    this.#latestEventId = head;
  }

  get latestEventId(): string {
    return this.#latestEventId;
  }

  get ended(): boolean {
    return this.#ended;
  }

  /**
   * Head-checked append inside this turn, with one additive fallback.
   *
   * The optimistic check catches a *lost update* — another writer that advanced the thread while
   * this turn was mid-flight. But a turn is not the thread's only legitimate writer: a tool takes
   * a snapshot (`snapshot_created`), the watchdog records a rewind, a delegated engine mirrors its
   * messages. Those appends are additive and correctly ordered by the store's single write lock,
   * so refusing them outright would break normal operation — the studio would fail a turn simply
   * for having snapshotted itself during it.
   *
   * So: try with the expected head; if the thread moved, append once more after whatever is the
   * head by then. The retry carries no expected head: adopting the head the mismatch reported would
   * fail again when a third writer lands in between (a Stop's queue pause and resume), and the
   * turn — its end included — would be lost. Resyncs are counted rather than hidden, and the strict
   * form remains available on the store API for callers that genuinely need optimistic concurrency.
   */
  async append(batch: EventData[]): Promise<string> {
    return (await this.write(batch)).latestEventId;
  }

  /** {@link TurnHandle.append}, returning the envelopes it wrote as well as the new head. */
  async write(batch: EventData[]): Promise<AppendResult> {
    if (batch.length === 0) return { latestEventId: this.#latestEventId, events: [] };
    let result: AppendResult;
    try {
      result = await this.store.appendEvents(this.threadId, batch, {
        sessionId: this.sessionId,
        turnId: this.turnId,
        expectedHead: this.#latestEventId,
      });
    } catch (err) {
      if (!(err instanceof HeadMismatch)) throw err;
      this.#resyncs++;
      result = await this.store.appendEvents(this.threadId, batch, {
        sessionId: this.sessionId,
        turnId: this.turnId,
      });
    }
    this.#latestEventId = result.latestEventId;
    return result;
  }

  /** How often another writer interleaved with this turn. */
  get resyncs(): number {
    return this.#resyncs;
  }

  async appendMessages(messages: Message[], usage?: Usage): Promise<string> {
    return this.append([{ type: EventKind.Messages, messages, ...(usage ? { usage } : {}) }]);
  }

  async end(status: "ok" | "error" | "cancelled" = "ok", metadata?: Record<string, unknown>): Promise<string> {
    if (this.#ended) return this.#latestEventId;
    this.#ended = true;
    return this.append([{ type: EventKind.TurnEnded, status, ...(metadata ? { metadata } : {}) }]);
  }
}

export interface BeginTurnOptions {
  /** Messages that triggered the turn (user input, run instruction, watchdog note). */
  input?: Message[];
  metadata?: Record<string, unknown>;
}

/**
 * Session-scoped turn factory. One instance per process run; `sessionId` identifies that run in
 * the log, which is how "which restart produced this?" stays answerable forever.
 */
export class TurnFactory {
  readonly store: EventStore;
  readonly sessionId: string;
  readonly #sessionOpened = new Set<string>();

  constructor(store: EventStore, sessionId = shortId("ses")) {
    this.store = store;
    this.sessionId = sessionId;
  }

  async beginTurn(threadId: string, options: BeginTurnOptions = {}): Promise<TurnHandle> {
    const turnId = shortId("turn");
    const batch: EventData[] = [];
    if (!this.#sessionOpened.has(threadId)) {
      this.#sessionOpened.add(threadId);
      batch.push({ type: EventKind.SessionStarted, metadata: { session_id: this.sessionId } });
    }
    batch.push({ type: EventKind.TurnStarted, ...(options.metadata ? { metadata: options.metadata } : {}) });
    if (options.input?.length) batch.push({ type: EventKind.Messages, messages: options.input });

    // ONE batch, before any model call.
    const result = await this.store.appendEvents(threadId, batch, {
      sessionId: this.sessionId,
      turnId,
    });
    return new TurnHandle(this.store, threadId, this.sessionId, turnId, result.latestEventId);
  }

  async endSession(threadId: string, reason = "shutdown"): Promise<void> {
    if (!this.#sessionOpened.has(threadId)) return;
    this.#sessionOpened.delete(threadId);
    await this.store.appendEvents(threadId, [{ type: EventKind.SessionEnded, reason }], {
      sessionId: this.sessionId,
    });
  }
}

/**
 * Turns that never received `turn_ended` — i.e. turns interrupted by a crash. The harness marks
 * them on boot so the reborn agent can see, from the log alone, that it was interrupted.
 */
export async function findInterruptedTurns(store: EventStore, threadId: string): Promise<string[]> {
  return interruptedTurnsIn(await store.listEvents(threadId));
}

/**
 * {@link findInterruptedTurns} over a thread's events already in hand, continuing from the turns
 * an earlier part of the log left open.
 */
export function interruptedTurnsIn(events: readonly EventEnvelope[], open: Iterable<string> = []): string[] {
  const started = new Set<string>(open);
  for (const event of events) {
    if (!event.turn_id) continue;
    if (event.data.type === EventKind.TurnStarted) started.add(event.turn_id);
    if (event.data.type === EventKind.TurnEnded) started.delete(event.turn_id);
  }
  return [...started];
}
