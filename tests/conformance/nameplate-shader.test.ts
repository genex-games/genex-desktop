/**
 * The Pro nameplate's pieces, compiled and drawn by Dawn (vgpu's Node adapter): every piece's
 * module compiles cleanly and draws a sidebar-sized plate that is opaque, holds real art for two
 * accounts' recipes and moves with its clock. Skipped where this machine has no WebGPU adapter.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  PLATE_UNIFORM_BYTES,
  plateShader,
  plateShaderWith,
  plateUniforms,
} from "../../src/renderer/nameplate/plate-shaders.ts";
import { PLATE_SCENES, type PlateRecipe, PlateScene, plateRecipe } from "../../src/shared/plate-recipe.ts";

const WIDTH = 240;
const HEIGHT = 44;
const FORMAT: GPUTextureFormat = "rgba8unorm";
/** A readback row, padded to WebGPU's 256-byte copy alignment. */
const BYTES_PER_ROW = Math.ceil((WIDTH * 4) / 256) * 256;
/** A plate with this many distinct colours or fewer is a flat fill or a broken draw, not a piece. */
const MIN_COLOURS = 12;
/** WebGPU's usage and map flags, spelled out: the DOM types name their type but not the constants. */
const USAGE = {
  textureCopySrc: 0x01,
  renderAttachment: 0x10,
  mapRead: 0x01,
  copyDst: 0x08,
  uniform: 0x40,
  read: 0x01,
  fragmentStage: 0x2,
} as const;

/** Two accounts' plates at the pixel ratios a sidebar meets, each at its own moment. */
const DRAWS = [
  { id: "fx-rab-neba", variant: 1, dpr: 2, seconds: 3 },
  { id: "fx-kenji-mori", variant: 4, dpr: 1, seconds: 7 },
] as const;

let release: (() => void) | null = null;
let device: GPUDevice | null = null;

/** A recipe on piece `index`, everything else as the account's roll has it. */
const onPiece = (index: number, id: string, variant: number): PlateRecipe => ({
  ...plateRecipe(id, variant),
  scene: PLATE_SCENES[index] ?? PlateScene.NeonRain,
  sceneIndex: index,
});

/** A module's code, with the compiler's errors as `line:pos message`. */
async function compile(gpu: GPUDevice, index: number | string): Promise<{ module: GPUShaderModule; errors: string[] }> {
  const module = gpu.createShaderModule({ code: typeof index === "number" ? plateShader(index) : index });
  const info = await module.getCompilationInfo();
  const errors = info.messages
    .filter((message) => message.type === "error")
    .map((message) => `${message.lineNum}:${message.linePos} ${message.message}`);
  return { module, errors };
}

/** Draw one plate at WIDTH by HEIGHT and read it back as RGBA bytes, row by row. */
async function render(
  gpu: GPUDevice,
  pipeline: GPURenderPipeline,
  recipe: PlateRecipe,
  seconds: number,
  dpr: number,
  paper = false,
): Promise<Uint8Array> {
  const target = gpu.createTexture({
    size: [WIDTH, HEIGHT],
    format: FORMAT,
    usage: USAGE.renderAttachment | USAGE.textureCopySrc,
  });
  const uniforms = gpu.createBuffer({ size: PLATE_UNIFORM_BYTES, usage: USAGE.uniform | USAGE.copyDst });
  gpu.queue.writeBuffer(uniforms, 0, plateUniforms(recipe, seconds, WIDTH, HEIGHT, dpr, paper));
  const readback = gpu.createBuffer({ size: BYTES_PER_ROW * HEIGHT, usage: USAGE.copyDst | USAGE.mapRead });
  const encoder = gpu.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [{ view: target.createView(), loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 0] }],
  });
  pass.setPipeline(pipeline);
  pass.setBindGroup(
    0,
    gpu.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: uniforms } }],
    }),
  );
  pass.draw(3);
  pass.end();
  encoder.copyTextureToBuffer({ texture: target }, { buffer: readback, bytesPerRow: BYTES_PER_ROW }, [WIDTH, HEIGHT]);
  gpu.queue.submit([encoder.finish()]);
  await readback.mapAsync(USAGE.read);
  const rows = new Uint8Array(readback.getMappedRange());
  const pixels = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y++)
    pixels.set(rows.subarray(y * BYTES_PER_ROW, y * BYTES_PER_ROW + WIDTH * 4), y * WIDTH * 4);
  readback.unmap();
  target.destroy();
  uniforms.destroy();
  readback.destroy();
  return pixels;
}

