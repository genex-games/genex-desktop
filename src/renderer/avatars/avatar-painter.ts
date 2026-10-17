/**
 * Paints every generated avatar on screen from one clock: at most 25 frames a second and at most
 * 28 avatars a frame, round-robin, so a page of a hundred stays smooth. An avatar is three stacked
 * canvases: gear behind (2D), the body (WebGPU, or a 2D still where the GPU cannot draw), and the
 * shell marks, eyes and front gear (2D). Avatars in lists paint once and hold still; one that is
 * hovered or set live runs on its own clock, which only moves while it moves. Out of sight, or
 * under Reduce Motion, nothing moves.
 */
import type { AvatarRecipe } from "../../shared/avatar-recipe.ts";
import { SECOND_MS } from "../../shared/duration.ts";
import { Motion } from "../motion-rest.ts";
import { REDUCED_MOTION_QUERY } from "../ui/media-queries.ts";
import {
  type BodyDraw,
  type BodyGpu,
  bodyGpu,
  drawBodies,
  type GpuBodyCanvas,
  gpuBodyCanvas,
  onBodyGpuLost,
  releaseBodyCanvas,
} from "./body-gpu.ts";
import { BRIGHT_STARS, type StarLook } from "./body-shader.ts";
import { drawStillBody } from "./body-still.ts";
import { type AvatarFrame, type Ctx2D, openness } from "./draw-kit.ts";
import { drawEyes } from "./eyes.ts";
import { drawBackGear, drawFrontGear, drawSkinGear } from "./gear.ts";

/** A frame at most this often: 25 a second. */
const FRAME_MS = 40;
/** How long the first frame waits for the GPU before it draws bodies in 2D. */
const GPU_ANSWER_MS = 1.5 * SECOND_MS;
/** The most avatars painted in one frame. */
export const PAINT_BUDGET = 28;
/** The moment a still avatar shows, in seconds; nudged on if its eyes would be mid-blink. */
const STILL_TIME = 3;
const STILL_NUDGE = 0.2;
/** A frame's clock step at most, so a stall does not jump an avatar ahead. */
const MAX_STEP_SECONDS = 0.2;
/** Pixels per point at most, and the largest body drawn. */
const MAX_DENSITY = 2;
const MAX_BODY_PIXELS = 384;
/** Where the body sits in a box with room for gear: 80% wide, a little low, so horns fit above. */
const GEAR_BODY_SHARE = 0.4;
const GEAR_BODY_DROP = 0.55;
/** How strongly eyes show: in full, on a placeholder, and on a quiet face (there when you look for them). */
const EYE_ALPHA = { Full: 1, Ghost: 0.5, Quiet: 0.22 } as const;
/** A quiet galaxy's stars: dim, in the palette's blue. */
const QUIET_STARS: StarLook = { strength: 0.4, tint: 1 };

/** What an avatar draws. */
export interface AvatarLook {
  recipe: AvatarRecipe;
  /** CSS pixels a side. */
  size: number;
  /** Small mode: the body fills the box and gear is left out (shell marks stay). */
  full: boolean;
  /** A placeholder: its eyes drawn at half strength. */
  ghost: boolean;
  /**
   * A face that stays in the background: eyes in their own colour but nearly see-through, and a
   * galaxy's stars dimmed to its blue. It is there when you look for it.
   */
  quiet: boolean;
  /**
   * Drawn the way genex.games' link previews draw it, with the body as a 2D still and never on the
   * GPU: a preview of that picture must show the same face.
   */
  flat: boolean;
}

/** The three canvases an avatar is, stacked in its box. */
export interface AvatarLayers {
  back: HTMLCanvasElement | null;
  body: HTMLCanvasElement;
  front: HTMLCanvasElement;
}

/** An avatar on the painter. */
export interface AvatarHandle {
  /** Draw something else (or the same at another size). */
  set(look: AvatarLook): void;
  /** Run its clock (hovered, or live) or hold it. */
  animate(on: boolean): void;
  dispose(): void;
}

/** Where the body sits in a box `pixels` wide, in canvas pixels. */
export function avatarGeometry(pixels: number, full: boolean): { cx: number; cy: number; rad: number } {
  if (full) return { cx: pixels / 2, cy: pixels / 2, rad: pixels / 2 };
  return { cx: pixels / 2, cy: pixels * GEAR_BODY_DROP, rad: pixels * GEAR_BODY_SHARE };
}

/** The moment an avatar holds still at: its eyes open. */
export const stillTime = (recipe: AvatarRecipe): number =>
  openness(recipe, STILL_TIME) < 1 ? STILL_TIME + STILL_NUDGE : STILL_TIME;

