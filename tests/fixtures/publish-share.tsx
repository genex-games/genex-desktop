/**
 * Test-owned production Publish dialog over a fake `window.studio`, for its row that shares the
 * game's assets on Play: the row (pictures, one line, a switch, off by default) shows above the
 * presses for a signed-in account with assets Genex made that are not on Play; with the switch on,
 * the game going live shares exactly those under their names, and the success screen says how it
 * went in one line (a bare ✓, or what missed with Try again). The pictures are drawn here.
 */
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import manifest from "../../src/plugins/genex/plugin.json" with { type: "json" };
import { initializeAppearance, updateAppearance } from "../../src/renderer/appearance/store.ts";
import { AppearanceMode } from "../../src/renderer/appearance/themes.ts";
import { GenexPublishDialog } from "../../src/renderer/panels/plugins/genex/GenexPublish.tsx";
import { studio } from "../../src/renderer/state/studio.ts";
import {
  type AssetLibraryState,
  type LibraryAsset,
  LibraryKind,
  ShareMiss,
  type ShareItem,
  type ShareOutcome,
} from "../../src/shared/asset-library.ts";
import type { ProjectAsset } from "../../src/shared/game-assets.ts";
import { GenexAccountStatus } from "../../src/shared/genex-account.ts";
import type { GameProject } from "../../src/shared/game-project.ts";
import {
  GenexAction,
  GenexPublishJobState,
  GenexPublishKind,
  GenexPublishPhase,
  type GenexPublishState,
} from "../../src/shared/genex.ts";
import type { PluginInfo } from "../../src/shared/plugins.ts";
import { fakeStudioApi } from "../helpers/fake-studio-api.ts";

const GAME = "snowball";
const AT = "2026-10-17T10:00:00.000Z";
const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Missing fixture root");
const root = createRoot(rootElement);
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function settle(frames = 10) {
  for (let i = 0; i < frames; i++) await frame();
}

/** The game's Genex files: five not on Play yet (one a sound), one shared already, one from Blender. */
const FILES = [
  { file: "assets/genex/a/mushroom.glb", kind: "model", prompt: "Giant mushroom tree with a tall twisted stem", hue: 18 },
  { file: "assets/genex/b/hut.glb", kind: "model", prompt: "Chitin hut with a round door", hue: 40 },
  { file: "assets/genex/c/strider.glb", kind: "model", prompt: "Silt strider, a giant insect mount", hue: 35 },
  { file: "assets/genex/d/crowd.wav", kind: "audio", prompt: "Stadium crowd erupting after a goal", hue: 210 },
  { file: "assets/genex/e/lantern.glb", kind: "model", prompt: "Iron street lantern on a post", hue: 48 },
  { file: "assets/genex/f/sled.glb", kind: "model", prompt: "Wooden sled", hue: 25, live: true },
  { file: "assets/blender/rock.glb", kind: "model", prompt: undefined, hue: 0, mine: true },
] as const;

const generationOf = (file: string) => `fxgen-${file.replace(/\W/g, "").slice(-16)}`;

/** A small drawn thumbnail in `hue`: a floor and a cone, as the fixture library draws them. */
function thumbnail(hue: number): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#24262b"/><ellipse cx="32" cy="50" rx="18" ry="4" fill="#000" opacity=".35"/><path d="M32 12 L48 48 L16 48 Z" fill="hsl(${hue} 55% 55%)"/></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

const states: AssetLibraryState[] = FILES.map((entry) => ({
  file: entry.file,
  generationId: "mine" in entry ? null : generationOf(entry.file),
  saved: false,
  shared: "live" in entry ? { projectId: "p-sled", slug: "wooden-sled", live: true } : null,
  saveable: true,
  shareable: !("mine" in entry),
}));
const assets = FILES.map((entry) => ({
  file: entry.file,
  kind: entry.kind,
  bytes: 1,
  mtime: AT,
  source: "genex",
  ...(entry.prompt ? { prompt: entry.prompt } : {}),
})) as unknown as ProjectAsset[];
const library: LibraryAsset[] = FILES.filter((entry) => !("mine" in entry)).map((entry) => ({
  id: generationOf(entry.file),
  kind: entry.kind === "audio" ? LibraryKind.Sound : LibraryKind.Model,
  title: entry.prompt ?? "",
  thumbnailUrl: thumbnail(entry.hue),
  fileUrl: null,
  fileKind: null,
  fileFormat: null,
  saved: false,
  shared: null,
  shareable: true,
  createdAt: AT,
}));

