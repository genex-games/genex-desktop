/** Where the native game view sits: over the stage's slot, or nowhere while something else owns the stage. */
import type { RefObject } from "react";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { NATIVE_VIEW_ATTRIBUTE } from "../../native-view.ts";
import { scheduleBounds } from "./bounds-schedule.ts";

type Bounds = { x: number; y: number; width: number; height: number };

/** The native view, out of sight. */
const HIDDEN_BOUNDS: Bounds = { x: 0, y: 0, width: 0, height: 0 };

/** The floating panels a native view would paint over; the developer colour tweaker is dragged like one. */
const FLOATING_PANELS = '[data-slot="popover-content"], [data-slot="dropdown-menu-content"], [data-color-tweaker]';
/** Cards docked in a window corner (the Genex promo): they hold still, so no frame-by-frame tracking. */
const DOCKED_CARDS = "[data-genex-promo]";
const OVERLAY_MOTION_MS = 400;
const OVERLAY_MOTION_EVENTS = ["animationstart", "animationend", "transitionrun", "transitionend"];
const MODAL_DIALOG = '[data-slot="dialog-content"]';

/** Whether a floating panel is on screen over the slot's rectangle. */
function overlaps(panel: Element, rect: DOMRect): boolean {
  const bounds = panel.getBoundingClientRect();
  const visible = bounds.width > 0 && bounds.height > 0;
  return (
    visible &&
    bounds.left < rect.right &&
    bounds.right > rect.left &&
    bounds.top < rect.bottom &&
    bounds.bottom > rect.top
  );
}

/** Marks the slot while it holds the game's cover frame. */
export const COVER_STILL_ATTRIBUTE = "data-live-still";

/**
 * The game as it looked when a dialog or popover covered it, painted on the slot the native view
 * left (null clears it). Without it the slot shows the stage's empty background: a black game.
 */
function holdStill(element: HTMLElement, still: string | null): void {
  element.style.backgroundImage = still ? `url("${still}")` : "";
  element.style.backgroundSize = still ? "100% 100%" : "";
  element.toggleAttribute(COVER_STILL_ATTRIBUTE, Boolean(still));
}

type Viewport = { width: number; height: number };

/** What main hears with every rectangle: whether a game in Live is watched, and the game open on the stage. */
type StageReport = { watching: boolean; project: string | null };

/**
 * Sends the slot's rectangle to main. When something comes to cover the game, the game is
 * photographed first and hidden after, so the dialog opens over the frame instead of a black slot.
 * Each cover has a number: a frame or a hide that arrives after its cover ended is dropped.
 */
/** Resolves after `count` painted frames: what the slot shows has reached the screen. */
function afterFrames(count: number): Promise<void> {
  return new Promise((resolve) => {
    const step = (left: number): void => {
      if (left <= 0) resolve();
      else requestAnimationFrame(() => step(left - 1));
    };
    step(count);
  });
}

/** The frame decoded, so painting it costs nothing when the view leaves; a frame that cannot decode is none. */
async function decodedStill(still: string | null): Promise<string | null> {
  if (!still) return null;
  const image = new Image();
  image.src = still;
  return image.decode().then(
    () => still,
    () => null,
  );
}

function boundsSender(element: HTMLElement, stage: StageReport) {
  let covering = false;
  let cover = 0;
  const send = (bounds: Bounds, viewport: Viewport): Promise<unknown> =>
    window.studio.previewBounds({ ...bounds, ...stage, viewport }).catch(() => false);
  // Covering: the frame is decoded and painted under the view before the view leaves, so no
  // frame of the empty slot ever shows. Uncovering: the view comes back over the frame first,
  // and the frame goes two painted frames later. Either way the stage never blinks black.
  const coverWith = async (mine: number, viewport: Viewport): Promise<void> => {
    const still = await decodedStill(await window.studio.previewCoverStill().catch(() => null));
    if (mine !== cover) return;
    if (still) {
      holdStill(element, still);
      await afterFrames(2);
      if (mine !== cover) return;
    }
    await send(HIDDEN_BOUNDS, viewport);
  };
  const uncover = async (mine: number, bounds: Bounds, viewport: Viewport): Promise<void> => {
    await send(bounds, viewport);
    await afterFrames(2);
    if (mine === cover) holdStill(element, null);
  };
  return {
    send(bounds: Bounds, covered: boolean, viewport: Viewport): void {
      if (covered && !covering) void coverWith(++cover, viewport);
      else if (!covered && covering) void uncover(++cover, bounds, viewport);
      else void send(bounds, viewport);
      covering = covered;
    },
    /** The slot stops tracking: any frame on its way is dropped and the slot is cleared. */
    end(): void {
      cover++;
      holdStill(element, null);
    },
  };
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
  /** Live shows a plugin's card: its game plays in the plugin's engine, so no web page belongs here. */
  pluginCardOnStage: boolean;
  /** Live shows the latest pictures of a folder with no page: no web page belongs here either. */
  stillsOnStage: boolean;
  /** The person stopped the game: its view holds a blank page, and the stage says it is stopped. */
  stopped: boolean;
  /** The person watches a game in Live, whatever briefly covers it (`stage.ts` `watchingLive`); main tells a chat's show by it. */
  watching: boolean;
}

