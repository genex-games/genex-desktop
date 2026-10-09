/**
 * The stage's views, and when Live may change. While the person watches Live only they change it:
 * a run's new build, a change to the game folder and a build found broken each mark Reload
 * instead (`liveBehindOf`), and Reload applies it. What waits while Live is out of sight is
 * applied at once (`appliesUnseen`), so Live is current when they come back. The one automatic
 * swap is the empty scaffold's: it has no game to lose, so the run's first healthy build shows.
 */

import { LiveBehindReason, type LiveBehindEvent } from "../shared/live-behind.ts";
import { type FactRef, type FolderHolds, kindPending } from "../shared/project-facts.ts";

/**
 * What the stage shows. `File` is a file opened from the chat; it is never remembered across
 * launches. Persisted values (`studio.previewView`): never rename one.
 */
export const StageView = {
  Live: "live",
  Builds: "builds",
  Assets: "assets",
  File: "file",
} as const;
export type StageView = (typeof StageView)[keyof typeof StageView];

const VIEWS: readonly StageView[] = [StageView.Live, StageView.Builds, StageView.Assets];

/**
 * A remembered view name this build still has (the layout store reads and writes
 * `studio.previewView` through it, so `file` is never written or restored).
 */
export const isStageView = (value: unknown): value is StageView => VIEWS.includes(value as StageView);

/**
 * The build the stage can offer right now: the newest merge of the run, unless something has
 * found that it does not run, and only while it is not already what the stage is showing. It
 * carries what is known about its health, because only a build a health pass says runs is offered.
 */
export function newBuildOffer(
  merged: { head: string; at: string; healthy: boolean | null } | null,
  shownHead: string | null,
): { head: string; at: string; healthy: boolean | null } | null {
  if (!merged || merged.healthy === false) return null;
  if (shownHead && sameCommit(merged.head, shownHead)) return null;
  return { head: merged.head, at: merged.at, healthy: merged.healthy };
}

/** The shortest hash the studio names a commit by (`COMMIT_HASH` in main): shorter says nothing. */
const SHORT_HASH_MIN = 7;

/** Two names of one commit: equal, or one the other's abbreviation. */
function sameCommit(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  return short.length >= SHORT_HASH_MIN && long.startsWith(short);
}

/**
 * Main's word on Live once the stage's mount read (`liveBehind`) answers: an event heard since the
 * read was asked is newer, so it stands; otherwise the read is what main holds now.
 */
export function laterOf(
  now: LiveBehindEvent | null,
  read: LiveBehindEvent,
  heardSince: boolean,
): LiveBehindEvent | null {
  return heardSince ? now : read;
}

/** A build the stage can offer: the run's newest merge, with what is known about its health. */
export type BuildOffer = NonNullable<ReturnType<typeof newBuildOffer>>;

/** What Live's Reload would bring, and why: main's waiting change, the run's newest build, or a way back from a broken one. */
export interface LiveBehind {
  reason: LiveBehindReason;
  /** A builder's own words about the change, when it left some. */
  note: string | null;
  /** The build Reload plays: the one main holds, or the run's newest; null for the game folder. */
  head: string | null;
  /** Main holds this change (`live.behind`), so Reload asks main for it. */
  held: boolean;
}

/**
 * What Reload offers now. Main's change comes first: it is what the studio did to the game or
 * what the lead chose to show. Then a healthy build of the run nobody is showing — nobody asked
 * for it, so only one a health pass says runs; merged is not checked. Then, when the build on the
 * stage was found not to run, the way back to the game folder.
 */
export function liveBehindOf(now: {
  waiting: LiveBehindEvent | null;
  offer: BuildOffer | null;
  shownBroken: boolean;
}): LiveBehind | null {
  const { waiting, offer } = now;
  if (waiting?.reason) return { reason: waiting.reason, note: waiting.note, head: waiting.commit, held: true };
  if (offer?.healthy === true) return { reason: LiveBehindReason.Build, note: null, head: offer.head, held: false };
  if (now.shownBroken) return { reason: LiveBehindReason.Broken, note: null, head: null, held: false };
  return null;
}

/** What the stage shows, as far as the rules below care. */
export interface StageWatch {
  view: StageView;
  /** The game stage is on screen (not Studio, not the plugins page). */
  visible: boolean;
  /** Live shows the empty scaffold's placeholder, not a game. */
  showEmpty: boolean;
}

/** Whether the person is watching a game in Live: then only they change it. */
export const watchingLive = (stage: StageWatch): boolean =>
  stage.visible && stage.view === StageView.Live && !stage.showEmpty;

/**
 * Whether what waits for Live (anything but a run's newest build, which only ever waits for
 * the person) goes in without asking: nobody is watching a game in Live.
 */
export function appliesUnseen(behind: LiveBehind | null, stage: StageWatch): boolean {
  if (!behind || watchingLive(stage)) return false;
  return behind.held || behind.reason === LiveBehindReason.Broken;
}

/** The empty scaffold's exception: its placeholder has no game to lose, so the run's first healthy build shows. */
export function firstBuildShows(offer: BuildOffer | null, stage: StageWatch): boolean {
  const onPlaceholder = stage.visible && stage.view === StageView.Live && stage.showEmpty;
  return offer?.healthy === true && onPlaceholder;
}

/**
 * Whether the game on the stage has no kind yet: it lists no facts and its folder nothing of its own
 * (`kindPending`), so its first message decides what it becomes. Live shows the first-idea state and
 * loads no page for it. A game listed without facts at all (an older listing) has a kind.
 */
export function kindPendingGame(game: { facts?: readonly FactRef[]; holds?: FolderHolds } | null | undefined): boolean {
  return Array.isArray(game?.facts) && kindPending({ facts: game.facts, holds: game.holds });
}

/** The game on the stage as one render saw it: which game, and whether it had no kind yet. */
export interface StageGameKind {
  project: string | null;
  pending: boolean;
}

/**
 * Whether the stage's game took its kind between two renders (its first message started it as a
 * web game): Live, which loaded nothing while it had none, loads its page now. A new game on the
 * stage loads through the stage follower instead.
 */
export const gameStartedSince = (before: StageGameKind, now: StageGameKind): boolean =>
  now.project !== null && before.project === now.project && before.pending && !now.pending;
