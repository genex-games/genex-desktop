/**
 * Test-owned production Publish dialog over a fake `window.studio`, for Allow remixing: a checkbox
 * under the press, ticked unless the person last chose otherwise, sent with the press; Rights turns
 * the dialog to what remixers can do and back, keeping the tick; a project that could not go says
 * why; an older Genex that can't send a project shows no checkbox.
 */
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import manifest from "../../src/plugins/genex/plugin.json" with { type: "json" };
import { initializeAppearance, updateAppearance } from "../../src/renderer/appearance/store.ts";
import { AppearanceMode } from "../../src/renderer/appearance/themes.ts";
import { GenexPublishDialog } from "../../src/renderer/panels/plugins/genex/GenexPublish.tsx";
import { studio } from "../../src/renderer/state/studio.ts";
import { GenexAccountStatus } from "../../src/shared/genex-account.ts";
import type { GameProject } from "../../src/shared/game-project.ts";
import { GenexAction, type GenexPublishState, type GenexRemixRecord, GenexRemixProblem } from "../../src/shared/genex.ts";
import { NativeArch } from "../../src/shared/play-native.ts";
import { CoreFact } from "../../src/shared/project-facts.ts";
import type { PluginInfo } from "../../src/shared/plugins.ts";
import { type PublishPlatform, PublishPlatformState, PublishTarget } from "../../src/shared/publish-platforms.ts";
import { fakeStudioApi } from "../helpers/fake-studio-api.ts";

const GAME = "megastructure";
const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Missing fixture root");
const root = createRoot(rootElement);
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
async function settle(frames = 10) {
  for (let i = 0; i < frames; i++) await frame();
}

/** A Unity game with only apps, a web game, either after its project could not go, or with an older Genex. */
type Scene = "apps" | "web" | "tooBig" | "notSent" | "older" | "off";

const REMIX: Record<Scene, GenexRemixRecord | undefined> = {
  apps: { supported: true, sending: false },
  web: { supported: true, sending: false },
  tooBig: { supported: true, sending: false, allowed: true, problem: GenexRemixProblem.TooBig },
  notSent: { supported: true, sending: false, allowed: true, problem: GenexRemixProblem.Failed },
  older: undefined,
  off: { supported: true, sending: false, allowed: false },
};

const app = (target: typeof PublishTarget.Mac | typeof PublishTarget.Windows, bytes: number): PublishPlatform => ({
  target,
  state: PublishPlatformState.Ready,
  arch: target === PublishTarget.Mac ? NativeArch.Arm64 : NativeArch.X64,
  bytes,
  builtAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  uploads: true,
});
const appsOnly = (): PublishPlatform[] => [
  { target: PublishTarget.Web, state: PublishPlatformState.Missing, arch: null, bytes: 0, builtAt: null, uploads: false },
  app(PublishTarget.Mac, 165 * 1024 ** 2),
  app(PublishTarget.Windows, 175 * 1024 ** 2),
];

let scene: Scene = "apps";
const state = (): GenexPublishState => {
  const remix = REMIX[scene];
  return {
    version: 1,
    project: GAME,
    connected: true,
    slug: GAME,
    status: "draft",
    native: { supported: true, sending: false, sent: [], failed: [] },
    ...(remix ? { remix } : {}),
  };
};
const fake = fakeStudioApi();
fake.stub("pluginAction", async (_id, name) => (name === GenexAction.PublishStatus ? state() : {}));
fake.stub("genexPublishPlatforms", async () => (scene === "web" ? [] : appsOnly()));
const published: Array<{ via: string; remix: boolean | undefined }> = [];
fake.stub("genexPublishApps", async (_project, _title, remix) => {
  published.push({ via: "apps", remix });
});
fake.stub("genexPublish", async (_project, _review, _title, remix) => {
  published.push({ via: "web", remix });
});
fake.stub("genexPublishReview", async () => ({ included: ["index.html"], excluded: [] }));
const opened: string[] = [];
fake.stub("openUrl", async (url) => {
  opened.push(url);
  return true;
});
fake.stub("assetLibraryStates", async () => ({ project: GAME, states: [], unread: false }));
fake.stub("projectAssets", async () => ({ project: GAME, assets: [], truncated: false, skipped: [] }));
fake.stub("assetLibrary", async () => ({ assets: [], nextCursor: null }));
window.studio = fake.api;
initializeAppearance();
const genex = { manifest, source: "bundled", enabled: true, removed: false, state: "enabled" } as unknown as PluginInfo;

