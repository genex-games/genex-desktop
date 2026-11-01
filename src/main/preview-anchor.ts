/**
 * Where Live's native view belongs while the studio window changes size. The renderer measures the
 * stage's slot a frame after the window moved; until its next report arrives, main keeps the
 * slot's right and bottom margins, as the chat column holds its width and the stage takes the
 * rest. The view then moves in the same frame as the window, as a browser page does.
 */

type Size = { width: number; height: number };
type Rectangle = Size & { x: number; y: number };

/** Whether a slot is off the stage: a zero rectangle (the loader, a dialog, another view over it). */
export const slotHidden = (slot: Size): boolean => slot.width <= 0 || slot.height <= 0;

/**
 * Where the native view goes for a slot: the slot itself, or, while the stage hides it, the
 * rectangle it was last shown in, where it is kept hidden (`previewVisibility`). Never a zero
 * rectangle, nor one wholly outside the window, which Chromium lays out at 0x0 as well: no
 * browser gives a page that size, and a game that sizes its world from its canvas at start-up
 * then starts in an empty world, or never finishes starting.
 */
export function placedBounds(requested: Rectangle, shown: Rectangle): Rectangle {
  return slotHidden(requested) ? { ...shown } : requested;
}

/** The slot measured in a `viewport`-sized window, carried into a window of `content` size. */
export function anchoredBounds(reported: Rectangle, viewport: Size | null, content: Size | null): Rectangle {
  const hidden = reported.width <= 0 || reported.height <= 0;
  if (hidden || !viewport || !content) return reported;
  return {
    x: reported.x,
    y: reported.y,
    width: Math.max(0, reported.width + content.width - viewport.width),
    height: Math.max(0, reported.height + content.height - viewport.height),
  };
}
