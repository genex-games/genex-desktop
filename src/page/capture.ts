/**
 * The end-of-frame photograph (M4.9a).
 *
 * The rule this file exists to enforce is: never re-render to take a picture. A game with a
 * post-processing composer draws its world into a target and its last pass is what the user
 * sees, so a capture that re-renders from (scene, camera) photographs a frame the player never
 * looked at — no bloom, no tone map, no grade — and the judge then argues with the screenshot.
 * So the capture waits for the END of a frame the game drew itself and reads the canvas in the
 * same JS turn, which is exactly as long as a WebGL drawing buffer survives without
 * `preserveDrawingBuffer`.
 *
 * The second thing it does is composite. A canvas created with `alpha: true` (three's default)
 * hands back a frame with transparent pixels wherever nothing was drawn, and `toDataURL` keeps
 * that alpha, so the pixel arithmetic downstream measured black where the player saw the page's
 * own background. One `fillRect` of the resolved page background under one `drawImage` fixes
 * that, and it is a no-op for an opaque frame — which is why it is unconditional and there is
 * no attribute sniffing and no second path. A page whose background is an image or a gradient
 * cannot be resolved to one colour, so the capture refuses and the compositor takes the frame.
 *
 * Everything is built from injected dependencies, so the whole ladder is testable under
 * `node --test` with stub canvases and a stub clock.
 */

import type { Foreign } from "./foreign.ts";

/** How long the capture waits for the page's own frame before it drives one itself. */
export const CAPTURE_RACE_MS = 250;

/** How long, and in how many looks, an asynchronous WebGPU frame is given to land. */
export const ASYNC_TICKS = 8;
export const ASYNC_TICK_MS = 16;

/** The context kinds a three game draws its world on. */
const THREE_KINDS = new Set(["webgl", "webgl2", "webgpu"]);

/** A colour that paints nothing, whatever the page meant by it. */
const TRANSPARENT = /^(?:transparent|rgba?\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0(?:\.0+)?\s*\))$/i;

/** With no declared background anywhere, a browser paints the page white. So do we. */
export const DEFAULT_BACKGROUND = "#ffffff";

export const NO_CANVAS = "this page has no canvas to photograph";
export const TRANSPARENT_WEBGPU =
  "this WebGPU canvas is transparent and the page cannot composite it, so the compositor takes the frame";
export const NOTHING_DREW = "nothing was drawn for this frame, so the canvas holds no picture";
export const PAINTED_BACKGROUND =
  "the page background is an image or a gradient, so the page cannot resolve one colour behind the frame";

/** Everything the capture needs from the page (the shim and the hook hand these in). */
export interface CaptureDeps {
  canvases?: () => Foreign;
  rendererCanvas?: () => Foreign;
  afterFrame?: (fn: () => void) => (() => void) | null | undefined;
  pumpFrame?: (dt: number) => unknown;
  draws?: () => Foreign;
  frozen?: () => boolean;
  start?: () => unknown;
  pause?: () => unknown;
  gameCapture?: () => Foreign;
  debugCamera?: (name: string) => unknown;
  currentCamera?: () => Foreign;
  computedStyle?: (element: Foreign) => Foreign;
  parentOf?: (element: Foreign) => Foreign;
  createCanvas?: () => Foreign;
  decode?: (dataUrl: string) => Promise<Foreign> | Foreign;
  setTimeout?: (fn: (value?: unknown) => void, ms: number) => Foreign;
  clearTimeout?: (id: Foreign) => void;
  raceMs?: number;
}

/** What the last capture did, and what it had to work with (`captureInfo()`). Plain data, JSON-able. */
export interface CaptureInfo {
  source: string;
  reason: string | null;
  picked: Foreign;
  canvases: Foreign[];
  background: string | null;
  composited: boolean;
  drawCalls: number | null;
  ladder: string[];
  backend: string | null;
  kind: string | null;
  count: number;
  [field: string]: Foreign;
}

