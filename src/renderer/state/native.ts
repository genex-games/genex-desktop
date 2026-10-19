/**
 * A C++ game's own Mac window, per game: the person's window run as the registry announces it
 * (`native.status`) and the last lines it wrote to stderr (`native.log`). The stage watches the
 * game it shows (`watch(project)`, as the library watches asset inventories): a watched game's run
 * is read once (`nativeState`) and then kept by the events; a game nobody watches is forgotten,
 * and its events change nothing. Agents' headless runs are not the person's window and never
 * reach the card.
 *
 * Live's Web | Native view, per game: which build Live shows, and the embedded run that draws the
 * Mac build inside Live (`hold`, `popOut`). Live's canvas holds that run while it is mounted; the
 * last hold let go unembeds it, after a tick so a remount keeps it. When the host says Live cannot
 * show a Mac build here at all (`embed-unsupported`, `electron-untested`), that holds for the session.
 *
 * Actions are pure `(state, input) => state`; `createNativeStore` binds them to a `StudioApi`, and
 * `nativeStoreFor` keeps the app's one store, subscribed once to `onEvent`.
 */
import { createStore, type StoreApi } from "zustand/vanilla";
import { BuildTarget } from "../../shared/game-project.ts";
import {
  NATIVE_NO_RUN_ID,
  type NativeEmbedSize,
  type NativeLogBatch,
  NativeRefusal,
  NativeRunMode,
  NativeRunState,
  type NativeRunStatus,
  type NativeTimers,
} from "../../shared/native-contract.ts";
import type { StudioApi } from "../../shared/studio-api.ts";
import { createRefresher, type Refresher } from "./refresher.ts";
import { nativeUpdate } from "./ui-event-routes.ts";

/** How many of the window run's stderr lines the renderer keeps per game. */
export const NATIVE_LOG_KEPT = 200;

/** One watched game's window run. */
export interface NativeGame {
  /** The run, or null when none is known. */
  status: NativeRunStatus | null;
  /** Its last {@link NATIVE_LOG_KEPT} stderr lines. */
  log: readonly string[];
  /** Lines were dropped: by the host (cut or batched away) or here, past the kept count. */
  truncated: boolean;
}

/** Which build Live shows for a C++ game with a Mac build: its web page, or the Mac build itself. Wire values of `data-stage-native-view`. */
export const NativeView = {
  Web: "web",
  Native: "native",
} as const;
export type NativeView = (typeof NativeView)[keyof typeof NativeView];

/** Live's view of one game: the person's choice and the embedded run that shows the Mac build. */
export interface NativeEmbed {
  /** The person's choice this session; null takes the game's default ({@link nativeViewOf}). */
  view: NativeView | null;
  /** The embedded run, as the host answered or announced it; null when none is held. */
  status: NativeRunStatus | null;
  /** The last embed call failed outright (no answer): Live says so and offers Try again. */
  failed: boolean;
}

/** The native store's state: each watched game's window run, and Live's view of each game. */
export interface NativeState {
  /** The watched games' runs, by game name. */
  games: Readonly<Record<string, NativeGame>>;
  /** Live's view of each game it was asked to show natively, by game name. */
  embeds: Readonly<Record<string, NativeEmbed>>;
  /** Why Live cannot show a Mac build in this session at all, once the host said so; null until then. */
  embedBlocked: NativeRefusal | null;
}

const NO_GAME: NativeGame = Object.freeze({ status: null, log: Object.freeze([]), truncated: false });
const NO_EMBED: NativeEmbed = Object.freeze({ view: null, status: null, failed: false });

/** Refusals that say Live cannot show any Mac build in this session, whatever the game. */
const EMBED_BLOCKING: ReadonlySet<NativeRefusal> = new Set([
  NativeRefusal.EmbedUnsupported,
  NativeRefusal.ElectronUntested,
]);

/** Nothing watched, nothing known. */
export const initialNative = (): NativeState => ({ games: {}, embeds: {}, embedBlocked: null });

/** `project`'s run as the store holds it; a game nobody watches has none. */
export const nativeOf = (state: NativeState, project: string | null | undefined): NativeGame =>
  (project ? state.games[project] : undefined) ?? NO_GAME;

