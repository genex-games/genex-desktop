/**
 * The chat header's place for the open game's engine button (`ToolbarPlace.Header`). The stage's
 * toolbar keeps owning the button, its status, panels and approvals, and draws it there through a
 * portal; the header only offers the place. While no header offers one, the button stays on the strip.
 */
import { useSyncExternalStore } from "react";

let slot: HTMLElement | null = null;
const listeners = new Set<() => void>();

/** The header's place, or null while no chat header offers one. */
export const engineSlot = (): HTMLElement | null => slot;

/** The header offers its place (a ref callback), or takes it back with null. */
export function setEngineSlot(element: HTMLElement | null): void {
  if (slot === element) return;
  slot = element;
  for (const changed of listeners) changed();
}

/** Calls `changed` whenever the place comes or goes; returns the unsubscribe. */
export function subscribeEngineSlot(changed: () => void): () => void {
  listeners.add(changed);
  return () => listeners.delete(changed);
}

/** The header's place as React state. */
export const useEngineSlot = (): HTMLElement | null => useSyncExternalStore(subscribeEngineSlot, engineSlot);
