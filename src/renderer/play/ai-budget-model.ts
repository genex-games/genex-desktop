/**
 * A native game's AI budget on its page (`AiBudget.tsx`), as pure decisions: what the one line under
 * the primary block says for what genex.games answered, the steps of the sheet that sets a budget,
 * which sentence a refusal gets and what it offers next, and when the count is read again. Every
 * number shown is one genex.games gave; the only number chosen here is a limit its quote offers.
 */
import { SECOND_MS } from "../../shared/duration.ts";
import {
  type AiBudgetConfirmed,
  type AiBudgetOpened,
  type AiBudgetQuote,
  type AiBudgetRead,
  AiBudgetRefusal,
  type AiBudgetView,
  isLiveBudget,
  nearestLimit,
} from "../../shared/play-ai-budget.ts";
import { GamePhase } from "./native-model.ts";

/** How often a running budget's count is read again while its game is played. */
export const BUDGET_REFRESH_MS = 30 * SECOND_MS;

/** What the line under a native game's primary block says. Values mark it in the page (`data-ai-budget-line`). */
export const BudgetLine = {
  /** Nothing: no budget declared, nothing read, or a page that offers no Play. */
  None: "none",
  /** The game uses AI and no budget runs: Set AI budget. */
  Offer: "offer",
  /** A declared model is not served now: one sentence, nothing to press. */
  Unavailable: "unavailable",
  /** The game's AI is voice, which the app does not offer yet: one sentence, nothing to press. */
  Voice: "voice",
  /** A budget runs: what is left of it, Stop, and Change while the game is not played. */
  Live: "live",
} as const;
export type BudgetLine = (typeof BudgetLine)[keyof typeof BudgetLine];

/** The line as the page draws it. */
export interface BudgetLineView {
  line: BudgetLine;
  /** The running budget, while the line is {@link BudgetLine.Live}. */
  current: AiBudgetView | null;
  /** Whether Change is offered: a new budget may be set, and the game is not being played. */
  canChange: boolean;
  /** Set AI budget signs in first: the app is signed out. */
  signIn: boolean;
}

const NO_LINE: BudgetLineView = { line: BudgetLine.None, current: null, canChange: false, signIn: false };

/** The phases whose primary block offers Play or leads to it: the budget is set before Play. */
const OFFERING: ReadonlySet<GamePhase> = new Set([
  GamePhase.Install,
  GamePhase.Ready,
  GamePhase.Update,
  GamePhase.Playing,
]);

/** Whether a game's page shows the AI budget at all: a native game that installs or plays here. */
export const offersBudget = (native: boolean, phase: GamePhase): boolean => native && OFFERING.has(phase);

/** The running budget of a read, or null: one that ended is no budget. */
export const liveBudget = (read: AiBudgetRead | null | undefined): AiBudgetView | null =>
  read?.current && isLiveBudget(read.current.status) ? read.current : null;

/** What the line says for `read` (null while nothing was read) on a page in `phase`. */
export function budgetLine(read: AiBudgetRead | null | undefined, native: boolean, phase: GamePhase): BudgetLineView {
  if (!read || !offersBudget(native, phase)) return NO_LINE;
  const { declared } = read;
  const settable = declared !== null && declared.available && !declared.voice;
  const current = liveBudget(read);
  if (current) {
    const canChange = settable && phase !== GamePhase.Playing && !current.stopping;
    return { line: BudgetLine.Live, current, canChange, signIn: false };
  }
  if (!declared) return NO_LINE;
  if (declared.voice) return { ...NO_LINE, line: BudgetLine.Voice };
  if (!declared.available) return { ...NO_LINE, line: BudgetLine.Unavailable };
  return { ...NO_LINE, line: BudgetLine.Offer, signIn: read.signedOut };
}

/**
 * What the page keeps after a read: genex.games' answer, or, once the app has signed out, what the
 * game declared (so Set AI budget can sign in first) with no budget, since a budget ends with the
 * sign-in.
 */
export function budgetAfterRead(kept: AiBudgetRead | undefined, read: AiBudgetRead): AiBudgetRead {
  if (!read.signedOut) return read;
  return { signedOut: true, declared: kept?.declared ?? null, current: null };
}

