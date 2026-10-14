/**
 * Where the web game view sits: over the stage's slot, or nowhere while something else owns the
 * stage or Live shows the Mac build itself (Native). The native web view paints above the page, so
 * a floating panel or a dialog over the slot takes it away; Live's own canvas (`NativeLiveCanvas`)
 * is part of the page, so overlays draw over it and nothing ever takes it away.
 */
import type { RefObject } from "react";
import { useEffect } from "react";
import { NATIVE_VIEW_ATTRIBUTE } from "../../native-view.ts";
import { scheduleBounds } from "./bounds-schedule.ts";

type Bounds = { x: number; y: number; width: number; height: number };

/** A rectangle as `getBoundingClientRect` reports it. */
export type Box = Pick<DOMRect, "left" | "top" | "right" | "bottom" | "width" | "height">;

/** The native view, out of sight. */
const HIDDEN_BOUNDS: Bounds = { x: 0, y: 0, width: 0, height: 0 };

/** The floating panels a native view would paint over; the developer colour tweaker is dragged like one. */
const FLOATING_PANELS =
  '[data-slot="popover-content"], [data-slot="dropdown-menu-content"], [data-color-tweaker], [data-genex-promo]';
const OVERLAY_MOTION_MS = 400;
const OVERLAY_MOTION_EVENTS = ["animationstart", "animationend", "transitionrun", "transitionend"];
const MODAL_DIALOG = '[data-slot="dialog-content"]';

/** What lies over the page near the stage. */
export const Overlay = {
  /** A popover, a menu, the colour tweaker: it takes the web view away while it is over the slot. */
  Floating: "floating",
  /** A dialog: the web view gives way wherever it is. */
  Modal: "modal",
} as const;
export type Overlay = (typeof Overlay)[keyof typeof Overlay];

/** One overlay and where it is. */
export interface OverlayBox {
  kind: Overlay;
  rect: Box;
}

/** Whether `panel` is on screen over the slot's rectangle. */
function overlaps(panel: Box, rect: Box): boolean {
  const visible = panel.width > 0 && panel.height > 0;
  return (
    visible && panel.left < rect.right && panel.right > rect.left && panel.top < rect.bottom && panel.bottom > rect.top
  );
}

/** Whether an overlay takes the web view away: any dialog, or a floating panel over the slot. */
function takesView(overlay: OverlayBox, slot: Box): boolean {
  if (overlay.kind === Overlay.Modal) return true;
  return overlay.kind === Overlay.Floating && overlaps(overlay.rect, slot);
}

/** Why the native view gives the rectangle back to the DOM: anything on the stage that is not the running game. */
export interface StageCover {
  project: string | null;
  visible: boolean;
  sidebarOverlay: boolean;
  buildsOpen: boolean;
  assetsOpen: boolean;
  fileOpen: boolean;
  showEmpty: boolean;
  liveLoading: boolean;
  toolbarOpen: boolean;
  /** Live shows the Unreal card: the game plays in the Unreal editor, so no web page belongs here. */
  cardOnStage: boolean;
  /** Live shows the latest pictures of a folder with no page: no web page belongs here either. */
  stillsOnStage: boolean;
  /** The person stopped the game: its view holds a blank page, and the stage says it is stopped. */
  stopped: boolean;
  /** The person watches a game in Live, whatever briefly covers it (`stage.ts` `watchingLive`); main tells a chat's show by it. */
  watching: boolean;
  /** Live shows the game's Mac build in its own canvas (Native): the web view gives the slot up. */
  native: boolean;
}

/** Whether the stage shows the running game at all. */
const showsGame = (cover: StageCover): boolean =>
  cover.visible &&
  Boolean(cover.project) &&
  ![
    cover.sidebarOverlay,
    cover.buildsOpen,
    cover.assetsOpen,
    cover.fileOpen,
    cover.showEmpty,
    cover.liveLoading,
    cover.toolbarOpen,
    cover.cardOnStage,
    cover.stillsOnStage,
    cover.stopped,
  ].some(Boolean);

/**
 * Where the web game view goes for a slot at `slot` with `overlays` near it: the slot, or nowhere
 * while the stage shows no game, Live shows the Mac build, or an overlay takes the view away.
 */
export function webViewBounds(cover: StageCover, slot: Box, overlays: readonly OverlayBox[]): Bounds {
  if (!showsGame(cover) || cover.native) return HIDDEN_BOUNDS;
  if (overlays.some((overlay) => takesView(overlay, slot))) return HIDDEN_BOUNDS;
  return { x: slot.left, y: slot.top, width: Math.max(0, slot.width), height: Math.max(0, slot.height) };
}

/**
 * Whether Live's canvas for the Mac build stays mounted: Native chosen for a game the person has
 * not stopped. Overlays, Builds and a hidden stage never take it away (they draw over it, and main
 * pauses the game unwatched); unmounting ends the run, which is what Stop asks for, and Play mounts
 * it again.
 */
