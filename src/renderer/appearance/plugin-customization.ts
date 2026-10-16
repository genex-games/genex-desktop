/** Compose a selected offer through the native painter, without editing saved themes. */
import type { PluginTheme } from "../../shared/plugin-customization.ts";
import { DEFAULT_CONTRAST, type Appearance } from "./themes.ts";
/** Both complete palettes replace preset overrides; the person's mode is always preserved. */
export function customizedAppearance(base: Appearance, theme: PluginTheme | null): Appearance {
  if (!theme) return base;
  return {
    ...base,
    ...theme.fonts,
    light: { ...base.light, overrides: { ...theme.light }, contrast: DEFAULT_CONTRAST },
    dark: { ...base.dark, overrides: { ...theme.dark }, contrast: DEFAULT_CONTRAST },
  };
}
