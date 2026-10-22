/**
 * One canvas drawing a live background on the shared GPU through the pipeline (`pipeline.ts`):
 * the shader, its glow, and an effect (lines, dots, characters) over it when one is chosen. It
 * moves while asked to, at most at its frame rate, on one clock whatever changes meanwhile
 * (`stage-clock.ts`), and otherwise draws one still frame for each change (a shader that keeps
 * trails runs up to that moment first, once changes pause); a window that cannot keep up draws
 * fewer pixels rather than fewer frames, and a canvas out of sight draws nothing: off screen, or
 * covered by a page over its own (Play over home), which an observer cannot see. A lost device is
 * started again once.
 */
import type { Effect, Surface, Texture } from "vgpu";
import { readsHistory, readsPicture } from "../../shared/backdrop-shader.ts";
import { ditherUniform } from "./dither.ts";
import { rgbaOf } from "./css-color.ts";
import { lumaOf, type Rgba, readableColor } from "./readable-color.ts";
import {
  type BackdropGpu,
  backdropGpu,
  compiledEffect,
  type GlyphSheet,
  glyphAtlas,
  glyphSheet,
  onGpuLost,
  pictureTexture,
} from "./gpu.ts";
import {
  changeStage,
  frameStep,
  recolourDue,
  STILL_SETTLE_MS,
  type StageClock,
  StillDraw,
  stageClock,
  stillSettled,
  stopClock,
} from "./stage-clock.ts";
import {
  createPipeline,
  disposePipeline,
  drawPipeline,
  type Pipeline,
  type PipelineFrame,
  prepareDither,
  presentAgain,
  resizePipeline,
  setShader,
} from "./pipeline.ts";
import { BackdropEffect, type BackdropSettings } from "./settings.ts";

/** Where a stage is: getting ready, drawing, without WebGPU, or holding a shader that failed. */
export const StageState = {
  Loading: "loading",
  Drawing: "drawing",
  NoGpu: "no-gpu",
  Failed: "failed",
} as const;
export type StageState = (typeof StageState)[keyof typeof StageState];

/** What the shader's pointer follows: the pointer anywhere in the window, over the canvas's box, or nothing. */
export const PointerSource = {
  Window: "window",
  Canvas: "canvas",
  None: "none",
} as const;
export type PointerSource = (typeof PointerSource)[keyof typeof PointerSource];

/** What a stage draws: the body, its colours as CSS colours, its settings and the picture. */
export interface StageInputs {
  body: string;
  ink: string;
  accent: string;
  page: string;
  speed: number;
  scale: number;
  glow: number;
  picture: string;
  moving: boolean;
  /** The effect drawn over the shader, and the monospace face ASCII is set in; null draws it as it is. */
  effect: { settings: BackdropSettings; font: string } | null;
}

/** How a stage draws, fixed for its life. */
export interface StageOptions {
  /** Pixels per point at most. */
  maxDensity: number;
  fps: number;
  pointer: PointerSource;
  /** The time a still stage shows, in seconds: a moment that shows the shader well. */
  stillTime: number;
  onState(state: StageState): void;
}

/** A canvas drawing a shader. */
export interface ShaderStage {
  update(inputs: StageInputs): void;
  /** A page lies over the canvas's own, or has gone: covered, it draws nothing. */
  cover(covered: boolean): void;
  dispose(): void;
}

/** A frame this many times its budget counts as slow. */
const SLOW_FRAME = 1.6;
/** When this share of a window of frames is slow, the stage draws fewer pixels. */
const SLOW_SHARE = 0.5;
/** Frames judged together. */
const QUALITY_WINDOW = 90;
/** Each step down keeps this share of the pixels per point, down to the least. */
const DENSITY_STEP = 0.75;
const MIN_DENSITY = 0.5;
/** How quickly the shader's pointer follows the real one, per second. */
const POINTER_EASE = 5;
/** Under an effect the shader draws this many pixels per point: the marks are coarser than that. */
const SCENE_DENSITY = 0.5;
/** A still frame of a shader that keeps trails is run up to over this many frames this far apart. */
const RUN_UP_FRAMES = 90;
const RUN_UP_STEP_SECONDS = 1 / 30;
/** The glyph measure until a sheet is set: a monospace face's usual advance, and one glyph. */
const NO_GLYPHS = { advance: 0.6, count: 1 };
/** A device lost more often than this is not started again. */
const RESTARTS = 1;