/** A frame capture's page, clock and what it recorded last. */
interface Capturing {
  deps: CaptureDeps;
  raceMs: number;
  later: (fn: Foreign, ms: number) => Foreign;
  cancel: (id: Foreign) => void;
  busy: boolean;
  info: CaptureInfo;
}

/** The canvas a picture comes from, and why it was chosen. */
interface Picked {
  canvas: Foreign;
  descriptor: Foreign;
  index: number;
  why: string;
  area?: number;
}

/** What a capture records about one picture. */
type Shot = (patch: Foreign) => CaptureInfo;

const guarded = (fn: () => Foreign, fallback: Foreign = null): Foreign => {
  try {
    const value = fn();
    return value === undefined ? fallback : value;
  } catch {
    return fallback;
  }
};

const isImage = (value: unknown): value is string => typeof value === "string" && value.startsWith("data:image/");

function surfaces(c: Capturing) {
  const seen = guarded(() => c.deps.canvases?.(), null);
  const elements = Array.isArray(seen?.elements) ? seen.elements : [];
  const descriptors = Array.isArray(seen?.descriptors) ? seen.descriptors : [];
  return { elements, descriptors };
}

const totals = (c: Capturing) => guarded(() => c.deps.draws?.(), null);
function drawnSoFar(c: Capturing) {
  const now = totals(c);
  const calls = Number(now?.drawCalls);
  return Number.isFinite(calls) ? calls : 0;
}
/** With no counters (or counters quieted for an optimization sample) a draw cannot be proved. */
function countersLive(c: Capturing) {
  const now = totals(c);
  return Boolean(now) && now.counting !== false;
}

const usable = (descriptor: Foreign) =>
  Boolean(descriptor) && descriptor.visible !== false && (descriptor.width ?? 0) > 0 && (descriptor.height ?? 0) > 0;

/** The largest usable canvas `wanted` accepts; ties go to document order, so `>` and never `>=`. */
function largest(elements: Foreign[], descriptors: Foreign[], wanted: (descriptor: Foreign) => boolean): Picked | null {
  let best: Picked | null = null;
  descriptors.forEach((descriptor: Foreign, index: number) => {
    if (!wanted(descriptor) || !usable(descriptor)) return;
    const area = (descriptor.width ?? 0) * (descriptor.height ?? 0);
    if (best && area <= (best.area ?? 0)) return;
    best = {
      canvas: elements[index],
      descriptor,
      index,
      area,
      why: THREE_KINDS.has(descriptor.kind) ? "largest 3D canvas" : "largest canvas",
    };
  });
  return best;
}

/**
 * The canvas the picture comes from: the one the hook saw the world drawn on, else the
 * largest 3D canvas the page created, ties going to document order. A canvas is never asked
 * for a context here — asking creates one, and that is what blanked every WebGPU frame.
 */
function pick(c: Capturing): Picked {
  const { elements, descriptors } = surfaces(c);
  const own = guarded(() => c.deps.rendererCanvas?.(), null);
  const ownIndex = own ? elements.indexOf(own) : -1;
  if (ownIndex >= 0 && usable(descriptors[ownIndex])) {
    return { canvas: own, descriptor: descriptors[ownIndex], index: ownIndex, why: "renderer" };
  }
  // Two passes: the 3D canvases first, then anything else the page made (a context created
  // before the shim's patch reads back as `unknown`, and is still more likely the world than
  // no picture at all).
  const best =
    largest(elements, descriptors, (descriptor) => THREE_KINDS.has(descriptor.kind)) ??
    largest(elements, descriptors, (descriptor) => descriptor.kind !== "2d");
  return best ?? { canvas: null, descriptor: null, index: -1, why: NO_CANVAS };
}

/** How many ancestors the background search climbs before it settles on the default. */
const MAX_BACKGROUND_HOPS = 32;

/** One element's own background: a colour, a refusal for an image, or null when it is transparent. */
function ownBackground(style: Foreign): { ok: boolean; colour?: string; reason?: string } | null {
  const image = String(style.backgroundImage ?? "none");
  if (image && image !== "none") return { ok: false, reason: PAINTED_BACKGROUND };
  const colour = String(style.backgroundColor ?? "");
  if (colour && !TRANSPARENT.test(colour.trim())) return { ok: true, colour };
  return null;
}

