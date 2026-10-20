/**
 * The purchase sheet's decisions, pure: how coin, dollars and the balance read, which buttons each
 * step offers and where the keyboard starts, what Esc, ✕ and a click outside answer, what the steps
 * that only tell say, and what of a game's own words reaches the page. Main decides every step and
 * pays or cancels only the purchase it holds; `PlayPurchase.tsx` draws what these decide.
 */
import {
  type PlayPurchaseSheet,
  PurchaseAnswer,
  PurchaseProblem,
  PurchaseRecovery,
  PurchaseStep,
  purchaseOver,
  withoutBidiControls,
} from "../../shared/play-purchase.ts";
import { PLAY_WORDS } from "../words.ts";

const WORDS = PLAY_WORDS.purchase;
const CENTS_PER_DOLLAR = 100;
/** Coin as genex.games writes it: whole, digits grouped (1,240). */
const COIN_DIGITS = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
/** genex.games prices coin in US dollars. */
const DOLLARS = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/** A number of coin as the sheet writes it: `1,240`. */
export const coinNumber = (coins: number): string => COIN_DIGITS.format(coins);
/** An amount of coin: `1,240 coin`. */
export const coinText = (coins: number): string => WORDS.coin(coinNumber(coins));
/** US cents as dollars: `$0.75`. */
export const usdText = (cents: number): string => DOLLARS.format(cents / CENTS_PER_DOLLAR);
/** Pay's label: `Pay 75 coin`. */
export const payLabel = (coins: number): string => WORDS.pay(coinText(coins));
/** How many are bought, beside the name: `× 5`; nothing for one. */
export const quantityText = (quantity: number): string | null =>
  quantity > 1 ? WORDS.quantity(coinNumber(quantity)) : null;
/** A game's own words without the characters that turn their direction; everything else stays. */
export const gameText = (text: string): string => withoutBidiControls(text);

/** The balance once `coins` are paid; null when it is unread or short of them. */
export function afterPaying(balance: number | null, coins: number): number | null {
  if (balance === null || balance < coins) return null;
  return balance - coins;
}

/** The coin still missing to pay `coins`; null when the balance is unread or covers them. */
export function moreNeeded(balance: number | null, coins: number): number | null {
  if (balance === null || balance >= coins) return null;
  return coins - balance;
}

/** How the balance line under the price reads. Never rename a value. */
export const BalanceLine = {
  /** What it is, and what it comes to after paying. */
  After: "after",
  /** What it is, and how much more paying needs. */
  Short: "short",
  /** What it is: paid, or a purchase that can no longer be paid here. */
  Left: "left",
} as const;
export type BalanceLine = (typeof BalanceLine)[keyof typeof BalanceLine];

/** The balance line's numbers. */
export type BalanceView =
  | { line: typeof BalanceLine.After; now: number; after: number }
  | { line: typeof BalanceLine.Short; now: number; more: number }
  | { line: typeof BalanceLine.Left; now: number };

/** The balance line under the price; null when the balance or the price is unread. */
export function balanceView(sheet: PlayPurchaseSheet): BalanceView | null {
  const { balance, price } = sheet;
  if (balance === null || price === null) return null;
  if (sheet.step === PurchaseStep.Paid) return { line: BalanceLine.Left, now: balance };
  const more = moreNeeded(balance, price.coins);
  if (more !== null) return { line: BalanceLine.Short, now: balance, more };
  const after = afterPaying(balance, price.coins);
  if (after === null || purchaseOver(sheet)) return { line: BalanceLine.Left, now: balance };
  return { line: BalanceLine.After, now: balance, after };
}

/** How a sheet is laid out. Never rename a value. */
export const SheetLayout = {
  /** The item and its price in full, with the balance: Ask, Paying, Not enough coin. */
  Item: "item",
  /** The item with the receipt: Paid. */
  Receipt: "receipt",
  /** A title and a line of news over the item in short: Signed out, Pending, Failed. */
  Notice: "notice",
} as const;
export type SheetLayout = (typeof SheetLayout)[keyof typeof SheetLayout];

const LAYOUTS: Record<PurchaseStep, SheetLayout> = {
  [PurchaseStep.Ask]: SheetLayout.Item,
  [PurchaseStep.Paying]: SheetLayout.Item,
  [PurchaseStep.NotEnough]: SheetLayout.Item,
  [PurchaseStep.Paid]: SheetLayout.Receipt,
  [PurchaseStep.SignedOut]: SheetLayout.Notice,
  [PurchaseStep.Pending]: SheetLayout.Notice,
  [PurchaseStep.Failed]: SheetLayout.Notice,
};

/** How `sheet` is laid out. */
export const sheetLayout = (sheet: Pick<PlayPurchaseSheet, "step">): SheetLayout => LAYOUTS[sheet.step];

/** A button on the sheet: what it answers, its words, and how it stands. */
export interface SheetButton {
  answer: PurchaseAnswer;
  label: string;
  /** Pressing it does nothing yet: Pay before main arms it, Cancel while paying. */
  disabled: boolean;
  /** Its press is being carried out: Pay while paying. */
  busy: boolean;
  /** It opens a page in the browser: drawn with the arrow out. */
  outside: boolean;
}

