/**
 * The Play bar's AI pill and its overlays, decided (design v3, the `V3-*` canvas boards): what the
 * pill says, which note it wears and for how long, the model menu's groups and its Genex row, the
 * cards main asks for (a first-use card, then a stop card, one per game), what each card's buttons
 * mean, the packs Get credits offers, where a card hangs, and the bounded, plain preview of what a
 * Report sends. Pure: `PlayAiPill.tsx` and its overlays draw what these decide; the words are
 * `PLAY_AI_WORDS`.
 */
import { AiFunding, type AiGameKey, type AiModelRef } from "../../shared/game-ai.ts";
import type { AiReportBundle } from "../../shared/game-ai-report.ts";
import {
  AI_AUTO_TOPUP_ADD_CREDITS,
  AI_AUTO_TOPUP_UNDER_CREDITS,
  type AiAutoTopUp,
  AiConsentKind,
  type AiConsentAnswer,
  AiConsentRefusal,
  type AiConsentResult,
  type AiConsentTicket,
  type AiCreditPack,
  AiCreditProductKind,
  AiMaker,
  type AiMenuGroup,
  type AiModelMenu,
  type AiStopCard,
  AiStopReason,
  type GameAiNotice,
  GameAiNoticeKind,
  type GameAiSettingsPatch,
  readAiCreditProduct,
} from "../../shared/game-ai-views.ts";
import { PLAY_AI_NOTE_MS, type PlayAiBar, PlayAiNote, PlayAiPhase, PlayBarOverlay } from "../../shared/play-bar.ts";

/** A card's yes counts only once it has been on screen this long: no click meant for the game lands on it. */
export const CARD_COMMIT_GATE_MS = 600;
/** The bar's height: a card or the menu hangs under it when the pill cannot be measured. */
const BAR_HEIGHT_PX = 48;
/** The gap between the pill and what hangs from it. */
const DROP_GAP_PX = 6;
/** The least room kept between a card and the window's right edge. */
const EDGE_PX = 16;
/** The pack Get credits picks first (`V3-TopUp`). */
const DEFAULT_PACK_CREDITS = 2_500;
/** The most packs Get credits lays out: genex.games sells four. */
const MAX_PACKS = 8;
/** The longest piece of a Report's preview: the player's words or the AI's, each. */
export const REPORT_PREVIEW_CHARS = 600;
/** The most AI moments a Report's preview lists: the newest. */
export const REPORT_PREVIEW_MOMENTS = 50;

/** Where reading something from main stands (the menu, the packs, what a Report sends). Never rename a value. */
export const AiLoad = { Loading: "loading", Ready: "ready", Failed: "failed" } as const;
export type AiLoad = (typeof AiLoad)[keyof typeof AiLoad];

// ── the pill ────────────────────────────────────────────────────────────────────────────────

/** What the pill's name says. Never rename a value. */
export const PillName = {
  /** The model's name. */
  Model: "model",
  /** "Credits", with the balance after it. */
  Credits: "credits",
  /** "AI · Choose": a card waits, or no model is set up yet. */
  Choose: "choose",
  /** "AI off". */
  Off: "off",
} as const;
export type PillName = (typeof PillName)[keyof typeof PillName];

/** The quieter word after the name. Never rename a value. */
export const PillValue = {
  None: "none",
  /** "Free": a model nobody pays for. */
  Free: "free",
  /** The credit balance. */
  Balance: "balance",
  /** A leaderboard game on a model that does not count. */
  Unranked: "unranked",
} as const;
export type PillValue = (typeof PillValue)[keyof typeof PillValue];

/** The pill as drawn. */
export interface PillView {
  name: PillName;
  value: PillValue;
  /** The model's name, whole and short (the narrow bar's). */
  label: string;
  short: string;
  balance: number | null;
  /** The balance is low: it reads in orange. */
  warn: boolean;
  /** A reply is on its way: the name shimmers. */
  busy: boolean;
  /** A card waits for the person: the pill wears Play's blue edge. */
  attention: boolean;
}

/** The word after the model's name. */
function pillValue(ai: PlayAiBar): PillValue {
  if (ai.unranked) return PillValue.Unranked;
  return ai.funding === AiFunding.Free ? PillValue.Free : PillValue.None;
}

