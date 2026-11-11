/**
 * Opening Play from elsewhere (the Genex plugin's Credits tab opens Friends, to invite; a published
 * game's Open, in the chat's live card and in Publish, opens the game's own page): the page is
 * chosen in Play's store, then the shell brings Play up over whatever covers the workspace.
 */
import { studio } from "../state/studio.ts";

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
