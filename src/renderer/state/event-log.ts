/**
 * The renderer's copy of the event log: the all-threads feed main hands out after a cursor, and a
 * per-thread map built from it. A view that needs one thread's whole story (the Builds stage and
 * its workers) asks for a backfill, and that thread's slice then holds its full log, not just
 * what the bounded feed still carries.
 *
 * Actions are pure `(state, input) => state`; `createEventLogStore` binds them to a `StudioApi`.
 */
import { createStore, type StoreApi } from "zustand/vanilla";
import { followsTail, mergeChatEvents } from "../../shared/chat-history.ts";
import type { EventEnvelope, EventFeed, StudioApi } from "../../shared/studio-api.ts";
import { appendFeed, EventRefreshAction, eventRefreshAction, FEED_WINDOW } from "../event-feed.ts";
import { createRefresher } from "./refresher.ts";

/** Where a thread's whole-log read stands; a thread with no entry has not asked for one. */
export const BackfillState = {
  Loading: "loading",
  Done: "done",
} as const;
export type BackfillState = (typeof BackfillState)[keyof typeof BackfillState];

/** Recent unobserved thread slices retained alongside the active views. */
export const THREAD_SLICES_MAX = 64;

export interface EventLogState {
  pins: Record<string, number>;
  /** Every thread's recent events, oldest first, at most `FEED_WINDOW`. */
  feed: EventEnvelope[];
  /** One array per thread. A slice keeps its identity while its thread gets nothing new. */
  byThread: Record<string, EventEnvelope[]>;
  /** Where the next read continues: the cursor main returned, never an event id of ours. */
  cursor: string | undefined;
  /** No read before the bootstrap has set the cursor: without one main lists every whole log. */
  bootstrapped: boolean;
  /** A refresh was asked for before the bootstrap; it runs right after it. */
  deferred: boolean;
  /** Threads whose whole log was read: their slices are not trimmed to the window. */
  backfill: Record<string, BackfillState>;
}

export const initialEventLog = (): EventLogState => ({
  pins: {},
  feed: [],
  byThread: {},
  cursor: undefined,
  bootstrapped: false,
  deferred: false,
  backfill: {},
});

/** Merge events into the per-thread map; threads that got nothing keep their array. */
function sliced(state: EventLogState, events: readonly EventEnvelope[]): Record<string, EventEnvelope[]> {
  if (events.length === 0) return state.byThread;
  const incoming = new Map<string, EventEnvelope[]>();
  for (const event of events) {
    const list = incoming.get(event.thread_id) ?? [];
    list.push(event);
    incoming.set(event.thread_id, list);
  }
  let next = state.byThread;
  for (const [threadId, fresh] of incoming) {
    const current = next[threadId] ?? [];
    const merged = followsTail(current, fresh) ? [...current, ...fresh] : mergeChatEvents(current, fresh);
    if (merged.length === current.length && merged.every((event, index) => event.id === current[index]?.id)) continue;
    if (next === state.byThread) next = { ...next };
    next[threadId] = state.backfill[threadId] === BackfillState.Done ? merged : merged.slice(-FEED_WINDOW);
  }
  return next;
}

/** A bootstrap replaces the log: its tail and the cursor to continue from. */
export function eventLogBootstrapped(
  state: EventLogState,
  boot: { events: EventEnvelope[]; eventsCursor?: string | null },
): EventLogState {
  const base: EventLogState = { ...initialEventLog(), deferred: state.deferred, pins: state.pins };
  return {
    ...base,
    feed: boot.events.slice(-FEED_WINDOW),
    byThread: pruneSlices({ ...base, byThread: sliced(base, boot.events) }).byThread,
    cursor: boot.eventsCursor ?? boot.events.at(-1)?.id,
    bootstrapped: true,
  };
}

/** One read of the feed: merged without duplicates, the cursor moved to where main says. */
export function eventsArrived(state: EventLogState, read: EventFeed): EventLogState {
  const cursor = read.cursor ? read.cursor : state.cursor;
  const feed = appendFeed(state.feed, read.events);
  const byThread = sliced(state, read.events);
  const unchanged = cursor === state.cursor && feed === state.feed && byThread === state.byThread;
  if (unchanged) return state;
  return pruneSlices({ ...state, cursor, feed, byThread });
}

export function backfillStarted(state: EventLogState, threadId: string): EventLogState {
  return { ...state, backfill: { ...state.backfill, [threadId]: BackfillState.Loading } };
}

/** A thread's whole log, read once: merged into its slice, which is then kept whole. */
export function threadBackfilled(
  state: EventLogState,
  threadId: string,
  events: readonly EventEnvelope[],
): EventLogState {
  const current = state.byThread[threadId] ?? [];
  return {
    ...state,
    byThread: {
      ...state.byThread,
      [threadId]: mergeChatEvents(
        events.filter((event) => event.thread_id === threadId),
        current,
      ),
    },
    backfill: { ...state.backfill, [threadId]: BackfillState.Done },
  };
}

/** A backfill that failed is asked for again by the next view that wants it. */
export function backfillFailed(state: EventLogState, threadId: string): EventLogState {
  const { [threadId]: _dropped, ...rest } = state.backfill;
  return { ...state, backfill: rest };
}

/** Forget a removed thread and every reference to its retained history. */
export function threadForgotten(state: EventLogState, threadId: string): EventLogState {
  const { [threadId]: _events, ...byThread } = state.byThread;
  const { [threadId]: _backfill, ...backfill } = state.backfill;
  const { [threadId]: _pin, ...pins } = state.pins;
  return { ...state, byThread, backfill, pins };
}