/** States a run has ended in: nothing more will happen to it. */
const ENDED: ReadonlySet<NativeRunState> = new Set([
  NativeRunState.Stopped,
  NativeRunState.Crashed,
  NativeRunState.Killed,
  NativeRunState.Refused,
]);

/** Whether `status` is a run that has ended. */
export const nativeRunEnded = (status: NativeRunStatus): boolean => ENDED.has(status.state);

/** A game the stage started watching; one already watched keeps what it has. */
export function nativeWatched(state: NativeState, project: string): NativeState {
  if (state.games[project]) return state;
  return { ...state, games: { ...state.games, [project]: NO_GAME } };
}

/** A game nobody watches any more: forgotten. */
export function nativeForgotten(state: NativeState, project: string): NativeState {
  if (!state.games[project]) return state;
  const { [project]: _gone, ...rest } = state.games;
  return { ...state, games: rest };
}

/** Whether `a` and `b` are word of one run (a status with no run id is a run of its own). */
function sameRun(a: NativeRunStatus | null, b: NativeRunStatus): boolean {
  return a !== null && a.runId !== NATIVE_NO_RUN_ID && a.runId === b.runId;
}

/**
 * Whether `next` is old news to a card showing `current`: an ended run's last word is final, and
 * another run that started before the shown one is over.
 */
function staleWord(current: NativeRunStatus | null, next: NativeRunStatus): boolean {
  if (current === null) return false;
  if (sameRun(current, next)) return nativeRunEnded(current);
  return next.startedAt < current.startedAt;
}

/** Whether `status` changes nothing in a watched `game`: another mode's run, or old news. */
function ignored(game: NativeGame, status: NativeRunStatus): boolean {
  return status.mode !== NativeRunMode.Window || staleWord(game.status, status);
}

/**
 * A window run's status from the registry (an event or a command's answer). Another mode's run,
 * a game nobody watches, an older run's late word and word of a run that already ended change
 * nothing; a new run starts a fresh log.
 */
export function nativeStatusReceived(state: NativeState, status: NativeRunStatus): NativeState {
  const game = state.games[status.project];
  if (!game || ignored(game, status)) return state;
  const next: NativeGame = sameRun(game.status, status) ? { ...game, status } : { status, log: [], truncated: false };
  return { ...state, games: { ...state.games, [status.project]: next } };
}

/**
 * Play's answer, for a card that showed the run `clicked` (or none) when Play was pressed. An
 * answer with no run id is a refusal made before any run started: it never replaces a run that
 * started after the click, whose own word the registry announced as it went.
 */
export function nativePlayAnswered(state: NativeState, answer: NativeRunStatus, clicked: string | null): NativeState {
  const shown = state.games[answer.project]?.status ?? null;
  const runSinceClick = answer.runId === NATIVE_NO_RUN_ID && shown !== null && shown.runId !== clicked;
  return runSinceClick ? state : nativeStatusReceived(state, answer);
}

/**
 * What a read of `project`'s window run found. None: a live card is cleared (the registry has no
 * such run), an ended one is kept (the registry forgets ended runs; the card still says how it ended).
 */
export function nativeStateRead(state: NativeState, project: string, status: NativeRunStatus | null): NativeState {
  const game = state.games[project];
  if (!game) return state;
  if (status) return nativeStatusReceived(state, status);
  if (!game.status || nativeRunEnded(game.status)) return state;
  return { ...state, games: { ...state.games, [project]: NO_GAME } };
}

/** The window run's stderr lines: the last {@link NATIVE_LOG_KEPT} are kept; another run's lines are not this card's. */
export function nativeLogReceived(state: NativeState, batch: NativeLogBatch): NativeState {
  const game = state.games[batch.project];
  if (!game?.status || game.status.runId !== batch.runId) return state;
  const all = [...game.log, ...batch.lines];
  const log = all.slice(-NATIVE_LOG_KEPT);
  const truncated = game.truncated || batch.truncated || log.length < all.length;
  return { ...state, games: { ...state.games, [batch.project]: { ...game, log, truncated } } };
}

// ── Live's Web | Native view ───────────────────────────────────────────────────────────────

