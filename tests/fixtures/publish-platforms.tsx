/**
 * Test-owned production Publish dialog over a fake `window.studio`, for its platform rows: a game
 * made in an engine lists the web, Mac, Windows and Linux, each with what its build runs on, when it was
 * built and its size; a built app says "Coming soon" and a missing one offers "Make with agent",
 * which sends the ask to the game's chat and keeps the dialog open. A web game with no app shows no
 * rows. An Unreal game whose web version is still on Genex says so on its web row, with Remove; a
 * Unity game whose web build would take the place of its apps' page says so above the press.
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
import { CloudBuildState, GenexAction, GenexBuildReview, type GenexNativeRecord, type GenexPublishState } from "../../src/shared/genex.ts";
import { CustomEvent as LogEvent, customEventData } from "../../src/shared/custom-events.ts";
import type { EventEnvelope } from "../../src/shared/event-log.ts";
import {
  GenexAppReview,
  GenexFixKind,
  GenexGameReview,
  GenexHumanReview,
  type GenexReviewApp,
  GenexReviewChange,
  GenexReviewReadProblem,
  type GenexReviewStatus,
  type GenexTakedown,
  gameReviewOf,
} from "../../src/shared/genex-review.ts";
import { NativeArch } from "../../src/shared/play-native.ts";
import { UiEvent } from "../../src/shared/ui-events.ts";
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
type Scene = "engine" | "stale" | "web" | "apps" | "appsSending" | "appsSent" | "appsFailed" | "appsOnly" | "appsHeld" | "appsReview" | "appsRejected" | "unityNoApp" | "unitySoon" | "unreal" | "unrealCloud" | "unrealBuilding" | "unrealWindows" | "unrealWebOnGenex" | "unityReplacesApps" | ReviewScene;

/**
 * The scenes of Genex's review of a game's Mac app, or of its takedown (spec §6.9), and the moments
 * around them: a game opened on a live app, an apps publish ending, a game with a web version whose
 * app is checked or whose takedown is fixed, a resend a person waits for, and a fix of an earlier build.
 */
type ReviewScene = "appsChecking" | "appsChecking20m" | "appsNotApproved1" | "appsNotApproved7" | "appsUpdateNotApproved" | "appsStill" | "appsRequested" | "appsWithPerson" | "appsPersonKept" | "appsTakenDown" | "appsTakenDownCsam" | "appsFixSent" | "appsFixStopped" | "appsNotBuilt" | "appsOffline" | "appsSignedOut" | "appsLive" | "appsPublishEnds" | "webWithAppsChecking" | "appsResendOwed" | "webAppsFixedWeb" | "appsFixEarlierBuild" | "appsUpdateGoesLive";
const REVIEW_SCENES: readonly ReviewScene[] = ["appsChecking", "appsChecking20m", "appsNotApproved1", "appsNotApproved7", "appsUpdateNotApproved", "appsStill", "appsRequested", "appsWithPerson", "appsPersonKept", "appsTakenDown", "appsTakenDownCsam", "appsFixSent", "appsFixStopped", "appsNotBuilt", "appsOffline", "appsSignedOut", "appsLive", "appsPublishEnds", "webWithAppsChecking", "appsResendOwed", "webAppsFixedWeb", "appsFixEarlierBuild", "appsUpdateGoesLive"];
/** The scenes of a game with a web version beside its app: its web build goes with Publish too. */
const WEB_WITH_APPS: ReadonlySet<Scene> = new Set(["webWithAppsChecking", "webAppsFixedWeb"]);
const isReviewScene = (of: Scene): of is ReviewScene => (REVIEW_SCENES as readonly string[]).includes(of);

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
  unreal: () => [web(false), mac(PublishPlatformState.Missing), windows, linux()],
  // A Mac's Unreal game whose Windows app Genex can build: offered, then building.
  unrealCloud: () => [web(false), mac(PublishPlatformState.Ready, true), windows, linux()],
  unrealBuilding: () => [web(false), mac(PublishPlatformState.Ready, true), windows, linux()],
  // On Windows: no Mac app, and the Linux app the agent packages here with Epic's toolchain.
  unrealWindows: () => [web(false), mac(PublishPlatformState.Missing), windows, linux()],
  unrealWebOnGenex: () => [web(false), mac(PublishPlatformState.Ready, true), windows, linux()],
  unityReplacesApps: () => [web(true), mac(PublishPlatformState.Ready, true), windows, linux()],
  ...Object.fromEntries(
    REVIEW_SCENES.map((one) => [one, () => [web(WEB_WITH_APPS.has(one)), mac(PublishPlatformState.Ready, true), windows, linux()]]),
  ),
} as Record<Scene, () => PublishPlatform[]>;

