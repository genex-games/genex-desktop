/**
 * Test-owned production Publish dialog over a fake `window.studio`, for the Publish card of a game
 * made in an engine (canvas "Publish to every platform", round 3 of its redesign): an Unreal game on
 * a Mac whose Mac app is made here and whose Windows app Genex Cloud builds, the same game on a PC,
 * and a Unity game with all four platforms. Each scene is a moment the card opens on: nothing built,
 * the Mac app built while Windows builds, Windows following by itself, both built, done, apps older
 * than the game, a newer one ready, a failed build, a build that didn't start, a send that failed, a
 * PC whose web build is ready while its apps are not built, and the rows while the folder is still
 * read. From there the fake Studio moves as the real one does: an ask to the agent is kept, a build
 * lands (`land`), Genex Cloud starts and finishes its build (`cloudStarts`, `cloudEnds`), a send says
 * how far it is and arrives (`arrive`), so a press of the big button can be followed to its end.
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
  CloudSendState,
  GenexAction,
  type GenexCloudBuild,
  GenexHostedStatus,
  type GenexNativeRecord,
  type GenexPublishJob,
  GenexPublishJobState,
  GenexPublishKind,
  GenexPublishPhase,
  type GenexPublishState,
  type GenexSendProgress,
  GenexSendStage,
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
type Scene =
  | "first"
  | "startFails"
  | "macBuilt"
  | "following"
  | "bothBuilt"
  | "windowsBuilt"
  | "old"
  | "built"
  | "updateReady"
  | "building"
  | "done"
  | "failed"
  | "failedFirst"
  | "sendFailed"
  | "pc"
  | "pcWeb"
  | "pcWebLive"
  | "unity"
  | "loading";

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

/** A PC's folder with a web build and no app built. */
const pcWithWeb = (): PublishPlatform[] => [
  row(PublishTarget.Web, Ready),
  row(PublishTarget.Mac, Missing),
  row(PublishTarget.Windows, Missing),
  row(PublishTarget.Linux, Missing),
];

const PLATFORMS: Record<Scene, () => PublishPlatform[]> = {
  first: () => unreal(Missing, 0),
  startFails: () => unreal(Missing, 0),
  macBuilt: () => unreal(Ready, 2 * MINUTE),
  following: () => unreal(Ready, 30 * MINUTE),
  bothBuilt: () => unreal(Ready, 40 * MINUTE),
  windowsBuilt: () => unreal(Missing, 0),
  old: () => unreal(Stale, 2 * DAY),
  // Built after the agent was asked in `old`: the new Mac app has landed.
  built: () => unreal(Ready, 0),
  updateReady: () => unreal(Ready, 2 * MINUTE),
  building: () => unreal(Ready, 30 * MINUTE),
  done: () => unreal(Ready, 30 * MINUTE),
  failed: () => unreal(Ready, 30 * MINUTE),
  failedFirst: () => unreal(Ready, 10 * MINUTE),
  sendFailed: () => unreal(Ready, 10 * MINUTE),
  pc: () => unreal(Missing, 0),
  pcWeb: () => pcWithWeb(),
  pcWebLive: () => pcWithWeb(),
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
  ...(state === CloudBuildState.Done || state === CloudBuildState.Built
    ? { finishedAt: ago(startedAgo - 20 * MINUTE) }
    : {}),
  ...extra,
});
/** A Windows app Genex Cloud built and keeps for the publish. */
const kept = (startedAgo: number): GenexCloudBuild =>
  cloud(CloudBuildState.Built, startedAgo, { held: true, installedBytes: Math.round(2.9 * 1024 ** 3) });
/** A Windows app Genex Cloud still builds and keeps. */
const keeping = (startedAgo: number): GenexCloudBuild => cloud(CloudBuildState.Building, startedAgo, { held: true });
const sent = (platform: string, sentAgo: number) => ({
  platform,
  arch: platform === "mac" ? "universal" : "x64",
  version: "1.4",
  sizeBytes: 1,
  publishedAt: ago(sentAgo),
});