/** Up to `budget` of `due`, starting at `cursor` and wrapping: who paints this frame. */
export function roundRobin<T>(due: readonly T[], cursor: number, budget: number): T[] {
  if (due.length <= budget) return [...due];
  return Array.from({ length: budget }, (_, i) => due[(cursor + i) % due.length] as T);
}

type BodySurface = { gpu: GpuBodyCanvas } | { ctx: Ctx2D } | null;

interface Entry {
  layers: AvatarLayers;
  look: AvatarLook;
  /** The avatar's own clock, in seconds. */
  t: number;
  animating: boolean;
  visible: boolean;
  /** It shows something other than its look at its clock. */
  dirty: boolean;
  body: BodySurface;
}

const entries = new Set<Entry>();
const byElement = new Map<Element, Entry>();
let frame = 0;
let lastFrame = 0;
let cursor = 0;
/** The body pipeline: undefined until asked, then the GPU or null for 2D. */
let gpu: BodyGpu | null | undefined;
let asking = false;
let observer: IntersectionObserver | null = null;
let reduced = typeof matchMedia === "function" && matchMedia(REDUCED_MOTION_QUERY).matches;

/** Ask for the GPU once; the frame waits for the answer, or draws bodies in 2D if it never comes. */
function askGpu(): void {
  if (asking) return;
  asking = true;
  const late = setTimeout(() => {
    if (gpu !== undefined) return;
    gpu = null;
    wake();
  }, GPU_ANSWER_MS);
  void bodyGpu()
    .catch(() => null)
    .then((answer) => {
      clearTimeout(late);
      // An answer after the wait gave up stays unused until the GPU is asked again (a lost device).
      if (gpu === undefined) gpu = answer;
      asking = false;
      wake();
    });
}

/** Whether the app's motion rests: the window idle or out of sight (`motion-rest.ts`). */
const resting = (): boolean => document.documentElement.dataset.motion === Motion.Rest;

/** Whether an avatar's clock runs: it animates on screen, nothing modal covers it, and motion is neither reduced nor resting. */
function moves(entry: Entry): boolean {
  return entry.animating && entry.visible && !reduced && !resting() && !entry.layers.front.closest("[inert]");
}

/** Whether an avatar paints this frame: on screen, and waiting to be drawn or moving. */
const isDue = (entry: Entry): boolean => entry.visible && (entry.dirty || moves(entry));

onBodyGpuLost(() => {
  gpu = undefined;
  for (const entry of entries)
    if (entry.body && "gpu" in entry.body) {
      entry.body = null;
      entry.dirty = true;
    }
  wake();
});

/** The surface an entry's body draws on, made the first time it paints. */
function bodySurface(entry: Entry, context: BodyGpu | null): BodySurface {
  if (entry.body) return entry.body;
  const made = context && !entry.look.flat ? gpuBodyCanvas(context, entry.layers.body) : null;
  if (made) entry.body = { gpu: made };
  else {
    const ctx = entry.layers.body.getContext("2d");
    entry.body = ctx ? { ctx } : null;
  }
  return entry.body;
}

/** A canvas `pixels` wide and tall, placed at `left`, `top` in its box, `css` CSS pixels a side. */
function fit(canvas: HTMLCanvasElement, pixels: number, css: number, at: { left: number; top: number }): void {
  if (canvas.width !== pixels) canvas.width = pixels;
  if (canvas.height !== pixels) canvas.height = pixels;
  canvas.style.width = `${css}px`;
  canvas.style.height = `${css}px`;
  canvas.style.left = `${at.left}px`;
  canvas.style.top = `${at.top}px`;
}

/** How strongly a look's eyes show. */
function eyeAlpha(look: AvatarLook): number {
  if (look.quiet) return EYE_ALPHA.Quiet;
  return look.ghost ? EYE_ALPHA.Ghost : EYE_ALPHA.Full;
}