/** Live's view of `project`; a game Live was never asked to show natively has none. */
export const nativeEmbedOf = (state: NativeState, project: string | null | undefined): NativeEmbed =>
  (project ? state.embeds[project] : undefined) ?? NO_EMBED;

/** `project`'s embed entry changed by `change`. */
function withEmbed(state: NativeState, project: string, change: (embed: NativeEmbed) => NativeEmbed): NativeState {
  return { ...state, embeds: { ...state.embeds, [project]: change(nativeEmbedOf(state, project)) } };
}

/** The person chose which build Live shows for `project`. */
export function nativeViewChosen(state: NativeState, project: string, view: NativeView): NativeState {
  if (state.embeds[project]?.view === view) return state;
  return withEmbed(state, project, (embed) => ({ ...embed, view }));
}

/**
 * Which build Live shows for a game made for `targets`: none but the web page once this session
 * cannot show a Mac build; else the person's choice, and by default Native for a game with no
 * Browser build and Web for one with, or while the game already plays in its own window (no
 * second copy inside Live).
 */
export function nativeViewOf(state: NativeState, project: string, targets: readonly BuildTarget[]): NativeView {
  if (state.embedBlocked !== null) return NativeView.Web;
  const chosen = state.embeds[project]?.view;
  if (chosen) return chosen;
  const ownWindow = state.games[project]?.status ?? null;
  const windowPlays = ownWindow !== null && !nativeRunEnded(ownWindow);
  return targets.includes(BuildTarget.Web) || windowPlays ? NativeView.Web : NativeView.Native;
}

/**
 * An embedded run's status, answered or announced. A window or agent run, a game Live never asked to
 * show, an older run's late word and word of a run that already ended change nothing. A refusal that
 * says Live cannot show Mac builds here holds for the session.
 */
export function nativeEmbedReceived(state: NativeState, status: NativeRunStatus): NativeState {
  const embed = state.embeds[status.project];
  if (status.mode !== NativeRunMode.Embedded || !embed || staleWord(embed.status, status)) return state;
  const blocked = status.refusal && EMBED_BLOCKING.has(status.refusal) ? status.refusal : state.embedBlocked;
  const next = withEmbed(state, status.project, (current) => ({ ...current, status, failed: false }));
  return blocked === state.embedBlocked ? next : { ...next, embedBlocked: blocked };
}

/** Live started to hold `project`'s embedded run: its entry exists, so the run's events land. */
export function nativeEmbedHeld(state: NativeState, project: string): NativeState {
  if (state.embeds[project]) return state;
  return withEmbed(state, project, (embed) => embed);
}

/** `project`'s embedded run was let go (or never answered): nothing shows; the person's choice stays. */
export function nativeEmbedEnded(state: NativeState, project: string, failed = false): NativeState {
  const embed = state.embeds[project];
  if (!embed || (embed.status === null && embed.failed === failed)) return state;
  return withEmbed(state, project, (current) => ({ ...current, status: null, failed }));
}

/** The native calls the store makes, and the event stream it listens to. */
export type NativeApi = Pick<
  StudioApi,
  "nativeState" | "nativeRun" | "nativeStop" | "nativeFront" | "nativeEmbed" | "nativeUnembed" | "onEvent"
>;

/** The clock the deferred unembed runs on. */
export type EmbedTimers = Pick<NativeTimers, "setTimeout" | "clearTimeout">;

