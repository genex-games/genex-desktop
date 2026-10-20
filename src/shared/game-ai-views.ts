/**
 * What Studio's trusted surfaces draw of play-time AI, as main computes it (design v3, the
 * `V3-*` canvas boards): the AI pill's model menu, the one-sentence first-use card, the one-card
 * stops, Settings → Play-time AI and its Games list, Get credits, and the news main pushes as
 * `UiEvent.GameAi`. Every number is a count of credits, micros or a plan share; the words for them
 * live in `renderer/words.ts`, never here.
 *
 * The pill is the chat's model button (`renderer/ui/ModelMenu.tsx`): it names the model and opens
 * the same kind of menu, grouped by maker, listing only the models the person shows in Settings →
 * Model Providers, plus a Genex group, one tag per row, a collapsed "may struggle" list, Turn off AI
 * and Report. Browser-safe; pure.
 */
import { MINUTE_MS } from "./duration.ts";
import {
  AiConsent,
  AiDoor,
  type AiFunding,
  type AiGameKey,
  type AiModelRef,
  type AiRequirement,
  isPlainRecord,
  readAiGameKey,
  readMember,
} from "./game-ai.ts";
import type { AiCheckFit } from "./game-ai-check.ts";
import { AiReportReason, AI_REPORT_NOTE_MAX_CHARS, type AiReportRequest } from "./game-ai-report.ts";

/** How long a consent card waits for the person before it lapses (the game plays its fallback). */
export const AI_CONSENT_TTL_MS = 5 * MINUTE_MS;
/** A credit balance at or under which the pill reads low. */
export const AI_LOW_CREDITS = 100;
/** The defaults of the optional limits (§14): a daily alert per game, and each plan's share kept for building. */
export const AI_DEFAULT_DAILY_ALERT_CREDITS = 500;
export const AI_DEFAULT_KEEP_FOR_BUILDING_PERCENT = 50;
/** Auto top-up's defaults and its guardrails (D11): enforced by genex.games, shown by Studio. */
export const AI_AUTO_TOPUP_UNDER_CREDITS = 100;
export const AI_AUTO_TOPUP_ADD_CREDITS = 1_000;
export const AI_AUTO_TOPUP_MAX_PER_DAY = 1;
export const AI_AUTO_TOPUP_MAX_PER_MONTH = 3;

/** One tag a menu row wears, never more. Wire values: never rename one. */
export const AiModelTag = {
  /** The maker's pick. */
  Best: "best",
  Free: "free",
  /** Runs on the person's plan. */
  Plan: "plan",
  /** On their own key: what this game costs on it. */
  CostLow: "cost-low",
  CostMedium: "cost-medium",
  CostHigh: "cost-high",
} as const;
export type AiModelTag = (typeof AiModelTag)[keyof typeof AiModelTag];

/** The menu's groups, by who makes the models. Wire values: never rename one. */
export const AiMaker = {
  Claude: "claude",
  ChatGpt: "chatgpt",
  Google: "google",
  Local: "local",
  Other: "other",
} as const;
export type AiMaker = (typeof AiMaker)[keyof typeof AiMaker];

/** One model the menu lists. */
export interface AiMenuRow {
  model: AiModelRef;
  label: string;
  /** The narrow bar's shorter name ("Haiku 4.5"). */
  shortLabel: string;
  funding: AiFunding;
  tag: AiModelTag | null;
  /** The model check's word on it; null when nobody checked it. */
  fit: AiCheckFit | null;
  /** It can answer now (signed in, downloaded, loaded). */
  ready: boolean;
}

/** Models of one maker. */
export interface AiMenuGroup {
  maker: AiMaker;
  /** How this group is paid: "your plan" beside Claude and ChatGPT models. */
  funding: AiFunding | null;
  rows: AiMenuRow[];
}

