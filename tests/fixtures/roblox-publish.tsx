/**
 * Test-owned production Publish card for a Roblox game over a fake `window.studio`: the press hands
 * the publish to the agent (the Roblox plugin's first-publish or publish-update, with the name for a
 * first one), and the card follows `publish-status` through publishing to Roblox or a stop; a game
 * with no place offers setup, and where Genex can't click it gives Studio's own clicks.
 */
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { initializeAppearance, updateAppearance } from "../../src/renderer/appearance/store.ts";
import { AppearanceMode } from "../../src/renderer/appearance/themes.ts";
import { RobloxPublishDialog } from "../../src/renderer/panels/plugins/roblox/RobloxPublish.tsx";
import {
  type RobloxPublishAnswer,
  RobloxPublishAction,
  RobloxPublishKind,
  RobloxPublishPhase,
  type RobloxPublishState,
} from "../../src/shared/roblox-publish.ts";
import { fakeStudioApi } from "../helpers/fake-studio-api.ts";

const GAME = "sky-race";
const PLACE_ID = "7781440219";
const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Missing fixture root");
const root = createRoot(rootElement);
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
async function settle(frames = 10) {
  for (let i = 0; i < frames; i++) await frame();
}

/** Where the game stands as the scene opens. */
type Scene = "first" | "update" | "publishing" | "published" | "stopped" | "noPlace" | "byHand" | "refused";

const SCENES: Record<Scene, () => RobloxPublishState> = {
  first: () => ({ linked: true, published: false, canClick: true, name: "Sky Race" }),
  update: () => ({ linked: true, published: true, canClick: true, placeId: PLACE_ID }),
  publishing: () => ({
    linked: true,
    published: true,
    canClick: true,
    placeId: PLACE_ID,
    attempt: { phase: RobloxPublishPhase.Publishing, kind: RobloxPublishKind.Update, at: Date.now() - 20_000 },
  }),
  published: () => ({
    linked: true,
    published: true,
    canClick: true,
    placeId: PLACE_ID,
    attempt: { phase: RobloxPublishPhase.Published, kind: RobloxPublishKind.First, at: Date.now() - 60_000, name: "Sky Racers" },
  }),
  stopped: () => ({
    linked: true,
    published: true,
    canClick: true,
    placeId: PLACE_ID,
    attempt: {
      phase: RobloxPublishPhase.Stopped,
      kind: RobloxPublishKind.Update,
      at: Date.now() - 60_000,
      detail: "Roblox asks you to verify your age in Studio's Publish window. Answer it there, then try again.",
    },
  }),
  noPlace: () => ({ linked: false, published: false, canClick: true }),
  byHand: () => ({ linked: true, published: false, canClick: false, name: "Sky Race" }),
  refused: () => ({ linked: true, published: true, canClick: true, placeId: PLACE_ID }),
};

let scene: Scene = "first";
let current: RobloxPublishState = SCENES.first();
const sent: Array<{ name: string; args: unknown }> = [];
const opened: string[] = [];
const fake = fakeStudioApi();
fake.stub("pluginAction", async (_id, name, args) => {
  if (name === RobloxPublishAction.PublishStatus) return current;
  sent.push({ name, args });
  if (scene === "refused")
    return {
      started: false,
      message: "The person said no to computer control, so nothing was published.",
      clickPath: "File › Publish to Roblox",
    } satisfies RobloxPublishAnswer;
  // The chat took it: the card now follows the publish under way.
  const kind = name === RobloxPublishAction.FirstPublish ? RobloxPublishKind.First : RobloxPublishKind.Update;
  const named = (args as { name?: string }).name;
  current = {
    ...current,
    attempt: { phase: RobloxPublishPhase.Publishing, kind, at: Date.now(), ...(named ? { name: named } : {}) },
  };
  return { started: true, message: "Publishing." } satisfies RobloxPublishAnswer;
});
fake.stub("openUrl", async (url) => {
  opened.push(url);
  return true;
});
window.studio = fake.api;
initializeAppearance();

/** What a person sees on the card, and what it sent. */
function sample() {
  const card = document.querySelector<HTMLElement>('[data-testid="roblox-publish"]');
  const primary = card?.querySelector<HTMLButtonElement>(".genex-publish-primary");
  return {
    stage: card?.querySelector<HTMLElement>("[data-roblox-publish-stage]")?.dataset.robloxPublishStage ?? null,
    title: card?.querySelector("h2")?.textContent ?? null,
    primary: primary ? { text: primary.textContent ?? "", disabled: primary.disabled } : null,
    name: card?.querySelector<HTMLInputElement>("[data-roblox-publish-name]")?.value ?? null,
    hints: [...(card?.querySelectorAll<HTMLElement>(".genex-publish-hint") ?? [])].map((el) => el.textContent ?? ""),
    alerts: [...(card?.querySelectorAll<HTMLElement>('[role="alert"]') ?? [])].map((el) => el.textContent ?? ""),
    steps: [...(card?.querySelectorAll<HTMLElement>(".step-bar [data-state]") ?? [])].map((el) => el.dataset.state),
    link: card?.querySelector<HTMLElement>(".genex-publish-link-field span")?.textContent ?? null,
    published: card?.querySelector<HTMLElement>("[data-roblox-published]")?.textContent ?? null,
    sent: [...sent],
    opened: [...opened],
  };
}

/** Open the card in `theme` on `scene`. */
async function open(options: { theme?: "dark" | "light"; scene?: Scene } = {}) {
  updateAppearance((appearance) => ({
    ...appearance,
    mode: options.theme === "light" ? AppearanceMode.Light : AppearanceMode.Dark,
  }));
  scene = options.scene ?? "first";
  current = SCENES[scene]();
  sent.length = 0;
  opened.length = 0;
  flushSync(() => root.render(null));
  await settle(2);
  flushSync(() => root.render(<RobloxPublishDialog project={GAME} onClose={() => {}} />));
  for (let i = 0; i < 100 && sample().stage === "loading"; i++) await frame();
  await settle();
  return sample();
}

/** Type a first publish's name, as a person would. */
async function name(value: string) {
  const input = document.querySelector<HTMLInputElement>("[data-roblox-publish-name]");
  if (!input) return sample();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
  return sample();
}

/** Press what `selector` names and let the card read again. */
async function click(selector: string) {
  document.querySelector<HTMLElement>(selector)?.click();
  for (let i = 0; i < 40; i++) await frame();
  return sample();
}

Object.assign(window, {
  robloxRig: {
    open,
    name,
    sample,
    press: () => click('[data-testid="roblox-publish"] .genex-publish-primary'),
    openLink: () => click('[data-testid="roblox-publish"] .genex-publish-link-field button'),
  },
});
