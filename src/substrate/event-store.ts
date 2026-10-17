/**
 * Append-only event store, port of Exo `crates/exoharness/src/{basic,storage}.rs`.
 *
 * Hard constraint #2 of the product: **the append-only event log is the agent's entire state.**
 * There is no other source of truth; SQLite/in-memory indexes are derived and disposable. The
 * store keeps one: each conversation's sorted event ids (`EventStore#idsThrough`), so a cursor,
 * tail or page read opens only the bodies it returns instead of listing the whole folder.
 *
 * On-disk layout (bit-compatible with Exo's `.exo/exoharness`):
 *
 *   <root>/agents/<agent_id>/record.json
 *   <root>/agents/<agent_id>/conversations/<conv_id>/record.json           ← holds the head
 *   <root>/agents/<agent_id>/conversations/<conv_id>/events/<uuid7>.json   ← ONE FILE PER EVENT
 *   <root>/agents/<agent_id>/conversations/<conv_id>/artifacts/<id>/<version>.json
 */
import path from "node:path";
import { CHAT_PAGE_SIZE, chatContext, type ChatPage } from "../shared/chat-history.ts";
import { rewindsOf, withdrawnId, withoutRewound } from "../shared/chat-rewind.ts";
import { EventKind } from "../shared/event-log.ts";
import { redactDeep } from "../shared/redact.ts";
import { rename, stat } from "node:fs/promises";
import { AsyncLock, atomicWriteJson, ensureDir, listDirs, listJsonFiles, readJson, readJsonIfExists } from "./fsx.ts";
import { compareIds, isUuidV7, processUuidv7, uuid7Timestamp, uuidv7, type Uuidv7Generator } from "./ids.ts";
import {
  type AgentRecord,
  type ArtifactVersion,
  type ConversationRecord,
  type EventData,
  type EventEnvelope,
  HeadMismatch,
  type Message,
  ThreadNotFound,
} from "./types.ts";

export interface AppendOptions {
  sessionId?: string | null;
  turnId?: string | null;
  /**
   * Optimistic concurrency: when provided, the append fails with {@link HeadMismatch} unless the
   * stored head still equals this id. `null` means "thread must still be empty".
   */
  expectedHead?: string | null;
}

export interface AppendResult {
  latestEventId: string;
  events: EventEnvelope[];
}

export interface ListOptions {
  /** Exclusive lower bound — pagination cursor. */
  after?: string;
  /** Inclusive upper bound. */
  upToInclusive?: string;
  limit?: number;
  /** Return the newest matching events, still in ascending order. */
  tail?: boolean;
}

/** A derived state of one thread's log, kept by {@link EventStore.foldThread}. */
export interface ThreadFold<S> {
  /** The checkpoint file's name beside the thread's record. */
  name: string;
  /** Bumped whenever `S` or `fold` changes meaning, so an older checkpoint is folded again. */
  version: number;
  /** Fold events, oldest first, into the state so far (`null` for none): JSON in, JSON out. */
  fold: (state: S | null, events: readonly EventEnvelope[]) => S;
}

export type EventSubscriber = (event: EventEnvelope) => void;

export interface Subscription {
  /** Stop receiving events. */
  close: () => void;
  /** Resolves once the initial replay (if requested) has been delivered. */
  ready: Promise<void>;
}

export interface CreateThreadOptions {
  title?: string;
  metadata?: Record<string, unknown>;
  threadId?: string;
}

const RAW_ALIAS_KEY = "conversation_id";
/** More files than this after the head are not one torn batch (see `#recoverUncommitted`). */
const MAX_UNCOMMITTED_TAIL = 64;
/** Event bodies read at once: enough to keep libuv's file threads busy, few enough to stay small. */
const READ_CONCURRENCY = 32;
/**
 * The chat-context checkpoint's format; a checkpoint of another version is rebuilt. Raise it
 * whenever the fold keeps different facts (6: context readings kept per session role; 7:
 * background work still running; 8: workers still working).
 */
const CHAT_CONTEXT_VERSION = 8;
/** Events folded into the chat context per read while it is rebuilt. */
const CHAT_CONTEXT_BATCH = 256;
/** How much of a refused id an error message quotes. */
const REFUSED_ID_PREVIEW_CHARS = 80;
/** A thread or artifact id: one path segment of letters, digits, `.`, `_` and `-`. */
const PLAIN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const MESSAGE = {
  UnreadableThread: (id: string) =>
    `Thread ${id} has an unreadable record. Original files are preserved; restore its record from a backup before continuing this conversation.`,
  BatchNotList: "event batch is not a list of events",
  BatchEntryNotEvent: (index: number) =>
    `event batch entry ${index} is not an event: it needs an object with a string "type"`,
  KeptBehindHead: (threadId: string, count: number, head: string) =>
    `[event-store] thread ${threadId}: ${count} events sort after the recorded head ${head}; ` +
    "they are committed history behind a head that went backwards, so they were kept, not quarantined",
  InvalidId: (what: string, id: unknown) =>
    `invalid ${what}: ${JSON.stringify(id)?.slice(0, REFUSED_ID_PREVIEW_CHARS)}`,
} as const;