/** A send that still moves: each read of the record has a progress line of that moment, as the CLI keeps saying it. */
const moving = (progress: GenexSendProgress): GenexSendProgress => ({ ...progress, at: Date.now() });

/** A build Genex Cloud keeps, once a publish asked for it: on the game's page when built, else no longer kept. */
function givenToPlayers(build: GenexCloudBuild): GenexCloudBuild {
  if (!since.released || !build.held) return build;
  const state = build.state === CloudBuildState.Built ? CloudBuildState.Done : build.state;
  return { ...build, held: false, state };
}

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
    first: () => record([], []),
    startFails: () => record([], []),
    macBuilt: () => record([], [keeping(20 * MINUTE)]),
    // Published while Genex Cloud still built it: it goes to players as soon as it is built.
    following: () => record([sent("mac", 5 * MINUTE)], [cloud(CloudBuildState.Building, 26 * MINUTE)]),
    bothBuilt: () => record([], [kept(HOUR)]),
    windowsBuilt: () => record([], [kept(HOUR)]),
    old: () => record([sent("mac", 2 * DAY)], [cloud(CloudBuildState.Done, 13 * HOUR)]),
    built: () => record([sent("mac", 2 * DAY)], [cloud(CloudBuildState.Done, 13 * HOUR)]),
    updateReady: () => record([sent("mac", 2 * DAY)], [cloud(CloudBuildState.Done, 13 * HOUR), kept(50 * MINUTE)]),
    building: () => record([sent("mac", 20 * MINUTE)], [cloud(CloudBuildState.Done, DAY), cloud(CloudBuildState.Building, 8 * MINUTE)]),
    done: () => record([sent("mac", 20 * MINUTE)], [cloud(CloudBuildState.Done, 40 * MINUTE)]),
    failed: () =>
      record(
        [sent("mac", 20 * MINUTE)],
        [cloud(CloudBuildState.Done, DAY), cloud(CloudBuildState.Failed, 10 * MINUTE, { failure: CloudBuildFailure.Compile, errors: COMPILE })],
      ),
    failedFirst: () =>
      record([], [cloud(CloudBuildState.Failed, 10 * MINUTE, { failure: CloudBuildFailure.Compile, errors: COMPILE })]),
    sendFailed: () => ({
      ...record([], [cloud(CloudBuildState.Done, 40 * MINUTE)]),
      failed: [{ platform: "mac", arch: "universal", error: "Couldn't get an upload token (HTTP 413)." }],
    }),
    pc: () => ({ ...record([], []), cloud: { supported: true, builds: [] } }),
    pcWeb: () => record([], []),
    pcWebLive: () => record([], []),
    loading: () => record([sent("mac", 20 * MINUTE)], [cloud(CloudBuildState.Done, 40 * MINUTE)]),
    unity: () => record([sent("mac", 40 * MINUTE)], []),
  };
  const made = records[of]();
  const builds = [...(made.cloud?.builds.map(givenToPlayers) ?? []), ...(since.cloudBuild ? [since.cloudBuild] : [])];
  return {
    ...made,
    sent: [...made.sent, ...since.sent],
    sending: since.sending.length > 0,
    ...(since.progress ? { progress: moving(since.progress) } : {}),
    cloud: { supported: true, builds, ...(since.cloudSend ? { send: since.cloudSend } : {}) },
  };
}

/** The scenes of a game that has no page on Genex yet. */
const NOT_ON_GENEX: ReadonlySet<Scene> = new Set([
  "first",
  "startFails",
  "macBuilt",
  "bothBuilt",
  "windowsBuilt",
  "failedFirst",
  "pc",
  "pcWeb",
]);
/** The scenes on a PC; every other is on a Mac. */
const ON_A_PC: ReadonlySet<Scene> = new Set(["pc", "pcWeb", "pcWebLive"]);
/** The scenes whose game has a web version players have. */
const WEB_LIVE: ReadonlySet<Scene> = new Set(["pcWebLive", "unity"]);
/** What Genex Cloud refuses a build with in `startFails`: never shown, only copied. */
const REFUSED = "This account has used its Genex Cloud builds for this month.";

