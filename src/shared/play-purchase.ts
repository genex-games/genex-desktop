/**
 * A game's coin purchase in Play's viewer. Main catches the game's request to pay, reads the purchase
 * on genex.games and draws Studio's own sheet over the dimmed game, in the bar's layer; the bar page
 * answers over `studio:play.purchase`, and main confirms or cancels the purchase it holds, never one
 * the page names. These are the shapes both sides share. Browser-safe.
 */
import { SECOND_MS } from "./duration.ts";

/**
 * How long the page must have shown Ask, with no press in it, before main takes Pay: a click or a key
 * meant for the game never lands on it. Firefox holds its own permission dialogs a second for the
 * same reason.
 */
export const PURCHASE_ARM_MS = SECOND_MS;

/** The longest intent id genex.games hands out (a cuid), with room to spare. */
const INTENT_ID_MAX = 64;
/**
 * Characters that turn the direction text runs in (Unicode's Bidi_Control): a game writes the
 * purchase's words, and one could make its price or name read backwards.
 */
const BIDI_CONTROLS = /\p{Bidi_Control}/gu;

/**
 * Where genex.games sells coin: its Buy coin dialog opens from the inventory page. UNCONFIRMED until
 * genex.games names a page for it; read from its web app's source, not from a published route.
 */
const COIN_PAGE_PATH = "/inventory";

/** Where the sheet stands: one artboard each. Values are `data-play-purchase` selectors: never rename one. */
export const PurchaseStep = {
  /** The item and its price, Cancel and Pay; Pay counts only once `armed`. */
  Ask: "ask",
  /** The confirm is on its way: nothing on the sheet answers until genex.games does. */
  Paying: "paying",
  /** genex.games took the coin: the receipt and the balance left. */
  Paid: "paid",
  /** The balance is short of the price: Get Nex. `recovery` says whether Pay can still come back. */
  NotEnough: "not-enough",
  /** No Genex account is unlocked, or genex.games refused its token on a read: Sign in. */
  SignedOut: "signed-out",
  /** genex.games has not said how the payment went: main keeps asking until it settles or times out. */
  Pending: "pending",
  /** The purchase ended without a charge, or with one genex.games gave back; `problem` says how. */
  Failed: "failed",
} as const;
export type PurchaseStep = (typeof PurchaseStep)[keyof typeof PurchaseStep];

/** How a Failed sheet ended. Each has its own words: only Refused may follow a refused payment. */
export const PurchaseProblem = {
  /** The purchase timed out before it was paid. */
  Expired: "expired",
  /** It was canceled before it was paid, here or elsewhere. */
  Canceled: "canceled",
  /** genex.games refused it, or failed it for a reason the sheet has no words of its own for. */
  Refused: "refused",
  /** It was paid, and genex.games gave the coin back: never read as nothing charged. */
  Refunded: "refunded",
} as const;
export type PurchaseProblem = (typeof PurchaseProblem)[keyof typeof PurchaseProblem];

/** Where a NotEnough or SignedOut sheet's way back to Ask stands. */
export const PurchaseRecovery = {
  /** Get Nex or Sign in is offered; once it is pressed, main checks again until the purchase times out. */
  Waiting: "waiting",
  /** What was missing came in: Review shows the purchase again. A sheet never turns into Ask on its own. */
  Ready: "ready",
  /** genex.games already ended the purchase (it refused the payment for want of coin): try again in the game. */
  Over: "over",
} as const;
export type PurchaseRecovery = (typeof PurchaseRecovery)[keyof typeof PurchaseRecovery];

/** What the bar page sends about the sheet on screen. Values are the wire's: never rename one. */
export const PurchaseAnswer = {
  /** Not a choice: the page has drawn this sheet, so main may start arming Pay from now. */
  Shown: "shown",
  Pay: "pay",
  /** Cancel, Esc, ✕ or a click outside the sheet. */
  Cancel: "cancel",
  /** Back to the game, from a sheet whose purchase is over. */
  Back: "back",
  GetCoin: "get-coin",
  SignIn: "sign-in",
  /** Show the purchase again once what was missing came in (`PurchaseRecovery.Ready`). */
  Review: "review",
} as const;
export type PurchaseAnswer = (typeof PurchaseAnswer)[keyof typeof PurchaseAnswer];

