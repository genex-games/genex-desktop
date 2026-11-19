/**
 * Opening Play from elsewhere (the Genex plugin's Credits tab opens Friends, to invite; a published
 * game's Open, in the chat's live card and in Publish, opens the game's own page; a published
 * game's stats open its analytics page): the page is chosen in Play's store, then the shell brings
 * Play up over whatever covers the workspace.
 */
import { ownStatsView } from "../state/play.ts";
import { studio } from "../state/studio.ts";
import type { AnalyticsTab } from "./game-analytics/tabs.ts";

/** The window event the shell answers by bringing Play up. */
export const OPEN_PLAY_EVENT = "studio:open-play";

/** Bring Play up on its Friends page. */
export function openPlayFriends(): void {
  studio().play.showFriends();
  window.dispatchEvent(new CustomEvent(OPEN_PLAY_EVENT));
}

/** Bring Play up on the page of the game whose link on Genex is `slug`. */
export function openPlayGame(slug: string): void {
  studio().play.showGame(slug);
  window.dispatchEvent(new CustomEvent(OPEN_PLAY_EVENT));
}

/**
 * Bring Play up on the analytics of the account's game whose link on Genex is `slug`, on `tab`
 * (Overview unless named). Its Back goes to the account's Stats page, as if the game had been
 * opened from the Stats table, and not to whatever page Play happened to show last; signed out
 * there is no Stats page, and Back goes to the shelf.
 */
export function openPlayGameAnalytics(slug: string, tab?: AnalyticsTab): void {
  const { play, people } = studio();
  play.showGameAnalytics(slug, tab, ownStatsView(people.getState().me?.id ?? null));
  window.dispatchEvent(new CustomEvent(OPEN_PLAY_EVENT));
}
