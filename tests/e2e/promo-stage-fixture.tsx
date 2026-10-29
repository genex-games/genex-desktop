/**
 * The Genex promo card over Live's slot, with the real bounds hook (`native-bounds.ts`) over a fake
 * host API: `previewBounds` records where the web view is sent, and `previewCoverStill` answers a
 * new frame of a stand-in game on every call, as a page that keeps drawing would. A dialog stands
 * in for anything that rests the game. `run-promo-stage-ui.mjs` drives it.
 */
import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { initializeAppearance, updateAppearance } from "../../src/renderer/appearance/store.ts";
import { PromoPhase } from "../../src/renderer/genex-promo.ts";
import { GenexPromoCard } from "../../src/renderer/panels/GenexPromo.tsx";
import { type StageCover, useNativeViewBounds } from "../../src/renderer/panels/stage/native-bounds.ts";
import { SessionStatus } from "../../src/renderer/state/session.ts";
import { studio } from "../../src/renderer/state/studio.ts";
import { StudioPlatform } from "../../src/shared/boot.ts";
import { fakeStudioApi } from "../helpers/fake-studio-api.ts";

/** One `previewBounds` call as the fake host heard it. */
interface SentBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

const sent: SentBounds[] = [];
let frame = 0;

/** The stand-in game's next frame: a counter on its own colour, as the page would draw it. */
function nextFrame(): string {
  frame += 1;
  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 240;
  const context = canvas.getContext("2d");
  if (!context) return "";
  context.fillStyle = "#14233b";
  context.fillRect(0, 0, 320, 240);
  context.fillStyle = "#43ddaa";
  context.fillRect(20 + (frame % 20) * 12, 60, 60, 60);
  context.fillStyle = "white";
  context.font = "28px sans-serif";
  context.fillText(`frame ${frame}`, 20, 200);
  return canvas.toDataURL("image/png");
}

document.documentElement.dataset.platform = StudioPlatform.Mac;
const fake = fakeStudioApi({
  previewBounds: async (bounds) => {
    sent.push({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height });
    return true;
  },
  previewCoverStill: async () => nextFrame(),
});
window.studio = fake.api;
studio().session.setState({ status: SessionStatus.Ready, welcoming: false });
initializeAppearance();

/** What the stage shows: the promo card, and a dialog over everything. */
interface Scene {
  promo: boolean;
  dialog: boolean;
}
let show: (scene: Scene) => void = () => {};
Object.assign(window, {
  test: {
    show: (scene: Scene) => show(scene),
    theme: (mode: "light" | "dark") => updateAppearance((previous) => ({ ...previous, mode })),
    /** Every rectangle sent to the host so far, and the newest. */
    bounds: () => ({ all: sent, last: sent.at(-1) ?? null }),
    /** How many frames the host has handed the slot. */
    frames: () => frame,
  },
});

const COVER: StageCover = {
  project: "my-first-game",
  visible: true,
  sidebarOverlay: false,
  buildsOpen: false,
  assetsOpen: false,
  fileOpen: false,
  showEmpty: false,
  liveLoading: false,
  toolbarOpen: false,
  cardOnStage: false,
  pluginCardOnStage: false,
  stillsOnStage: false,
  stopped: false,
  watching: true,
  native: false,
};

function Fixture() {
  const [scene, setScene] = useState<Scene>({ promo: false, dialog: false });
  show = setScene;
  const slot = useRef<HTMLDivElement | null>(null);
  useNativeViewBounds(slot, COVER);
  return (
    <div className="flex h-screen bg-canvas">
      <div className="w-[300px] shrink-0 border-r border-line p-4 text-ink-2">Chat</div>
      <div ref={slot} data-fixture-slot className="relative m-3 flex-1 rounded-card bg-inset" />
      {scene.promo ? (
        <GenexPromoCard
          phase={PromoPhase.Offer}
          busy={false}
          closing={false}
          onConnect={() => {}}
          onCancel={() => {}}
          onClose={() => setScene((now) => ({ ...now, promo: false }))}
        />
      ) : null}
      {scene.dialog ? (
        <div
          data-slot="dialog-content"
          className="fixed top-1/3 left-1/3 w-[320px] rounded-card bg-surface p-6 shadow-overlay"
        >
          A dialog
        </div>
      ) : null}
    </div>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<Fixture />);
