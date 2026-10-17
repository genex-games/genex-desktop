/**
 * Home's background settings, remembered on this Mac: Settings changes them, home and the Settings
 * preview draw them. A preference like the appearance, so it lives beside it rather than in a
 * domain store.
 */
import { useEffect, useSyncExternalStore } from "react";
import { browserStorage, type KeyValueStorage, readText, STORAGE_KEYS, writeText } from "../storage.ts";
import { type BackdropSettings, DEFAULT_BACKDROP, normalizeBackdrop } from "./settings.ts";

let current: BackdropSettings | null = null;
const listeners = new Set<() => void>();

/** The saved settings, read once; anything unreadable is the default. */
function settings(): BackdropSettings {
  if (current) return current;
  try {
    current = normalizeBackdrop(JSON.parse(readText(STORAGE_KEYS.homeBackdrop) ?? "null"));
  } catch {
    current = normalizeBackdrop(DEFAULT_BACKDROP);
  }
  return current;
}

/** Change the settings, show the change everywhere, and remember it. */
export function updateBackdrop(update: (previous: BackdropSettings) => BackdropSettings): void {
  current = normalizeBackdrop(update(settings()));
  writeText(STORAGE_KEYS.homeBackdrop, JSON.stringify(current));
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The settings now, outside a component. */
export function backdropNow(): BackdropSettings {
  return settings();
}

/** The current settings, kept up to date. */
export function useBackdrop(): BackdropSettings {
  return useSyncExternalStore(subscribe, settings);
}

/** Previews of home on screen: while one is, it follows a slider and home waits for the slider. */
let previews = 0;
const previewListeners = new Set<() => void>();
function previewsChanged(change: number): void {
  previews += change;
  for (const listener of previewListeners) listener();
}
function subscribePreviews(listener: () => void): () => void {
  previewListeners.add(listener);
  return () => {
    previewListeners.delete(listener);
  };
}

/** Count a preview of home as on screen while `shown`. */
export function useBackdropPreview(shown: boolean): void {
  useEffect(() => {
    if (!shown) return;
    previewsChanged(1);
    return () => previewsChanged(-1);
  }, [shown]);
}

/** Whether a preview of home is on screen. */
export function useBackdropPreviewShown(): boolean {
  return useSyncExternalStore(subscribePreviews, () => previews > 0);
}

/**
 * Whether home's Background panel has been opened on this Mac: until it has, its button glints now
 * and then. Where nothing can be remembered it never glints, so it cannot glint for ever.
 */
export function backdropButtonFound(storage: KeyValueStorage | null = browserStorage()): boolean {
  return !storage || readText(STORAGE_KEYS.homeBackdropFound, storage) === "1";
}

/** Remember that the Background panel has been opened. */
export function markBackdropButtonFound(storage: KeyValueStorage | null = browserStorage()): void {
  writeText(STORAGE_KEYS.homeBackdropFound, "1", storage);
}
