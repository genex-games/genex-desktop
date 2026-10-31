import { browserVisibility, type VisibilitySource } from "./visibility.ts";
import { sameSnapshot, shareRecords } from "./snapshot-equality.ts";
/**
 * The game library: the games, where they live, which are building, the self-improvement
 * suggestions waiting, and each open game's asset inventory.
 *
 * Asset inventories are watched, not polled per panel: the Builds timeline and the Assets stage
 * both call `watchAssets(project)`, and one read (every ten seconds, and on a plugin's or a
 * delivery's word) serves both. A hand-dropped file appears without any event, hence the poll.
 *
 * Actions are pure `(state, input) => state`; `createLibraryStore` binds them to a `StudioApi`.
 */
import { createStore, type StoreApi } from "zustand/vanilla";
import { SECOND_MS } from "../../shared/duration.ts";
import type { GameUpdate } from "../../shared/game-library.ts";
import type { Bootstrap, GameProject, ProjectAssets, StudioApi } from "../../shared/studio-api.ts";
import { createRefresher, type Refresher } from "./refresher.ts";

/** How often a watched inventory is walked again. */
export const ASSET_POLL_MS = 10 * SECOND_MS;

export interface AssetInventory {
  value: ProjectAssets | null;
  /** The last read failed; `value` is what the read before it found. */
  error: string | null;
}

export interface LibraryState {
  games: GameProject[];
  /** `~/AI Games` as a human reads it. */
  rootLabel: string;
  /** Where run folders live, for stills recorded before a run named its own. */
  runsRoot: string | null;
  /** Games a builder is working in right now. */
  building: ReadonlySet<string>;
  /** Watched games' asset inventories. */
  assets: Record<string, AssetInventory>;
}

export const initialLibrary = (): LibraryState => ({
  games: [],
  rootLabel: "games",
  runsRoot: null,
  building: new Set(),
  assets: {},
});

/**
 * The library as the bootstrap found it. Games with a builder at work read as building from the
 * start, so a reload during a build does not lose the badge until the next `delegation.*` event.
 */
export function libraryBootstrapped(
  state: LibraryState,
  boot: Pick<Bootstrap, "games" | "gamesRootLabel" | "layout"> & Partial<Pick<Bootstrap, "activeDelegations">>,
): LibraryState {
  const building = new Set(
    Object.entries(boot.activeDelegations ?? {})
      .filter(([, active]) => active > 0)
      .map(([project]) => project),
  );
  return {
    ...state,
    games: boot.games,
    rootLabel: boot.gamesRootLabel ?? "games",
    runsRoot: boot.layout.runs ?? null,
    building,
  };
}

export function gamesLoaded(state: LibraryState, games: GameProject[]): LibraryState {
  const shared = shareRecords(state.games, games, (game) => game.name);
  return shared === state.games ? state : { ...state, games: shared };
}

/** A game main just saved replaces its old record. */
export function gameSaved(state: LibraryState, game: GameProject): LibraryState {
  return { ...state, games: state.games.map((item) => (item.name === game.name ? game : item)) };
}

/** A game just created goes to the end, replacing any record of the same name. */
export function gameAdded(state: LibraryState, game: GameProject): LibraryState {
  return { ...state, games: [...state.games.filter((item) => item.name !== game.name), game] };
}

export function gameRemoved(state: LibraryState, name: string): LibraryState {
  return { ...state, games: state.games.filter((game) => game.name !== name) };
}

/**
 * A builder started or finished in a game. `active` is how many are still working there; an
 * older producer without it is read from the event's own name.
 */
export function delegationChanged(
  state: LibraryState,
  change: { started: boolean; project?: string; active?: number },
): LibraryState {
  if (!change.project) return state;
  const working = typeof change.active === "number" ? change.active > 0 : change.started;
  if (working === state.building.has(change.project)) return state;
  const building = new Set(state.building);
  if (working) building.add(change.project);
  else building.delete(change.project);
  return { ...state, building };
}

