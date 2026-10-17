/**
 * The passes that draw a live background, on any vgpu (the browser's, or Dawn in a lab): the
 * shader into an HDR frame (two, swapped every frame, when it reads the frame before), a glow
 * taken from that frame's brightest parts at a quarter of its size, and a composite that adds the
 * glow and rolls highlights off to white. With an effect over it, the composite goes to a scene the
 * effect pass reads (`dither.ts`) instead of the output. No DOM here: the stage owns the canvas.
 */
import type { Effect, Frame, Gpu, Surface, Target, Texture } from "vgpu";
import { DITHER_SHADER } from "./dither.ts";

type Vgpu = Pick<typeof import("vgpu"), "effect" | "target" | "frame">;

/** The library, its device, what an unset texture binds, and the linear sampler every pass reads with. */
export interface PipelineGpu {
  vgpu: Vgpu;
  gpu: Gpu;
  blank: Texture;
  sampler: GPUSampler;
}

/** The frame is HDR, so what a shader draws over 1 glows instead of clipping. */
export const FRAME_FORMAT: GPUTextureFormat = "rgba16float";
/** The glow is taken at this fraction of the frame's size, on each side. */
const GLOW_DIVISOR = 4;
/** Below this brightness nothing glows; the knee softens the cut. */
const GLOW_THRESHOLD = 0.55;
const GLOW_KNEE = 0.35;
/** History starts empty: a = 0 tells a shader there is no frame before. */
const NO_HISTORY: [number, number, number, number] = [0, 0, 0, 0];

/** The bright pass: four bilinear taps cover the 4×4 block of the frame each glow pixel stands for. */
const EXTRACT_SHADER = `struct Extract {
  page: vec4f,
  texel: vec2f,
  dark: f32,
  threshold: f32,
  knee: f32,
}
@group(0) @binding(0) var<uniform> extract: Extract;
@group(0) @binding(1) var frame: texture_2d<f32>;
@group(0) @binding(2) var linear: sampler;

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let o = extract.texel;
  var c = textureSampleLevel(frame, linear, uv + vec2f(-o.x, -o.y), 0.0).rgb;
  c += textureSampleLevel(frame, linear, uv + vec2f(o.x, -o.y), 0.0).rgb;
  c += textureSampleLevel(frame, linear, uv + vec2f(-o.x, o.y), 0.0).rgb;
  c += textureSampleLevel(frame, linear, uv + vec2f(o.x, o.y), 0.0).rgb;
  c *= 0.25;
  // How far a pixel went from the page towards ink: light on a dark page, dark on a light one.
  let ink = max(mix(extract.page.rgb - c, c, extract.dark), vec3f(0.0));
  let level = dot(ink, vec3f(0.2126, 0.7152, 0.0722));
  let soft = clamp((level - extract.threshold + extract.knee) / (2.0 * extract.knee), 0.0, 1.0);
  let part = max(soft * soft * extract.knee, level - extract.threshold) / max(level, 0.0001);
  return vec4f(ink * part, 1.0);
}
`;

/** A separable 9-tap Gaussian, spread wide: one pass across, one down. */
const BLUR_SHADER = `struct Blur {
  step: vec2f,
}
@group(0) @binding(0) var<uniform> blur: Blur;
@group(0) @binding(1) var source: texture_2d<f32>;
@group(0) @binding(2) var linear: sampler;

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let weights = array<f32, 5>(0.227027, 0.1945946, 0.1216216, 0.054054, 0.016216);
  var sum = textureSampleLevel(source, linear, uv, 0.0).rgb * weights[0];
  for (var i = 1; i < 5; i++) {
    let offset = blur.step * f32(i);
    sum += textureSampleLevel(source, linear, uv + offset, 0.0).rgb * weights[i];
    sum += textureSampleLevel(source, linear, uv - offset, 0.0).rgb * weights[i];
  }
  return vec4f(sum, 1.0);
}
`;

/**
 * The frame and its glow, as the screen shows them: on a dark page the glow adds light and what
 * passes white bleaches and rolls off, the way an overexposed photograph does; on a light page the
 * glow is ink spreading.
 */
