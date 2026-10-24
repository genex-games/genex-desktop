import { useSyncExternalStore } from "react";
import {
  DEFAULT_APPEARANCE,
  normalizeAppearance,
  resolveScheme,
  type Appearance,
  type Palette,
  type Scheme,
} from "./themes.ts";
import { paintAppearance, savedAppearance } from "./paint.ts";
import { t } from "../../shared/i18n.ts";
import { STORAGE_KEYS, writeText } from "../storage.ts";
import { DARK_SCHEME_QUERY } from "../ui/media-queries.ts";

export const APPEARANCE_KEY = STORAGE_KEYS.appearance;
const listeners = new Set<() => void>();
let current = structuredClone(DEFAULT_APPEARANCE);
let saveError = "";
let media: MediaQueryList | undefined;
let transitionFrame = 0;
/** A palette shown in place of the saved appearance: the developer colour tweaker's live preview. */
export type PalettePreview = { scheme: Scheme; palette: Palette; contrast: number };
let preview: PalettePreview | null = null;
/** The theme variables set last: one a later palette leaves out (an unset icon colour) is removed. */
let applied: ReadonlySet<string> = new Set<string>();
/** The scheme on screen: the preview's while one is shown, else the saved mode's. */
const shownScheme = (): Scheme => preview?.scheme ?? resolveScheme(current.mode, media?.matches ?? false);
export function applyAppearance(): void {
  applied = paintAppearance(document.documentElement, current, shownScheme(), preview, applied);
}
function notify(): void {
  for (const listener of listeners) listener();
}
function refresh(): void {
  // Suppress color transitions for one frame; a theme flip is a single visual change.
  const root = document.documentElement;
  root.dataset.themeSwitching = "true";
  cancelAnimationFrame(transitionFrame);
  applyAppearance();
  void root.offsetHeight;
  transitionFrame = requestAnimationFrame(() => {
    delete root.dataset.themeSwitching;
  });
  notify();
}
/** Called before mounting React; portal content shares the same root tokens. */
export function initializeAppearance(): void {
  if (media) return;
  const saved = savedAppearance();
  current = saved.appearance;
  if (saved.unreadable) saveError = t("Saved appearance could not be read. Default themes are active.");
  media = window.matchMedia(DARK_SCHEME_QUERY);
  media.addEventListener("change", refresh);
  window.addEventListener("storage", (event) => {
    if (event.key !== APPEARANCE_KEY && event.key !== null) return;
    try {
      current = event.newValue ? normalizeAppearance(JSON.parse(event.newValue)) : structuredClone(DEFAULT_APPEARANCE);
      saveError = "";
      refresh();
    } catch {
      /* Keep the last valid appearance. */
    }
  });
  applyAppearance();
}
export function updateAppearance(update: (previous: Appearance) => Appearance): void {
  current = normalizeAppearance(update(current));
  saveError = writeText(APPEARANCE_KEY, JSON.stringify(current))
    ? ""
    : t("Changes are visible, but could not be saved. Free some disk space and try again.");
  refresh();
}
/** Show `next` instead of the saved appearance, without saving it; null returns to the saved one. */
export function previewPalette(next: PalettePreview | null): void {
  preview = next;
  refresh();
}
/** Hear every appearance change, after it is applied to the root; returns the unsubscribe. */
export function subscribeAppearance(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
const subscribe = subscribeAppearance;
export function useAppearance() {
  const appearance = useSyncExternalStore(subscribe, () => current);
  const scheme = useSyncExternalStore(subscribe, shownScheme);
  const error = useSyncExternalStore(subscribe, () => saveError);
  return { appearance, scheme, error, update: updateAppearance };
}
