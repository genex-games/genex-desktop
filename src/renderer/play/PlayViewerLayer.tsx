/**
 * Play's game viewer in the app: in the game's place below the bar, while the game's page loads, its
 * cover developing as an ordered dither (`dither.ts`) under its title and a thin dot rail; when it
 * cannot load, what went wrong (offline, or the page itself) with Try again and Back to Play.
 * The game itself is a native view main lays over that place once it has loaded, and the bar is a
 * strip above it in a layer of its own (`PlayBarPage.tsx`).
 */
import type { JSX } from "react";
import { useEffect, useRef, useState } from "react";
import { PlayControl, PlayViewerPhase } from "../../shared/play.ts";
import { usePlay } from "../state/hooks.ts";
import { studio } from "../state/studio.ts";
import { Button } from "../ui/Button.tsx";
import { prefersReducedMotion } from "../ui/media-queries.ts";
import { useBackOnline, useOnline } from "../ui/use-online.ts";
import { PLAY_WORDS } from "../words.ts";
import { DEVELOP_DONE_MS, DITHER_CELL, type DitherSource, ditherSource, drawDevelop } from "./dither.ts";
import { escapeLeaves } from "./play-model.ts";
import { OfflineMark } from "./PlayOffline.tsx";

const WORDS = PLAY_WORDS.viewer;

/** The cover, loaded for drawing; null until it has decoded (or when it cannot be). */
function useCover(src: string | null): HTMLImageElement | null {
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  useEffect(() => {
    setImage(null);
    if (!src) return;
    const img = new Image();
    // Read back for the dither: the covers' CDN allows any origin, so the canvas stays readable.
    img.crossOrigin = "anonymous";
    img.decoding = "async";
    img.onload = () => setImage(img);
    img.src = src;
    return () => {
      img.onload = null;
    };
  }, [src]);
  return image;
}

/** The cover read at the canvas's dither size, covering it as `object-fit: cover` would. */
function readCover(canvas: HTMLCanvasElement, image: HTMLImageElement): DitherSource | null {
  const width = Math.max(1, Math.round(canvas.clientWidth / DITHER_CELL));
  const height = Math.max(1, Math.round(canvas.clientHeight / DITHER_CELL));
  const reader = document.createElement("canvas");
  reader.width = width;
  reader.height = height;
  const context = reader.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight);
  const drawnWidth = image.naturalWidth * scale;
  const drawnHeight = image.naturalHeight * scale;
  context.drawImage(image, (width - drawnWidth) / 2, (height - drawnHeight) / 2, drawnWidth, drawnHeight);
  try {
    return ditherSource(context.getImageData(0, 0, width, height).data, width, height);
  } catch {
    // A cover served without CORS taints the canvas: there is nothing to read, so nothing is drawn.
    return null;
  }
}

/**
 * The cover developing as a dither, one frame per animation frame until it holds (at once to how it
 * holds under Reduce Motion); read again at the new size when the window resizes.
 */
function DitherCover({ src }: { src: string | null }): JSX.Element | null {
  const canvas = useRef<HTMLCanvasElement>(null);
  const image = useCover(src);
  const [drawn, setDrawn] = useState(false);
  useEffect(() => {
    const target = canvas.current;
    if (!target || !image) return;
    const started = prefersReducedMotion() ? Number.NEGATIVE_INFINITY : performance.now();
    let frame = 0;
    let source: DitherSource | null = null;
    let pixels: ImageData | null = null;
    const read = () => {
      source = readCover(target, image);
      if (!source) return;
      target.width = source.width;
      target.height = source.height;
      pixels = new ImageData(source.width, source.height);
    };
    const draw = () => {
      const context = target.getContext("2d");
      if (!source || !pixels || !context) return;
      const elapsed = performance.now() - started;
      drawDevelop(source, elapsed, pixels.data);
      context.putImageData(pixels, 0, 0);
      setDrawn(true);
      if (elapsed < DEVELOP_DONE_MS) frame = requestAnimationFrame(draw);
    };
    const resized = () => {
      cancelAnimationFrame(frame);
      read();
      draw();
    };
    resized();
    window.addEventListener("resize", resized);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", resized);
    };
  }, [image]);
  if (!src) return null;
  return <canvas ref={canvas} className="play-loader-dither" data-shown={drawn ? true : undefined} />;
}

