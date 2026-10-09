/**
 * Where the Builds canvas looks: a run opens fitted, a live one keeps its work in view until the
 * user moves the canvas, and a resize refits an untouched canvas. Opening a node glides it to the
 * middle at the zoom the canvas already has, and its card opens in place over it; walking to another
 * glides there; closing glides back to the view it was opened from. Moving the canvas takes it over: following stops, and an open node
 * closes where it is.
 */
import type { RefObject } from "react";
import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import { type CanvasView, fitView, useCanvasView } from "../../canvas-view.ts";
import { boundsOf, type Rect, type RunGraph as RunGraphModel } from "../../run-graph.ts";
import type { PartRow, Step, StepsLayout } from "../../run-steps.ts";
import { partOf } from "../inspector/selection.ts";

/** The zoom a run's canvas opens at before its first fit. */
const INITIAL_ZOOM = 0.86;
/** The zoom live work is brought to when the whole graph would be too small to read. */
const READABLE = 0.8;
/** A whole graph at this share of the readable zoom still reads; below it the camera follows the work. */
const READABLE_SHARE = 0.75;
/** The card leaves room for the zoom pill below it, so the node it opens from sits this much higher. */
const ZOOM_PILL_ROOM = 40;
/** How long the camera glides when it moves on its own (opening, walking, closing a node). */
export const GLIDE_MS = 250;
/** A glide is over this long after it was asked for. */
const GLIDE_SETTLE_MS = GLIDE_MS + 50;
/** One press of zoom in or out. */
const ZOOM_STEP = 1.2;
const RESIZE_SETTLE_MS = 100;

type Canvas = ReturnType<typeof useCanvasView>;
type SetAuto = (auto: boolean) => void;

/** What the camera centres on to open a selection: a part's whole row (its label and steps), else the node. */
function focusRect(layout: StepsLayout, rows: PartRow[], id: string): Rect | undefined {
  const facetId = partOf(id);
  const row = facetId ? rows.find((item) => item.facet.facetId === facetId) : undefined;
  if (!row) return layout.rects[id];
  const rects = [layout.rects[`row:${row.facet.facetId}`], ...row.steps.map((item) => layout.rects[item.id])];
  return boundsOf(rects.filter((item) => item !== undefined)) ?? undefined;
}

/** The viewport's size, as a view is fitted to it. */
type ViewportSize = { width: number; height: number };

const sizeOf = (element: HTMLElement): ViewportSize => ({ width: element.clientWidth, height: element.clientHeight });

/** A view that puts a rect at the middle of the viewport at zoom `k`, `lift` pixels above centre. */
function centredOn(size: ViewportSize, rect: Rect, k: number, lift = 0): CanvasView {
  return {
    k,
    tx: size.width / 2 - (rect.x + rect.w / 2) * k,
    ty: (size.height - lift) / 2 - (rect.y + rect.h / 2) * k,
  };
}

/** The view an opened node glides to: centred under its card, at the zoom the canvas already has. */
export function selectionView(size: ViewportSize, rect: Rect, view: CanvasView): CanvasView {
  return centredOn(size, rect, view.k, ZOOM_PILL_ROOM);
}

/** Fitting the canvas: everything, or the work in hand (else the lead) at a readable zoom. */
function useFitting(canvas: Canvas, layout: StepsLayout, live: Step | null, touched: RefObject<boolean>) {
  const { viewport, apply } = canvas;

  // A small run is not blown up past its own size.
  const fit = useCallback(() => {
    const element = viewport.current;
    const bounds = boundsOf(Object.values(layout.rects));
    if (!element || !bounds) return;
    const size = { width: element.clientWidth, height: element.clientHeight };
    const view = fitView(bounds, size);
    touched.current = false;
    if (view.k <= 1) return apply(view);
    apply({ k: 1, tx: (size.width - bounds.w) / 2 - bounds.x, ty: (size.height - bounds.h) / 2 - bounds.y });
  }, [apply, layout, viewport, touched]);

  /** Everything, if it reads at that size; otherwise the work in hand at a readable zoom. */
  const showNow = useCallback(() => {
    const element = viewport.current;
    const bounds = boundsOf(Object.values(layout.rects));
    if (!element || !bounds) return;
    const whole = fitView(bounds, { width: element.clientWidth, height: element.clientHeight });
    const rect = live ? layout.rects[live.id] : layout.rects.lead;
    if (whole.k >= READABLE * READABLE_SHARE || !rect) {
      fit();
      return;
    }
    apply(centredOn(sizeOf(element), rect, READABLE));
  }, [apply, fit, layout, live, viewport]);
  return { fit, showNow };
}

