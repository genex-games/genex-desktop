/**
 * A made background drawn off screen as home draws it, for the model to look at before it improves
 * it: three moments a few seconds apart on the chosen picture in the colours on screen, side by
 * side in one picture; what stands out in them (`look-findings.ts`); and what a frame costs at a
 * laptop's size. Nothing here touches a canvas on screen.
 */
import type { Effect } from "vgpu";
import { type BackdropLook, readsHistory, readsPicture } from "../../shared/backdrop-shader.ts";
import type { MessageImage } from "../../shared/event-log.ts";
import { rgbaOf } from "./css-color.ts";
import { type BackdropGpu, backdropGpu, compiledEffect, glyphAtlas, pictureTexture } from "./gpu.ts";
import { lookFindings } from "./look-findings.ts";
import {
  createPipeline,
  disposePipeline,
  drawPipeline,
  type PipelineFrame,
  releaseTarget,
  setShader,
} from "./pipeline.ts";
import { lumaOf, type Rgba, readableColor } from "./readable-color.ts";

/** Each moment's size in pixels, the moments in seconds, and the step the shader is run at between them. */
const MOMENT_SIZE: [number, number] = [512, 320];
const MOMENTS = [3, 8, 13];
const STEP_SECONDS = 1 / 20;
/** A frame's cost is measured at a laptop's size over this many frames. */
const COST_SIZE: [number, number] = [1920, 1200];
const COST_FRAMES = 24;
const JPEG_QUALITY = 0.85;
/** The moments stand apart by a grey line this wide, so the model reads three frames, not one. */
const GAP = 6;
const GAP_COLOR = "#808080";

/** What the look is drawn in: the picture, the colours on screen as CSS colours, and the glow. */
export interface LookInputs {
  picture: string;
  ink: string;
  accent: string;
  page: string;
  glow: number;
}

/** What a frame of the look draws with at `time`. */
function lookFrame(inputs: LookInputs, aspect: number, time: number, delta: number): PipelineFrame {
  const page = rgbaOf(inputs.page);
  const dark = lumaOf(page) < 0.5;
  return {
    backdrop: {
      ink: readableColor(rgbaOf(inputs.ink), dark),
      accent: readableColor(rgbaOf(inputs.accent), dark),
      page,
      pointer: [0.5, 0.5],
      time,
      scale: 1,
      dark: dark ? 1 : 0,
      pictureAspect: aspect,
      delta,
      density: 1,
    },
    page,
    dark,
    glow: inputs.glow,
    dither: null,
  };
}

/** The moments' pixels: the shader run from the start at a steady step, each moment read back. */
async function moments(context: BackdropGpu, shader: Effect, history: boolean, frame: (t: number) => PipelineFrame) {
  const pipeline = createPipeline(context, MOMENT_SIZE);
  const output = context.vgpu.target(context.gpu, { size: MOMENT_SIZE, format: "rgba8unorm" });
  setShader(pipeline, shader, history);
  const read: Uint8Array[] = [];
  try {
    let time = 0;
    for (const moment of MOMENTS) {
      for (; time < moment - STEP_SECONDS / 2; time += STEP_SECONDS) drawPipeline(pipeline, null, frame(time));
      drawPipeline(pipeline, output, frame(time));
      read.push(await output.color.read({ mipLevel: 0, region: "all" }));
    }
    return read;
  } finally {
    disposePipeline(pipeline);
    releaseTarget(output);
  }
}

/** Milliseconds a frame takes at a laptop's size, wall clock over a run of frames. */
async function frameCost(context: BackdropGpu, shader: Effect, history: boolean, frame: (t: number) => PipelineFrame) {
  const pipeline = createPipeline(context, COST_SIZE);
  const output = context.vgpu.target(context.gpu, { size: COST_SIZE, format: "rgba8unorm" });
  setShader(pipeline, shader, history);
  try {
    drawPipeline(pipeline, output, frame(0));
    await context.gpu.settled();
    const started = performance.now();
    for (let n = 1; n <= COST_FRAMES; n++) drawPipeline(pipeline, output, frame(n * STEP_SECONDS));
    await context.gpu.settled();
    return (performance.now() - started) / COST_FRAMES;
  } finally {
    disposePipeline(pipeline);
    releaseTarget(output);
  }
}

/** The moments side by side as one JPEG, as the model is shown it; null where it cannot be encoded. */
async function sheet(read: readonly Uint8Array[]): Promise<MessageImage | null> {
  const [width, height] = MOMENT_SIZE;
  const canvas = new OffscreenCanvas(width * read.length + GAP * (read.length - 1), height);
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.fillStyle = GAP_COLOR;
  context.fillRect(0, 0, canvas.width, height);
  for (const [index, pixels] of read.entries())
    context.putImageData(new ImageData(new Uint8ClampedArray(pixels), width, height), index * (width + GAP), 0);
  const bytes = new Uint8Array(
    await (await canvas.convertToBlob({ type: "image/jpeg", quality: JPEG_QUALITY })).arrayBuffer(),
  );
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return { mimeType: "image/jpeg", data: btoa(binary) };
}

/** Bind what the body samples: the picture when it reads one, and the glyph sheet. */
async function bound(context: BackdropGpu, wgsl: string, picture: string): Promise<{ shader: Effect; aspect: number }> {
  const shader = await compiledEffect(context, wgsl);
  const shown = readsPicture(wgsl) ? await pictureTexture(context, picture) : null;
  const atlas = await glyphAtlas(context);
  shader.set({
    picture: shown?.texture ?? context.blank,
    pictureSampler: context.sampler,
    glyphs: atlas ?? context.blank,
  });
  return { shader, aspect: shown?.aspect ?? 1 };
}

/** How `wgsl` looks on home, or null when it cannot be drawn here (no GPU, or it fails to compile). */
export async function lookAt(wgsl: string, inputs: LookInputs): Promise<BackdropLook | null> {
  const context = await backdropGpu();
  if (!context) return null;
  try {
    const { shader, aspect } = await bound(context, wgsl, inputs.picture);
    const history = readsHistory(wgsl);
    const frame = (time: number): PipelineFrame => lookFrame(inputs, aspect, time, STEP_SECONDS);
    const read = await moments(context, shader, history, frame);
    const frameMs = await frameCost(context, shader, history, frame);
    const page: Rgba = rgbaOf(inputs.page);
    const image = await sheet(read).catch(() => null);
    return { wgsl, images: image ? [image] : [], findings: lookFindings(read, MOMENT_SIZE, page, frameMs), frameMs };
  } catch {
    return null;
  }
}