/** Everything one stage holds between frames. */
interface Stage {
  canvas: HTMLCanvasElement;
  options: StageOptions;
  disposed: boolean;
  context: BackdropGpu | null;
  surface: Surface | null;
  pipeline: Pipeline | null;
  shader: Effect | null;
  inputs: StageInputs | null;
  /** The body compiled or being compiled. */
  body: string;
  pictureId: string | null;
  picture: { texture: Texture; aspect: number } | null;
  /** Whether the picture the body reads is still on its way: the canvas shows itself once it is there. */
  pictureLoading: boolean;
  atlas: Texture | null;
  density: number;
  /** The canvas's size in points, as its last resize left it: never measured in a frame. */
  size: [number, number];
  /** Whether any of the canvas is on screen, as its observer says. */
  onScreen: boolean;
  /** Whether a page lies over the canvas's own: hidden there, it is still on screen to an observer. */
  covered: boolean;
  /** Whether the canvas can be seen: on screen and not covered. One out of sight draws nothing. */
  visible: boolean;
  clock: StageClock;
  time: number;
  /** The animation frame asked for, and the wait before a still canvas runs up. */
  frame: number;
  settle: ReturnType<typeof setTimeout> | undefined;
  restarts: number;
  drawn: boolean;
  pointer: { x: number; y: number; toX: number; toY: number };
  pace: { frames: number; slow: number };
  /** The ASCII effect's glyphs, and the font and ramp they were set for. */
  glyphs: GlyphSheet | null;
  glyphKey: string;
  /** What the still frame on the canvas was drawn from (`stillKey`). */
  stillKey: string;
}

const isDark = (color: Rgba): boolean => lumaOf(color) < 0.5;

/** The canvas's size in points. */
function points(stage: Stage): [number, number] {
  return stage.size;
}

/** The canvas's size in pixels at `density` pixels per point. */
function pixels(stage: Stage, density = stage.density): [number, number] {
  const [width, height] = points(stage);
  return [Math.max(1, Math.round(width * density)), Math.max(1, Math.round(height * density))];
}

/** The pipeline's frames in pixels: coarser under an effect, whose marks are coarser still. */
function frameSize(stage: Stage): [number, number] {
  return pixels(stage, stage.inputs?.effect ? SCENE_DENSITY : stage.density);
}

/** What the pipeline draws this frame with, `delta` seconds after the last. */
function frameInputs(stage: Stage, delta: number): PipelineFrame {
  const { inputs } = stage;
  const page = rgbaOf(inputs?.page ?? "#000000");
  const dark = isDark(page);
  const over = inputs?.effect;
  return {
    backdrop: {
      ink: readableColor(rgbaOf(inputs?.ink ?? "#ffffff"), dark),
      accent: readableColor(rgbaOf(inputs?.accent ?? "#ffffff"), dark),
      page,
      pointer: [stage.pointer.x, stage.pointer.y],
      time: stage.time,
      scale: inputs?.scale ?? 1,
      dark: dark ? 1 : 0,
      pictureAspect: stage.picture?.aspect ?? 1,
      delta: delta * (inputs?.speed ?? 1),
      density: inputs?.effect ? SCENE_DENSITY : stage.density,
    },
    page,
    dark,
    glow: inputs?.glow ?? 0,
    dither: over
      ? ditherUniform(over.settings, {
          points: points(stage),
          density: stage.density,
          page,
          inkIsLight: dark,
          glyphs: stage.glyphs?.measure ?? NO_GLYPHS,
        })
      : null,
  };
}

function draw(stage: Stage, delta: number): void {
  const { pipeline, surface } = stage;
  if (!pipeline?.shader || !surface || stage.disposed) return;
  drawPipeline(pipeline, surface, frameInputs(stage, delta));
  if (stage.drawn || stage.pictureLoading) return;
  stage.drawn = true;
  stage.options.onState(StageState.Drawing);
}

/** What a still frame's shader pass depends on: while it holds, a still canvas only presents again. */
function stillKey(stage: Stage): string {
  const { inputs } = stage;
  if (!inputs) return "";
  const [width, height] = stage.pipeline?.frames[0].size ?? [0, 0];
  const bound = `${stage.pictureId}:${stage.picture !== null}:${stage.atlas !== null}`;
  return [
    inputs.body,
    inputs.ink,
    inputs.accent,
    inputs.page,
    inputs.scale,
    inputs.speed,
    bound,
    width,
    height,
    stage.time,
  ].join("|");
}