/** What the pill says for the bar main drew (`V3-Pill`). */
export function pillView(ai: PlayAiBar): PillView {
  const label = ai.label ?? "";
  const base = { label, short: ai.shortLabel ?? label, balance: null, warn: false, busy: false, attention: false };
  if (ai.phase === PlayAiPhase.Off) return { ...base, name: PillName.Off, value: PillValue.None };
  if (ai.phase === PlayAiPhase.NeedsYou)
    return { ...base, name: PillName.Choose, value: PillValue.None, attention: true };
  if (!ai.model || !ai.label) return { ...base, name: PillName.Choose, value: PillValue.None };
  const busy = ai.phase === PlayAiPhase.Writing;
  if (ai.funding === AiFunding.Credits && ai.balanceCredits !== null && !ai.unranked)
    return {
      ...base,
      name: PillName.Credits,
      value: PillValue.Balance,
      balance: ai.balanceCredits,
      warn: ai.lowCredits,
      busy,
    };
  return { ...base, name: PillName.Model, value: pillValue(ai), busy };
}

/** A note the pill wears, from when it first came until its time is up. */
export interface ShownNote {
  note: PlayAiNote;
  /** What makes it this note and not an earlier one of the same kind (another top-up). */
  key: string;
  until: number;
}

const noteKey = (ai: PlayAiBar): string => `${ai.note}:${ai.addedCredits ?? ""}`;

/**
 * The note after main's news at `now`: the same note keeps its time, a new one (or another top-up)
 * starts its own, and a note main dropped is gone.
 */
export function noteFor(shown: ShownNote | null, ai: PlayAiBar | null, now: number): ShownNote | null {
  if (!ai?.note) return null;
  const key = noteKey(ai);
  if (shown?.key === key) return shown;
  return { note: ai.note, key, until: now + PLAY_AI_NOTE_MS[ai.note] };
}

/** Notes that say something is done: worn with a check over a green tint (`Report-v2`). */
const DONE_NOTES: ReadonlySet<PlayAiNote> = new Set([PlayAiNote.CreditsAdded, PlayAiNote.ReportSent]);

/** Whether a note says something is done. */
export const noteDone = (note: PlayAiNote): boolean => DONE_NOTES.has(note);

// ── the model menu ──────────────────────────────────────────────────────────────────────────

/** Whether two refs name the same model through the same door. */
export const sameModel = (a: AiModelRef | null, b: AiModelRef | null): boolean =>
  a !== null && b !== null && a.door === b.door && a.engine === b.engine && a.model === b.model;

/** The menu's groups with a model in them, makers first and local models last, as the chat's menu lists them. */
export function menuGroups(menu: AiModelMenu): AiMenuGroup[] {
  return menu.groups
    .filter((group) => group.rows.length > 0)
    .sort((a, b) => Number(a.maker === AiMaker.Local) - Number(b.maker === AiMaker.Local));
}

/** What the Genex credits row does. Never rename a value. */
export const GenexRowAction = {
  /** Play on credits with the maker's pick. */
  Pick: "pick",
  /** Signed out: sign in to use credits. */
  SignIn: "sign-in",
  /** The game names no model for credits: the row only says so. */
  None: "none",
} as const;
export type GenexRowAction = (typeof GenexRowAction)[keyof typeof GenexRowAction];

/** The Genex credits row. */
export type GenexRow =
  | { action: typeof GenexRowAction.Pick; model: AiModelRef; current: boolean }
  | { action: typeof GenexRowAction.SignIn | typeof GenexRowAction.None; model: null; current: false };

/** The Genex credits row of a menu. */
export function genexRow(menu: AiModelMenu): GenexRow {
  const { genex } = menu;
  if (!genex.signedIn) return { action: GenexRowAction.SignIn, model: null, current: false };
  if (!genex.recommended) return { action: GenexRowAction.None, model: null, current: false };
  return { action: GenexRowAction.Pick, model: genex.recommended, current: sameModel(menu.current, genex.recommended) };
}

// ── the cards main asks for ─────────────────────────────────────────────────────────────────

/** The cards waiting, by game: at most one first-use card and one stop card each. */
export interface AiCards {
  consents: Readonly<Record<AiGameKey, AiConsentTicket>>;
  stops: Readonly<Record<AiGameKey, AiStopCard>>;
  /** Counts main's "changed" news, so an open menu reads again. */
  changed: number;
}

/** No cards. */
export const NO_CARDS: AiCards = { consents: {}, stops: {}, changed: 0 };

/** What kind of card shows. Never rename a value. */
export const AiCardKind = { Consent: "consent", Stop: "stop" } as const;
export type AiCardKind = (typeof AiCardKind)[keyof typeof AiCardKind];

/** The card a game shows. */
export type AiCard =
  | { kind: typeof AiCardKind.Consent; consent: AiConsentTicket }
  | { kind: typeof AiCardKind.Stop; card: AiStopCard };