export function nativeCanvasShown(cover: Pick<StageCover, "native" | "project" | "stopped">): boolean {
  return cover.native && Boolean(cover.project) && !cover.stopped;
}

/** The overlays on the page right now, each with where it is. */
function overlaysNow(): OverlayBox[] {
  const floating = [...document.querySelectorAll(FLOATING_PANELS)].map((panel) => ({
    kind: Overlay.Floating,
    rect: panel.getBoundingClientRect(),
  }));
  const modal = document.querySelector(MODAL_DIALOG);
  return modal ? [...floating, { kind: Overlay.Modal, rect: modal.getBoundingClientRect() }] : floating;
}

// Keep the native view aligned with this element through resizes and layout changes — and
// hand the rectangle back to the DOM while Builds is open (the native view would otherwise
// paint over it).
/** Report the slot's rectangle to main while the game shows, and zero it the moment anything covers it. */
export function useNativeViewBounds(slot: RefObject<HTMLDivElement | null>, cover: StageCover): void {
  const {
    project,
    buildsOpen,
    assetsOpen,
    fileOpen,
    showEmpty,
    liveLoading,
    visible,
    sidebarOverlay,
    toolbarOpen,
    cardOnStage,
    stillsOnStage,
    watching,
    stopped,
    native,
  } = cover;
  // biome-ignore lint/correctness/useExhaustiveDependencies: each cover reason re-reports the rectangle, as it always has
  useEffect(() => {
    const element = slot.current;
    if (!element) return;
    if (!showsGame(cover) || native) {
      element.removeAttribute(NATIVE_VIEW_ATTRIBUTE);
      void window.studio.previewBounds({ ...HIDDEN_BOUNDS, watching });
      return;
    }
    let lastBounds = "";
    const report = (): void => {
      // A native view paints above DOM overlays. Modal dialogs must take it away; an anchored panel
      // in the chat must not blank an unrelated game surface.
      const bounds = webViewBounds(cover, element.getBoundingClientRect(), overlaysNow());
      // What floats beside the stage reads where the game paints from here (native-view.ts).
      element.toggleAttribute(NATIVE_VIEW_ATTRIBUTE, bounds.width > 0 && bounds.height > 0);
      // The window size it was measured in lets main carry the slot through a resize in progress.
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      const key = JSON.stringify([bounds, viewport]);
      if (key !== lastBounds) {
        lastBounds = key;
        void window.studio.previewBounds({ ...bounds, watching, viewport });
      }
      // Overlay style mutations report positioning and exit changes without an idle frame loop.
    };
    report();
    const layout = scheduleBounds(report, window);
    const schedule = layout.signal;
    const stopOverlays = observeOverlays(report);
    const observer = new ResizeObserver(schedule);
    observer.observe(element);
    window.addEventListener("resize", schedule);
    return () => {
      observer.disconnect();
      stopOverlays();
      layout.stop();
      window.removeEventListener("resize", schedule);
      element.removeAttribute(NATIVE_VIEW_ATTRIBUTE);
      void window.studio.previewBounds({ ...HIDDEN_BOUNDS, watching: false });
    };
  }, [
    project,
    buildsOpen,
    assetsOpen,
    fileOpen,
    showEmpty,
    liveLoading,
    visible,
    sidebarOverlay,
    toolbarOpen,
    cardOnStage,
    stillsOnStage,
    watching,
    stopped,
    native,
  ]);
}

/** Track only overlay movement, with no animation frame left running after it settles. */
function observeOverlays(report: () => void): () => void {
  const selector = `${FLOATING_PANELS}, ${MODAL_DIALOG}`;
  const relevant = (node: Node): boolean =>
    node instanceof Element && (Boolean(node.closest(selector)) || Boolean(node.querySelector(selector)));
  let frame = 0;
  let until = 0;
  const tick = () => {
    report();
    frame = performance.now() < until ? requestAnimationFrame(tick) : 0;
  };
  const moving = () => {
    report();
    until = performance.now() + OVERLAY_MOTION_MS;
    if (!frame) frame = requestAnimationFrame(tick);
  };
  const motion = (event: Event) => {
    if (event.target instanceof Node && relevant(event.target)) moving();
  };
  const overlays = new MutationObserver((records) => {
    const changed = records.some((record) =>
      record.type === "attributes"
        ? relevant(record.target)
        : [...record.addedNodes, ...record.removedNodes].some(relevant),
    );
    if (changed) moving();
  });
  overlays.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["style", "data-state", "data-open", "data-closed"],
  });
  for (const event of OVERLAY_MOTION_EVENTS) document.addEventListener(event, motion, true);
  return () => {
    overlays.disconnect();
    cancelAnimationFrame(frame);
    for (const event of OVERLAY_MOTION_EVENTS) document.removeEventListener(event, motion, true);
  };
}