const COMPOSITE_SHADER = `struct Composite {
  page: vec4f,
  glow: f32,
  dark: f32,
}
@group(0) @binding(0) var<uniform> composite: Composite;
@group(0) @binding(1) var frame: texture_2d<f32>;
@group(0) @binding(2) var bloom: texture_2d<f32>;
@group(0) @binding(3) var linear: sampler;

fn shoulder(c: vec3f) -> vec3f {
  let over = max(max(c.r, max(c.g, c.b)) - 1.0, 0.0);
  let bleached = c + vec3f(over * 0.5);
  let knee = 0.82;
  let rolled = knee + (1.0 - knee) * (1.0 - exp(-(bleached - knee) / (1.0 - knee)));
  return select(bleached, rolled, bleached > vec3f(knee));
}

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let base = textureSampleLevel(frame, linear, uv, 0.0).rgb;
  let glow = textureSampleLevel(bloom, linear, uv, 0.0).rgb * composite.glow;
  let lit = shoulder(base + glow);
  let inked = clamp(base - glow, vec3f(0.0), vec3f(1.0));
  return vec4f(mix(inked, lit, composite.dark), 1.0);
}
`;

/** Everything a pipeline holds between frames. */
export interface Pipeline {
  context: PipelineGpu;
  shader: Effect | null;
  /** Whether the shader reads its last frame: then there are two frames, swapped every draw. */
  history: boolean;
  frames: [Target, Target];
  /** Which frame the next draw writes. */
  parity: number;
  /** Whether the frame before holds nothing yet. */
  fresh: boolean;
  glow: [Target, Target];
  extract: Effect;
  blurAcross: Effect;
  blurDown: Effect;
  composite: Effect;
  /** The composite as the effect pass reads it, and that pass; made when an effect is first drawn. */
  scene: Target | null;
  dither: Effect | null;
}

/** What one frame draws with. */
export interface PipelineFrame {
  /** The shader's `backdrop` uniform, its resolution aside: the pipeline sets that. */
  backdrop: Record<string, unknown>;
  page: readonly number[];
  dark: boolean;
  /** How much the brightest parts glow, 0 for none. */
  glow: number;
  /** The effect pass's uniform when an effect is drawn over the shader. */
  dither: Record<string, unknown> | null;
}

const glowSize = ([width, height]: readonly [number, number]): [number, number] => [
  Math.max(1, Math.ceil(width / GLOW_DIVISOR)),
  Math.max(1, Math.ceil(height / GLOW_DIVISOR)),
];

/** A pipeline drawing frames of `size` pixels; the shader comes later (`useShader`). */
export function createPipeline(context: PipelineGpu, size: readonly [number, number]): Pipeline {
  const { vgpu, gpu, sampler } = context;
  const frame = (): Target => vgpu.target(gpu, { size, format: FRAME_FORMAT });
  const small = (): Target => vgpu.target(gpu, { size: glowSize(size), format: FRAME_FORMAT });
  const frames: [Target, Target] = [frame(), frame()];
  const glow: [Target, Target] = [small(), small()];
  const blur = (source: Target): Effect => {
    const pass = vgpu.effect(gpu, BLUR_SHADER);
    pass.set({ source, linear: sampler });
    return pass;
  };
  const extract = vgpu.effect(gpu, EXTRACT_SHADER);
  extract.set({ frame: frames[0], linear: sampler });
  const composite = vgpu.effect(gpu, COMPOSITE_SHADER);
  composite.set({ frame: frames[0], bloom: glow[0], linear: sampler });
  const pipeline: Pipeline = {
    context,
    shader: null,
    history: false,
    frames,
    parity: 0,
    fresh: true,
    glow,
    extract,
    blurAcross: blur(glow[0]),
    blurDown: blur(glow[1]),
    composite,
    scene: null,
    dither: null,
  };
  setBlurSteps(pipeline);
  return pipeline;
}

/** The blur's steps for the glow's size: a texel and a half apart, so nine taps reach far. */
function setBlurSteps(pipeline: Pipeline): void {
  const [width, height] = pipeline.glow[0].size;
  pipeline.blurAcross.set({ blur: { step: [1.5 / width, 0] } });
  pipeline.blurDown.set({ blur: { step: [0, 1.5 / height] } });
}

/** Draw with `shader` from now on; `history` says whether it reads its last frame. */
export function setShader(pipeline: Pipeline, shader: Effect, history: boolean): void {
  pipeline.shader = shader;
  pipeline.history = history;
  pipeline.fresh = true;
}

/** Frames of `size` pixels from now on; the frame before is forgotten. */
export function resizePipeline(pipeline: Pipeline, size: readonly [number, number]): void {
  const [width, height] = pipeline.frames[0].size;
  if (width === size[0] && height === size[1]) return;
  for (const frame of pipeline.frames) frame.resize(size);
  for (const glow of pipeline.glow) glow.resize(glowSize(size));
  pipeline.scene?.resize(size);
  pipeline.fresh = true;
  setBlurSteps(pipeline);
}

