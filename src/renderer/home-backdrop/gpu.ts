/**
 * The GPU behind home's live backgrounds: vgpu loaded on first use, so it stays out of the
 * renderer's first bundle, and one low-power device shared by every canvas that draws a shader
 * (home, the gallery's tiles, the Settings preview). A lost device is started again on next use.
 */
import type { Effect, Gpu, Texture } from "vgpu";
import { SHADER_BODY_FIRST_LINE, shaderSource } from "../../shared/backdrop-shader.ts";
import { ASCII_LINE_HEIGHT, type GlyphMeasure } from "./dither.ts";
import { drawGlyphAtlas } from "./glyph-atlas.ts";
import { loadBackdropPicture } from "./images.ts";
import { FRAME_FORMAT } from "./pipeline.ts";
import { DEFAULT_BACKDROP_IMAGE } from "./settings.ts";

type Vgpu = typeof import("vgpu");

/** The loaded library, its device, and what every shader binds when it reads no picture. */
export interface BackdropGpu {
  vgpu: Vgpu;
  gpu: Gpu;
  blank: Texture;
  sampler: GPUSampler;
}

/** A picture on the GPU, and its width / height. */
export interface PictureTexture {
  texture: Texture;
  aspect: number;
}

/** What the compiler says of a shader body. */
export const ShaderCheck = {
  Ok: "ok",
  Fails: "fails",
  /** No WebGPU here: nothing can be compiled or drawn. */
  NoGpu: "no-gpu",
} as const;
export type ShaderCheck = (typeof ShaderCheck)[keyof typeof ShaderCheck];

/** Pictures kept on the GPU: the one shown and the few chosen before it. */
const PICTURES_KEPT = 3;
/** The longest compiler report kept, in characters. */
const REPORT_MAX_CHARS = 2_000;
/** Compiler reports kept: every bundled and made body, and the last few a model wrote. */
const REPORTS_KEPT = 32;

let starting: Promise<BackdropGpu | null> | null = null;
const lostListeners = new Set<() => void>();
const pictures = new Map<string, Promise<PictureTexture | null>>();
let atlas: Promise<Texture | null> | null = null;
/** What the compiler said of each body this device compiled: every canvas drawing one asks once. */
const reports = new Map<string, Promise<string>>();

async function start(): Promise<BackdropGpu | null> {
  if (!("gpu" in navigator)) return null;
  try {
    const vgpu = await import("vgpu");
    const gpu = await vgpu.init({ powerPreference: "low-power" });
    void gpu.gpu.lost.then(() => {
      starting = null;
      pictures.clear();
      reports.clear();
      sheets.clear();
      atlas = null;
      for (const listener of lostListeners) listener();
    });
    const blank = vgpu.texture(gpu, {
      kind: "2d",
      size: [1, 1],
      format: "rgba8unorm",
      usage: ["texture_binding", "copy_dst"],
    });
    return { vgpu, gpu, blank, sampler: vgpu.sampler(gpu, { minFilter: "linear", magFilter: "linear" }) };
  } catch {
    return null;
  }
}

/** The shared GPU, started on first use; null where WebGPU is unavailable. */
export function backdropGpu(): Promise<BackdropGpu | null> {
  starting ??= start();
  return starting;
}

/** Hear the device go (a driver reset, sleep); returns the unsubscribe. */
export function onGpuLost(listener: () => void): () => void {
  lostListeners.add(listener);
  return () => {
    lostListeners.delete(listener);
  };
}

/** The picture `id` names, else the bundled one when an added picture is gone. */
async function bitmapFor(id: string): Promise<ImageBitmap | null> {
  return (
    (await loadBackdropPicture(id)) ??
    (id === DEFAULT_BACKDROP_IMAGE ? null : loadBackdropPicture(DEFAULT_BACKDROP_IMAGE))
  );
}

async function upload(context: BackdropGpu, id: string): Promise<PictureTexture | null> {
  const bitmap = await bitmapFor(id);
  if (!bitmap) return null;
  const texture = context.vgpu.texture(context.gpu, {
    kind: "2d",
    size: [bitmap.width, bitmap.height],
    format: "rgba8unorm",
    usage: ["texture_binding", "copy_dst", "render_attachment"],
  });
  context.gpu.gpu.queue.copyExternalImageToTexture({ source: bitmap }, { texture: texture.gpu }, [
    bitmap.width,
    bitmap.height,
  ]);
  return { texture, aspect: bitmap.width / bitmap.height };
}

/** The picture `id` on the GPU, uploaded once and kept while it is among the last few chosen. */
export function pictureTexture(context: BackdropGpu, id: string): Promise<PictureTexture | null> {
  const known = pictures.get(id);
  if (known) return known;
  const loading = upload(context, id).catch(() => null);
  pictures.set(id, loading);
  for (const old of [...pictures.keys()].slice(0, Math.max(0, pictures.size - PICTURES_KEPT))) pictures.delete(old);
  return loading;
}

/** A canvas's pixels on the GPU, as a texture any pass can sample. */
function canvasTexture(context: BackdropGpu, canvas: OffscreenCanvas): Texture {
  const texture = context.vgpu.texture(context.gpu, {
    kind: "2d",
    size: [canvas.width, canvas.height],
    format: "rgba8unorm",
    usage: ["texture_binding", "copy_dst", "render_attachment"],
  });
  context.gpu.gpu.queue.copyExternalImageToTexture({ source: canvas }, { texture: texture.gpu }, [
    canvas.width,
    canvas.height,
  ]);
  return texture;
}