/** While the game loads: its title over a thin dot rail with a lit run sweeping along it. */
function Loading({ title }: { title: string }): JSX.Element {
  return (
    <div className="play-loader-status" role="status" aria-label={WORDS.loading(title)}>
      <p className="play-loader-title" aria-hidden="true">
        {title}
      </p>
      <span className="play-loader-line" aria-hidden="true" />
    </div>
  );
}

/**
 * Why the game could not load, over its cover: offline (it opens by itself once the Mac is back
 * online), or the page itself; Back to Play and Try again either way.
 */
function Failed({ title }: { title: string }): JSX.Element {
  const online = useOnline();
  useBackOnline(() => void studio().play.retry());
  return (
    <div className="play-viewer-failed" role="alert" data-offline={online ? undefined : true}>
      {!online && <OfflineMark />}
      <h2>{online ? WORDS.failedTitle(title) : PLAY_WORDS.offline.title}</h2>
      <p>{online ? WORDS.failedText : PLAY_WORDS.offline.game(title)}</p>
      <div className="play-viewer-actions">
        <Button onClick={() => void studio().play.close()}>{WORDS.back}</Button>
        <Button variant="default" onClick={() => void studio().play.retry()}>
          {WORDS.retry}
        </Button>
      </div>
    </div>
  );
}

/** The cover under the game's view while it loads, or why it could not load; nothing while no game is open. */
export function PlayViewerLayer(): JSX.Element | null {
  const viewer = usePlay((s) => s.viewer);
  const layer = useRef<HTMLDivElement>(null);
  const failed = viewer?.phase === PlayViewerPhase.Failed;
  // Once the game is on screen over it, the cover says nothing more.
  const playing = viewer?.phase === PlayViewerPhase.Playing;
  const slug = viewer?.slug ?? null;
  // Read when a key comes, so the listener below stays put while the phase moves on.
  const leaves = useRef(false);
  leaves.current = escapeLeaves(viewer);
  const onScreen = useRef(false);
  onScreen.current = playing;
  // While the game is not on screen Esc is the app's: it leaves. Once it plays, an Esc in the app
  // gives the keyboard back to the game. Focus goes back where it was (the card or the Recent row
  // that opened the game) once the viewer closes.
  useEffect(() => {
    if (!slug) return;
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    layer.current?.focus();
    const leave = (event: KeyboardEvent) => {
      // A key held down repeats: only a fresh press acts.
      if (event.key !== "Escape" || event.repeat) return;
      if (leaves.current) void studio().play.close();
      else if (onScreen.current)
        void studio()
          .api.playControl(PlayControl.Resume)
          .catch(() => undefined);
    };
    window.addEventListener("keydown", leave);
    return () => {
      window.removeEventListener("keydown", leave);
      if (before?.isConnected) before.focus({ preventScroll: true });
    };
  }, [slug]);
  if (!viewer) return null;
  return (
    <div
      ref={layer}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label={viewer.title}
      className="play-viewer"
      data-play-viewer={viewer.phase}
    >
      <div className="play-viewer-stage">
        {/* Once the game plays over it, nothing here draws: every frame goes to the game. Another
            game starts the develop over. */}
        {!playing && <DitherCover key={viewer.slug} src={viewer.coverUrl} />}
        <div className="play-viewer-status">
          {failed ? <Failed title={viewer.title} /> : !playing && <Loading title={viewer.title} />}
        </div>
      </div>
    </div>
  );
}
