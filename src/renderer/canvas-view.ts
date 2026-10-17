/**
 * The zoomable canvas both stage views share — pan, wheel zoom and fit. (Pictures are read
 * through `stills.ts`.)
 *
 * This is the Builds timeline's own canvas, lifted out of `RunGraph.tsx` unchanged so the Assets
 * stage can behave identically: same zoom limits, same dead zone before a drag counts, same
 * non-passive wheel listener (the page must never scroll under a pinch), same one-tick reset of
 * `moved` so the click that ends a drag selects nothing. What stayed behind in `RunGraph.tsx` is
 * what only a timeline wants: following the live round, the keyboard chain, the first fit.
 *
 * The maths is exported twice — as `fitView`/`zoomAt`, pure and testable without a window, and
 * through the hook that owns the state. Nothing here touches `run-graph.ts`.
 */
import type { PointerEvent as ReactPointerEvent, RefObject } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/** Where the canvas is: a scale and a translation, in viewport pixels. */
export interface CanvasView {
  k: number;
  tx: number;
  ty: number;
}

/** The rectangle a fit has to contain, in canvas coordinates. Structurally `run-graph.ts`'s `Rect`. */
export interface CanvasBounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const MIN_ZOOM = 0.12;
export const MAX_ZOOM = 2.5;
/** How far a pointer must travel before it is a pan rather than a click on the background. */
export const DRAG_DEAD_ZONE = 3;
/** The padding a fit leaves around the content, and the room it leaves for the header strip. */
const FIT_PAD = 32;
const FIT_TOP = 48;

export const clamp = (value: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, value));

/**
 * The view that shows `bounds` whole inside a viewport of `size`. `reserveRight` is the width of
 * a drawer sitting over the canvas: the content is centred in what is left, not under the drawer.
 */
export function fitView(
  bounds: CanvasBounds,
  size: { width: number; height: number },
  options: { reserveRight?: number } = {},
): CanvasView {
  const pad = FIT_PAD;
  const top = FIT_TOP;
  const vw = Math.max(1, size.width - (options.reserveRight ?? 0));
  const vh = Math.max(1, size.height);
  const k = clamp(Math.min((vw - pad * 2) / bounds.w, (vh - top - pad) / bounds.h), MIN_ZOOM, MAX_ZOOM);
  return {
    k,
    tx: (vw - bounds.w * k) / 2 - bounds.x * k,
    ty: top + (vh - top - pad - bounds.h * k) / 2 - bounds.y * k,
  };
}

/**
 * Zoom by `factor` about the viewport point (`px`, `py`) — the point under the cursor stays where
 * it is. Returns the same view when the limit is already reached, so callers can skip the update.
 */
export function zoomAt(view: CanvasView, factor: number, px: number, py: number): CanvasView {
  const k = clamp(view.k * factor, MIN_ZOOM, MAX_ZOOM);
  if (k === view.k) return view;
  return { k, tx: px - (px - view.tx) * (k / view.k), ty: py - (py - view.ty) * (k / view.k) };
}

export interface CanvasController {
  view: CanvasView;
  /** The current view without waiting for a render — every handler reads this one. */
  viewRef: RefObject<CanvasView>;
  viewport: RefObject<HTMLDivElement | null>;
  layer: RefObject<HTMLDivElement | null>;
  grid: RefObject<HTMLDivElement | null>;
  apply: (next: CanvasView) => void;
  update: (next: (current: CanvasView) => CanvasView) => void;
  /** Fit `bounds` into the mounted viewport; a null bounds (nothing to show) does nothing. */
  fit: (bounds: CanvasBounds | null, options?: { reserveRight?: number }) => void;
  zoomBy: (factor: number) => void;
  /** Bring canvas x into view on the left, never scrolling past the origin. */
  panTo: (x: number) => void;
  onBackgroundDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  /** True between a drag passing the dead zone and the tick after the pointer goes up. */
  moved: RefObject<boolean>;
  panning: boolean;
}

/** The zoom a canvas opens at before its first fit. */
const INITIAL_ZOOM = 0.72;
/** How far from the left edge `panTo` leaves the point it brings into view. */
const PAN_TO_MARGIN = 40;
/** Wheel zoom speed per pixel of scroll: a pinch (ctrl/meta held) moves faster than a wheel. */
const PINCH_ZOOM_RATE = 0.012;
const WHEEL_ZOOM_RATE = 0.0025;
const WHEEL_SETTLE_MS = 120;
const VIEW_EPSILON = 0.001;
const GRID_PX = 22;

/** Equivalent cameras do not schedule another React render. */
export function sameCanvasView(a: CanvasView, b: CanvasView): boolean {
  return (
    Math.abs(a.k - b.k) < VIEW_EPSILON && Math.abs(a.tx - b.tx) < VIEW_EPSILON && Math.abs(a.ty - b.ty) < VIEW_EPSILON
  );
}

/**
 * The canvas's own state. `onPan` fires once a drag starts, which is how the timeline stops
 * following the live round the moment the user takes the canvas somewhere themselves.
 */