/** How many pixels are not fully opaque. */
function seeThrough(pixels: Uint8Array): number {
  let count = 0;
  for (let at = 3; at < pixels.length; at += 4) if (pixels[at] !== 255) count += 1;
  return count;
}

/** How many distinct colours the plate holds. */
function colours(pixels: Uint8Array): number {
  const seen = new Set<number>();
  for (let at = 0; at < pixels.length; at += 4)
    seen.add(((pixels[at] ?? 0) << 16) | ((pixels[at + 1] ?? 0) << 8) | (pixels[at + 2] ?? 0));
  return seen.size;
}

/** A piece on paper is at least this bright on average. */
const PAPER_MIN = 0.45;

/** The mean of every pixel's luma, 0..1. */
function brightness(pixels: Uint8Array): number {
  let sum = 0;
  for (let at = 0; at < pixels.length; at += 4)
    sum += 0.299 * (pixels[at] ?? 0) + 0.587 * (pixels[at + 1] ?? 0) + 0.114 * (pixels[at + 2] ?? 0);
  return sum / (pixels.length / 4) / 255;
}

/**
 * The pipeline as the app builds it (`plate-gpu.ts`): one uniform buffer seen by the fragment stage
 * only, so a piece whose vertex stage read the uniforms would fail here as it would in the app.
 */
function appPipeline(gpu: GPUDevice, module: GPUShaderModule): GPURenderPipeline {
  const bindLayout = gpu.createBindGroupLayout({
    entries: [{ binding: 0, visibility: USAGE.fragmentStage, buffer: { type: "uniform" } }],
  });
  return gpu.createRenderPipeline({
    layout: gpu.createPipelineLayout({ bindGroupLayouts: [bindLayout] }),
    vertex: { module, entryPoint: "vs_main" },
    fragment: { module, entryPoint: "fs_main", targets: [{ format: FORMAT }] },
  });
}

/** Dials that leave a piece's colour as it is: no warp, mirror, hue turn, glow, grain or steps. */
const NEUTRAL_DIALS = { zoom: 0.5, speed: 0.5, warp: 0, mirror: 0, hue: 0.5, glow: 0, grain: 0, steps: 0 };
/** Colours far apart in every channel, so a swapped slot shows. */
const PROBE: PlateRecipe = {
  ...plateRecipe("probe", 1),
  colors: { deep: "#102030", mid: "#405060", acc: "#708090", light: "#a0b0c0", glow: "#d0e0f0" },
  vars: [0.1, 0.5, 0.9, 0.3],
  dials: NEUTRAL_DIALS,
};
const channels = (hex: string): number[] => [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));

