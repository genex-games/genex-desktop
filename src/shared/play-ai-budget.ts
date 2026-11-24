/**
 * A native game's AI budget (docs/play.md, "AI budget"): a game can ask AI models for things while
 * it is played, paid from the player's Genex credits up to a limit they set on the game's page
 * before Play. genex.games is the authority on every number here: the app shows what it answered
 * and sends back only a limit inside the bounds it gave. Browser-safe.
 */

/** Where a budget stands on genex.games. Values are its own: never rename one. */
export const AiBudgetStatus = {
  /** A quote the player has yet to approve. */
  RequiresConfirmation: "requires_confirmation",
  Active: "active",
  /** Live, but the account has too few credits for the next call. */
  SuspendedInsufficientFunds: "suspended_insufficient_funds",
  WaitingForPlan: "waiting_for_plan",
  Exhausted: "exhausted",
  Stopped: "stopped",
  Expired: "expired",
} as const;
export type AiBudgetStatus = (typeof AiBudgetStatus)[keyof typeof AiBudgetStatus];

const STATUSES: ReadonlySet<string> = new Set(Object.values(AiBudgetStatus));
const LIVE: ReadonlySet<AiBudgetStatus> = new Set([
  AiBudgetStatus.Active,
  AiBudgetStatus.SuspendedInsufficientFunds,
  AiBudgetStatus.WaitingForPlan,
]);

/** Whether a value is a status genex.games gives a budget. */
export const isAiBudgetStatus = (value: unknown): value is AiBudgetStatus =>
  typeof value === "string" && STATUSES.has(value);

/** Whether a budget with this status is running: the game's calls are paid under it. */
export const isLiveBudget = (status: AiBudgetStatus): boolean => LIVE.has(status);

/** What a game's estimate is counted over. Values are genex.games' own: never rename one. */
export const AiBudgetPeriod = { Minute: "minute", Hour: "hour", Session: "session" } as const;
export type AiBudgetPeriod = (typeof AiBudgetPeriod)[keyof typeof AiBudgetPeriod];

const PERIODS: ReadonlySet<string> = new Set(Object.values(AiBudgetPeriod));

/** Whether a value is a period genex.games counts an estimate over. */
export const isAiBudgetPeriod = (value: unknown): value is AiBudgetPeriod =>
  typeof value === "string" && PERIODS.has(value);

/**
 * Why a budget call was refused. The first group are genex.games' own codes (never rename one); the
 * last are the app's: no sign-in, a voice budget it does not offer, and a code it does not know.
 */
export const AiBudgetRefusal = {
  NotDeclared: "model_budget_not_declared",
  ModelNotAvailable: "model_not_available",
  GenerationPaused: "generation_paused",
  ProviderUnavailable: "provider_unavailable",
  ProjectNotFound: "project_not_found",
  GameUnavailable: "game_unavailable",
  InvalidLimit: "invalid_grant_limit",
  LimitBelowCallCeiling: "grant_limit_below_call_ceiling",
  QuoteExpired: "quote_expired",
  QuoteMismatch: "quote_mismatch",
  BillingPolicyMismatch: "billing_policy_mismatch",
  InsufficientCredits: "insufficient_credits",
  /** The account's email is not verified, so it cannot pay with credits. */
  CreditsUnverified: "credits_unverified",
  SessionRevoked: "session_revoked",
  GrantNotFound: "grant_not_found",
  CredentialScope: "credential_scope",
  /** The app is not signed in to Genex. */
  SignedOut: "signed_out",
  /** The budget covers voice, which the app does not offer yet: nothing is approved here. */
  Voice: "voice_unsupported",
  Unknown: "unknown",
} as const;
export type AiBudgetRefusal = (typeof AiBudgetRefusal)[keyof typeof AiBudgetRefusal];

const REFUSALS: readonly AiBudgetRefusal[] = Object.values(AiBudgetRefusal);

/** The refusal a code names; a code the app does not know (or none) is {@link AiBudgetRefusal.Unknown}. */
export const aiBudgetRefusalOf = (code: unknown): AiBudgetRefusal =>
  REFUSALS.find((known) => known === code) ?? AiBudgetRefusal.Unknown;

/** What a game says it spends: about this many credits per period. */
export interface AiBudgetEstimate {
  period: AiBudgetPeriod;
  credits: number;
}

/** What a game's maker declared, as its page reads it before anybody is asked anything. */
export interface AiBudgetDeclared {
  /** The models' names as genex.games shows them. */
  models: string[];
  /** An AI judge checks the answers. */
  judge: boolean;
  /** The game listens or speaks: the app does not offer voice yet, so it approves nothing for it. */
  voice: boolean;
  /** Null when genex.games gave none. */
  estimate: AiBudgetEstimate | null;
  /** False while a declared model is not served: opening the budget would be refused. */
  available: boolean;
}

/** A budget the player approved, as genex.games counts it. */
export interface AiBudgetView {
  status: AiBudgetStatus;
  limitCredits: number;
  spentCredits: number;
  /** Set aside for calls whose bill is not final yet. */
  heldCredits: number;
  remainingCredits: number;
  /** When it ends by itself (ISO). */
  expiresAt: string;
  /** The player stopped it, and a call that had started is still finishing. */
  stopping: boolean;
}

/** The limits a player may choose between, in credits: `minCredits` plus whole steps, up to `maxCredits`. */
export interface AiBudgetLimit {
  minCredits: number;
  maxCredits: number;
  stepCredits: number;
  defaultCredits: number;
}

/** A budget opened for approval: what the sheet shows before Approve. Good for a few minutes. */
export interface AiBudgetQuote {
  /** The most one call may cost. */
  perCallMaxCredits: number;
  /** Null when genex.games gave none. */
  estimate: AiBudgetEstimate | null;
  limit: AiBudgetLimit;
  /** Approving ends a budget already running for this game. */
  replaces: boolean;
  /** When the quote lapses (ISO). */
  expiresAt: string;
}

/** A game page's read: what the game declared and the player's budget in it, if any. */
export interface AiBudgetRead {
  /** The app is signed out, so genex.games was not asked: neither field says anything. */
  signedOut: boolean;
  declared: AiBudgetDeclared | null;
  current: AiBudgetView | null;
}

/** Opening the budget for approval: the quote, or why there is none. */
export type AiBudgetOpened = { quote: AiBudgetQuote } | { refused: AiBudgetRefusal };

/** Approve: the budget now running, or why it is not. */
export type AiBudgetConfirmed = { current: AiBudgetView } | { refused: AiBudgetRefusal };

/** Stop: the budget after it (null when none was running), or why it still runs. */
export type AiBudgetStopped = { current: AiBudgetView | null } | { refused: AiBudgetRefusal };

/** Whether `value` is a limit the quote offers: a whole number of steps from its least, within its most. */
export function limitOffered(limit: AiBudgetLimit, value: unknown): value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return false;
  const inside = value >= limit.minCredits && value <= limit.maxCredits;
  return inside && (value - limit.minCredits) % limit.stepCredits === 0;
}

/** The offered limit nearest `value`: what a slider over the quote's bounds lands on. */
export function nearestLimit(limit: AiBudgetLimit, value: number): number {
  const { minCredits, maxCredits, stepCredits } = limit;
  const top = minCredits + Math.floor((maxCredits - minCredits) / stepCredits) * stepCredits;
  if (!Number.isFinite(value)) return minCredits;
  const steps = Math.round((value - minCredits) / stepCredits);
  return Math.min(top, Math.max(minCredits, minCredits + steps * stepCredits));
}