export function useCanvasView(options: { initial?: CanvasView; onPan?: () => void } = {}): CanvasController {
  const [view, setView] = useState<CanvasView>(options.initial ?? { k: INITIAL_ZOOM, tx: 0, ty: 0 });
  const viewport = useRef<HTMLDivElement>(null);
  const viewRef = useRef<CanvasView>(view);

  const layer = useRef<HTMLDivElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const onPan = useRef(options.onPan);
  onPan.current = options.onPan;

  const apply = useCallback((next: CanvasView): void => {
    if (sameCanvasView(viewRef.current, next)) return;
    viewRef.current = next;
    setView(next);
  }, []);

  const update = useCallback(
    (next: (current: CanvasView) => CanvasView): void => apply(next(viewRef.current)),
    [apply],
  );
  const gesture = useCanvasGesture(viewport, layer, grid, viewRef, setView);

  const fit = useCallback(
    (bounds: CanvasBounds | null, fitOptions: { reserveRight?: number } = {}): void => {
      const element = viewport.current;
      if (!element || !bounds) return;
      apply(fitView(bounds, { width: element.clientWidth, height: element.clientHeight }, fitOptions));
    },
    [apply],
  );

  const panTo = useCallback(
    (x: number): void => {
      const current = viewRef.current;
      apply({ ...current, tx: Math.min(0, -x * current.k + PAN_TO_MARGIN) });
    },
    [apply],
  );

  useWheelZoom(viewport, viewRef, gesture.move, gesture.finish);

  const zoomBy = useCallback(
    (factor: number): void => {
      const element = viewport.current;
      if (!element) return;
      const current = viewRef.current;
      const next = zoomAt(current, factor, element.clientWidth / 2, element.clientHeight / 2);
      if (next === current) return;
      apply(next);
    },
    [apply],
  );

  const { onBackgroundDown, moved, pan } = useBackgroundPan(viewRef, gesture.move, gesture.finish, onPan);

  return {
    view,
    viewRef,
    viewport,
    layer,
    grid,
    apply,
    update,
    fit,
    zoomBy,
    panTo,
    onBackgroundDown,
    moved,
    panning: pan.current !== null,
  };
}

/** How many canvases' cameras outlive their tab; the oldest is forgotten past this. */
const KEPT_VIEWS_MAX = 64;
const keptViews = new Map<string, CanvasView>();

/**
 * Keep the camera a user left a canvas at, for when its tab comes back; null forgets it, and the
 * canvas opens fitted again.
 */
export function keepView(key: string, view: CanvasView | null): void {
  keptViews.delete(key);
  if (!view) return;
  keptViews.set(key, view);
  while (keptViews.size > KEPT_VIEWS_MAX) {
    const oldest = keptViews.keys().next().value;
    if (oldest !== undefined) keptViews.delete(oldest);
  }
}

/** The camera a user left this canvas at, or null when it opens fitted. */
export function keptView(key: string): CanvasView | null {
  return keptViews.get(key) ?? null;
}

/** Calls `onWheel` for every wheel over the viewport (the user moving the canvas), passively. */
export function useOnWheel(viewport: RefObject<HTMLDivElement | null>, onWheel: () => void): void {
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    element.addEventListener("wheel", onWheel, { passive: true });
    return () => element.removeEventListener("wheel", onWheel);
  }, [viewport, onWheel]);
}

/** Wheel zoom about the cursor, on a non-passive listener so the page never scrolls under a pinch. */
function useWheelZoom(
  viewport: RefObject<HTMLDivElement | null>,
  viewRef: RefObject<CanvasView>,
  move: (view: CanvasView) => void,
  finish: () => void,
): void {
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let box: DOMRect | null = null;
    const settle = () => {
      box = null;
      finish();
    };
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const current = viewRef.current;
      const rate = event.ctrlKey || event.metaKey ? PINCH_ZOOM_RATE : WHEEL_ZOOM_RATE;
      box ??= element.getBoundingClientRect();
      const next = zoomAt(current, Math.exp(-event.deltaY * rate), event.clientX - box.left, event.clientY - box.top);
      if (next === current) return;
      move(next);
      clearTimeout(timer);
      timer = setTimeout(settle, WHEEL_SETTLE_MS);
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      clearTimeout(timer);
      element.removeEventListener("wheel", onWheel);
    };
  }, [viewport, viewRef, move, finish]);
}

type PanState = { startX: number; startY: number; tx: number; ty: number; moved: boolean };