/** Let a target's textures go now rather than whenever they are collected. */
export function releaseTarget(target: Target): void {
  for (const texture of target.colors) texture.destroy();
}

/** Let the pipeline's frames go with the canvas that drew them. */
export function disposePipeline(pipeline: Pipeline): void {
  for (const target of [...pipeline.frames, ...pipeline.glow, pipeline.scene]) if (target) releaseTarget(target);
  pipeline.shader = null;
}

/** The effect pass and the scene it reads, made the first time an effect is drawn. */
export function prepareDither(pipeline: Pipeline): Effect {
  if (pipeline.dither) return pipeline.dither;
  const { vgpu, gpu, sampler, blank } = pipeline.context;
  pipeline.scene = vgpu.target(gpu, { size: pipeline.frames[0].size, format: "rgba8unorm" });
  pipeline.dither = vgpu.effect(gpu, DITHER_SHADER);
  pipeline.dither.set({ scene: pipeline.scene, sceneSampler: sampler, glyphs: blank });
  return pipeline.dither;
}

/** Bind the frame this draw reads from and the one it writes, and the passes reading it. */
function bindFrames(pipeline: Pipeline, shader: Effect): Target {
  const { frames, history } = pipeline;
  const write = frames[history ? pipeline.parity : 0];
  const read = frames[history ? 1 - pipeline.parity : 1];
  shader.set({ history: history ? read : pipeline.context.blank });
  pipeline.extract.set({ frame: write });
  pipeline.composite.set({ frame: write });
  return write;
}

/** The passes after the shader: glow, then the composite onto the output, through the effect when one is drawn. */
function present(pipeline: Pipeline, current: Frame, output: Surface | Target, frame: PipelineFrame): void {
  const [glowAt, glowSpare] = pipeline.glow;
  if (frame.glow > 0) {
    current.pass(glowAt, pipeline.extract);
    current.pass(glowSpare, pipeline.blurAcross);
    current.pass(glowAt, pipeline.blurDown);
  }
  const over = frame.dither ? pipeline.dither : null;
  if (over && pipeline.scene) {
    current.pass(pipeline.scene, pipeline.composite);
    current.pass(output, over);
    return;
  }
  current.pass(output, pipeline.composite);
}

/**
 * Draw one frame into `output`, or only advance the shader when there is none (a still frame's
 * run-up). A canvas surface is drawn inside a frame: vgpu hands out its texture for that frame only.
 */
export function drawPipeline(pipeline: Pipeline, output: Surface | Target | null, frame: PipelineFrame): void {
  const { shader, context } = pipeline;
  if (!shader) return;
  const write = bindFrames(pipeline, shader);
  const read = pipeline.frames[1 - pipeline.parity];
  shader.set({ backdrop: { ...frame.backdrop, resolution: write.size } });
  setPresent(pipeline, frame);
  const clearing = pipeline.history && pipeline.fresh;
  context.vgpu.frame(context.gpu, (current) => {
    if (clearing) current.pass({ target: read, clear: NO_HISTORY }, () => {});
    current.pass(write, shader);
    if (output) present(pipeline, current, output, frame);
  });
  pipeline.fresh = false;
  if (pipeline.history) pipeline.parity = 1 - pipeline.parity;
}

/** The glow's, composite's and effect's uniforms for a frame. */
function setPresent(pipeline: Pipeline, frame: PipelineFrame): void {
  const dark = frame.dark ? 1 : 0;
  const { texelSize } = pipeline.frames[0];
  pipeline.extract.set({
    extract: { page: frame.page, texel: texelSize, dark, threshold: GLOW_THRESHOLD, knee: GLOW_KNEE },
  });
  pipeline.composite.set({ composite: { page: frame.page, glow: frame.glow, dark } });
  if (frame.dither) pipeline.dither?.set({ dither: frame.dither });
}

/**
 * Show the frame last drawn again with new glow or effect settings, without running the shader:
 * what a still canvas does when only those changed. False when there is no frame to show yet.
 */
export function presentAgain(pipeline: Pipeline, output: Surface | Target, frame: PipelineFrame): boolean {
  const { context } = pipeline;
  if (!pipeline.shader || pipeline.fresh) return false;
  setPresent(pipeline, frame);
  context.vgpu.frame(context.gpu, (current) => present(pipeline, current, output, frame));
  return true;
}