/** What the menu's top line says the game's AI costs, in the words of how it is paid. */
export type AiUsageLine =
  | { funding: typeof AiFunding.Plan; planUsedPercent: number; resetsAt: string | null }
  | { funding: typeof AiFunding.Free }
  | { funding: typeof AiFunding.Credits; sessionCredits: number; balanceCredits: number | null }
  | { funding: typeof AiFunding.Key; monthMicros: number }
  | { funding: typeof AiFunding.Playtest };

/** The Genex group: the person's credits, and the maker's pick that credits run. */
export interface AiGenexGroup {
  signedIn: boolean;
  balanceCredits: number | null;
  /** The maker's recommended model, which players on credits get; null when the game names none. */
  recommended: AiModelRef | null;
  recommendedLabel: string | null;
}

/** The AI pill's model menu for one game. */
export interface AiModelMenu {
  game: AiGameKey;
  title: string;
  /** The model the game uses now; null while AI is off or nothing is set up. */
  current: AiModelRef | null;
  usage: AiUsageLine | null;
  genex: AiGenexGroup;
  groups: AiMenuGroup[];
  /** Models the check marked weak here: folded under "N more may struggle". */
  struggling: AiMenuRow[];
  off: boolean;
  /** The game keeps a leaderboard: only Genex credits count on it. */
  leaderboard: boolean;
  requires: AiRequirement;
}

/** What a first-use card asks about. Wire values: never rename one. */
export const AiConsentKind = {
  /** The first time a game would use the person's plan. */
  Plan: "plan",
  /** The first time a game would spend Genex credits. */
  Credits: "credits",
  /** The first time a game would bill the person's own key. */
  Key: "key",
  /** A leaderboard game: credits, or play unranked. */
  Leaderboard: "leaderboard",
  /** Signed out with nothing set up, in a game that needs AI. */
  SetUp: "set-up",
  /** The embed-sdk's desktop confirm (D3): a grant or generation on genex.games, read by id. */
  GenexConfirm: "genex-confirm",
} as const;
export type AiConsentKind = (typeof AiConsentKind)[keyof typeof AiConsentKind];

/** A first-use card's facts. */
export interface AiConsentTicket {
  ticket: string;
  game: AiGameKey;
  title: string;
  kind: AiConsentKind;
  /** The model Genex picked; null on the set-up card. */
  model: AiModelRef | null;
  modelLabel: string | null;
  balanceCredits: number | null;
  /** On a plan: the share kept for building (games pause before it). */
  keepForBuildingPercent: number | null;
  /** On the set-up card: the download a model on this Mac needs, in bytes; null when none fits this Mac. */
  localDownloadBytes: number | null;
  /** On a Genex confirm: the most it may spend, in credits, read from genex.games. */
  maxCredits: number | null;
  expiresAt: string;
}

/** The person's answer to a card. */
export interface AiConsentAnswer {
  ticket: string;
  /** Play: yes, with the model the card named, or another chosen with Change. */
  approve: boolean;
  /** A model chosen with Change instead of the card's; null keeps the card's. */
  model: AiModelRef | null;
  /** On a leaderboard card: play unranked instead. */
  unranked: boolean;
}

/** What answering a card came to. */
export type AiConsentResult = { ok: true; model: AiModelRef | null } | { ok: false; code: AiConsentRefusal };

/** Why an answer did nothing. Wire values: never rename one. */
export const AiConsentRefusal = {
  /** The card lapsed, or another took its place. */
  Expired: "expired",
  /** The commit came inside the card's first 600 ms, or from a key repeat. */
  TooSoon: "too-soon",
  /** The model chosen cannot be used here. */
  Unavailable: "unavailable",
} as const;
export type AiConsentRefusal = (typeof AiConsentRefusal)[keyof typeof AiConsentRefusal];