/**
 * A still frame; a shader that keeps trails first runs up to it from nothing, so the trails are
 * there and the frame is the same each time. In a stream of changes it draws one frame on what it
 * holds instead, and runs up once they pause. When only the glow or the effect changed, the frame
 * already drawn is presented again.
 */
function drawStill(stage: Stage, how: StillDraw): void {
  const { pipeline, surface } = stage;
  const key = stillKey(stage);
  if (pipeline && surface && key === stage.stillKey && presentAgain(pipeline, surface, frameInputs(stage, 0))) return;
  if (how === StillDraw.Quick) {
    stage.stillKey = "";
    draw(stage, 0);
    return;
  }
  stage.stillKey = key;
  if (pipeline?.history && stage.inputs && stage.inputs.speed > 0) {
    const moment = stage.time;
    pipeline.fresh = true;
    for (let back = RUN_UP_FRAMES; back > 0; back--) {
      stage.time = moment - back * RUN_UP_STEP_SECONDS;
      drawPipeline(pipeline, null, frameInputs(stage, RUN_UP_STEP_SECONDS));
    }
    stage.time = moment;
  }
  draw(stage, RUN_UP_STEP_SECONDS);
}

/** Fewer pixels per point when most recent frames ran late; never fewer than the least. */
function keepPace(stage: Stage, seconds: number): void {
  const { pace } = stage;
  pace.frames++;
  if (seconds > SLOW_FRAME / stage.options.fps) pace.slow++;
  if (pace.frames < QUALITY_WINDOW) return;
  const behind = pace.slow / pace.frames > SLOW_SHARE;
  pace.frames = 0;
  pace.slow = 0;
  if (!behind || stage.density <= MIN_DENSITY) return;
  stage.density = Math.max(MIN_DENSITY, stage.density * DENSITY_STEP);
  resize(stage);
}

/** Size the canvas and the pipeline's frames to the box. */
function resize(stage: Stage): void {
  stage.surface?.resize(pixels(stage));
  if (stage.pipeline) resizePipeline(stage.pipeline, frameSize(stage));
}

function tick(stage: Stage, now: number): void {
  stage.frame = requestAnimationFrame((next) => tick(stage, next));
  const step = frameStep(stage.clock, now);
  if (step === null) return;
  stage.time += step * (stage.inputs?.speed ?? 1);
  const ease = 1 - Math.exp(-POINTER_EASE * step);
  const { pointer } = stage;
  pointer.x += (pointer.toX - pointer.x) * ease;
  pointer.y += (pointer.toY - pointer.y) * ease;
  if (step) keepPace(stage, step);
  if (stage.pipeline && recolourDue(stage.clock, now)) stage.pipeline.fresh = true;
  draw(stage, step);
}

/** Stop asking for frames, and for the run-up a still canvas was waiting to draw. */
function cancel(stage: Stage): void {
  cancelAnimationFrame(stage.frame);
  clearTimeout(stage.settle);
}

/** A still canvas whose changes paused runs up to its moment. */
function settle(stage: Stage): void {
  if (stage.disposed || stage.inputs?.moving || !stillSettled(stage.clock, performance.now())) return;
  stage.frame = requestAnimationFrame(() => drawStill(stage, StillDraw.RunUp));
}

/**
 * Draw what changed: a moving canvas's next frame draws it on the same clock (the loop started if
 * it was not running); a still canvas draws the one frame this change needs. New colours let the
 * frame kept in the old ones go: once they hold, while moving; at once when out of sight.
 */
function play(stage: Stage, recoloured = false): void {
  if (!stage.inputs || stage.disposed) return;
  if (!stage.visible) {
    if (recoloured && stage.pipeline) stage.pipeline.fresh = true;
    return;
  }
  const { start, still } = changeStage(stage.clock, {
    moving: stage.inputs.moving,
    recoloured,
    now: performance.now(),
  });
  if (start) {
    cancel(stage);
    stage.frame = requestAnimationFrame((now) => tick(stage, now));
    return;
  }
  if (!still) return;
  cancel(stage);
  stage.frame = requestAnimationFrame(() => drawStill(stage, still));
  if (still === StillDraw.Quick) stage.settle = setTimeout(() => settle(stage), STILL_SETTLE_MS);
}

/** Give the shader what it samples: the picture (or nothing), and the glyph sheet. */
function bindInputs(stage: Stage): void {
  if (!stage.shader || !stage.context) return;
  const { blank, sampler } = stage.context;
  stage.shader.set({
    picture: stage.picture?.texture ?? blank,
    pictureSampler: sampler,
    glyphs: stage.atlas ?? blank,
  });
}

