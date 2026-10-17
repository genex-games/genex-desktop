/**
 * The theme's colours and monospace face as the page resolves them, for canvases that draw in
 * them: read once, and again only after the theme changes.
 */
import { subscribeAppearance } from "../appearance/store.ts";

/** A theme value (the monospace family) as written in the stylesheet. */
function themeValue(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

/**
 * A theme colour as the page resolves it: a token may name another (`--ink: var(--foreground)`), so
 * it is read back from an element coloured with it rather than from the stylesheet's text.
 */
function themeColor(name: string, fallback: string): string {
  const probe = document.createElement("span");
  probe.style.color = `var(${name}, ${fallback})`;
  probe.hidden = true;
  document.body.append(probe);
  const resolved = getComputedStyle(probe).color;
  probe.remove();
  return resolved || fallback;
}

/** The theme's colours and monospace face, as the page resolves them. */
export interface ThemeReading {
  ink: string;
  accent: string;
  page: string;
  font: string;
}

let themeRead: ThemeReading | null = null;
let themeWatched = false;

/**
 * The theme read once and again only after it changes: reading it touches the document and forces
 * a style pass, and every canvas asks on every change of a slider being dragged.
 */
export function themeReading(): ThemeReading {
  if (!themeWatched) {
    themeWatched = true;
    subscribeAppearance(() => {
      themeRead = null;
    });
  }
  themeRead ??= {
    ink: themeColor("--ink", "#ffffff"),
    accent: themeColor("--accent-ink", "#4759c2"),
    page: themeColor("--page", "#000000"),
    font: themeValue("--font-family-mono", "ui-monospace, monospace"),
  };
  return themeRead;
}