let scene: Scene = "old";
/** How many times a scene was opened: each opens a game of its own. */
let opened = 0;

/** What happened since the scene opened, as the real Studio's folder and record would say it. */
interface Since {
  /** The builds that landed in the game's folder, by when. */
  landed: Map<PublishTarget, string>;
  /** The apps being sent now, and how far the first is. */
  sending: string[];
  progress?: GenexSendProgress;
  /** The apps that arrived. */
  sent: ReturnType<typeof sent>[];
  /** The game's project on its way to Genex Cloud since a Build, or the one that didn't arrive. */
  cloudSend?: NonNullable<GenexNativeRecord["cloud"]>["send"];
  /** The build Genex Cloud made of it since. */
  cloudBuild?: GenexCloudBuild;
  /** A publish gave players the app Genex Cloud builds: it goes to them once built. */
  released: boolean;
  /** The web publish under way. */
  web?: GenexPublishJob;
  /** The web version went live since, at this time. */
  webLiveAt?: string;
  /** What was taken off Genex. */
  down: Set<string>;
}
const fresh = (): Since => ({ landed: new Map(), sending: [], sent: [], released: false, down: new Set() });
let since = fresh();
/**
 * The game each scene opens: the Mac app the agent builds in `old` lands in `built`, so those two share
 * one game (the card remembers its ask per game); every other scene is a game of its own.
 */
let game = GAME;
const composed: ComposeInChat[] = [];
window.addEventListener(COMPOSE_IN_CHAT_EVENT, (event) => composed.push((event as CustomEvent<ComposeInChat>).detail));
const onGenex = (): boolean => !NOT_ON_GENEX.has(scene) || since.sent.length > 0 || since.webLiveAt !== undefined;
const webLive = (): boolean => (WEB_LIVE.has(scene) || since.webLiveAt !== undefined) && !since.down.has("web");
const state = (): GenexPublishState => ({
  version: 1,
  project: game,
  connected: true,
  ...(onGenex()
    ? {
        slug: game,
        status: GenexHostedStatus.Published,
        galleryUrl: `https://genex.games/${GAME}`,
        lastPublishAt: since.webLiveAt ?? ago(40 * MINUTE),
      }
    : {}),
  native: appsOf(scene),
  ...(webLive() ? { hostedWeb: true } : {}),
  ...(since.web ? { job: { ...since.web, ...(since.web.progress ? { progress: moving(since.web.progress) } : {}) } } : {}),
});
/** The folder as it is now: the scene's, with every build that landed since. */
const folder = (): PublishPlatform[] =>
  PLATFORMS[scene]().map((one) => {
    const at = since.landed.get(one.target);
    return at ? { ...row(one.target, Ready, 0), builtAt: at } : one;
  });