const THINGS = [
  { text: "The “Get 5,000 coins” button opens an outside payment page", where: "Garage → Get coins", rule: "Off-platform payment" },
  { text: "Loads code from another website (unpkg.com)", where: "src/main.js:3" },
  { text: "Sets a cookie before the player agrees", where: "index.html · on load" },
  { text: "Shows ads from an outside ad network after each fight" },
  { text: "Asks for the player's email before the game starts" },
  { text: "Opens a chat with strangers with no way to block them" },
  { text: "Sends the player's progress to a server Genex doesn't know" },
];
const MINER = [{ text: "Mines cryptocurrency on the player's computer", where: "vendor/worker.min.js" }];

/** The apps publish of `appsPublishEnds` has ended: its Mac app is with Genex. */
let sendEnded = false;
/** Genex approved the update `appsUpdateGoesLive` checks while the dialog is open. */
let approved = false;

/**
 * Genex's review of the scene's Mac app, or of its takedown, as main answers it; `read` once Genex was
 * read after the scene's publish ended (before, the plugin answers what it kept).
 */
function reviewOf(of: Scene, read = true): GenexReviewStatus | null {
  if (!isReviewScene(of)) return null;
  const sentAt = new Date(Date.now() - (of === "appsChecking20m" ? 20 * MINUTE : 65_000)).toISOString();
  const decidedAt = new Date(Date.now() - 2 * MINUTE).toISOString();
  const asked = { state: GenexHumanReview.Requested, canRequest: false };
  const app = (state: GenexAppReview, extra: Partial<GenexReviewApp> = {}): GenexReviewApp => ({
    platform: "mac", arch: "universal", state, version: "1.3.0", sentAt, decidedAt, decidedBy: "check",
    things: state === GenexAppReview.NotApproved ? MINER : [],
    humanReview: { state: GenexHumanReview.None, canRequest: state === GenexAppReview.NotApproved },
    ...extra,
  });
  const takedown = (extra: Partial<GenexTakedown> = {}): GenexTakedown => ({
    at: decidedAt, rule: "Off-platform payment", things: THINGS.slice(0, 3), appealable: true,
    humanReview: { state: GenexHumanReview.None, canRequest: true }, ...extra,
  });
  const apps: Record<ReviewScene, [GenexReviewApp[], GenexTakedown | null]> = {
    appsChecking: [[app(GenexAppReview.Checking)], null],
    appsChecking20m: [[app(GenexAppReview.Checking)], null],
    appsNotApproved1: [[app(GenexAppReview.NotApproved)], null],
    appsNotApproved7: [[app(GenexAppReview.NotApproved, { things: THINGS })], null],
    appsUpdateNotApproved: [[app(GenexAppReview.NotApproved, { players: { version: "1.2.0", since: "2026-10-25T10:03:10.000Z" } })], null],
    appsStill: [[app(GenexAppReview.NotApproved, { things: THINGS.slice(1, 2) })], null],
    appsRequested: [[app(GenexAppReview.NotApproved, { humanReview: asked })], null],
    appsWithPerson: [[app(GenexAppReview.WithPerson, { decidedBy: undefined })], null],
    appsPersonKept: [[app(GenexAppReview.NotApproved, { decidedBy: "person", reply: "The coin page sends players to a store outside Genex. Sell coins through the Genex shop instead.", humanReview: { state: GenexHumanReview.Answered, canRequest: false } })], null],
    appsTakenDown: [[app(GenexAppReview.Live)], takedown()],
    appsTakenDownCsam: [[app(GenexAppReview.Live)], takedown({ rule: undefined, things: [], appealable: false, humanReview: { state: GenexHumanReview.None, canRequest: false } })],
    appsFixSent: [[app(GenexAppReview.NotApproved)], null],
    appsFixStopped: [[app(GenexAppReview.NotApproved)], null],
    appsNotBuilt: [[app(GenexAppReview.NotApproved)], null],
    appsOffline: [[app(GenexAppReview.NotApproved)], null],
    appsSignedOut: [[app(GenexAppReview.NotApproved)], null],
    appsLive: [[app(GenexAppReview.Live)], null],
    appsPublishEnds: [read && sendEnded ? [app(GenexAppReview.Checking, { sentAt: new Date(Date.now() - 5000).toISOString() })] : [], null],
    webWithAppsChecking: [[app(GenexAppReview.Checking)], null],
    appsResendOwed: [[app(GenexAppReview.NotApproved, { humanReview: { ...asked, resend: true } })], null],
    webAppsFixedWeb: [[app(GenexAppReview.Live)], takedown()],
    appsFixEarlierBuild: [[app(GenexAppReview.Checking, { sentAt: new Date(Date.now() - MINUTE).toISOString() })], null],
    appsUpdateGoesLive: [[approved ? app(GenexAppReview.Live) : app(GenexAppReview.Checking, { players: { version: "1.2.0", since: "2026-10-25T10:03:10.000Z" } })], null],
  };
  const [list, down] = apps[of];
  const problem = of === "appsOffline" ? { problem: GenexReviewReadProblem.Offline } : of === "appsSignedOut" ? { problem: GenexReviewReadProblem.SignedOut } : {};
  return {
    record: { state: gameReviewOf(list, down), apps: list, takedown: down },
    checkedAt: new Date().toISOString(), connected: of !== "appsSignedOut", ...problem,
    open: true, fingerprint: of, told: null, publishing: false,
  };
}

