/**
 * Live run summaries without re-sending the run. A summary's `graphEvents` is every drawn custom
 * event of the run — thousands on a long run, several MiB — and every run event invalidates it.
 * Sending the whole list per event kept the UI renderer copying multi-MiB replies back to back
 *, so a subscriber names what it already holds and main sends only what follows.
 * Main memoizes the summary itself (`main/run-summary-cache.ts`); a preview change only patches
 * the summary's `preview`.
 */
import type { EventEnvelope } from "./event-log.ts";
import type { RunSummary } from "./run-summary.ts";
import { UiEvent } from "./ui-events.ts";

/** Least time between the starts of two fetches of one run's summary. */
export const RUN_SUMMARY_SPACING_MS = 250;

/** What a subscriber already holds of a run's graph events: how many, and the last one's id. */
export interface GraphCursor {
  count: number;
  lastId: string;
}

/** A cursor as the renderer sent it: a count that fits `all` and names its last held event. */
function continues(all: EventEnvelope[], cursor: GraphCursor | null | undefined): cursor is GraphCursor {
  const count = cursor?.count;
  if (typeof count !== "number" || !Number.isInteger(count) || count <= 0 || count > all.length) return false;
  return typeof cursor?.lastId === "string" && all[count - 1]?.id === cursor.lastId;
}

/**
 * The graph events from the last one `cursor` holds on, and the index they start at. The held
 * last event is sent again: the compacted graph stamps its last event with the time of the run's
 * latest trace (`graphLastAt`, shared/run-graph-events.ts), which moves as traces arrive. When the
 * held prefix no longer matches — an event sorted in before the cursor, or no cursor at all — the
 * whole list, from 0.
 */
export function graphEventsSince<E extends EventEnvelope>(
  all: E[],
  cursor?: GraphCursor | null,
): { from: number; events: E[] } {
  if (!continues(all, cursor)) return { from: 0, events: all };
  const from = cursor.count - 1;
  return { from, events: all.slice(from) };
}

/** Two copies of one event that say the same thing. */
function sameEvent(a: EventEnvelope | undefined, b: EventEnvelope | undefined): boolean {
  return a !== undefined && b !== undefined && JSON.stringify(a) === JSON.stringify(b);
}

/**
 * `held` up to `from`, then `added`: the held array itself when the reply only repeats what it
 * holds, so views of an unchanged graph keep the same array.
 */
function continueGraph(held: EventEnvelope[], from: number, added: EventEnvelope[]): EventEnvelope[] {
  if (from === 0) return added;
  const repeats = added.length === held.length - from && added.every((event, i) => sameEvent(held[from + i], event));
  return repeats ? held : [...held.slice(0, from), ...added];
}

export interface RunSummaryFeedOptions {
  /** Fetches the summary with graph events after `cursor` only (`graphEventsFrom` says where). */
  fetch: (cursor: GraphCursor | null) => Promise<RunSummary>;
  /** Least time between the starts of two fetches; later invalidations fold into one. */
  minIntervalMs?: number;
  /** A monotonic clock; a wall clock stepping back would hold the next fetch for the whole step. */
  now?: () => number;
}

/** The preview a summary names, as main pushes it (`preview.identity`). */
type SummaryPreview = RunSummary["preview"];

/**
 * One run's live summary, shared by every view showing that run. At most one fetch is in
 * flight; invalidations meanwhile queue a single follow-up, spaced by `minIntervalMs`.
 * Listeners always receive the complete `graphEvents`.
 */
export class RunSummaryFeed {
  readonly #options: RunSummaryFeedOptions;
  readonly #listeners = new Set<(summary: RunSummary) => void>();
  #graph: EventEnvelope[] = [];
  #latest: RunSummary | null = null;
  #pending = false;
  #dirty = false;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #lastStart = Number.NEGATIVE_INFINITY;
  #disposed = false;
  /** A preview pushed while a fetch was in flight: newer than the one its reply names. */
  #pushedPreview: { preview: SummaryPreview } | null = null;

  constructor(options: RunSummaryFeedOptions) {
    this.#options = options;
  }

  get listeners(): number {
    return this.#listeners.size;
  }

