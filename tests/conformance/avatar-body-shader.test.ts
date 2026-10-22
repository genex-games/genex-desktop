/**
 * The generated avatar's body shader, compiled and drawn by Dawn (vgpu's Node adapter): every one
 * of the twelve bodies is a lit sphere with a soft edge, premultiplied, transparent outside the
 * circle, and in its own palette. Skipped where this machine has no WebGPU adapter.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { AVATAR_BODIES, type AvatarRecipe, avatarRecipe } from "../../src/shared/avatar-recipe.ts";
import {
  BODY_SHADER,
  BODY_UNIFORM_BYTES,
  BRIGHT_STARS,
  bodyUniforms,
  type StarLook,
} from "../../src/renderer/avatars/body-shader.ts";

const SIZE = 64;
const FORMAT: GPUTextureFormat = "rgba8unorm";
const BYTES_PER_ROW = 256;
/** WebGPU's usage and map flags, spelled out: the DOM types name their type but not the constants. */
const USAGE = {
  textureCopySrc: 0x01,
  renderAttachment: 0x10,
  mapRead: 0x01,
  copyDst: 0x08,
  uniform: 0x40,
  read: 0x01,
} as const;

let release: (() => void) | null = null;
let device: GPUDevice | null = null;
let pipeline: GPURenderPipeline | null = null;

/** A recipe on body `index`, other things as `id` has them. */
const onBody = (index: number, id = "rab neba"): AvatarRecipe => ({
  ...avatarRecipe(id),
  body: AVATAR_BODIES[index] ?? AVATAR_BODIES[0] ?? "vapor",
  bodyIndex: index,
  turn: 0,
});

/** Draw a body at SIZE pixels and read it back as RGBA bytes, row by row. */
async function render(recipe: AvatarRecipe, t = 3, stars?: StarLook): Promise<Uint8Array> {
  if (!device || !pipeline) throw new Error("no device");
  const target = device.createTexture({
    size: [SIZE, SIZE],
    format: FORMAT,
    usage: USAGE.renderAttachment | USAGE.textureCopySrc,
  });
  const uniforms = device.createBuffer({ size: BODY_UNIFORM_BYTES, usage: USAGE.uniform | USAGE.copyDst });
  device.queue.writeBuffer(uniforms, 0, bodyUniforms(recipe, t, SIZE, stars));
  const readback = device.createBuffer({ size: BYTES_PER_ROW * SIZE, usage: USAGE.copyDst | USAGE.mapRead });
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [{ view: target.createView(), loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 0] }],
  });
  pass.setPipeline(pipeline);
  pass.setBindGroup(
    0,
    device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: uniforms } }],
    }),
  );
  pass.draw(3);
  pass.end();
  encoder.copyTextureToBuffer({ texture: target }, { buffer: readback, bytesPerRow: BYTES_PER_ROW }, [SIZE, SIZE]);
  device.queue.submit([encoder.finish()]);
  await readback.mapAsync(USAGE.read);
  const rows = new Uint8Array(readback.getMappedRange());
  const pixels = new Uint8Array(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++)
    pixels.set(rows.subarray(y * BYTES_PER_ROW, y * BYTES_PER_ROW + SIZE * 4), y * SIZE * 4);
  readback.unmap();
  target.destroy();
  uniforms.destroy();
  readback.destroy();
  return pixels;
}

const pixel = (pixels: Uint8Array, x: number, y: number) =>
  Array.from(pixels.subarray((y * SIZE + x) * 4, (y * SIZE + x) * 4 + 4));

