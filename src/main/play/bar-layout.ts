/**
 * Where the viewer bar's layer lies over the window. The bar is a strip of its own across the
 * window's top for as long as a game is open, the game below it, never under it; the layer covers the
 * whole window while Comments or a game's purchase sheet is open, and is put away while the game's page
 * holds the screen in full screen (a purchase sheet still covers it then). Nothing the bar's page says
 * puts the layer away under a sheet: the sheet is main's word, never the page's.
 */
import type { PlayBarHold } from "../../shared/play-bar.ts";

/** Where the bar's layer lies over the window. */
export const BarLayout = {
  /** Put away: no game is open, or the game's page is full screen. */
  Hidden: "hidden",
  /** The bar's strip across the window's top. */
  Bar: "bar",
  /** The whole window, for Comments or a purchase sheet over the dimmed game. */
  Full: "full",
} as const;
export type BarLayout = (typeof BarLayout)[keyof typeof BarLayout];

/** What the layout moves: the bar's layer. */
export interface BarLayoutDeps {
  place(layout: BarLayout): void;
}

/** The bar's layer laid out over `deps`. */
export function barLayout(deps: BarLayoutDeps) {
  let open = false;
  let comments = false;
  /** A game's purchase sheet is open over the window. */
  let sheet = false;
  /** The game's page holds the screen in full screen. */
  let fullScreen = false;
  let layout: BarLayout = BarLayout.Hidden;

  /** Comments or a purchase sheet lies over the whole window. */
  const covering = (): boolean => comments || sheet;
  const wanted = (): BarLayout => {
    if (!open) return BarLayout.Hidden;
    if (covering()) return BarLayout.Full;
    return fullScreen ? BarLayout.Hidden : BarLayout.Bar;
  };
  const place = (): void => {
    const next = wanted();
    if (layout === next) return;
    layout = next;
    deps.place(next);
  };

  return {
    /** A game opened: the bar's strip, from its cover on. */
    opened(): void {
      open = true;
      place();
    },
    /** What the bar's layer says: whether Comments is open. */
    hold(next: PlayBarHold): void {
      comments = next.comments;
      place();
    },
    /** Comments is open over the game. */
    comments: (): boolean => comments,
    /** A game's purchase sheet opened or closed: open, the layer covers the whole window. */
    sheet(on: boolean): void {
      sheet = on;
      place();
    },
    /** The game's page took the screen in full screen, or gave it back. */
    fullScreen(on: boolean): void {
      fullScreen = on;
      place();
    },
    /** Whether the game's page holds the screen in full screen. */
    isFullScreen: (): boolean => fullScreen,
    /** Comments or a purchase sheet covers the window: the keyboard stays with the bar's layer. */
    covering,
    /** The viewer closed: the layer goes at once, and the next game starts afresh. */
    close(): void {
      open = false;
      comments = false;
      sheet = false;
      fullScreen = false;
      place();
    },
    /** Where its layer lies now. */
    layout: (): BarLayout => layout,
  };
}