/** Resolve one colour to paint behind the frame, or say why the page cannot be resolved. */
function background(c: Capturing, canvas: Foreign) {
  let element = canvas;
  let hops = 0;
  while (element && hops++ < MAX_BACKGROUND_HOPS) {
    const style = guarded(() => c.deps.computedStyle?.(element), null);
    if (!style) break;
    const found = ownBackground(style);
    if (found) return found;
    element = guarded(() => c.deps.parentOf?.(element), null);
  }
  return { ok: true, colour: DEFAULT_BACKGROUND };
}

/** The next end-of-frame, or false when none came within the race. */
function nextFrame(c: Capturing) {
  return new Promise((resolve) => {
    let settled = false;
    let timer: Foreign = null;
    let unsubscribe: (() => void) | null = null;
    const finish = (fired: Foreign) => {
      if (settled) return;
      settled = true;
      if (timer !== null) c.cancel(timer);
      try {
        unsubscribe?.();
      } catch {
        /* an unsubscribe that throws has already done its job */
      }
      resolve(fired);
    };
    timer = c.later(() => finish(false), c.raceMs);
    try {
      unsubscribe = c.deps.afterFrame?.(() => finish(true)) ?? null;
      if (!unsubscribe) finish(false);
    } catch {
      finish(false);
    }
  });
}

function record(c: Capturing, patch: Foreign) {
  c.info = { ...c.info, ...patch, count: c.info.count + 1 };
  return c.info;
}

/** The picked canvas as a record describes it. */
function pickedSummary(picked: Picked, kind: Foreign) {
  if (!picked.descriptor) return null;
  const { index, descriptor, why } = picked;
  return { index, kind, width: descriptor.width, height: descriptor.height, why };
}

/** The fields a caller may record about a picture it took itself. */
const NOTED = ["source", "reason", "picked", "background", "composited", "drawCalls", "ladder", "backend", "kind"];

/**
 * What a game's own `capture()` did — recorded here so the picture's provenance is not lost.
 * The template photographs its own render for a game that passed `render`, and without this
 * the studio read back the record of a capture that never happened: no draw count, and a
 * reason left over from before the page had drawn anything.
 */
function note(c: Capturing, patch: Foreign) {
  const clean: Record<string, Foreign> = { source: "game", ladder: ["game"], canvases: [] };
  if (patch && typeof patch === "object") {
    for (const key of NOTED) if (patch[key] !== undefined) clean[key] = patch[key];
  }
  record(c, clean);
  return captureInfo(c);
}

/** Decodes a picture the page can draw, or null when it cannot. */
const decodeImage = (c: Capturing, dataUrl: string) =>
  Promise.resolve(guarded(() => c.deps.decode?.(dataUrl), null)).catch(() => null);

/** The canvas's pixel size, at least one by one. */
const pixelSize = (canvas: Foreign) => ({
  width: Math.max(1, Math.round(Number(canvas?.width) || 0)),
  height: Math.max(1, Math.round(Number(canvas?.height) || 0)),
});

/** A decoded picture's own pixel size, or null when it does not say. */
function imageSize(image: Foreign): { width: number; height: number } | null {
  const width = Math.round(Number(image?.naturalWidth ?? image?.width) || 0);
  const height = Math.round(Number(image?.naturalHeight ?? image?.height) || 0);
  return width > 0 && height > 0 ? { width, height } : null;
}

/**
 * Composite a picture a game took itself over the page's own background, and record it.
 *
 * The template photographs its own render — for a game that passed `render`, and for a
 * viewpoint the harness placed, which the page's own next frame would undo — and a raw
 * `toDataURL` of a canvas made with `alpha: true`, three's default, encodes as black wherever
 * nothing was drawn. That is the very thing this file exists to prevent, so a game's own
 * picture goes over the same background as one the shim took. Returns the composited picture,
 * or the one it was given when the page cannot be resolved to one colour.
 */
