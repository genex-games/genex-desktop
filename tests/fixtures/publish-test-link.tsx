/**
 * Test-owned production Publish dialog over a fake `window.studio`: the test link shows only while
 * it holds a build players do not have, the public link is labelled after the main press, and the
 * main press still publishes exactly as before (one `genexPublish` call with the game and its name).
 */
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import manifest from "../../src/plugins/genex/plugin.json" with { type: "json" };
import { GenexPublishDialog } from "../../src/renderer/panels/plugins/genex/GenexPublish.tsx";
import { studio } from "../../src/renderer/state/studio.ts";
import type { GameProject } from "../../src/shared/game-project.ts";
import { GenexAction, type GenexPublishState } from "../../src/shared/genex.ts";
import type { PluginInfo } from "../../src/shared/plugins.ts";
import { fakeStudioApi } from "../helpers/fake-studio-api.ts";

const GAME = "cathedral-chess";
const PUBLISHED_AT = "2026-10-16T10:00:00.000Z";
const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Missing fixture root");
const root = createRoot(rootElement);
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
async function settle(frames = 10) {
  for (let i = 0; i < frames; i++) await frame();
}

const base: GenexPublishState = { version: 1, project: GAME, connected: true, slug: GAME };
const live = { status: "published", galleryUrl: `https://genex.games/${GAME}`, lastPublishAt: PUBLISHED_AT } as const;
const draft = (verifiedAt: string, revision = "r2") => ({
  revision,
  url: `https://preview--${GAME}.genex.technology/`,
  digest: "d".repeat(64),
  verifiedAt,
});
const done = { id: "j", state: "done", phase: "ready", startedAt: PUBLISHED_AT } as const;
/** The publish records the plugin answers, by scenario. */
const SCENARIOS: Record<string, GenexPublishState> = {
  /** Never published, no tested draft: today's dialog, untouched. */
  fresh: { ...base, status: "draft" },
  /** Never published, the agent's tested draft is up: the test link under Publish to the web. */
  draft: { ...base, status: "draft", readyDraft: draft("2026-10-16T09:00:00.000Z") },
  /** Live, and a draft tested after the last publish: the public link, then the test link. */
  newer: { ...base, ...live, readyDraft: draft("2026-10-16T11:00:00.000Z"), job: { ...done, kind: "draft" } },
  /** Live, the draft is the publish's own build: no test link. */
  same: {
    ...base,
    ...live,
    readyDraft: draft("2026-10-16T09:59:00.000Z"),
    job: { ...done, kind: "gallery", expectedStagingRevision: "r2" },
  },
};

let scenario: GenexPublishState = SCENARIOS.fresh;
const publishes: Array<{ game: string; title: string }> = [];
const fake = fakeStudioApi();
fake.stub("pluginAction", async (_id, name) => (name === GenexAction.PublishStatus ? scenario : {}));
fake.stub("genexPublishReview", async () => ({ included: ["index.html"], excluded: [] }));
fake.stub("genexPublish", async (game, _review, title) => {
  publishes.push({ game, title: title ?? "" });
});
window.studio = fake.api;
const genex = { manifest, source: "bundled", enabled: true, removed: false, state: "enabled" } as unknown as PluginInfo;

/** The open game as the library lists it: multiplayer or not. */
function setGame(multiplayer: boolean) {
  const game = { name: GAME, title: "Cathedral Chess", ...(multiplayer ? { multiplayer: true } : {}) };
  studio().library.setState((state) => ({ ...state, games: [game as unknown as GameProject] }), true);
}

/** What a person sees, in the order the dialog draws it. */
function sample() {
  const dialog = document.querySelector<HTMLElement>('[data-testid="genex-publish"]');
  const content = dialog?.querySelector<HTMLElement>(".genex-publish-content");
  const primary = content?.querySelector<HTMLButtonElement>(".genex-publish-primary") ?? null;
  const publicField = content?.querySelector<HTMLElement>("[data-public]") ?? null;
  const testField = content?.querySelector<HTMLElement>("[data-test]") ?? null;
  const order = [...(content?.querySelectorAll<HTMLElement>(".genex-publish-primary, [data-public], [data-test]") ?? [])].map(
    (el) => (el.matches("[data-public]") ? "public" : el.matches("[data-test]") ? "test" : "primary"),
  );
  // Every row ends where the main press ends: nothing wider than the column, nothing past the dialog.
  const column = primary?.getBoundingClientRect();
  const overflow = [...(content?.querySelectorAll<HTMLElement>("*") ?? [])].some(
    (el) => column !== undefined && el.getBoundingClientRect().right > column.right + 0.5,
  );
  return {
    dialog: Boolean(dialog),
    stage: document.querySelector("[data-genex-publish-status]")?.getAttribute("data-genex-publish-status") ?? null,
    primary: primary?.textContent?.trim() ?? null,
    publicText: publicField?.textContent?.replace(/\s+/g, " ").trim() ?? null,
    testText: testField?.textContent?.replace(/\s+/g, " ").trim() ?? null,
    testCopyLabel: testField?.querySelector("button")?.getAttribute("aria-label") ?? null,
    note: testField?.parentElement?.querySelector(".genex-publish-hint")?.textContent?.trim() ?? null,
    hints: [...(content?.querySelectorAll(":scope > .genex-publish-hint") ?? [])].map((p) => p.textContent?.trim()),
    order,
    overflow,
    publishes: [...publishes],
  };
}

/** Open the dialog with the plugin answering `name`, for a multiplayer game or not. */
async function open(name: string, options: { multiplayer?: boolean } = {}) {
  scenario = SCENARIOS[name] ?? SCENARIOS.fresh;
  setGame(options.multiplayer === true);
  flushSync(() => root.render(null));
  await settle(2);
  flushSync(() => root.render(<GenexPublishDialog plugin={genex} project={GAME} onClose={() => {}} />));
  for (let i = 0; i < 100 && !document.querySelector("[data-genex-publish-status]"); i++) await frame();
  await settle();
  return sample();
}

/** Press the dialog's main button, as a person would. */
async function press() {
  const button = document.querySelector<HTMLButtonElement>(".genex-publish-primary");
  if (!button) throw new Error("No main press");
  button.click();
  await settle(30);
  return sample();
}

Object.assign(window, { testLink: { open, press, sample } });