/** The scene's fix press and how it ended, as the game's chat log holds them. */
function fixEventsOf(of: Scene): EventEnvelope[] {
  const at = new Date(Date.now() - MINUTE).toISOString();
  const envelope = (id: string, data: EventEnvelope["data"]): EventEnvelope => ({ id, thread_id: "t1", session_id: null, turn_id: null, created_at: at, data });
  const press = envelope("fix", customEventData(LogEvent.GenexReviewFix, { project: GAME, fixId: "fix-1", kind: GenexFixKind.App, count: 1, autoPublish: true, at }));
  const outcome = (change: GenexReviewChange, extra: Record<string, unknown> = {}) =>
    envelope(`out-${change}`, customEventData(LogEvent.GenexReview, { project: GAME, change, ...extra, at }));
  if (of === "webAppsFixedWeb") {
    const web = customEventData(LogEvent.GenexReviewFix, { project: GAME, fixId: "fix-1", kind: GenexFixKind.Web, count: 3, autoPublish: true, at });
    return [envelope("fix", web), outcome(GenexReviewChange.FixedWeb)];
  }
  // A fix that ended with nothing built half an hour ago: the app sent since is checked, not "your fixes".
  if (of === "appsFixEarlierBuild") {
    const earlier = new Date(Date.now() - 40 * MINUTE).toISOString();
    const pressed = customEventData(LogEvent.GenexReviewFix, { project: GAME, fixId: "fix-1", kind: GenexFixKind.App, count: 1, autoPublish: true, at: earlier });
    return [{ ...envelope("fix", pressed), created_at: earlier }, outcome(GenexReviewChange.NotBuilt, { at: new Date(Date.now() - 30 * MINUTE).toISOString() })];
  }
  if (of === "appsFixSent") return [press];
  if (of === "appsFixStopped") return [press, outcome(GenexReviewChange.FixStopped)];
  if (of === "appsNotBuilt") return [press, outcome(GenexReviewChange.NotBuilt)];
  // A fix sent again before the check turned it down once more: still to fix after the re-check.
  if (of === "appsStill") return [{ ...press, created_at: new Date(Date.now() - 30 * MINUTE).toISOString(), data: customEventData(LogEvent.GenexReviewFix, { project: GAME, fixId: "fix-1", kind: GenexFixKind.App, count: 3, autoPublish: true, at: new Date(Date.now() - 30 * MINUTE).toISOString() }) }, outcome(GenexReviewChange.Sent, { recheck: true, at: new Date(Date.now() - 20 * MINUTE).toISOString() })];
  return [];
}

