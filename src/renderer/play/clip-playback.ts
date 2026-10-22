/**
 * Play's cover clips: one store for the window that decides which cards' clips hold a decoder and
 * whether each one plays, by genex.games' Featured grid's rules. A clip is cheap to draw and
 * expensive to hold (every `<video>` with a source keeps a decoder and a buffer), so the decision
 * is made here, once, and not in each card:
 *
 * - The measured first row of the dashboard's Games feed (`topRowClip`) plays by itself, at most
 *   MAX_TOP_ROW_CLIPS of it at a time, plus ONE hovered clip anywhere.
 * - A top-row clip starts once its own cover has decoded, the page has had an idle moment since
 *   the row arrived, card i's `i × CLIP_STAGGER_MS` has passed, it is at least half in view (ONE
 *   IntersectionObserver for every card) and the window shows with no viewer over the dashboard.
 *   Below half in view it holds, paused; out of view for CLIP_RELEASE_MS it lets its decoder go.
 * - The hover token: a card claims it on enter and its clip loads after CLIP_HOVER_DELAY_MS; the
 *   previous holder loses it in the same tick, and a stale release never evicts the new holder.
 * - Reduce Motion (or a setting not read yet) plays nothing; a clip that failed is never tried
 *   again this session; a refused play() stops every clip; the row's pause stops every clip,
 *   hover too, and is remembered on this Mac.
 *
 * `createClipPlayback` takes its clock, storage, observer and idle callback, so
 * `tests/conformance/play-clips.test.ts` drives the real store. It is a small external store read
 * through `useSyncExternalStore`, not one of `state/`'s Zustand stores: it is the window's playback
 * bookkeeping (elements, an observer, timers), not app data, and lives as long as the window.
 * Cards read it through per-card primitive selectors, so a change re-renders only the cards whose
 * own answer moved.
 */
import { useSyncExternalStore } from "react";
import { SECOND_MS } from "../../shared/duration.ts";
import { browserStorage, type KeyValueStorage, readText, removeKey, STORAGE_KEYS, writeText } from "../storage.ts";
import { REDUCED_MOTION_QUERY } from "../ui/media-queries.ts";

/** What a card's clip does right now: `Hold` keeps its decoder, paused; `Auto` and `Hover` play. */
export const ClipState = { Off: "off", Hold: "hold", Auto: "auto", Hover: "hover" } as const;
export type ClipState = (typeof ClipState)[keyof typeof ClipState];

/** The most top-row clips playing at once. */
export const MAX_TOP_ROW_CLIPS = 4;
/** How long a pointer rests on a card before its clip loads: a pass across the grid fetches nothing. */
export const CLIP_HOVER_DELAY_MS = 150;
/** A hovered clip never shows sooner than this after the pointer came. */
export const CLIP_REVEAL_FLOOR_MS = 350;
/** Top-row card i may start i × this after the row's idle moment. */
export const CLIP_STAGGER_MS = 100;
/** Out of view this long, a top-row clip lets its decoder go. */
export const CLIP_RELEASE_MS = 10 * SECOND_MS;
/** At least this much of a top-row card is on screen before its clip plays. */
export const CLIP_VIEW_THRESHOLD = 0.5;
/** requestIdleCallback's timeout, and the plain timer where there is no idle callback. */
const CLIP_IDLE_TIMEOUT_MS = 2 * SECOND_MS;
const CLIP_IDLE_FALLBACK_MS = 1.5 * SECOND_MS;
/** The stored value while the row's control has paused the clips. */
const PAUSED = "1";

/** What the window says about motion and being seen. */
export interface ClipSignals {
  /** Reduce Motion; null until read, which plays nothing. */
  reducedMotion: boolean | null;
  /** The window is shown. */
  visible: boolean;
  /** Play's viewer lies over the dashboard. */
  covered: boolean;
}

/** One card's clip as the card describes it. */
export interface ClipSpec {
  url: string;
  /** The card's cover has decoded: a clip never plays over an empty box. */
  ready: boolean;
  /** A top-row card (`topRowClip`). */
  autoplay: boolean;
  /** The card's place in its grid: the stagger, and the order the cap admits in. */
  index: number;
}

/** The store's clock. */
export interface ClipClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** The slice of an IntersectionObserverEntry the store reads. */
export interface ClipObserverEntry {
  target: Element;
  isIntersecting: boolean;
  intersectionRatio: number;
}

