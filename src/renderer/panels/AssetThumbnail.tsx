/** Visible-file previews: one decoder at a time, no persistent per-card WebGL contexts. */
import type { JSX } from "react";
import { useEffect, useRef, useState } from "react";
import { assetPreviewMode } from "../../shared/asset-preview.ts";
import { SECOND_MS } from "../../shared/duration.ts";
import type { ProjectAsset } from "../../shared/game-assets.ts";
import { previewBytes } from "../asset-bytes.ts";
import { type SnapshotRead, viewerSnapshot } from "../asset-snapshot.ts";
import { assetTitle } from "../asset-names.ts";
import { Icon } from "../ui/icons.tsx";
import { t } from "../../shared/i18n.ts";

/** A thumbnail's size in pixels, and the largest side of an image read for one. */
const THUMB_WIDTH = 360;
const THUMB_HEIGHT = 220;
const IMAGE_THUMB_PX = 512;
/** How long a video may take to decode before its thumbnail gives up. */
const DECODE_TIMEOUT_MS = 15 * SECOND_MS;
/** The most thumbnails kept in memory; the oldest goes first. */
const CACHE_MAX = 96;

/** What a card shows in place of a thumbnail it could not draw. */
const MESSAGE = {
  cancelled: t("Preview cancelled"),
  unavailable: t("Preview unavailable"),
  videoUnavailable: t("Video preview unavailable"),
  videoCodec: t("Video codec unavailable"),
  openPreview: t("Open preview to inspect this file"),
  loading: t("Loading preview…"),
};

/** The modes the card can draw a thumbnail for. A sound draws its own waveform (`AudioTile`). */
const THUMBNAIL_MODES = new Set(["image", "model", "texture", "video"]);

const cache = new Map<string, string>();
let queue: Promise<unknown> = Promise.resolve();

/** The bytes of a previewed file, as the model viewer module hands them over. */
type PreviewBytes = ReturnType<typeof previewBytes>;

const dataUrl = (still: { mimeType: string; data: string }): string => `data:${still.mimeType};base64,${still.data}`;

/** A model or texture drawn once off screen at the thumbnail's size, read from the game's own files. */
function viewerThumbnail(project: string, file: string, companions: string[], signal: AbortSignal): Promise<string> {
  const read: SnapshotRead = (name) => window.studio.previewProjectAsset({ project, file: name });
  return viewerSnapshot({ file, companions, read, width: THUMB_WIDTH, height: THUMB_HEIGHT }, signal);
}

/** A clip's first frame, drawn onto the thumbnail's canvas. */
function firstFrame(
  bytes: PreviewBytes,
  mimeType: string,
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  signal: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    const url = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      video.pause();
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(url);
      if (error) reject(error);
      else resolve(canvas.toDataURL("image/png"));
    };
    const abort = () => finish(new Error(MESSAGE.cancelled));
    const timer = setTimeout(() => finish(new Error(MESSAGE.videoUnavailable)), DECODE_TIMEOUT_MS);
    signal.addEventListener("abort", abort, { once: true });
    video.muted = true;
    video.preload = "auto";
    video.onloadeddata = () => {
      ctx.drawImage(video, 0, 0, THUMB_WIDTH, THUMB_HEIGHT);
      finish();
    };
    video.onerror = () => finish(new Error(MESSAGE.videoCodec));
    video.src = url;
  });
}

/** A video's thumbnail: its first frame. */
async function clipThumbnail(project: string, file: string, mode: string, signal: AbortSignal): Promise<string> {
  const result = await window.studio.previewProjectAsset({ project, file });
  signal.throwIfAborted();
  const bytes = previewBytes(result.data);
  const canvas = document.createElement("canvas");
  canvas.width = THUMB_WIDTH;
  canvas.height = THUMB_HEIGHT;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error(MESSAGE.unavailable);
  if (mode === "video") return firstFrame(bytes, result.mimeType, canvas, ctx, signal);
  throw new Error(MESSAGE.openPreview);
}

async function thumbnail(
  project: string,
  asset: ProjectAsset,
  companions: string[],
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  const file = asset.assetRef ?? asset.file;
  const mode = assetPreviewMode(asset.file);
  if (asset.render) {
    const still = await window.studio.readRunStill(asset.render).catch(() => null);
    signal.throwIfAborted();
    if (still) return dataUrl(still);
  }
  if (mode === "image") {
    const image = await window.studio.readProjectAsset({ project, file, maxPx: IMAGE_THUMB_PX });
    signal.throwIfAborted();
    if (!image) throw new Error(MESSAGE.unavailable);
    return dataUrl(image);
  }
  if (mode === "model" || mode === "texture") return viewerThumbnail(project, file, companions, signal);
  return clipThumbnail(project, file, mode, signal);
}