/** Whether Genex's page plays a web version in each scene (`hostedWeb`); unknown in the rest. */
const HOSTED_WEB: Partial<Record<Scene, boolean>> = {
  unrealWebOnGenex: true,
  unityReplacesApps: false,
  webWithAppsChecking: true,
  webAppsFixedWeb: true,
};

/** The publish record's apps in each scene: none sent yet, going now, on Genex, or refused. */
function appsOf(of: Scene): GenexNativeRecord {
  const sending = of === "appsSending" || (of === "appsPublishEnds" && !sendEnded);
  const record: GenexNativeRecord = { supported: true, sending, sent: [], failed: [] };
  const at = new Date().toISOString();
  if (of === "appsSent" || of === "unrealWebOnGenex" || of === "unityReplacesApps") {
    record.sent.push({ platform: "mac", arch: "universal", version: "1.0+3f2a9c1d0e4b", sizeBytes: 1, publishedAt: at });
    record.sent.push({ platform: "linux", arch: "x64", version: "1.0+9b1e44c2d0a7", sizeBytes: 1, publishedAt: at });
  }
  if (of === "appsFailed")
    record.failed.push({ platform: "mac", arch: "", error: "Couldn't get an upload token (HTTP 413)." });
  if (of === "unrealCloud") record.cloud = { supported: true, builds: [] };
  if (of === "unrealBuilding") {
    const startedAt = new Date(Date.now() - 12 * MINUTE).toISOString();
    record.cloud = { supported: true, builds: [{ platform: "windows", jobId: "job_1", state: CloudBuildState.Building, startedAt }] };
  }
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
  const reviewed = reviewOf(of, true)?.record?.apps[0];
  if (reviewed) {
    const review = { live: GenexBuildReview.Approved, not_approved: GenexBuildReview.Rejected }[reviewed.state as string] ?? GenexBuildReview.Pending;
    const reviewReason = reviewed.things[0]?.text;
    record.sent.push({ platform: "mac", arch: "universal", version: "1.3.0", sizeBytes: 1, publishedAt: at, review, ...(reviewReason ? { reviewReason } : {}) });
  }
  return record;
}

let scene: Scene = "engine";
let closed = 0;
const composed: ComposeInChat[] = [];
window.addEventListener(COMPOSE_IN_CHAT_EVENT, (event) => composed.push((event as CustomEvent<ComposeInChat>).detail));
/** The scenes of a game already public on Genex: its web version is live. */
const LISTED: ReadonlySet<Scene> = new Set(["webWithAppsChecking"]);
const state = (): GenexPublishState => ({
  version: 1,
  project: GAME,
  connected: true,
  slug: GAME,
  status: LISTED.has(scene) ? "published" : "draft",
  ...(LISTED.has(scene) ? { galleryUrl: `https://genex.games/${GAME}` } : {}),
  native: appsOf(scene),
  ...(HOSTED_WEB[scene] === undefined ? {} : { hostedWeb: HOSTED_WEB[scene] }),
});
/** The Genex actions the dialog ran, besides reading the publish state. */
const actions: string[] = [];
const fake = fakeStudioApi();
// A confirmed action is reviewed first: main's native dialog stands behind this ticket.
fake.stub("pluginReview", async (_id, name) => {
  actions.push(`review:${name}`);
  return { ticket: "fixture-ticket" };
});
fake.stub("pluginAction", async (_id, name) => {
  if (name === GenexAction.PublishStatus) return state();
  actions.push(name);
  return {};
});
fake.stub("genexPublishPlatforms", async () => SCENES[scene]());
const published: Array<{ via: string; title?: string; replaceNativePage?: boolean }> = [];
fake.stub("genexPublishApps", async (_project, title) => {
  published.push({ via: "apps", ...(title ? { title } : {}) });
});
fake.stub("genexCloudBuild", async (_project, platform) => {
  published.push({ via: `cloud:${platform}` });
});
fake.stub("genexPublish", async (_project, _review, _title, _remix, replaceNativePage) => {
  published.push({ via: "web", ...(replaceNativePage ? { replaceNativePage } : {}) });
});
fake.stub("genexPublishReview", async () => ({ included: ["index.html"], excluded: [] }));
/**
 * Each read of the review, and whether it asked Genex (`refresh`). Like the plugin, a read that asks
 * Genex while the scene's apps are being sent answers what was kept; one after the send has ended
 * answers what Genex says of what it sent.
 */
