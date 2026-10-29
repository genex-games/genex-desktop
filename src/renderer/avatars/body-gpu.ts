/**
 * Generated avatars' bodies on the GPU: one pipeline on the shared low-power device (the one home's
 * live backgrounds use), and each avatar's body canvas configured on it with its own small uniform
 * buffer. A tick draws every body it paints in one submission. Where WebGPU is missing, or the
 * device cannot be had, `bodyGpu()` answers null and bodies are drawn in 2D (`body-still.ts`).
 */
import type { AvatarRecipe } from "../../shared/avatar-recipe.ts";
import { backdropGpu, onGpuLost } from "../home-backdrop/gpu.ts";
import { BODY_SHADER, BODY_UNIFORM_BYTES, bodyUniforms, type StarLook } from "./body-shader.ts";

/** The device, the body pipeline and the canvas format it draws in. */
export interface BodyGpu {
  device: GPUDevice;
  pipeline: GPURenderPipeline;
  format: GPUTextureFormat;
}

/** One body canvas on the GPU: its context, and the uniforms only it reads. */
export interface GpuBodyCanvas {
  device: GPUDevice;
  context: GPUCanvasContext;
  uniforms: GPUBuffer;
  bindings: GPUBindGroup;
}

/** One body to draw this tick. */
export interface BodyDraw {
  canvas: GpuBodyCanvas;
  recipe: AvatarRecipe;
  /** The avatar's own clock, in seconds. */
  t: number;
  /** The body's size in canvas pixels. */
  pixels: number;
  /** How a galaxy's stars show. */
  stars: StarLook;
}

/**
 * `GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST`: the DOM types name the flags' type but not
 * the constants, so their values are spelled here (WebGPU fixes them).
 */
const UNIFORM_COPY_DST = 0x40 | 0x08;

/** Whether a canvas context is a WebGPU one: the DOM types do not narrow `getContext("webgpu")`. */
const isGpuContext = (value: unknown): value is GPUCanvasContext =>
  typeof value === "object" && value !== null && "configure" in value && "getCurrentTexture" in value;

let starting: Promise<BodyGpu | null> | null = null;
const lostListeners = new Set<() => void>();

async function start(): Promise<BodyGpu | null> {
  const shared = await backdropGpu();
  if (!shared || !navigator.gpu) return null;
  const device = shared.gpu.gpu;
  const format = navigator.gpu.getPreferredCanvasFormat();
  const module = device.createShaderModule({ code: BODY_SHADER });
  try {
    const pipeline = await device.createRenderPipelineAsync({
      layout: "auto",
      vertex: { module, entryPoint: "vs_main" },
      fragment: { module, entryPoint: "fs_main", targets: [{ format }] },
      primitive: { topology: "triangle-list" },
    });
    return { device, pipeline, format };
  } catch {
    return null;
  }
}

/** The body pipeline, started on first use; null where bodies cannot be drawn on the GPU. */
export function bodyGpu(): Promise<BodyGpu | null> {
  starting ??= start();
  return starting;
}

/** Hear the device go: every body canvas has to be configured again. Returns the unsubscribe. */
export function onBodyGpuLost(listener: () => void): () => void {
  lostListeners.add(listener);
  return () => {
    lostListeners.delete(listener);
  };
}

onGpuLost(() => {
  starting = null;
  for (const listener of lostListeners) listener();
});

/** A canvas set up to show bodies drawn on `gpu`; null when the canvas refuses a WebGPU context. */
export function gpuBodyCanvas(gpu: BodyGpu, canvas: HTMLCanvasElement): GpuBodyCanvas | null {
  const context = canvas.getContext("webgpu");
  if (!isGpuContext(context)) return null;
  context.configure({ device: gpu.device, format: gpu.format, alphaMode: "premultiplied" });
  const uniforms = gpu.device.createBuffer({
    size: BODY_UNIFORM_BYTES,
    usage: UNIFORM_COPY_DST,
  });
  const bindings = gpu.device.createBindGroup({
    layout: gpu.pipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: uniforms } }],
  });
  return { device: gpu.device, context, uniforms, bindings };
}

/** Let a body canvas go: its uniforms are freed and its context forgets the device. */
export function releaseBodyCanvas(canvas: GpuBodyCanvas): void {
  canvas.uniforms.destroy();
  canvas.context.unconfigure();
}

/** Draw these bodies, each into its own canvas, in one submission. */
export function drawBodies(gpu: BodyGpu, draws: readonly BodyDraw[]): void {
  if (!draws.length) return;
  const encoder = gpu.device.createCommandEncoder();
  for (const { canvas, recipe, t, pixels, stars } of draws) {
    gpu.device.queue.writeBuffer(canvas.uniforms, 0, bodyUniforms(recipe, t, pixels, stars));
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: canvas.context.getCurrentTexture().createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });
    pass.setPipeline(gpu.pipeline);
    pass.setBindGroup(0, canvas.bindings);
    pass.draw(3);
    pass.end();
  }
  gpu.device.queue.submit([encoder.finish()]);
}