export interface EventStoreOptions {
  /** Wall clock for new ids. Tests step it backwards to stand in for a clock change. */
  now?: () => number;
  /** Id generator. A fresh one stands in for a new process: its in-memory floor starts empty. */
  ids?: Uuidv7Generator;
  /** Where recovery reports what it refused to do. */
  warn?: (message: string) => void;
  /**
   * Applied to every string of every appended event before it is written, returned or announced
   * (`redactDeep`): the log is durable and replayed, so a credential an agent printed must not
   * reach it. Studio's core passes its `secretRedactor`; the store itself knows no secrets.
   */
  redact?: (text: string) => string;
}

export class EventStore {
  readonly root: string;
  readonly agentId: string;
  readonly #lock = new AsyncLock();
  readonly #subscribers = new Map<string, Set<EventSubscriber>>();
  readonly #recovered = new Set<string>();
  /**
   * Each conversation's event ids in order, as its folder lists them: loaded on first read, then
   * extended by this store's own appends. Derived and disposable: dropped whenever it may be
   * wrong (a quarantine, a head it does not hold) and listed again from the folder.
   */
  readonly #index = new Map<string, string[]>();
  readonly #records = new Map<string, { stamp: string; record: ConversationRecord }>();
  readonly #unreadableRecords = new Set<string>();
  readonly #now: () => number;
  readonly #ids: Uuidv7Generator;
  readonly #warn: (message: string) => void;
  readonly #redact: ((text: string) => string) | undefined;

  constructor(root: string, agentId: string, options: EventStoreOptions = {}) {
    this.root = root;
    this.agentId = agentId;
    this.#now = options.now ?? Date.now;
    this.#ids = options.ids ?? processUuidv7;
    this.#warn = options.warn ?? ((message) => console.warn(message));
    this.#redact = options.redact;
  }

  static async open(root: string, agentId = "studio", options: EventStoreOptions = {}): Promise<EventStore> {
    const store = new EventStore(root, agentId, options);
    await ensureDir(store.conversationsDir());
    const recordPath = path.join(store.agentDir(), "record.json");
    const existing = await readJsonIfExists<AgentRecord>(recordPath);
    if (!existing) {
      const now = new Date().toISOString();
      await atomicWriteJson(recordPath, {
        id: agentId,
        created_at: now,
        updated_at: now,
        metadata: {},
      } satisfies AgentRecord);
    }
    await store.#floorAtNewestEvent();
    return store;
  }