/** The prelude's glyph sheet (`glyph-atlas.ts`), set once per device; null where it cannot be drawn. */
export function glyphAtlas(context: BackdropGpu): Promise<Texture | null> {
  atlas ??= document.fonts.ready
    .then(() => {
      const canvas = drawGlyphAtlas();
      return canvas ? canvasTexture(context, canvas) : null;
    })
    .catch(() => null);
  return atlas;
}

/** A shader body's compiler messages, its line numbers counted from the body's first line. */
async function compilerReport(context: BackdropGpu, body: string): Promise<string> {
  const module = context.gpu.gpu.createShaderModule({ code: shaderSource(body) });
  const { messages } = await module.getCompilationInfo();
  const lines = body.split("\n");
  return messages
    .filter((message) => message.type === "error")
    .map((message) => {
      const line = message.lineNum - SHADER_BODY_FIRST_LINE + 1;
      const source = lines[line - 1]?.trim();
      return `line ${line}:${message.linePos} ${message.message}${source ? `\n  ${source}` : ""}`;
    })
    .join("\n")
    .slice(0, REPORT_MAX_CHARS);
}

/** The compiler's report on a body, asked once per device. */
function reportOn(context: BackdropGpu, body: string): Promise<string> {
  const known = reports.get(body);
  if (known) return known;
  const report = compilerReport(context, body);
  reports.set(body, report);
  report.catch(() => reports.delete(body));
  for (const old of [...reports.keys()].slice(0, Math.max(0, reports.size - REPORTS_KEPT))) reports.delete(old);
  return report;
}

/** An effect for a body, its pipeline built for the frame it draws into; throws what the compiler says. */
export async function compiledEffect(context: BackdropGpu, body: string): Promise<Effect> {
  const { vgpu, gpu } = context;
  const report = await reportOn(context, body);
  if (report) throw new Error(report);
  const effect = vgpu.effect(gpu, shaderSource(body));
  await effect.compile({ colors: [FRAME_FORMAT] });
  return effect;
}

/** An error's words, with its cause's: a pipeline failure keeps the GPU's reason in its cause. */
function errorReport(error: unknown): string {
  const words = (value: unknown): string => (value instanceof Error ? value.message : String(value ?? ""));
  const cause = error instanceof Error ? words(error.cause) : "";
  return cause ? `${words(error)}\n${cause}` : words(error);
}

/** Whether a body compiles here, and the compiler's words when it does not. */
export async function checkShader(body: string): Promise<{ check: ShaderCheck; report: string }> {
  const context = await backdropGpu();
  if (!context) return { check: ShaderCheck.NoGpu, report: "" };
  try {
    await compiledEffect(context, body);
    return { check: ShaderCheck.Ok, report: "" };
  } catch (error) {
    return { check: ShaderCheck.Fails, report: errorReport(error).slice(0, REPORT_MAX_CHARS) };
  }
}

/** A ramp's glyphs set side by side in white, for the ASCII effect over a live background. */
export interface GlyphSheet {
  texture: Texture;
  measure: GlyphMeasure;
}

/** The size glyphs are set at on their sheet, in pixels: sampled down, never up. */
const GLYPH_SIZE = 64;
/** Glyph sheets kept: the ramp shown and the one before it. */
const SHEETS_KEPT = 2;
const sheets = new Map<string, Promise<GlyphSheet | null>>();

async function setGlyphs(context: BackdropGpu, ramp: readonly string[], font: string): Promise<GlyphSheet | null> {
  await document.fonts.load(`${GLYPH_SIZE}px ${font}`).catch(() => []);
  const face = `${GLYPH_SIZE}px ${font}`;
  const measure = new OffscreenCanvas(1, 1).getContext("2d");
  if (!measure) return null;
  measure.font = face;
  const advance = measure.measureText("M").width / GLYPH_SIZE || 0.6;
  const cell = { width: Math.ceil(advance * GLYPH_SIZE), height: Math.ceil(GLYPH_SIZE * ASCII_LINE_HEIGHT) };
  const canvas = new OffscreenCanvas(cell.width * ramp.length, cell.height);
  const sheet = canvas.getContext("2d");
  if (!sheet) return null;
  sheet.font = face;
  sheet.textBaseline = "top";
  sheet.fillStyle = "#ffffff";
  for (const [index, glyph] of ramp.entries())
    sheet.fillText(glyph, index * cell.width, (cell.height - GLYPH_SIZE) / 2);
  return { texture: canvasTexture(context, canvas), measure: { advance, count: ramp.length } };
}

/** The glyph sheet for a ramp in a font, set once and kept while it is among the last chosen. */
export function glyphSheet(context: BackdropGpu, ramp: string, font: string): Promise<GlyphSheet | null> {
  const key = `${font}\n${ramp}`;
  const known = sheets.get(key);
  if (known) return known;
  const setting = setGlyphs(context, Array.from(ramp), font).catch(() => null);
  sheets.set(key, setting);
  for (const old of [...sheets.keys()].slice(0, Math.max(0, sheets.size - SHEETS_KEPT))) sheets.delete(old);
  return setting;
}