/** The cards without the first-use card of `ticket`; the same cards when none has it. */
export function withoutConsent(cards: AiCards, ticket: string): AiCards {
  const entry = Object.entries(cards.consents).find(([, consent]) => consent.ticket === ticket);
  if (!entry) return cards;
  const consents = { ...cards.consents };
  delete consents[entry[0] as AiGameKey];
  return { ...cards, consents };
}

/** The cards without `game`'s stop card. */
export function withoutStop(cards: AiCards, game: AiGameKey): AiCards {
  if (!Object.hasOwn(cards.stops, game)) return cards;
  const stops = { ...cards.stops };
  delete stops[game];
  return { ...cards, stops };
}

/** The cards after main's news: the newest card of each kind replaces the one before it. */
export function cardsAfter(cards: AiCards, notice: GameAiNotice): AiCards {
  switch (notice.kind) {
    case GameAiNoticeKind.Consent:
      return { ...cards, consents: { ...cards.consents, [notice.consent.game]: notice.consent } };
    case GameAiNoticeKind.ConsentClosed:
      return withoutConsent(cards, notice.ticket);
    case GameAiNoticeKind.Stop:
      return { ...cards, stops: { ...cards.stops, [notice.card.game]: notice.card } };
    case GameAiNoticeKind.Changed:
      return { ...cards, changed: cards.changed + 1 };
    default:
      return cards;
  }
}

/** Whether a first-use card has lapsed by `now` (an unreadable time counts as lapsed). */
const lapsed = (consent: AiConsentTicket, now: number): boolean => !(Date.parse(consent.expiresAt) > now);

/** The card `game` shows at `now`: its first-use card unless it lapsed, else its stop card. */
export function cardFor(cards: AiCards, game: AiGameKey, now: number): AiCard | null {
  const consent = Object.hasOwn(cards.consents, game) ? cards.consents[game] : undefined;
  if (consent && !lapsed(consent, now)) return { kind: AiCardKind.Consent, consent };
  const card = Object.hasOwn(cards.stops, game) ? cards.stops[game] : undefined;
  return card ? { kind: AiCardKind.Stop, card } : null;
}

/** A card's identity: a first-use card's ticket, or a stop card's game and why. */
export const cardKey = (card: AiCard): string =>
  card.kind === AiCardKind.Consent
    ? `${AiCardKind.Consent}:${card.consent.ticket}`
    : `${AiCardKind.Stop}:${card.card.game}:${card.card.reason}`;

/** What the pill's press opens: the card that waits, else the model menu. */
export const pillOpens = (card: AiCard | null): PlayBarOverlay =>
  card ? PlayBarOverlay.AiCard : PlayBarOverlay.AiMenu;

/**
 * The bar's overlay after the cards changed: a card that comes opens itself over nothing else, unless
 * the person set it aside (it then waits on the pill); a card that goes takes its overlay with it.
 */
export function overlayForCard(
  open: PlayBarOverlay | null,
  card: AiCard | null,
  setAside: string | null,
): PlayBarOverlay | null {
  if (open === PlayBarOverlay.AiCard) return card ? open : null;
  if (open !== null || !card) return open;
  return cardKey(card) === setAside ? null : PlayBarOverlay.AiCard;
}

/** What a model picked in the menu asks main: the answer to the card being changed, else a pick. */
export type PickRequest = { answer: AiConsentAnswer } | { pick: AiModelRef };

/** The request for a model picked in the menu, with `changing` the first-use card its Change opened it for. */
export function pickRequest(changing: AiConsentTicket | null, model: AiModelRef): PickRequest {
  const answer = changing ? consentAnswer(changing, ConsentAction.Change, model) : null;
  return answer ? { answer } : { pick: model };
}

/** The cards after main's word on an answer, and what to tell the person when a model was refused. */
export function afterAnswer(
  cards: AiCards,
  ticket: string,
  result: AiConsentResult,
): { cards: AiCards; problem: AiConsentRefusal | null } {
  if (result.ok || result.code === AiConsentRefusal.Expired)
    return { cards: withoutConsent(cards, ticket), problem: null };
  // Too soon: the yes came inside the card's first moments; the card stays for a real one.
  return { cards, problem: result.code === AiConsentRefusal.Unavailable ? result.code : null };
}

/** Whether a card shown at `shownAt` takes a yes at `now`. */
export const commitReady = (shownAt: number, now: number): boolean => now - shownAt >= CARD_COMMIT_GATE_MS;

