/**
 * Play's bar layer: the transparent page main lays over a game in the viewer (`renderer/play-bar.html`).
 * Its preload (`preload/play-bar.ts`) gives it only these calls of the studio's bridge, and it tells
 * main what holds the bar up. The bar also carries the game's AI pill: the chat's model button, which
 * names the model, opens the model menu, and drops Genex's own cards over the game.
 */
import type { AiFunding, AiGameKey, AiModelRef } from "./game-ai.ts";
import type { AiModelTag } from "./game-ai-views.ts";
import type { StudioApi } from "./studio-api.ts";

/**
 * The studio calls the bar's layer may make: the viewer's news, its controls, its game's comments and
 * AI. Get credits reads the packs and the person's auto top-up, and saves its switch; every spend
 * still waits for a card's yes or checkout in the browser.
 */
export const PLAY_BAR_CALLS = [
  "onEvent",
  "playControl",
  "playClose",
  "playBar",
  "playComments",
  "playComment",
  "playUncomment",
  "gameAiMenu",
  "gameAiPick",
  "gameAiAnswer",
  "gameAiEnable",
  "gameAiReportPreview",
  "gameAiReport",
  "gameAiCheckout",
  "gameAiCredits",
  "gameAiSettings",
  "gameAiSettingsSave",
] as const satisfies readonly (keyof StudioApi)[];

/** The bridge the bar's layer gets. */
export type PlayBarApi = Pick<StudioApi, (typeof PLAY_BAR_CALLS)[number]>;

/**
 * What the bar's layer has open over the dimmed game, holding the whole window: one at a time.
 * Wire values: never rename one.
 */
export const PlayBarOverlay = {
  Comments: "comments",
  /** The AI pill's model menu. */
  AiMenu: "ai-menu",
  /** A first-use card or a stop card. */
  AiCard: "ai-card",
  /** Report what the AI wrote. */
  AiReport: "ai-report",
  /** Get Genex credits. */
  AiCredits: "ai-credits",
} as const;
export type PlayBarOverlay = (typeof PlayBarOverlay)[keyof typeof PlayBarOverlay];

const OVERLAYS: ReadonlySet<unknown> = new Set(Object.values(PlayBarOverlay));
/** Whether a value names an overlay. */
export const isPlayBarOverlay = (value: unknown): value is PlayBarOverlay => OVERLAYS.has(value);

/**
 * What the bar's layer tells main about itself: the pointer or the keyboard is on it, or one of its
 * overlays is open; `ready` once its page has mounted, so main draws the bar again for a page that
 * loaded late.
 */
export interface PlayBarHold {
  held: boolean;
  overlay: PlayBarOverlay | null;
  ready?: boolean;
}

/** Where the pill stands. Wire values: never rename one. */
export const PlayAiPhase = {
  /** It names the model the game uses. */
  Ready: "ready",
  /** A reply is on its way: the pill shimmers (`aria-busy`). */
  Writing: "writing",
  /** A card waits for the person ("AI · Choose"). */
  NeedsYou: "needs-you",
  /** AI is off for this game. */
  Off: "off",
} as const;
export type PlayAiPhase = (typeof PlayAiPhase)[keyof typeof PlayAiPhase];

/** The pill's notes under itself, which then fade. Wire values: never rename one. */
export const PlayAiNote = {
  /** "AI is on · <model>, <how it is paid>". */
  FirstUse: "first-use",
  /** "Your plan is resting. Switched to <model>, free". */
  PlanResting: "plan-resting",
  TurnedOff: "turned-off",
  /** "Added <n> credits · <balance> now". */
  CreditsAdded: "credits-added",
  ReportSent: "report-sent",
} as const;
export type PlayAiNote = (typeof PlayAiNote)[keyof typeof PlayAiNote];

/** How long each note shows, in ms (`V3-Pill`, `Report-v2`). */
export const PLAY_AI_NOTE_MS = {
  [PlayAiNote.FirstUse]: 4_000,
  [PlayAiNote.PlanResting]: 4_000,
  [PlayAiNote.TurnedOff]: 2_000,
  [PlayAiNote.CreditsAdded]: 2_000,
  [PlayAiNote.ReportSent]: 2_200,
} as const satisfies Record<PlayAiNote, number>;

/** The pill, as main draws it (`PlayBarState.ai`); null until the game says hello to its AI. */
export interface PlayAiBar {
  /** The game as play-time AI keys it, which the pill's calls name (`gameAiMenu`, `gameAiPick`…). */
  game: AiGameKey;
  phase: PlayAiPhase;
  model: AiModelRef | null;
  label: string | null;
  /** The narrow bar's shorter name. */
  shortLabel: string | null;
  funding: AiFunding | null;
  tag: AiModelTag | null;
  /** On Genex credits: the balance the pill shows. */
  balanceCredits: number | null;
  /** The balance is at or under `AI_LOW_CREDITS`. */
  lowCredits: boolean;
  /** A leaderboard game played on a model that does not count. */
  unranked: boolean;
  note: PlayAiNote | null;
  /** With `CreditsAdded`: how many came. */
  addedCredits: number | null;
}
