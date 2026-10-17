/**
 * The stage strip stays one row. When its labelled buttons (a plugin's, Make multiplayer, Publish)
 * would push it past its width, they all fold into 32px icons at once, their names moving to their
 * tooltips; they unfold only once the strip is as wide as the labelled row needed. `nextFold` is
 * the rule, `useStripFold` feeds it the strip's own widths.
 */
import { type RefObject, useLayoutEffect, useState } from "react";
import { flushSync } from "react-dom";

/** Whether the strip's labels are folded, and how wide the labelled row needed the strip to be. */
export type StripFold = { folded: boolean; needed: number };

/** Labels shown. */
export const UNFOLDED: StripFold = { folded: false, needed: 0 };

/** The strip's widths: its content's (`scrollWidth`) and its own (`clientWidth`). */
export type StripWidths = { scroll: number; client: number };

/** The fold after a measure: fold once the labelled row overflows; unfold once it would fit again. */
export function nextFold(fold: StripFold, { scroll, client }: StripWidths): StripFold {
  if (!fold.folded) return scroll > client ? { folded: true, needed: scroll } : fold;
  return client >= fold.needed ? UNFOLDED : fold;
}

/**
 * Whether the strip's labels are folded. One observer watches the strip (a window or pane resize)
 * and the groups inside it (a button coming or going, a label changing). A group that changed size
 * on its own (not by a fold this hook made) measures afresh from the labelled row; otherwise only
 * the strip's width is compared. Every change lands before the frame is painted.
 */
export function useStripFold(strip: RefObject<HTMLElement | null>, groups: RefObject<HTMLElement | null>[]): boolean {
  const [folded, setFolded] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the refs are stable; their elements are read once mounted
  useLayoutEffect(() => {
    const row = strip.current;
    const parts = groups.map((group) => group.current).filter((part): part is HTMLElement => part !== null);
    if (!row) return;
    let fold = UNFOLDED;
    const widths = new Map<Element, number>();
    const apply = (next: StripFold) => {
      const flips = next.folded !== fold.folded;
      fold = next;
      if (flips) flushSync(() => setFolded(next.folded));
    };
    const measure = () => apply(nextFold(fold, { scroll: row.scrollWidth, client: row.clientWidth }));
    const remember = () => {
      for (const part of parts) widths.set(part, part.offsetWidth);
    };
    const observer = new ResizeObserver((entries) => {
      const changed = entries.some(
        (entry) => entry.target !== row && widths.get(entry.target) !== (entry.target as HTMLElement).offsetWidth,
      );
      if (changed) apply(UNFOLDED);
      measure();
      remember();
    });
    observer.observe(row);
    for (const part of parts) observer.observe(part);
    return () => observer.disconnect();
  }, []);
  return folded;
}