/** Pan by dragging the background, on window listeners while dragging so cards keep their own clicks. */
function useBackgroundPan(
  viewRef: RefObject<CanvasView>,
  apply: (next: CanvasView) => void,
  finish: () => void,
  onPan: RefObject<(() => void) | undefined>,
): {
  onBackgroundDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  moved: RefObject<boolean>;
  pan: RefObject<PanState | null>;
} {
  const pan = useRef<PanState | null>(null);
  const moved = useRef(false);
  const removeListeners = useRef<(() => void) | undefined>(undefined);
  useEffect(() => () => removeListeners.current?.(), []);
  const onBackgroundDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      if (event.button !== 0) return;
      removeListeners.current?.();
      const current = viewRef.current;
      pan.current = { startX: event.clientX, startY: event.clientY, tx: current.tx, ty: current.ty, moved: false };
      moved.current = false;
      const onMove = (move: PointerEvent): void => {
        const state = pan.current;
        if (!state) return;
        const dx = move.clientX - state.startX;
        const dy = move.clientY - state.startY;
        if (!state.moved && Math.hypot(dx, dy) < DRAG_DEAD_ZONE) return;
        if (!state.moved) onPan.current?.();
        state.moved = true;
        moved.current = true;
        apply({ ...viewRef.current, tx: state.tx + dx, ty: state.ty + dy });
      };
      const onUp = (): void => {
        removeListeners.current?.();
        pan.current = null;
        finish();
        // the click that ends a drag must not select or deselect
        setTimeout(() => {
          moved.current = false;
        }, 0);
      };
      removeListeners.current = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        removeListeners.current = undefined;
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [apply, finish, viewRef, onPan],
  );
  return { onBackgroundDown, moved, pan };
}

/** Keep gesture pixels in the compositor; React adopts the camera only at rest. */
function useCanvasGesture(
  viewport: RefObject<HTMLDivElement | null>,
  layer: RefObject<HTMLDivElement | null>,
  grid: RefObject<HTMLDivElement | null>,
  viewRef: RefObject<CanvasView>,
  commit: (view: CanvasView) => void,
) {
  const transition = useRef<string | null>(null);
  const paint = useCallback(() => {
    const element = viewport.current;
    const content = layer.current;
    const next = viewRef.current;
    if (!element || !content) return;
    transition.current ??= content.style.transition;
    content.style.transition = "none";
    content.style.willChange = "transform";
    content.style.transform = `translate(${next.tx}px, ${next.ty}px) scale(${next.k})`;
    if (grid.current) {
      const tile = grid.current;
      let basis = Number(tile.dataset.gridScale) || next.k;
      const scale = next.k / basis;
      if (scale < 0.75 || scale > 1.5) {
        basis = next.k;
        tile.dataset.gridScale = String(basis);
        tile.style.backgroundSize = `${GRID_PX * basis}px ${GRID_PX * basis}px`;
      }
      tile.style.transform = gridTransform(next, basis);
      tile.style.willChange = "transform";
    } else {
      element.style.backgroundSize = `${GRID_PX * next.k}px ${GRID_PX * next.k}px`;
      element.style.backgroundPosition = `${next.tx}px ${next.ty}px`;
    }
    let zoom = "mid";
    if (next.k < 0.6) zoom = "far";
    if (next.k >= 1.35) zoom = "near";
    element.dataset.zoom = zoom;
    element.style.cursor = "grabbing";
  }, [viewport, layer, grid, viewRef]);
  const gesture = useMemo(
    () =>
      createCanvasGesture({
        view: viewRef,
        paint,
        commit,
        schedule: (paint) => window.requestAnimationFrame(paint),
        cancel: (frame) => window.cancelAnimationFrame(frame),
      }),
    [viewRef, paint, commit],
  );
  const finish = useCallback(() => {
    gesture.finish();
    if (layer.current) {
      layer.current.style.willChange = "";
      layer.current.style.transition = transition.current ?? layer.current.style.transition;
      transition.current = null;
    }
    if (viewport.current) viewport.current.style.cursor = "";
    if (grid.current) grid.current.style.willChange = "";
  }, [gesture, layer, grid, viewport]);
  useEffect(() => () => gesture.dispose(), [gesture]);
  return { move: gesture.move, finish };
}

/** A tiled grid moves by only its tile remainder, keeping its composited surface bounded. */
export function gridTransform(view: CanvasView, basis = 1): string {
  const tile = GRID_PX * view.k;
  const x = (((view.tx % tile) + tile) % tile) - tile;
  const y = (((view.ty % tile) + tile) % tile) - tile;
  return `translate(${x}px, ${y}px) scale(${view.k / basis})`;
}

/** Injectable frame scheduler: transient camera writes never commit React state mid-gesture. */
export function createCanvasGesture(options: {
  view: { current: CanvasView };
  paint: () => void;
  commit: (view: CanvasView) => void;
  schedule: (paint: () => void) => number;
  cancel: (id: number) => void;
}) {
  const { schedule, cancel } = options;
  let frame = 0;
  let changed = false;
  const paint = () => {
    frame = 0;
    options.paint();
  };
  return {
    move(next: CanvasView): void {
      if (sameCanvasView(options.view.current, next)) return;
      changed = true;
      options.view.current = next;
      if (!frame) frame = schedule(paint);
    },
    finish(): void {
      if (!changed) return;
      if (frame) {
        cancel(frame);
        paint();
      }
      changed = false;
      options.commit(options.view.current);
    },
    dispose(): void {
      cancel(frame);
      frame = 0;
      changed = false;
    },
  };
}
