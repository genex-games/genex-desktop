/**
 * When a canvas drawing that runs its own paint loop (the asset cards' making art, the Genex page's
 * Connect band) must paint again: it scrolls in or out, the theme or `inert` changes, motion rests
 * or wakes, Reduce Motion or the colour scheme flips, or the window hides.
 */

/** Repaint when the art scrolls in or out, the theme or `inert` changes, motion rests or wakes, or the window hides. */
export function watchRepaints(
  canvas: HTMLCanvasElement,
  on: { visible: (visible: boolean) => void; schedule: () => void; recolor: () => void },
  media: { reduced: MediaQueryList; dark: MediaQueryList },
): () => void {
  const intersection = new IntersectionObserver((records) => {
    on.visible(records.some((record) => record.isIntersecting));
    on.schedule();
  });
  intersection.observe(canvas);
  const root = new MutationObserver((records) => {
    if (records.some((record) => record.attributeName === "data-motion")) on.schedule();
    else on.recolor();
  });
  root.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["style", "class", "data-theme", "data-motion"],
  });
  const inert = new MutationObserver(on.schedule);
  inert.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["inert"] });
  media.reduced.addEventListener("change", on.schedule);
  media.dark.addEventListener("change", on.recolor);
  document.addEventListener("visibilitychange", on.schedule);
  return () => {
    intersection.disconnect();
    root.disconnect();
    inert.disconnect();
    media.reduced.removeEventListener("change", on.schedule);
    media.dark.removeEventListener("change", on.recolor);
    document.removeEventListener("visibilitychange", on.schedule);
  };
}