const base: GenexPublishState = { version: 1, project: GAME, connected: true, slug: GAME, status: "draft" };
const running: GenexPublishState = {
  ...base,
  job: {
    id: "j1",
    kind: GenexPublishKind.Gallery,
    state: GenexPublishJobState.Running,
    phase: GenexPublishPhase.Uploading,
    startedAt: new Date().toISOString(),
  },
};
const live: GenexPublishState = {
  ...base,
  status: "published",
  galleryUrl: `https://genex.games/${GAME}`,
  lastPublishAt: AT,
  job: { ...(running.job as NonNullable<GenexPublishState["job"]>), state: GenexPublishJobState.Done, phase: GenexPublishPhase.Done },
};

let scenario: GenexPublishState = base;
/** How the next shares answer: every one live, or the check refusing one and the network losing one. */
let shareMode: "live" | "misses" = "live";
const shares: ShareItem[][] = [];
const fake = fakeStudioApi();
fake.stub("pluginAction", async (_id, name) => (name === GenexAction.PublishStatus ? scenario : {}));
fake.stub("genexPublishReview", async () => ({ included: ["index.html"], excluded: [] }));
fake.stub("genexPublish", async () => {
  scenario = running;
});
fake.stub("assetLibraryStates", async () => ({
  project: GAME,
  states: states.map((state) => ({ ...state })),
  unread: false,
}));
fake.stub("projectAssets", async () => ({ project: GAME, assets, truncated: false, skipped: [] }));
fake.stub("assetLibrary", async (query) => ({
  assets: library.filter((asset) => !query.ids || query.ids.includes(asset.id)),
  nextCursor: null,
}));
fake.stub("assetShare", async (_game, items) => {
  shares.push(items);
  return items.map((item, index): ShareOutcome => {
    if (shareMode === "live" || index > 1) {
      const state = states.find((entry) => entry.file === item.file);
      if (state) state.shared = { projectId: `p-${index}`, slug: `shared-${index}`, live: true };
      return { file: item.file, shared: { projectId: `p-${index}`, slug: `shared-${index}`, live: true } };
    }
    return { file: item.file, miss: index === 0 ? ShareMiss.Refused : ShareMiss.Failed };
  });
});
window.studio = fake.api;
initializeAppearance();
const genex = { manifest, source: "bundled", enabled: true, removed: false, state: "enabled" } as unknown as PluginInfo;

/** The outcome line: how it went, its words (without its button's) and its button's, if any. */
function lineOf(line: HTMLElement) {
  const words = [...line.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent);
  const action = line.querySelector("button")?.textContent ?? null;
  return { outcome: line.dataset.publishShareOutcome, text: words.join("").trim(), action };
}

/** What a person sees: the row, its switch, the outcome line, and whether anything pokes out. */
function sample() {
  const dialog = document.querySelector<HTMLElement>('[data-testid="genex-publish"]');
  const content = dialog?.querySelector<HTMLElement>(".genex-publish-content");
  const row = content?.querySelector<HTMLElement>("[data-publish-share]") ?? null;
  const line = content?.querySelector<HTMLElement>("[data-publish-share-outcome]") ?? null;
  const toggle = row?.querySelector<HTMLButtonElement>('button[role="switch"]') ?? null;
  const text = row?.querySelector<HTMLElement>(".publish-share-text") ?? null;
  const column = content?.getBoundingClientRect();
  const overflow = [...(content?.querySelectorAll<HTMLElement>("*") ?? [])].some(
    (el) => column !== undefined && el.getBoundingClientRect().right > column.right + 0.5,
  );
  const order = [...(content?.querySelectorAll<HTMLElement>("[data-publish-share], .genex-publish-primary") ?? [])].map(
    (el) => (el.matches("[data-publish-share]") ? "share" : "primary"),
  );
  return {
    stage: document.querySelector("[data-genex-publish-status]")?.getAttribute("data-genex-publish-status") ?? null,
    celebrating: Boolean(document.querySelector("[data-celebrating]")),
    row: row ? { text: text?.textContent ?? "", thumbs: row.querySelectorAll(".publish-share-thumb img").length } : null,
    oneLine: text ? text.scrollHeight <= Math.ceil(parseFloat(getComputedStyle(text).lineHeight)) + 1 : null,
    switchOn: toggle ? toggle.getAttribute("aria-checked") === "true" : null,
    switchLabel: toggle?.getAttribute("aria-label") ?? null,
    line: line ? lineOf(line) : null,
    order,
    overflow,
    shares: shares.map((batch) => batch.map((item) => item.name)),
  };
}

