/**
 * Test-owned production Publish dialog over a fake `window.studio`, for the Publish card of a game
 * made in an engine (canvas "Publish to every platform", round 4): an Unreal game on a Mac whose Mac
 * app is made here and whose Windows app Genex Cloud builds, and a Unity game with all four platforms.
 * Each scene is a moment of the card: apps older than the game, built, building, done, failed, a first
 * publish, a switch turned off, and the rows while the folder is still read.
 */
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import manifest from "../../src/plugins/genex/plugin.json" with { type: "json" };
import { initializeAppearance, updateAppearance } from "../../src/renderer/appearance/store.ts";
import { AppearanceMode } from "../../src/renderer/appearance/themes.ts";
import { COMPOSE_IN_CHAT_EVENT, type ComposeInChat } from "../../src/renderer/compose-in-chat.ts";
import { GenexPublishDialog } from "../../src/renderer/panels/plugins/genex/GenexPublish.tsx";
import { studio } from "../../src/renderer/state/studio.ts";
import type { GameProject } from "../../src/shared/game-project.ts";
import { GenexAccountStatus } from "../../src/shared/genex-account.ts";
import {
  CloudBuildFailure,
  CloudBuildState,
  GenexAction,
  type GenexCloudBuild,
  type GenexNativeRecord,
  type GenexPublishState,
} from "../../src/shared/genex.ts";
import { GenexGameReview, type GenexReviewStatus } from "../../src/shared/genex-review.ts";
import { NativeArch } from "../../src/shared/play-native.ts";
import type { PluginInfo } from "../../src/shared/plugins.ts";
import { CoreFact } from "../../src/shared/project-facts.ts";
import { type PublishPlatform, PublishPlatformState, PublishTarget } from "../../src/shared/publish-platforms.ts";
import { UiEvent } from "../../src/shared/ui-events.ts";
import { fakeStudioApi } from "../helpers/fake-studio-api.ts";

const GAME = "genex-strike";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Missing fixture root");
const root = createRoot(rootElement);
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
async function settle(frames = 10) {
  for (let i = 0; i < frames; i++) await frame();
}

/** The moments of the card. */
type Scene = "old" | "built" | "building" | "done" | "failed" | "sendFailed" | "first" | "unity" | "loading";

const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();
const CHANGED = (): string => ago(HOUR);

/** A folder row. */
function row(target: PublishTarget, state: PublishPlatformState, builtAgo: number | null = null): PublishPlatform {
  const built = state !== PublishPlatformState.Missing && target !== PublishTarget.Web;
  return {
    target,
    state,
    arch: built ? (target === PublishTarget.Mac ? NativeArch.Universal : NativeArch.X64) : null,
    bytes: built ? 3.2 * 1024 ** 3 : 0,
    builtAt: built && builtAgo !== null ? ago(builtAgo) : null,
    uploads: state === PublishPlatformState.Ready,
    changedAt: CHANGED(),
  };
}
const { Ready, Stale, Missing } = PublishPlatformState;
const unreal = (mac: PublishPlatformState, builtAgo: number): PublishPlatform[] => [
  row(PublishTarget.Web, Missing),
  row(PublishTarget.Mac, mac, builtAgo),
  row(PublishTarget.Windows, Missing),
  row(PublishTarget.Linux, Missing),
];

const PLATFORMS: Record<Scene, () => PublishPlatform[]> = {
  old: () => unreal(Stale, 2 * DAY),
  // Built after the agent was asked in `old`: the new Mac app has landed.
  built: () => unreal(Ready, 0),
  building: () => unreal(Ready, 30 * MINUTE),
  done: () => unreal(Ready, 30 * MINUTE),
  failed: () => unreal(Ready, 30 * MINUTE),
  sendFailed: () => unreal(Ready, 10 * MINUTE),
  first: () => unreal(Ready, 10 * MINUTE),
  loading: () => unreal(Ready, 30 * MINUTE),
  unity: () => [
    row(PublishTarget.Web, Ready),
    row(PublishTarget.Mac, Ready, 50 * MINUTE),
    row(PublishTarget.Windows, Ready, 5 * MINUTE),
    row(PublishTarget.Linux, Missing),
  ],
};