/** The camera's own moves glide; a pan or a wheel under the user's hand never does. */
function useGlide(apply: Canvas["apply"]) {
  const [gliding, setGliding] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const glide = useCallback(
    (next: CanvasView): void => {
      setGliding(true);
      apply(next);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setGliding(false), GLIDE_SETTLE_MS);
    },
    [apply],
  );
  useEffect(() => () => clearTimeout(timer.current), []);
  return { gliding, glide };
}

/** A run opens fitted; a live one keeps its work in view from then on, and stops once the run does. */
function useOpenFitted(graph: RunGraphModel, ready: boolean, fit: () => void, onNewRun: () => void, setAuto: SetAuto) {
  const opened = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!ready || opened.current === graph.runId) return;
    if (opened.current !== null) onNewRun();
    opened.current = graph.runId;
    setAuto(graph.active);
    fit();
  }, [graph.runId, graph.active, fit, ready, onNewRun, setAuto]);
  useEffect(() => {
    if (!graph.active) setAuto(false);
  }, [graph.active, setAuto]);
}

/**
 * Following a live run — except while a node is open: the camera is the user's then. A window or
 * pane resized under an untouched canvas keeps showing everything; an open node stays centred.
 */
function useFollowLive({
  viewport,
  active,
  auto,
  selected,
  touched,
  focusOpen,
  fit,
  showNow,
}: {
  viewport: Canvas["viewport"];
  active: boolean;
  auto: boolean;
  selected: string | null;
  touched: RefObject<boolean>;
  /** Re-centre the open node, if there is one; false when none is open. */
  focusOpen: () => boolean;
  fit: () => void;
  showNow: () => void;
}): void {
  useEffect(() => {
    if (auto && active && !selected) showNow();
  }, [auto, active, showNow, selected]);

  const refit = useEffectEvent(() => {
    if (focusOpen()) return;
    if (auto && active) showNow();
    else if (!touched.current) fit();
  });
  useEffect(() => {
    const element = viewport.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    let last = `${element.clientWidth}x${element.clientHeight}`;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      const size = `${element.clientWidth}x${element.clientHeight}`;
      if (size === last) return;
      last = size;
      clearTimeout(timer);
      timer = setTimeout(refit, RESIZE_SETTLE_MS);
    });
    observer.observe(element);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [viewport]);
}

/**
 * Opening a node glides it to the middle; walking to another glides there; closing glides back
 * to the view it was opened from (a following live run picks up following again instead). New
 * work re-lays the graph under an open node; that node stays under its card.
 */
