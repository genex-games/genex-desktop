/**
 * Test-owned chat review cards over a fake `window.studio` (mockups A2, C2, C3, C4, D2): each game's
 * live card as Genex's word now draws it (checking, checking fixes, live with its cover and link, an
 * update live, public again, not approved, taken down, a fix on its way, a fix that stopped) and the
 * settled history lines, one opened to what its record says. Each scene is its own game, so each card
 * reads its own review. A live card's Open shows the game's page in Play. Beside them, the toast a
 * game's review raises while another game is open (C5), made by the feed's own rules from a
 * `genex_review` record, with its [Open].
 */
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import manifest from "../../src/plugins/genex/plugin.json" with { type: "json" };
import { initializeAppearance, updateAppearance } from "../../src/renderer/appearance/store.ts";
import { AppearanceMode } from "../../src/renderer/appearance/themes.ts";
import { EntryKind, type GenexReviewEntry } from "../../src/renderer/chat-entries.ts";
import { GenexReviewCard } from "../../src/renderer/chat/GenexReviewCard.tsx";
import { applyEvents, EMPTY_NOTICES, reviewToasts } from "../../src/renderer/notifications.ts";
import { OPEN_PLAY_EVENT } from "../../src/renderer/play/open-play.ts";
import { useToasts } from "../../src/renderer/state/hooks.ts";
import { studio } from "../../src/renderer/state/studio.ts";
import { ToastStack } from "../../src/renderer/ui/Toast.tsx";
import { REVIEW_WORDS } from "../../src/renderer/words.ts";
import { CustomEvent as LogEvent, customEventData } from "../../src/shared/custom-events.ts";
import type { EventEnvelope } from "../../src/shared/event-log.ts";
import type { GameProject } from "../../src/shared/game-project.ts";
import { GenexAction } from "../../src/shared/genex.ts";
import type { PluginInfo } from "../../src/shared/plugins.ts";
import { CoreFact } from "../../src/shared/project-facts.ts";
import {
  GenexAppReview,
  GenexFixKind,
  GenexHumanReview,
  type GenexReviewApp,
  GenexReviewChange,
  type GenexReviewPayload,
  type GenexReviewStatus,
  type GenexTakedown,
  gameReviewOf,
} from "../../src/shared/genex-review.ts";
import { fakeStudioApi } from "../helpers/fake-studio-api.ts";

const MINUTE = 60_000;
const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Missing fixture root");
const root = createRoot(rootElement);
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

const THINGS = [
  { text: "The “Get 5,000 coins” button opens an outside payment page" },
  { text: "Loads code from another website (unpkg.com)" },
  { text: "Sets a cookie before the player agrees" },
];
const ago = (minutes: number) => new Date(Date.now() - minutes * MINUTE).toISOString();
const app = (state: GenexAppReview, extra: Partial<GenexReviewApp> = {}): GenexReviewApp => ({
  platform: "mac",
  arch: "universal",
  state,
  version: "1.3.0",
  sentAt: ago(1.1),
  decidedAt: ago(1),
  things: state === GenexAppReview.NotApproved ? THINGS.slice(0, 1) : [],
  humanReview: { state: GenexHumanReview.None, canRequest: state === GenexAppReview.NotApproved },
  ...extra,
});
const takedown: GenexTakedown = {
  at: ago(30),
  things: THINGS,
  appealable: true,
  humanReview: { state: GenexHumanReview.None, canRequest: true },
};

/** Each scene's game: its review now, its log records, and the newest record's change. */
const SCENES: Record<string, { apps: GenexReviewApp[]; takedown?: GenexTakedown; log: Array<Partial<GenexReviewPayload> | "fix" | "fix-stopped"> }> = {
  checking: { apps: [app(GenexAppReview.Checking)], log: [{ change: GenexReviewChange.Sent }] },
  "checking-fixes": { apps: [app(GenexAppReview.Checking)], log: [{ change: GenexReviewChange.NotApproved }, "fix", { change: GenexReviewChange.Sent, recheck: true }] },
  live: { apps: [app(GenexAppReview.Live)], log: [{ change: GenexReviewChange.Live }] },
  "live-update": { apps: [app(GenexAppReview.Live)], log: [{ change: GenexReviewChange.Live, update: true }] },
  restored: { apps: [app(GenexAppReview.Live)], log: [{ change: GenexReviewChange.TakenDown }, "fix", { change: GenexReviewChange.Restored, requested: true }] },
  "not-approved": { apps: [app(GenexAppReview.NotApproved)], log: [{ change: GenexReviewChange.NotApproved }] },
  "taken-down": { apps: [app(GenexAppReview.Live)], takedown, log: [{ change: GenexReviewChange.Live }, { change: GenexReviewChange.TakenDown }] },
  "fix-sent": { apps: [app(GenexAppReview.Live)], takedown, log: [{ change: GenexReviewChange.TakenDown }, "fix"] },
  // Turned down before the press: how the fix ended speaks of that decision.
  "fix-stopped": { apps: [app(GenexAppReview.NotApproved, { sentAt: ago(4), decidedAt: ago(3) })], log: [{ change: GenexReviewChange.NotApproved }, "fix", "fix-stopped"] },
};