const cloud = (state: CloudBuildState, startedAgo: number, extra: Partial<GenexCloudBuild> = {}): GenexCloudBuild => ({
  platform: "windows",
  jobId: `job-${startedAgo}`,
  state,
  startedAt: ago(startedAgo),
  ...(state === CloudBuildState.Done ? { finishedAt: ago(startedAgo - 20 * MINUTE) } : {}),
  ...extra,
});
const sent = (platform: string, sentAgo: number) => ({
  platform,
  arch: platform === "mac" ? "universal" : "x64",
  version: "1.4",
  sizeBytes: 1,
  publishedAt: ago(sentAgo),
});

/** The publish record's apps and Genex Cloud's Windows builds in each scene. */
function appsOf(of: Scene): GenexNativeRecord {
  const record = (sentList: ReturnType<typeof sent>[], builds: GenexCloudBuild[]): GenexNativeRecord => ({
    supported: true,
    sending: false,
    sent: sentList,
    failed: [],
    cloud: { supported: true, builds },
  });
  const COMPILE = ["Source/Strike/Weapon.cpp(88): error C2065: 'FVector': undeclared identifier", "and 3 more"];
  const records: Record<Scene, () => GenexNativeRecord> = {
    old: () => record([sent("mac", 2 * DAY)], [cloud(CloudBuildState.Done, 13 * HOUR)]),
    built: () => record([sent("mac", 2 * DAY)], [cloud(CloudBuildState.Done, 13 * HOUR)]),
    building: () => record([sent("mac", 20 * MINUTE)], [cloud(CloudBuildState.Done, DAY), cloud(CloudBuildState.Building, 8 * MINUTE)]),
    done: () => record([sent("mac", 20 * MINUTE)], [cloud(CloudBuildState.Done, 40 * MINUTE)]),
    failed: () =>
      record(
        [sent("mac", 20 * MINUTE)],
        [cloud(CloudBuildState.Done, DAY), cloud(CloudBuildState.Failed, 10 * MINUTE, { failure: CloudBuildFailure.Compile, errors: COMPILE })],
      ),
    sendFailed: () => ({
      ...record([], [cloud(CloudBuildState.Done, 40 * MINUTE)]),
      failed: [{ platform: "mac", arch: "universal", error: "Couldn't get an upload token (HTTP 413)." }],
    }),
    first: () => record([], []),
    loading: () => record([sent("mac", 20 * MINUTE)], [cloud(CloudBuildState.Done, 40 * MINUTE)]),
    unity: () => record([sent("mac", 40 * MINUTE)], []),
  };
  return records[of]();
}

let scene: Scene = "old";
/** The agent's Mac build has landed in the folder while the card stays open (`land`). */
let landed = false;
/**
 * The game each scene opens: the Mac app the agent builds in `old` lands in `built`, so those two share
 * one game (the card remembers its ask per game); every other scene is a game of its own.
 */