async function paint(c: Capturing, dataUrl: Foreign, patch: Record<string, Foreign> = {}) {
  const picked = pick(c);
  const kind = picked.descriptor?.kind ?? null;
  const keep = (extra: Foreign) =>
    note(c, {
      picked: pickedSummary(picked, kind),
      kind,
      backend: THREE_KINDS.has(kind) ? kind : null,
      ...patch,
      ...extra,
    });
  if (!isImage(dataUrl)) {
    keep({ reason: patch.reason ?? "the game's own capture produced no image", composited: false, background: null });
    return null;
  }
  const colour = picked.canvas ? background(c, picked.canvas) : { ok: false, reason: NO_CANVAS };
  if (!colour.ok) {
    keep({ composited: false, background: null });
    return dataUrl;
  }
  const decoded = await decodeImage(c, dataUrl);
  // The picture's own size, not the canvas's: a Rust game reads back its world target at the
  // world size while an `expand` canvas fills the window, and the rows it did not cover were a band.
  const { width, height } = imageSize(decoded) ?? pixelSize(picked.canvas);
  const painted = decoded ? composite(c, decoded, colour.colour, width, height) : null;
  keep({ composited: Boolean(painted), background: colour.colour });
  return painted ?? dataUrl;
}

/** Paint `colour` behind `source` on a scratch canvas and encode it. Null when it cannot. */
function composite(c: Capturing, source: Foreign, colour: Foreign, width: Foreign, height: Foreign) {
  const scratch = guarded(() => c.deps.createCanvas?.(), null);
  const context = scratch ? guarded(() => scratch.getContext("2d"), null) : null;
  if (!context) return null;
  scratch.width = width;
  scratch.height = height;
  context.fillStyle = colour;
  context.fillRect(0, 0, width, height);
  const drawn = guarded(() => {
    context.drawImage(source, 0, 0);
    return true;
  }, false);
  if (!drawn) return null;
  const url = guarded(() => scratch.toDataURL("image/png"), null);
  return isImage(url) ? url : null;
}

/**
 * Photograph the frame the game drew. Returns a `data:image/png` string, or null with a
 * reason in `captureInfo()`. `options.allowResume` lets the ladder start a frozen page for
 * one frame — a look never does that, a deliberate recovery may.
 */
async function capture(c: Capturing, options = {}) {
  // The ladder calls the game's own `capture()`, and the template's own `capture()` calls
  // back into this one when the game has no render of its own. One of them has to stop.
  if (c.busy) return null;
  c.busy = true;
  try {
    return await photograph(c, options ?? {});
  } catch {
    record(c, { reason: "the page-side capture threw", composited: false });
    return null;
  } finally {
    c.busy = false;
  }
}

/** Drives one frame the page did not draw on its own: frozen (`pump`), or past the race (`timeout`). */
function pumpOne(c: Capturing, ladder: string[], why: "pump" | "timeout") {
  ladder.push(why);
  guarded(() => c.deps.pumpFrame?.(0), false);
}

/** Where the ladder stands: what it has tried, and what had been drawn before it began. */
interface Climb {
  ladder: string[];
  before: number;
  kind: Foreign;
  allowResume: boolean;
}

// A WebGPU game renders ASYNCHRONOUSLY: `renderAsync` returns a promise, so the render pass
// is recorded after the animation callback has already returned and the counters, read in
// the same turn, still say nothing was drawn. Unlike a WebGL drawing buffer, a WebGPU canvas
// keeps its picture across turns, so waiting for the pass costs nothing — and it is the only
// way to photograph `setAnimationLoop(async () => …)`, which is how a WebGPU game is written.
async function awaitAsyncDraw(c: Capturing, climb: Climb): Promise<boolean> {
  climb.ladder.push("async");
  for (let tick = 0; tick < ASYNC_TICKS; tick++) {
    await new Promise((resolve) => c.later(resolve, ASYNC_TICK_MS));
    if (drawnSoFar(c) > climb.before) return true;
  }
  return false;
}

