/**
 * Save and Share on a game's assets: where each of the open game's files stands with the person's
 * genex.games library (saved, shared, can be shared), and each share on its card's line, from
 * Send through genex.games' Check to Live, or why it missed.
 *
 * One call does the whole share; the line lights Check once it has been out a moment, since that
 * is where genex.games spends the time, and a quick answer waits until the steps have been seen. A
 * share genex.games is still checking is read again a little later until it is live. Actions are pure `(state, input) => state`; `createSharingStore`
 * binds them to a `StudioApi`.
 */
import { createStore, type StoreApi } from "zustand/vanilla";
import {
  type GameLibraryStates,
  inBatches,
  type ShareItem,
  ShareMiss,
  type ShareOutcome,
  type SharedAsset,
  shareInBatches,
} from "../../shared/asset-library.ts";
import { SECOND_MS } from "../../shared/duration.ts";
import type { StudioApi } from "../../shared/studio-api.ts";
import { type ShareProgress, ShareStep } from "../asset-library-view.ts";
import { createRefresher, type Refresher } from "./refresher.ts";

/** How long a share shows Send before Check lights, while the call is still out. */
export const SEND_STEP_MS = 1000;
/** The least time a line shows its steps, so a quick answer reads as steps rather than a flash. */
export const STEPS_SHOWN_MS = 2 * SECOND_MS;
/** How long ✓ On Play stays under a card before it goes. */
export const LIVE_SHOWN_MS = 4 * SECOND_MS;
/** How long until a share genex.games is still checking is read again, and how many times. */
export const CHECK_REREAD_MS = 15 * SECOND_MS;
export const CHECK_REREADS = 4;

export interface SharingState {
  /** Each read game's files as the library knows them. */
  games: Record<string, GameLibraryStates>;
  /** Each game's shares on its cards, by file: under way, just live, or missed. */
  shares: Record<string, Record<string, ShareProgress>>;
}

export const initialSharing = (): SharingState => ({ games: {}, shares: {} });

const NO_SHARES: Record<string, ShareProgress> = {};

/** A game's library states, or null before the first read. */
export const libraryOf = (state: SharingState, project: string): GameLibraryStates | null =>
  state.games[project] ?? null;

/** A game's shares on its cards, by file. */
export const sharesOf = (state: SharingState, project: string): Record<string, ShareProgress> =>
  state.shares[project] ?? NO_SHARES;

/** `project`'s shares with `change` applied to each file it names (an undefined answer removes the file's). */
function withShares(
  state: SharingState,
  project: string,
  files: readonly string[],
  change: (current: ShareProgress | undefined, file: string) => ShareProgress | undefined,
): SharingState {
  const shares = { ...sharesOf(state, project) };
  for (const file of files) {
    const next = change(shares[file], file);
    if (next) shares[file] = next;
    else delete shares[file];
  }
  return { ...state, shares: { ...state.shares, [project]: shares } };
}

/** Files whose share genex.games was still checking and the library now lists as live. */
export function checkedLive(state: SharingState, read: GameLibraryStates): string[] {
  const shares = sharesOf(state, read.project);
  return read.states
    .filter((entry) => entry.shared?.live && shares[entry.file]?.miss === ShareMiss.Checking)
    .map((entry) => entry.file);
}

/** A game's states as read (or as Save and Stop sharing answered); a check that passed shows live. */
export function statesRead(state: SharingState, read: GameLibraryStates): SharingState {
  const live = checkedLive(state, read);
  const next = { ...state, games: { ...state.games, [read.project]: read } };
  return withShares(next, read.project, live, (current) => current && { ...current, step: ShareStep.Live, miss: null });
}

/** Shares sent: each card's line starts at Send. */
export function sharesStarted(state: SharingState, project: string, items: readonly ShareItem[]): SharingState {
  const names = new Map(items.map((item) => [item.file, item.name]));
  return withShares(state, project, [...names.keys()], (_, file) => ({
    name: names.get(file) ?? file,
    step: ShareStep.Send,
    miss: null,
    reported: false,
  }));
}

/** Shares out a moment: the ones still at Send light Check. */
export function sharesChecking(state: SharingState, project: string, files: readonly string[]): SharingState {
  return withShares(state, project, files, (current) =>
    current?.step === ShareStep.Send ? { ...current, step: ShareStep.Check } : current,
  );
}

/** The shared asset an outcome gave each file. */
const sharedBy = (outcomes: readonly ShareOutcome[]): Map<string, SharedAsset> =>
  new Map(outcomes.flatMap((outcome) => ("shared" in outcome ? [[outcome.file, outcome.shared] as const] : [])));

/** How one outcome leaves its card's line. */
function answeredProgress(current: ShareProgress | undefined, outcome: ShareOutcome): ShareProgress | undefined {
  if (!current) return current;
  if ("shared" in outcome) return { ...current, step: ShareStep.Live, miss: null };
  if (outcome.miss === ShareMiss.Checking) return { ...current, step: ShareStep.Check, miss: ShareMiss.Checking };
  return {
    ...current,
    step: ShareStep.Missed,
    miss: outcome.miss,
    ...(outcome.detail ? { detail: outcome.detail } : {}),
  };
}

/** How the shares went: live ones show ✓ and their Shared tag at once; the others say why. */
export function sharesAnswered(state: SharingState, project: string, outcomes: readonly ShareOutcome[]): SharingState {
  const byFile = new Map(outcomes.map((outcome) => [outcome.file, outcome]));
  const shared = sharedBy(outcomes);
  const game = state.games[project];
  const games = game
    ? {
        ...state.games,
        [project]: {
          ...game,
          states: game.states.map((entry) => ({ ...entry, shared: shared.get(entry.file) ?? entry.shared })),
        },
      }
    : state.games;
  return withShares({ ...state, games }, project, [...byFile.keys()], (current, file) => {
    const outcome = byFile.get(file);
    return outcome ? answeredProgress(current, outcome) : current;
  });
}

