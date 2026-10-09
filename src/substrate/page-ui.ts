/**
 * What the studio can see of the page that is NOT the canvas (M4.5a).
 *
 * The studio's eyes were a WebGL canvas, so a game whose menu, car select, pause screen, loader
 * or HUD lives in the DOM was invisible to every builder pass and every judge: the picture came
 * back black and the verdict argued with a screen the player could see perfectly well. This
 * module is the probe that says how much of the window the page's own DOM paints over the game,
 * plus the small ladder that turns `surface: "auto"` into one of the two real surfaces.
 *
 * It is deliberately Electron-free: the probe is a string the preview evaluates in the page, the
 * folding of its untrusted answer is a pure function, and the surface choice is a pure ladder
 * over four callbacks. All three are testable under `node --test` with no window at all.
 *
 * `domUi()` in `src/page/hook.ts` stays the source for the `no-dom-ui` CHECK — what a game
 * declares about itself. `PAGE_UI_PROBE` is the source for the EYES — what the studio decides to
 * photograph. Both live in the studio so they cannot drift apart per game.
 */
import { isJsonObject } from "./fsx.ts";
import { isEffectivelyBlack, type PixelStats } from "./pixel-stats.ts";
import { CaptureSurface } from "../shared/preview-contract.ts";

/** Every surface a caller may ask for. */
const SURFACES: ReadonlySet<string> = new Set(Object.values(CaptureSurface));

/** Above this fraction of the window, the DOM is the primary surface and `auto` photographs it. */
export const PAGE_UI_PRIMARY_COVERAGE = 0.01;

/** At most this many elements are NAMED; area keeps summing past the cap (a busy page still counts). */
export const PAGE_UI_MAX_ENTRIES = 12;
/** How much of one named element a reading keeps. */
const PAGE_UI_MAX_ENTRY_CHARS = 200;

/** The probe never holds a capture up for longer than this; a busy page simply reports nothing. */
export const PAGE_UI_TIMEOUT_MS = 400;

