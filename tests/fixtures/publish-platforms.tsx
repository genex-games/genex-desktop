/**
 * Test-owned production Publish dialog over a fake `window.studio`, for its platform rows: a game
 * made in an engine lists the web, Mac, Windows and Linux, each with what its build runs on, when it was
 * built and its size; a built app says "Coming soon" and a missing one offers "Make with agent",
 * which sends the ask to the game's chat and keeps the dialog open. A web game with no app shows no
 * rows.
 */
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import manifest from "../../src/plugins/genex/plugin.json" with { type: "json" };
import { initializeAppearance, updateAppearance } from "../../src/renderer/appearance/store.ts";
import { AppearanceMode } from "../../src/renderer/appearance/themes.ts";
import { COMPOSE_IN_CHAT_EVENT, type ComposeInChat } from "../../src/renderer/compose-in-chat.ts";
import { GenexPublishDialog } from "../../src/renderer/panels/plugins/genex/GenexPublish.tsx";
import { studio } from "../../src/renderer/state/studio.ts";
import { GenexAccountStatus } from "../../src/shared/genex-account.ts";
import type { GameProject } from "../../src/shared/game-project.ts";
import { GenexAction, GenexBuildReview, type GenexNativeRecord, type GenexPublishState } from "../../src/shared/genex.ts";
import { NativeArch } from "../../src/shared/play-native.ts";
import { CoreFact } from "../../src/shared/project-facts.ts";
import type { PluginInfo } from "../../src/shared/plugins.ts";
import {
  type PublishPlatform,
  PublishPlatformState,
  PublishTarget,
} from "../../src/shared/publish-platforms.ts";
import { fakeStudioApi } from "../helpers/fake-studio-api.ts";

const GAME = "dust-runners";
const AT = "2026-10-17T10:00:00.000Z";
const MINUTE = 60_000;
const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Missing fixture root");
const root = createRoot(rootElement);
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
async function settle(frames = 10) {
  for (let i = 0; i < frames; i++) await frame();
}

/** What the game folder holds in each scene, and how its last Publish's apps went (`apps*`). */
type Scene = "engine" | "stale" | "web" | "apps" | "appsSending" | "appsSent" | "appsFailed" | "appsOnly" | "appsHeld" | "appsReview" | "appsRejected" | "unityNoApp" | "unitySoon" | "unityOldPlugin" | "unreal";

const web = (uploads: boolean): PublishPlatform => ({
  target: PublishTarget.Web,
  state: uploads ? PublishPlatformState.Ready : PublishPlatformState.Missing,
  arch: null,
  bytes: 0,
  builtAt: null,
  uploads,
});
const mac = (state: PublishPlatformState, uploads = false): PublishPlatform => ({
  target: PublishTarget.Mac,
  state,
  arch: state === PublishPlatformState.Missing ? null : NativeArch.Universal,
  bytes: state === PublishPlatformState.Missing ? 0 : 1.4 * 1024 ** 3,
  builtAt: state === PublishPlatformState.Missing ? null : new Date(Date.now() - 5 * MINUTE).toISOString(),
  uploads,
});
const windows: PublishPlatform = {
  target: PublishTarget.Windows,
  state: PublishPlatformState.Missing,
  arch: null,
  bytes: 0,
  builtAt: null,
  uploads: false,
};
/** A Linux app: not made, or built five minutes ago and going with Publish. */
const linux = (made = false): PublishPlatform => ({
  target: PublishTarget.Linux,
  state: made ? PublishPlatformState.Ready : PublishPlatformState.Missing,
  arch: made ? NativeArch.X64 : null,
  bytes: made ? 700 * 1024 ** 2 : 0,
  builtAt: made ? new Date(Date.now() - 5 * MINUTE).toISOString() : null,
  uploads: made,
});
const sendingApps = () => [web(true), mac(PublishPlatformState.Ready, true), windows, linux(true)];
const SCENES: Record<Scene, () => PublishPlatform[]> = {
  engine: () => [web(true), mac(PublishPlatformState.Ready), windows, linux()],
  stale: () => [web(true), mac(PublishPlatformState.Stale), windows, linux()],
  web: () => [web(true), mac(PublishPlatformState.Missing), windows, linux()],
  apps: sendingApps,
  appsSending: sendingApps,
  appsSent: sendingApps,
  appsFailed: sendingApps,
  appsOnly: () => [web(false), mac(PublishPlatformState.Ready, true), windows, linux()],
  appsHeld: () => [web(false), mac(PublishPlatformState.Ready, true), windows, linux()],
  appsReview: () => [web(false), mac(PublishPlatformState.Ready, true), windows, linux()],
  appsRejected: () => [web(false), mac(PublishPlatformState.Ready, true), windows, linux()],
  unityNoApp: () => [web(false), mac(PublishPlatformState.Missing), windows, linux()],
  unitySoon: () => [web(false), mac(PublishPlatformState.Ready), windows, linux()],
  unityOldPlugin: () => [web(false), mac(PublishPlatformState.Ready, true), windows, linux()],
  unreal: () => [web(false), mac(PublishPlatformState.Missing), windows, linux()],
};