  /** Adds a listener; it gets the latest summary at once, if there is one, then every update. */
  subscribe(listener: (summary: RunSummary) => void): () => void {
    this.#listeners.add(listener);
    if (this.#latest) listener(this.#latest);
    this.invalidate();
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** The run changed: fetch again, now or as soon as the spacing allows. */
  invalidate(): void {
    if (this.#disposed) return;
    if (this.#pending) {
      this.#dirty = true;
      return;
    }
    if (this.#timer) return;
    const interval = this.#options.minIntervalMs ?? 0;
    const wait = Math.min(interval, this.#lastStart + interval - this.#now());
    if (wait <= 0) {
      void this.#run();
      return;
    }
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.#run();
    }, wait);
  }

  /** The preview the summary names changed: listeners get it at once, without a fetch. */
  previewChanged(preview: SummaryPreview): void {
    if (this.#disposed) return;
    if (this.#pending) this.#pushedPreview = { preview };
    if (!this.#latest) return;
    this.#latest = { ...this.#latest, preview };
    this.#notify();
  }

  #notify(): void {
    const latest = this.#latest;
    if (!latest) return;
    for (const listener of [...this.#listeners]) listener(latest);
  }

  #now(): number {
    return this.#options.now?.() ?? performance.now();
  }

  dispose(): void {
    this.#disposed = true;
    this.#listeners.clear();
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  async #run(): Promise<void> {
    this.#pending = true;
    this.#pushedPreview = null;
    this.#lastStart = this.#now();
    const held = this.#graph;
    const last = held.at(-1);
    try {
      const reply = await this.#options.fetch(last ? { count: held.length, lastId: last.id } : null);
      if (!this.#disposed) this.#apply(reply, held);
    } catch {
      // The next invalidation retries; a view keeps showing the last good summary.
    } finally {
      this.#pending = false;
      if (this.#dirty && !this.#disposed) {
        this.#dirty = false;
        this.invalidate();
      }
    }
  }

  #apply(reply: RunSummary, held: EventEnvelope[]): void {
    const { graphEventsFrom: from = 0, ...summary } = reply;
    if (from > held.length) {
      // Not a continuation of what was held: start over with the whole list.
      this.#graph = [];
      this.#dirty = true;
      return;
    }
    this.#graph = continueGraph(held, from, reply.graphEvents ?? []);
    const pushed = this.#pushedPreview;
    this.#latest = { ...summary, ...(pushed ? { preview: pushed.preview } : {}), graphEvents: this.#graph };
    this.#notify();
  }
}

/** Where a feed reads: the summary call and the UI event stream (`StudioApi`, or the preload's own). */
export interface RunSummarySource {
  runSummary(project: string, runId: string, graphFrom?: GraphCursor | null): Promise<RunSummary>;
  onEvent(listener: (event: UiEvent) => void): () => void;
}

/** The run a pushed event's payload names, when it is an object that names one. */
function runIdOf(payload: unknown): unknown {
  return typeof payload === "object" && payload !== null && "runId" in payload ? payload.runId : undefined;
}

/** Hands a pushed event to the feed of `project`'s run `runId` when it concerns that run. */
function routeEvent(feed: RunSummaryFeed, event: UiEvent, project: string, runId: string): void {
  if (event.type === UiEvent.RunSummaryChanged && runIdOf(event.payload) === runId) {
    feed.invalidate();
    return;
  }
  if (event.type !== UiEvent.PreviewIdentity) return;
  // Another game's preview says nothing about this run's; no preview at all clears it.
  const preview = event.payload;
  if (!preview || preview.project === project) feed.previewChanged(preview);
}

/**
 * The feeds of every run on screen, one per project and run, shared by all its views. A feed
 * refetches on its run's `run.summary.changed`, patches its summary's preview on preview identity
 * changes, and goes away with its last view.
 */
export function createRunSummaryFeeds(source: RunSummarySource, minIntervalMs = RUN_SUMMARY_SPACING_MS) {
  const feeds = new Map<string, { feed: RunSummaryFeed; off: () => void }>();
  const feedOf = (project: string, runId: string, key: string) => {
    const existing = feeds.get(key);
    if (existing) return existing;
    const feed = new RunSummaryFeed({
      fetch: (graphFrom) => source.runSummary(project, runId, graphFrom),
      minIntervalMs,
    });
    const off = source.onEvent((event) => routeEvent(feed, event, project, runId));
    const shared = { feed, off };
    feeds.set(key, shared);
    return shared;
  };
  return {
    get size(): number {
      return feeds.size;
    },
    subscribe(project: string, runId: string, listener: (summary: RunSummary) => void): () => void {
      const key = JSON.stringify([project, runId]);
      const { feed, off } = feedOf(project, runId, key);
      const unsubscribe = feed.subscribe(listener);
      return () => {
        unsubscribe();
        if (feed.listeners > 0 || feeds.get(key)?.feed !== feed) return;
        feed.dispose();
        off();
        feeds.delete(key);
      };
    },
  };
}
