/**
 * The passes behind a live background, on vgpu's mock device: a shader that reads its last frame
 * draws into two frames in turn, starts from nothing after a resize or a new shader, and a still
 * canvas can show its last frame again without running the shader. Every bundled background draws
 * with all of its inputs bound, under an effect too.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as vgpu from "vgpu/mock";
import { readsHistory, shaderSource } from "../../src/shared/backdrop-shader.ts";
import { ditherUniform } from "../../src/renderer/home-backdrop/dither.ts";
import {
  createPipeline,
  drawPipeline,
  type PipelineFrame,
  type PipelineGpu,
  prepareDither,
  presentAgain,
  resizePipeline,
  setShader,
} from "../../src/renderer/home-backdrop/pipeline.ts";
import { SHADER_PRESETS } from "../../src/renderer/home-backdrop/presets.ts";
import { BackdropEffect, DEFAULT_BACKDROP } from "../../src/renderer/home-backdrop/settings.ts";

const SIZE: [number, number] = [64, 40];
const PAGE = [0.08, 0.08, 0.09, 1];
const TRAILS = "@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f { return bd_history(uv); }";
const PLAIN = "@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f { return backdrop.ink; }";

async function context(): Promise<PipelineGpu> {
  const gpu = await vgpu.init();
  const blank = vgpu.texture(gpu, { kind: "2d", size: [1, 1], format: "rgba8unorm", usage: ["texture_binding"] });
  return { vgpu, gpu, blank, sampler: vgpu.sampler(gpu, {}) };
}

/** A pipeline drawing `body`, its picture and glyphs bound as the stage binds them. */
async function drawing(body: string) {
  const gpu = await context();
  const pipeline = createPipeline(gpu, SIZE);
  const shader = gpu.vgpu.effect(gpu.gpu, shaderSource(body));
  shader.set({ picture: gpu.blank, pictureSampler: gpu.sampler, glyphs: gpu.blank });
  setShader(pipeline, shader, readsHistory(body));
  const output = gpu.vgpu.target(gpu.gpu, { size: SIZE, format: "rgba8unorm" });
  return { pipeline, output };
}

function frame(dither: PipelineFrame["dither"] = null): PipelineFrame {
  return {
    backdrop: {
      ink: [1, 1, 1, 1],
      accent: [0.4, 0.5, 1, 1],
      page: PAGE,
      pointer: [0.5, 0.5],
      time: 3,
      scale: 1,
      dark: 1,
      pictureAspect: 1.5,
      delta: 1 / 60,
      density: 1,
    },
    page: PAGE,
    dark: true,
    glow: 0.6,
    dither,
  };
}

describe("a live background's passes", () => {
  it("draws a shader that reads its last frame into each frame in turn", async () => {
    const { pipeline, output } = await drawing(TRAILS);
    assert.equal(pipeline.history, true);
    const written = [0, 1, 2, 3].map(() => {
      const before = pipeline.parity;
      drawPipeline(pipeline, output, frame());
      return before;
    });
    assert.deepEqual(written, [0, 1, 0, 1]);
  });

  it("keeps one frame for a shader that does not", async () => {
    const { pipeline, output } = await drawing(PLAIN);
    drawPipeline(pipeline, output, frame());
    drawPipeline(pipeline, output, frame());
    assert.deepEqual([pipeline.history, pipeline.parity], [false, 0]);
  });

  it("starts from nothing after a resize, at the new size, its glow a quarter of it", async () => {
    const { pipeline, output } = await drawing(TRAILS);
    drawPipeline(pipeline, output, frame());
    assert.equal(pipeline.fresh, false);
    resizePipeline(pipeline, [81, 50]);
    assert.equal(pipeline.fresh, true);
    assert.deepEqual(
      [pipeline.frames[0].size, pipeline.frames[1].size, pipeline.glow[0].size],
      [
        [81, 50],
        [81, 50],
        [21, 13],
      ],
    );
  });

  it("shows the last frame again only once there is one", async () => {
    const { pipeline, output } = await drawing(TRAILS);
    assert.equal(presentAgain(pipeline, output, frame()), false);
    drawPipeline(pipeline, output, frame());
    const parity = pipeline.parity;
    assert.equal(presentAgain(pipeline, output, frame()), true);
    assert.equal(pipeline.parity, parity, "presenting again does not run the shader");
    resizePipeline(pipeline, [32, 20]);
    assert.equal(presentAgain(pipeline, output, frame()), false);
  });

  it("runs a still frame's run-up without an output", async () => {
    const { pipeline } = await drawing(TRAILS);
    drawPipeline(pipeline, null, frame());
    assert.deepEqual([pipeline.fresh, pipeline.parity], [false, 1]);
  });
});

describe("every bundled background", () => {
  for (const preset of SHADER_PRESETS)
    it(`${preset.name} draws with its inputs bound, alone and under an effect`, async () => {
      const { pipeline, output } = await drawing(preset.body);
      drawPipeline(pipeline, output, frame());
      prepareDither(pipeline);
      const dots = ditherUniform(
        { ...DEFAULT_BACKDROP, effect: BackdropEffect.Dots },
        { points: SIZE, density: 1, page: [0.08, 0.08, 0.09, 1], inkIsLight: true, glyphs: { advance: 0.6, count: 1 } },
      );
      drawPipeline(pipeline, output, frame(dots));
    });
});
