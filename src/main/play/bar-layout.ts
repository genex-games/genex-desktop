/**
 * Where the viewer bar's layer lies over the window. The bar is a strip of its own across the
 * window's top for as long as a game is open, the game below it, never under it; the layer covers the
 * whole window while one of the bar's overlays (Comments, an AI card or menu) or a game's purchase sheet
 * is open, and is put away while the game's page holds the screen in full screen (an overlay or a
 * purchase sheet still covers it then). Nothing the bar's page says
 * puts the layer away under a sheet: the sheet is main's word, never the page's.
 */
import type { PlayBarHold } from "../../shared/play-bar.ts";

/** Where the bar's layer lies over the window. */
export const BarLayout = {
  /** Put away: no game is open, or the game's page is full screen. */
  Hidden: "hidden",
  /** The bar's strip across the window's top. */
  Bar: "bar",
  /** The whole window, for an overlay or a purchase sheet over the dimmed game. */
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
  /** One of the bar's overlays is open over the window. */
  let overlaid = false;
  /** A game's purchase sheet is open over the window. */
  let sheet = false;
  /** The game's page holds the screen in full screen. */
  let fullScreen = false;
  let layout: BarLayout = BarLayout.Hidden;

  /** An overlay of the bar's (Comments, an AI card or menu) or a purchase sheet lies over the whole window. */
  const covering = (): boolean => overlaid || sheet;
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
    /** What the bar's layer says: which of its overlays is open, if any. */
    hold(next: PlayBarHold): void {
      overlaid = next.overlay !== null;
      place();
    },
    /** One of the bar's overlays (Comments, an AI card or menu) is open over the game. */
    overlaid: (): boolean => overlaid,
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
    /** An overlay or a purchase sheet covers the window: the keyboard stays with the bar's layer. */
    covering,
    /** The viewer closed: the layer goes at once, and the next game starts afresh. */
    close(): void {
      open = false;
      overlaid = false;
      sheet = false;
      fullScreen = false;
      place();
    },
    /** Where its layer lies now. */
    layout: (): BarLayout => layout,
  };
}