  /**
   * Ids are time-ordered across threads (the live feed's cursor, a rewind's range). A clock that
   * stepped back since the last run must not mint ids below what is already stored, so the id
   * floor starts at the newest head of any thread.
   */
  async #floorAtNewestEvent(): Promise<void> {
    let newest: string | null = null;
    for (const { latest_event_id: head } of await this.listThreads()) {
      if (head && isUuidV7(head)) newest = laterId(newest, head);
    }
    if (newest) this.#ids(this.#now(), newest);
  }

  // ── paths ────────────────────────────────────────────────────────────────────────────────
  agentDir(): string {
    return path.join(this.root, "agents", this.agentId);
  }
  conversationsDir(): string {
    return path.join(this.agentDir(), "conversations");
  }
  threadDir(threadId: string): string {
    return path.join(this.conversationsDir(), plainId(threadId, "thread id"));
  }
  recordPath(threadId: string): string {
    return path.join(this.threadDir(threadId), "record.json");
  }
  eventsDir(threadId: string): string {
    return path.join(this.threadDir(threadId), "events");
  }
  eventPath(threadId: string, eventId: string): string {
    return path.join(this.eventsDir(threadId), `${eventId}.json`);
  }
  artifactsDir(threadId: string): string {
    return path.join(this.threadDir(threadId), "artifacts");
  }

  // ── threads ──────────────────────────────────────────────────────────────────────────────
  async createThread(options: CreateThreadOptions = {}): Promise<string> {
    const threadId = options.threadId ?? uuidv7();
    const now = new Date().toISOString();
    await this.#lock.run(async () => {
      await ensureDir(this.eventsDir(threadId));
      this.#index.delete(threadId);
      const record: ConversationRecord = {
        id: threadId,
        agent_id: this.agentId,
        created_at: now,
        updated_at: now,
        latest_event_id: null,
        ...(options.title !== undefined ? { title: options.title } : {}),
        ...(options.metadata ? { metadata: options.metadata } : {}),
      };
      await this.#saveRecord(threadId, record);
    });
    await this.appendEvents(
      threadId,
      [
        {
          type: EventKind.ThreadCreated,
          ...(options.title !== undefined ? { title: options.title } : {}),
          ...(options.metadata ? { metadata: options.metadata } : {}),
        },
      ],
      {},
    );
    return threadId;
  }

  async listThreads(): Promise<ConversationRecord[]> {
    const before = new Map(this.#records);
    const ids = await listDirs(this.conversationsDir());
    const records: ConversationRecord[] = [];
    for (let at = 0; at < ids.length; at += READ_CONCURRENCY) {
      const chunk = ids.slice(at, at + READ_CONCURRENCY);
      for (const record of await Promise.all(chunk.map((id) => this.#indexedRecord(id)))) {
        if (record) records.push(structuredClone(record));
      }
    }
    const live = new Set(ids);
    for (const [id, entry] of before) {
      if (!live.has(id) && this.#records.get(id) === entry) this.#records.delete(id);
    }
    return records.sort((a, b) => compareIds(a.id, b.id));
  }

  /** Stat outside the writer lock; external handles invalidate only the record they changed. */
  async #indexedRecord(id: string): Promise<ConversationRecord | null> {
    const previous = this.#records.get(id);
    const stamp = await recordStamp(this.recordPath(id));
    if (previous && previous.stamp === stamp) return previous.record;
    let record: ConversationRecord | null;
    try {
      record = await this.#readRecord(id);
      this.#unreadableRecords.delete(id);
    } catch {
      this.#records.delete(id);
      if (!this.#unreadableRecords.has(id)) this.#warn(MESSAGE.UnreadableThread(id));
      this.#unreadableRecords.add(id);
      return null;
    }
    const current = this.#records.get(id);
    // A durable local append that completed during this read owns the newer record.
    if (current && current !== previous) return current.record;
    if (record) this.#records.set(id, { stamp, record });
    else this.#records.delete(id);
    return record;
  }

  /** Publish the derived record only after the atomic head write is durable. */
  async #saveRecord(threadId: string, record: ConversationRecord): Promise<void> {
    await atomicWriteJson(this.recordPath(threadId), record);
    const stamp = await recordStamp(this.recordPath(threadId));
    this.#records.set(threadId, { stamp, record: structuredClone(record) });
  }

  /**
   * Every thread's committed head at one instant: taken under the single-writer lock, so no
   * append is half-way through. Readers that follow all threads with one cursor list each thread
   * only up to this head (see {@link EventStore.listAllSince}).
   */
  async headsSnapshot(): Promise<Array<{ threadId: string; head: string | null }>> {
    await this.listThreads();
    return this.#lock.run(async () =>
      [...this.#records.values()].map(({ record }) => ({ threadId: record.id, head: record.latest_event_id })),
    );
  }

  /**
   * Every thread's events after one cursor, and the cursor to pass next time. Each thread is read
   * only up to its snapshotted head and the cursor is the newest of those heads, so an event
   * appended while the threads are being read sorts after the cursor and arrives on the next call
   * instead of being passed over. `limit` keeps the newest events across all threads.
   */
  async listAllSince(after?: string, limit?: number): Promise<{ events: EventEnvelope[]; cursor: string | null }> {
    const heads = await this.headsSnapshot();
    let cursor = after ?? null;
    // Ids first, across every thread; then only the bodies that make the page are read.
    const wanted: EventRef[] = [];
    for (const { threadId, head } of heads) {
      if (head === null) continue;
      cursor = laterId(cursor, head);
      if (after && compareIds(head, after) <= 0) continue;
      wanted.push(...(await this.#refsSince(threadId, head, after, limit)));
    }
    wanted.sort((a, b) => compareIds(a.id, b.id));
    return { events: await this.#readBodies(wanted, limit ? { limit, tail: true } : {}), cursor };
  }

  /** One thread's events after `after` up to `head`, the newest `limit` of them when given. */
  async #refsSince(threadId: string, head: string, after?: string, limit?: number): Promise<EventRef[]> {
    const ids = await this.#idsThrough(threadId, head);
    const range = ids.slice(after ? countThrough(ids, after) : 0, countThrough(ids, head));
    return (limit ? range.slice(-limit) : range).map((id) => ({ threadId, id }));
  }

  async getRecord(threadId: string): Promise<ConversationRecord> {
    const record = await this.#readRecord(threadId);
    if (!record) throw new ThreadNotFound(threadId);
    return record;
  }

  /** Do not guess a committed head from event filenames when its index record cannot be read. */
  async #readRecord(threadId: string): Promise<ConversationRecord | null> {
    try {
      const record = await readJsonIfExists<ConversationRecord>(this.recordPath(threadId));
      if (!record) return null;
      const headValid = record.latest_event_id === null || typeof record.latest_event_id === "string";
      const readable = record.id === threadId && headValid && typeof record.created_at === "string";
      if (!readable) throw new Error(MESSAGE.UnreadableThread(threadId));
      return record;
    } catch {
      throw new Error(MESSAGE.UnreadableThread(threadId));
    }
  }

  /**
   * Retitle or re-tag a thread. The record is the index; the `thread_updated` event is the
   * durable truth — a rebuilt index could recover titles and metadata from the log alone.
   */
  async updateThread(
    threadId: string,
    patch: { title?: string; metadata?: Record<string, unknown> },
  ): Promise<ConversationRecord> {
    const updated = await this.#lock.run(async () => {
      const record = await this.getRecord(threadId);
      if (patch.title !== undefined) record.title = patch.title;
      if (patch.metadata !== undefined) record.metadata = { ...record.metadata, ...patch.metadata };
      record.updated_at = new Date().toISOString();
      await this.#saveRecord(threadId, record);
      return record;
    });
    await this.appendEvents(threadId, [
      {
        type: EventKind.ThreadUpdated,
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.metadata !== undefined ? { metadata: patch.metadata } : {}),
      },
    ]);
    return updated;
  }

  async head(threadId: string): Promise<string | null> {
    return (await this.getRecord(threadId)).latest_event_id;
  }

  async threadExists(threadId: string): Promise<boolean> {
    return (await readJsonIfExists<ConversationRecord>(this.recordPath(threadId))) !== null;
  }

  // ── crash recovery ───────────────────────────────────────────────────────────────────────
  /**
   * Quarantine *uncommitted* events — files that exist on disk but sort after the recorded head.
   *
   * They are the tail of a batch whose head update never happened (power loss, `kill -9`
   * between two writes). The head is authoritative, so those events were never observed by
   * anyone: leaving them in place would make a partially-written batch reappear as soon as the
   * head moved past them. They are moved to `events/.uncommitted/` rather than deleted — the log
   * stays append-only and the evidence survives for forensics — and readers never see them.
   *
   * Must be called while holding the write lock. Runs once per thread per store instance; the
   * substrate is the single writer, so nothing can create new orphans behind our back.
   *
   * An uncommitted tail is one batch. Files after the head that include the thread's
   * `thread_created`, or more than {@link MAX_UNCOMMITTED_TAIL} of them, are committed history
   * behind a head that went backwards (a log written with the clock set back, before ids carried
   * their floor over): they are kept in place, reported, and returned so the next id sorts after
   * them and the head moves past them again.
   */
  async #recoverUncommitted(threadId: string, head: string | null): Promise<{ kept: string[] }> {
    if (this.#recovered.has(threadId)) return { kept: [] };
    this.#recovered.add(threadId);
    const dir = this.eventsDir(threadId);
    const files = await listJsonFiles(dir);
    const orphans = files.filter((file) => head === null || compareIds(eventIdOf(file), head) > 0);
    if (orphans.length === 0) return { kept: [] };
    if (head !== null && (await this.#isCommittedHistory(dir, orphans))) {
      this.#warn(MESSAGE.KeptBehindHead(threadId, orphans.length, head));
      return { kept: orphans.map(eventIdOf) };
    }
    const quarantine = path.join(dir, ".uncommitted");
    await ensureDir(quarantine);
    this.#index.delete(threadId);
    for (const file of orphans) {
      await rename(path.join(dir, file), path.join(quarantine, file));
    }
    return { kept: [] };
  }

  /**
   * Events after the head that are too many to be one torn batch, or that include the thread's
   * start, are committed history behind a head that went backwards, not a crashed append.
   */
  async #isCommittedHistory(dir: string, orphans: string[]): Promise<boolean> {
    if (orphans.length > MAX_UNCOMMITTED_TAIL) return true;
    return this.#holdsThreadStart(dir, orphans);
  }

  /** Whether one of these event files is the thread's first event, which no later batch writes. */
  async #holdsThreadStart(dir: string, files: string[]): Promise<boolean> {
    for (const file of files) {
      const raw = await readJsonIfExists<{ data?: { type?: unknown } }>(path.join(dir, file)).catch(() => null);
      if (raw?.data?.type === EventKind.ThreadCreated) return true;
    }
    return false;
  }

  /** Ids quarantined by crash recovery, for the run report. */
  async uncommittedEvents(threadId: string): Promise<string[]> {
    const files = await listJsonFiles(path.join(this.eventsDir(threadId), ".uncommitted"));
    return files.map(eventIdOf);
  }

  // ── append ───────────────────────────────────────────────────────────────────────────────
  /**
   * Append a batch of events under the single-writer lock, with an optimistic head check.
   * Port of `basic.rs::append_events` + `ensure_conversation_head`.
   */
  async appendEvents(threadId: string, batch: EventData[], options: AppendOptions = {}): Promise<AppendResult> {
    assertEventBatch(batch);
    if (batch.length === 0) {
      const head = await this.head(threadId);
      return { latestEventId: head ?? "", events: [] };
    }
    const redact = this.#redact;
    const events = redact ? batch.map((data) => redactDeep(data, redact)) : batch;
    return this.#lock.run(() => this.#writeBatch(threadId, events, options));
  }

  /** The locked half of {@link EventStore.appendEvents}: head check, recovery, one file per event, then the head. */
  async #writeBatch(threadId: string, batch: EventData[], options: AppendOptions): Promise<AppendResult> {
    const record = await this.getRecord(threadId);
    if (options.expectedHead !== undefined && record.latest_event_id !== options.expectedHead) {
      throw new HeadMismatch(record.latest_event_id, options.expectedHead);
    }
    const { kept } = await this.#recoverUncommitted(threadId, record.latest_event_id);
    const written: EventEnvelope[] = [];
    let latest = record.latest_event_id;
    // The floor is the stored log, not only this process's memory: a new id always sorts after
    // the head (and after any history recovery kept past it), whatever the wall clock says.
    const floor = kept.reduce<string | null>(laterId, latest);
    for (const data of batch) {
      const id = this.#ids(this.#now(), floor);
      const event: EventEnvelope = {
        id,
        thread_id: threadId,
        session_id: options.sessionId ?? null,
        turn_id: options.turnId ?? null,
        created_at: uuid7Timestamp(id),
        data,
      };
      // Atomic per event: a crash here leaves every earlier event intact and loadable.
      await atomicWriteJson(this.eventPath(threadId, id), event);
      this.#indexed(threadId, id);
      written.push(event);
      latest = id;
    }
    record.latest_event_id = latest;
    record.updated_at = new Date().toISOString();
    await this.#saveRecord(threadId, record);
    // Notify only after the head is durable, so subscribers never observe a phantom event.
    for (const event of written) this.#notify(threadId, event);
    // The batch is never empty here, so `latest` is the id just written.
    return { latestEventId: latest ?? "", events: written };
  }

  // ── read ─────────────────────────────────────────────────────────────────────────────────
  /**
   * Read the log. **The head is the visibility boundary**: events beyond `latest_event_id` are
   * uncommitted (see {@link EventStore.uncommittedEvents}) and are never returned, which is what
   * makes a batch atomic to every reader.
   */
  async listEvents(threadId: string, options: ListOptions = {}): Promise<EventEnvelope[]> {
    const record = await this.getRecord(threadId);
    const head = record.latest_event_id;
    if (head === null) return [];
    const upTo = options.upToInclusive && compareIds(options.upToInclusive, head) < 0 ? options.upToInclusive : head;
    const ids = await this.#idsThrough(threadId, head);
    const selected = ids.slice(options.after ? countThrough(ids, options.after) : 0, countThrough(ids, upTo));
    return this.#readBodies(
      selected.map((id) => ({ threadId, id })),
      { ...(options.limit ? { limit: options.limit } : {}), ...(options.tail ? { tail: true } : {}) },
    );
  }

  /** Read only the selected page bodies; the id index finds them without parsing old messages. */
  async chatPage(threadId: string, before?: string): Promise<ChatPage> {
    const record = await this.getRecord(threadId);
    const head = record.latest_event_id;
    // A page is made of rows the chat shows: withdrawn ones would leave it empty after a rewind.
    const rewinds = rewindsOf([], record.metadata);
    const listed = head === null ? [] : await this.#idsThrough(threadId, head);
    const ids = rewinds.length ? listed.filter((id) => !withdrawnId(id, rewinds)) : listed;
    const end = head === null ? 0 : Math.min(countThrough(ids, head), before ? countBefore(ids, before) : ids.length);
    const start = Math.max(0, end - CHAT_PAGE_SIZE);
    const events = await this.#readBodies(ids.slice(start, end).map((id) => ({ threadId, id })));
    return {
      events,
      before: events[0]?.id ?? null,
      hasMore: start > 0,
      context: before ? [] : await this.chatState(threadId),
    };
  }

  /**
   * The thread's event ids, sorted, holding at least everything up to `head`. The first read
   * lists the folder under the write lock, so no append lands between the listing and the index
   * going live; after that this store's appends extend it. An index without the head is stale
   * (another handle on the folder appended) and is listed again.
   */
  async #idsThrough(threadId: string, head: string): Promise<string[]> {
    const known = this.#index.get(threadId);
    if (known && known[countThrough(known, head) - 1] === head) return known;
    return this.#lock.run(async () => {
      const ids = (await listJsonFiles(this.eventsDir(threadId))).map(eventIdOf);
      this.#index.set(threadId, ids);
      return ids;
    });
  }

  /** An event file this store just wrote, under the lock, joins its thread's index if one is loaded. */
  #indexed(threadId: string, id: string): void {
    const ids = this.#index.get(threadId);
    if (!ids) return;
    const at = countThrough(ids, id);
    if (ids[at - 1] !== id) ids.splice(at, 0, id);
  }

  /**
   * These events' bodies, in the given order, a bounded number at a time. An entry persisted
   * before appends were validated is skipped, so the thread stays readable. With a `limit`,
   * reading stops once that many are in hand, counted from the end when `tail`; the result is
   * always in the given order.
   */
  async #readBodies(
    wanted: readonly EventRef[],
    options: { limit?: number; tail?: boolean } = {},
  ): Promise<EventEnvelope[]> {
    const order = options.tail ? [...wanted].reverse() : wanted;
    // No limit (or a zero one) reads everything.
    const limit = options.limit || Number.POSITIVE_INFINITY;
    const inGivenOrder = (events: EventEnvelope[]) => (options.tail ? events.reverse() : events);
    const out: EventEnvelope[] = [];
    // A sliding window: a new file opens as soon as one is consumed, so one slow read never holds
    // a whole batch. Never more open than the limit still needs: a bounded read opens only what
    // it returns.
    const reads = new Map<number, Promise<EventEnvelope>>();
    let started = 0;
    for (let at = 0; at < order.length; at++) {
      const room = () => started - at < READ_CONCURRENCY && out.length + started - at < limit;
      for (let ref = order[started]; ref && room(); ref = order[started]) reads.set(started++, this.#readEvent(ref));
      const read = reads.get(at);
      reads.delete(at);
      if (!read) break;
      const event = await read;
      if (!isEventData(event.data)) continue;
      out.push(event);
      if (out.length >= limit) return inGivenOrder(out);
    }
    return inGivenOrder(out);
  }

  /** Keep the committed position visible when its body is corrupt; never rewrite the original file. */
  async #readEvent({ threadId, id }: EventRef): Promise<EventEnvelope> {
    try {
      const raw = await readJson<Record<string, unknown>>(this.eventPath(threadId, id));
      const event = normalizeEvent(raw);
      if (event.id !== id || event.thread_id !== threadId || !isEventData(event.data)) throw new Error("Invalid event");
      return event;
    } catch {
      return {
        id,
        thread_id: threadId,
        session_id: null,
        turn_id: null,
        created_at: new Date(uuid7Timestamp(id)).toISOString(),
        data: {
          type: EventKind.Error,
          message:
            "Stored event is unreadable. Its original file is preserved; restore it from a backup to recover its contents.",
        },
      };
    }
  }

  /** Checkpointed separately from transcript pages; old stores rebuild once in bounded batches. */
  async chatState(threadId: string): Promise<EventEnvelope[]> {
    const record = await this.getRecord(threadId);
    const head = record.latest_event_id;
    // Facts are folded over the conversation as it reads after its rewinds. A fold cannot take
    // a fact back, so a new rewind rebuilds the checkpoint from the start.
    const rewinds = rewindsOf([], record.metadata);
    const file = path.join(this.threadDir(threadId), "chat-context.json");
    const saved = await readJsonIfExists<{
      version: number;
      head: string | null;
      rewinds?: number;
      events: EventEnvelope[];
    }>(file).catch(() => null);
    const valid =
      saved?.version === CHAT_CONTEXT_VERSION &&
      (saved.rewinds ?? 0) === rewinds.length &&
      (!saved.head || (head && saved.head <= head));
    let cursor = valid ? saved.head : null;
    let events = valid ? saved.events : [];
    while (head && cursor !== head) {
      const batch = await this.listEvents(threadId, {
        ...(cursor ? { after: cursor } : {}),
        upToInclusive: head,
        limit: CHAT_CONTEXT_BATCH,
      });
      const last = batch.at(-1);
      if (!last) break;
      events = chatContext(events, withoutRewound(batch, rewinds));
      cursor = last.id;
    }
    if (!valid || saved.head !== head) {
      await atomicWriteJson(file, { version: CHAT_CONTEXT_VERSION, head, rewinds: rewinds.length, events });
    }
    return events;
  }

  /**
   * A fold over one thread's whole log, checkpointed beside it (`<name>.json`) with the head it
   * covers, so the next call reads and folds only the events after that head. Derived and
   * disposable like every index here: a missing or unreadable checkpoint, another `version`, or
   * one ahead of the log (a restored backup) is dropped and the whole log folded again.
   */
  async foldThread<S>(threadId: string, spec: ThreadFold<S>): Promise<{ head: string | null; state: S }> {
    const head = await this.head(threadId);
    const file = path.join(this.threadDir(threadId), `${plainId(spec.name, "checkpoint name")}.json`);
    const saved = await readJsonIfExists<{ version: number; head: string | null; state: S }>(file).catch(() => null);
    const usable =
      saved?.version === spec.version && (saved.head === null || (head !== null && compareIds(saved.head, head) <= 0));
    const from = usable ? saved.head : null;
    const events =
      head === null || from === head
        ? []
        : await this.listEvents(threadId, { ...(from ? { after: from } : {}), upToInclusive: head });
    const state = spec.fold(usable ? saved.state : null, events);
    if (!usable || saved.head !== head) await atomicWriteJson(file, { version: spec.version, head, state });
    return { head, state };
  }

  async getEvent(threadId: string, eventId: string): Promise<EventEnvelope | null> {
    if (!(await stat(this.eventPath(threadId, eventId)).catch(() => null))) return null;
    return this.#readEvent({ threadId, id: eventId });
  }

  /** Every message ever appended to the thread, in order — the raw material for prompts. */
  async listMessages(threadId: string, options: ListOptions = {}): Promise<Message[]> {
    const events = await this.listEvents(threadId, options);
    const messages: Message[] = [];
    for (const event of events) {
      if (event.data.type === EventKind.Messages) messages.push(...event.data.messages);
    }
    return messages;
  }

  // ── watch ────────────────────────────────────────────────────────────────────────────────
  /**
   * Subscribe to a thread. With `replay: true` the existing log is delivered first (Exo's
   * `watch_events` semantics), which is what lets a UI attach at any time and stay consistent.
   *
   * Live events that arrive *during* the replay read are buffered and flushed afterwards, and
   * ids already delivered by the replay are suppressed — so a subscriber always sees each event
   * exactly once, in log order, no matter when it attached.
   */
  watch(
    threadId: string,
    subscriber: EventSubscriber,
    options: { replay?: boolean; after?: string } = {},
  ): Subscription {
    let set = this.#subscribers.get(threadId);
    if (!set) {
      set = new Set();
      this.#subscribers.set(threadId, set);
    }

    let replaying = Boolean(options.replay);
    const buffered: EventEnvelope[] = [];
    const delivery: EventSubscriber = (event) => {
      if (replaying) buffered.push(event);
      else subscriber(event);
    };
    set.add(delivery);

    const close = () => {
      set.delete(delivery);
      if (set.size === 0) this.#subscribers.delete(threadId);
    };

    if (!replaying) return { close, ready: Promise.resolve() };

    const ready = (async () => {
      try {
        const existing = await this.listEvents(threadId, options.after ? { after: options.after } : {});
        const delivered = new Set<string>();
        for (const event of existing) {
          delivered.add(event.id);
          subscriber(event);
        }
        for (const event of buffered) {
          if (!delivered.has(event.id)) subscriber(event);
        }
      } finally {
        buffered.length = 0;
        replaying = false;
      }
    })();

    return { close, ready };
  }

  #notify(threadId: string, event: EventEnvelope): void {
    const set = this.#subscribers.get(threadId);
    if (!set) return;
    for (const subscriber of [...set]) {
      try {
        subscriber(event);
      } catch {
        /* a broken subscriber must never break the log */
      }
    }
  }

  // ── fork ─────────────────────────────────────────────────────────────────────────────────
  /**
   * Fork = copy-and-rewrite, **never truncate** (port of `basic.rs::fork_conversation`).
   * Events `<= upToInclusive` are copied under fresh UUIDv7 ids into a new thread, artifacts are
   * carried over, and a `thread_forked` event records the lineage. Rewinding the log is just
   * forking from an earlier event id.
   */
  async forkThread(
    sourceThreadId: string,
    upToInclusive: string,
    options: { title?: string; threadId?: string } = {},
  ): Promise<string> {
    const source = await this.getRecord(sourceThreadId);
    const events = await this.listEvents(sourceThreadId, { upToInclusive });
    const newThreadId = options.threadId ?? uuidv7();
    const now = new Date().toISOString();

    await this.#lock.run(async () => {
      await ensureDir(this.eventsDir(newThreadId));
      this.#index.delete(newThreadId);
      const record: ConversationRecord = {
        id: newThreadId,
        agent_id: this.agentId,
        created_at: now,
        updated_at: now,
        latest_event_id: null,
        title: options.title ?? `${source.title ?? "thread"} (fork)`,
        parent: { thread_id: sourceThreadId, up_to_inclusive: upToInclusive },
      };
      await this.#saveRecord(newThreadId, record);

      let latest: string | null = null;
      // Copies sort after the source's history even when the clock is behind it.
      const floor = (await this.getRecord(sourceThreadId)).latest_event_id;
      for (const event of events) {
        const id = this.#ids(this.#now(), floor);
        const copy: EventEnvelope = {
          id,
          thread_id: newThreadId,
          session_id: event.session_id,
          turn_id: event.turn_id,
          created_at: uuid7Timestamp(id),
          data: event.data,
        };
        await atomicWriteJson(this.eventPath(newThreadId, id), copy);
        latest = id;
      }
      record.latest_event_id = latest;
      await this.#saveRecord(newThreadId, record);

      // Artifacts are prefix-copied so the fork is self-contained.
      for (const artifactId of await listDirs(this.artifactsDir(sourceThreadId))) {
        for (const file of await listJsonFiles(path.join(this.artifactsDir(sourceThreadId), artifactId))) {
          const value = await readJson<ArtifactVersion>(path.join(this.artifactsDir(sourceThreadId), artifactId, file));
          await atomicWriteJson(path.join(this.artifactsDir(newThreadId), artifactId, file), value);
        }
      }
    });

    await this.appendEvents(newThreadId, [
      { type: EventKind.ThreadForked, source_thread_id: sourceThreadId, up_to_inclusive: upToInclusive },
    ]);
    return newThreadId;
  }

  // ── artifacts ────────────────────────────────────────────────────────────────────────────
  async writeArtifact<T>(threadId: string, artifactId: string, value: T): Promise<number> {
    return this.#lock
      .run(async () => {
        const dir = path.join(this.artifactsDir(threadId), plainId(artifactId, "artifact id"));
        const versions = await listJsonFiles(dir);
        const version = versions.length + 1;
        const record: ArtifactVersion<T> = {
          artifact_id: artifactId,
          version,
          created_at: new Date().toISOString(),
          value,
        };
        await atomicWriteJson(path.join(dir, `${String(version).padStart(6, "0")}.json`), record);
        return version;
      })
      .then(async (version) => {
        await this.appendEvents(threadId, [
          {
            type: EventKind.ArtifactWritten,
            artifact_id: artifactId,
            path: path.join("artifacts", artifactId, `${String(version).padStart(6, "0")}.json`),
            version,
          },
        ]);
        return version;
      });
  }

  async readArtifact<T>(threadId: string, artifactId: string): Promise<T | null> {
    const dir = path.join(this.artifactsDir(threadId), plainId(artifactId, "artifact id"));
    const versions = await listJsonFiles(dir);
    const last = versions.at(-1);
    if (!last) return null;
    const record = await readJson<ArtifactVersion<T>>(path.join(dir, last));
    return record.value;
  }

  async listArtifactVersions<T>(threadId: string, artifactId: string): Promise<ArtifactVersion<T>[]> {
    const dir = path.join(this.artifactsDir(threadId), plainId(artifactId, "artifact id"));
    const out: ArtifactVersion<T>[] = [];
    for (const file of await listJsonFiles(dir)) {
      out.push(await readJson<ArtifactVersion<T>>(path.join(dir, file)));
    }
    return out;
  }
}

