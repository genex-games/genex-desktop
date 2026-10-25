/**
 * An asset opened over the window: a picture (click to see it at full size), a model or texture in
 * the 3D viewer with its animations in one bar, a clip, text, or why it cannot show. Nothing frames
 * it but its library actions (Save, Share), Reveal in Finder and Close.
 */
import type { JSX, MouseEvent, ReactNode, RefObject } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";
import { assetPreviewMode } from "../../shared/asset-preview.ts";
import type { ProjectAsset } from "../../shared/game-assets.ts";
import type { createAssetViewer } from "../asset-model-viewer.js";
import { previewBytes } from "../asset-bytes.ts";
import { clipTitles } from "../asset-names.ts";
import { Lightbox } from "../ui/Lightbox.tsx";
import { prefersReducedMotion } from "../ui/media-queries.ts";
import { hostPlatform } from "../platform.ts";
import { ASSET_WORDS, fileManagerWords } from "../words.ts";
import { t } from "../../shared/i18n.ts";
import { Pending } from "../ui/Pending.tsx";
import { Skeleton } from "../ui/Skeleton.tsx";

/** How much of a text file the preview decodes. */
const TEXT_PREVIEW_BYTES = 256 * 1024;
/** A picture at full size is at least this many times its fitted width, so a small one still grows. */
const ZOOM_MIN_SCALE = 2;
/** The animation speeds the speed button steps through. */
const SPEEDS = [1, 2, 0.5] as const;

type Mode = ReturnType<typeof assetPreviewMode>;
type Viewer = ReturnType<typeof createAssetViewer>;
type Clip = { name: string; duration: number };

/** Why a file could not show, by mode. */
const MESSAGE = {
  image: t("This image could not be decoded. The file may be incomplete or unsupported."),
  audio: t("This audio codec could not be played. Try a WAV, MP3 or Ogg export."),
  video: t("This video codec could not be played. Try an MP4 (H.264) or WebM export."),
  unsupported: t(
    "This format needs its authoring app. For a 3D preview with materials and animation, export GLB; for a sprite animation, export animated GIF/WebP or video.",
  ),
  truncated: `\n${t("… Preview truncated at 256 KiB; original unchanged.")}`,
};

/** What a read file shows as: its text, truncated past the preview's limit, or an object URL for the media element. */
function mediaFrom(
  result: Awaited<ReturnType<typeof window.studio.previewProjectAsset>>,
  mode: Mode,
): { text: string } | { url: string } {
  const bytes = previewBytes(result.data);
  if (mode !== "text") return { url: URL.createObjectURL(new Blob([bytes], { type: result.mimeType })) };
  const truncated = bytes.length > TEXT_PREVIEW_BYTES ? MESSAGE.truncated : "";
  return { text: new TextDecoder().decode(bytes.subarray(0, TEXT_PREVIEW_BYTES)) + truncated };
}

/**
 * The asset loaded for its preview: the 3D viewer for a model or texture (with `clips`, animation
 * files of its rig, playing on it), else its bytes as text or a media URL.
 */