describe("generated avatar body shader", () => {
  before(async () => {
    try {
      const { init } = await import("vgpu/node");
      const gpu = await init();
      release = () => gpu.dispose();
      device = gpu.gpu;
      const module = device.createShaderModule({ code: BODY_SHADER });
      const info = await module.getCompilationInfo();
      const errors = info.messages.filter((message) => message.type === "error");
      assert.deepEqual(
        errors.map((message) => `${message.lineNum}:${message.linePos} ${message.message}`),
        [],
      );
      pipeline = device.createRenderPipeline({
        layout: "auto",
        vertex: { module, entryPoint: "vs_main" },
        fragment: { module, entryPoint: "fs_main", targets: [{ format: FORMAT }] },
      });
    } catch (error) {
      if (error instanceof assert.AssertionError) throw error;
      device = null;
    }
  });

  // A live Dawn device keeps the process running.
  after(() => release?.());

  for (const [index, body] of AVATAR_BODIES.entries())
    it(`draws the ${body} body as an opaque sphere, clear outside it`, async (t) => {
      if (!device) return t.skip("no WebGPU adapter on this machine");
      const pixels = await render(onBody(index));
      for (const [x, y] of [
        [0, 0],
        [SIZE - 1, 0],
        [0, SIZE - 1],
        [SIZE - 1, SIZE - 1],
      ] as const)
        assert.deepEqual(pixel(pixels, x, y), [0, 0, 0, 0], `corner ${x},${y}`);
      const centre = pixel(pixels, SIZE / 2, SIZE / 2);
      assert.equal(centre[3], 255, `centre alpha ${centre}`);
      for (let at = 0; at < pixels.length; at += 4)
        for (const channel of [0, 1, 2])
          assert.ok((pixels[at + channel] ?? 0) <= (pixels[at + 3] ?? 0) + 1, `premultiplied at ${at / 4}`);
      const lit = new Set<number>();
      for (let at = 0; at < pixels.length; at += 4)
        if (pixels[at + 3] === 255)
          lit.add(((pixels[at] ?? 0) << 16) | ((pixels[at + 1] ?? 0) << 8) | (pixels[at + 2] ?? 0));
      assert.ok(lit.size > 6, `${body} drew ${lit.size} colours`);
    });

  it("paints the CRT body in exactly its four palette steps, darkened only by its scanlines", async (t) => {
    if (!device) return t.skip("no WebGPU adapter on this machine");
    const recipe = onBody(AVATAR_BODIES.indexOf("crt"), "fx-kenji-mori");
    const pixels = await render(recipe);
    const palette = recipe.palette.map((hex) => [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16)));
    const matches = (rgb: number[]) =>
      palette.some((colour) =>
        [1, 0.86].some((k) => colour.every((value, i) => Math.abs(value * k - (rgb[i] ?? 0)) <= 2)),
      );
    for (let at = 0; at < pixels.length; at += 4)
      if (pixels[at + 3] === 255) assert.ok(matches(Array.from(pixels.subarray(at, at + 3))), `pixel ${at / 4}`);
  });

  it("draws a galaxy's stars white unless asked for quieter ones in its blue", async (t) => {
    if (!device) return t.skip("no WebGPU adapter on this machine");
    const recipe = onBody(AVATAR_BODIES.indexOf("galaxy"), "sign-in");
    const white = (pixels: Uint8Array) => {
      let count = 0;
      for (let at = 0; at < pixels.length; at += 4)
        if ([0, 1, 2].every((channel) => (pixels[at + channel] ?? 0) > 220)) count += 1;
      return count;
    };
    const plain = await render(recipe);
    assert.deepEqual(plain, await render(recipe, 3, BRIGHT_STARS), "stars are bright unless asked");
    const quiet = await render(recipe, 3, { strength: 0.4, tint: 1 });
    assert.ok(white(plain) > 0, "a galaxy shows white stars");
    assert.ok(white(quiet) < white(plain), `quiet stars leave ${white(quiet)} white pixels of ${white(plain)}`);
  });

  it("moves with the avatar's clock", async (t) => {
    if (!device) return t.skip("no WebGPU adapter on this machine");
    const recipe = onBody(AVATAR_BODIES.indexOf("matrix"));
    assert.notDeepEqual(await render(recipe, 3), await render(recipe, 4.5));
  });
});