let game = GAME;
const composed: ComposeInChat[] = [];
window.addEventListener(COMPOSE_IN_CHAT_EVENT, (event) => composed.push((event as CustomEvent<ComposeInChat>).detail));
const onGenex = (): boolean => scene !== "first";
const state = (): GenexPublishState => ({
  version: 1,
  project: game,
  connected: true,
  ...(onGenex()
    ? { slug: game, status: "published", galleryUrl: `https://genex.games/${GAME}`, lastPublishAt: ago(40 * MINUTE) }
    : {}),
  native: appsOf(scene),
  ...(scene === "unity" ? { hostedWeb: true } : {}),
});
/** What the card asked of Genex and main: the actions, publishes and Genex Cloud builds. */
const asked: string[] = [];
const fake = fakeStudioApi();
fake.stub("pluginReview", async (_id, name) => {
  asked.push(`review:${name}`);
  return { ticket: "fixture-ticket" };
});
fake.stub("pluginAction", async (_id, name, args) => {
  if (name === GenexAction.PublishStatus) return state();
  asked.push(`${name}${args && typeof args === "object" && "platform" in args ? `:${String(args.platform)}` : ""}`);
  return {};
});
/** While the scene is `loading`, the folder's read waits until `release`. */
let release: () => void = () => {};
fake.stub("genexPublishPlatforms", async () => {
  if (scene === "loading") await new Promise<void>((resolve) => (release = resolve));
  return landed ? PLATFORMS.built() : PLATFORMS[scene]();
});
fake.stub("genexPublishApps", async (_project, _title, _remix, platforms) => {
  asked.push(`apps:${(platforms ?? []).join("+")}`);
});
fake.stub("genexPublish", async (_project, _review, _title, _remix, _replace, platforms) => {
  asked.push(`web:${(platforms ?? []).join("+")}`);
});
fake.stub("genexCloudBuild", async (_project, platform) => {
  asked.push(`cloud:${platform}`);
});
fake.stub("genexPublishReview", async () => ({ included: ["index.html"], excluded: [] }));
const NOTHING: GenexReviewStatus = {
  record: { state: GenexGameReview.NotPublished, apps: [], takedown: null },
  checkedAt: null,
  connected: true,
  open: false,
  fingerprint: "",
  told: null,
  publishing: false,
};
fake.stub("genexReviewStatus", async () => NOTHING);
fake.stub("assetLibraryStates", async () => ({ project: game, states: [], unread: false }));
fake.stub("projectAssets", async () => ({ project: game, assets: [], truncated: false, skipped: [] }));
fake.stub("assetLibrary", async () => ({ assets: [], nextCursor: null }));
window.studio = fake.api;
document.documentElement.dataset.platform = "darwin";
initializeAppearance();
const genex = { manifest, source: "bundled", enabled: true, removed: false, state: "enabled" } as unknown as PluginInfo;

/** What a person sees on the card: each row, the button, the line under it, and what was asked. */
function sample() {
  const content = document.querySelector<HTMLElement>('[data-testid="genex-publish"] .genex-publish-content');
  const rows = [...(content?.querySelectorAll<HTMLElement>("[data-genex-publish-platforms] [data-publish-platform]") ?? [])].map(
    (one) => ({
      target: one.dataset.publishPlatform,
      tone: one.dataset.tone,
      on: one.dataset.on === "true",
      name: one.querySelector(".genex-publish-card-text > span:first-child")?.textContent ?? "",
      status: one.querySelector("[data-publish-platform-status]")?.textContent ?? "",
      side: one.querySelector(".genex-publish-card-side")?.textContent ?? null,
      clock: one.querySelector("[data-publish-platform-clock]")?.textContent ?? null,
      switch: Boolean(one.querySelector('[role="switch"]')),
    }),
  );
  const primary = document.querySelector<HTMLButtonElement>(".genex-publish-primary");
  const column = content?.getBoundingClientRect();
  const overflow = [...(content?.querySelectorAll<HTMLElement>("*") ?? [])].some(
    (el) => column !== undefined && el.getBoundingClientRect().right > column.right + 0.5,
  );
  return {
    loading: Boolean(content?.querySelector("[data-publish-card-loading]")),
    rows,
    primary: primary?.textContent ?? null,
    primaryDisabled: primary?.disabled ?? null,
    warn: primary?.dataset.warn === "true",
    note: content?.querySelector(".genex-publish-card-note")?.textContent ?? null,
    blocks: [...(content?.querySelectorAll<HTMLElement>("[data-publish-error]") ?? [])].map((block) => ({
      target: block.dataset.publishError,
      text: block.textContent ?? "",
      sent: block.hasAttribute("data-sent"),
      send: Boolean(block.querySelector("[data-publish-error-send]")),
      retry: Boolean(block.querySelector("[data-publish-error-retry]")),
      copy: Boolean(block.querySelector("[data-publish-error-copy]")),
    })),
    link: content?.querySelector("[data-public]")?.textContent ?? null,
    share: Boolean(content?.querySelector(".genex-publish-share, [data-publish-share]")),
    text: content?.textContent ?? "",
    asked: [...asked],
    composed: [...composed],
    overflow,
  };
}