/** Open the dialog in `theme`, signed in or not, on a game that is not online yet. */
async function open(options: { theme?: "dark" | "light"; signedIn?: boolean; mode?: "live" | "misses" } = {}) {
  const mode = options.theme === "light" ? AppearanceMode.Light : AppearanceMode.Dark;
  updateAppearance((appearance) => ({ ...appearance, mode }));
  shareMode = options.mode ?? "live";
  scenario = base;
  shares.length = 0;
  for (const state of states) state.shared = FILES.find((entry) => entry.file === state.file && "live" in entry) ? { projectId: "p-sled", slug: "wooden-sled", live: true } : null;
  const account = options.signedIn === false ? GenexAccountStatus.SignedOut : GenexAccountStatus.SignedIn;
  studio().people.setState((state) => ({ ...state, account }), true);
  const game = { name: GAME, title: "Snowball", createdAt: AT } as unknown as GameProject;
  studio().library.setState((state) => ({ ...state, games: [game] }), true);
  flushSync(() => root.render(null));
  await settle(2);
  flushSync(() => root.render(<GenexPublishDialog plugin={genex} project={GAME} onClose={() => {}} />));
  for (let i = 0; i < 100 && !document.querySelector("[data-genex-publish-status]"); i++) await frame();
  for (let i = 0; i < 60 && !document.querySelector(".publish-share-thumb img"); i++) await frame();
  await settle();
  return sample();
}

/** Flip the row's switch, as a person would. */
async function toggle() {
  document.querySelector<HTMLButtonElement>('[data-publish-share] button[role="switch"]')?.click();
  await settle();
  return sample();
}

/** Press Publish; the record then runs, and goes live at the dialog's next read. */
async function publish() {
  document.querySelector<HTMLButtonElement>(".genex-publish-primary")?.click();
  for (let i = 0; i < 200 && scenario !== running; i++) await frame();
  await wait(300);
  scenario = live;
  for (let i = 0; i < 400 && !document.querySelector("[data-publish-share-outcome]:not([data-publish-share-outcome='sharing'])"); i++) {
    if (!document.querySelector("[data-celebrating]")) await wait(50);
    else await frame();
  }
  await settle(20);
  return sample();
}

/** Press Try again on the success screen's line. */
async function retry() {
  shareMode = "live";
  document.querySelector<HTMLButtonElement>(".publish-share-retry")?.click();
  for (let i = 0; i < 200 && document.querySelector("[data-publish-share-outcome='missed']"); i++) await frame();
  await settle(10);
  return sample();
}

/** Close the dialog before the game goes live and open it again, the files as they stand. */
async function reopen() {
  flushSync(() => root.render(null));
  await settle(2);
  flushSync(() => root.render(<GenexPublishDialog plugin={genex} project={GAME} onClose={() => {}} />));
  for (let i = 0; i < 100 && !document.querySelector("[data-publish-share-outcome='not-shared']"); i++) await frame();
  await settle();
  return sample();
}

/** Press Share now, then wait past the library's re-read that follows the share. */
async function shareNow(mode: "live" | "misses" = "live") {
  shareMode = mode;
  document.querySelector<HTMLButtonElement>(".publish-share-now")?.click();
  for (let i = 0; i < 200 && shares.length === 0; i++) await frame();
  await wait(500);
  await settle(20);
  return sample();
}

Object.assign(window, { shareRig: { open, toggle, publish, retry, reopen, shareNow, sample } });
