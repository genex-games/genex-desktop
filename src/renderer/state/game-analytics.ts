/**
 * A game's analytics in the renderer: its reports, its campaign links and the SDK tab's events
 * status as last read, for the account signed in. genex.games computes every number; this store
 * only asks, keeps and forgets.
 *
 * - Only what the page shows is read. A question already on its way is joined, not asked twice,
 *   unless a save or removal genex.games answered since it was sent: an answer sent before a write
 *   never lands over it, and is read again while it is shown.
 * - An answer lands only while the page still shows what it was asked for: one for a game, period,
 *   tab or option the person has left is dropped, and so is one asked under another account.
 * - An answer is kept while it is read again and when a re-read fails. One older than its
 *   `…_STALE_MS` is read again the next time it is shown; `force` reads again whatever its age.
 * - The events status is read again every `EVENTS_STATUS_POLL_MS` while the SDK tab stays shown.
 * - At most `…_KEPT` answers of each kind are kept, the oldest going first.
 * - Everything goes when the account changes or signs out, and nothing is written to localStorage.
 */
import { createStore, type StoreApi } from "zustand/vanilla";
import { MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";
import {
  type AnalyticsGame,
  type AnalyticsRead,
  type CampaignLink,
  type CampaignTags,
  type EventFunnel,
  type EventFunnelDraft,
  type EventOrigin,
  type EventsStatus,
  GameReport,
  type GameReportAnswer,
  type GameReportOptions,
  type GameReportQuery,
  ReadKind,
} from "../../shared/game-analytics.ts";
import { REPORT_OPTIONS } from "../../shared/game-analytics-asks.ts";
import { DEFAULT_STATS_PERIOD, type StatsPeriod } from "../../shared/play-stats.ts";
import type { StudioApi } from "../../shared/studio-api.ts";
import { LoadStatus } from "./people.ts";

/** A report this old is read again when its tab is shown: the numbers are minutes behind, never live. */
export const REPORT_STALE_MS = 2 * MINUTE_MS;
/** The campaign links list this old is read again when its tab is shown. */
export const LINKS_STALE_MS = 2 * MINUTE_MS;
/** How often the events status is read again while the SDK tab stays shown. */
export const EVENTS_STATUS_POLL_MS = 5 * SECOND_MS;
/**
 * The most answers of each kind the store keeps for the account: a long session asks many games,
 * periods and options, and one Acquisition answer alone can hold thousands of rows.
 */
export const REPORTS_KEPT = 40;
export const LINKS_KEPT = 12;
export const EVENTS_KEPT = 6;

/** Copy one option, when it is set. */
function copyOption<Name extends keyof GameReportOptions>(
  to: GameReportOptions,
  from: GameReportOptions,
  name: Name,
): void {
  if (from[name] !== undefined) to[name] = from[name];
}

/**
 * The question a report is asked with: the game, the period and only the options that report takes
 * (`REPORT_OPTIONS`), so main is never sent another report's. A report asked with any other option
 * is the same question, so it is one entry and one read.
 */
export function reportQuery(
  slug: string,
  report: GameReport,
  days: StatsPeriod,
  options: GameReportOptions = {},
): GameReportQuery {
  const names: readonly (keyof GameReportOptions)[] = REPORT_OPTIONS[report];
  const kept: GameReportOptions = {};
  for (const name of names) copyOption(kept, options, name);
  return { slug, report, days, ...kept };
}

/** The campaign links of a game over a period. */
export interface LinksAsk {
  slug: string;
  days: StatsPeriod;
}

/** The events status of a game, for the published game or Studio's preview. */
export interface EventsAsk {
  slug: string;
  origin: EventOrigin;
}

/** A report's place in the store: its game, report, period and the options that matter to it. */
export function reportKey(query: GameReportQuery): string {
  const names: readonly (keyof GameReportOptions)[] = REPORT_OPTIONS[query.report];
  return JSON.stringify([query.slug, query.report, query.days, ...names.map((name) => query[name] ?? null)]);
}

/** A links list's place in the store. */
export const linksKey = (ask: LinksAsk): string => JSON.stringify([ask.slug, ask.days]);

/** An events status's place in the store. */
export const eventsKey = (ask: EventsAsk): string => JSON.stringify([ask.slug, ask.origin]);

/**
 * One read of a game's analytics. `status` says where it stands (Loading, Ready or Failed); `read`
 * is the last answer, which is the value or why there is none (`ReadKind`), and stays while it is
 * read again and when a re-read fails.
 */
export interface AnalyticsEntry<Ask, Value> {
  /** What was asked. */
  ask: Ask;
  status: LoadStatus;
  /** The last answer; null until the first arrives. */
  read: AnalyticsRead<Value> | null;
  /** When `read` arrived, on the store's clock; 0 before it has, or once it must be read again. */
  at: number;
}

/** Reads of one kind, by their key. */
export type AnalyticsEntries<Ask, Value> = Record<string, AnalyticsEntry<Ask, Value>>;

export type ReportEntry = AnalyticsEntry<GameReportQuery, GameReportAnswer>;
export type LinksEntry = AnalyticsEntry<LinksAsk, CampaignLink[]>;
export type EventsEntry = AnalyticsEntry<EventsAsk, EventsStatus>;

/** What the app holds of the account's game analytics. In memory only. */
export interface GameAnalyticsState {
  /** The account these are read for; null signed out. Everything below goes when it changes. */
  account: string | null;
  /** The period the Stats page and every game's page show. */
  period: StatsPeriod;
  /** Reports, by `reportKey`. */
  reports: AnalyticsEntries<GameReportQuery, GameReportAnswer>;
  /** Campaign links, by `linksKey`. */
  links: AnalyticsEntries<LinksAsk, CampaignLink[]>;
  /** Events statuses, by `eventsKey`. */
  events: AnalyticsEntries<EventsAsk, EventsStatus>;
  /** Each game as the latest answer described it, by slug: the page's header and its Installs tab. */
  games: Record<string, AnalyticsGame>;
}

/** Nothing read, nobody signed in. */
export const initialGameAnalytics = (): GameAnalyticsState => ({
  account: null,
  period: DEFAULT_STATS_PERIOD,
  reports: {},
  links: {},
  events: {},
  games: {},
});

/**
 * One kind of read: where its entries live in the state, how it is asked of main, what makes it
 * stale, and the game its answer describes (none for a links list).
 */
export interface AnalyticsReads<Ask extends { slug: string }, Value> {
  key(ask: Ask): string;
  entries(state: GameAnalyticsState): AnalyticsEntries<Ask, Value>;
  withEntries(state: GameAnalyticsState, entries: AnalyticsEntries<Ask, Value>): GameAnalyticsState;
  fetch(api: GameAnalyticsApi, ask: Ask): Promise<AnalyticsRead<Value>>;
  gameOf(value: Value): AnalyticsGame | null;
  staleMs: number;
  /** The most entries of this kind kept: the oldest answers go first. */
  kept: number;
}

/** The reports. */
export const ReportReads: AnalyticsReads<GameReportQuery, GameReportAnswer> = {
  key: reportKey,
  entries: (state) => state.reports,
  withEntries: (state, reports) => ({ ...state, reports }),
  fetch: (api, query) => api.playGameReport(query),
  gameOf: (answer) => answer.game,
  staleMs: REPORT_STALE_MS,
  kept: REPORTS_KEPT,
};

/** The campaign links lists. */
export const LinksReads: AnalyticsReads<LinksAsk, CampaignLink[]> = {
  key: linksKey,
  entries: (state) => state.links,
  withEntries: (state, links) => ({ ...state, links }),
  fetch: (api, ask) => api.playCampaignLinks(ask.slug, ask.days),
  gameOf: () => null,
  staleMs: LINKS_STALE_MS,
  kept: LINKS_KEPT,
};

/** The events statuses: never fresh, so each turn of the SDK tab's interval reads. */
export const EventsReads: AnalyticsReads<EventsAsk, EventsStatus> = {
  key: eventsKey,
  entries: (state) => state.events,
  withEntries: (state, events) => ({ ...state, events }),
  fetch: (api, ask) => api.playGameEvents(ask.slug, ask.origin),
  gameOf: (status) => status.game,
  staleMs: 0,
  kept: EVENTS_KEPT,
};

/** The state with one entry of `reads` replaced, or taken out (null). */
function withEntry<Ask extends { slug: string }, Value>(
  state: GameAnalyticsState,
  reads: AnalyticsReads<Ask, Value>,
  key: string,
  entry: AnalyticsEntry<Ask, Value> | null,
): GameAnalyticsState {
  const { [key]: _before, ...others } = reads.entries(state);
  return reads.withEntries(state, entry ? { ...others, [key]: entry } : others);
}

/** A read is on its way: its entry says so and keeps the answer it holds. */
export function readRequested<Ask extends { slug: string }, Value>(
  state: GameAnalyticsState,
  reads: AnalyticsReads<Ask, Value>,
  ask: Ask,
): GameAnalyticsState {
  const key = reads.key(ask);
  const held = reads.entries(state)[key];
  return withEntry(state, reads, key, { ask, read: held?.read ?? null, at: held?.at ?? 0, status: LoadStatus.Loading });
}

/**
 * `entries` cut to `kept`: the entries that answered longest ago go first, and an entry whose read
 * is on its way, or `keep`, never does.
 */
function pruned<Ask, Value>(
  entries: AnalyticsEntries<Ask, Value>,
  kept: number,
  keep: string,
): AnalyticsEntries<Ask, Value> {
  const keys = Object.keys(entries);
  if (keys.length <= kept) return entries;
  const at = (key: string): number => entries[key]?.at ?? 0;
  const settled = keys.filter((key) => key !== keep && entries[key]?.status !== LoadStatus.Loading);
  const gone = new Set(settled.sort((a, b) => at(a) - at(b)).slice(0, keys.length - kept));
  return Object.fromEntries(Object.entries(entries).filter(([key]) => !gone.has(key)));
}

/**
 * An answer arrived at `at`: the entry holds it, and the game it describes is remembered. The
 * kind's entries are cut to `reads.kept`, so a long session does not keep every answer it read.
 */
export function readAnswered<Ask extends { slug: string }, Value>(
  state: GameAnalyticsState,
  reads: AnalyticsReads<Ask, Value>,
  ask: Ask,
  read: AnalyticsRead<Value>,
  at: number,
): GameAnalyticsState {
  const key = reads.key(ask);
  const entry: AnalyticsEntry<Ask, Value> = { ask, read, at, status: LoadStatus.Ready };
  const answered = reads.withEntries(state, pruned({ ...reads.entries(state), [key]: entry }, reads.kept, key));
  const game = read.kind === ReadKind.Ready ? reads.gameOf(read.value) : null;
  return game ? { ...answered, games: { ...answered.games, [ask.slug]: game } } : answered;
}

/** A read failed: the entry says so and keeps the last answer, as old as it was. */
export function readFailed<Ask extends { slug: string }, Value>(
  state: GameAnalyticsState,
  reads: AnalyticsReads<Ask, Value>,
  ask: Ask,
): GameAnalyticsState {
  const key = reads.key(ask);
  const held = reads.entries(state)[key];
  return withEntry(state, reads, key, { ask, read: held?.read ?? null, at: held?.at ?? 0, status: LoadStatus.Failed });
}

/**
 * A read's answer was dropped, because the person left what it was for: the entry goes back to the
 * answer it held, still as old, or goes altogether when it held none.
 */
export function readDropped<Ask extends { slug: string }, Value>(
  state: GameAnalyticsState,
  reads: AnalyticsReads<Ask, Value>,
  ask: Ask,
): GameAnalyticsState {
  const key = reads.key(ask);
  const held = reads.entries(state)[key];
  if (!held) return state;
  return withEntry(state, reads, key, held.read ? { ...held, status: LoadStatus.Ready } : null);
}

/** The account is `account` now: a different one (or none) leaves nothing of the last one's. */
export const accountSwitched = (state: GameAnalyticsState, account: string | null): GameAnalyticsState =>
  state.account === account ? state : { ...initialGameAnalytics(), account };

/** The period switch turned, on the Stats page or a game's. */
export const periodChosen = (state: GameAnalyticsState, period: StatsPeriod): GameAnalyticsState =>
  state.period === period ? state : { ...state, period };

/** Every links list read for the game, each changed by `change`. */
function withLinks(
  state: GameAnalyticsState,
  slug: string,
  change: (links: CampaignLink[]) => CampaignLink[],
): GameAnalyticsState {
  const links: GameAnalyticsState["links"] = {};
  for (const [key, entry] of Object.entries(state.links)) {
    const mine = entry.ask.slug === slug && entry.read?.kind === ReadKind.Ready;
    links[key] = mine ? { ...entry, read: { kind: ReadKind.Ready, value: change(listOf(entry)) } } : entry;
  }
  return { ...state, links };
}

/** The links an entry holds; none while it holds no list. */
const listOf = (entry: LinksEntry): CampaignLink[] => (entry.read?.kind === ReadKind.Ready ? entry.read.value : []);

/**
 * genex.games saved a campaign link: every list read for the game shows it, first, in the place of
 * any link it already had under that id.
 */
export const linkSaved = (state: GameAnalyticsState, slug: string, link: CampaignLink): GameAnalyticsState =>
  withLinks(state, slug, (links) => [link, ...links.filter((one) => one.id !== link.id)]);

/** genex.games removed a campaign link: no list read for the game shows it. */
export const linkRemoved = (state: GameAnalyticsState, slug: string, id: string): GameAnalyticsState =>
  withLinks(state, slug, (links) => links.filter((one) => one.id !== id));

/** A funnel of the game changed: every Events answer read for it must be read again when shown. */
export function eventsReportsAged(state: GameAnalyticsState, slug: string): GameAnalyticsState {
  const reports: GameAnalyticsState["reports"] = {};
  for (const [key, entry] of Object.entries(state.reports)) {
    const mine = entry.ask.slug === slug && entry.ask.report === GameReport.Events;
    reports[key] = mine ? { ...entry, at: 0 } : entry;
  }
  return { ...state, reports };
}

/**
 * The newest value among the entries `mine` picks, whatever period or option each was asked with:
 * what a tab shows, dimmed, while the answer to a new question is on its way. Null when none of
 * them has a value. The store's own object, so a selector may return it.
 */
export function latestReady<Ask, Value>(
  entries: AnalyticsEntries<Ask, Value>,
  mine: (ask: Ask) => boolean,
): Value | null {
  let newest: { at: number; value: Value } | null = null;
  for (const entry of Object.values(entries)) {
    if (entry.read?.kind !== ReadKind.Ready || !mine(entry.ask)) continue;
    if (!newest || entry.at > newest.at) newest = { at: entry.at, value: entry.read.value };
  }
  return newest?.value ?? null;
}

/** The calls the store makes: `window.studio`'s, by their fixed names. */
export type GameAnalyticsApi = Pick<
  StudioApi,
  | "playGameReport"
  | "playGameEvents"
  | "playCampaignLinks"
  | "playCampaignLinkSave"
  | "playCampaignLinkRemove"
  | "playFunnelSave"
  | "playFunnelRemove"
>;

/** The clock and the interval the store runs on, and whether the window is hidden; tests pass their own. */
export interface GameAnalyticsClock {
  now(): number;
  setInterval(run: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  /** While the window is hidden the events status is not read again. */
  hidden?(): boolean;
}

const browserClock: GameAnalyticsClock = {
  now: () => Date.now(),
  setInterval: (run, ms) => globalThis.setInterval(run, ms),
  clearInterval: (handle) => globalThis.clearInterval(handle as ReturnType<typeof setInterval>),
};

/** Reading again whatever the answer's age. */
export interface LoadOptions {
  force?: boolean;
}

/** The store and what the pages ask of it. */
export interface GameAnalyticsStore extends StoreApi<GameAnalyticsState> {
  /** The account signed in is `account` now (null signed out): a different one clears everything. */
  accountChanged(account: string | null): void;
  /** Turn the period switch of the Stats page and of every game's page. */
  choosePeriod(period: StatsPeriod): void;
  /**
   * Read a report for showing. It becomes what the page shows; one read before and still fresh is
   * not read again unless forced. Resolves when the read has landed or was dropped; never rejects.
   */
  loadReport(query: GameReportQuery, options?: LoadOptions): Promise<void>;
  /** Read a game's campaign links for showing, as `loadReport` reads a report. */
  loadLinks(slug: string, days: StatsPeriod, options?: LoadOptions): Promise<void>;
  /** Read a game's events status now, as the SDK tab's Try again does. */
  loadEvents(slug: string, origin: EventOrigin): Promise<void>;
  /**
   * The SDK tab shows: read the events status now and again every `EVENTS_STATUS_POLL_MS`.
   * Returns the stop, to call when the tab is left; a newer watch stops the one before by itself.
   */
  watchEvents(slug: string, origin: EventOrigin): () => void;
  /** The page shows nothing of the store's any more: answers on their way are dropped, the interval stops. */
  leave(): void;
  /**
   * Save a campaign link; every list read for the game shows it at once. Resolves with the link, or
   * rejects with genex.games' refusal, the lists as they were.
   */
  saveLink(slug: string, tags: CampaignTags): Promise<CampaignLink>;
  /** Remove a campaign link; rejects when genex.games could not, the lists as they were. */
  removeLink(slug: string, id: string): Promise<void>;
  /**
   * Save a funnel, then read the Events report shown again, which is where it appears. Resolves
   * with the funnel once that read has landed; rejects with genex.games' refusal.
   */
  saveFunnel(slug: string, draft: EventFunnelDraft): Promise<EventFunnel>;
  /** Remove a funnel, then read the Events report shown again. */
  removeFunnel(slug: string, id: string): Promise<void>;
}

/** What the page shows now: the read's key, and the report's question when it is a report. */
interface Shown {
  key: string;
  report: GameReportQuery | null;
}

/** A read on its way, and how many writes of its kind the game had seen when it was sent. */
interface Running {
  promise: Promise<void>;
  written: number;
}

/** The reads the store runs, shared by its three kinds. */
function reader(api: GameAnalyticsApi, store: StoreApi<GameAnalyticsState>, clock: GameAnalyticsClock) {
  const set = (change: (state: GameAnalyticsState) => GameAnalyticsState) => store.setState(change, true);
  /** Counts accounts: an answer asked under an earlier one lands nowhere. */
  let epoch = 0;
  let shown: Shown | null = null;
  const inFlight = new Map<string, Running>();
  /** Saves and removals genex.games has answered, by the kind of read they change and the game. */
  const writes = new Map<unknown, Map<string, number>>();
  const writtenTo = (reads: unknown, slug: string): number => writes.get(reads)?.get(slug) ?? 0;
  /** The writes seen by the last read of each key that settled while shown, answered or failed. */
  const landed = new Map<string, number>();

  /**
   * One read; its answer lands only while the page still shows it, for the account that asked. A
   * read sent before a save or removal of its kind never lands: it is read again while shown, and a
   * read on its way is joined only when no such write has been answered since it was sent.
   */
  const read = <Ask extends { slug: string }, Value>(reads: AnalyticsReads<Ask, Value>, ask: Ask): Promise<void> => {
    const key = reads.key(ask);
    const written = writtenTo(reads, ask.slug);
    const running = inFlight.get(key);
    if (running?.written === written) return running.promise;
    const asked = epoch;
    const settle = (land: (state: GameAnalyticsState) => GameAnalyticsState): Promise<void> | undefined => {
      // Another account's state is not this read's to touch, even to tidy its own entry.
      if (asked !== epoch) return undefined;
      if (written !== writtenTo(reads, ask.slug)) return outdated();
      if (shown?.key === key) landed.set(key, written);
      set((state) => (shown?.key === key ? land(state) : readDropped(state, reads, ask)));
      return undefined;
    };
    /**
     * The answer predates a write: a newer read lands instead, or already did; else one is sent now
     * while it is shown.
     */
    const outdated = (): Promise<void> | undefined => {
      const newer = inFlight.get(key);
      if (newer && newer.promise !== started) return newer.promise;
      if ((landed.get(key) ?? -1) >= writtenTo(reads, ask.slug)) return undefined;
      if (shown?.key === key) return read(reads, ask);
      set((state) => readDropped(state, reads, ask));
      return undefined;
    };
    set((state) => readRequested(state, reads, ask));
    const started: Promise<void> = reads
      .fetch(api, ask)
      .then(
        (answer) => settle((state) => readAnswered(state, reads, ask, answer, clock.now())),
        () => settle((state) => readFailed(state, reads, ask)),
      )
      .finally(() => {
        if (inFlight.get(key)?.promise === started) inFlight.delete(key);
      });
    inFlight.set(key, { promise: started, written });
    return started;
  };

  /** genex.games answered a save or removal that changes `reads` of the game: reads sent before it are outdated. */
  const wrote = (reads: unknown, slug: string): void => {
    const counts = writes.get(reads) ?? new Map<string, number>();
    counts.set(slug, writtenTo(reads, slug) + 1);
    writes.set(reads, counts);
  };

  /** Show `ask`: read it unless it was read before and is still fresh. Nothing is read signed out. */
  const load = <Ask extends { slug: string }, Value>(
    reads: AnalyticsReads<Ask, Value>,
    ask: Ask,
    options: LoadOptions & { report?: GameReportQuery } = {},
  ): Promise<void> => {
    const key = reads.key(ask);
    shown = { key, report: options.report ?? null };
    if (store.getState().account === null) return Promise.resolve();
    const held = reads.entries(store.getState())[key];
    const fresh = held?.status === LoadStatus.Ready && clock.now() - held.at < reads.staleMs;
    return fresh && !options.force ? Promise.resolve() : read(reads, ask);
  };

  return {
    set,
    load,
    wrote,
    /** The Events report the page shows for `slug`, when that is what it shows. */
    shownEvents: (slug: string): GameReportQuery | null => {
      const query = shown?.report;
      return query && query.slug === slug && query.report === GameReport.Events ? query : null;
    },
    /** Whether an answer asked now would still be this account's when it arrives. */
    sameAccount: (): (() => boolean) => {
      const asked = epoch;
      return () => asked === epoch;
    },
    /** Nothing is shown: every answer on its way is dropped. */
    leave: (): void => {
      shown = null;
    },
    /** Another account: nothing on its way lands, and its reads are not joined. */
    reset: (): void => {
      epoch += 1;
      shown = null;
      inFlight.clear();
      writes.clear();
      landed.clear();
    },
  };
}

/** The events status as the SDK tab reads it: now, then on an interval until the tab is left. */
function eventsWatch(clock: GameAnalyticsClock, readNow: (ask: EventsAsk) => Promise<void>) {
  let timer: unknown = null;
  const stop = (): void => {
    if (timer === null) return;
    clock.clearInterval(timer);
    timer = null;
  };
  /** Start watching `ask`; the stop it returns says whether this watch was still the one running. */
  const watch = (ask: EventsAsk): (() => boolean) => {
    stop();
    void readNow(ask);
    const mine = clock.setInterval(() => {
      if (!clock.hidden?.()) void readNow(ask);
    }, EVENTS_STATUS_POLL_MS);
    timer = mine;
    // A stop kept from an older watch must not end the one that replaced it.
    return () => {
      if (timer !== mine) return false;
      stop();
      return true;
    };
  };
  return { watch, stop };
}

/** The game analytics store over `api`, on `clock`. */
export function createGameAnalyticsStore(
  api: GameAnalyticsApi,
  clock: GameAnalyticsClock = browserClock,
): GameAnalyticsStore {
  const store = createStore<GameAnalyticsState>()(() => initialGameAnalytics());
  const reads = reader(api, store, clock);
  const { set, load } = reads;
  const loadEvents = (slug: string, origin: EventOrigin) => load(EventsReads, { slug, origin });
  const events = eventsWatch(clock, (ask) => loadEvents(ask.slug, ask.origin));

  const loadReport = (query: GameReportQuery, options: LoadOptions = {}): Promise<void> => {
    events.stop();
    const { slug, report, days, ...asked } = query;
    const ask = reportQuery(slug, report, days, asked);
    return load(ReportReads, ask, { ...options, report: ask });
  };

  /** A funnel changed: the game's Events answers are stale, and the one shown is read again now. */
  const funnelsChanged = async (slug: string): Promise<void> => {
    reads.wrote(ReportReads, slug);
    set((state) => eventsReportsAged(state, slug));
    const query = reads.shownEvents(slug);
    if (query) await loadReport(query, { force: true });
  };

  return Object.assign(store, {
    accountChanged: (account: string | null) => {
      if (store.getState().account === account) return;
      events.stop();
      reads.reset();
      set((state) => accountSwitched(state, account));
    },
    choosePeriod: (period: StatsPeriod) => set((state) => periodChosen(state, period)),
    loadReport,
    loadLinks: (slug: string, days: StatsPeriod, options: LoadOptions = {}) => {
      events.stop();
      return load(LinksReads, { slug, days }, options);
    },
    loadEvents,
    watchEvents: (slug: string, origin: EventOrigin) => {
      const stop = events.watch({ slug, origin });
      // Leaving the tab leaves what it showed; a watch already replaced has nothing left to leave.
      return () => {
        if (stop()) reads.leave();
      };
    },
    leave: () => {
      events.stop();
      reads.leave();
    },
    saveLink: async (slug: string, tags: CampaignTags): Promise<CampaignLink> => {
      const mine = reads.sameAccount();
      const link = await api.playCampaignLinkSave(slug, tags);
      if (!mine()) return link;
      reads.wrote(LinksReads, slug);
      set((state) => linkSaved(state, slug, link));
      return link;
    },
    removeLink: async (slug: string, id: string): Promise<void> => {
      const mine = reads.sameAccount();
      await api.playCampaignLinkRemove(slug, id);
      if (!mine()) return;
      reads.wrote(LinksReads, slug);
      set((state) => linkRemoved(state, slug, id));
    },
    saveFunnel: async (slug: string, draft: EventFunnelDraft): Promise<EventFunnel> => {
      const mine = reads.sameAccount();
      const funnel = await api.playFunnelSave(slug, draft);
      if (mine()) await funnelsChanged(slug);
      return funnel;
    },
    removeFunnel: async (slug: string, id: string): Promise<void> => {
      const mine = reads.sameAccount();
      await api.playFunnelRemove(slug, id);
      if (mine()) await funnelsChanged(slug);
    },
  });
}