/** Builds the ONE observer, or null where there is none (every card then counts as in view). */
export type ClipObserverFactory = (
  onChange: (entries: readonly ClipObserverEntry[]) => void,
) => { observe(el: Element): void; unobserve(el: Element): void; disconnect(): void } | null;

/** What the store runs on. `idle` calls back at the page's next idle moment and answers a cancel. */
export interface ClipDeps {
  clock: ClipClock;
  storage: () => KeyValueStorage | null;
  observer: ClipObserverFactory;
  idle: (fn: () => void) => () => void;
}

interface Entry extends ClipSpec {
  el: Element | null;
  observed: boolean;
  registeredAt: number;
  inView: boolean;
  outSince: number | null;
  started: boolean;
}

interface Gates {
  /** Motion may happen at all: the row's control has something to pause. */
  control: boolean;
  /** A started clip keeps its decoder (a hidden window holds it rather than letting go). */
  keep: boolean;
  /** Clips may play now. */
  live: boolean;
}

/** Everything the store knows; the functions below read and move it. */
interface Model {
  deps: ClipDeps;
  listeners: Set<() => void>;
  entries: Map<string, Entry>;
  byElement: Map<Element, string>;
  failed: Set<string>;
  states: Map<string, ClipState>;
  signals: ClipSignals;
  refused: boolean;
  paused: boolean;
  gates: Gates;
  observer: ReturnType<ClipObserverFactory> | undefined;
  /** When the current row's idle moment came; null until it has. */
  settledAt: number | null;
  cancelIdle: (() => void) | null;
  wake: unknown;
  hover: { holder: string | null; since: number; pending: string | null; pendingAt: number; timer: unknown };
}

const NEVER = Number.POSITIVE_INFINITY;

const gatesOf = (signals: ClipSignals, paused: boolean, refused: boolean): Gates => {
  const motion = signals.reducedMotion === false && !refused;
  const showing = signals.visible && !signals.covered;
  return { control: motion, keep: motion && !paused, live: motion && !paused && showing };
};

const showing = (m: Model): boolean => m.signals.visible && !m.signals.covered;
const inViewOf = (change: ClipObserverEntry): boolean =>
  change.isIntersecting && change.intersectionRatio >= CLIP_VIEW_THRESHOLD;
/** A card the row may play: flagged top row, cover decoded, clip not failed. */
const playable = (m: Model, e: Entry): boolean => e.autoplay && e.ready && !m.failed.has(e.url);
const staggerAt = (m: Model, e: Entry): number =>
  Math.max(e.registeredAt, m.settledAt ?? 0) + e.index * CLIP_STAGGER_MS;
const expired = (e: Entry, now: number): boolean =>
  !e.inView && e.outSince !== null && now - e.outSince >= CLIP_RELEASE_MS;
const mayStart = (m: Model, e: Entry, now: number): boolean =>
  m.gates.live && m.settledAt !== null && e.inView && now >= staggerAt(m, e);
const hasRow = (m: Model): boolean => [...m.entries.values()].some((e) => e.autoplay && !m.failed.has(e.url));

function onIntersections(m: Model, changes: readonly ClipObserverEntry[]): void {
  let moved = false;
  for (const change of changes) {
    const key = m.byElement.get(change.target);
    const entry = key === undefined ? undefined : m.entries.get(key);
    const inView = inViewOf(change);
    if (!entry || inView === entry.inView) continue;
    entry.inView = inView;
    entry.outSince = inView ? null : m.deps.clock.now();
    moved = true;
  }
  if (moved) recompute(m);
}

function ensureObserver(m: Model): ReturnType<ClipObserverFactory> {
  if (m.observer === undefined) m.observer = m.deps.observer((changes) => onIntersections(m, changes));
  return m.observer;
}

/** Stops watching a card that is no longer a top-row card, or is going. */
function unwatch(m: Model, entry: Entry): void {
  if (!entry.observed || !entry.el) return;
  m.observer?.unobserve(entry.el);
  m.byElement.delete(entry.el);
  entry.observed = false;
}

/** Watches a top-row card; one the observer cannot watch (or with no element) counts as in view. */
function syncObservation(m: Model, key: string, entry: Entry): void {
  if (!entry.autoplay) {
    unwatch(m, entry);
    return;
  }
  const el = entry.el;
  if (entry.observed) return;
  const io = el ? ensureObserver(m) : null;
  if (!el || !io) {
    entry.inView = true;
    return;
  }
  m.byElement.set(el, key);
  entry.observed = true;
  entry.inView = false;
  io.observe(el);
}