/** Why the game's AI stopped, one card each (`V3-Stops`). Wire values: never rename one. */
export const AiStopReason = {
  OutOfCredits: "out-of-credits",
  PlanResting: "plan-resting",
  DailyAlert: "daily-alert",
  /** A game that needs AI, with AI turned off. */
  NeedsAiOff: "needs-ai-off",
  NotAnswering: "not-answering",
  /** The person picked a model the check marked weak here. */
  Struggles: "struggles",
  /** genex.games paused the game after a second auto top-up within a day (D11). */
  TopUpPaused: "top-up-paused",
} as const;
export type AiStopReason = (typeof AiStopReason)[keyof typeof AiStopReason];

/** Why a game's AI waits for the person to let it go on. Wire values: never rename one. */
export const AiPause = {
  /** It reached the daily alert the person set (Studio's own pause). */
  DailyAlert: "daily-alert",
  /** genex.games paused it after a second auto top-up within a day (D11). */
  AutoTopUp: "auto-topup",
} as const;
export type AiPause = (typeof AiPause)[keyof typeof AiPause];

/** A pause as the renderer sends it, or null. */
export const readAiPause = (raw: unknown): AiPause | null => readMember(AiPause, raw);

/** A game genex.games paused after its top-ups, as Settings lists it with Resume. */
export interface AiPausedGame {
  game: AiGameKey;
  /** Its name on genex.games; null when it has none there now. */
  title: string | null;
  /** When it paused (ISO). */
  pausedAt: string;
}

/** A stop card's facts. */
export interface AiStopCard {
  game: AiGameKey;
  title: string;
  reason: AiStopReason;
  model: AiModelRef | null;
  modelLabel: string | null;
  /** The one way on the card offers (a free model, the maker's pick); null when there is none. */
  alternative: AiModelRef | null;
  alternativeLabel: string | null;
  /** A resting plan's reset (ISO). */
  resetsAt: string | null;
  /** At the alert: what the game spent today, in credits. */
  spentCredits: number | null;
}

/** How Genex picks a model for a game (Settings → Games pick). Wire values: never rename one. */
export const AiPickPolicy = {
  /** The maker's pick if the person has it, else their best model that fits: free, then plan, then paid. */
  Best: "best",
  /** Only free models: a game asks before it spends anything else. */
  FreeOnly: "free-only",
} as const;
export type AiPickPolicy = (typeof AiPickPolicy)[keyof typeof AiPickPolicy];

/** Auto top-up as genex.games holds it (D11): off by default, with server-side caps. */
export interface AiAutoTopUp {
  on: boolean;
  underCredits: number;
  addCredits: number;
}

/** Settings → Play-time AI. */
export interface GameAiSettingsView {
  pick: AiPickPolicy;
  signedIn: boolean;
  balanceCredits: number | null;
  /** Genex Pro tops the balance up monthly; free accounts refill weekly. */
  pro: boolean | null;
  /** Null until read from genex.games (or signed out). */
  autoTopUp: AiAutoTopUp | null;
  /** Games genex.games paused after a second top-up within a day; each waits for Resume. */
  pausedGames: AiPausedGame[];
  /** Alert when a game spends this many credits in a day; null: no alert. */
  dailyAlertCredits: number | null;
  /** Games pause before they use this share of each plan. */
  keepForBuildingPercent: number;
  /** The person's own OpenRouter monthly limit, in USD micros; null: no limit. */
  openRouterMonthlyMicros: number | null;
  /** The Create Live route (D1), off by default. */
  createRouteEnabled: boolean;
  /** D2: the plan may answer the creator's own playtests. */
  allowPlan: boolean;
  /** Counts-only fit from play may be shared with genex.games (D12 follow-up). */
  shareFitCounts: boolean;
}

/** What Settings may change. */
export type GameAiSettingsPatch = Partial<
  Pick<
    GameAiSettingsView,
    | "pick"
    | "autoTopUp"
    | "dailyAlertCredits"
    | "keepForBuildingPercent"
    | "openRouterMonthlyMicros"
    | "createRouteEnabled"
    | "allowPlan"
    | "shareFitCounts"
  >
>;