const reviewReads: boolean[] = [];
let genexRead = false;
const NOTHING_SENT: GenexReviewStatus = {
  record: { state: GenexGameReview.NotPublished, apps: [], takedown: null },
  checkedAt: null, connected: true, open: false, fingerprint: "", told: null, publishing: false,
};
fake.stub("genexReviewStatus", async (_project, refresh) => {
  reviewReads.push(refresh === true);
  if (refresh === true && !appsOf(scene).sending) genexRead = true;
  return reviewOf(scene, genexRead) ?? NOTHING_SENT;
});
fake.stub("genexFixReview", async (_project, options) => {
  published.push({ via: options.autoPublish ? "fix" : "fix:manual" });
  return { fixId: "fix-1" };
});
fake.stub("genexRequestReview", async (_project, args) => {
  published.push({ via: `request:${args.note ?? ""}` });
  return { requested: [{ platform: "mac", arch: "universal", resend: false }], takedown: scene === "appsTakenDown" };
});
// The row that shares a game's assets on Play reads them too: this game has none.
fake.stub("assetLibraryStates", async () => ({ project: GAME, states: [], unread: false }));
fake.stub("projectAssets", async () => ({ project: GAME, assets: [], truncated: false, skipped: [] }));
fake.stub("assetLibrary", async () => ({ assets: [], nextCursor: null }));
window.studio = fake.api;
// The studio puts main's platform on the root before it mounts: these scenes are on a Mac.
document.documentElement.dataset.platform = "darwin";
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
    replaces: list?.querySelector("[data-publish-replaces-apps]")?.textContent ?? null,
    actions: [...actions],
    primary: document.querySelector<HTMLElement>(".genex-publish-primary")?.textContent ?? null,
    primaryDisabled: document.querySelector<HTMLButtonElement>(".genex-publish-primary")?.disabled ?? null,
    hint: content?.querySelector(":scope > .genex-publish-hint")?.textContent ?? null,
    published: [...published],
    failures: [...(list?.querySelectorAll<HTMLElement>(".genex-publish-platform-failure") ?? [])].map(
      (line) => line.textContent ?? "",
    ),
    oneLine: details.every((el) => el.scrollHeight <= Math.ceil(parseFloat(getComputedStyle(el).lineHeight)) + 1),
    review: reviewSample(content),
    chip: document.querySelector<HTMLElement>(".genex-publish-chip")?.textContent ?? null,
    steps: [...(content?.querySelectorAll<HTMLElement>(".step-bar [data-state]") ?? [])].map((el) => el.dataset.state ?? ""),
    check: content?.querySelector<HTMLElement>("[data-genex-publish-check]")?.textContent ?? null,
    celebrating: Boolean(document.querySelector("[data-celebrating]")),
    liveUpdate: content?.querySelector<HTMLElement>("[data-genex-publish-live-update]")?.textContent ?? null,
    reviewReads: [...reviewReads],
    text: content?.textContent ?? "",
    order,
    overflow,
    closed,
    composed: [...composed],
  };
}

/** The review card as a person reads it: which card, its words, its things and presses. */
function reviewSample(content: HTMLElement | null | undefined) {
  const card = content?.querySelector<HTMLElement>("[data-genex-review]");
  if (!card) return null;
  const all = (selector: string) => [...card.querySelectorAll<HTMLElement>(selector)].map((el) => el.textContent ?? "");
  return {
    kind: card.dataset.genexReview,
    title: card.querySelector(".genex-review-title")?.textContent ?? null,
    lines: all(".genex-review-line"),
    quote: card.querySelector(".genex-review-quote")?.textContent ?? null,
    things: all(".genex-review-things li"),
    more: card.querySelector("[data-genex-review-more]")?.textContent ?? null,
    after: all(".genex-review-after"),
    presses: all("[data-genex-review-press]"),
    link: card.querySelector("[data-genex-review-link]")?.textContent ?? null,
    footer: card.querySelector(".genex-review-footer")?.textContent ?? null,
  };
}