/** A row on screen asks for its idle moment once; a row gone forgets it. */
function settleRow(m: Model): void {
  if (!hasRow(m)) {
    m.cancelIdle?.();
    m.cancelIdle = null;
    m.settledAt = null;
    return;
  }
  if (m.settledAt !== null || m.cancelIdle !== null) return;
  m.cancelIdle = m.deps.idle(() => {
    m.cancelIdle = null;
    m.settledAt = m.deps.clock.now();
    recompute(m);
  });
}

/** Keeps the started clips that may stay, then admits new ones in order up to the cap. */
function admit(m: Model, row: readonly Entry[], now: number): void {
  let admitted = 0;
  for (const e of row) {
    if (!e.started) continue;
    const stays = m.gates.keep && !expired(e, now) && admitted < MAX_TOP_ROW_CLIPS;
    e.started = stays;
    if (stays) admitted += 1;
  }
  for (const e of row) {
    if (e.started || admitted >= MAX_TOP_ROW_CLIPS || !mayStart(m, e, now)) continue;
    e.started = true;
    admitted += 1;
  }
  // Anything no longer a live top-row card holds no decoder.
  for (const e of m.entries.values()) if (e.started && !playable(m, e)) e.started = false;
}

function stateOf(m: Model, e: Entry): ClipState {
  if (!e.started) return ClipState.Off;
  return e.inView && showing(m) ? ClipState.Auto : ClipState.Hold;
}

function writeStates(m: Model): void {
  m.states.clear();
  for (const [key, e] of m.entries) m.states.set(key, stateOf(m, e));
  const key = m.hover.holder;
  const held = key === null ? undefined : m.entries.get(key);
  if (key === null || !held || !m.gates.live || !held.ready || m.failed.has(held.url)) return;
  if (m.states.get(key) !== ClipState.Auto) m.states.set(key, ClipState.Hover);
}

/** When a card's answer next changes by itself: its stagger coming due, or its release. */
function nextChange(m: Model, e: Entry, now: number): number {
  if (e.started) return !e.inView && e.outSince !== null ? e.outSince + CLIP_RELEASE_MS : NEVER;
  const due = m.settledAt !== null && e.inView ? staggerAt(m, e) : NEVER;
  return due > now ? due : NEVER;
}

/** ONE timer for the row's next change. */
function scheduleWake(m: Model, row: readonly Entry[], now: number): void {
  const next = Math.min(NEVER, ...row.map((e) => nextChange(m, e, now)));
  if (m.wake !== null) m.deps.clock.clearTimeout(m.wake);
  m.wake = null;
  if (next === NEVER) return;
  m.wake = m.deps.clock.setTimeout(
    () => {
      m.wake = null;
      recompute(m);
    },
    Math.max(0, next - now),
  );
}

function recompute(m: Model): void {
  const now = m.deps.clock.now();
  m.gates = gatesOf(m.signals, m.paused, m.refused);
  settleRow(m);
  const row = [...m.entries.values()].filter((e) => playable(m, e)).sort((a, b) => a.index - b.index);
  admit(m, row, now);
  writeStates(m);
  scheduleWake(m, row, now);
  for (const listener of m.listeners) listener();
}

function newModel(deps: ClipDeps): Model {
  const signals: ClipSignals = { reducedMotion: null, visible: true, covered: false };
  const paused = readText(STORAGE_KEYS.playClipsPaused, deps.storage()) === PAUSED;
  return {
    deps,
    listeners: new Set(),
    entries: new Map(),
    byElement: new Map(),
    failed: new Set(),
    states: new Map(),
    signals,
    refused: false,
    paused,
    gates: gatesOf(signals, paused, false),
    observer: undefined,
    settledAt: null,
    cancelIdle: null,
    wake: null,
    hover: { holder: null, since: 0, pending: null, pendingAt: 0, timer: null },
  };
}

