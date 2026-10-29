/**
 * Pro nameplates on the GPU: one pipeline per piece on the shared low-power device (the one home's
 * live backgrounds and the avatars use), all on one bind group layout, so a plate canvas keeps one
 * uniform buffer and one bind group whatever piece it shows. A piece's pipeline is built the first
 * time a plate shows it. Where WebGPU is missing, `plateGpu()` answers null and plates are drawn
 * in 2D (`plate-still.ts`).
 */
import type { PlateRecipe } from "../../shared/plate-recipe.ts";
import { backdropGpu, onGpuLost } from "../home-backdrop/gpu.ts";
import { PLATE_UNIFORM_BYTES, plateShader, plateUniforms } from "./plate-shaders.ts";

/**
 * WebGPU's flags, spelled out: the DOM types name their types but not the constants (WebGPU fixes
 * the values). Uniform | copy-dst for the buffer, fragment for the binding's visibility.
 */
const UNIFORM_COPY_DST = 0x40 | 0x08;
const FRAGMENT_STAGE = 0x2;

/** The device, its canvas format, the shared layouts, and the pipelines built so far. */
export interface PlateGpu {
  device: GPUDevice;
  format: GPUTextureFormat;
  bindLayout: GPUBindGroupLayout;
  pipelineLayout: GPUPipelineLayout;
  /** Each piece's pipeline once built (null when it failed to build). */
  pipelines: Map<number, GPURenderPipeline | null>;
  /** Pieces whose pipeline is being built. */
  building: Set<number>;
}

/** One plate canvas on the GPU: its context, and the uniforms only it reads. */
export interface GpuPlateCanvas {
  context: GPUCanvasContext;
  uniforms: GPUBuffer;
  bindings: GPUBindGroup;
}

/** Whether a canvas context is a WebGPU one: the DOM types do not narrow `getContext("webgpu")`. */
const isGpuContext = (value: unknown): value is GPUCanvasContext =>
  typeof value === "object" && value !== null && "configure" in value && "getCurrentTexture" in value;

let starting: Promise<PlateGpu | null> | null = null;
const lostListeners = new Set<() => void>();

async function start(): Promise<PlateGpu | null> {
  const shared = await backdropGpu();
  if (!shared || !navigator.gpu) return null;
  const device = shared.gpu.gpu;
  const bindLayout = device.createBindGroupLayout({
    entries: [{ binding: 0, visibility: FRAGMENT_STAGE, buffer: { type: "uniform" } }],
  });
  return {
    device,
    format: navigator.gpu.getPreferredCanvasFormat(),
    bindLayout,
    pipelineLayout: device.createPipelineLayout({ bindGroupLayouts: [bindLayout] }),
    pipelines: new Map(),
    building: new Set(),
  };
}

/** The plate GPU, started on first use; null where plates cannot be drawn on the GPU. */
export function plateGpu(): Promise<PlateGpu | null> {
  starting ??= start();
  return starting;
}

/** Hear the device go: every plate canvas has to be configured again. Returns the unsubscribe. */
export function onPlateGpuLost(listener: () => void): () => void {
  lostListeners.add(listener);
  return () => {
    lostListeners.delete(listener);
  };
}

onGpuLost(() => {
  starting = null;
  for (const listener of lostListeners) listener();
});

/**
 * A piece's pipeline: built if ready, else undefined while it builds (call again next frame), or
 * null when it cannot be built. `built` hears when one is ready.
 */
export function plateGpuPipeline(
  gpu: PlateGpu,
  scene: number,
  built: () => void,
): GPURenderPipeline | null | undefined {
  if (gpu.pipelines.has(scene)) return gpu.pipelines.get(scene) ?? null;
  if (gpu.building.has(scene)) return undefined;
  gpu.building.add(scene);
  const module = gpu.device.createShaderModule({ code: plateShader(scene) });
  void gpu.device
    .createRenderPipelineAsync({
      layout: gpu.pipelineLayout,
      vertex: { module, entryPoint: "vs_main" },
      fragment: { module, entryPoint: "fs_main", targets: [{ format: gpu.format }] },
      primitive: { topology: "triangle-list" },
    })
    .catch(() => null)
    .then((pipeline) => {
      gpu.pipelines.set(scene, pipeline);
      gpu.building.delete(scene);
      built();
    });
  return undefined;
}

/** A canvas set up to show plates drawn on `gpu`; null when the canvas refuses a WebGPU context. */
export function gpuPlateCanvas(gpu: PlateGpu, canvas: HTMLCanvasElement): GpuPlateCanvas | null {
  const context = canvas.getContext("webgpu");
  if (!isGpuContext(context)) return null;
  context.configure({ device: gpu.device, format: gpu.format, alphaMode: "opaque" });
  const uniforms = gpu.device.createBuffer({ size: PLATE_UNIFORM_BYTES, usage: UNIFORM_COPY_DST });
  const bindings = gpu.device.createBindGroup({
    layout: gpu.bindLayout,
    entries: [{ binding: 0, resource: { buffer: uniforms } }],
  });
  return { context, uniforms, bindings };
}

/** Let a plate canvas go: its uniforms are freed and its context forgets the device. */
export function releasePlateCanvas(canvas: GpuPlateCanvas): void {
  canvas.uniforms.destroy();
  canvas.context.unconfigure();
}

/** One plate to draw: its canvas, its look, its clock and its size in pixels. */
export interface PlateDraw {
  canvas: GpuPlateCanvas;
  pipeline: GPURenderPipeline;
  recipe: PlateRecipe;
  seconds: number;
  width: number;
  height: number;
  density: number;
  /** A light theme: the piece is drawn on paper. */
  paper: boolean;
}

/** Draw these plates, each into its own canvas, in one submission. */
export function drawPlates(gpu: PlateGpu, draws: readonly PlateDraw[]): void {
  if (!draws.length) return;
  const encoder = gpu.device.createCommandEncoder();
  for (const draw of draws) {
    gpu.device.queue.writeBuffer(
      draw.canvas.uniforms,
      0,
      plateUniforms(draw.recipe, draw.seconds, draw.width, draw.height, draw.density, draw.paper),
    );
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: draw.canvas.context.getCurrentTexture().createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });
    pass.setPipeline(draw.pipeline);
    pass.setBindGroup(0, draw.canvas.bindings);
    pass.draw(3);
    pass.end();
  }
  gpu.device.queue.submit([encoder.finish()]);
}