function pruneSlices(state: EventLogState): EventLogState {
  const unpinned = Object.keys(state.byThread).filter((id) => !state.pins[id]);
  if (unpinned.length <= THREAD_SLICES_MAX) return state;
  const ordered = unpinned.sort((a, b) => {
    const left = state.byThread[a]?.at(-1)?.id ?? "";
    const right = state.byThread[b]?.at(-1)?.id ?? "";
    return left < right ? -1 : Number(left > right);
  });
  let next = state;
  for (const id of ordered.slice(0, ordered.length - THREAD_SLICES_MAX)) next = threadForgotten(next, id);
  return next;
}

/** Last observer releases full history, retaining only the bounded recent tail. */
export function threadReleased(state: EventLogState, threadId: string): EventLogState {
  const count = state.pins[threadId] ?? 0;
  if (count > 1) return { ...state, pins: { ...state.pins, [threadId]: count - 1 } };
  const { [threadId]: _pin, ...pins } = state.pins;
  const { [threadId]: _backfill, ...backfill } = state.backfill;
  const current = state.byThread[threadId];
  const byThread = current ? { ...state.byThread, [threadId]: current.slice(-FEED_WINDOW) } : state.byThread;
  return pruneSlices({ ...state, pins, backfill, byThread });
}

/** A new bootstrap is on its way: nothing reads until it has set the cursor again. */
export function eventLogUnbootstrapped(state: EventLogState): EventLogState {
  return { ...state, bootstrapped: false, deferred: false };
}

const EMPTY: EventEnvelope[] = [];
/** One thread's events, oldest first (a stable empty array for a thread with none). */
export const threadLog = (state: EventLogState, threadId: string | null | undefined): EventEnvelope[] =>
  (threadId ? state.byThread[threadId] : undefined) ?? EMPTY;

export interface EventLogStore extends StoreApi<EventLogState> {
  /** Read what is new; before the bootstrap this is remembered and runs right after it. */
  refresh(): Promise<void>;
  bootstrap(boot: { events: EventEnvelope[]; eventsCursor?: string | null }): void;
  /** Start again: a bootstrap is being retried. Reads in flight land nowhere. */
  unbootstrap(): void;
  /** Read a thread's whole log once, for a view that must see all of it. */
  backfill(threadId: string): void;
  /** Pin a full log until this viewer releases it. */
  watchThread(threadId: string): () => void;
  /** Drop a deleted or archived conversation. */
  forgetThread(threadId: string): void;
  /**
   * Hear every record as it arrives from the feed: the bootstrap's tail, then each read after it.
   * A record can arrive again after a new bootstrap; the listener tells them apart. Returns the stop.
   */
  onArrived(listener: (events: readonly EventEnvelope[]) => void): () => void;
}

export function createEventLogStore(
  api: Pick<StudioApi, "events" | "threadEvents">,
  publish?: (apply: () => void) => void,
): EventLogStore {
  const store = createStore<EventLogState>()(() => initialEventLog());
  const listeners = new Set<(events: readonly EventEnvelope[]) => void>();
  const arrived = (events: readonly EventEnvelope[]): void => {
    if (events.length === 0) return;
    for (const listener of listeners) listener(events);
  };
  const refresher = createRefresher(
    () => api.events(store.getState().cursor),
    (read) => {
      store.setState((state) => eventsArrived(state, read), true);
      arrived(read.events);
    },
    { publish },
  );
  const generations = new Map<string, object>();
  const backfill = (threadId: string): void => {
    if (store.getState().backfill[threadId]) return;
    const generation = {};
    generations.set(threadId, generation);
    store.setState((state) => backfillStarted(state, threadId), true);
    void api.threadEvents(threadId).then(
      (events) => {
        if (generations.get(threadId) !== generation) return;
        generations.delete(threadId);
        store.setState((state) => threadBackfilled(state, threadId, events), true);
      },
      () => {
        if (generations.get(threadId) !== generation) return;
        generations.delete(threadId);
        store.setState((state) => backfillFailed(state, threadId), true);
      },
    );
  };
  return Object.assign(store, {
    refresh(): Promise<void> {
      const state = store.getState();
      if (
        eventRefreshAction({ bootstrapped: state.bootstrapped, inFlight: refresher.inFlight }) ===
        EventRefreshAction.Defer
      ) {
        if (!state.deferred) store.setState({ deferred: true });
        return Promise.resolve();
      }
      return refresher.request();
    },
    bootstrap(boot: { events: EventEnvelope[]; eventsCursor?: string | null }): void {
      const deferred = store.getState().deferred;
      store.setState((state) => ({ ...eventLogBootstrapped(state, boot), deferred: false }), true);
      arrived(boot.events);
      for (const id of Object.keys(store.getState().pins)) backfill(id);
      if (deferred) void refresher.request();
    },
    unbootstrap(): void {
      refresher.reset();
      generations.clear();
      store.setState((state) => eventLogUnbootstrapped(state), true);
    },
    backfill,
    watchThread(threadId: string): () => void {
      store.setState((state) => ({ pins: { ...state.pins, [threadId]: (state.pins[threadId] ?? 0) + 1 } }));
      backfill(threadId);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if ((store.getState().pins[threadId] ?? 0) <= 1) generations.delete(threadId);
        store.setState((state) => threadReleased(state, threadId), true);
      };
    },
    forgetThread(threadId: string): void {
      generations.delete(threadId);
      store.setState((state) => threadForgotten(state, threadId), true);
    },
    onArrived(listener: (events: readonly EventEnvelope[]) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
}