function useFocusSelected({
  canvas,
  selected,
  following,
  returnView,
  focusView,
  glide,
  layout,
}: {
  canvas: Canvas;
  selected: string | null;
  following: boolean;
  returnView: RefObject<CanvasView | null>;
  focusView: (id: string) => CanvasView | null;
  glide: (next: CanvasView) => void;
  layout: StepsLayout;
}): void {
  const { viewRef, apply } = canvas;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new selection moves the camera; a pan or zoom under an open card must not
  useLayoutEffect(() => {
    if (selected) {
      returnView.current ??= viewRef.current;
      const next = focusView(selected);
      if (next) glide(next);
      return;
    }
    const back = returnView.current;
    returnView.current = null;
    if (back && !following) glide(back);
  }, [selected]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new layout is the reason to re-centre
  useLayoutEffect(() => {
    const next = selectedRef.current ? focusView(selectedRef.current) : null;
    if (next) apply(next);
  }, [layout]);
}

/** The canvas camera of the Builds tab, and the zoom pill's actions. */
export function useGraphCamera({
  graph,
  ready,
  layout,
  rows,
  live,
  selected,
  onNewRun,
  onDeselect,
}: {
  graph: RunGraphModel;
  /** The recorded outcome has arrived: a run is only fitted once it has. */
  ready: boolean;
  layout: StepsLayout;
  rows: PartRow[];
  live: Step | null;
  selected: string | null;
  onNewRun: () => void;
  /** Close the open node: the camera took the canvas elsewhere. */
  onDeselect: () => void;
}) {
  // A live run keeps its work in view until the user takes the canvas somewhere themselves.
  const [auto, setAuto] = useState(false);
  // Whether the user has moved the canvas since the last fit: until then a resize refits it.
  const touched = useRef(false);
  /** The view a node was opened from: closing it glides back there, unless the user moved on. */
  const returnView = useRef<CanvasView | null>(null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  /** Close an open node where it is — for a move that is about to put the camera elsewhere. */
  const closeHere = useCallback((): void => {
    returnView.current = null;
    if (selectedRef.current) onDeselect();
  }, [onDeselect]);
  // Moving the canvas takes it over: live following stops, and an open node closes where it is.
  const takeOver = useCallback((): void => {
    touched.current = true;
    setAuto(false);
    closeHere();
  }, [closeHere]);
  const canvas = useCanvasView({ initial: { k: INITIAL_ZOOM, tx: 0, ty: 0 }, onPan: takeOver });
  useTakeOverOnWheel(canvas.viewport, takeOver);
  const { gliding, glide } = useGlide(canvas.apply);
  const { fit, showNow } = useFitting(canvas, layout, live, touched);
  const { viewport, viewRef, apply } = canvas;
  const focusView = useCallback(
    (id: string): CanvasView | null => {
      const element = viewport.current;
      const rect = focusRect(layout, rows, id);
      return element && rect ? selectionView(sizeOf(element), rect, viewRef.current) : null;
    },
    [layout, rows, viewport, viewRef],
  );
  const focusOpen = useCallback((): boolean => {
    const next = selectedRef.current ? focusView(selectedRef.current) : null;
    if (next) apply(next);
    return next !== null;
  }, [apply, focusView]);
  const onNewRunHere = useCallback((): void => {
    returnView.current = null;
    onNewRun();
  }, [onNewRun]);
  useOpenFitted(graph, ready, fit, onNewRunHere, setAuto);
  useFollowLive({ viewport, active: graph.active, auto, selected, touched, focusOpen, fit, showNow });
  const following = auto && graph.active;
  useFocusSelected({ canvas, selected, following, returnView, focusView, glide, layout });

  const zoom = (factor: number): void => {
    takeOver();
    canvas.zoomBy(factor);
  };
  return {
    ...canvas,
    auto,
    gliding,
    fit,
    /** Fit everything: an open node closes where it is, and the camera stops following the work. */
    fitAll: (): void => {
      closeHere();
      setAuto(false);
      fit();
    },
    zoomOut: (): void => zoom(1 / ZOOM_STEP),
    zoomIn: (): void => zoom(ZOOM_STEP),
    /** Follow the live work again, or null when there is nothing to follow or it already is. */
    jumpToNow:
      graph.active && !auto
        ? () => {
            closeHere();
            setAuto(true);
          }
        : null,
  };
}

/** A wheel over the canvas is the user moving it: the camera stops following, and an open node closes. */
function useTakeOverOnWheel(viewport: RefObject<HTMLDivElement | null>, takeOver: () => void): void {
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    element.addEventListener("wheel", takeOver, { passive: true });
    return () => element.removeEventListener("wheel", takeOver);
  }, [viewport, takeOver]);
}