/** Open the dialog in `theme` on the scene's game. */
async function open(options: { theme?: "dark" | "light"; scene?: Scene } = {}) {
  updateAppearance((appearance) => ({
    ...appearance,
    mode: options.theme === "light" ? AppearanceMode.Light : AppearanceMode.Dark,
  }));
  scene = options.scene ?? "old";
  landed = false;
  game = scene === "old" || scene === "built" ? GAME : `${GAME}-${scene}`;
  asked.length = 0;
  composed.length = 0;
  studio().people.setState((people) => ({ ...people, account: GenexAccountStatus.SignedIn }), true);
  const fact = scene === "unity" ? CoreFact.UnityProject : CoreFact.UnrealProject;
  const listed = {
    name: game,
    title: scene === "unity" ? "Moon Garden" : "genex-strike",
    createdAt: ago(10 * DAY),
    engine: { id: scene === "unity" ? "unity" : "unreal", project: "." },
    facts: [{ id: fact, path: "." }],
  } as unknown as GameProject;
  studio().library.setState((library) => ({ ...library, games: [listed] }), true);
  flushSync(() => root.render(null));
  await settle(2);
  flushSync(() => root.render(<GenexPublishDialog plugin={genex} project={game} onClose={() => {}} />));
  for (let i = 0; i < 100 && !document.querySelector("[data-genex-publish-status]"); i++) await frame();
  const ready = () => document.querySelector("[data-genex-publish-platforms], [data-publish-card-loading]");
  for (let i = 0; i < 100 && !ready(); i++) await frame();
  await settle();
  return sample();
}

/** The folder's read answers (the `loading` scene). */
async function answer() {
  release();
  for (let i = 0; i < 100 && !document.querySelector("[data-genex-publish-platforms]"); i++) await frame();
  await settle();
  return sample();
}

/** Turn a row's switch. */
async function toggle(target: PublishTarget) {
  document.querySelector<HTMLButtonElement>(`[data-publish-platform="${target}"] [role="switch"]`)?.click();
  await settle();
  return sample();
}

/** Press the card's button. */
async function press() {
  document.querySelector<HTMLButtonElement>(".genex-publish-primary")?.click();
  for (let i = 0; i < 60 && asked.length === 0 && composed.length === 0; i++) await frame();
  await settle();
  return sample();
}

/**
 * The agent's Mac build lands in the folder while the card stays open, and the agent's turn ends: the
 * card is never reopened, and waits at most `wait` frames for the row to change.
 */
async function land(wait = 120) {
  landed = true;
  fake.emit({ type: UiEvent.ChatStreamEnded, payload: { threadId: "t1", streamId: "s1" } });
  const status = () =>
    document.querySelector(`[data-publish-platform="mac"] [data-publish-platform-status]`)?.textContent ?? "";
  for (let i = 0; i < wait && status().startsWith("Building"); i++) await frame();
  await settle();
  return sample();
}

/** Press an error block's Send to agent, Try again or Copy (`send`, `retry`, `copy`). */
async function block(which: "send" | "retry" | "copy") {
  document.querySelector<HTMLButtonElement>(`[data-publish-error-${which}]`)?.click();
  for (let i = 0; i < 30 && asked.length === 0 && composed.length === 0; i++) await frame();
  await settle();
  return sample();
}

Object.assign(window, { cardRig: { open, answer, toggle, press, sample, land, block } });
