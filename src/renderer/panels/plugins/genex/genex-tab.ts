/**
 * The Genex plugin page's tab (Tools, which holds the account, and Credits), and the way other
 * places open the page on one: the account menu's Credits row opens Credits, Settings' note on what
 * credits pay for opens Tools. The tab is kept for the window's life, so the page reopens where it was left.
 */
import { useSyncExternalStore } from "react";
import { GENEX_PLUGIN_ID } from "../../../../shared/genex.ts";
import { OPEN_PLUGINS_EVENT } from "../../../ui/ComposerAddMenu.tsx";

/** The Genex plugin page's tabs. Their `data-genex-tab` values. */
export const GenexTab = { Tools: "tools", Credits: "credits" } as const;
export type GenexTab = (typeof GenexTab)[keyof typeof GenexTab];
/** The tabs in the order the page shows them. */
export const GENEX_TABS: readonly GenexTab[] = Object.values(GenexTab);

let current: GenexTab = GenexTab.Tools;
const listeners = new Set<() => void>();

/** Show `tab` on the Genex page (now, or when it next opens). */
export function chooseGenexTab(tab: GenexTab): void {
  if (current === tab) return;
  current = tab;
  for (const listener of listeners) listener();
}

/** Listen for the tab changing; the stop that `useSyncExternalStore` keeps. */
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The tab now. */
const shownTab = (): GenexTab => current;

/** The tab the Genex page shows. */
export function useGenexTab(): GenexTab {
  return useSyncExternalStore(subscribe, shownTab);
}

/** Open Plugins on the Genex plugin's page, at `tab`. */
export function openGenexPage(tab: GenexTab = GenexTab.Tools): void {
  chooseGenexTab(tab);
  window.dispatchEvent(new CustomEvent(OPEN_PLUGINS_EVENT, { detail: { plugin: GENEX_PLUGIN_ID } }));
}
