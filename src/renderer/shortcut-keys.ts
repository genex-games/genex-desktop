/**
 * A shortcut as the keyboard in front of the person shows it. The app writes its shortcuts in the
 * Mac's glyphs (`⌘B`, `⌥⌘C`); the handlers take Ctrl for ⌘ off the Mac (`use-app-shortcuts.ts`),
 * so Windows and Linux read `Ctrl+B` and `Ctrl+Alt+C`.
 */
import { StudioPlatform } from "../shared/boot.ts";

/** Each modifier glyph's name off the Mac, in the order Windows writes them. */
const MODIFIER_NAMES = [
  ["⌃", "Ctrl"],
  ["⌘", "Ctrl"],
  ["⌥", "Alt"],
  ["⇧", "Shift"],
] as const;

const MODIFIER_GLYPHS = /[⌘⌃⌥⇧]/g;

/** `keys` for `platform`: unchanged on the Mac (and before main answers), else `Ctrl+Shift+Z`. */
export function shortcutKeys(keys: string, platform: string): string {
  if (platform === StudioPlatform.Mac || platform === "") return keys;
  const key = keys.replace(MODIFIER_GLYPHS, "");
  if (key === keys) return keys;
  const names = MODIFIER_NAMES.filter(([glyph]) => keys.includes(glyph)).map(([, name]) => name);
  return [...new Set(names), key.toUpperCase()].join("+");
}