/** Bind the chosen picture when the body reads it, uploading it first. */
function showPicture(stage: Stage, next: StageInputs): void {
  const wanted = readsPicture(next.body) ? next.picture : null;
  const { context } = stage;
  if (!context || wanted === stage.pictureId) return;
  stage.pictureId = wanted;
  stage.pictureLoading = wanted !== null;
  if (!wanted) {
    stage.picture = null;
    bindInputs(stage);
    return;
  }
  void pictureTexture(context, wanted).then((loaded) => {
    if (stage.disposed || stage.pictureId !== wanted) return;
    stage.picture = loaded;
    stage.pictureLoading = false;
    if (stage.pipeline) stage.pipeline.fresh = true;
    bindInputs(stage);
    play(stage);
  });
}

function compile(stage: Stage, body: string): void {
  const { context } = stage;
  if (!context) return;
  if (!stage.shader) stage.options.onState(StageState.Loading);
  void compiledEffect(context, body).then(
    (compiled) => {
      if (stage.disposed || body !== stage.body) return;
      stage.shader = compiled;
      stage.pipeline ??= createPipeline(context, frameSize(stage));
      setShader(stage.pipeline, compiled, readsHistory(body));
      bindInputs(stage);
      // An effect chosen before the first shader was ready finds its pass now.
      if (stage.inputs) fitPipeline(stage, context, stage.inputs);
      play(stage);
    },
    () => {
      if (!stage.disposed && body === stage.body) stage.options.onState(StageState.Failed);
    },
  );
}

/** Set the ramp's glyphs for ASCII; a sheet arriving after the ramp changed again is let go. */
function showGlyphs(stage: Stage, context: BackdropGpu, effect: { settings: BackdropSettings; font: string }) {
  if (effect.settings.effect !== BackdropEffect.Ascii) return;
  const key = `${effect.font}\n${effect.settings.asciiCharacters}`;
  if (key === stage.glyphKey) return;
  stage.glyphKey = key;
  void glyphSheet(context, effect.settings.asciiCharacters, effect.font).then((sheet) => {
    if (stage.disposed || stage.glyphKey !== key || !sheet) return;
    stage.glyphs = sheet;
    stage.pipeline?.dither?.set({ glyphs: sheet.texture });
    play(stage);
  });
}

/** Size the pipeline's frames for the inputs, and give an effect its pass and glyphs. */
function fitPipeline(stage: Stage, context: BackdropGpu, next: StageInputs): void {
  if (!stage.pipeline) return;
  resizePipeline(stage.pipeline, frameSize(stage));
  if (!next.effect) return;
  const dither = prepareDither(stage.pipeline);
  if (stage.glyphs) dither.set({ glyphs: stage.glyphs.texture });
  showGlyphs(stage, context, next.effect);
}

function apply(stage: Stage, next: StageInputs, recoloured = false): void {
  const { context } = stage;
  if (!context || !stage.surface) return;
  if (next.body !== stage.body) {
    stage.body = next.body;
    compile(stage, next.body);
  }
  showPicture(stage, next);
  fitPipeline(stage, context, next);
  play(stage, recoloured);
}

async function boot(stage: Stage): Promise<void> {
  const context = await backdropGpu();
  stage.context = context;
  if (stage.disposed) return;
  if (!context) {
    stage.options.onState(StageState.NoGpu);
    return;
  }
  stage.surface = context.vgpu.surface(context.gpu, stage.canvas, {
    autoResize: false,
    size: pixels(stage),
    alphaMode: "opaque",
  });
  void glyphAtlas(context).then((atlas) => {
    if (stage.disposed || stage.context !== context || !atlas) return;
    stage.atlas = atlas;
    bindInputs(stage);
    play(stage);
  });
  if (stage.inputs) apply(stage, stage.inputs);
}

/** Let the canvas's surface and frames go; either may have gone with its device already. */
function releaseSurface(stage: Stage): void {
  for (const release of [() => stage.surface?.dispose(), () => stage.pipeline && disposePipeline(stage.pipeline)]) {
    try {
      release();
    } catch {
      // Gone with its device.
    }
  }
  stage.surface = null;
}

