/**
 * Test-owned Play bar layer (`PlayBarPage`) with the game's AI pill, over a painted stand-in for the
 * game. A fake studio answers the bar's calls; `window.test` sends main's news (the viewer's bar, the
 * game's AI notices) and reads back every call the layer made.
 */
import { createRoot } from "react-dom/client";
import { paintAppearance, savedAppearance } from "../../src/renderer/appearance/paint.ts";
import { Scheme } from "../../src/renderer/appearance/themes.ts";
import { PlayBarPage } from "../../src/renderer/play/PlayBarPage.tsx";
import { AiDoor, AiFunding, type AiModelRef, AiOp, AiProvenance, AiRequirement } from "../../src/shared/game-ai.ts";
import {
  AI_REPORT_WIRE_VERSION,
  type AiReportBundle,
  AiReportFailure,
  AiReportKind,
  AiValidation,
} from "../../src/shared/game-ai-report.ts";
import {
  AiConsentKind,
  type AiConsentTicket,
  AiMaker,
  type AiModelMenu,
  AiModelTag,
  type AiStopCard,
  AiStopReason,
  type GameAiNotice,
  type GameAiSettingsView,
  AiPickPolicy,
} from "../../src/shared/game-ai-views.ts";
import { type PlayBarState, PlayViewerPhase } from "../../src/shared/play.ts";
import { type PlayAiBar, PlayAiPhase } from "../../src/shared/play-bar.ts";
import { EngineId } from "../../src/shared/providers.ts";
import { UiEvent } from "../../src/shared/ui-events.ts";
import { fakeStudioApi } from "../helpers/fake-studio-api.ts";

const GAME = "play:p-crowns" as const;
const HAIKU: AiModelRef = { door: AiDoor.PlanWatcher, engine: EngineId.ClaudeCode, model: "claude-haiku-4-5" };
const SONNET: AiModelRef = { door: AiDoor.PlanWatcher, engine: EngineId.ClaudeCode, model: "claude-sonnet-4-5" };
const GPT: AiModelRef = { door: AiDoor.PlanWatcher, engine: EngineId.Codex, model: "gpt-5-mini" };
const QWEN: AiModelRef = { door: AiDoor.Local, engine: EngineId.Ollama, model: "qwen3:8b" };
const LLAMA: AiModelRef = { door: AiDoor.Local, engine: EngineId.Ollama, model: "llama3.2:3b" };
const CREDITS: AiModelRef = { door: AiDoor.GenexCredits, engine: "genex", model: "claude-haiku-4-5" };
const HOSTILE = '<img src=x onerror="window.test.pwned=true">';

const row = (model: AiModelRef, label: string, funding: AiFunding, tag: AiModelTag | null) => ({
  model,
  label,
  shortLabel: label.replace(/^Claude /u, ""),
  funding,
  tag,
  fit: null,
  ready: true,
});

const MENU: AiModelMenu = {
  game: GAME,
  title: "Crowns of 1444",
  current: HAIKU,
  usage: { funding: AiFunding.Plan, planUsedPercent: 8, resetsAt: null },
  genex: { signedIn: true, balanceCredits: 1240, recommended: CREDITS, recommendedLabel: "Claude Haiku 4.5" },
  groups: [
    { maker: AiMaker.Local, funding: null, rows: [row(QWEN, "Qwen3 8B", AiFunding.Free, AiModelTag.Free)] },
    {
      maker: AiMaker.Claude,
      funding: AiFunding.Plan,
      rows: [row(HAIKU, "Claude Haiku 4.5", AiFunding.Plan, AiModelTag.Best), row(SONNET, "Claude Sonnet 4.5", AiFunding.Plan, AiModelTag.Plan)],
    },
    { maker: AiMaker.ChatGpt, funding: AiFunding.Plan, rows: [row(GPT, "GPT-5 mini", AiFunding.Plan, AiModelTag.Plan)] },
  ],
  struggling: [row(LLAMA, "Llama 3.2 3B", AiFunding.Free, AiModelTag.Free), row({ ...LLAMA, model: "gemma3:1b" }, "Gemma 3 1B", AiFunding.Free, AiModelTag.Free)],
  off: false,
  leaderboard: false,
  requires: AiRequirement.Ai,
};

const SETTINGS: GameAiSettingsView = {
  pick: AiPickPolicy.Best,
  signedIn: true,
  balanceCredits: 38,
  pro: false,
  autoTopUp: null,
  dailyAlertCredits: 500,
  keepForBuildingPercent: 50,
  openRouterMonthlyMicros: null,
  createRouteEnabled: false,
  allowPlan: true,
  shareFitCounts: false,
  pausedGames: [],
};

const call = (said: string, wrote: string) => ({
  site: "envoy",
  op: AiOp.Say,
  system: null,
  systemSha256: null,
  prompt: "The envoy answers.",
  untrusted: { said },
  schema: null,
  rawOutput: wrote,
  value: wrote,
  validation: AiValidation.Valid,
  code: null,
  model: "claude-haiku-4-5",
  door: AiDoor.PlanWatcher,
  provenance: AiProvenance.Unverified,
  usage: null,
  costMicros: 0,
  latencyMs: 400,
  frame: 120,
  tick: null,
});

