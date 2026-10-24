/**
 * Home's background on a canvas: drawn once for the window's size, the settings and the theme, and
 * again only when one of those changes. Home shows its own part of the window's drawing, so the
 * sidebar opening or closing beside it draws nothing; while a window resize settles, the last
 * drawing grows evenly to cover the window, and the new one follows once the size is still.
 */
import type { CSSProperties, JSX, RefObject } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAppearance } from "../appearance/store.ts";
import { Scheme } from "../appearance/themes.ts";
import { drawBackdrop } from "./draw.ts";
import { colorLightness } from "./field.ts";
import { loadBackdropPicture } from "./images.ts";
import { useMadeShaders } from "./made-shaders.ts";
import { shaderFor } from "./presets.ts";
import { ShaderCanvas, type ShaderCanvasMode } from "./ShaderCanvas.tsx";
import { PointerSource } from "./shader-stage.ts";
import { BackdropEffect, type BackdropSettings, BackdropSource, DEFAULT_BACKDROP_IMAGE } from "./settings.ts";
import { useBackdrop, useBackdropPreviewShown } from "./store.ts";
import { type BackdropView, homeView, previewView, type Rect, type Size } from "./view.ts";

/** On a dark page a live background draws at this share of its strength, to read as it does on a light one. */
const DARK_PAGE_STRENGTH = 0.5;
/** Home's live background: full frame rate, the pointer anywhere in the window. */
const HOME_LIVE: ShaderCanvasMode = {
  fps: 60,
  maxDensity: 1.5,
  pointer: PointerSource.Window,
  stillTime: 6,
  darkStrength: DARK_PAGE_STRENGTH,
};
/** The Settings preview: a small canvas, so a lower rate and a sharper density cost little. */
const PREVIEW_LIVE: ShaderCanvasMode = {
  fps: 30,
  maxDensity: 2,
  pointer: PointerSource.None,
  stillTime: 6,
  darkStrength: DARK_PAGE_STRENGTH,
};

/** A resize redraws once it has been still this long. */
const RESIZE_SETTLE_MS = 120;
/** Home beneath Settings redraws once a slider has been still this long; the preview follows at once. */
const HOME_SETTLE_MS = 150;

type Screen = Size & { density: number };

function screenNow(): Screen {
  return { width: window.innerWidth, height: window.innerHeight, density: window.devicePixelRatio || 1 };
}

const sameScreen = (a: Screen, b: Screen): boolean =>
  a.width === b.width && a.height === b.height && a.density === b.density;

/** The window's size and density: now, then after each resize or move to another display settles. */
function useSettledScreen(shown: boolean): Screen {
  const [screen, setScreen] = useState(screenNow);
  useEffect(() => {
    if (!shown) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let density: MediaQueryList | null = null;
    const settle = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const next = screenNow();
        setScreen((previous) => (sameScreen(previous, next) ? previous : next));
        watchDensity();
      }, RESIZE_SETTLE_MS);
    };
    // A media query for the density now, renewed after each change: the only word of a move to a
    // display of another density when the window's size in points stays the same.
    const watchDensity = (): void => {
      density?.removeEventListener("change", settle);
      density = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      density.addEventListener("change", settle);
    };
    watchDensity();
    setScreen((previous) => {
      const next = screenNow();
      return sameScreen(previous, next) ? previous : next;
    });
    window.addEventListener("resize", settle);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("resize", settle);
      density?.removeEventListener("change", settle);
    };
  }, [shown]);
  return screen;
}

/** The canvas's width in points, now and then after each resize settles. */
function useSettledWidth(canvas: RefObject<HTMLCanvasElement | null>, shown: boolean): number | null {
  const [width, setWidth] = useState<number | null>(null);
  useEffect(() => {
    const element = canvas.current;
    if (!shown || !element) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let first = true;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const next = entry.contentRect.width;
      clearTimeout(timer);
      if (first) setWidth(next);
      else timer = setTimeout(() => setWidth(next), RESIZE_SETTLE_MS);
      first = false;
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      clearTimeout(timer);
    };
  }, [canvas, shown]);
  return width;
}

/** The picture for `id`, else the bundled one when an added picture is gone. */
async function pictureFor(id: string): Promise<ImageBitmap | null> {
  return (
    (await loadBackdropPicture(id)) ??
    (id === DEFAULT_BACKDROP_IMAGE ? null : loadBackdropPicture(DEFAULT_BACKDROP_IMAGE))
  );
}

/** A colour that paints nothing, as computed styles spell it. */
const CLEAR = /^transparent$|,\s*0\)$/;

/** The colour of the nearest box behind `element` that paints one. */
function pageBehind(element: HTMLElement): string | null {
  for (let box = element.parentElement; box; box = box.parentElement) {
    const color = getComputedStyle(box).backgroundColor;
    if (!CLEAR.test(color)) return color;
  }
  return null;
}

/**
 * Whether the ink is lighter than the page under the canvas, so the picture's light is drawn rather
 * than its dark; the scheme decides when either colour cannot be read.
 */
function inkIsLight(ink: string, canvas: HTMLElement, scheme: Scheme): boolean {
  const behind = pageBehind(canvas);
  const page = behind === null ? null : colorLightness(behind);
  const mark = colorLightness(ink);
  return page === null || mark === null ? scheme === Scheme.Dark : mark > page;
}