/** Whether the studio window is shown: not hidden or minimized (a window merely covered by others still counts as shown). */
function useWindowShown(): boolean {
  return useSyncExternalStore(
    (changed) => {
      document.addEventListener("visibilitychange", changed);
      return () => document.removeEventListener("visibilitychange", changed);
    },
    () => document.visibilityState !== "hidden",
  );
}

/**
 * Whether the stage shows the running game at all. The compact sidebar and the stage toolbar's
 * panels only float over it: they cover the game like a popover does (see `overlaid`), so the
 * game is photographed before it leaves rather than leaving a black stage behind them.
 */
const showsGame = (cover: StageCover, windowShown: boolean): boolean =>
  windowShown &&
  cover.visible &&
  Boolean(cover.project) &&
  ![
    cover.buildsOpen,
    cover.assetsOpen,
    cover.fileOpen,
    cover.showEmpty,
    cover.liveLoading,
    cover.cardOnStage,
    cover.pluginCardOnStage,
    cover.stillsOnStage,
    cover.stopped,
  ].some(Boolean);

// Keep the native view aligned with this element through resizes and layout changes — and
// hand the rectangle back to the DOM while Builds is open (the native view would otherwise
// paint over it).
/** Report the slot's rectangle to main while the game shows, and zero it the moment anything covers it. */
export function useNativeViewBounds(slot: RefObject<HTMLDivElement | null>, cover: StageCover): void {
  // The game view never throttles itself (agents watch it in the background), so a window out of
  // sight takes it off the stage like any cover: its frames pause and it comes back as it was.
  const windowShown = useWindowShown();
  // The floating covers change without re-placing the view: report() reads them when they move.
  const overlaid = useRef(false);
  overlaid.current = cover.toolbarOpen || cover.sidebarOverlay;
  const reportNow = useRef<(() => void) | null>(null);
  useEffect(() => reportNow.current?.(), [cover.toolbarOpen, cover.sidebarOverlay]);
  const {
    project,
    buildsOpen,
    assetsOpen,
    fileOpen,
    showEmpty,
    liveLoading,
    visible,
    cardOnStage,
    pluginCardOnStage,
    stillsOnStage,
    watching,
    stopped,
  } = cover;
  // biome-ignore lint/correctness/useExhaustiveDependencies: each cover reason re-reports the rectangle, as it always has
  useEffect(() => {
    const element = slot.current;
    if (!element) return;
    // Main hears the game open on the stage, so a show asked in its chat may start it (`liveOutOfSight`).
    const stage: StageReport = { watching, project: visible ? project : null };
    if (!showsGame(cover, windowShown)) {
      element.removeAttribute(NATIVE_VIEW_ATTRIBUTE);
      holdStill(element, null);
      void window.studio.previewBounds({ ...HIDDEN_BOUNDS, ...stage });
      return;
    }
    let lastBounds = "";
    const sender = boundsSender(element, stage);
    const report = (): void => {
      const rect = element.getBoundingClientRect();
      const panels = [...document.querySelectorAll(FLOATING_PANELS)];
      const cards = [...document.querySelectorAll(DOCKED_CARDS)];
      // A native view paints above DOM overlays. Modal dialogs must take it away;
      // an anchored panel in the chat must not blank an unrelated game surface.
      const covered =
        overlaid.current ||
        Boolean(document.querySelector(MODAL_DIALOG)) ||
        [...panels, ...cards].some((panel) => overlaps(panel, rect));
      const bounds = covered
        ? HIDDEN_BOUNDS
        : { x: rect.left, y: rect.top, width: Math.max(0, rect.width), height: Math.max(0, rect.height) };
      // What floats beside the stage reads where the game paints from here (native-view.ts).
      element.toggleAttribute(NATIVE_VIEW_ATTRIBUTE, !covered);
      // The window size it was measured in lets main carry the slot through a resize in progress.
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      const key = JSON.stringify([bounds, viewport]);
      if (key !== lastBounds) {
        lastBounds = key;
        sender.send(bounds, covered, viewport);
      }
      // Overlay style mutations report positioning and exit changes without an idle frame loop.
    };
    report();
    reportNow.current = report;
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
      reportNow.current = null;
      sender.end();
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
    cardOnStage,
    pluginCardOnStage,
    stillsOnStage,
    watching,
    stopped,
    windowShown,
  ]);
}

/** Track only overlay movement, with no animation frame left running after it settles. */
function observeOverlays(report: () => void): () => void {
  const selector = `${FLOATING_PANELS}, ${DOCKED_CARDS}, ${MODAL_DIALOG}`;
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