const BUNDLE: AiReportBundle = {
  v: AI_REPORT_WIRE_VERSION,
  id: "report-0001",
  kind: AiReportKind.Player,
  createdAt: "2026-10-20T12:00:00.000Z",
  game: { key: GAME, title: "Crowns of 1444" },
  reason: null,
  note: null,
  calls: [call("Will you join our alliance?", "The envoy bows."), call("Tell me a secret", HOSTILE)],
  replay: { seed: 7, commit: null, engine: "web", templateVersion: null, inputs: [1, 2, 3], tape: [] },
  digests: [],
  aiState: null,
  consoleErrors: [],
  frame: { mime: "image/png", data: "AAAA" },
  modelCheck: null,
  playerText: true,
};

let reports = 0;
const fake = fakeStudioApi({
  playBar: async () => undefined,
  playControl: async () => undefined,
  playClose: async () => undefined,
  gameAiMenu: async () => MENU,
  gameAiPick: async (_game, model) => ({ ok: true, model }),
  gameAiAnswer: async (answer) => ({ ok: true, model: answer.model }),
  gameAiEnable: async () => undefined,
  gameAiCredits: async () => [
    { id: "pack_5000", credits: 5000, priceCents: 5500 },
    { id: "pack_500", credits: 500, priceCents: 550 },
    { id: "pack_2500", credits: 2500, priceCents: 2750 },
    { id: "pack_1000", credits: 1000, priceCents: 1100 },
  ],
  gameAiSettings: async () => SETTINGS,
  gameAiSettingsSave: async (patch) => ({ ...SETTINGS, ...patch }),
  gameAiCheckout: async () => undefined,
  gameAiReportPreview: async () => BUNDLE,
  // The first send fails, so Try again is seen; the next one goes.
  gameAiReport: async () => (++reports === 1 ? { ok: false, failure: AiReportFailure.Refused } : { ok: true, id: "report-0001" }),
});

const BAR: PlayBarState = {
  title: "Crowns of 1444",
  liked: false,
  likes: 212,
  remixable: false,
  multiplayer: false,
  note: null,
  guestCard: false,
  facts: { author: "mira", authorId: null, plays: 2100, online: null },
  mic: null,
  ai: null,
  comments: 4,
  signedIn: true,
  remixing: false,
  nativeApp: null,
  purchase: null,
  store: null,
};

const AI: PlayAiBar = {
  game: GAME,
  phase: PlayAiPhase.Ready,
  model: HAIKU,
  label: "Claude Haiku 4.5",
  shortLabel: "Haiku 4.5",
  funding: AiFunding.Plan,
  tag: AiModelTag.Best,
  balanceCredits: null,
  lowCredits: false,
  unranked: false,
  note: null,
  addedCredits: null,
};

const consent = (over: Partial<AiConsentTicket> = {}): AiConsentTicket => ({
  ticket: "ticket-0001",
  game: GAME,
  title: "Crowns of 1444",
  kind: AiConsentKind.Plan,
  model: HAIKU,
  modelLabel: "Claude Haiku 4.5",
  balanceCredits: 1240,
  keepForBuildingPercent: 50,
  localDownloadBytes: null,
  maxCredits: null,
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  ...over,
});

const stop = (over: Partial<AiStopCard> = {}): AiStopCard => ({
  game: GAME,
  title: "Crowns of 1444",
  reason: AiStopReason.OutOfCredits,
  model: CREDITS,
  modelLabel: "Claude Haiku 4.5",
  alternative: QWEN,
  alternativeLabel: "Qwen3 8B",
  resetsAt: null,
  spentCredits: null,
  ...over,
});

const bar = (ai: Partial<PlayAiBar> | null): void =>
  fake.emit({
    type: UiEvent.PlayViewer,
    payload: { slug: "crowns", openId: 1, phase: PlayViewerPhase.Playing, bar: { ...BAR, ai: ai ? { ...AI, ...ai } : null } },
  });
const notice = (payload: GameAiNotice): void => fake.emit({ type: UiEvent.GameAi, payload });

Object.assign(window, {
  test: {
    bar,
    notice,
    consent,
    stop,
    models: { HAIKU, QWEN, CREDITS },
    calls: (method: string) => JSON.parse(JSON.stringify(fake.calls.filter((entry) => entry.method === method).map((entry) => entry.args))),
    pwned: false,
    // The app's own appearance, painted in one scheme or the other, as the studio paints it.
    theme: (scheme: Scheme) => paintAppearance(document.documentElement, savedAppearance().appearance, scheme),
  },
});

document.documentElement.dataset.platform = "darwin";
paintAppearance(document.documentElement, savedAppearance().appearance, Scheme.Dark);
const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Missing fixture root");
createRoot(rootElement).render(<PlayBarPage api={fake.api} />);
