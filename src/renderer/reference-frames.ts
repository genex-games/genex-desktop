import { EngineKind, EngineStatusCode } from "../shared/engine-descriptor.ts";
import { errorMessage } from "../shared/errors.ts";
import { isMetered } from "../shared/providers.ts";
/** Run-start intake of the quality bar's actual pixels. */

export const MIN_REFERENCE_FRAMES = 2;
/** Mood boards want breathing room (A8) — 12 chips, still bounded for the judge's context. */
export const MAX_REFERENCE_FRAMES = 12;
/** Long side of a re-encoded still: enough for a judge, small enough for twelve in one prompt. */
export const MAX_REFERENCE_PX = 2048;
/** A PNG under this stays PNG (crisp UI stills); anything else becomes JPEG. */
const PNG_KEEP_BYTES = 2 * 1024 * 1024;

export interface PickedFrame {
  label: string;
  mimeType: string;
  data: string;
}

export interface PickedFrames {
  frames: PickedFrame[];
  /** Files the browser could not decode — shown as an error chip, never silently dropped. */
  skipped: string[];
}

/**
 * Decode every file with the browser (Chromium reads AVIF/HEIC/TIFF the judges cannot),
 * draw it to a canvas capped at MAX_REFERENCE_PX on the long side, and export JPEG (PNG kept
 * for small PNGs). The declared `file.type` is never trusted again.
 */
export async function filesToFramesDetailed(files: FileList | File[]): Promise<PickedFrames> {
  const list = [...files].slice(0, MAX_REFERENCE_FRAMES);
  const frames: PickedFrame[] = [];
  const skipped: string[] = [];
  for (const file of list) {
    const label = file.name.replace(/\.[^.]+$/, "") || `frame-${frames.length + 1}`;
    try {
      const encoded = await reencode(file);
      frames.push({ label, ...encoded });
    } catch {
      skipped.push(file.name);
    }
  }
  return { frames, skipped };
}

/** The frames alone — what the composer and review panel consumed before `skipped` existed. */
export async function filesToFrames(files: FileList | File[]): Promise<PickedFrame[]> {
  return (await filesToFramesDetailed(files)).frames;
}

async function reencode(file: File): Promise<{ mimeType: string; data: string }> {
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") {
    // No decoder here (tests, a worker): pass the bytes through under a sniffed type.
    if (file.type && !file.type.startsWith("image/")) throw new Error("not an image");
    return { mimeType: file.type || "image/jpeg", data: await readAsBase64(file) };
  }
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch (err) {
    throw new Error(`cannot decode ${file.name}: ${errorMessage(err)}`);
  }
  try {
    const long = Math.max(bitmap.width, bitmap.height);
    const scale = long > MAX_REFERENCE_PX ? MAX_REFERENCE_PX / long : 1;
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    ctx.drawImage(bitmap, 0, 0, width, height);
    const keepPng = file.type === "image/png" && file.size <= PNG_KEEP_BYTES && scale === 1;
    const mimeType = keepPng ? "image/png" : "image/jpeg";
    const url = canvas.toDataURL(mimeType, keepPng ? undefined : 0.92);
    const comma = url.indexOf(",");
    return { mimeType, data: comma >= 0 ? url.slice(comma + 1) : url };
  } finally {
    bitmap.close?.();
  }
}

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result ?? "");
      const comma = url.indexOf(",");
      resolve(comma >= 0 ? url.slice(comma + 1) : url);
    };
    reader.onerror = () => reject(reader.error ?? new Error("could not read image"));
    reader.readAsDataURL(file);
  });
}

/** A ready direct engine the app may pick on its own: never a metered one (OpenRouter). */
const isUnmeteredReadyDirect = (engine: { id: string; kind: string; status: { code: string } }): boolean =>
  engine.kind === EngineKind.Direct && engine.status.code === EngineStatusCode.Ready && !isMetered(engine.id);

/**
 * The critic is the same engine the user picked to build. Local stays local (a vision
 * install on that engine, when there is one). Claude Code stays Claude Code — a fresh
 * session, not a swap to Ollama.
 */
export function pickJudge(
  engines: Array<{
    id: string;
    kind: string;
    status: { code: string };
    models?: Array<{ id: string; supportsVision?: boolean }>;
  }>,
  builderEngine?: string,
  builderModel?: string,
): { judgeEngine?: string; judgeModel?: string } {
  const builder =
    engines.find((engine) => engine.id === builderEngine) ?? engines.find((engine) => isUnmeteredReadyDirect(engine));
  const judgeEngine = builder?.id ?? builderEngine;
  if (!judgeEngine) return {};
  if (builder?.kind === EngineKind.Delegated) {
    // Which model judges is the role policy's call, resolved by the harness at launch
    // (harness-seed/loop/model-roles.ts) — on Claude, a Fable pick judges on Opus, not on Fable.
    return { judgeEngine };
  }
  const vision = builder?.models?.find((model) => model.supportsVision);
  const judgeModel = vision?.id ?? builderModel;
  return { judgeEngine, ...(judgeModel ? { judgeModel } : {}) };
}
