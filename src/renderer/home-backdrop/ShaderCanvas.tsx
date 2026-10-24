/**
 * A canvas drawing a live background: the shader body, in the settings' colours for the theme on
 * screen (the theme's ink and accent until colours are picked), over the page's colour, through
 * the settings' effect when one is chosen.
 */
import type { CSSProperties, JSX } from "react";
import { useEffect, useRef, useState } from "react";
import { useAppearance } from "../appearance/store.ts";
import { Scheme } from "../appearance/themes.ts";
import { prefersReducedMotion } from "../ui/media-queries.ts";
import { BackdropEffect, type BackdropSettings } from "./settings.ts";
import { createShaderStage, type PointerSource, type ShaderStage, StageState } from "./shader-stage.ts";
import { themeReading } from "./theme-reading.ts";

/** How a canvas draws: its frame rate and pixels per point at most, and what its pointer follows. */
export interface ShaderCanvasMode {
  fps: number;
  maxDensity: number;
  pointer: PointerSource;
  /** The moment a still canvas shows, in seconds. */
  stillTime: number;
  /**
   * The share of the strength drawn on a dark page, where light marks read about twice as strong
   * as dark ones on a light page: below 1 where the background sits behind home, 1 in a tile.
   */
  darkStrength: number;
}

/**
 * Draws `body` with `settings`' colours, speed, size and picture; moves only while `moving`, and
 * draws nothing while `covered`.
 */
export function ShaderCanvas({
  body,
  settings,
  moving,
  covered = false,
  mode,
  className,
  onState,
}: {
  body: string;
  settings: BackdropSettings;
  moving: boolean;
  /** A page lies over the canvas's own (Play over home): hidden there, it asks for no frames. */
  covered?: boolean;
  mode: ShaderCanvasMode;
  className: string;
  onState?: (state: StageState) => void;
}): JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null);
  const stage = useRef<ShaderStage | null>(null);
  const [state, setState] = useState<StageState>(StageState.Loading);
  const { appearance, scheme } = useAppearance();
  const told = useRef(onState);
  told.current = onState;
  // The stage lives as long as the canvas; its mode is fixed for that life.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new mode is a new canvas (its key)
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const created = createShaderStage(element, {
      ...mode,
      onState: (next) => {
        setState(next);
        told.current?.(next);
      },
    });
    stage.current = created;
    return () => {
      created.dispose();
      stage.current = null;
    };
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a theme change recolours through the stylesheet
  useEffect(() => {
    const theme = themeReading();
    stage.current?.update({
      body,
      ink: settings.shaderColors[scheme] ?? theme.ink,
      accent: settings.shaderAccents[scheme] ?? theme.accent,
      page: theme.page,
      speed: settings.speed,
      glow: settings.glow,
      scale: settings.scale,
      picture: settings.image,
      moving: moving && settings.speed > 0 && !prefersReducedMotion(),
      effect: settings.effect === BackdropEffect.None ? null : { settings, font: theme.font },
    });
  }, [body, settings, scheme, appearance, moving]);
  useEffect(() => {
    stage.current?.cover(covered);
  }, [covered]);
  return (
    <canvas
      ref={canvas}
      className={className}
      data-backdrop-shader={state}
      data-ready={state === StageState.Drawing || undefined}
      style={
        { "--backdrop-strength": settings.strength * (scheme === Scheme.Dark ? mode.darkStrength : 1) } as CSSProperties
      }
    />
  );
}