/**
 * Whether the frame drew, once the page's own frame showed nothing: climbs the ladder until it
 * does — an asynchronous WebGPU frame, the game's own capture (whose picture is the answer when
 * it takes one), the debug camera, and, only when allowed, one resumed frame.
 */
async function climbLadder(c: Capturing, climb: Climb): Promise<boolean | string> {
  const grew = () => drawnSoFar(c) > climb.before;
  if (climb.kind === "webgpu" && (await awaitAsyncDraw(c, climb))) return true;
  climb.ladder.push("game");
  const own = await Promise.resolve(guarded(() => c.deps.gameCapture?.(), null)).catch(() => null);
  if (isImage(own)) return own;
  if (grew()) return true;
  climb.ladder.push("camera");
  guarded(() => c.deps.debugCamera?.(guarded(() => c.deps.currentCamera?.(), null) ?? "default"), null);
  if (grew()) return true;
  if (!climb.allowResume) return false;
  climb.ladder.push("resume");
  guarded(() => c.deps.start?.(), null);
  guarded(() => c.deps.pumpFrame?.(16), false);
  guarded(() => c.deps.pause?.(), null);
  return grew();
}

// A WebGPU canvas is not a usable `drawImage` source in Chromium: its texture goes to the
// compositor, so the copy lands empty and the composite comes back as bare page background
// (the WebGPU fixture photographed black while the window showed a lit field). Its own
// `toDataURL` does return the frame — so the frame is read directly, and composited only if
// the context was configured transparent. It usually is: `alphaMode: "premultiplied"` is
// what three's own WebGPU renderer configures unless the game asked for an opaque canvas,
// and a PNG encodes those transparent pixels as black, which is the black frame this whole
// file exists to prevent. The read is decoded and painted over the page's background; a
// page that cannot decode declines, and the compositor takes that frame instead.
/** The WebGPU frame read directly; undefined when the canvas gives no picture that way. */
async function readWebGpuFrame(
  c: Capturing,
  picked: Picked,
  colour: string,
  drawCalls: () => number,
  shot: Shot,
): Promise<string | null | undefined> {
  const direct = guarded(() => picked.canvas.toDataURL("image/png"), null);
  if (!isImage(direct)) return undefined;
  const alphaMode = picked.descriptor?.alphaMode ?? null;
  if (alphaMode === null || alphaMode === "opaque") {
    shot({ reason: null, composited: false, drawCalls: drawCalls(), background: colour });
    return direct;
  }
  const decoded = await decodeImage(c, direct);
  const { width, height } = pixelSize(picked.canvas);
  const painted = decoded ? composite(c, decoded, colour, width, height) : null;
  if (painted) {
    shot({ reason: null, composited: true, drawCalls: drawCalls(), background: colour });
    return painted;
  }
  shot({ reason: TRANSPARENT_WEBGPU, composited: false, drawCalls: drawCalls(), background: colour });
  return null;
}

/** The drawn frame, over the page's own background. */
async function readFrame(c: Capturing, picked: Picked, kind: Foreign, before: number, shot: Shot) {
  const drawCalls = () => drawnSoFar(c) - before;
  const paint = background(c, picked.canvas);
  if (!paint.ok) {
    shot({ reason: paint.reason, composited: false, drawCalls: drawCalls(), background: null });
    return null;
  }
  const colour = paint.colour as string;
  if (kind === "webgpu") {
    const read = await readWebGpuFrame(c, picked, colour, drawCalls, shot);
    if (read !== undefined) return read;
  }
  const { width, height } = pixelSize(picked.canvas);
  const url = composite(c, picked.canvas, colour, width, height);
  if (!url) {
    shot({
      reason: "the frame could not be composited onto a scratch canvas",
      composited: false,
      drawCalls: drawCalls(),
      background: colour,
    });
    return null;
  }
  shot({ reason: null, composited: true, drawCalls: drawCalls(), background: colour });
  return url;
}