/** One game in Settings' Games list. */
export interface AiGameRow {
  game: AiGameKey;
  title: string;
  model: AiModelRef | null;
  modelLabel: string | null;
  funding: AiFunding | null;
  /** Spent this calendar month on credits or the key, in USD micros; 0 when free or on a plan. */
  monthMicros: number;
  on: boolean;
  consent: AiConsent | null;
}

/** Settings' Games list. */
export interface AiActivity {
  games: AiGameRow[];
}

/** One saved playtest of a game. */
export interface AiTapeSummary {
  name: string;
  calls: number;
  sites: string[];
  /** Lines the reader refused. */
  rejected: number;
  bytes: number;
  recordedAt: string | null;
}

/** A credit pack as genex.games sells it: the price includes everything (D13), shown only at checkout. */
export interface AiCreditPack {
  id: string;
  credits: number;
  priceCents: number;
}

/** What Get credits sells. Wire values: never rename one. */
export const AiCreditProductKind = { Pack: "pack", Pro: "pro" } as const;
export type AiCreditProductKind = (typeof AiCreditProductKind)[keyof typeof AiCreditProductKind];

/** What Get credits opens checkout for, in the browser. */
export type AiCreditProduct =
  | { kind: typeof AiCreditProductKind.Pack; packId: string }
  | { kind: typeof AiCreditProductKind.Pro };

/** What the pill's pick asks for: use this model now, or the card that must come first. */
export type AiPickResult = { ok: true; model: AiModelRef } | { ok: false; consent: AiConsentTicket };

/** What `UiEvent.GameAi` says. Wire values: never rename one. */
export const GameAiNoticeKind = {
  /** A card must be shown (first use, leaderboard, set-up, a Genex confirm). */
  Consent: "consent",
  /** The card for this ticket is gone (answered elsewhere, lapsed, the game left). */
  ConsentClosed: "consent-closed",
  Stop: "stop",
  /** A game's AI changed: the pill, the menu and Settings read again. */
  Changed: "changed",
  /** A model check moved on. */
  Check: "check",
} as const;
export type GameAiNoticeKind = (typeof GameAiNoticeKind)[keyof typeof GameAiNoticeKind];

/** `UiEvent.GameAi`'s payload. */
export type GameAiNotice =
  | { kind: typeof GameAiNoticeKind.Consent; consent: AiConsentTicket }
  | { kind: typeof GameAiNoticeKind.ConsentClosed; ticket: string }
  | { kind: typeof GameAiNoticeKind.Stop; card: AiStopCard }
  | { kind: typeof GameAiNoticeKind.Changed; game: AiGameKey | null }
  | { kind: typeof GameAiNoticeKind.Check; project: string; done: number; total: number };

// ── readers for what the renderer sends ────────────────────────────────────────────────────

const TICKET_RE = /^[A-Za-z0-9_-]{8,100}$/;
const ENGINE_RE = /^[a-z][a-z0-9-]{0,39}$/;
const MODEL_MAX_CHARS = 200;

/** A model ref from the renderer, or null. */
export function readAiModelRef(raw: unknown): AiModelRef | null {
  if (!isPlainRecord(raw) || Object.keys(raw).length !== 3) return null;
  const door = readMember(AiDoor, raw.door);
  const { engine, model } = raw;
  if (!door || typeof engine !== "string" || !ENGINE_RE.test(engine)) return null;
  if (typeof model !== "string" || !model || model.length > MODEL_MAX_CHARS || /\p{Cc}/u.test(model)) return null;
  return { door, engine, model };
}

/** A card's answer from the renderer, or null. */
export function readAiConsentAnswer(raw: unknown): AiConsentAnswer | null {
  if (!isPlainRecord(raw) || Object.keys(raw).length !== 4) return null;
  const { ticket, approve, unranked } = raw;
  const model = raw.model === null ? null : readAiModelRef(raw.model);
  if (typeof ticket !== "string" || !TICKET_RE.test(ticket) || typeof approve !== "boolean") return null;
  if (typeof unranked !== "boolean" || (raw.model !== null && model === null)) return null;
  return { ticket, approve, model, unranked };
}

