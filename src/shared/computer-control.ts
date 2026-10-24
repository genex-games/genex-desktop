/**
 * The person's computer control (docs/computer-use.md#the-persons-computer): the systems Genex
 * offers it on, where its desktop driver ships, and the global shortcut that stops every desktop
 * session there. Main registers the shortcut; the consent card, the agent's answers and Settings
 * say it in the person's words.
 */
import { StudioPlatform } from "./boot.ts";

/** A stop shortcut: Electron's accelerator, its keys as the person reads them, and its name in words. */
export interface DesktopStopShortcut {
  accelerator: string;
  keys: string;
  words: string;
}

const MAC_STOP: DesktopStopShortcut = {
  accelerator: "Control+Alt+Command+Escape",
  keys: "⌃⌥⌘Esc",
  words: "Control-Option-Command-Escape",
};

/** The stop shortcut of each system that offers computer control. */
const STOP_SHORTCUTS: ReadonlyMap<string, DesktopStopShortcut> = new Map([
  [StudioPlatform.Mac, MAC_STOP],
  // Windows has no Command key, and Ctrl+Shift+Esc is Task Manager's.
  [
    StudioPlatform.Windows,
    { accelerator: "Control+Alt+Shift+Escape", keys: "Ctrl+Alt+Shift+Esc", words: "Ctrl+Alt+Shift+Esc" },
  ],
]);

/** Whether `platform` offers computer control: macOS and Windows, where the desktop driver ships. */
export function computerControlOffered(platform: string): boolean {
  return STOP_SHORTCUTS.has(platform);
}

/** The stop shortcut on `platform`; a system that offers no computer control never shows one, so it reads as the Mac's. */
export function desktopStopShortcut(platform: string): DesktopStopShortcut {
  return STOP_SHORTCUTS.get(platform) ?? MAC_STOP;
}

/** The shortcut in a sentence: its name, and its keys beside it where they read differently. */
export function stopShortcutWords(shortcut: DesktopStopShortcut): string {
  return shortcut.words === shortcut.keys ? shortcut.keys : `${shortcut.words} (${shortcut.keys})`;
}
