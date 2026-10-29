/**
 * Each studio window's Play views, as the viewer wires them (`viewer-view.ts`) and the development
 * control reads them (`dev/runtime.ts`). Its own module, with no Electron value import, so the
 * development control loads without the viewer's Electron surface.
 */
import type { BrowserWindow, WebContentsView } from "electron";

/** The viewer's views in a window: its bar's layer once made, and the game's view while a game is open. */
export interface PlayViews {
  bar(): WebContentsView | null;
  game(): WebContentsView | null;
}

const viewsOf = new WeakMap<BrowserWindow, PlayViews>();

/** `win`'s Play views, for the development control; null before the viewer is wired. */
export const playViewsOf = (win: BrowserWindow): PlayViews | null => viewsOf.get(win) ?? null;

/** Records `win`'s Play views once the viewer has wired them. */
export function registerPlayViews(win: BrowserWindow, views: PlayViews): void {
  viewsOf.set(win, views);
}