const ANSWERS: ReadonlySet<string> = new Set(Object.values(PurchaseAnswer));

/** What is being bought, as genex.games described it when the game asked. */
export interface PurchaseItem {
  name: string;
  /** The terms a game wrote for its own price; shown whole, never cut. */
  description: string | null;
  /** A picture on a host the app loads images from; null draws the placeholder tile. */
  imageUrl: string | null;
  /** How many: the sheet shows `× N` above one. */
  quantity: number;
  unitPriceCoins: number;
}

/** Earned coin the account cannot spend yet (genex.games' spend hold), and when the first of it is ready. */
export interface PurchaseHeld {
  coins: number;
  /** Milliseconds since the epoch. */
  releaseAt: number;
}

/** The sheet as main draws it in the bar's layer (`PlayBarState.purchase`). */
export interface PlayPurchaseSheet {
  /**
   * Counts up from 1 each time main shows a step (a new purchase, or the next step of one): an
   * answer names the one on screen, so a press meant for an earlier step is dropped, and the page
   * keys what it draws by it.
   */
  sheet: number;
  step: PurchaseStep;
  /** How a Failed sheet ended; null on every other step. */
  problem: PurchaseProblem | null;
  /** Where a NotEnough or SignedOut sheet's way back to Ask stands; null on every other step. */
  recovery: PurchaseRecovery | null;
  /** Pay counts: the page has shown Ask for {@link PURCHASE_ARM_MS} with no press in it. */
  armed: boolean;
  /** The game the purchase is for, as Play shows it. */
  game: { title: string; coverUrl: string | null };
  /** Null when it could not be read (signed out). */
  item: PurchaseItem | null;
  /** The total, and its value in US cents when genex.games gives one; null when unread. */
  price: { coins: number; usdCents: number | null } | null;
  /** The coin the account may spend: after paying once Paid. Null while unknown. */
  balance: number | null;
  /** Earned coin on hold beside it, when genex.games says there is some and when it is ready; absent with none. */
  held?: PurchaseHeld;
}

/** An answer as main takes it: to which sheet, and what. */
export interface PlayPurchaseAnswer {
  sheet: number;
  answer: PurchaseAnswer;
}

/** Whether a value is an intent id genex.games could have handed out: all an address or a route may carry. */
export const isIntentId = (value: unknown): value is string =>
  typeof value === "string" && value.length <= INTENT_ID_MAX && /^[A-Za-z0-9_-]+$/.test(value);

/**
 * Whether a sheet's purchase is over (paid, pending, failed, or ended for want of coin): Back closes
 * it, and Esc, ✕ or a click outside answer Back rather than Cancel. Main and the bar page both read it.
 */
export const purchaseOver = (sheet: Pick<PlayPurchaseSheet, "step" | "recovery">): boolean =>
  sheet.step === PurchaseStep.Paid ||
  sheet.step === PurchaseStep.Pending ||
  sheet.step === PurchaseStep.Failed ||
  sheet.recovery === PurchaseRecovery.Over;

/** A game's own words without the characters that turn their direction; everything else stays. */
export const withoutBidiControls = (text: string): string => text.replace(BIDI_CONTROLS, "");

/** An object with fields of its own to read, not null and not an array. */
const isPlainObject = (value: unknown): value is object =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const ownField = (value: object, key: string): unknown =>
  Object.hasOwn(value, key) ? Reflect.get(value, key) : undefined;
const isSheetNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
const isAnswer = (value: unknown): value is PurchaseAnswer => typeof value === "string" && ANSWERS.has(value);

/** An answer the page sent, as main takes it: a known answer to a whole sheet number, nothing else; else null. */
export function readPurchaseAnswer(value: unknown): PlayPurchaseAnswer | null {
  if (!isPlainObject(value)) return null;
  const sheet = ownField(value, "sheet");
  const answer = ownField(value, "answer");
  return isSheetNumber(sheet) && isAnswer(answer) ? { sheet, answer } : null;
}

/** The genex.games page Get Nex opens, on the website Play links to. */
export const playCoinPageUrl = (web: string): string => new URL(COIN_PAGE_PATH, web).href;