function useAssetSource(
  project: string,
  asset: ProjectAsset,
  assets: ProjectAsset[],
  clips: ProjectAsset[],
  host: HTMLDivElement | null,
) {
  const mode = assetPreviewMode(asset.file);
  const model = mode === "model" || mode === "texture";
  const media = useRef<HTMLMediaElement | null>(null);
  const viewer = useRef<Viewer | null>(null);
  const [url, setURL] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [animations, setAnimations] = useState<Clip[]>([]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the preview reloads for a new file or viewer host, not a new list of companions
  useEffect(() => {
    let cancelled = false;
    let objectURL: string | null = null;
    const fail = (error: unknown) => {
      if (!cancelled) setError(error instanceof Error ? error.message : String(error));
    };
    const read = (file: string) => window.studio.previewProjectAsset({ project, file });
    if (model && host) {
      const files = clips.map((clip) => clip.assetRef ?? clip.file);
      const names = clipTitles(clips.map((clip) => clip.file));
      void import("../asset-model-viewer.js")
        .then(({ createAssetViewer }) => {
          if (cancelled) return;
          viewer.current = createAssetViewer(host, {
            file: asset.assetRef ?? asset.file,
            read,
            companions: assets.map((a) => a.assetRef ?? a.file),
            motions: files.map((file, i) => ({ file, name: names[i] ?? file })),
            onReady: (value: { clips: Clip[]; triangles: number }) => {
              if (cancelled) return;
              setAnimations(value.clips);
              setReady(true);
            },
            onError: fail,
            onTime: () => {},
          });
        })
        .catch(fail);
    } else if (!model && mode !== "unsupported")
      void read(asset.assetRef ?? asset.file)
        .then((result) => {
          if (cancelled) return;
          const shown = mediaFrom(result, mode);
          if ("text" in shown) {
            setText(shown.text);
            setReady(true);
            return;
          }
          objectURL = shown.url;
          setURL(objectURL);
        })
        .catch(fail);
    return () => {
      cancelled = true;
      media.current?.pause();
      media.current?.removeAttribute("src");
      media.current?.load();
      viewer.current?.dispose();
      viewer.current = null;
      if (objectURL) URL.revokeObjectURL(objectURL);
    };
  }, [project, asset.assetRef, asset.file, host]);
  return { mode, model, media, viewer, url, text, error, setError, ready, setReady, animations };
}

type Source = ReturnType<typeof useAssetSource>;

/** Keep the media element the viewer plays, so closing it stops it. */
const keepMedia =
  (media: RefObject<HTMLMediaElement | null>) =>
  (node: HTMLMediaElement | null): void => {
    if (node) media.current = node;
  };

/** Where a full-size picture was asked for: its width, and the point clicked, as shares of the picture. */
type Zoom = { width: number; x: number; y: number };

/** The picture fitted to the window; a click shows it at full size around the point clicked, another fits it again. */
function ImageStage({ url, name, source }: { url: string; name: string; source: Source }): JSX.Element {
  const [zoom, setZoom] = useState<Zoom | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const box = scroller.current;
    if (!zoom || !box) return;
    box.scrollLeft = zoom.x * box.scrollWidth - box.clientWidth / 2;
    box.scrollTop = zoom.y * box.scrollHeight - box.clientHeight / 2;
  }, [zoom]);
  const image = (style?: { width: number; imageRendering?: "pixelated" }) => (
    <img
      src={url}
      alt={name}
      draggable={false}
      onLoad={() => source.setReady(true)}
      onError={() => source.setError(MESSAGE.image)}
      style={style}
      className={`lightbox-media block ${style ? "max-w-none" : "max-h-[calc(100vh-160px)] max-w-[calc(100vw-160px)] object-contain"}`}
    />
  );
  const zoomIn = (event: MouseEvent<HTMLButtonElement>) => {
    const picture = event.currentTarget.querySelector("img");
    if (!picture) return;
    const rect = picture.getBoundingClientRect();
    const byKeyboard = event.detail === 0;
    setZoom({
      width: Math.max(picture.naturalWidth, rect.width * ZOOM_MIN_SCALE),
      x: byKeyboard ? 0.5 : (event.clientX - rect.left) / rect.width,
      y: byKeyboard ? 0.5 : (event.clientY - rect.top) / rect.height,
    });
  };
  if (!zoom)
    return (
      <button type="button" aria-label={ASSET_WORDS.zoomIn} onClick={zoomIn} className="cursor-zoom-in rounded-xl">
        {image()}
      </button>
    );
  const natural = scroller.current?.querySelector("img")?.naturalWidth ?? zoom.width;
  return (
    <div ref={scroller} className="absolute inset-0 overflow-auto">
      <div className="grid min-h-full w-max min-w-full place-items-center p-20">
        <button
          type="button"
          aria-label={ASSET_WORDS.zoomOut}
          onClick={() => setZoom(null)}
          className="cursor-zoom-out rounded-xl"
        >
          {image({ width: zoom.width, ...(zoom.width > natural ? { imageRendering: "pixelated" } : {}) })}
        </button>
      </div>
    </div>
  );
}

/** The preview itself for anything but a model: the picture, the player, the text, or why it cannot show. */
function MediaBody({ source, asset }: { source: Source; asset: ProjectAsset }): JSX.Element | null {
  const { mode, url, setReady, setError } = source;
  const name = asset.file.split("/").pop() ?? asset.file;
  if (mode === "image" && url) return <ImageStage url={url} name={name} source={source} />;
  if (mode === "video" && url)
    return (
      <video
        ref={keepMedia(source.media)}
        controls
        playsInline
        preload="metadata"
        src={url}
        className="lightbox-media max-h-[calc(100vh-160px)] max-w-[calc(100vw-160px)]"
        onLoadedMetadata={() => setReady(true)}
        onError={() => setError(MESSAGE.video)}
      />
    );
  if (mode === "audio" && url)
    return (
      <div className="lightbox-panel w-[min(480px,calc(100vw-160px))] p-5">
        <audio
          ref={keepMedia(source.media)}
          controls
          preload="metadata"
          src={url}
          className="w-full"
          onLoadedMetadata={() => setReady(true)}
          onError={() => setError(MESSAGE.audio)}
        />
      </div>
    );
  if (mode === "text" && source.ready)
    return (
      <pre className="lightbox-panel max-h-[calc(100vh-160px)] w-[min(960px,calc(100vw-160px))] overflow-auto whitespace-pre-wrap break-words p-5 text-xs select-text">
        {source.text}
      </pre>
    );
  if (mode === "unsupported")
    return <p className="max-w-md text-center text-body-sm text-ink-2">{MESSAGE.unsupported}</p>;
  return null;
}