/** The publish record's apps in each scene: none sent yet, going now, on Genex, or refused. */
function appsOf(of: Scene): GenexNativeRecord {
  const record: GenexNativeRecord = { supported: true, sending: of === "appsSending", sent: [], failed: [] };
  const at = new Date().toISOString();
  if (of === "appsSent") {
    record.sent.push({ platform: "mac", arch: "universal", version: "1.0+3f2a9c1d0e4b", sizeBytes: 1, publishedAt: at });
    record.sent.push({ platform: "linux", arch: "x64", version: "1.0+9b1e44c2d0a7", sizeBytes: 1, publishedAt: at });
  }
  if (of === "appsFailed")
    record.failed.push({ platform: "mac", arch: "", error: "Couldn't get an upload token (HTTP 413)." });
  if (of === "appsHeld") {
    record.sent.push({ platform: "mac", arch: "universal", version: "1", sizeBytes: 1, publishedAt: at });
    record.listing = { state: "held", detail: null };
  }
  // Someone other than an admin sent it: Genex reviews it before players get it, or turned it down.
  if (of === "appsReview") {
    const review = GenexBuildReview.Pending;
    record.sent.push({ platform: "mac", arch: "universal", version: "1", sizeBytes: 1, publishedAt: at, review });
    record.listing = { state: "held", detail: null };
  }
  if (of === "appsRejected") {
    const review = GenexBuildReview.Rejected;
    const reviewReason = "It opens a shell.";
    record.sent.push({ platform: "mac", arch: "universal", version: "1", sizeBytes: 1, publishedAt: at, review, reviewReason });
  }
  return record;
}

let scene: Scene = "engine";
let closed = 0;
const composed: ComposeInChat[] = [];
window.addEventListener(COMPOSE_IN_CHAT_EVENT, (event) => composed.push((event as CustomEvent<ComposeInChat>).detail));
const state = (): GenexPublishState => ({
  version: 1,
  project: GAME,
  connected: true,
  slug: GAME,
  status: "draft",
  // A Genex plugin from before apps answers no record of them.
  ...(scene === "unityOldPlugin" ? {} : { native: appsOf(scene) }),
});
const fake = fakeStudioApi();
fake.stub("pluginAction", async (_id, name) => (name === GenexAction.PublishStatus ? state() : {}));
fake.stub("genexPublishPlatforms", async () => SCENES[scene]());
const published: Array<{ via: string; title?: string }> = [];
fake.stub("genexPublishApps", async (_project, title) => {
  published.push({ via: "apps", ...(title ? { title } : {}) });
});
fake.stub("genexPublish", async () => {
  published.push({ via: "web" });
});
fake.stub("genexPublishReview", async () => ({ included: ["index.html"], excluded: [] }));
// The row that shares a game's assets on Play reads them too: this game has none.
fake.stub("assetLibraryStates", async () => ({ project: GAME, states: [], unread: false }));
fake.stub("projectAssets", async () => ({ project: GAME, assets: [], truncated: false, skipped: [] }));
fake.stub("assetLibrary", async () => ({ assets: [], nextCursor: null }));
window.studio = fake.api;
initializeAppearance();
const genex = { manifest, source: "bundled", enabled: true, removed: false, state: "enabled" } as unknown as PluginInfo;

