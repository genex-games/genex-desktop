/**
 * The studio window's title bar by platform. macOS keeps `hiddenInset`: the traffic lights sit in
 * the app's own header, which leaves them room (`theme.css`, `[data-platform="darwin"]`), centred
 * on the same line as the sidebar toggle and the header's title. Windows
 * and Linux have no such controls in a frameless window, so they get `titleBarOverlay`: the
 * system's minimise, maximise and close drawn over the top-right corner, as tall as the headers,
 * in the theme's colours (the renderer repaints them through `studio:window.controls`). On Windows
 * their box is see-through while Home's background lies under it, as the space around macOS's
 * lights is; elsewhere it is filled, so nothing a room scrolls or shows passes under the symbols.
 */
import type { WindowControls } from "../shared/studio-api.ts";
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

/** The dark fallback theme's canvas and ink (`theme.css` `:root`), filled, until the renderer sends its own. */
const FALLBACK_CONTROLS: WindowControls = { color: "#0e0d0f", symbolColor: "#dee0e2", seeThrough: false };

/**
 * The see-through box: Windows then paints only the symbols and their hover, whose tint it takes
 * from the system's own colours (Electron's caption buttons), never from this fill.
 */
const SEE_THROUGH = "rgba(0, 0, 0, 0)";

/** The overlay's options: its fill, its symbols' colour and its height. */
export interface TitleBarOverlay {
  color: string;
  symbolColor: string;
  height: number;
}

/** What the window's options say about its title bar. */
export type WindowChrome =
  | { titleBarStyle: "hiddenInset"; trafficLightPosition: { x: number; y: number } }
  | { titleBarStyle: "hidden"; titleBarOverlay: TitleBarOverlay };

/** The part of the studio window the controls' painter touches. */
export interface OverlayWindow {
  isDestroyed(): boolean;
  setTitleBarOverlay(options: TitleBarOverlay): void;
}

/** The overlay on `platform`: see-through on Windows when `controls` ask for it, filled otherwise. */
function titleBarOverlay(platform: string, controls: WindowControls): TitleBarOverlay {
  const seeThrough = controls.seeThrough && platform === StudioPlatform.Windows;
  return {
    color: seeThrough ? SEE_THROUGH : controls.color,
    symbolColor: controls.symbolColor,
    height: TITLEBAR_HEIGHT,
  };
}

/** The title-bar options for a window on `platform`. */
export function windowChrome(platform: string, controls: WindowControls = FALLBACK_CONTROLS): WindowChrome {
  if (platform === StudioPlatform.Mac)
    return { titleBarStyle: "hiddenInset", trafficLightPosition: { ...TRAFFIC_LIGHTS } };
  return { titleBarStyle: "hidden", titleBarOverlay: titleBarOverlay(platform, controls) };
}

/**
 * The window controls on `platform` as the renderer last sent them: the title bar a window opens
 * with, and a repaint of the open window's controls on each change (none on macOS, which draws its own).
 */
export function windowControlsPainter(platform: string) {
  let last = FALLBACK_CONTROLS;
  return {
    chrome: (): WindowChrome => windowChrome(platform, last),
    paint(window: OverlayWindow | null, controls: WindowControls): void {
      last = controls;
      if (platform === StudioPlatform.Mac || !window || window.isDestroyed()) return;
      window.setTitleBarOverlay(titleBarOverlay(platform, controls));
    },
  };
}
