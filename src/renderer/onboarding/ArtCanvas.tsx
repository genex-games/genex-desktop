/**
 * A first-launch canvas, also the stage's Planner. Sized for the display, coloured from the theme
 * (the canvas' own CSS colours, see `.onboarding-art`), and redrawn every frame (or `fps` times a
 * second) while it is on screen, uninert, in a visible window; under Reduce Motion it paints one
 * still frame whenever its inputs change.
 */
import { useEffect, useRef, type JSX } from "react";
import { SECOND_MS } from "../../shared/duration.ts";
import { DARK_SCHEME_QUERY, REDUCED_MOTION_QUERY } from "../ui/media-queries.ts";
import { toRgb } from "../ui/WireArt.tsx";
import type { Palette } from "./art.ts";

/**
 * How often a moving canvas measures its on-screen width again. Measuring reads layout, and in a
 * window that lays out every frame (a reply streaming beside it) that is a forced layout per frame.
 */
const ZOOM_REFRESH_MS = 500;

/** Paints one frame. `now` is performance.now(), or null for a still frame. */
export type Draw = (ctx: CanvasRenderingContext2D, palette: Palette, now: number | null) => void;

function readPalette(canvas: HTMLCanvasElement): Palette {
  const style = getComputedStyle(canvas);
  // The sheet and the marks' faces have a colour only when the theme sets one (themes.ts `artPaper`, `artMark`).
  const optional = (variable: string) => {
    const value = style.getPropertyValue(variable).trim();
    return value ? toRgb(value) : undefined;
  };
  return {
    accent: toRgb(style.color),
    ink: toRgb(style.borderLeftColor),
    muted: toRgb(style.borderRightColor),
    green: toRgb(style.borderTopColor),
    orange: toRgb(style.borderBottomColor),
    paper: optional("--art-paper"),
    markFace: optional("--art-mark"),
  };
}

/**
 * Repaint when anything that shows, hides or colours the art changes: it scrolls in or out, the
 * theme lands on <html>, `inert` hides it behind drawers and dialogs (and lifts when they close),
 * Reduce Motion or the colour scheme flips, or the window hides. Returns the unsubscribe.
 */
function watchArt(
  canvas: HTMLCanvasElement,
  on: { visible: (visible: boolean) => void; schedule: () => void; recolor: () => void },
  media: { reduced: MediaQueryList; dark: MediaQueryList },
): () => void {
  const intersection = new IntersectionObserver((records) => {
    on.visible(records.some((record) => record.isIntersecting));
    on.schedule();
  });
  intersection.observe(canvas);
  const themes = new MutationObserver(on.recolor);
  themes.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class", "data-theme"] });
  const inert = new MutationObserver(on.schedule);
  inert.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["inert"] });
  media.reduced.addEventListener("change", on.schedule);
  media.dark.addEventListener("change", on.recolor);
  document.addEventListener("visibilitychange", on.schedule);
  return () => {
    intersection.disconnect();
    themes.disconnect();
    inert.disconnect();
    media.reduced.removeEventListener("change", on.schedule);
    media.dark.removeEventListener("change", on.recolor);
    document.removeEventListener("visibilitychange", on.schedule);
  };
}

export function ArtCanvas({
  width,
  height,
  draw,
  still,
  fps,
  className = "",
}: {
  width: number;
  height: number;
  draw: Draw;
  /** Anything a still frame depends on; a change repaints it. */
  still?: unknown;
  /** At most this many frames a second; every display frame when unset. */
  fps?: number;
  className?: string;
}): JSX.Element {
  const host = useRef<HTMLCanvasElement>(null);
  const drawRef = useRef(draw);
  drawRef.current = draw;
  const repaint = useRef<() => void>(() => {});

  useEffect(() => {
    const canvas = host.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const reduced = matchMedia(REDUCED_MOTION_QUERY);
    const dark = matchMedia(DARK_SCHEME_QUERY);
    const frameMs = fps ? SECOND_MS / fps : 0;
    let palette = readPalette(canvas),
      visible = false,
      frame = 0,
      timer: ReturnType<typeof setTimeout> | undefined,
      scale = 0,
      zoom = 1,
      zoomAt = Number.NEGATIVE_INFINITY;

    const paint = (now: number | null) => {
      // A stage scaled up by its parent still gets a pixel for every display pixel.
      const at = now ?? performance.now();
      if (now === null || at - zoomAt >= ZOOM_REFRESH_MS) {
        zoom = canvas.getBoundingClientRect().width / width || 1;
        zoomAt = at;
      }
      const ratio = Math.min(3, Math.max(1, (window.devicePixelRatio || 1) * zoom));
      if (ratio !== scale) {
        scale = ratio;
        canvas.width = Math.round(width * ratio);
        canvas.height = Math.round(height * ratio);
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      try {
        drawRef.current(ctx, palette, now);
      } catch (error) {
        console.warn("First-launch art stopped:", error);
        stop();
      }
    };
    const live = () => visible && !document.hidden && !reduced.matches && !canvas.closest("[inert]");
    const stop = () => {
      clearTimeout(timer);
      timer = undefined;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
    };
    const next = () => {
      if (!frameMs) {
        frame = requestAnimationFrame(tick);
        return;
      }
      timer = setTimeout(() => {
        timer = undefined;
        frame = requestAnimationFrame(tick);
      }, frameMs);
    };
    const tick = (now: number) => {
      frame = 0;
      if (!live()) return;
      paint(now);
      next();
    };
    const schedule = () => {
      stop();
      if (live()) frame = requestAnimationFrame(tick);
      else paint(reduced.matches ? null : performance.now());
    };
    const recolor = () => {
      palette = readPalette(canvas);
      schedule();
    };
    repaint.current = () => {
      if (!frame && !timer) schedule();
    };

    const unwatch = watchArt(
      canvas,
      {
        visible: (value) => {
          visible = value;
        },
        schedule,
        recolor,
      },
      { reduced, dark },
    );
    schedule();
    return () => {
      stop();
      repaint.current = () => {};
      unwatch();
    };
  }, [width, height, fps]);

  useEffect(() => {
    repaint.current();
  }, [still]);

  return <canvas ref={host} aria-hidden="true" className={`onboarding-art ${className}`} style={{ width, height }} />;
}
