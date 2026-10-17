/**
 * Home's background readied before home opens (the welcome's last screen asks for it, quietly): for
 * a live background the GPU started, the library loaded, the shader compiled, its picture and
 * glyphs on the GPU, and every pass it draws through drawn once off screen, so its pipelines are
 * built; for a picture, the picture decoded. Home's canvas then finds it all ready and its first
 * frame follows at once. Anything that fails here is left for home to try again.
 */
import { readsHistory, readsPicture } from "../../shared/backdrop-shader.ts";
import { ditherUniform } from "./dither.ts";
import { backdropGpu, type BackdropGpu, compiledEffect, glyphAtlas, glyphSheet, pictureTexture } from "./gpu.ts";
import { loadBackdropPicture } from "./images.ts";
import { madeShader } from "./made-shaders.ts";
import {
  createPipeline,
  disposePipeline,
  drawPipeline,
  type PipelineFrame,
  prepareDither,
  releaseTarget,
  setShader,
} from "./pipeline.ts";
import { shaderFor } from "./presets.ts";
import type { Rgba } from "./readable-color.ts";
import { BackdropEffect, type BackdropSettings, BackdropSource } from "./settings.ts";
import { backdropNow } from "./store.ts";
import { themeReading } from "./theme-reading.ts";

/** The warm-up frame's size in pixels: the pipelines it builds do not depend on it. */
const WARM_SIZE: [number, number] = [64, 40];
const WARM_PAGE: Rgba = [0, 0, 0, 1];

let preloading: Promise<void> | null = null;

/** A frame for the warm-up: any values do, only the passes it runs matter. */
function warmFrame(settings: BackdropSettings): PipelineFrame {
  const over = settings.effect !== BackdropEffect.None;
  return {
    backdrop: {
      ink: [1, 1, 1, 1],
      accent: [1, 1, 1, 1],
      page: WARM_PAGE,
      pointer: [0.5, 0.5],
      time: 0,
      scale: 1,
      dark: 1,
      pictureAspect: 1,
      delta: 0,
      density: 1,
    },
    page: WARM_PAGE,
    dark: true,
    glow: settings.glow,
    dither: over
      ? ditherUniform(settings, {
          points: WARM_SIZE,
          density: 1,
          page: WARM_PAGE,
          inkIsLight: true,
          glyphs: { advance: 0.6, count: 1 },
        })
      : null,
  };
}

/** Compile the live background and draw it once into a canvas-format target, through its effect. */
async function warmShader(context: BackdropGpu, settings: BackdropSettings): Promise<void> {
  const made = madeShader(settings.shader);
  const { body } = shaderFor(settings.shader, made ? [made] : []);
  const [shader, picture, atlas] = await Promise.all([
    compiledEffect(context, body),
    readsPicture(body) ? pictureTexture(context, settings.image) : null,
    glyphAtlas(context),
    settings.effect === BackdropEffect.Ascii
      ? glyphSheet(context, settings.asciiCharacters, themeReading().font)
      : null,
  ]);
  const { blank, sampler } = context;
  shader.set({ picture: picture?.texture ?? blank, pictureSampler: sampler, glyphs: atlas ?? blank });
  const pipeline = createPipeline(context, WARM_SIZE);
  const format = navigator.gpu?.getPreferredCanvasFormat?.() ?? "bgra8unorm";
  const output = context.vgpu.target(context.gpu, { size: WARM_SIZE, format });
  try {
    setShader(pipeline, shader, readsHistory(body));
    if (settings.effect !== BackdropEffect.None) prepareDither(pipeline);
    drawPipeline(pipeline, output, warmFrame(settings));
    await context.gpu.settled();
  } finally {
    disposePipeline(pipeline);
    releaseTarget(output);
  }
}

async function warm(): Promise<void> {
  const settings = backdropNow();
  if (settings.source === BackdropSource.Picture) {
    await loadBackdropPicture(settings.image);
    return;
  }
  if (settings.source !== BackdropSource.Shader) return;
  const context = await backdropGpu();
  if (context) await warmShader(context, settings);
}

/** Ready home's background now, once; never throws. */
export function preloadHomeBackdrop(): Promise<void> {
  preloading ??= warm().catch(() => {});
  return preloading;
}