/** A first-use card's buttons. Never rename a value. */
export const ConsentAction = {
  Play: "play",
  PlayOnCredits: "play-on-credits",
  PlayFree: "play-free",
  Allow: "allow",
  /** Opens the model menu; the model picked there answers the card. */
  Change: "change",
  PlayUnranked: "play-unranked",
  SignIn: "sign-in",
  NotNow: "not-now",
} as const;
export type ConsentAction = (typeof ConsentAction)[keyof typeof ConsentAction];

/** A card's two buttons: the primary first; a card with one way on has no secondary. */
export interface CardActions<A> {
  primary: A;
  secondary: A | null;
}

const CONSENT_ACTIONS = {
  [AiConsentKind.Plan]: { primary: ConsentAction.Play, secondary: ConsentAction.Change },
  [AiConsentKind.Credits]: { primary: ConsentAction.Play, secondary: ConsentAction.Change },
  [AiConsentKind.Key]: { primary: ConsentAction.Play, secondary: ConsentAction.Change },
  [AiConsentKind.Leaderboard]: { primary: ConsentAction.PlayOnCredits, secondary: ConsentAction.PlayUnranked },
  [AiConsentKind.SetUp]: { primary: ConsentAction.PlayFree, secondary: ConsentAction.SignIn },
  [AiConsentKind.GenexConfirm]: { primary: ConsentAction.Allow, secondary: ConsentAction.NotNow },
} as const satisfies Record<AiConsentKind, CardActions<ConsentAction>>;

/** A first-use card's buttons (`V3-First`). */
export const consentActions = (ticket: AiConsentTicket): CardActions<ConsentAction> => CONSENT_ACTIONS[ticket.kind];

/**
 * What a first-use card's button answers: yes with the card's model, yes with one picked in the menu
 * (Change), yes unranked, or no. Sign in, and Change before a model is picked, answer nothing here.
 */
export function consentAnswer(
  ticket: AiConsentTicket,
  action: ConsentAction,
  model: AiModelRef | null = null,
): AiConsentAnswer | null {
  const answer = { ticket: ticket.ticket, approve: true, model: null, unranked: false };
  switch (action) {
    case ConsentAction.Change:
      return model ? { ...answer, model } : null;
    case ConsentAction.PlayUnranked:
      return { ...answer, unranked: true };
    case ConsentAction.NotNow:
      return { ...answer, approve: false };
    case ConsentAction.SignIn:
      return null;
    default:
      return answer;
  }
}

/** A stop card's buttons. Never rename a value. */
export const StopAction = {
  GetCredits: "get-credits",
  /** Use the card's alternative model. */
  UseAlternative: "use-alternative",
  Ok: "ok",
  /** Opens the model menu. */
  Change: "change",
  KeepPlaying: "keep-playing",
  /** Leaves the game for today. */
  StopToday: "stop-today",
  TurnOn: "turn-on",
  BackToPlay: "back-to-play",
  /** Keep the model the check marked weak. */
  Keep: "keep",
  /** Opens the model menu. */
  UseAnother: "use-another",
} as const;
export type StopAction = (typeof StopAction)[keyof typeof StopAction];

/** A stop card's buttons (`V3-Stops`): only ways on the card can keep. */
export function stopActions(card: AiStopCard): CardActions<StopAction> {
  const alternative = card.alternative !== null;
  switch (card.reason) {
    case AiStopReason.OutOfCredits:
      return {
        primary: StopAction.GetCredits,
        secondary: alternative ? StopAction.UseAlternative : StopAction.BackToPlay,
      };
    case AiStopReason.PlanResting:
      return { primary: StopAction.Ok, secondary: StopAction.Change };
    case AiStopReason.DailyAlert:
      return { primary: StopAction.KeepPlaying, secondary: StopAction.StopToday };
    case AiStopReason.NeedsAiOff:
      return { primary: StopAction.TurnOn, secondary: StopAction.BackToPlay };
    case AiStopReason.NotAnswering:
      return { primary: StopAction.UseAnother, secondary: null };
    case AiStopReason.Struggles:
      return alternative
        ? { primary: StopAction.UseAlternative, secondary: StopAction.Keep }
        : { primary: StopAction.Keep, secondary: StopAction.Change };
  }
}

/** Where a card or the menu hangs: under the pill's right edge, inside the window. */
export function placeUnder(
  pill: { bottom: number; right: number } | null,
  windowWidth: number,
): { top: number; right: number } {
  if (!pill) return { top: BAR_HEIGHT_PX + DROP_GAP_PX, right: EDGE_PX };
  return { top: pill.bottom + DROP_GAP_PX, right: Math.max(EDGE_PX, windowWidth - pill.right) };
}