/** The games folder was changed in Settings: new games are created under this one. */
export function rootLabelChanged(state: LibraryState, rootLabel: string): LibraryState {
  return state.rootLabel === rootLabel ? state : { ...state, rootLabel };
}

export function assetsLoaded(state: LibraryState, project: string, value: ProjectAssets): LibraryState {
  const previous = state.assets[project];
  if (previous?.error === null && sameSnapshot(previous.value, value)) return state;
  return { ...state, assets: { ...state.assets, [project]: { value, error: null } } };
}

export function assetsFailed(state: LibraryState, project: string, error: string): LibraryState {
  return { ...state, assets: { ...state.assets, [project]: { value: state.assets[project]?.value ?? null, error } } };
}

const NO_ASSETS: AssetInventory = { value: null, error: null };
export const assetsOf = (state: LibraryState, project: string | null | undefined): AssetInventory =>
  (project ? state.assets[project] : undefined) ?? NO_ASSETS;

export interface LibraryStore extends StoreApi<LibraryState> {
  refreshGames(): Promise<void>;
  saveGame(name: string, patch: GameUpdate): Promise<void>;
  removeGame(name: string): Promise<void>;
  /** Keep this game's inventory fresh while the returned function has not been called. */
  watchAssets(project: string): () => void;
  /** Read a watched game's inventory again now (`null`: every watched game). */
  refreshAssets(project: string | null): void;
}

export interface LibraryTimers {
  setInterval(run: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const browserTimers: LibraryTimers = {
  setInterval: (run, ms) => globalThis.setInterval(run, ms),
  clearInterval: (handle) => globalThis.clearInterval(handle as ReturnType<typeof setInterval>),
};

export function createLibraryStore(
  api: Pick<StudioApi, "games" | "updateGame" | "removeGame" | "projectAssets">,
  timers: LibraryTimers = browserTimers,
  visibility: VisibilitySource = browserVisibility,
  publish?: (apply: () => void) => void,
): LibraryStore {
  const store = createStore<LibraryState>()(() => initialLibrary());
  const games = createRefresher(
    api.games.bind(api),
    (list) => store.setState((state) => gamesLoaded(state, list), true),
    { publish },
  );
  let unwatchVisibility: (() => void) | undefined;
  const watched = new Map<string, { count: number; timer: unknown; reader: Refresher }>();

  const reader = (project: string): Refresher =>
    createRefresher(
      () => api.projectAssets(project),
      // An answer for another game (a renamed folder, a stale reply) is not this game's inventory.
      (value) => {
        if (value.project === project) store.setState((state) => assetsLoaded(state, project, value), true);
      },
      { onError: (error) => store.setState((state) => assetsFailed(state, project, String(error)), true) },
    );

  return Object.assign(store, {
    refreshGames: () => games.request(),
    async saveGame(name: string, patch: GameUpdate): Promise<void> {
      const updated = await api.updateGame(name, patch);
      store.setState((state) => gameSaved(state, updated), true);
    },
    async removeGame(name: string): Promise<void> {
      await api.removeGame(name);
      store.setState((state) => gameRemoved(state, name), true);
    },
    watchAssets(project: string): () => void {
      let entry = watched.get(project);
      if (!entry) {
        const read = reader(project);
        entry = {
          count: 0,
          reader: read,
          timer: timers.setInterval(() => {
            if (!visibility.hidden()) void read.request();
          }, ASSET_POLL_MS),
        };
        watched.set(project, entry);
        unwatchVisibility ??= visibility.subscribe(() => {
          if (!visibility.hidden()) for (const value of watched.values()) void value.reader.request();
        });
        if (!visibility.hidden()) void read.request();
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
        timers.clearInterval(current.timer);
        current.reader.reset();
        watched.delete(project);
        if (!watched.size) {
          unwatchVisibility?.();
          unwatchVisibility = undefined;
        }
      };
    },
    refreshAssets(project: string | null): void {
      for (const [name, entry] of watched) if (project === null || project === name) void entry.reader.request();
    },
  });
}