/** What a person sees: the checkbox and its line, why a project didn't go, the rights page, and what was sent. */
function sample() {
  const box = document.querySelector<HTMLInputElement>("[data-genex-remix-allow]");
  const line = document.querySelector<HTMLElement>(".genex-remix-line");
  const page = document.querySelector<HTMLElement>("[data-genex-remix-page]");
  const content = document.querySelector<HTMLElement>('[data-testid="genex-publish"] .genex-publish-content');
  const order = [...(content?.querySelectorAll<HTMLElement>(".genex-publish-primary, [data-genex-remix]") ?? [])].map(
    (el) => (el.matches("[data-genex-remix]") ? "remix" : "primary"),
  );
  const primary = document.querySelector<HTMLElement>(".genex-publish-primary");
  const lines = [...(content?.querySelectorAll<HTMLElement>(".genex-publish-hint, .genex-publish-reach") ?? [])];
  const isAbove = (el: HTMLElement) =>
    primary !== null && Boolean(el.compareDocumentPosition(primary) & Node.DOCUMENT_POSITION_FOLLOWING);
  return {
    above: lines.filter(isAbove).map((el) => ({ text: el.textContent ?? "", align: getComputedStyle(el).textAlign })),
    below: lines.filter((el) => !isAbove(el)).map((el) => el.textContent ?? ""),
    shown: Boolean(box),
    checked: box?.checked ?? null,
    line: line?.textContent ?? null,
    lineOneRow: line ? line.getBoundingClientRect().height <= 24 : null,
    problem: document.querySelector(".genex-remix-problem")?.textContent ?? null,
    page: page
      ? {
          title: page.querySelector("h2")?.textContent ?? "",
          headings: [...page.querySelectorAll("h3")].map((h) => h.textContent ?? ""),
          lines: [...page.querySelectorAll("p")].map((p) => p.textContent ?? ""),
        }
      : null,
    order,
    published: [...published],
    opened: [...opened],
  };
}

/** Open the dialog in `theme` on the scene's game: a Unity game with apps, unless the scene is a web game. */
async function open(options: { theme?: "dark" | "light"; scene?: Scene } = {}) {
  const mode = options.theme === "light" ? AppearanceMode.Light : AppearanceMode.Dark;
  updateAppearance((appearance) => ({ ...appearance, mode }));
  scene = options.scene ?? "apps";
  published.length = 0;
  opened.length = 0;
  studio().people.setState((people) => ({ ...people, account: GenexAccountStatus.SignedIn }), true);
  const engine =
    scene === "web"
      ? {}
      : { engine: { id: "unity", project: "." }, facts: [{ id: CoreFact.UnityProject, path: "unity" }] };
  const game = { name: GAME, title: "Megastructure", createdAt: new Date().toISOString(), ...engine } as unknown as GameProject;
  studio().library.setState((library) => ({ ...library, games: [game] }), true);
  flushSync(() => root.render(null));
  await settle(2);
  flushSync(() => root.render(<GenexPublishDialog plugin={genex} project={GAME} onClose={() => {}} />));
  for (let i = 0; i < 100 && !document.querySelector("[data-genex-publish-status]"); i++) await frame();
  for (let i = 0; i < 60 && scene !== "web" && !document.querySelector("[data-genex-publish-platforms]"); i++) await frame();
  await settle();
  return sample();
}

/** Click what `selector` names, as a person would, and let it settle. */
async function click(selector: string) {
  document.querySelector<HTMLElement>(selector)?.click();
  await settle();
  return sample();
}

/** Press the main button and wait for what it sent. */
async function press() {
  const before = published.length;
  document.querySelector<HTMLButtonElement>(".genex-publish-primary")?.click();
  for (let i = 0; i < 100 && published.length === before; i++) await frame();
  await settle();
  return sample();
}

Object.assign(window, {
  remixRig: {
    open,
    press,
    sample,
    toggle: () => click("[data-genex-remix-allow]"),
    rights: () => click("[data-genex-remix-rights]"),
    back: () => click('[data-genex-remix-page] button[aria-label="Back to Publish"]'),
    terms: () => click("[data-genex-remix-page] .genex-remix-terms"),
  },
});
