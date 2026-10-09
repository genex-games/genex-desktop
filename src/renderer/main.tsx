import { PerformanceBoundary } from "./performance.tsx";
import { PerformanceComponent } from "../shared/performance.ts";
/**
 * Renderer entry.
 *
 * Two rooms: Build (chat + the live game) and Review (what it did unattended, and what it changed
 * about itself). The renderer holds no state the log does not: it subscribes to substrate events
 * and renders them, so what you see is always a view of the agent's actual state.
 *
 * Before any of that, the window asks main where startup stands (`state/boot.ts`): the platform
 * sets `data-platform` on the root (the window chrome is laid out by it), and while the process
 * sandbox cannot start the window shows the setup screen instead of the studio.
 *
 * Styling comes from dist/renderer/theme.css (the shared Genex Tailwind system), linked by
 * index.html — there is no CSS import here for esbuild to bundle.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ErrorBoundary } from "./ErrorBoundary.tsx";
import { initializeAppearance } from "./appearance/store.ts";
import { installMotionRest } from "./motion-rest.ts";
import { BootRoot } from "./SandboxSetup.tsx";
import { createBoot } from "./state/boot.ts";
import { startStudio } from "./state/studio.ts";
import { syncWindowControls } from "./window-controls.ts";
import { MINUTE_MS } from "../shared/duration.ts";

initializeAppearance();
installMotionRest();

// React's development build (watch and owned development builds; scripts/renderer-build.mjs)
// records a User Timing measure for every component render and never clears them; drop them so
// a long session cannot fill the renderer's memory.
if (process.env.NODE_ENV !== "production") setInterval(() => performance.clearMeasures(), MINUTE_MS);
// The stores subscribe and bootstrap once, when main says the core is ready and before the studio
// mounts: StrictMode's replayed effects can then neither subscribe twice nor drop a reply.
const boot = createBoot(window.studio, { onReady: startStudio });
const unsubscribe = boot.store.subscribe(({ platform }) => {
  if (platform === null) return;
  unsubscribe();
  // An empty platform means main could not say; the window keeps the default chrome.
  if (!platform) return;
  document.documentElement.dataset.platform = platform;
  syncWindowControls(window.studio, platform);
});
void boot.load();

const container = document.getElementById("root");
if (!container) throw new Error("missing #root");

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <PerformanceBoundary id={PerformanceComponent.App}>
        <BootRoot boot={boot} />
      </PerformanceBoundary>
    </ErrorBoundary>
  </StrictMode>,
);