/** A Report from the renderer, or null: a game, a reason, and a note of at most 500 characters. */
export function readAiReportRequest(raw: unknown): AiReportRequest | null {
  if (!isPlainRecord(raw) || Object.keys(raw).length !== 3) return null;
  const game = readAiGameKey(raw.game);
  const reason = readMember(AiReportReason, raw.reason);
  const { note } = raw;
  if (!game || !reason) return null;
  if (note !== null && (typeof note !== "string" || note.length > AI_REPORT_NOTE_MAX_CHARS)) return null;
  return { game, reason, note: typeof note === "string" && note.trim() ? note : null };
}

/** Whether consent was given by a person's tap (not a silent free start). */
export const consentTapped = (consent: AiConsent | null): boolean => consent !== null && consent !== AiConsent.Silent;

const PACK_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** A checkout request from the renderer, or null. */
export function readAiCreditProduct(raw: unknown): AiCreditProduct | null {
  if (!isPlainRecord(raw)) return null;
  const kind = readMember(AiCreditProductKind, raw.kind);
  if (kind === AiCreditProductKind.Pro) return Object.keys(raw).length === 1 ? { kind } : null;
  const { packId } = raw;
  if (kind !== AiCreditProductKind.Pack || Object.keys(raw).length !== 2) return null;
  return typeof packId === "string" && PACK_ID_RE.test(packId) ? { kind, packId } : null;
}

/** The most credits a daily alert, or an auto top-up's threshold or amount, may name. */
export const AI_MAX_SETTING_CREDITS = 100_000;
/** The most a monthly OpenRouter limit may name, in USD micros ($10,000). */
export const AI_MAX_MONTHLY_MICROS = 10_000_000_000;

const isCredits = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= AI_MAX_SETTING_CREDITS;

function readAutoTopUp(raw: unknown): AiAutoTopUp | null {
  if (!isPlainRecord(raw) || Object.keys(raw).length !== 3) return null;
  const { on, underCredits, addCredits } = raw;
  if (typeof on !== "boolean" || !isCredits(underCredits) || !isCredits(addCredits)) return null;
  return { on, underCredits, addCredits };
}

/** Each field Settings may change and the reader of its value; undefined refuses the patch. */
const PATCH_READERS = {
  pick: (value: unknown) => readMember(AiPickPolicy, value) ?? undefined,
  autoTopUp: (value: unknown) => readAutoTopUp(value) ?? undefined,
  dailyAlertCredits: (value: unknown) => (value === null || isCredits(value) ? value : undefined),
  keepForBuildingPercent: (value: unknown) =>
    typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100 ? value : undefined,
  openRouterMonthlyMicros: (value: unknown) =>
    value === null ||
    (typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= AI_MAX_MONTHLY_MICROS)
      ? value
      : undefined,
  createRouteEnabled: (value: unknown) => (typeof value === "boolean" ? value : undefined),
  allowPlan: (value: unknown) => (typeof value === "boolean" ? value : undefined),
  shareFitCounts: (value: unknown) => (typeof value === "boolean" ? value : undefined),
} as const satisfies { [K in keyof GameAiSettingsPatch]-?: (value: unknown) => GameAiSettingsPatch[K] | undefined };

const isPatchKey = (key: string): key is keyof typeof PATCH_READERS => Object.hasOwn(PATCH_READERS, key);

/** A Settings change from the renderer, or null: known fields only, each in range, at least one. */
export function readGameAiSettingsPatch(raw: unknown): GameAiSettingsPatch | null {
  if (!isPlainRecord(raw)) return null;
  const keys = Object.keys(raw);
  if (keys.length === 0) return null;
  const patch: GameAiSettingsPatch = {};
  for (const key of keys) {
    if (!isPatchKey(key)) return null;
    const value = PATCH_READERS[key](raw[key]);
    if (value === undefined) return null;
    Object.assign(patch, { [key]: value });
  }
  return patch;
}