/** The union rectangle of every canvas the page is painting on, in view pixels. */
export interface PageUiCanvas {
  count: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What the DOM adds to the picture the canvas alone would give. */
export interface PageUi {
  /** Up to {@link PAGE_UI_MAX_ENTRIES} named elements, spelled as `domUi()` spells them. */
  entries: string[];
  /** Fraction of the window painted by DOM UI that sits over the game, 0–1. */
  coverage: number;
  /** Where the game is drawn, or null on a page with no canvas at all. */
  canvas: PageUiCanvas | null;
  viewport: { width: number; height: number };
  /** Whether the DOM, not the canvas, is what the player is mostly looking at. */
  uiPrimary: boolean;
}

/**
 * The probe, as one expression `preview.evaluate` can run. It is `domUi()`'s rules with four
 * differences, each of which was a wrong answer in practice:
 *
 *  - per-element CLIPPED area, so a 20 px score line and a full-screen menu are told apart;
 *  - ancestor de-duplication, so a menu and its eight buttons are counted once, not nine times;
 *  - any element that CONTAINS a canvas is skipped — a styled full-page wrapper is not UI;
 *  - an element counts toward coverage only when it INTERSECTS the canvas rectangle, so a
 *    page-sized gradient or a letterboxing frame beside the game cannot flip a game that has no
 *    DOM UI at all.
 *
 * One rule runs the other way and is not mirrored here: `domUi()` names a second visible canvas
 * over the game's (a HUD painted beside the contract's), while this probe skips every canvas, so
 * that canvas reaches the no-dom-ui check and never this coverage.
 *
 * The canvases are collected ONCE and containment is tested against that list, rather than a
 * `querySelector` per element; the entry cap stops the naming, never the area sum. The probe
 * swallows its own throw, because a capture must never fail because the page could not be read.
 */
export const PAGE_UI_PROBE = `(() => {
  try {
    const doc = typeof document === "undefined" ? null : document;
    const win = typeof window === "undefined" ? null : window;
    const root = doc && doc.documentElement ? doc.documentElement : null;
    const width = Math.max(0, Math.round((win && win.innerWidth) || (root && root.clientWidth) || 0));
    const height = Math.max(0, Math.round((win && win.innerHeight) || (root && root.clientHeight) || 0));
    const viewport = { width: width, height: height };
    const empty = { entries: [], coverage: 0, canvas: null, viewport: viewport, uiPrimary: false };
    if (!doc || !doc.body || width <= 0 || height <= 0) return empty;
    const view = { left: 0, top: 0, right: width, bottom: height };
    const spanOf = (r) => {
      const w = Math.min(r.right, view.right) - Math.max(r.left, view.left);
      const h = Math.min(r.bottom, view.bottom) - Math.max(r.top, view.top);
      return { w: Math.max(0, w), h: Math.max(0, h) };
    };
    const overlaps = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0;
    const climb = (el, visit) => {
      let parent = el.parentElement;
      let depth = 0;
      while (parent && depth++ < 64) {
        if (visit(parent) === false) return false;
        parent = parent.parentElement;
      }
      return true;
    };
    // One pass over the canvases: the union rectangle the game is drawn on, and every element
    // that contains one. A wrapper around the game is scenery, not interface.
    const wrappers = new Set();
    let box = null;
    let count = 0;
    const canvases = doc.querySelectorAll ? doc.querySelectorAll("canvas") : [];
    for (const canvas of canvases) {
      climb(canvas, (parent) => void wrappers.add(parent));
      const r = canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : null;
      if (!r || r.width <= 0 || r.height <= 0) continue;
      count++;
      box = box
        ? { left: Math.min(box.left, r.left), top: Math.min(box.top, r.top), right: Math.max(box.right, r.right), bottom: Math.max(box.bottom, r.bottom) }
        : { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    }
    let target = view;
    if (box) {
      const clipped = { left: Math.max(box.left, 0), top: Math.max(box.top, 0), right: Math.min(box.right, width), bottom: Math.min(box.bottom, height) };
      if (clipped.right > clipped.left && clipped.bottom > clipped.top) target = clipped;
    }
    const skip = new Set(["CANVAS", "SCRIPT", "STYLE", "LINK", "META", "TEMPLATE", "TITLE", "HEAD", "HTML", "BODY"]);
    const visual = new Set(["IMG", "SVG", "INPUT", "BUTTON", "SELECT", "TEXTAREA", "VIDEO", "PROGRESS", "METER"]);
    const taken = new Set();
    const entries = [];
    let painted = 0;
    for (const el of doc.body.querySelectorAll("*")) {
      if (skip.has(el.tagName)) continue;
      if (el.closest && el.closest("svg") !== null && el.tagName !== "SVG") continue;
      if (wrappers.has(el)) continue;
      if (!climb(el, (parent) => (taken.has(parent) ? false : true))) continue;
      if (el.id === "fatal" && !(el.textContent || "").trim()) continue;
      const style = getComputedStyle(el);
      if (!style || style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) continue;
      const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
      if (!rect || rect.width <= 0 || rect.height <= 0) continue;
      if (el.getClientRects && el.getClientRects().length === 0) continue;
      const ownText = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => (n.textContent || "").trim()).join(" ").trim();
      const paints =
        (style.backgroundColor && !/rgba\\(\\s*\\d+,\\s*\\d+,\\s*\\d+,\\s*0\\s*\\)|transparent/.test(style.backgroundColor)) ||
        (style.backgroundImage && style.backgroundImage !== "none") ||
        (style.borderStyle && style.borderStyle !== "none" && parseFloat(style.borderWidth) > 0);
      if (!ownText && !visual.has(el.tagName) && !paints) continue;
      if (!overlaps(rect, target)) continue;
      const span = spanOf(rect);
      if (span.w <= 0 || span.h <= 0) continue;
      taken.add(el);
      painted += span.w * span.h;
      if (entries.length < ${PAGE_UI_MAX_ENTRIES}) {
        const name = el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\\s+/).join(".") : "");
        entries.push(ownText ? name + ' "' + ownText.slice(0, 40) + '"' : name);
      }
    }
    const coverage = Math.min(1, painted / (width * height));
    return {
      entries: entries,
      coverage: coverage,
      canvas: box ? { count: count, x: Math.round(box.left), y: Math.round(box.top), width: Math.round(box.right - box.left), height: Math.round(box.bottom - box.top) } : null,
      viewport: viewport,
      uiPrimary: coverage >= ${PAGE_UI_PRIMARY_COVERAGE},
    };
  } catch (err) {
    return { entries: [], coverage: 0, canvas: null, viewport: { width: 0, height: 0 }, uiPrimary: false, error: String(err) };
  }
})()`;

const finite = (value: unknown, fallback = 0): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/**
 * Fold the probe's answer — which is produced by a page an agent wrote, so it is data and
 * nothing else — into a {@link PageUi}. A page that answered nothing, threw, or answered a
 * shape this does not recognise reads back as `null`: the studio then knows it does not know,
 * which is not the same as knowing the page has no UI.
 */
export function readPageUi(raw: unknown): PageUi | null {
  if (!isJsonObject(raw)) return null;
  const value = raw;
  if (typeof value.__error === "string" || typeof value.error === "string") return null;
  const rawEntries = Array.isArray(value.entries) ? value.entries : [];
  const entries: string[] = [];
  for (const entry of rawEntries) {
    if (typeof entry !== "string") continue;
    entries.push(entry.slice(0, PAGE_UI_MAX_ENTRY_CHARS));
    if (entries.length >= PAGE_UI_MAX_ENTRIES) break;
  }
  const coverage = Math.min(1, Math.max(0, finite(value.coverage)));
  const viewportRaw = (value.viewport ?? {}) as Record<string, unknown>;
  const canvasRaw = value.canvas && typeof value.canvas === "object" ? (value.canvas as Record<string, unknown>) : null;
  const canvas: PageUiCanvas | null = canvasRaw
    ? {
        count: Math.max(0, Math.round(finite(canvasRaw.count, 1))),
        x: Math.round(finite(canvasRaw.x)),
        y: Math.round(finite(canvasRaw.y)),
        width: Math.max(0, Math.round(finite(canvasRaw.width))),
        height: Math.max(0, Math.round(finite(canvasRaw.height))),
      }
    : null;
  return {
    entries,
    coverage,
    canvas,
    viewport: {
      width: Math.max(0, Math.round(finite(viewportRaw.width))),
      height: Math.max(0, Math.round(finite(viewportRaw.height))),
    },
    // Recomputed, never taken on the page's word: the threshold is the studio's to decide.
    uiPrimary: coverage >= PAGE_UI_PRIMARY_COVERAGE,
  };
}

/**
 * Run the probe through whatever can evaluate in the page, guarded and timed. An evaluate that
 * rejects (a navigating frame), hangs (a page in a long task) or answers rubbish yields `null`,
 * because a capture that works today must never start failing because a probe did.
 */
export async function probePageUi(
  evaluate: (expression: string) => Promise<unknown>,
  options: { timeoutMs?: number } = {},
): Promise<PageUi | null> {
  const timeoutMs = finite(options.timeoutMs, PAGE_UI_TIMEOUT_MS);
  const late = Symbol("page-ui-timeout");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const answer = await Promise.race([
      Promise.resolve()
        .then(() => evaluate(PAGE_UI_PROBE))
        .catch(() => late),
      new Promise<typeof late>((resolve) => {
        timer = setTimeout(() => resolve(late), timeoutMs);
      }),
    ]);
    return answer === late ? null : readPageUi(answer);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** `surface` wins; the legacy `page: true` is its permanent alias; neither means the canvas. */
export function resolveSurface(opts: { page?: boolean; surface?: CaptureSurface } = {}): CaptureSurface {
  if (opts.surface && SURFACES.has(opts.surface)) return opts.surface;
  return opts.page === true ? CaptureSurface.Page : CaptureSurface.Canvas;
}

/** With the DOM over the game, the picture the player sees is the compositor's, not the canvas's. */
export function autoWantsPage(ui: PageUi | null): boolean {
  return ui?.uiPrimary === true;
}

/**
 * The other half of `auto`: the case where the CANVAS eye is the broken one. No frame at all, or
 * a frame that is effectively black on a page that does have a canvas, means the canvas read
 * gave the studio nothing — a WebGPU or multi-canvas game that would otherwise be judged black
 * for the whole run. The compositor sees those frames, so `auto` asks it.
 */
export function blankCanvasWantsPage(stats: PixelStats | null, ui: PageUi | null): boolean {
  if (!stats) return true;
  if (!isEffectivelyBlack(stats)) return false;
  return (ui?.canvas?.count ?? 0) > 0;
}

/** The four things the ladder needs from the preview; `T` is whatever a capture returns. */
export interface CaptureLadder<T> {
  /** The guarded probe. Called at most once per capture. */
  pageUi(): Promise<PageUi | null>;
  /** The canvas surface: the page's own end-of-frame read, else the compositor. */
  canvas(): Promise<T>;
  /** The page surface: the compositor frame, with every DOM element on it. */
  page(): Promise<T>;
  /** Pixel stats of a canvas frame — only ever asked for on the `auto` path. */
  measure(shot: T): PixelStats | null;
}

/** What the ladder settled on, and everything it learned on the way there. */
export interface ChosenCapture<T> {
  shot: T;
  surface: typeof CaptureSurface.Canvas | typeof CaptureSurface.Page;
  ui: PageUi | null;
  /** The stats already computed for a returned canvas frame, so no caller measures it twice. */
  stats: PixelStats | null;
}

/**
 * The surface ladder, pure over its four callbacks so the whole of it is testable without a
 * window. `canvas` and `page` are the two real surfaces and go straight through. `auto` asks the
 * page what it looks like, and then, if the canvas frame it took is missing or black on a page
 * that has a canvas, asks the compositor instead.
 *
 * Every fallback runs one way only: toward a picture. An `auto` capture that works today cannot
 * begin to fail because a probe rejected, because a page capture threw, or because a window is
 * offscreen — the frame it already has is returned instead.
 */
export async function chooseCapture<T>(asked: CaptureSurface, ladder: CaptureLadder<T>): Promise<ChosenCapture<T>> {
  if (asked === CaptureSurface.Page)
    return { shot: await ladder.page(), surface: CaptureSurface.Page, ui: null, stats: null };
  if (asked !== CaptureSurface.Auto) {
    return { shot: await ladder.canvas(), surface: CaptureSurface.Canvas, ui: null, stats: null };
  }

  const ui = await ladder.pageUi();
  if (autoWantsPage(ui)) {
    try {
      return { shot: await ladder.page(), surface: CaptureSurface.Page, ui, stats: null };
    } catch {
      /* the DOM is the better picture, but a canvas frame beats no frame at all */
    }
    return { shot: await ladder.canvas(), surface: CaptureSurface.Canvas, ui, stats: null };
  }

  let shot: { value: T } | null = null;
  let failure: unknown = null;
  try {
    shot = { value: await ladder.canvas() };
  } catch (err) {
    failure = err;
  }
  let stats: PixelStats | null = null;
  if (shot) {
    try {
      stats = ladder.measure(shot.value);
    } catch {
      stats = null;
    }
  }
  // No shot means no stats, and no stats always wants the page: `shot` is set whenever this returns.
  if (shot && !blankCanvasWantsPage(stats, ui)) return { shot: shot.value, surface: CaptureSurface.Canvas, ui, stats };
  try {
    return { shot: await ladder.page(), surface: CaptureSurface.Page, ui, stats: null };
  } catch (err) {
    if (shot) return { shot: shot.value, surface: CaptureSurface.Canvas, ui, stats };
    throw failure ?? err;
  }
}

/**
 * What a `PreviewPort.pageUi()` hands back. It is deliberately untyped: the answer comes from a
 * page an agent wrote, through a port that may be a fake or an older seed, so every caller folds
 * it with {@link readPageUi} rather than trusting a shape. `GamePreview.pageUi()` itself returns
 * the folded {@link PageUi}.
 */
export type PageUiAnswer = unknown;