/** Press a review card's button or link (`press` is its `data-genex-review-press` value, or `more`). */
async function reviewPress(which: string) {
  const selector = which === "more" ? "[data-genex-review-more]" : `[data-genex-review-press="${which}"]`;
  document.querySelector<HTMLButtonElement>(selector)?.click();
  await settle();
  if (which === "request") await new Promise((resolve) => setTimeout(resolve, 400));
  return sample();
}

/** Type a note in Request human review and send it. */
async function requestReview(note: string) {
  const field = document.querySelector<HTMLTextAreaElement>('[data-testid="genex-review-request"] textarea');
  if (field) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(field, note);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  }
  // Let the dialog's opening animation finish, so its picture shows it as a person sees it.
  await new Promise((resolve) => setTimeout(resolve, 400));
  await settle(2);
  document.querySelector<HTMLButtonElement>("[data-genex-review-request-send]")?.click();
  for (let i = 0; i < 100 && published.length === 0; i++) await frame();
  await settle();
  return { ...sample(), dialogOpen: Boolean(document.querySelector('[data-testid="genex-review-request"]')) };
}

/** A game made in Unity or Unreal, as the library knows it: its engine and the fact it was found by. */
const engineOf = (fact: CoreFact, webVersion = false) => ({
  engine: { id: fact === CoreFact.UnrealProject ? "unreal" : "unity", project: "." },
  facts: [{ id: fact, path: "." }, ...(webVersion ? [{ id: CoreFact.WebGame, path: "web" }] : [])],
});

/** Open the dialog in `theme` on the scene's game: made in an engine unless the scene is a web game. */
async function open(options: { theme?: "dark" | "light"; scene?: Scene; platform?: string } = {}) {
  document.documentElement.dataset.platform = options.platform ?? "darwin";
  const mode = options.theme === "light" ? AppearanceMode.Light : AppearanceMode.Dark;
  updateAppearance((appearance) => ({ ...appearance, mode }));
  scene = options.scene ?? "engine";
  closed = 0;
  composed.length = 0;
  published.length = 0;
  actions.length = 0;
  reviewReads.length = 0;
  genexRead = false;
  sendEnded = false;
  approved = false;
  studio().people.setState((people) => ({ ...people, account: GenexAccountStatus.SignedIn }), true);
  const engine =
    scene === "web"
      ? { facts: [{ id: CoreFact.WebGame, path: "." }] }
      : engineOf(scene.startsWith("unreal") ? CoreFact.UnrealProject : CoreFact.UnityProject, WEB_WITH_APPS.has(scene));
  const game = { name: GAME, title: "Dust Runners", createdAt: AT, ...engine } as unknown as GameProject;
  studio().library.setState((library) => ({ ...library, games: [game] }), true);
  studio().eventLog.setState((log) => ({ ...log, byThread: { t1: fixEventsOf(scene) } }), true);
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

/** End the scene's apps publish, then wait for the dialog to read Genex's word on what it sent. */
async function endSend() {
  sendEnded = true;
  for (let i = 0; i < 400 && !document.querySelector("[data-genex-publish-check]"); i++) await frame();
  await settle();
  return sample();
}

/** Genex approves the update while the dialog is open: main's watch says the game's review changed. */
async function approve() {
  approved = true;
  fake.emit({ type: UiEvent.GenexReviewChanged, payload: { project: GAME } });
  for (let i = 0; i < 200 && !document.querySelector("[data-celebrating]"); i++) await frame();
  await settle();
  return sample();
}

/** Press a row's Make with agent. */
async function make(target: PublishTarget) {
  document.querySelector<HTMLButtonElement>(`[data-publish-platform-make="${target}"]`)?.click();
  await settle();
  return sample();
}

/** Press the web row's Remove. */
async function removeWeb() {
  document.querySelector<HTMLButtonElement>("[data-publish-platform-remove-web]")?.click();
  for (let i = 0; i < 100 && actions.length === 0; i++) await frame();
  await settle();
  return sample();
}

Object.assign(window, { platformsRig: { open, make, press, sample, removeWeb, reviewPress, requestReview, endSend, approve } });
