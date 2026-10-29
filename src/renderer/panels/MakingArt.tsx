/**
 * The drawing on an asset card while its asset is being made (`making-art.ts`). One canvas,
 * 30 fps while it is on screen, in an uninert region of a visible window that someone is using
 * (`motion-rest.ts`); a still frame otherwise and under Reduce Motion. It renders at the size it
 * is shown, so it stays sharp as the Assets canvas zooms. Colours follow the theme: the canvas'
 * CSS colours (`.making-art` in theme.css) are read back and refreshed on theme change.
 */
import { type JSX, type RefObject, useEffect, useRef } from "react";
import { SECOND_MS } from "../../shared/duration.ts";
import {
  ART_HEIGHT,
  ART_WIDTH,
  type MakingColors,
  type MakingDrawing,
  makingFrame,
  paintMaking,
} from "../making-art.ts";
import { Motion } from "../motion-rest.ts";
import { watchRepaints } from "../ui/art-repaints.ts";
import { DARK_SCHEME_QUERY, REDUCED_MOTION_QUERY } from "../ui/media-queries.ts";
import { toRgb } from "../ui/WireArt.tsx";

/** The drawing moves at most this many frames a second, so once every `FRAME_MS`. */
const FPS = 30;
const FRAME_MS = SECOND_MS / FPS;
/** How sharp the backing store may get, as a multiple of the drawing's CSS size. */
const MAX_SCALE = 4;
/** How often a running drawing checks the size it is shown at (the canvas may have zoomed). */
const RESIZE_EVERY_FRAMES = 15;

type ArtInput = { drawing: MakingDrawing; still: boolean; offset: number };

const readColors = (canvas: HTMLCanvasElement): MakingColors => {
  const style = getComputedStyle(canvas);
  return { ink: toRgb(style.color), beam: toRgb(style.outlineColor) };
};

/** The backing store's scale: the drawing's on-screen size at the device's pixel ratio. */
function shownScale(canvas: HTMLCanvasElement): number {
  const shown = canvas.getBoundingClientRect().width / ART_WIDTH;
  const ratio = (window.devicePixelRatio || 1) * (Number.isFinite(shown) && shown > 0 ? shown : 1);
  return Math.min(MAX_SCALE, Math.max(1, Math.ceil(ratio * 2) / 2));
}

/** The paint loop: a frame every FRAME_MS while it should move, one frame otherwise. Returns the stop. */
function startMakingLoop(
  canvas: HTMLCanvasElement,
  input: RefObject<ArtInput>,
  redraw: RefObject<() => void>,
): () => void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return () => {};
  const born = performance.now();
  const reduced = matchMedia(REDUCED_MOTION_QUERY);
  const dark = matchMedia(DARK_SCHEME_QUERY);
  let colors = readColors(canvas);
  let visible = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let frame = 0;
  let scale = 0;
  let frames = 0;
  const moving = () => !input.current.still && !reduced.matches;
  const live = () =>
    visible &&
    moving() &&
    !document.hidden &&
    document.documentElement.dataset.motion !== Motion.Rest &&
    !canvas.closest("[inert]");
  const paint = () => {
    if (!scale || frames++ % RESIZE_EVERY_FRAMES === 0) {
      const next = shownScale(canvas);
      if (next !== scale) {
        scale = next;
        canvas.width = Math.round(ART_WIDTH * scale);
        canvas.height = Math.round(ART_HEIGHT * scale);
      }
    }
    const { drawing, still, offset } = input.current;
    const resting = still || reduced.matches;
    // A drawing at rest keeps one pose, so a repaint (a theme, a zoom) never nudges it.
    const t = resting ? offset : (performance.now() - born) / SECOND_MS + offset;
    try {
      paintMaking(ctx, makingFrame(drawing, t, resting), colors, scale);
    } catch (error) {
      console.warn("Asset drawing stopped:", error);
      stop();
    }
  };
  const stop = () => {
    clearTimeout(timer);
    timer = undefined;
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
  };
  const next = () => {
    timer = setTimeout(() => {
      frame = requestAnimationFrame(tick);
    }, FRAME_MS);
  };
  const tick = () => {
    frame = 0;
    if (!live()) return;
    paint();
    next();
  };
  const schedule = () => {
    stop();
    paint();
    if (live()) next();
  };
  redraw.current = schedule;
  const unwatch = watchRepaints(
    canvas,
    {
      visible: (value) => {
        visible = value;
      },
      schedule,
      recolor: () => {
        colors = readColors(canvas);
        schedule();
      },
    },
    { reduced, dark },
  );
  schedule();
  return () => {
    stop();
    redraw.current = () => {};
    unwatch();
  };
}

/**
 * The drawing for `drawing`; `still` shows it built and at rest (a job that waits or stopped).
 * `offset` starts its loop that many seconds in, so cards side by side never move in step.
 */
export function MakingArt({
  drawing,
  still,
  offset,
  className = "",
}: {
  drawing: MakingDrawing;
  still: boolean;
  offset: number;
  className?: string;
}): JSX.Element {
  const host = useRef<HTMLCanvasElement>(null);
  const input = useRef<ArtInput>({ drawing, still, offset });
  input.current = { drawing, still, offset };
  const redraw = useRef<() => void>(() => {});

  useEffect(() => {
    const canvas = host.current;
    if (!canvas) return;
    return startMakingLoop(canvas, input, redraw);
  }, []);

  useEffect(() => {
    redraw.current();
  }, [drawing, still]);

  return (
    <canvas
      ref={host}
      aria-hidden="true"
      data-making-art={drawing}
      data-still={still ? "" : undefined}
      className={`making-art ${className}`}
    />
  );
}