/** After the device is lost: forget what it held, and start again once. */
function restart(stage: Stage): void {
  cancel(stage);
  stopClock(stage.clock);
  releaseSurface(stage);
  Object.assign(stage, {
    context: null,
    pipeline: null,
    shader: null,
    body: "",
    pictureId: null,
    picture: null,
    pictureLoading: false,
    atlas: null,
    drawn: false,
    glyphs: null,
    glyphKey: "",
    stillKey: "",
  });
  if (stage.disposed) return;
  stage.restarts++;
  if (stage.restarts > RESTARTS) {
    stage.options.onState(StageState.Failed);
    return;
  }
  void boot(stage);
}

/** Where the stage hears the pointer, and how it follows it; returns the unsubscribe. */
function followPointer(stage: Stage): () => void {
  const { pointer, options, canvas } = stage;
  const host: EventTarget | null = options.pointer === PointerSource.Window ? window : canvas.parentElement;
  if (options.pointer === PointerSource.None || !host) return () => {};
  const follow = (event: Event): void => {
    const box = canvas.getBoundingClientRect();
    if (!(event instanceof PointerEvent) || box.width < 1 || box.height < 1) return;
    pointer.toX = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
    pointer.toY = Math.min(1, Math.max(0, (event.clientY - box.top) / box.height));
  };
  const centre = (): void => {
    pointer.toX = 0.5;
    pointer.toY = 0.5;
  };
  host.addEventListener("pointermove", follow);
  host.addEventListener("pointerleave", centre);
  return () => {
    host.removeEventListener("pointermove", follow);
    host.removeEventListener("pointerleave", centre);
  };
}

/** Whether the colours changed (a theme switch, a picked colour): a frame kept in the old ones is let go. */
function recoloured(before: StageInputs | null, next: StageInputs): boolean {
  if (!before) return false;
  return before.page !== next.page || before.ink !== next.ink || before.accent !== next.accent;
}

/** The canvas may have come into sight or gone out of it: draw what it needs, or ask for no more frames. */
function sightChanged(stage: Stage): void {
  const visible = stage.onScreen && !stage.covered;
  if (visible === stage.visible) return;
  stage.visible = visible;
  if (visible) {
    play(stage);
    return;
  }
  cancel(stage);
  stopClock(stage.clock);
}

/** Watch the canvas's size and whether it is on screen; returns the unsubscribe. */
function watchCanvas(stage: Stage): () => void {
  const resized = new ResizeObserver(([entry]) => {
    if (!entry) return;
    stage.size = [Math.max(1, entry.contentRect.width), Math.max(1, entry.contentRect.height)];
    if (!stage.surface) return;
    resize(stage);
    if (!stage.inputs?.moving) play(stage);
  });
  const seen = new IntersectionObserver(([entry]) => {
    stage.onScreen = entry?.isIntersecting ?? true;
    sightChanged(stage);
  });
  resized.observe(stage.canvas);
  seen.observe(stage.canvas);
  return () => {
    resized.disconnect();
    seen.disconnect();
  };
}

/** Start drawing shaders into `canvas`. */
export function createShaderStage(canvas: HTMLCanvasElement, options: StageOptions): ShaderStage {
  const stage: Stage = {
    canvas,
    options,
    disposed: false,
    context: null,
    surface: null,
    pipeline: null,
    shader: null,
    inputs: null,
    body: "",
    pictureId: null,
    picture: null,
    pictureLoading: false,
    atlas: null,
    density: Math.min(window.devicePixelRatio || 1, options.maxDensity),
    size: [Math.max(1, canvas.clientWidth), Math.max(1, canvas.clientHeight)],
    onScreen: true,
    covered: false,
    visible: true,
    clock: stageClock(options.fps),
    time: options.stillTime,
    frame: 0,
    settle: undefined,
    restarts: 0,
    drawn: false,
    pointer: { x: 0.5, y: 0.5, toX: 0.5, toY: 0.5 },
    pace: { frames: 0, slow: 0 },
    glyphs: null,
    glyphKey: "",
    stillKey: "",
  };
  const stopLost = onGpuLost(() => restart(stage));
  const stopPointer = followPointer(stage);
  const stopWatching = watchCanvas(stage);
  void boot(stage);
  return {
    update(next) {
      const changed = recoloured(stage.inputs, next);
      stage.inputs = next;
      apply(stage, next, changed);
    },
    cover(covered) {
      stage.covered = covered;
      sightChanged(stage);
    },
    dispose() {
      stage.disposed = true;
      cancel(stage);
      stopWatching();
      stopLost();
      stopPointer();
      releaseSurface(stage);
    },
  };
}