/** A card's line goes: ✓ faded, Try again pressed, or the share was stopped. */
export function shareCleared(state: SharingState, project: string, file: string): SharingState {
  if (!sharesOf(state, project)[file]) return state;
  return withShares(state, project, [file], () => undefined);
}

/** A refusal's report went to the Genex team. */
export function shareReported(state: SharingState, project: string, file: string): SharingState {
  return withShares(state, project, [file], (current) => current && { ...current, reported: true });
}

/** Files of `project` whose line is at `step`. */
const filesAt = (state: SharingState, project: string, files: readonly string[], step: ShareStep): string[] =>
  files.filter((file) => sharesOf(state, project)[file]?.step === step);

export interface SharingStore extends StoreApi<SharingState> {
  /** Read where the game's files stand; a newer read wins, and an unreadable library reads as signed out. */
  read(project: string): Promise<void>;
  /** Save files (or take Saved off); the states Save answers. */
  save(project: string, files: string[], saved: boolean): Promise<void>;
  /** Share files under their names; each card's line follows it. Never rejects: a failure is a missed line. */
  share(project: string, items: ShareItem[]): Promise<void>;
  /** Take a file off Play; the states it answers. */
  unshare(project: string, file: string): Promise<void>;
  /** A card's line goes. */
  clear(project: string, file: string): void;
  /** A refusal's report went. */
  reported(project: string, file: string): void;
}

export interface SharingTimers {
  setTimeout(run: () => void, ms: number): unknown;
}

const browserTimers: SharingTimers = { setTimeout: (run, ms) => globalThis.setTimeout(run, ms) };

export function createSharingStore(
  api: Pick<StudioApi, "assetLibraryStates" | "assetSave" | "assetShare" | "assetUnshare">,
  timers: SharingTimers = browserTimers,
): SharingStore {
  const store = createStore<SharingState>()(() => initialSharing());
  const readers = new Map<string, Refresher>();
  const apply = (read: GameLibraryStates): void => {
    const live = checkedLive(store.getState(), read);
    store.setState((state) => statesRead(state, read), true);
    fadeLive(read.project, live);
  };
  /** ✓ On Play goes after a while, unless the line moved on. */
  const fadeLive = (project: string, files: readonly string[]): void => {
    if (files.length === 0) return;
    timers.setTimeout(() => {
      for (const file of filesAt(store.getState(), project, files, ShareStep.Live)) clear(project, file);
    }, LIVE_SHOWN_MS);
  };
  const clear = (project: string, file: string): void =>
    store.setState((state) => shareCleared(state, project, file), true);
  const readerOf = (project: string): Refresher => {
    let reader = readers.get(project);
    if (!reader) {
      reader = createRefresher(() => api.assetLibraryStates(project), apply, {
        onError: () => apply({ project, states: [], unread: true }),
      });
      readers.set(project, reader);
    }
    return reader;
  };
  /** Read again while genex.games checks, a few times; the line goes if it never says. */
  const recheck = (project: string, files: readonly string[], left: number): void => {
    timers.setTimeout(() => {
      void readerOf(project)
        .request()
        .then(() => {
          const still = files.filter((file) => sharesOf(store.getState(), project)[file]?.miss === ShareMiss.Checking);
          if (still.length === 0) return;
          if (left > 1) recheck(project, still, left - 1);
          else for (const file of still) clear(project, file);
        });
    }, CHECK_REREAD_MS);
  };
  /** A write's own answer wins: a read that started before it lands nowhere. */
  const applyWrite = (project: string, read: GameLibraryStates): void => {
    readerOf(project).reset();
    apply(read);
  };
  const failed = (items: readonly ShareItem[]): ShareOutcome[] =>
    items.map((item) => ({ file: item.file, miss: ShareMiss.Failed }));

  return Object.assign(store, {
    read: (project: string) => readerOf(project).request(),
    async save(project: string, files: string[], saved: boolean): Promise<void> {
      for (const run of inBatches(files)) applyWrite(project, await api.assetSave(project, run, saved));
    },
    async share(project: string, items: ShareItem[]): Promise<void> {
      const files = items.map((item) => item.file);
      store.setState((state) => sharesStarted(state, project, items), true);
      timers.setTimeout(() => store.setState((state) => sharesChecking(state, project, files), true), SEND_STEP_MS);
      const seen = new Promise<void>((done) => timers.setTimeout(done, STEPS_SHOWN_MS));
      const sent = shareInBatches((run) => api.assetShare(project, run).catch(() => failed(run)), items);
      const [outcomes] = await Promise.all([sent, seen]);
      store.setState((state) => sharesAnswered(state, project, outcomes), true);
      fadeLive(project, filesAt(store.getState(), project, files, ShareStep.Live));
      const checking = outcomes.filter((outcome) => "miss" in outcome && outcome.miss === ShareMiss.Checking);
      if (checking.length > 0)
        recheck(
          project,
          checking.map((outcome) => outcome.file),
          CHECK_REREADS,
        );
    },
    async unshare(project: string, file: string): Promise<void> {
      applyWrite(project, await api.assetUnshare(project, file));
      clear(project, file);
    },
    clear,
    reported: (project: string, file: string) => store.setState((state) => shareReported(state, project, file), true),
  });
}