/** Draw the settings into the canvas whenever they, the view or the theme change. */
function useBackdropDrawing(
  canvas: RefObject<HTMLCanvasElement | null>,
  settings: BackdropSettings,
  drawing: BackdropView | null,
  onDrawn: () => void,
): void {
  const shown = settings.source === BackdropSource.Picture;
  const { scheme } = useAppearance();
  const drawn = useRef(onDrawn);
  drawn.current = onDrawn;
  useEffect(() => {
    const element = canvas.current;
    if (!shown || !drawing || !element || drawing.view.width < 1 || drawing.view.height < 1) return;
    let cancelled = false;
    let frame = 0;
    const draw = async (): Promise<void> => {
      const picture = await pictureFor(settings.image);
      const style = getComputedStyle(element);
      if (settings.effect === BackdropEffect.Ascii)
        await document.fonts.load(`16px ${style.fontFamily}`).catch(() => []);
      if (cancelled || !picture) return;
      frame = requestAnimationFrame(() => {
        const context = element.getContext("2d");
        if (cancelled || !context) return;
        const { view, scale } = drawing;
        element.width = Math.round(view.width * scale);
        element.height = Math.round(view.height * scale);
        // Home's canvas takes its size in points from these with its new pixels, never before them.
        element.style.setProperty("--backdrop-width", `${view.width}px`);
        element.style.setProperty("--backdrop-aspect", String(view.width / view.height));
        const ink = settings.colors[scheme] ?? style.color;
        drawBackdrop(context, picture, settings, {
          width: drawing.frame.width,
          height: drawing.frame.height,
          origin: { x: view.x, y: view.y },
          scale,
          ink,
          inkIsLight: inkIsLight(ink, element, scheme),
          font: style.fontFamily,
        });
        drawn.current();
      });
    };
    void draw();
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [canvas, shown, drawing, settings, scheme]);
}

/** One background canvas: `drawing` says what it holds; null waits for a size to draw at. */
function BackdropCanvas({
  settings,
  drawing,
  canvas,
  className,
}: {
  settings: BackdropSettings;
  drawing: BackdropView | null;
  canvas: RefObject<HTMLCanvasElement | null>;
  className: string;
}): JSX.Element {
  const [ready, setReady] = useState(false);
  useBackdropDrawing(canvas, settings, drawing, () => setReady(true));
  return (
    <canvas
      ref={canvas}
      data-home-backdrop={settings.effect}
      data-ready={ready || undefined}
      className={className}
      style={{ "--backdrop-strength": settings.strength } as CSSProperties}
    />
  );
}

/**
 * A preview of home's background, home in small: the window's drawing through home's part of it,
 * `window` and `home` in points.
 */
export function BackdropPreview({
  settings,
  window: frame,
  home,
}: {
  settings: BackdropSettings;
  window: Size;
  home: Rect;
}): JSX.Element | null {
  const canvas = useRef<HTMLCanvasElement>(null);
  const live = settings.source === BackdropSource.Shader;
  const shown = settings.source === BackdropSource.Picture;
  const width = useSettledWidth(canvas, shown);
  const density = window.devicePixelRatio || 1;
  const drawing = useMemo(
    () => (width ? previewView(frame, home, width, density) : null),
    [frame, home, width, density],
  );
  if (live) return <LiveBackground settings={settings} mode={PREVIEW_LIVE} className="backdrop-preview-art" />;
  if (!shown) return null;
  return <BackdropCanvas settings={settings} drawing={drawing} canvas={canvas} className="backdrop-preview-art" />;
}

/** The live background the settings choose, moving unless Reduce Motion is on; nothing drawn while `covered`. */
function LiveBackground({
  settings,
  mode,
  className,
  covered = false,
}: {
  settings: BackdropSettings;
  mode: ShaderCanvasMode;
  className: string;
  covered?: boolean;
}): JSX.Element {
  const { body } = shaderFor(settings.shader, useMadeShaders());
  return <ShaderCanvas body={body} settings={settings} moving covered={covered} mode={mode} className={className} />;
}

/** `value`, once it has stopped changing for `ms`; the first value, and any with no wait, at once. */
function useSettledValue<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    if (ms === 0) return;
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return ms === 0 ? value : settled;
}

/**
 * Home's own background, read from the saved settings; only it re-renders when they change. It
 * follows a slider as it moves, except beneath Settings, where the preview follows and home
 * redraws once the slider settles. While Play or Plugins lies over home (`covered`), a live
 * background draws nothing: the page hides it, and it would otherwise draw every frame unseen.
 */
export function HomeBackground({ covered = false }: { covered?: boolean }): JSX.Element | null {
  const settle = useBackdropPreviewShown() ? HOME_SETTLE_MS : 0;
  const settings = useSettledValue(useBackdrop(), settle);
  const canvas = useRef<HTMLCanvasElement>(null);
  const live = settings.source === BackdropSource.Shader;
  const shown = settings.source === BackdropSource.Picture;
  const screen = useSettledScreen(shown);
  const drawing = useMemo(() => homeView({ width: screen.width, height: screen.height }, screen.density), [screen]);
  if (live)
    return (
      <div className="home-backdrop-frame">
        <LiveBackground settings={settings} mode={HOME_LIVE} className="home-backdrop-live" covered={covered} />
      </div>
    );
  if (!shown) return null;
  return (
    <div className="home-backdrop-frame">
      <BackdropCanvas settings={settings} drawing={drawing} canvas={canvas} className="home-backdrop" />
    </div>
  );
}