/** What the page keeps after an approval or a stop: the budget as it stands, none once it ended. */
export function budgetAfterChange(kept: AiBudgetRead | undefined, current: AiBudgetView | null): AiBudgetRead {
  const live = current && isLiveBudget(current.status) ? current : null;
  return { signedOut: false, declared: kept?.declared ?? null, current: live };
}

/** Whether the count is read again by itself: a budget runs and its game is being played. */
export const refreshesBudget = (read: AiBudgetRead | null | undefined, phase: GamePhase): boolean =>
  phase === GamePhase.Playing && liveBudget(read) !== null;

/** What a watch on a running budget needs: the read, a repeating timer and the window's focus, each stopped by what it returns. */
export interface BudgetWatchDeps {
  read(): void;
  every(ms: number, tick: () => void): () => void;
  focused(listener: () => void): () => void;
}

/** Read the budget again every {@link BUDGET_REFRESH_MS} and when the window comes back; returns the stop. */
export function watchBudget(deps: BudgetWatchDeps): () => void {
  const stops = [deps.every(BUDGET_REFRESH_MS, deps.read), deps.focused(deps.read)];
  return () => {
    for (const stop of stops) stop();
  };
}

/** Where the sheet stands. Values mark it in the page (`data-ai-budget-step`). */
export const SheetStep = {
  /** The quote is being opened. */
  Loading: "loading",
  /** The quote is shown: choose a limit, Approve or Cancel. */
  Ask: "ask",
  /** Approve was pressed and genex.games has not answered. */
  Approving: "approving",
  /** The budget runs: the sheet closes and the line shows it. */
  Approved: "approved",
  /** There is no quote to approve: one sentence and its next step. */
  Failed: "failed",
} as const;
export type SheetStep = (typeof SheetStep)[keyof typeof SheetStep];

/** Why the sheet could not set a budget, as its sentences name it. */
export const SheetFailure = {
  Credits: "credits",
  Email: "email",
  Expired: "expired",
  Paused: "paused",
  Unavailable: "unavailable",
  SignedOut: "signed_out",
  Other: "other",
} as const;
export type SheetFailure = (typeof SheetFailure)[keyof typeof SheetFailure];

/** What a failure offers next. */
export const SheetNext = {
  /** Nothing to press but Cancel. */
  None: "none",
  GetCredits: "get_credits",
  /** Open a fresh quote. */
  TryAgain: "try_again",
  SignIn: "sign_in",
} as const;
export type SheetNext = (typeof SheetNext)[keyof typeof SheetNext];

/** The sheet. */
export interface BudgetSheet {
  step: SheetStep;
  /** The quote on show; null before one is open and after it ended. */
  quote: AiBudgetQuote | null;
  /** The limit chosen, always one the quote offers. */
  limitCredits: number;
  /** The sentence shown: with a quote still open it sits over Approve, without one it is the sheet. */
  failure: SheetFailure | null;
}

const FAILURES: Partial<Record<AiBudgetRefusal, SheetFailure>> = {
  [AiBudgetRefusal.InsufficientCredits]: SheetFailure.Credits,
  [AiBudgetRefusal.CreditsUnverified]: SheetFailure.Email,
  [AiBudgetRefusal.QuoteExpired]: SheetFailure.Expired,
  [AiBudgetRefusal.QuoteMismatch]: SheetFailure.Expired,
  [AiBudgetRefusal.BillingPolicyMismatch]: SheetFailure.Expired,
  [AiBudgetRefusal.GrantNotFound]: SheetFailure.Expired,
  [AiBudgetRefusal.GenerationPaused]: SheetFailure.Paused,
  [AiBudgetRefusal.ProviderUnavailable]: SheetFailure.Paused,
  [AiBudgetRefusal.ModelNotAvailable]: SheetFailure.Unavailable,
  [AiBudgetRefusal.NotDeclared]: SheetFailure.Unavailable,
  [AiBudgetRefusal.GameUnavailable]: SheetFailure.Unavailable,
  [AiBudgetRefusal.ProjectNotFound]: SheetFailure.Unavailable,
  [AiBudgetRefusal.Voice]: SheetFailure.Unavailable,
  [AiBudgetRefusal.SignedOut]: SheetFailure.SignedOut,
  [AiBudgetRefusal.SessionRevoked]: SheetFailure.SignedOut,
};