/** What the card asked of Genex and main: the actions, publishes and Genex Cloud builds. */
const asked: string[] = [];
const fake = fakeStudioApi();
fake.stub("pluginReview", async (_id, name) => {
  asked.push(`review:${name}`);
  return { ticket: "fixture-ticket" };
});
/** A game the dialog isn't open on has nothing: the follow of an earlier scene's press ends by itself. */
const NO_GAME: GenexPublishState = { version: 1, project: "", connected: true };
fake.stub("pluginAction", async (_id, name, args, project) => {
  if (name === GenexAction.PublishStatus) return project === game ? state() : NO_GAME;
  const platform = args && typeof args === "object" && "platform" in args ? String(args.platform) : "";
  asked.push(`${name}${platform ? `:${platform}` : ""}`);
  if (name === GenexAction.PublishRemoveWeb) since.down.add("web");
  return {};
});
/** While the scene is `loading`, the folder's read waits until `release`. */
let release: () => void = () => {};
fake.stub("genexPublishPlatforms", async (project) => {
  if (project !== game) return [];
  if (scene === "loading") await new Promise<void>((resolve) => (release = resolve));
  return folder();
});
/** How far the app being sent is, as the Genex CLI says it. */
const uploading = (target: string, part: number): GenexSendProgress => ({
  stage: GenexSendStage.Upload,
  doneBytes: Math.round(part * 3.2 * 1024 ** 3),
  totalBytes: Math.round(3.2 * 1024 ** 3),
  at: Date.now(),
  bytesPerSecond: 16 * 1024 ** 2,
  target,
});
fake.stub("genexPublishApps", async (_project, _title, _remix, platforms, release) => {
  asked.push(`apps:${(platforms ?? []).join("+")}`);
  if (release?.length) asked.push(`release:${release.join("+")}`);
  // The record says at once that the apps are on their way, and that Genex Cloud's goes to players once built.
  since.sending = [...(platforms ?? [])];
  const [first] = since.sending;
  since.progress = first ? uploading(`${first}-x64`, 0.4) : undefined;
  if (!release?.length) return;
  since.released = true;
  if (since.cloudSend) since.cloudSend = { ...since.cloudSend, released: true };
  if (since.cloudBuild) since.cloudBuild = { ...since.cloudBuild, held: false };
});
fake.stub("genexPublish", async (_project, _review, _title, _remix, _replace, platforms) => {
  asked.push(`web:${(platforms ?? []).join("+")}`);
  since.web = {
    id: "job-web",
    kind: GenexPublishKind.Gallery,
    state: GenexPublishJobState.Running,
    phase: GenexPublishPhase.Uploading,
    startedAt: new Date().toISOString(),
    progress: { ...uploading("web", 0.27), totalBytes: Math.round(1.5 * 1024 ** 3), doneBytes: Math.round(0.4 * 1024 ** 3) },
  };
});
/** A held press: the ask it sends to Genex Cloud waits until `letThrough`. */
let held = false;
let letThrough: () => void = () => {};
fake.stub("genexCloudBuild", async (_project, platform, keep) => {
  asked.push(`cloud:${platform}${keep ? ":keep" : ""}`);
  if (held) await new Promise<void>((resolve) => (letThrough = resolve));
  const startedAt = new Date().toISOString();
  // The record says at once how the project's way up goes: on its way, or refused.
  since.cloudSend =
    scene === "startFails"
      ? { platform, startedAt, state: CloudSendState.Failed, error: REFUSED }
      : { platform, startedAt, state: CloudSendState.Sending, ...(keep ? { held: true } : {}) };
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
initializeAppearance();
const genex = { manifest, source: "bundled", enabled: true, removed: false, state: "enabled" } as unknown as PluginInfo;

/** What a person sees on the card: each row and its control, the big button, the line under it, and what was asked. */
function sample() {
  const content = document.querySelector<HTMLElement>('[data-testid="genex-publish"] .genex-publish-content');
  const rows = [...(content?.querySelectorAll<HTMLElement>("[data-genex-publish-platforms] [data-publish-platform]") ?? [])].map(
    (one) => ({
      target: one.dataset.publishPlatform,
      tone: one.dataset.tone,
      name: one.querySelector(".genex-publish-card-text > span:first-child")?.textContent ?? "",
      status: one.querySelector("[data-publish-platform-status]")?.textContent ?? "",
      side: one.querySelector(".genex-publish-card-side")?.textContent ?? null,
      // The row's own button, its loader's words (with its clock), or "Queued".
      act: one.querySelector("[data-publish-platform-act]")?.textContent ?? null,
      busy: one.querySelector("[data-publish-platform-busy]")?.textContent ?? null,
      queued: one.querySelector("[data-publish-platform-queued]")?.textContent ?? null,
      bar: one.querySelector("[data-send-progress]")?.getAttribute("aria-valuenow") ?? null,
      menu: Boolean(one.querySelector("[data-publish-platform-more]")),
      switch: Boolean(one.querySelector('[role="switch"]')),
    }),
  );
  const primary = document.querySelector<HTMLButtonElement>(".genex-publish-primary");
  const column = content?.getBoundingClientRect();
  const overflow = [...(content?.querySelectorAll<HTMLElement>("*") ?? [])].some(
    (el) => column !== undefined && el.getBoundingClientRect().right > column.right + 0.5,
  );
  const note = content?.querySelector<HTMLElement>(".genex-publish-card-note");
  return {
    loading: Boolean(content?.querySelector("[data-publish-card-loading]")),
    // The banner says "<name> is live!".
    celebrating: Boolean(document.querySelector("[data-celebrating]")),
    rows,
    primary: primary?.textContent ?? null,
    primaryDisabled: primary?.disabled ?? null,
    // The big button is the status of a press under way, not a press.
    following: primary?.hasAttribute("data-genex-publish-following") ?? false,
    // The button's label colour and fill as drawn.
    primaryInk: primary ? getComputedStyle(primary).color : null,
    primaryFill: primary ? getComputedStyle(primary).backgroundColor : null,
    note: note?.textContent ?? null,
    // The line under the button keeps to one line.
    noteLines: note ? Math.round(note.getBoundingClientRect().height / Number.parseFloat(getComputedStyle(note).lineHeight)) : 0,
    blocks: [...(content?.querySelectorAll<HTMLElement>("[data-publish-error]") ?? [])].map((block) => ({
      target: block.dataset.publishError,
      text: block.textContent ?? "",
      sent: block.hasAttribute("data-sent"),
      send: Boolean(block.querySelector("[data-publish-error-send]")),
      copy: Boolean(block.querySelector("[data-publish-error-copy]")),
    })),
    menuItems: [...document.querySelectorAll<HTMLElement>("[data-publish-platform-down]")].map((item) => item.textContent ?? ""),
    link: content?.querySelector("[data-public]")?.textContent ?? null,
    share: Boolean(content?.querySelector(".genex-publish-share, [data-publish-share]")),
    text: content?.textContent ?? "",
    asked: [...asked],
    composed: [...composed],
    overflow,
  };
}

/** Open the dialog in `theme` on the scene's game, as the scene has it: nothing has happened since. */
async function open(options: { theme?: "dark" | "light"; scene?: Scene } = {}) {
  updateAppearance((appearance) => ({
    ...appearance,
    mode: options.theme === "light" ? AppearanceMode.Light : AppearanceMode.Dark,
  }));
  scene = options.scene ?? "old";
  since = fresh();
  // The computer the game is made on: a Mac, or the PC of the `pc` scenes.
  document.documentElement.dataset.platform = ON_A_PC.has(scene) ? "win32" : "darwin";
  // A game of its own each time: what the card asked for and follows is kept per game for the app's run.
  opened += 1;
  game = `${GAME}-${scene}-${opened}`;
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
  return show();
}

/** Draw the dialog on the open game from nothing, as closing and opening it again does. */
async function show() {
  flushSync(() => root.render(null));
  await settle(2);
  flushSync(() => root.render(<GenexPublishDialog plugin={genex} project={game} onClose={() => {}} />));
  for (let i = 0; i < 100 && !document.querySelector("[data-genex-publish-status]"); i++) await frame();
  const ready = () => document.querySelector("[data-genex-publish-platforms], [data-publish-card-loading]");
  for (let i = 0; i < 100 && !ready(); i++) await frame();
  await settle();
  return sample();
}

/** Close the dialog: what the app follows goes on without it. */
async function close() {
  flushSync(() => root.render(null));
  await settle(2);
}

/** The folder's read answers (the `loading` scene). */
async function answer() {
  release();
  for (let i = 0; i < 100 && !document.querySelector("[data-genex-publish-platforms]"); i++) await frame();
  await settle();
  return sample();
}

/** Wait until the fake Studio was asked something new, or the card changed, then sample. */
async function afterPress(before: number) {
  const said = () => asked.length + composed.length;
  for (let i = 0; i < 60 && said() === before; i++) await frame();
  await settle();
  return sample();
}

/** Press the card's big button. */
async function press() {
  const before = asked.length + composed.length;
  document.querySelector<HTMLButtonElement>("[data-genex-publish-press]")?.click();
  return afterPress(before);
}

/** Press a row's own button. */
async function act(target: PublishTarget) {
  const before = asked.length + composed.length;
  document.querySelector<HTMLButtonElement>(`[data-publish-platform="${target}"] [data-publish-platform-act]`)?.click();
  return afterPress(before);
}

/** Open the menu of a platform players have. */
async function menu(target: PublishTarget) {
  const more = document.querySelector<HTMLButtonElement>(`[data-publish-platform-more="${target}"]`);
  more?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
  for (let i = 0; i < 30 && !document.querySelector("[data-publish-platform-down]"); i++) await frame();
  await settle();
  return sample();
}

/** Choose the open menu's Take down. */
async function takeDown() {
  const before = asked.length + composed.length;
  document.querySelector<HTMLElement>("[data-publish-platform-down]")?.click();
  return afterPress(before);
}

/** Press the card's big button and stop while its ask to Genex Cloud is being sent; `goThrough` lets it on. */
async function hold() {
  held = true;
  document.querySelector<HTMLButtonElement>("[data-genex-publish-press]")?.click();
  for (let i = 0; i < 60 && asked.length === 0; i++) await frame();
  await settle();
  return sample();
}

/** The held press goes through. */
async function goThrough() {
  held = false;
  letThrough();
  await settle();
  return sample();
}

/** Wait, at most `frames`, until the card's rows read as `until` says, then sample. */
async function wait(until: (seen: ReturnType<typeof sample>) => boolean, frames = 600) {
  for (let i = 0; i < frames && !until(sample()); i++) await frame();
  await settle();
  return sample();
}
const rowOf = (seen: ReturnType<typeof sample>, target: PublishTarget) => seen.rows.find((one) => one.target === target);

/**
 * The agent's build of `target` lands in the folder, and the agent's turn ends: an open card is never
 * reopened, and its row stops saying it builds.
 */
async function land(target: PublishTarget = PublishTarget.Mac) {
  since.landed.set(target, new Date().toISOString());
  fake.emit({ type: UiEvent.ChatStreamEnded, payload: { threadId: "t1", streamId: "s1" } });
  return wait((seen) => rowOf(seen, target)?.busy?.startsWith("Building") !== true && !rowOf(seen, target)?.queued, 240);
}

/** The game's project reached Genex Cloud: it builds the app now, keeping it unless a publish asked for it. */
async function cloudStarts() {
  const send = since.cloudSend;
  if (!send) return sample();
  since.cloudBuild = cloud(CloudBuildState.Building, 0, send.held && !send.released && !since.released ? { held: true } : {});
  since.cloudSend = undefined;
  return wait((seen) => rowOf(seen, PublishTarget.Windows)?.status === "On Genex Cloud");
}

/** Genex Cloud's build ends: it keeps the app, or puts it on the game's page when a publish asked for it. */
async function cloudEnds() {
  const build = since.cloudBuild;
  if (!build) return sample();
  const finishedAt = new Date().toISOString();
  since.cloudBuild = build.held
    ? { ...build, state: CloudBuildState.Built, finishedAt, installedBytes: Math.round(2.9 * 1024 ** 3) }
    : { ...build, state: CloudBuildState.Done, finishedAt };
  return wait((seen) => rowOf(seen, PublishTarget.Windows)?.busy === null);
}

/** What is being sent arrives: the apps are live, and so is the web version when it was on its way. */
async function arrive() {
  const publishedAt = new Date().toISOString();
  since.sent.push(...since.sending.map((platform) => ({ ...sent(platform, 0), publishedAt })));
  since.sending = [];
  since.progress = undefined;
  if (since.web) since.webLiveAt = publishedAt;
  since.web = undefined;
  return wait((seen) => seen.rows.every((one) => !one.busy?.startsWith("Publishing") && !one.busy?.startsWith("Updating")));
}

/** Press an error block's Send to agent or Copy (`send`, `copy`). */
async function block(which: "send" | "copy") {
  document.querySelector<HTMLButtonElement>(`[data-publish-error-${which}]`)?.click();
  for (let i = 0; i < 30 && asked.length === 0 && composed.length === 0; i++) await frame();
  await settle();
  return sample();
}

Object.assign(window, {
  cardRig: {
    open,
    show,
    close,
    answer,
    press,
    act,
    menu,
    takeDown,
    hold,
    goThrough,
    sample,
    wait,
    land,
    cloudStarts,
    cloudEnds,
    arrive,
    block,
  },
});