async function photograph(c: Capturing, options: Foreign) {
  const climb: Climb = { ladder: [], before: 0, kind: null, allowResume: options.allowResume === true };
  const { descriptors } = surfaces(c);
  const picked = pick(c);
  const kind = picked.descriptor?.kind ?? null;
  climb.kind = kind;
  const shot: Shot = (patch) =>
    record(c, {
      source: "page",
      picked: pickedSummary(picked, kind),
      canvases: descriptors,
      backend: THREE_KINDS.has(kind) ? kind : null,
      kind,
      ladder: climb.ladder,
      ...patch,
    });
  if (!picked.canvas) {
    shot({ reason: NO_CANVAS, composited: false, drawCalls: null, background: null });
    return null;
  }
  climb.before = drawnSoFar(c);
  // Only the page's own frame is awaited; a drawn frame is then read in that same turn, before
  // its drawing buffer can be cleared.
  if (guarded(() => c.deps.frozen?.(), false)) pumpOne(c, climb.ladder, "pump");
  else if (await nextFrame(c)) climb.ladder.push("frame");
  else pumpOne(c, climb.ladder, "timeout");
  const drewAlready = !countersLive(c) || drawnSoFar(c) > climb.before;
  const drawn = drewAlready || (await climbLadder(c, climb));
  if (typeof drawn === "string") {
    shot({ reason: null, composited: false, drawCalls: drawnSoFar(c) - climb.before, background: null });
    return drawn;
  }
  if (!drawn) {
    shot({ reason: NOTHING_DREW, composited: false, drawCalls: 0, background: null });
    return null;
  }
  return readFrame(c, picked, kind, climb.before, shot);
}

/** What the last capture did, and what it had to work with. Plain data, JSON-able. */
function captureInfo(c: Capturing): CaptureInfo {
  return {
    ...c.info,
    canvases: c.info.canvases.map((descriptor: Foreign) => ({ ...descriptor })),
    ladder: [...c.info.ladder],
  };
}

/**
 * `createFrameCapture(deps)` — `{ capture(options), captureInfo(), note(patch), paint(dataUrl), pick() }`.
 *
 * `deps` is everything this needs from the page: `canvases()` (the shim's one `getContext`
 * record), `rendererCanvas()` (what the hook saw the world drawn on), `afterFrame(fn)`,
 * `pumpFrame(dt)`, `draws()`, `frozen()`, `start()`, `pause()`, `gameCapture()`,
 * `debugCamera(name)`, `currentCamera()`, `computedStyle(el)`, `parentOf(el)`,
 * `createCanvas()`, `decode(dataUrl)`, `setTimeout`/`clearTimeout` and `raceMs`.
 */
export function createFrameCapture(deps: CaptureDeps = {}) {
  const c: Capturing = {
    deps,
    raceMs: Number.isFinite(Number(deps.raceMs)) ? Number(deps.raceMs) : CAPTURE_RACE_MS,
    later:
      typeof deps.setTimeout === "function"
        ? deps.setTimeout
        : (fn: Foreign, ms: number) => globalThis.setTimeout(fn, ms),
    cancel: typeof deps.clearTimeout === "function" ? deps.clearTimeout : (id: Foreign) => globalThis.clearTimeout(id),
    busy: false,
    info: {
      source: "page",
      reason: "nothing has been photographed yet",
      picked: null,
      canvases: [],
      background: null,
      composited: false,
      drawCalls: null,
      ladder: [],
      backend: null,
      kind: null,
      /** How many pictures this object has recorded. A caller reads it either side of a capture
       * to learn whether the record it is holding describes the frame it just asked for, or a
       * frame somebody else took — a game with its own `capture()` never comes through here. */
      count: 0,
    },
  };
  return {
    capture: (options = {}) => capture(c, options),
    captureInfo: () => captureInfo(c),
    note: (patch: Foreign) => note(c, patch),
    paint: (dataUrl: Foreign, patch: Record<string, Foreign> = {}) => paint(c, dataUrl, patch),
    pick: () => pick(c),
  };
}
