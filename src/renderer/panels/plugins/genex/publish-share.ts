/**
 * Publish's one line that shares the game's assets on Play when it goes live, pure: when the line
 * shows, which files it shares under which names, and how the shares went, as one line says it.
 */
import {
  type AssetLibraryState,
  type GameLibraryStates,
  libraryKindOf,
  type LibraryKind,
  ShareMiss,
  type ShareItem,
  shareNameOf,
  type ShareOutcome,
} from "../../../../shared/asset-library.ts";
import type { ProjectAsset } from "../../../../shared/game-assets.ts";

/**
 * Whether Publish closed with the switch on before the share ran: the game may go live without its
 * assets, so the next time the dialog opens it says so and offers Share now.
 */
export const closedBeforeShare = (on: boolean, started: boolean, count: number): boolean => on && !started && count > 0;

/** How many of the shared assets the line shows as pictures. */
export const SHARE_THUMBS_MAX = 3;

/** The game's files Share can put on Play that are not on it now: Genex made them, and none is live. */
export function unsharedStates(states: GameLibraryStates | null): AssetLibraryState[] {
  if (!states || states.unread) return [];
  return states.states.filter((state) => state.shareable && !state.shared?.live);
}

/** Whether the line shows: the account is signed in and the game has an asset to put on Play. */
export const shareLineShown = (signedIn: boolean, states: GameLibraryStates | null): boolean =>
  signedIn && unsharedStates(states).length > 0;

/** The files to share, each under the name Play shows: the first line it was made from, else its file's. */
export function shareItems(
  states: GameLibraryStates | null,
  assets: readonly Pick<ProjectAsset, "file" | "prompt">[],
): ShareItem[] {
  const prompts = new Map(assets.map((asset) => [asset.file, asset.prompt]));
  return unsharedStates(states).map((state) => ({
    file: state.file,
    name: shareNameOf(prompts.get(state.file), state.file),
  }));
}

/** One of the line's pictures: the generation's thumbnail when the library has one, else its kind. */
export interface ShareThumb {
  file: string;
  generationId: string | null;
  kind: LibraryKind | null;
}

/** The first few files to share, with what their pictures are read from. */
export function shareThumbs(
  states: GameLibraryStates | null,
  assets: readonly Pick<ProjectAsset, "file" | "kind">[],
): ShareThumb[] {
  const kinds = new Map(assets.map((asset) => [asset.file, libraryKindOf(asset)]));
  return unsharedStates(states)
    .slice(0, SHARE_THUMBS_MAX)
    .map((state) => ({ file: state.file, generationId: state.generationId, kind: kinds.get(state.file) ?? null }));
}

/** How the shares went: how many are on Play, how many go live once checked, and the files to try again. */
export interface ShareTally {
  shared: number;
  checking: number;
  missed: string[];
}

/** No shares yet. */
export const NO_SHARES: ShareTally = { shared: 0, checking: 0, missed: [] };

/** Misses no retry can turn into a share (genex.games takes no shares of the kind, or the file isn't Genex's). */
const FINAL_MISSES: ReadonlySet<ShareMiss> = new Set([ShareMiss.KindNotShareable, ShareMiss.NotShareable]);

/**
 * The tally of one batch of shares, added to the one before it (a retry's files were its misses). A
 * miss no retry can fix is left out: it is neither on Play nor worth a Try again.
 */
export function tallyShares(outcomes: readonly ShareOutcome[], before: ShareTally = NO_SHARES): ShareTally {
  const tally: ShareTally = { shared: before.shared, checking: before.checking, missed: [] };
  for (const outcome of outcomes) {
    if ("shared" in outcome) tally.shared += 1;
    else if (outcome.miss === ShareMiss.Checking) tally.checking += 1;
    else if (!FINAL_MISSES.has(outcome.miss)) tally.missed.push(outcome.file);
  }
  return tally;
}

/** A batch that never got an answer (offline, an outage): every file in it missed. */
export const allMissed = (items: readonly ShareItem[], before: ShareTally = NO_SHARES): ShareTally => ({
  shared: before.shared,
  checking: before.checking,
  missed: items.map((item) => item.file),
});

/** The items of `items` a retry sends: the ones the tally says missed. */
export const retryItems = (items: readonly ShareItem[], tally: ShareTally): ShareItem[] =>
  items.filter((item) => tally.missed.includes(item.file));

/**
 * How the line reads after the shares: what missed, else what is on Play (or will be once
 * checked), else nothing (every share was one no retry can fix).
 */
export const ShareLine = { Missed: "missed", Checking: "checking", Shared: "shared", None: "none" } as const;
export type ShareLine = (typeof ShareLine)[keyof typeof ShareLine];

/** Which line the tally gets, and the count it says. */
export function shareLine(tally: ShareTally): { line: ShareLine; count: number } {
  if (tally.missed.length > 0) return { line: ShareLine.Missed, count: tally.missed.length };
  const count = tally.shared + tally.checking;
  if (count === 0) return { line: ShareLine.None, count };
  return { line: tally.checking > 0 ? ShareLine.Checking : ShareLine.Shared, count };
}

/** What the share does as the dialog's success comes and goes. */
export const CelebrationStep = { Start: "start", Reset: "reset", None: "none" } as const;
export type CelebrationStep = (typeof CelebrationStep)[keyof typeof CelebrationStep];

/**
 * The share's step for the dialog's success `was` → `now`: start while it celebrates (the share
 * runs once), reset only when a celebration ends, so a share pressed outside one (Share now) keeps
 * its line through the reads that follow it.
 */
export function celebrationStep(was: boolean, now: boolean): CelebrationStep {
  if (now) return CelebrationStep.Start;
  return was ? CelebrationStep.Reset : CelebrationStep.None;
}
