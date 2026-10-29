/**
 * The bar layer's decisions, pure: which opening of the viewer its news is about and how the bar
 * stands after it, and how Comments' pages add up and read. `PlayBarPage.tsx` and `PlayComments.tsx`
 * draw what these decide.
 */
import { MINUTE_MS } from "../../shared/duration.ts";
import { type PlayBarState, type PlayViewerEvent, PlayViewerPhase } from "../../shared/play.ts";
import type { PlayBarHold } from "../../shared/play-bar.ts";
import type { PlayComment, PlayCommentsPage } from "../../shared/play-comments.ts";

/** The game the bar is over, as main last drew it. */
export interface BarView {
  slug: string;
  openId: number;
  phase: PlayViewerPhase;
  bar: PlayBarState | null;
  /** How many times an Esc held in the game has asked for the bar to take the keyboard. */
  focusAsks: number;
}

/**
 * The bar after main's news: a later opening replaces the one shown, news of an earlier one is
 * dropped, and the closing of the one shown leaves nothing.
 */
export function barNews(shown: BarView | null, event: PlayViewerEvent): BarView | null {
  if (shown && event.openId < shown.openId) return shown;
  if (event.phase === PlayViewerPhase.Closed) return shown?.openId === event.openId ? null : shown;
  const base: BarView =
    shown?.openId === event.openId
      ? shown
      : { slug: event.slug, openId: event.openId, phase: event.phase, bar: null, focusAsks: 0 };
  return {
    ...base,
    phase: event.phase,
    bar: event.bar ?? base.bar,
    focusAsks: base.focusAsks + (event.focusBar ? 1 : 0),
  };
}

/** Comments as the modal holds them: the pages read so far, and how the reading stands. */
export interface CommentsList {
  items: PlayComment[];
  nextCursor: string | null;
  status: CommentsStatus;
  /** A further page is on its way. */
  loadingMore: boolean;
}

/** Where the first page stands. Never rename a value. */
export const CommentsStatus = { Loading: "loading", Ready: "ready", Failed: "failed" } as const;
export type CommentsStatus = (typeof CommentsStatus)[keyof typeof CommentsStatus];

/** Comments before the first page. */
export const NO_COMMENTS: CommentsList = {
  items: [],
  nextCursor: null,
  status: CommentsStatus.Loading,
  loadingMore: false,
};

/** The list after a page: the first replaces it, a further one adds the comments it does not have yet. */
export function withCommentsPage(list: CommentsList, page: PlayCommentsPage, more: boolean): CommentsList {
  if (!more)
    return { items: [...page.items], nextCursor: page.nextCursor, status: CommentsStatus.Ready, loadingMore: false };
  const known = new Set(list.items.map((comment) => comment.id));
  const added = page.items.filter((comment) => !known.has(comment.id));
  return { ...list, items: [...list.items, ...added], nextCursor: page.nextCursor, loadingMore: false };
}

/** The list with the account's new comment on top. */
export const withPosted = (list: CommentsList, comment: PlayComment): CommentsList => ({
  ...list,
  items: [comment, ...list.items.filter((item) => item.id !== comment.id)],
});

/** The list without a deleted comment. */
export const withoutComment = (list: CommentsList, id: string): CommentsList => ({
  ...list,
  items: list.items.filter((item) => item.id !== id),
});

/** Nothing told main yet: a page that has just mounted, or a new game opened under it. */
export const NOTHING_TOLD = "";

/**
 * What the layer tells main about itself, given what it last told (`told`, a key from an earlier
 * answer): nothing when that is unchanged; the first word after `NOTHING_TOLD` asks main to draw the
 * bar again for it (`ready`).
 */
export function holdToTell(told: string, hold: PlayBarHold): { key: string; payload: PlayBarHold } | null {
  const plain = { comments: hold.comments };
  const key = holdKey(plain);
  if (key === told) return null;
  return { key, payload: told === NOTHING_TOLD ? { ...plain, ready: true } : plain };
}

/** The key a hold is remembered by, once told. */
export const holdKey = (hold: PlayBarHold): string => JSON.stringify({ comments: hold.comments });

/** What Esc in the bar's layer does. Never rename a value. */
export const BarEscape = {
  /** Nothing: Comments closes itself, a purchase sheet answers it, a key held down repeats, or no game is open. */
  None: "none",
  /** The game is playing: the keyboard goes back to it. */
  Resume: "resume",
  /** The game is not on screen yet (or failed): the viewer closes, as the cover's Esc does. */
  Leave: "leave",
} as const;
export type BarEscape = (typeof BarEscape)[keyof typeof BarEscape];

/** What an Esc press in the bar's layer does, by the game's phase. */
export function barEscape(
  phase: PlayViewerPhase | undefined,
  press: { repeat: boolean; commentsOpen: boolean; sheetOpen: boolean },
): BarEscape {
  // Comments and a purchase sheet each answer Esc themselves; the game stays covered under them.
  const covered = press.commentsOpen || press.sheetOpen;
  if (!phase || press.repeat || covered) return BarEscape.None;
  return phase === PlayViewerPhase.Playing ? BarEscape.Resume : BarEscape.Leave;
}

/** Whole minutes since `at`, never below zero (a clock a little behind genex.games'). */
export const minutesSince = (at: number, now: number): number => Math.max(0, Math.floor((now - at) / MINUTE_MS));