/** What cards and the row's control read. */
function reads(m: Model) {
  return {
    /** The store's clock: the reveal floor measures on the same one. */
    now: (): number => m.deps.clock.now(),
    subscribe(listener: () => void): () => void {
      m.listeners.add(listener);
      return () => void m.listeners.delete(listener);
    },
    getState: (key: string): ClipState => m.states.get(key) ?? ClipState.Off,
    /** When the pointer (or focus) came to the card that holds the hover token. */
    hoverStartedAt: (key: string): number | null => (m.hover.holder === key ? m.hover.since : null),
    isFailed: (url: string): boolean => m.failed.has(url),
    isPaused: (): boolean => m.paused,
    /** The row's control shows: motion may happen and a top-row card has a clip that can play. */
    showsControl: (): boolean => m.gates.control && hasRow(m),
  };
}

/** A card's clip coming, changing and going. */
function cards(m: Model) {
  const unregister = (key: string, entry: Entry): void => {
    if (m.entries.get(key) !== entry) return;
    entry.autoplay = false;
    syncObservation(m, key, entry);
    m.entries.delete(key);
    if (m.hover.pending === key) {
      m.deps.clock.clearTimeout(m.hover.timer);
      m.hover.pending = null;
    }
    if (m.hover.holder === key) m.hover.holder = null;
    recompute(m);
  };
  return {
    /** Adds a card's clip; answers its removal. */
    register(key: string, spec: ClipSpec & { el: Element | null }): () => void {
      const registeredAt = m.deps.clock.now();
      const entry: Entry = { ...spec, observed: false, registeredAt, inView: false, outSince: null, started: false };
      m.entries.set(key, entry);
      syncObservation(m, key, entry);
      recompute(m);
      return () => unregister(key, entry);
    },
    update(key: string, spec: Partial<ClipSpec>): void {
      const entry = m.entries.get(key);
      if (!entry) return;
      if (spec.url !== undefined && spec.url !== entry.url) entry.started = false;
      Object.assign(entry, spec);
      syncObservation(m, key, entry);
      recompute(m);
    },
  };
}

/** The hover token: claimed on enter, held after the dwell, let go only by its holder. */
function hovering(m: Model) {
  const { hover, deps } = m;
  return {
    claimHover(key: string): void {
      if (hover.holder === key || hover.pending === key) return;
      if (hover.pending !== null) deps.clock.clearTimeout(hover.timer);
      hover.pending = key;
      hover.pendingAt = deps.clock.now();
      hover.timer = deps.clock.setTimeout(() => {
        hover.pending = null;
        hover.holder = key;
        hover.since = hover.pendingAt;
        recompute(m);
      }, CLIP_HOVER_DELAY_MS);
    },
    /** Lets go only of what `key` still holds or waits for. */
    releaseHover(key: string): void {
      if (hover.pending === key) {
        deps.clock.clearTimeout(hover.timer);
        hover.pending = null;
      }
      if (hover.holder !== key) return;
      hover.holder = null;
      recompute(m);
    },
  };
}

/** What stops clips: the window's signals, a failure, a refusal, the row's pause. */
function stops(m: Model) {
  return {
    setSignals(next: Partial<ClipSignals>): void {
      m.signals = { ...m.signals, ...next };
      recompute(m);
    },
    markFailed(url: string): void {
      if (m.failed.has(url)) return;
      m.failed.add(url);
      recompute(m);
    },
    markRefused(): void {
      if (m.refused) return;
      m.refused = true;
      recompute(m);
    },
    setPaused(next: boolean): void {
      m.paused = next;
      // Storage that cannot keep it: the pause holds for this session only.
      if (next) writeText(STORAGE_KEYS.playClipsPaused, PAUSED, m.deps.storage());
      else removeKey(STORAGE_KEYS.playClipsPaused, m.deps.storage());
      recompute(m);
    },
  };
}

/** Makes a clip store on the clock, storage, observer and idle callback it is given. */
export function createClipPlayback(deps: ClipDeps) {
  const m = newModel(deps);
  return { ...reads(m), ...cards(m), ...hovering(m), ...stops(m) };
}

/** The window's clip store. */
export type ClipPlayback = ReturnType<typeof createClipPlayback>;

/**
 * Whether grid card `index` is a top-row clip: a feed that autoplays (the dashboard's Games feed,
 * never a profile or a search), its columns measured, inside the first row and the cap, with a clip.
 */
export function topRowClip(input: {
  autoplayTopRow: boolean;
  measured: boolean;
  columns: number;
  index: number;
  hasClip: boolean;
}): boolean {
  const inRow = input.index < Math.min(input.columns, MAX_TOP_ROW_CLIPS);
  return input.autoplayTopRow && input.measured && input.hasClip && inRow;
}