/** The sheet's buttons, right-aligned: a quiet one, then the one thing to do. */
export interface SheetActions {
  quiet: SheetButton | null;
  primary: SheetButton;
}

const button = (answer: PurchaseAnswer, label: string, how: Partial<SheetButton> = {}): SheetButton => ({
  answer,
  label,
  disabled: false,
  busy: false,
  outside: false,
  ...how,
});
const CANCEL = button(PurchaseAnswer.Cancel, WORDS.cancel);
const BACK = button(PurchaseAnswer.Back, WORDS.back);
const REVIEW = button(PurchaseAnswer.Review, WORDS.review);
const GET_COIN = button(PurchaseAnswer.GetCoin, WORDS.getCoin, { outside: true });
const SIGN_IN = button(PurchaseAnswer.SignIn, WORDS.signIn);

/** Pay on Ask: pressable once main has armed it and the price is read. */
function askActions(sheet: Pick<PlayPurchaseSheet, "armed" | "price">): SheetActions {
  const { price } = sheet;
  const label = price ? payLabel(price.coins) : WORDS.payBare;
  return { quiet: CANCEL, primary: button(PurchaseAnswer.Pay, label, { disabled: !sheet.armed || !price }) };
}

/** Not enough coin: Get coin until the coin arrives (then Review), or Back once genex.games ended it. */
function shortActions(recovery: PurchaseRecovery | null): SheetActions {
  if (recovery === PurchaseRecovery.Over) return { quiet: BACK, primary: GET_COIN };
  return { quiet: CANCEL, primary: recovery === PurchaseRecovery.Ready ? REVIEW : GET_COIN };
}

/**
 * The buttons `sheet` offers. Review never turns into Pay under the pointer: it shows Ask again,
 * with Pay waiting to be armed.
 */
export function sheetActions(sheet: Pick<PlayPurchaseSheet, "step" | "recovery" | "armed" | "price">): SheetActions {
  switch (sheet.step) {
    case PurchaseStep.Ask:
      return askActions(sheet);
    case PurchaseStep.Paying:
      return {
        quiet: { ...CANCEL, disabled: true },
        primary: button(PurchaseAnswer.Pay, WORDS.paying, { busy: true }),
      };
    case PurchaseStep.NotEnough:
      return shortActions(sheet.recovery);
    case PurchaseStep.SignedOut:
      return { quiet: CANCEL, primary: sheet.recovery === PurchaseRecovery.Ready ? REVIEW : SIGN_IN };
    default:
      return { quiet: null, primary: BACK };
  }
}

/** Where the keyboard starts on a sheet: the quiet button when there is one, never Pay; none while paying. */
export function sheetFocus(actions: SheetActions): SheetButton | null {
  const { quiet, primary } = actions;
  if (quiet && !quiet.disabled) return quiet;
  const pressable = !primary.disabled && !primary.busy && primary.answer !== PurchaseAnswer.Pay;
  return pressable ? primary : null;
}

/** What Esc, ✕ and a click outside answer: Cancel while the purchase is open, Back once over, nothing while paying. */
export function purchaseEscape(sheet: Pick<PlayPurchaseSheet, "step" | "recovery">): PurchaseAnswer | null {
  if (sheet.step === PurchaseStep.Paying) return null;
  return purchaseOver(sheet) ? PurchaseAnswer.Back : PurchaseAnswer.Cancel;
}

/** A notice's title and its line of news. */
export interface NoticeWords {
  title: string;
  body: string;
}

/** What a sheet that only tells says: Signed out (and signed in since), Pending, Failed; null for the others. */
export function noticeWords(
  sheet: Pick<PlayPurchaseSheet, "step" | "problem" | "recovery" | "game">,
): NoticeWords | null {
  switch (sheet.step) {
    case PurchaseStep.SignedOut:
      return sheet.recovery === PurchaseRecovery.Ready
        ? { title: WORDS.signedInTitle, body: WORDS.signedInBody }
        : { title: WORDS.signedOutTitle, body: WORDS.signedOutBody };
    case PurchaseStep.Pending:
      return { title: WORDS.pendingTitle, body: WORDS.pendingBody(gameText(sheet.game.title)) };
    case PurchaseStep.Failed:
      // Main always says how; one it did not is read as genex.games' refusal, as main reads one.
      return WORDS.failed[sheet.problem ?? PurchaseProblem.Refused];
    default:
      return null;
  }
}

/** The small line under the buttons: where Get coin or Sign in leads, and what comes after. */
export function sheetNote(sheet: Pick<PlayPurchaseSheet, "step" | "recovery">): string | null {
  if (sheet.step === PurchaseStep.SignedOut) return sheet.recovery === PurchaseRecovery.Ready ? null : WORDS.signInNote;
  if (sheet.step !== PurchaseStep.NotEnough) return null;
  if (sheet.recovery === PurchaseRecovery.Over) return WORDS.overNote;
  return sheet.recovery === PurchaseRecovery.Ready ? WORDS.coinArrived : WORDS.getCoinNote;
}