/** A model's animations in one floating bar: play or pause, the clips, and the speed. */
function AnimationBar({ source }: { source: Source }): JSX.Element {
  const { animations, viewer } = source;
  const [clip, setClip] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(0);
  const start = (index: number) => {
    viewer.current?.clip(index);
    viewer.current?.play(true);
    setClip(index);
    setPlaying(true);
  };
  // A model opens moving: its first clip plays at once, unless motion is reduced.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the bar mounts once the clips are known
  useEffect(() => {
    if (!prefersReducedMotion()) start(0);
  }, []);
  const toggle = () => {
    if (clip < 0) {
      start(0);
      return;
    }
    viewer.current?.play(!playing);
    setPlaying(!playing);
  };
  const clipName = animations[Math.max(clip, 0)]?.name ?? "";
  return (
    <div role="group" aria-label={ASSET_WORDS.animations} className="lightbox-bar">
      <button
        type="button"
        aria-label={playing ? t("Pause {clip}", { clip: clipName }) : t("Play {clip}", { clip: clipName })}
        onClick={toggle}
        className="lightbox-play"
      >
        {playing ? (
          <Pause aria-hidden size={12} fill="currentColor" strokeWidth={0} />
        ) : (
          <Play aria-hidden size={12} fill="currentColor" strokeWidth={0} className="translate-x-px" />
        )}
      </button>
      {animations.map((item, index) => (
        <button
          // biome-ignore lint/suspicious/noArrayIndexKey: a clip is chosen by its index; names may repeat
          key={index}
          type="button"
          aria-pressed={index === clip}
          onClick={() => start(index)}
          className="lightbox-chip"
        >
          {item.name}
        </button>
      ))}
      <span aria-hidden className="lightbox-rule" />
      <button
        type="button"
        aria-label={ASSET_WORDS.speed}
        title={ASSET_WORDS.speed}
        onClick={() => {
          const next = (speed + 1) % SPEEDS.length;
          viewer.current?.speed(SPEEDS[next] ?? 1);
          setSpeed(next);
        }}
        className="lightbox-chip min-w-11 tabular-nums"
      >
        {SPEEDS[speed]}×
      </button>
    </div>
  );
}

export function AssetPreview({
  project,
  asset,
  assets,
  clips = [],
  library,
  onClose,
  onReveal,
}: {
  project: string;
  asset: ProjectAsset;
  assets: ProjectAsset[];
  /** Animation files of this model's rig, played on it after its own clips. */
  clips?: ProjectAsset[];
  /** Save and Share, left of Reveal. */
  library?: ReactNode;
  onClose: () => void;
  onReveal: () => void;
}): JSX.Element {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const source = useAssetSource(project, asset, assets, clips, host);
  const { mode, model, ready, error } = source;
  const shown = ready && !error;
  const loading = !ready && !error && mode !== "unsupported";
  // A video or a sound draws its own player while it loads; the shape would cover its controls.
  const drawsWhileLoading = mode === "video" || mode === "audio";
  const animated = source.animations.length > 0;
  const name = asset.file.split("/").pop() ?? t("Asset preview");
  return (
    <Lightbox
      title={name}
      testId="asset-preview"
      onDismiss={onClose}
      actions={
        <>
          {library}
          <button type="button" className="lightbox-button" onClick={onReveal}>
            {fileManagerWords(hostPlatform()).reveal}
          </button>
        </>
      }
    >
      <div className="contents" data-asset-preview-mode={mode} data-preview-ready={ready}>
        {model && <div ref={setHost} className="absolute inset-0" onDoubleClick={() => source.viewer.current?.fit()} />}
        {!error && <MediaBody source={source} asset={asset} />}
        {model && shown && (
          // Centred, and above the animations bar when there is one, so the two never meet.
          <p
            className={`pointer-events-none absolute left-1/2 -translate-x-1/2 text-center text-micro text-ink-3 ${animated ? "bottom-[88px]" : "bottom-9"}`}
          >
            {mode === "texture" ? ASSET_WORDS.textureHint : ASSET_WORDS.modelHint}
          </p>
        )}
        {model && shown && animated && <AnimationBar source={source} />}
        {loading && (
          <Pending label={ASSET_WORDS.loading} className="pointer-events-none absolute inset-0 grid place-items-center">
            {!drawsWhileLoading && <Skeleton width={220} height={220} radius={20} />}
          </Pending>
        )}
        {error && (
          <div role="alert" className="max-w-md text-center text-body-sm text-ink-2">
            {error}
          </div>
        )}
      </div>
    </Lightbox>
  );
}