/** How many columns a grid lays out, from its computed `grid-template-columns`. */
export function gridColumns(template: string): number {
  const tracks = template.trim();
  if (tracks === "" || tracks === "none") return 0;
  return tracks.split(/\s+/).length;
}

/** How long a clip that has its first frame still waits to show: a hover's reveal floor, else nothing. */
export function revealWait(hoverSince: number | null, now: number): number {
  return hoverSince === null ? 0 : Math.max(0, hoverSince + CLIP_REVEAL_FLOOR_MS - now);
}

// ── The window's store, and the hooks cards read it through ───────────────────────────────

function browserIdle(fn: () => void): () => void {
  if (typeof window.requestIdleCallback === "function") {
    const id = window.requestIdleCallback(fn, { timeout: CLIP_IDLE_TIMEOUT_MS });
    return () => window.cancelIdleCallback(id);
  }
  const timer = window.setTimeout(fn, CLIP_IDLE_FALLBACK_MS);
  return () => window.clearTimeout(timer);
}

const browserObserver: ClipObserverFactory = (onChange) =>
  typeof IntersectionObserver === "undefined"
    ? null
    : new IntersectionObserver((list) => onChange(list), { threshold: CLIP_VIEW_THRESHOLD });

/** Feeds the store Reduce Motion and the window's visibility, for as long as the window lives. */
function attachBrowserSignals(store: ClipPlayback): void {
  const motion = window.matchMedia(REDUCED_MOTION_QUERY);
  const read = () =>
    store.setSignals({ reducedMotion: motion.matches, visible: document.visibilityState === "visible" });
  motion.addEventListener("change", read);
  document.addEventListener("visibilitychange", read);
  read();
}

let page: ClipPlayback | null = null;

function pageStore(): ClipPlayback {
  if (page) return page;
  const store = createClipPlayback({
    clock: {
      now: () => performance.now(),
      setTimeout: (fn, ms) => window.setTimeout(fn, ms),
      clearTimeout: (handle) => window.clearTimeout(handle as number),
    },
    storage: browserStorage,
    observer: browserObserver,
    idle: browserIdle,
  });
  page = store;
  attachBrowserSignals(store);
  return store;
}

const subscribe = (listener: () => void): (() => void) => pageStore().subscribe(listener);

/** What this card's clip does now. */
export const useClipState = (key: string): ClipState =>
  useSyncExternalStore(subscribe, () => pageStore().getState(key));
/** Whether this clip failed this session. */
export const useClipFailed = (url: string): boolean => useSyncExternalStore(subscribe, () => pageStore().isFailed(url));
/** Whether the row's control has paused the clips. */
export const useClipsPaused = (): boolean => useSyncExternalStore(subscribe, () => pageStore().isPaused());
/** Whether the row's control shows. */
export const useClipControl = (): boolean => useSyncExternalStore(subscribe, () => pageStore().showsControl());

/** Adds a card's clip to the window's store; answers its removal. */
export const registerClip = (key: string, spec: ClipSpec & { el: Element | null }): (() => void) =>
  pageStore().register(key, spec);
/** Tells the store what changed about a card's clip. */
export const updateClip = (key: string, spec: Partial<ClipSpec>): void => pageStore().update(key, spec);
/** The pointer or focus came to a card. */
export const claimHoverClip = (key: string): void => pageStore().claimHover(key);
/** The pointer or focus left a card. */
export const releaseHoverClip = (key: string): void => pageStore().releaseHover(key);
/** When the hover this card holds began, on the store's clock. */
export const clipHoverStartedAt = (key: string): number | null => pageStore().hoverStartedAt(key);
/** The store's clock now. */
export const clipNow = (): number => pageStore().now();
/** A clip that could not play: never tried again this session. */
export const markClipFailed = (url: string): void => pageStore().markFailed(url);
/** A play() the browser refused: no clip plays again this session. */
export const markClipsRefused = (): void => pageStore().markRefused();
/** The row's control pressed. */
export const toggleClipsPaused = (): void => pageStore().setPaused(!pageStore().isPaused());
/** Play's viewer came over the dashboard, or went. */
export const setClipsCovered = (covered: boolean): void => pageStore().setSignals({ covered });