describe("Pro nameplate shaders", () => {
  before(async () => {
    try {
      const { init } = await import("vgpu/node");
      const gpu = await init();
      release = () => gpu.dispose();
      device = gpu.gpu;
    } catch {
      device = null;
    }
  });

  // A live Dawn device keeps the process running.
  after(() => release?.());

  it("draws the first piece for an index it does not know", () => {
    for (const index of [-1, PLATE_SCENES.length, 2.5])
      assert.equal(plateShader(index), plateShader(0), `index ${index}`);
  });

  for (const [index, scene] of PLATE_SCENES.entries())
    it(`compiles ${scene} and draws it opaque, in real art, moving with its clock, pale on paper`, async (t) => {
      if (!device) return t.skip("no WebGPU adapter on this machine");
      const { module, errors } = await compile(device, index);
      assert.deepEqual(errors, [], `${scene} compiles`);
      device.pushErrorScope("validation");
      const pipeline = appPipeline(device, module);
      const frames: Uint8Array[] = [];
      for (const draw of DRAWS)
        frames.push(await render(device, pipeline, onPiece(index, draw.id, draw.variant), draw.seconds, draw.dpr));
      const first = DRAWS[0];
      const later = await render(
        device,
        pipeline,
        onPiece(index, first.id, first.variant),
        first.seconds + 1.5,
        first.dpr,
      );
      const invalid = await device.popErrorScope();
      assert.equal(invalid?.message ?? null, null, `${scene} draws without a validation error`);
      for (const [at, draw] of DRAWS.entries()) {
        const pixels = frames[at] ?? new Uint8Array();
        assert.equal(seeThrough(pixels), 0, `${scene} for ${draw.id} is opaque`);
        const count = colours(pixels);
        assert.ok(count > MIN_COLOURS, `${scene} for ${draw.id} drew ${count} colours`);
      }
      assert.notDeepEqual(frames[0], frames[1], `${scene} differs between accounts`);
      assert.notDeepEqual(later, frames[0], `${scene} moves with its clock`);
      const paper = await render(
        device,
        pipeline,
        onPiece(index, first.id, first.variant),
        first.seconds,
        first.dpr,
        true,
      );
      const dark = brightness(frames[0] ?? new Uint8Array());
      const pale = brightness(paper);
      // Turned over: a night piece goes pale, and nothing ends up darker than half grey.
      assert.ok(pale > PAPER_MIN && (dark >= 0.5 || pale > dark), `${scene} on paper is pale (${pale} vs ${dark})`);
      assert.ok(colours(paper) > MIN_COLOURS, `${scene} on paper keeps its art`);
    });

  // Each uniform slot, read back through the real dials: a piece that returns one slot draws it.
  const SLOTS = [
    ["deep", "u.deep", channels(PROBE.colors.deep)],
    ["mid", "u.mid", channels(PROBE.colors.mid)],
    ["acc", "u.acc", channels(PROBE.colors.acc)],
    ["light", "u.light", channels(PROBE.colors.light)],
    ["glow", "u.glow", channels(PROBE.colors.glow)],
    ["vars", "u.vars.xyz", [0.1, 0.5, 0.9].map((v) => v * 255)],
    ["canvas size", "vec3f(u.res / 1000.0, 0.0)", [WIDTH / 1000, HEIGHT / 1000, 0].map((v) => v * 255)],
    ["pixel ratio", "vec3f(u.dpr / 4.0)", [0.5, 0.5, 0.5].map((v) => v * 255)],
  ] as const;
  for (const [name, read, expected] of SLOTS)
    it(`passes the ${name} to a piece where the shader reads it`, async (t) => {
      if (!device) return t.skip("no WebGPU adapter on this machine");
      const { module, errors } = await compile(
        device,
        plateShaderWith(`fn scene(f: vec2f) -> vec3f { return ${read}; }`),
      );
      assert.deepEqual(errors, []);
      const pixels = await render(device, appPipeline(device, module), PROBE, 1, 2);
      const centre = ((HEIGHT >> 1) * WIDTH + (WIDTH >> 1)) * 4;
      const got = Array.from(pixels.subarray(centre, centre + 3));
      for (const [at, value] of expected.entries())
        assert.ok(Math.abs((got[at] ?? 0) - value) <= 2, `${name}: got ${got}, want ${expected.map(Math.round)}`);
    });

  it("turns a dark piece pale on paper, and leaves it dark off it", async (t) => {
    if (!device) return t.skip("no WebGPU adapter on this machine");
    const { module } = await compile(device, plateShaderWith("fn scene(f: vec2f) -> vec3f { return u.deep; }"));
    const pipeline = appPipeline(device, module);
    const dark = brightness(await render(device, pipeline, PROBE, 1, 2));
    const pale = brightness(await render(device, pipeline, PROBE, 1, 2, true));
    assert.ok(dark < 0.2 && pale > 0.75, `dark ${dark}, on paper ${pale}`);
  });
});
