/**
 * The studio window's title bar by platform. macOS keeps `hiddenInset`: the traffic lights sit in
 * the app's own header, which leaves them room (`theme.css`, `[data-platform="darwin"]`), centred
 * on the same line as the sidebar toggle and the header's title. Windows
 * and Linux have no such controls in a frameless window, so they get `titleBarOverlay`: the
 * system's minimise, maximise and close drawn over the top-right corner, as tall as the headers,
 * in the theme's colours (the renderer repaints them through `studio:window.controls`).
 */
import type { WindowControlColors } from "../shared/studio-api.ts";
import { StudioPlatform } from "../shared/boot.ts";

/** The app's header height in px (`h-12`); the overlay controls match it. */
export const TITLEBAR_HEIGHT = 48;

/** macOS's traffic-light circles, in points. */
const TRAFFIC_LIGHT_SIZE = 14;
/**
 * Where the lights sit: AppKit's inset from the left edge, and down so their centre is the
 * headers' middle rather than AppKit's 18pt.
 */
const TRAFFIC_LIGHTS = { x: 12, y: (TITLEBAR_HEIGHT - TRAFFIC_LIGHT_SIZE) / 2 } as const;

/** The dark fallback theme's canvas and ink (`theme.css` `:root`), until the renderer sends its own. */
const FALLBACK_COLORS: WindowControlColors = { color: "#0e0d0f", symbolColor: "#dee0e2" };

/** The studio's initial and minimum outer size, in Electron's device-independent pixels. */
export interface StudioWindowSize {
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
}

const STUDIO_WINDOW_SIZE: StudioWindowSize = { width: 1440, height: 900, minWidth: 1080, minHeight: 680 };

/** The studio size for this display; an omitted area preserves fixed-size acceptance launches. */
export function studioWindowSize(platform: string, workArea?: { width: number; height: number }): StudioWindowSize {
  if (platform !== StudioPlatform.Windows || !workArea) return { ...STUDIO_WINDOW_SIZE };
  const width = Math.min(STUDIO_WINDOW_SIZE.width, workArea.width);
  const height = Math.min(STUDIO_WINDOW_SIZE.height, workArea.height);
  return {
    width,
    height,
    minWidth: Math.min(STUDIO_WINDOW_SIZE.minWidth, width),
    minHeight: Math.min(STUDIO_WINDOW_SIZE.minHeight, height),
  };
}

/** What the window's options say about its title bar. */
export type WindowChrome =
  | { titleBarStyle: "hiddenInset"; trafficLightPosition: { x: number; y: number } }
  | { titleBarStyle: "hidden"; titleBarOverlay: WindowControlColors & { height: number } };

/** The title-bar options for a window on `platform`. */
export function windowChrome(platform: string, colors: WindowControlColors = FALLBACK_COLORS): WindowChrome {
  if (platform === StudioPlatform.Mac)
    return { titleBarStyle: "hiddenInset", trafficLightPosition: { ...TRAFFIC_LIGHTS } };
  return { titleBarStyle: "hidden", titleBarOverlay: { ...colors, height: TITLEBAR_HEIGHT } };
}
