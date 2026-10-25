/**
 * Putting an appearance on the page: its scheme, its palette's theme variables and its fonts, on
 * the root element. No React, so `first-paint.ts` runs it from index.html's head before the page
 * is first drawn, and the store (`store.ts`) runs it on every change after.
 */
import { readText, STORAGE_KEYS } from "../storage.ts";
import {
  type Appearance,
  DEFAULT_APPEARANCE,
  normalizeAppearance,
  type Palette,
  paletteFor,
  type Scheme,
  themeVariables,
} from "./themes.ts";

// The same stacks as theme.css: Zalando, TikTok Sans for Cyrillic and Greek, then the language's face.
const studioFont =
  '"Zalando Sans SemiExpanded", "TikTok Sans Genex", var(--font-language), ui-sans-serif, system-ui, sans-serif';
const systemFont = '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
const codeFont = '"Geist Mono", var(--font-language), ui-monospace, "SF Mono", Menlo, monospace';
/** The font stack each content-font choice stands for. */
const CONTENT_FONT: Record<Appearance["contentFont"], string> = {
  inherit: "var(--font-family-sans)",
  system: systemFont,
  serif: 'Georgia, "Times New Roman", serif',
  mono: codeFont,
};

/** The saved appearance, the default where none is saved, and whether a saved one could not be read. */
export function savedAppearance(): { appearance: Appearance; unreadable: boolean } {
  try {
    const raw = readText(STORAGE_KEYS.appearance);
    return {
      appearance: raw ? normalizeAppearance(JSON.parse(raw)) : structuredClone(DEFAULT_APPEARANCE),
      unreadable: false,
    };
  } catch {
    return { appearance: structuredClone(DEFAULT_APPEARANCE), unreadable: true };
  }
}

/** A palette shown instead of the appearance's own for `scheme`: the colour tweaker's live preview. */
export type PaintedPalette = { palette: Palette; contrast: number };

/**
 * Paint `appearance` in `scheme` onto `root`; `shown` overrides its palette. `previous` names the
 * theme variables painted last, so one this palette leaves out is removed. Returns the ones painted.
 */
export function paintAppearance(
  root: HTMLElement,
  appearance: Appearance,
  scheme: Scheme,
  shown: PaintedPalette | null = null,
  previous: ReadonlySet<string> = new Set(),
): Set<string> {
  root.dataset.theme = scheme;
  root.style.colorScheme = scheme;
  const palette = shown?.palette ?? paletteFor(appearance, scheme);
  const contrast = shown?.contrast ?? appearance[scheme].contrast;
  const variables = themeVariables(palette, contrast);
  for (const key of previous) if (!(key in variables)) root.style.removeProperty(key);
  for (const [key, value] of Object.entries(variables)) root.style.setProperty(key, value);
  root.style.setProperty("--font-family-sans", appearance.uiFont === "studio" ? studioFont : systemFont);
  root.style.setProperty("--font-family-controls", appearance.uiFont === "studio" ? codeFont : systemFont);
  root.style.setProperty("--font-family-content", CONTENT_FONT[appearance.contentFont] ?? codeFont);
  root.style.setProperty(
    "--font-family-code",
    appearance.codeFont === "geist" ? codeFont : 'ui-monospace, "SF Mono", Menlo, monospace',
  );
  return new Set(Object.keys(variables));
}