const SYSTEM_TIMERS: EmbedTimers = {
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** How long the last hold let go waits before it unembeds: a remount in this time keeps the run. */
const UNEMBED_DELAY_MS = 0;

/** The native store: its state, the event subscription and the commands that reach the registry. */
export interface NativeStore extends StoreApi<NativeState> {
  /** Listen to `native.*` events; returns the stop. */
  start(): () => void;
  /** Keep `project`'s window run while the returned function has not been called: read now, then kept by events. */
  watch(project: string): () => void;
  /** Read `project`'s window run again. */
  refresh(project: string): Promise<void>;
  /** Play on Mac (and Restart): its answer, a refusal included, goes on the card. */
  play(project: string): Promise<NativeRunStatus>;
  /** Stop the window run; false when none ran. */
  stop(project: string): Promise<boolean>;
  /** Bring the window to the front; false when there is none. */
  front(project: string): Promise<boolean>;
  /** Choose which build Live shows for `project`. */
  choose(project: string, view: NativeView): void;
  /** Hold `project`'s embedded run at `size` (embedding it unless it is held already); the returned function lets go. */
  hold(project: string, size: NativeEmbedSize): () => void;
  /** Embed `project` again (Try again, Restart inside Live), whatever its last run did. */
  retryEmbed(project: string, size: NativeEmbedSize): Promise<void>;
  /** Live's canvas for `project` is now `size`: what a restart of its embedded run asks for. */
  resized(project: string, size: NativeEmbedSize): void;
  /**
   * The person's Reload while Live holds `project`'s embedded run: the run the Reload ends (main
   * ends it before it rebuilds) starts again at once, from what is on disk; one already stopped
   * plays once `reloading` is done. A game Live does not show natively starts nothing.
   */
  afterReload(project: string, reloading: Promise<unknown>): Promise<void>;
  /** Pop out: unembed, show Web in Live, then open the Mac window (Play on Mac). */
  popOut(project: string): Promise<NativeRunStatus>;
}

/** A native store over `api`; `start` subscribes it to the event stream. */
export function createNativeStore(api: NativeApi, timers: EmbedTimers = SYSTEM_TIMERS): NativeStore {
  const store = createStore<NativeState>()(() => initialNative());
  const watched = new Map<string, { count: number; reader: Refresher }>();
  const apply = (change: (state: NativeState) => NativeState): void => store.setState(change, true);
  /** The newest word wins: a read still in flight would land older news. */
  const settle = (project: string): void => watched.get(project)?.reader.reset();
  const reader = (project: string): Refresher =>
    createRefresher(
      () => api.nativeState(project),
      (status) => apply((state) => nativeStateRead(state, project, status)),
    );
  const embeds = embedHolds(api, timers, apply);
  const reloads = embedReloads(embeds, (project) => nativeEmbedOf(store.getState(), project).status);
  const received = (status: NativeRunStatus): void => {
    if (status.mode === NativeRunMode.Embedded) {
      apply((state) => nativeEmbedReceived(state, status));
      reloads.received(status);
      return;
    }
    settle(status.project);
    apply((state) => nativeStatusReceived(state, status));
  };

  return Object.assign(store, {
    start(): () => void {
      return api.onEvent((event) => {
        const update = nativeUpdate(event);
        if (!update) return;
        if ("status" in update) received(update.status);
        else apply((state) => nativeLogReceived(state, update.log));
      });
    },
    watch(project: string): () => void {
      let entry = watched.get(project);
      if (!entry) {
        entry = { count: 0, reader: reader(project) };
        watched.set(project, entry);
        apply((state) => nativeWatched(state, project));
        void entry.reader.request();
      }
      entry.count += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const current = watched.get(project);
        if (!current) return;
        current.count -= 1;
        if (current.count > 0) return;
        current.reader.reset();
        watched.delete(project);
        apply((state) => nativeForgotten(state, project));
      };
    },
    async refresh(project: string): Promise<void> {
      await watched.get(project)?.reader.request();
    },
    async play(project: string): Promise<NativeRunStatus> {
      const clicked = nativeOf(store.getState(), project).status?.runId ?? null;
      const status = await api.nativeRun(project);
      settle(project);
      apply((state) => nativePlayAnswered(state, status, clicked));
      return status;
    },
    async stop(project: string): Promise<boolean> {
      const stopped = await api.nativeStop(project);
      void watched.get(project)?.reader.request();
      return stopped;
    },
    front: (project: string): Promise<boolean> => api.nativeFront(project),
    choose(project: string, view: NativeView): void {
      apply((state) => nativeViewChosen(state, project, view));
    },
    hold: embeds.hold,
    retryEmbed: embeds.embed,
    resized: embeds.resized,
    afterReload: reloads.afterReload,
    async popOut(project: string): Promise<NativeRunStatus> {
      apply((state) => nativeViewChosen(state, project, NativeView.Web));
      await embeds.unembed(project);
      const clicked = nativeOf(store.getState(), project).status?.runId ?? null;
      const status = await api.nativeRun(project);
      settle(project);
      apply((state) => nativePlayAnswered(state, status, clicked));
      return status;
    },
  });
}

