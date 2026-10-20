/**
 * The bar layer's entry (`play-bar.html`): the page main lays, transparent, over Play's game view, with
 * the studio's own preload. It draws only the viewer's bar, its Comments and a game's purchase sheet
 * (`play/PlayBarPage.tsx`), in the studio's appearance, laid out for the platform main names in its address.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { initializeAppearance } from "./appearance/store.ts";
import { PlayBarPage } from "./play/PlayBarPage.tsx";

initializeAppearance();
const root = document.documentElement;
const platform = new URLSearchParams(window.location.search).get("platform");
if (platform) root.dataset.platform = platform;

const container = document.getElementById("root");
if (!container) throw new Error("missing #root");

createRoot(container).render(
  <StrictMode>
    <PlayBarPage api={window.studio} />
  </StrictMode>,
);