let seq = 0;
/** A scene's log: its records in order, each a minute apart, the newest just now. */
function logOf(project: string): EventEnvelope[] {
  const records = SCENES[project]?.log ?? [];
  return records.map((record, index) => {
    seq += 1;
    const at = ago(records.length - index);
    const envelope = (data: EventEnvelope["data"]): EventEnvelope => ({ id: `e${seq}`, thread_id: project, session_id: null, turn_id: null, created_at: at, data });
    if (record === "fix")
      return envelope(customEventData(LogEvent.GenexReviewFix, { project, fixId: `fix-${project}`, kind: SCENES[project]?.takedown ? GenexFixKind.Takedown : GenexFixKind.App, count: 3, autoPublish: true, at }));
    if (record === "fix-stopped") return envelope(customEventData(LogEvent.GenexReview, { project, change: GenexReviewChange.FixStopped, at }));
    return envelope(customEventData(LogEvent.GenexReview, { project, ...record, at }));
  });
}

const statusOf = (project: string): GenexReviewStatus => {
  const scene = SCENES[project];
  const apps = scene?.apps ?? [];
  const down = scene?.takedown && project !== "restored" ? scene.takedown : null;
  return { record: { state: gameReviewOf(apps, down), apps, takedown: down }, checkedAt: null, connected: true, open: true, fingerprint: project, told: null, publishing: false };
};

const pressed: string[] = [];
const fake = fakeStudioApi();
fake.stub("genexReviewStatus", async (project) => statusOf(project));
fake.stub("genexFixReview", async (project, options) => {
  pressed.push(`${options.autoPublish ? "fix" : "manual"}:${project}`);
  return { fixId: `fix-${project}` };
});
/** Each game's page on genex.games, but the restored one's: it is on another Genex, a development stand's. */
const pageOf = (project: string) => `https://${project === "restored" ? "dev.genex.games" : "genex.games"}/${project}`;
fake.stub("pluginAction", async (_id, name, _args, project) =>
  name === GenexAction.PublishStatus ? { version: 1, project, connected: true, slug: project, galleryUrl: pageOf(project ?? "") } : {},
);
fake.stub("readProjectAsset", async () => null);
window.studio = fake.api;
document.documentElement.dataset.platform = "darwin";
initializeAppearance();
const genex = { manifest, source: "bundled", enabled: true, removed: false, state: "enabled" } as unknown as PluginInfo;
studio().plugins.setState((plugins) => ({ ...plugins, list: [genex] }), true);

const toastOpened: string[] = [];

/** The toast stack as the app draws it, over the store. */
function Toasts() {
  const items = useToasts((s) => s.items);
  return <ToastStack toasts={items} onDismiss={(id) => studio().toasts.dismiss(id)} />;
}

/** Lost Cathedral is public again while Midnight Asphalt is open: the toast the feed raises for it. */
function offerToast() {
  for (const toast of studio().toasts.getState().items) studio().toasts.dismiss(toast.id);
  const at = new Date().toISOString();
  const restored: EventEnvelope = {
    id: `toast-${Date.now()}`,
    thread_id: "cathedral",
    session_id: null,
    turn_id: null,
    created_at: at,
    data: customEventData(LogEvent.GenexReview, { project: "cathedral", title: "Lost Cathedral", change: GenexReviewChange.Restored, at }),
  };
  const { arrived } = applyEvents(EMPTY_NOTICES, [restored]);
  for (const notice of reviewToasts(arrived, { focused: true, openProject: "taken-down" }))
    studio().toasts.offer(notice.headline ?? notice.text, { label: REVIEW_WORDS.notice.open, run: () => toastOpened.push(notice.project ?? "") });
}