/**
 * Live's holds on embedded runs: the first hold of a game embeds it, the last let go unembeds it
 * after {@link UNEMBED_DELAY_MS} (a remount in between keeps the run), and an explicit unembed
 * (Pop out) leaves nothing for a later let-go to undo.
 */
function embedHolds(api: NativeApi, timers: EmbedTimers, apply: (change: (state: NativeState) => NativeState) => void) {
  const holds = new Map<string, { count: number; timer: unknown }>();
  /** Games with an embed asked for and no unembed since. */
  const embedded = new Set<string>();
  /** The canvas size each of those last asked for. */
  const sizes = new Map<string, NativeEmbedSize>();
  const embed = async (project: string, size: NativeEmbedSize): Promise<void> => {
    embedded.add(project);
    sizes.set(project, size);
    apply((state) => nativeEmbedHeld(state, project));
    try {
      const status = await api.nativeEmbed(project, size);
      apply((state) => nativeEmbedReceived(state, status));
    } catch {
      apply((state) => nativeEmbedEnded(state, project, true));
    }
  };
  const unembed = async (project: string): Promise<void> => {
    if (!embedded.delete(project)) return;
    sizes.delete(project);
    apply((state) => nativeEmbedEnded(state, project));
    await api.nativeUnembed(project).catch(() => false);
  };
  const letGo = (project: string): void => {
    const entry = holds.get(project);
    if (!entry) return;
    entry.count -= 1;
    if (entry.count > 0) return;
    entry.timer = timers.setTimeout(() => {
      holds.delete(project);
      void unembed(project);
    }, UNEMBED_DELAY_MS);
  };
  const hold = (project: string, size: NativeEmbedSize): (() => void) => {
    const entry = holds.get(project) ?? { count: 0, timer: null };
    timers.clearTimeout(entry.timer);
    entry.timer = null;
    entry.count += 1;
    holds.set(project, entry);
    if (!embedded.has(project)) void embed(project, size);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      letGo(project);
    };
  };
  const resized = (project: string, size: NativeEmbedSize): void => {
    if (embedded.has(project)) sizes.set(project, size);
  };
  /** The size `project`'s held embedded run draws at, or null when Live holds none. */
  const sizeOf = (project: string): NativeEmbedSize | null => sizes.get(project) ?? null;
  return { hold, embed, unembed, resized, sizeOf };
}

/**
 * Reloads with Live's Native view shown ({@link NativeStore.afterReload}): the embedded run a
 * Reload ends starts again once, at the size Live holds; `shownOf` reads the run Live shows.
 */
function embedReloads(embeds: ReturnType<typeof embedHolds>, shownOf: (project: string) => NativeRunStatus | null) {
  /** Each game's Reload under way, with the embedded run it ends (null when none was running). */
  const reloads = new Map<string, { runId: string | null }>();
  const restart = (project: string): void => {
    reloads.delete(project);
    const size = embeds.sizeOf(project);
    if (size) void embeds.embed(project, size);
  };
  /** An embedded run's word: the run a Reload ends, once ended, starts again at once. */
  const received = (status: NativeRunStatus): void => {
    const reload = reloads.get(status.project);
    if (reload?.runId === status.runId && nativeRunEnded(status)) restart(status.project);
  };
  const afterReload = async (project: string, reloading: Promise<unknown>): Promise<void> => {
    if (!embeds.sizeOf(project)) {
      await reloading.catch(() => {});
      return;
    }
    const shown = shownOf(project);
    const reload = { runId: shown && !nativeRunEnded(shown) ? shown.runId : null };
    reloads.set(project, reload);
    await reloading.catch(() => {});
    // Already started again (its run's stop arrived first), or a later Reload took over.
    if (reloads.get(project) !== reload) return;
    reloads.delete(project);
    const now = shownOf(project);
    if (!now || nativeRunEnded(now)) restart(project);
  };
  return { received, afterReload };
}

const stores = new WeakMap<NativeApi, NativeStore>();

/** The one native store over `api`, listening from its first use for as long as the app runs. */
export function nativeStoreFor(api: NativeApi): NativeStore {
  let store = stores.get(api);
  if (!store) {
    store = createNativeStore(api);
    store.start();
    stores.set(api, store);
  }
  return store;
}
