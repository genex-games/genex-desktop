/**
 * The stage strip makes room in steps, never by hiding a control. Its first row holds the views,
 * Play/Stop, Reload, Sound and Full screen, then the plugin buttons (a plugin's, Make multiplayer,
 * Publish) at its end, always with their names. When that row would overflow, the views fold into
 * one button that names the current one; when it still would, the plugin buttons move to a second
 * row; and when even that is not enough, Sound and Full screen join them there. The step is always
 * the first one whose first row fits, however the strip reached its width: a strip that grows
 * starts again from one row. `nextFold` is the rule, `useStripFold` feeds it the first row's
 * widths, and theme.css lays each step out (`data-fold`).
 */
import { type RefObject, useLayoutEffect, useState } from "react";
import { flushSync } from "react-dom";

/** The strip's steps, in the order it takes them (`data-fold` on the strip). */
export const StripFoldStep = {
  /** Everything on one row, each view a tab of its own. */
  Full: "full",
  /** The views folded into one button that names the current one. */
  Views: "views",
  /** The plugin buttons on a second row. */
  Plugins: "plugins",
  /** Sound and Full screen on the second row too. */
  Game: "game",
} as const;
export type StripFoldStep = (typeof StripFoldStep)[keyof typeof StripFoldStep];

/** Every step, in the order the strip takes them. */
export const STRIP_STEPS: readonly StripFoldStep[] = [
  StripFoldStep.Full,
  StripFoldStep.Views,
  StripFoldStep.Plugins,
  StripFoldStep.Game,
];

/** A first row this much past its room is rounding, not overflow: the free space between its ends is a fraction. */
const ROUNDING_PX = 1;

/** The strip's widths: how wide its first row needs it (`row`) and how wide it is (`room`). */
export type StripWidths = { row: number; room: number };

/** The step after a measure: the next one while the first row overflows, the same one once it fits or none is left. */
export function nextFold(step: StripFoldStep, { row, room }: StripWidths): StripFoldStep {
  if (row - room < ROUNDING_PX) return step;
  return STRIP_STEPS[STRIP_STEPS.indexOf(step) + 1] ?? step;
}

/**
 * The strip's widths: what its grid needs (`scrollWidth`) and what it has (`clientWidth`). Only the
 * first row can need more: the second row's plugin buttons wrap rather than overflow.
 */
const stripWidths = (strip: HTMLElement): StripWidths => ({ row: strip.scrollWidth, room: strip.clientWidth });

/**
 * The strip's step. One observer watches the strip (a window or pane resize, the room the window's
 * own controls leave) and the groups inside it (a button coming or going, a label changing). A
 * strip that narrowed only steps further; one that grew, or a group that changed size on its own
 * (not by a step this hook took), starts again from one row. Each step is drawn at once
 * (`flushSync`) so the next measure sees it, so a resize settles in one frame, and it lands one
 * frame after the resize that called for it: stepping inside the observer resizes the groups it
 * watches in the same frame, which Chromium reports as a renderer error ("ResizeObserver loop
 * completed with undelivered notifications").
 */
export function useStripFold(
  strip: RefObject<HTMLElement | null>,
  groups: RefObject<HTMLElement | null>[],
): StripFoldStep {
  const [step, setStep] = useState<StripFoldStep>(StripFoldStep.Full);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the refs are stable; their elements are read once mounted
  useLayoutEffect(() => {
    const row = strip.current;
    const parts = groups.map((group) => group.current).filter((part): part is HTMLElement => part !== null);
    if (!row) return;
    let current: StripFoldStep = StripFoldStep.Full;
    let room = Number.NEGATIVE_INFINITY;
    const widths = new Map<Element, number>();
    const apply = (next: StripFoldStep) => {
      if (next === current) return;
      current = next;
      flushSync(() => setStep(next));
    };
    // Each step changes the first row, so one measure may take several.
    const measure = () => {
      for (const _ of STRIP_STEPS) {
        const next = nextFold(current, stripWidths(row));
        if (next === current) return;
        apply(next);
      }
    };
    const remember = () => {
      for (const part of parts) widths.set(part, part.offsetWidth);
    };
    let frame = 0;
    let groupChanged = false;
    const settle = () => {
      const now = stripWidths(row).room;
      if (groupChanged || now > room) apply(StripFoldStep.Full);
      groupChanged = false;
      room = now;
      measure();
      remember();
    };
    const observer = new ResizeObserver((entries) => {
      // A group that changed on its own is kept until the frame settles, so a later resize can't drop it.
      groupChanged ||= entries.some(
        (entry) => entry.target !== row && widths.get(entry.target) !== (entry.target as HTMLElement).offsetWidth,
      );
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(settle);
    });
    observer.observe(row);
    for (const part of parts) observer.observe(part);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);
  return step;
}