/** One event, by where it lives. */
interface EventRef {
  threadId: string;
  id: string;
}

/** How many of the sorted `ids` sort at or before `id`: where a read after `id` starts. */
function countThrough(ids: readonly string[], id: string): number {
  let lo = 0;
  let hi = ids.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    // `mid` is always below `ids.length`; the check only narrows the index read.
    const midId = ids[mid];
    if (midId !== undefined && compareIds(midId, id) <= 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** An event file's id: its name without `.json`. */
function eventIdOf(file: string): string {
  return file.slice(0, -".json".length);
}

/** Whichever of two ids sorts later; `null` (nothing yet) loses to any id. */
function laterId(current: string | null, id: string): string {
  return current === null || compareIds(id, current) > 0 ? id : current;
}

/**
 * The log is written by an editable harness over RPC; an entry that is not an event would be
 * persisted for good and break every reader of the thread. Refuse the whole batch first.
 */
function assertEventBatch(batch: unknown): asserts batch is EventData[] {
  if (!Array.isArray(batch)) throw new TypeError(MESSAGE.BatchNotList);
  batch.forEach((data, index) => {
    if (!isEventData(data)) throw new TypeError(MESSAGE.BatchEntryNotEvent(index));
  });
}

/** How many of the sorted `ids` sort strictly before `id`. */
function countBefore(ids: readonly string[], id: string): number {
  const through = countThrough(ids, id);
  return ids[through - 1] === id ? through - 1 : through;
}

/**
 * Thread and artifact ids reach the store from the sandboxed harness over RPC. Each names one
 * directory under the store, so a separator or a `..` in one would write outside it.
 */
function plainId(id: string, what: string): string {
  const plain = typeof id === "string" && PLAIN_ID.test(id) && !id.includes("..");
  if (!plain) throw new Error(MESSAGE.InvalidId(what, id));
  return id;
}

/** An event body: a plain object with a string `type`. Anything else is refused on write and skipped on read. */
function isEventData(data: unknown): data is EventData {
  return (
    typeof data === "object" &&
    data !== null &&
    !Array.isArray(data) &&
    typeof (data as { type?: unknown }).type === "string"
  );
}

/** Accept Exo's `conversation_id` alias on read; always write `thread_id`. */
export function normalizeEvent(raw: Record<string, unknown>): EventEnvelope {
  const threadId = (raw.thread_id ?? raw[RAW_ALIAS_KEY]) as string;
  return {
    id: raw.id as string,
    thread_id: threadId,
    session_id: (raw.session_id as string | null) ?? null,
    turn_id: (raw.turn_id as string | null) ?? null,
    created_at: raw.created_at as string,
    data: raw.data as EventEnvelope["data"],
  };
}

/** Atomic replacement changes inode/ctime even when a writer preserves size and mtime. */
async function recordStamp(file: string): Promise<string> {
  const info = await stat(file, { bigint: true }).catch(() => null);
  return info ? `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}` : "";
}
