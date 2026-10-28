/**
 * How fast the Live game draws, kept free of Electron so the rule is tested as a table. While
 * Genex is not the app in front the game draws at a lower rate: macOS never tells the page that
 * another app's window covers it, so this is what saves the GPU there. Only its frames are
 * paced; its timers, sound and network run as before, and the full rate is back on focus.
 */

/** Live's frame rate while Genex is behind another app; 0 turns the pacing off. */
export const LIVE_BACKGROUND_FPS = 30;

/** What Live's pace depends on. */
export interface LivePace {
  /** Genex is the app in front. */
  foreground: boolean;
  /** An agent looks at the game (through Live itself, or a run's harness): it gets every frame. */
  observed: boolean;
}

/** The most frames a second Live draws, or 0 for the display's own rate. */
export function liveMaxFps(pace: LivePace): number {
  if (pace.foreground || pace.observed) return 0;
  return LIVE_BACKGROUND_FPS;
}