/** Paint one avatar's 2D layers and queue its body; returns the body to draw on the GPU, if any. */
function paint(entry: Entry, context: BodyGpu | null): BodyDraw | null {
  const { look, layers, t } = entry;
  const density = Math.min(MAX_DENSITY, Math.max(1, globalThis.devicePixelRatio || 1));
  const pixels = Math.max(8, Math.round(look.size * density));
  const { cx, cy, rad } = avatarGeometry(pixels, look.full);
  const bodyPixels = Math.min(MAX_BODY_PIXELS, Math.max(8, Math.round(rad * 2)));
  fit(layers.front, pixels, look.size, { left: 0, top: 0 });
  if (layers.back) fit(layers.back, pixels, look.size, { left: 0, top: 0 });
  fit(layers.body, bodyPixels, (rad * 2) / density, { left: (cx - rad) / density, top: (cy - rad) / density });
  const back = layers.back?.getContext("2d");
  if (back) {
    back.clearRect(0, 0, pixels, pixels);
    if (!look.full) drawBackGear({ ctx: back, recipe: look.recipe, cx, cy, rad, t });
  }
  const front = layers.front.getContext("2d");
  if (front) {
    const drawn: AvatarFrame = { ctx: front, recipe: look.recipe, cx, cy, rad, t };
    front.clearRect(0, 0, pixels, pixels);
    drawSkinGear(drawn);
    front.globalAlpha = eyeAlpha(look);
    drawEyes(drawn);
    front.globalAlpha = 1;
    if (!look.full) drawFrontGear(drawn);
  }
  const surface = bodySurface(entry, context);
  entry.dirty = false;
  if (!surface) return null;
  if ("ctx" in surface) {
    drawStillBody(surface.ctx, look.recipe, bodyPixels);
    return null;
  }
  return {
    canvas: surface.gpu,
    recipe: look.recipe,
    t,
    pixels: bodyPixels,
    stars: look.quiet ? QUIET_STARS : BRIGHT_STARS,
  };
}

/** One frame: move the clocks of avatars that run, then paint this frame's share. */
function tick(now: number): void {
  frame = 0;
  const due = [...entries].filter(isDue);
  if (!due.length) {
    lastFrame = 0;
    return;
  }
  frame = requestAnimationFrame(tick);
  if (gpu === undefined) {
    askGpu();
    return;
  }
  if (lastFrame && now - lastFrame < FRAME_MS) return;
  const step = lastFrame ? Math.min(MAX_STEP_SECONDS, (now - lastFrame) / 1000) : 0;
  lastFrame = now;
  for (const entry of entries) if (moves(entry)) entry.t += step;
  const painted = roundRobin(due, cursor, PAINT_BUDGET);
  cursor = (cursor + painted.length) % Math.max(1, due.length);
  const context = gpu;
  const bodies = painted.map((entry) => paint(entry, context)).filter((draw): draw is BodyDraw => draw !== null);
  if (context && bodies.length) drawBodies(context, bodies);
}

/** Start the clock if it sleeps. */
function wake(): void {
  if (!frame && typeof requestAnimationFrame === "function") frame = requestAnimationFrame(tick);
}

/**
 * The observer that tells the painter which avatars are on screen; the first time, the painter also
 * starts watching the app's motion and modal covers, so a moving avatar stops and starts with them.
 */
function visibility(): IntersectionObserver {
  if (observer) return observer;
  observer = new IntersectionObserver((seen) => {
    for (const { target, isIntersecting } of seen) {
      const entry = byElement.get(target);
      if (entry) entry.visible = isIntersecting;
    }
    wake();
  });
  new MutationObserver(wake).observe(document.documentElement, { attributes: true, attributeFilter: ["data-motion"] });
  new MutationObserver(wake).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["inert"] });
  return observer;
}

if (typeof matchMedia === "function")
  matchMedia(REDUCED_MOTION_QUERY).addEventListener("change", (event) => {
    reduced = event.matches;
    wake();
  });

/** Put an avatar on the painter: it paints when it comes into view. */
export function mountAvatar(layers: AvatarLayers, look: AvatarLook): AvatarHandle {
  const entry: Entry = {
    layers,
    look,
    t: stillTime(look.recipe),
    animating: false,
    visible: false,
    dirty: true,
    body: null,
  };
  entries.add(entry);
  byElement.set(layers.front, entry);
  visibility().observe(layers.front);
  return {
    set(next) {
      if (next.recipe !== entry.look.recipe) entry.t = stillTime(next.recipe);
      entry.look = next;
      entry.dirty = true;
      wake();
    },
    animate(on) {
      if (entry.animating === on) return;
      entry.animating = on;
      // Stopped, it goes back to its still pose: never held mid-blink.
      if (!on) {
        entry.t = stillTime(entry.look.recipe);
        entry.dirty = true;
      }
      wake();
    },
    dispose() {
      entries.delete(entry);
      byElement.delete(layers.front);
      observer?.unobserve(layers.front);
      if (entry.body && "gpu" in entry.body) releaseBodyCanvas(entry.body.gpu);
    },
  };
}
