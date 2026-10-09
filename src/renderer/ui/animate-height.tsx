"use client";

/**
 * RULES: a container whose HEIGHT glides when its content changes — built for
 * a dialog whose body swaps between lanes (the remix modal's Create-on-the-web
 * / Use-my-own-agent toggle, which otherwise changes size abruptly), and used
 * by the chat for a reply that grows
 * as it is written and for the cards waiting above the composer.
 *
 * How it works: the inner div is measured by a ResizeObserver and the outer
 * div takes that pixel height, gliding there from the height it shows (the
 * theme's opening duration and smooth-out ease, run as a Web Animation; a
 * change mid-glide starts the next glide from where the box is).
 * Until the first measure the height is `auto`, so mount renders at final size
 * with no opening jump. Under Reduce Motion, or while the window rests (behind
 * or untouched: renderer/motion-rest.ts), changes are followed at once. The
 * height is written straight to the element, so a change re-renders nothing.
 *
 * `overflow-hidden` is what makes the glide read as one surface instead of
 * text spilling past a lagging edge. Anything that must escape the box — a
 * dropdown, a tooltip — already portals to <body> in this product, so nothing
 * real is clipped.
 */
import * as React from "react";

import { cn } from "./cn.ts";
import { prefersReducedMotion } from "./media-queries.ts";
import { motionResting } from "../motion-rest.ts";
import { OPEN_MS, SMOOTH_OUT, sizeGlide } from "./motion.ts";

/**
 * Keeps `outer` as tall as `inner` measures. Each change glides there over `glideMs` from the
 * height shown, a glide under way included, so a reply growing line after line moves without a step.
 */
export function useFollowHeight(
  outer: React.RefObject<HTMLElement | null>,
  inner: React.RefObject<HTMLElement | null>,
  glideMs = OPEN_MS,
): void {
  React.useLayoutEffect(() => {
    const box = outer.current;
    const content = inner.current;
    if (!box || !content) return;
    let frame = 0;
    // The content's height as the observer reported it, rounded up so the box never clips a
    // fraction of it: read from the report, so following it lays nothing out again.
    let height = 0;
    // The height last given to the box, and the glide toward it, if one is under way.
    let target: number | null = null;
    let running: { animation: Animation; from: number; to: number } | null = null;
    // Where the box is now, from the glide's own progress: reading the page would lay it out again.
    const shown = (): number | null => {
      const progress = running?.animation.effect?.getComputedTiming().progress;
      if (!running || progress === null || progress === undefined) return target;
      return running.from + (running.to - running.from) * progress;
    };
    const follow = () => {
      frame = 0;
      // Each change glides on from where the box is now, a glide under way included, so the box
      // never steps. Nobody watching a resting window, nothing glides.
      const glide = prefersReducedMotion() || motionResting() ? null : sizeGlide(shown(), height);
      running?.animation.cancel();
      running = null;
      target = height;
      box.style.height = `${height}px`;
      if (!glide) return;
      const animation = box.animate([{ height: `${glide.from}px` }, { height: `${glide.to}px` }], {
        duration: glideMs,
        easing: SMOOTH_OUT,
      });
      running = { animation, ...glide };
    };
    // In the next frame, not inside the observer's own delivery: a size changed
    // there is reported again in the same frame ("ResizeObserver loop").
    const observer = new ResizeObserver((entries) => {
      const size = entries.at(-1)?.borderBoxSize[0]?.blockSize;
      if (size === undefined) return;
      height = Math.ceil(size);
      if (!frame) frame = requestAnimationFrame(follow);
    });
    observer.observe(content);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      running?.animation.cancel();
    };
  }, [outer, inner, glideMs]);
}

export function AnimateHeight({ children, className }: { children: React.ReactNode; className?: string }) {
  const outer = React.useRef<HTMLDivElement>(null);
  const inner = React.useRef<HTMLDivElement>(null);
  useFollowHeight(outer, inner);
  return (
    <div ref={outer} data-slot="animate-height" className={cn("overflow-hidden", className)}>
      {/* flow-root: a child's margin stays inside what is measured, so nothing is clipped. */}
      <div ref={inner} className="flow-root">
        {children}
      </div>
    </div>
  );
}