/** What a person sees: each row's words and what it offers, the line under them, and their place. */
function sample() {
  const content = document.querySelector<HTMLElement>('[data-testid="genex-publish"] .genex-publish-content');
  const list = content?.querySelector<HTMLElement>("[data-genex-publish-platforms]") ?? null;
  const rows = [...(list?.querySelectorAll<HTMLElement>("[data-publish-platform]") ?? [])].map((row) => ({
    target: row.dataset.publishPlatform,
    state: row.dataset.state,
    name: row.querySelector(".genex-publish-platform-text > span:first-child")?.textContent ?? "",
    detail: row.querySelector(".genex-publish-platform-detail")?.textContent ?? "",
    size: row.querySelector(".genex-publish-platform-size")?.textContent ?? null,
    end:
      row.querySelector(".genex-publish-platform-note")?.textContent ??
      row.querySelector(".genex-publish-platform-make")?.textContent ??
      null,
  }));
  const column = content?.getBoundingClientRect();
  const overflow = [...(content?.querySelectorAll<HTMLElement>("*") ?? [])].some(
    (el) => column !== undefined && el.getBoundingClientRect().right > column.right + 0.5,
  );
  const order = [
    ...(content?.querySelectorAll<HTMLElement>("[data-genex-publish-platforms], .genex-publish-primary") ?? []),
  ].map((el) => (el.matches("[data-genex-publish-platforms]") ? "platforms" : "primary"));
  const details = [...(list?.querySelectorAll<HTMLElement>(".genex-publish-platform-detail") ?? [])];
  return {
    listed: Boolean(list),
    rows,
    reach: list?.querySelector(".genex-publish-reach")?.textContent ?? null,
    primary: document.querySelector<HTMLElement>(".genex-publish-primary")?.textContent ?? null,
    primaryDisabled: document.querySelector<HTMLButtonElement>(".genex-publish-primary")?.disabled ?? null,
    hint: content?.querySelector(":scope > .genex-publish-hint")?.textContent ?? null,
    published: [...published],
    failures: [...(list?.querySelectorAll<HTMLElement>(".genex-publish-platform-failure") ?? [])].map(
      (line) => line.textContent ?? "",
    ),
    oneLine: details.every((el) => el.scrollHeight <= Math.ceil(parseFloat(getComputedStyle(el).lineHeight)) + 1),
    order,
    overflow,
    closed,
    composed: [...composed],
  };
}

/** A game made in Unity or Unreal, as the library knows it: its engine and the fact it was found by. */
const engineOf = (fact: CoreFact) => ({
  engine: { id: fact === CoreFact.UnrealProject ? "unreal" : "unity", project: "." },
  facts: [{ id: fact, path: "." }],
});

/** Open the dialog in `theme` on the scene's game: made in an engine unless the scene is a web game. */
async function open(options: { theme?: "dark" | "light"; scene?: Scene } = {}) {
  const mode = options.theme === "light" ? AppearanceMode.Light : AppearanceMode.Dark;
  updateAppearance((appearance) => ({ ...appearance, mode }));
  scene = options.scene ?? "engine";
  closed = 0;
  composed.length = 0;
  published.length = 0;
  studio().people.setState((people) => ({ ...people, account: GenexAccountStatus.SignedIn }), true);
  const engine = scene === "web" ? {} : engineOf(scene === "unreal" ? CoreFact.UnrealProject : CoreFact.UnityProject);
  const game = { name: GAME, title: "Dust Runners", createdAt: AT, ...engine } as unknown as GameProject;
  studio().library.setState((library) => ({ ...library, games: [game] }), true);
  flushSync(() => root.render(null));
  await settle(2);
  flushSync(() =>
    root.render(
      <GenexPublishDialog
        plugin={genex}
        project={GAME}
        onClose={() => {
          closed += 1;
        }}
      />,
    ),
  );
  for (let i = 0; i < 100 && !document.querySelector("[data-genex-publish-status]"); i++) await frame();
  for (let i = 0; i < 60 && scene !== "web" && !document.querySelector("[data-genex-publish-platforms]"); i++) await frame();
  await settle();
  return sample();
}

/** Press the main button, as a person would, and let the press settle. */
async function press() {
  document.querySelector<HTMLButtonElement>(".genex-publish-primary")?.click();
  for (let i = 0; i < 100 && published.length === 0; i++) await frame();
  await settle();
  return sample();
}

/** Press a row's Make with agent. */
async function make(target: PublishTarget) {
  document.querySelector<HTMLButtonElement>(`[data-publish-platform-make="${target}"]`)?.click();
  await settle();
  return sample();
}

Object.assign(window, { platformsRig: { open, make, press, sample } });