/** Keep a thumbnail, forgetting the oldest once the cache is full. */
function remember(key: string, value: string): void {
  cache.set(key, value);
  if (cache.size <= CACHE_MAX) return;
  const oldest = cache.keys().next().value;
  if (oldest !== undefined) cache.delete(oldest);
}

/** A thumbnail made once the card scrolls into view, one at a time across the page, and cached by the file's identity. */
function useThumbnail(
  project: string,
  asset: ProjectAsset,
  companions: string[],
  fallback: string | null,
  supported: boolean,
) {
  const key = JSON.stringify([project, asset.assetRef ?? asset.file, asset.mtime, asset.bytes, asset.render]);
  const ref = useRef<HTMLSpanElement>(null);
  const [src, setSrc] = useState<string | null>(() => fallback ?? cache.get(key) ?? null);
  const [error, setError] = useState(false);
  const [fresh, setFresh] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key is the asset's identity; a new object for the same file must not restart it
  useEffect(() => {
    setSrc(fallback ?? cache.get(key) ?? null);
    setFresh(false);
    setError(false);
    if (fallback || !supported) return;
    const cached = cache.get(key);
    if (cached) {
      setSrc(cached);
      return;
    }
    const controller = new AbortController();
    let started = false;
    const observer = new IntersectionObserver((entries) => {
      if (started || !entries.some((e) => e.isIntersecting)) return;
      started = true;
      const task = queue.catch(() => {}).then(() => thumbnail(project, asset, companions, controller.signal));
      queue = task;
      void task
        .then((value) => {
          if (controller.signal.aborted) return;
          remember(key, value);
          setFresh(true);
          setSrc(value);
        })
        .catch(() => {
          if (!controller.signal.aborted) setError(true);
        });
    });
    if (ref.current) observer.observe(ref.current);
    return () => {
      observer.disconnect();
      controller.abort();
    };
  }, [key, fallback, supported]);
  return { ref, src, error, fresh };
}

/** Where the thumbnail stands, as its `data-thumbnail-state` says it. */
function thumbnailState(src: string | null, error: boolean, supported: boolean): string {
  if (src) return "ready";
  if (error) return "unavailable";
  return supported ? "loading" : "unsupported";
}

/** The thumbnail picture's alt text, by what it shows. */
const ALT_WORDS: Partial<Record<ProjectAsset["kind"], string>> = { model: t("3D model preview") };

/** What stands in for a thumbnail: why there is none, that it is loading, or the file's name. */
function placeholderWords(error: boolean, supported: boolean, file: string): string | undefined {
  if (error) return MESSAGE.unavailable;
  return supported ? MESSAGE.loading : file.split("/").at(-1);
}

/** An animation file draws nothing of its own: a figure and its name stand in. */
function MotionStandIn({ file }: { file: string }): JSX.Element {
  return (
    <span className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-3 text-center text-ink-3">
      <Icon name="character" size={22} />
      <span className="max-w-full truncate text-micro">{assetTitle(file)}</span>
    </span>
  );
}

export function AssetThumbnail({
  project,
  asset,
  companions,
  fallback,
  quiet = false,
  motion = false,
}: {
  project: string;
  asset: ProjectAsset;
  companions: string[];
  fallback: string | null;
  quiet?: boolean;
  /** An animation-only file, which a render would show as an empty stage. */
  motion?: boolean;
}): JSX.Element {
  const supported = !motion && THUMBNAIL_MODES.has(assetPreviewMode(asset.file));
  const { ref, src, error, fresh } = useThumbnail(project, asset, companions, fallback, supported);
  const placeholder = quiet ? null : (
    <span className="px-2 text-center text-micro">{placeholderWords(error, supported, asset.file)}</span>
  );
  if (motion) return <MotionStandIn file={asset.file} />;
  return (
    <span
      ref={ref}
      className="absolute inset-0 grid place-items-center"
      data-thumbnail-state={thumbnailState(src, error, supported)}
    >
      {src ? (
        <img
          src={src}
          alt={ALT_WORDS[asset.kind] ?? t("Asset preview")}
          className={`h-full w-full object-contain ${fresh ? "asset-thumbnail" : ""}`}
          draggable={false}
        />
      ) : (
        placeholder
      )}
    </span>
  );
}