// ── Get credits ─────────────────────────────────────────────────────────────────────────────

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/** Whether a pack can be sold: an id checkout takes, whole credits and a whole price. */
const sellable = (pack: AiCreditPack): boolean =>
  isCount(pack.credits) &&
  isCount(pack.priceCents) &&
  readAiCreditProduct({ kind: AiCreditProductKind.Pack, packId: pack.id }) !== null;

/** The packs Get credits lays out: sellable ones, each id once (its first), smallest first. */
export function packsShown(packs: readonly AiCreditPack[]): AiCreditPack[] {
  const seen = new Set<string>();
  const shown: AiCreditPack[] = [];
  for (const pack of packs) {
    if (seen.has(pack.id) || !sellable(pack)) continue;
    seen.add(pack.id);
    shown.push(pack);
  }
  return shown.sort((a, b) => a.credits - b.credits).slice(0, MAX_PACKS);
}

/** The pack Get credits picks first: 2,500 credits, else the smallest; null with nothing to sell. */
export function defaultPack(packs: readonly AiCreditPack[]): string | null {
  const shown = packsShown(packs);
  return (shown.find((pack) => pack.credits === DEFAULT_PACK_CREDITS) ?? shown[0])?.id ?? null;
}

/** Auto top-up switched on or off: the amounts the person set stay, else the defaults (D11). */
export function autoTopUpPatch(current: AiAutoTopUp | null, on: boolean): GameAiSettingsPatch {
  return {
    autoTopUp: {
      on,
      underCredits: current?.underCredits ?? AI_AUTO_TOPUP_UNDER_CREDITS,
      addCredits: current?.addCredits ?? AI_AUTO_TOPUP_ADD_CREDITS,
    },
  };
}

// ── a Report's "See what's sent" ────────────────────────────────────────────────────────────

/** One AI moment as the preview shows it: plain text only. */
export interface ReportMoment {
  site: string;
  model: string | null;
  /** What the player said, their fields joined; null when they said nothing. */
  said: string | null;
  /** What the AI wrote, raw, else its value as JSON; null when it wrote nothing. */
  wrote: string | null;
}

/** Control characters other than a line break or a tab, and the marks that turn text around. */
const UNSHOWN_RE = /(?![\n\t])[\p{Cc}\p{Bidi_Control}]/gu;

/** The first half of a character outside the BMP: a cut never splits one. */
const HIGH_SURROGATE_MIN = 0xd800;
const HIGH_SURROGATE_MAX = 0xdbff;

/** Text the preview can show: no control characters, at most `REPORT_PREVIEW_CHARS` and an ellipsis. */
function plain(text: string): string {
  const clean = text.slice(0, REPORT_PREVIEW_CHARS * 4).replace(UNSHOWN_RE, "");
  if (clean.length <= REPORT_PREVIEW_CHARS) return clean;
  const code = clean.charCodeAt(REPORT_PREVIEW_CHARS - 1);
  const cut =
    code >= HIGH_SURROGATE_MIN && code <= HIGH_SURROGATE_MAX ? REPORT_PREVIEW_CHARS - 1 : REPORT_PREVIEW_CHARS;
  return `${clean.slice(0, cut)}…`;
}

/** A parsed value as text, or null when there is none or it is no JSON. */
function valueText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  try {
    const text: unknown = JSON.stringify(value);
    return typeof text === "string" ? text : null;
  } catch {
    return null;
  }
}

/** The newest AI moments of a Report, as "See what's sent" lists them. */
export function reportMoments(bundle: AiReportBundle): ReportMoment[] {
  return bundle.calls.slice(-REPORT_PREVIEW_MOMENTS).map((call) => {
    const fields = Object.values(call.untrusted).filter((value) => typeof value === "string" && value);
    const wrote = call.rawOutput ?? valueText(call.value);
    return {
      site: plain(call.site),
      model: call.model === null ? null : plain(call.model),
      said: fields.length ? plain(fields.join(" · ")) : null,
      wrote: wrote === null ? null : plain(wrote),
    };
  });
}

/** What else a Report sends, counted. */
export interface ReportExtras {
  moments: number;
  inputs: number;
  frame: boolean;
  consoleErrors: number;
}

/** What else a Report sends besides the moments listed. */
export const reportExtras = (bundle: AiReportBundle): ReportExtras => ({
  moments: bundle.calls.length,
  inputs: bundle.replay.inputs.length,
  frame: bundle.frame !== null,
  consoleErrors: bundle.consoleErrors.length,
});
