/**
 * The studio window beside a game engine's editor: after the Genex button in the editor, the window
 * becomes a small chat that stays above other windows at the right edge of its screen, and goes back
 * to the size and place it had when the person asks for the full window. Electron-free: the window
 * and the screen are a host, so a test drives it with a recorder.
 */

/** A rectangle on the desktop, in screen points. */
export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The part of the studio window, and of its screen, that going beside an editor uses. */
export interface BesideWindowHost {
  getBounds(): WindowBounds;
  setBounds(bounds: WindowBounds): void;
  setMinimumSize(width: number, height: number): void;
  setAlwaysOnTop(on: boolean): void;
  isMaximized(): boolean;
  unmaximize(): void;
  isFullScreen(): boolean;
  /** The usable part of the screen the window is on: without the menu bar, Dock or taskbar. */
  workArea(): WindowBounds;
}

/** The small chat window: its size, and the smallest a person can drag it to. */
export const BESIDE_WINDOW = { width: 420, height: 760, minWidth: 360, minHeight: 480 } as const;
/** How far the small window stands from the screen's edges. */
const EDGE_GAP = 16;

/** Where the small window goes: the right edge of `area`, centred top to bottom, never taller than it. */
export function besideBounds(area: WindowBounds): WindowBounds {
  const width = Math.min(BESIDE_WINDOW.width, Math.max(BESIDE_WINDOW.minWidth, area.width - 2 * EDGE_GAP));
  const height = Math.min(BESIDE_WINDOW.height, Math.max(BESIDE_WINDOW.minHeight, area.height - 2 * EDGE_GAP));
  return {
    x: Math.round(area.x + area.width - width - EDGE_GAP),
    y: Math.round(area.y + (area.height - height) / 2),
    width,
    height,
  };
}

/** The studio window's two shapes, and the way between them. */
export interface BesideWindow {
  /** Whether the window is the small chat now. */
  on(): boolean;
  /** Make `host` the small chat (`true`) or give it back its size and place (`false`); the same shape again does nothing. */
  set(host: BesideWindowHost, on: boolean): void;
  /** The window closed: the next one opens full. */
  forget(): void;
}

/** One launch's small-chat state for a window whose full shape is never smaller than `fullMinimum`. */
export function besideWindow(fullMinimum: { minWidth: number; minHeight: number }): BesideWindow {
  let full: WindowBounds | null = null;
  return {
    on: () => full !== null,
    set(host, on) {
      if (on === (full !== null)) return;
      if (!on) {
        const back = full;
        full = null;
        host.setAlwaysOnTop(false);
        host.setMinimumSize(fullMinimum.minWidth, fullMinimum.minHeight);
        if (back) host.setBounds(back);
        return;
      }
      // A full-screen window has no place to come back to: it stays as it is.
      if (host.isFullScreen()) return;
      if (host.isMaximized()) host.unmaximize();
      full = host.getBounds();
      host.setMinimumSize(BESIDE_WINDOW.minWidth, BESIDE_WINDOW.minHeight);
      host.setBounds(besideBounds(host.workArea()));
      host.setAlwaysOnTop(true);
    },
    forget() {
      full = null;
    },
  };
}