/** The sentence a refusal gets; any the sheet has no words for is {@link SheetFailure.Other}. */
export const sheetFailureOf = (refused: AiBudgetRefusal): SheetFailure => FAILURES[refused] ?? SheetFailure.Other;

/** Failures the open quote does not outlive: Approve is gone, and a new quote is the way on. */
const ENDS_QUOTE: ReadonlySet<SheetFailure> = new Set([SheetFailure.Expired, SheetFailure.Unavailable]);

const NEXT: Record<SheetFailure, SheetNext> = {
  [SheetFailure.Credits]: SheetNext.GetCredits,
  [SheetFailure.Email]: SheetNext.None,
  [SheetFailure.Expired]: SheetNext.TryAgain,
  [SheetFailure.Paused]: SheetNext.None,
  [SheetFailure.Unavailable]: SheetNext.None,
  [SheetFailure.SignedOut]: SheetNext.SignIn,
  [SheetFailure.Other]: SheetNext.TryAgain,
};

/** What the sheet offers beside Cancel for the sentence it shows; nothing with no failure. */
export function sheetNext(sheet: BudgetSheet): SheetNext {
  if (!sheet.failure) return SheetNext.None;
  // With the quote still open, Approve is the way to try again.
  const approves = sheet.quote !== null && NEXT[sheet.failure] === SheetNext.TryAgain;
  return approves ? SheetNext.None : NEXT[sheet.failure];
}

/** The sheet as it opens: the quote is on its way. */
export const SHEET_OPENING: BudgetSheet = { step: SheetStep.Loading, quote: null, limitCredits: 0, failure: null };

const failed = (failure: SheetFailure): BudgetSheet => ({ ...SHEET_OPENING, step: SheetStep.Failed, failure });

/** The sheet once the quote answered: `opened` is null when the call itself failed. */
export function sheetOpened(opened: AiBudgetOpened | null): BudgetSheet {
  if (!opened) return failed(SheetFailure.Other);
  if ("refused" in opened) return failed(sheetFailureOf(opened.refused));
  const { quote } = opened;
  return {
    step: SheetStep.Ask,
    quote,
    limitCredits: nearestLimit(quote.limit, quote.limit.defaultCredits),
    failure: null,
  };
}

/** The sheet with another limit chosen: the offered one nearest `value`, while it asks. */
export function sheetLimitChosen(sheet: BudgetSheet, value: number): BudgetSheet {
  if (sheet.step !== SheetStep.Ask || !sheet.quote) return sheet;
  return { ...sheet, limitCredits: nearestLimit(sheet.quote.limit, value) };
}

/** Whether Approve may be pressed: a quote is on show and nothing is being sent. */
export const canApprove = (sheet: BudgetSheet): boolean => sheet.step === SheetStep.Ask && sheet.quote !== null;

/** The sheet once Approve is pressed. */
export const sheetApproving = (sheet: BudgetSheet): BudgetSheet =>
  canApprove(sheet) ? { ...sheet, step: SheetStep.Approving, failure: null } : sheet;

/**
 * The sheet once Approve answered (`confirmed` is null when the call itself failed): approved only
 * for a budget genex.games says is running; else the sentence for why, over the quote while that
 * can still be approved.
 */
export function sheetAnswered(sheet: BudgetSheet, confirmed: AiBudgetConfirmed | null): BudgetSheet {
  if (sheet.step !== SheetStep.Approving) return sheet;
  if (confirmed && "current" in confirmed && isLiveBudget(confirmed.current.status))
    return { ...sheet, step: SheetStep.Approved, failure: null };
  const failure = confirmed && "refused" in confirmed ? sheetFailureOf(confirmed.refused) : SheetFailure.Other;
  return ENDS_QUOTE.has(failure) ? failed(failure) : { ...sheet, step: SheetStep.Ask, failure };
}