/** Every card, newest of each game live and the rest as history lines. */
async function open(options: { theme?: "dark" | "light" } = {}) {
  updateAppearance((appearance) => ({ ...appearance, mode: options.theme === "light" ? AppearanceMode.Light : AppearanceMode.Dark }));
  const names = Object.keys(SCENES);
  // Each a Unity game with a Mac app and no web version: Studio sends it again and asks a person for it.
  const facts = [{ id: CoreFact.UnityProject, path: "." }];
  const games = names.map((name) => ({ name, title: "Midnight Asphalt", createdAt: ago(100), facts }) as unknown as GameProject);
  studio().library.setState((library) => ({ ...library, games }), true);
  const byThread = Object.fromEntries(names.map((name) => [name, logOf(name)]));
  studio().eventLog.setState((log) => ({ ...log, byThread }), true);
  const entries = names.flatMap((name) =>
    (byThread[name] ?? []).map((event, index, all): GenexReviewEntry => {
      const payload = event.data.type === "custom" ? (event.data.payload as Record<string, unknown>) : {};
      const isFix = event.data.type === "custom" && event.data.event_type === LogEvent.GenexReviewFix;
      return { kind: EntryKind.GenexReview, id: event.id, project: name, at: event.created_at, review: isFix ? null : payload, fix: isFix ? payload : null, latest: index === all.length - 1 };
    }),
  );
  flushSync(() =>
    root.render(
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 26rem)", gap: 24, padding: 24, alignItems: "start" }}>
        {names.map((name) => (
          <div key={name} data-chat-review-scene={name} style={{ display: "grid", gap: 10 }}>
            {entries.filter((entry) => entry.project === name).map((entry) => (
              <GenexReviewCard key={entry.id} entry={entry} project={name} />
            ))}
          </div>
        ))}
        <Toasts />
      </div>,
    ),
  );
  offerToast();
  for (let i = 0; i < 60; i++) await frame();
  return sample();
}

/** Each scene's live card and history lines as a person reads them. */
function sample() {
  const scenes = [...document.querySelectorAll<HTMLElement>("[data-chat-review-scene]")].map((scene) => ({
    scene: scene.dataset.chatReviewScene,
    live: scene.querySelector<HTMLElement>("[data-genex-review]")?.dataset.genexReview ?? null,
    // Everything the newest card says, as one run of text.
    card: scene.querySelector<HTMLElement>("[data-genex-review]")?.textContent ?? null,
    address: scene.querySelector("[data-genex-review-address]")?.textContent ?? null,
    title: scene.querySelector(".genex-review-title")?.textContent ?? null,
    lines: [...scene.querySelectorAll(".genex-review-line, .genex-review-after")].map((el) => el.textContent ?? ""),
    history: [...scene.querySelectorAll(".genex-review-history-line")].map((el) => el.textContent ?? ""),
    presses: [...scene.querySelectorAll("[data-genex-review-press], [data-genex-review-copy], [data-genex-review-open]")].map((el) => el.textContent ?? ""),
    link: scene.querySelector("[data-genex-review-link]")?.textContent ?? null,
  }));
  const toasts = [...document.querySelectorAll<HTMLElement>("[role=status]")].map((toast) => ({
    text: toast.querySelector(".font-mono")?.textContent ?? "",
    action: toast.querySelector("[data-toast-action]")?.textContent ?? null,
  }));
  const settled = [...document.querySelectorAll<HTMLElement>("[data-genex-review-settled]")].map((card) => ({
    title: card.querySelector(".genex-review-title")?.textContent ?? null,
    lines: [...card.querySelectorAll(".genex-review-line")].map((el) => el.textContent ?? ""),
    presses: card.querySelectorAll("button").length,
  }));
  return { scenes, pressed: [...pressed], toasts, toastOpened: [...toastOpened], settled, text: document.body.textContent ?? "" };
}

/** Open a scene's first history line to what it said then. */
async function expand(scene: string) {
  document.querySelector<HTMLButtonElement>(`[data-chat-review-scene="${scene}"] .genex-review-history-line`)?.click();
  for (let i = 0; i < 10; i++) await frame();
  return sample();
}

/** Press the toast's [Open]. */
async function openToast() {
  document.querySelector<HTMLButtonElement>("[data-toast-action]")?.click();
  for (let i = 0; i < 10; i++) await frame();
  return sample();
}

let playAsked = 0;
window.addEventListener(OPEN_PLAY_EVENT, () => {
  playAsked += 1;
});

/** Press a scene's Open: its mark, what Play shows then, how often Play was asked up, and what went to the browser. */
async function openGame(scene: string) {
  const button = document.querySelector<HTMLButtonElement>(`[data-chat-review-scene="${scene}"] [data-genex-review-open]`);
  const leaves = button?.querySelector("svg")?.getAttribute("data-icon") ?? null;
  button?.click();
  for (let i = 0; i < 10; i++) await frame();
  const toBrowser = fake.callsOf("pluginAction").filter(([, name]) => name === GenexAction.PublishOpen).map(([, , , project]) => project);
  return { leaves, view: studio().play.getState().view, playAsked, toBrowser };
}

/** Press a scene's review button. */
async function press(scene: string, which: string) {
  document.querySelector<HTMLButtonElement>(`[data-chat-review-scene="${scene}"] [data-genex-review-press="${which}"]`)?.click();
  for (let i = 0; i < 10; i++) await frame();
  return sample();
}

Object.assign(window, { chatReviewRig: { open, sample, press, expand, openToast, openGame } });
