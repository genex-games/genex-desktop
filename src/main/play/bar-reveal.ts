/**
 * When the viewer's bar is up over the game. It is up while the game loads and when it could not
 * load; once the game plays it stays a few seconds, then fades up and out, and it comes back when the
 * pointer reaches the window's top edge or Esc is pressed in the game. While the pointer or the
 * keyboard is on it, or its Comments is open, it stays. Its layer is put away once it has faded, and
 * covers the whole window while Comments is open. Electron-free: the clock comes in as a dep.
 */
import { SECOND_MS } from "../../shared/duration.ts";
import type { PlayBarHold } from "../../shared/play-bar.ts";

/** How long the bar stays after play starts, the pointer reaches the top edge or Esc is pressed. */
export const BAR_SHOWN_MS = 3 * SECOND_MS;
/** How long it stays once the pointer and the keyboard have left it. */
export const BAR_LINGER_MS = SECOND_MS;
/** How long its fade takes before its layer is put away (`play.css`'s fade, with a frame to spare). */
export const BAR_FADE_MS = 280;

/** Where the bar's layer lies over the window. */
export const BarLayout = {
  /** Put away: the game has the whole window. */
  Hidden: "hidden",
  /** The bar's strip across the window's top. */
  Bar: "bar",
  /** The whole window, for Comments over the dimmed game. */
  Full: "full",
} as const;
export type BarLayout = (typeof BarLayout)[keyof typeof BarLayout];

type Clock = { setTimeout(run: () => void, ms: number): unknown; clearTimeout(handle: unknown): void };

/** What the reveal moves: the bar's look, and its layer. */
export interface BarRevealDeps {
  clock: Clock;
  /** The bar is up, or fading out. */
  shown(up: boolean): void;
  place(layout: BarLayout): void;
}

const NO_HOLD: PlayBarHold = { held: false, overlay: null };

/** The bar's reveal over `deps`. */
export function barReveal(deps: BarRevealDeps) {
  const { clock } = deps;
  let up = false;
  let playing = false;
  let hold = NO_HOLD;
  let layout: BarLayout = BarLayout.Hidden;
  let hideTimer: unknown = null;
  let fadeTimer: unknown = null;

  const stop = (timer: unknown): null => {
    if (timer !== null) clock.clearTimeout(timer);
    return null;
  };
  const placeAt = (next: BarLayout): void => {
    if (layout === next) return;
    layout = next;
    deps.place(next);
  };
  const show = (): void => {
    fadeTimer = stop(fadeTimer);
    placeAt(hold.overlay !== null ? BarLayout.Full : BarLayout.Bar);
    if (up) return;
    up = true;
    deps.shown(true);
  };
  const hide = (): void => {
    hideTimer = null;
    if (!up) return;
    up = false;
    deps.shown(false);
    fadeTimer = clock.setTimeout(() => {
      fadeTimer = null;
      placeAt(BarLayout.Hidden);
    }, BAR_FADE_MS);
  };
  /** Up now, and for `ms` more unless something holds it; while the game is not playing, for good. */
  const showFor = (ms: number): void => {
    hideTimer = stop(hideTimer);
    show();
    if (playing && !hold.held && hold.overlay === null) hideTimer = clock.setTimeout(hide, ms);
  };

  return {
    /** A game opened, or could not load: the bar is up, and stays (an open overlay stays open over a failure). */
    pinned(): void {
      playing = false;
      showFor(0);
    },
    /** The game is on screen: the bar stays a few seconds more. */
    playing(): void {
      playing = true;
      showFor(BAR_SHOWN_MS);
    },
    /** The pointer reached the top edge, or Esc was pressed in the game. */
    reveal(): void {
      if (playing) showFor(BAR_SHOWN_MS);
    },
    /** What the bar's layer says holds it; letting go leaves it a moment more. */
    hold(next: PlayBarHold): void {
      const was = hold;
      hold = { held: next.held, overlay: next.overlay };
      if (hold.held || hold.overlay !== null) showFor(0);
      else if (was.held || was.overlay !== null) showFor(BAR_LINGER_MS);
    },
    /** One of the bar's overlays (Comments, an AI card or menu) is open over the game. */
    overlaid: (): boolean => hold.overlay !== null,
    /** The viewer closed: the layer goes at once. */
    close(): void {
      hideTimer = stop(hideTimer);
      fadeTimer = stop(fadeTimer);
      up = false;
      playing = false;
      hold = NO_HOLD;
      placeAt(BarLayout.Hidden);
    },
    /** Whether the bar is up. */
    up: (): boolean => up,
    /** Where its layer lies now. */
    layout: (): BarLayout => layout,
  };
}

/** The reveal as `barReveal` makes it. */
export type BarReveal = ReturnType<typeof barReveal>;
