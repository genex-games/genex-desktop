/**
 * The purchase sheet of an item bought on a game's Play page (marketplace plan 10.3, P7; screens
 * 03–05), decided without a window: its one button on each step main shows (Pay N, Paying, Get
 * coin ↗, Review, Done, Sign in, Close), the balance line under the price ("Balance X → Y", "You
 * have X · Y more needed", "Balance X"), the note under the button, what a sheet that only tells
 * says on the game's page, and where the keyboard starts: never on Pay.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  StoreFocus,
  storeBalanceLine,
  storeHeldLine,
  storeNotice,
  storePayLabel,
  storeSheetAction,
  storeSheetFocus,
  storeSheetNote,
} from "../../src/renderer/play/purchase-model.ts";
import { PLAY_STORE_WORDS, PLAY_WORDS } from "../../src/renderer/words.ts";
import {
  type PlayPurchaseSheet,
  PurchaseAnswer,
  PurchaseProblem,
  PurchaseRecovery,
  PurchaseStep,
} from "../../src/shared/play-purchase.ts";

/** Legendary Sword's Ask on Stick & Steel's page, armed, with 62,450 coin to spend. */
const sheetWith = (over: Partial<PlayPurchaseSheet> = {}): PlayPurchaseSheet => ({
  sheet: 1,
  step: PurchaseStep.Ask,
  problem: null,
  recovery: null,
  armed: true,
  game: { title: "Stick & Steel", coverUrl: null },
  item: { name: "Legendary Sword", description: null, imageUrl: null, quantity: 1, unitPriceCoins: 50_000 },
  price: { coins: 50_000, usdCents: 50_000 },
  balance: 62_450,
  ...over,
});

const ASK = sheetWith();
const PAYING = sheetWith({ step: PurchaseStep.Paying, armed: false });
const PAID = sheetWith({ step: PurchaseStep.Paid, armed: false, balance: 12_450 });
const short = (recovery: PurchaseRecovery) =>
  sheetWith({ step: PurchaseStep.NotEnough, recovery, armed: false, balance: 12_450 });
const failed = (problem: PurchaseProblem) => sheetWith({ step: PurchaseStep.Failed, problem, armed: false });
const signedOut = (recovery: PurchaseRecovery) =>
  sheetWith({ step: PurchaseStep.SignedOut, recovery, armed: false, item: null, price: null, balance: null });
const PENDING = sheetWith({ step: PurchaseStep.Pending, armed: false });

describe("the store sheet's one button (P7)", () => {
  it("says Pay and the price in coin without the word, as the design does", () => {
    assert.equal(storePayLabel(50_000), "Pay 50,000");
    assert.equal(storePayLabel(300), "Pay 300");
  });

  it("offers Pay on Ask, pressable only once main armed it and the price is read", () => {
    const pay = storeSheetAction(ASK);
    assert.equal(pay.answer, PurchaseAnswer.Pay);
    assert.equal(pay.label, "Pay 50,000");
    assert.equal(pay.disabled, false);
    assert.equal(storeSheetAction(sheetWith({ armed: false })).disabled, true);
    assert.equal(storeSheetAction(sheetWith({ price: null })).disabled, true);
  });

  it("holds Pay busy while paying", () => {
    const paying = storeSheetAction(PAYING);
    assert.equal(paying.answer, PurchaseAnswer.Pay);
    assert.equal(paying.busy, true);
    assert.equal(paying.label, PLAY_WORDS.purchase.paying);
  });

  it("offers Get Nex, out to genex.games, while the coin is short, and Review once it lands", () => {
    const getCoin = storeSheetAction(short(PurchaseRecovery.Waiting));
    assert.equal(getCoin.answer, PurchaseAnswer.GetCoin);
    assert.equal(getCoin.label, "Get Nex");
    assert.equal(getCoin.outside, true);
    assert.equal(storeSheetAction(short(PurchaseRecovery.Ready)).answer, PurchaseAnswer.Review);
    assert.equal(storeSheetAction(short(PurchaseRecovery.Over)).answer, PurchaseAnswer.GetCoin);
  });

  it("closes with Done once paid", () => {
    const done = storeSheetAction(PAID);
    assert.equal(done.answer, PurchaseAnswer.Back);
    assert.equal(done.label, "Done");
  });

  it("signs in while signed out, then shows the purchase again with Review", () => {
    assert.equal(storeSheetAction(signedOut(PurchaseRecovery.Waiting)).answer, PurchaseAnswer.SignIn);
    assert.equal(storeSheetAction(signedOut(PurchaseRecovery.Ready)).answer, PurchaseAnswer.Review);
  });

  it("closes a pending or failed purchase", () => {
    for (const sheet of [PENDING, failed(PurchaseProblem.Expired), failed(PurchaseProblem.Refunded)]) {
      const close = storeSheetAction(sheet);
      assert.equal(close.answer, PurchaseAnswer.Back, sheet.step);
      assert.equal(close.label, PLAY_STORE_WORDS.close, sheet.step);
    }
  });
});

describe("the balance line under the price", () => {
  it("shows what the balance comes to after paying", () => {
    assert.equal(storeBalanceLine(ASK), "Balance 62,450 → 12,450");
    assert.equal(storeBalanceLine(PAYING), "Balance 62,450 → 12,450");
  });

  it("shows what the player has and how much more paying needs", () => {
    assert.equal(storeBalanceLine(short(PurchaseRecovery.Waiting)), "You have 12,450 · 37,550 more needed");
  });

  it("says under a short balance how much earned coin is on hold, and until when", () => {
    const held = { coins: 7500, releaseAt: Date.parse("2026-10-30T12:00:00.000Z") };
    assert.equal(
      storeHeldLine({ ...short(PurchaseRecovery.Waiting), held }),
      "7,500 of your Nex is on hold until Oct 30.",
    );
    assert.equal(storeHeldLine(short(PurchaseRecovery.Waiting)), null, "nothing on hold: nothing more to say");
    assert.equal(storeHeldLine({ ...ASK, held }), null, "a balance that covers the price says nothing of it");
    assert.equal(storeHeldLine({ ...PAID, held }), null);
  });

  it("shows the balance left once paid", () => {
    assert.equal(storeBalanceLine(PAID), "Balance 12,450");
  });

  it("shows nothing while the balance or the price is unread", () => {
    assert.equal(storeBalanceLine(sheetWith({ balance: null })), null);
    assert.equal(storeBalanceLine(sheetWith({ price: null })), null);
  });
});

describe("the note under the button", () => {
  it("says where Get Nex leads and that Pay comes back", () => {
    assert.equal(
      storeSheetNote(short(PurchaseRecovery.Waiting)),
      "Opens genex.games. Pay comes back once the Nex lands.",
    );
  });

  it("says the coin arrived once it did, and to try again once genex.games ended the purchase", () => {
    assert.equal(storeSheetNote(short(PurchaseRecovery.Ready)), PLAY_WORDS.purchase.coinArrived);
    assert.equal(storeSheetNote(short(PurchaseRecovery.Over)), PLAY_STORE_WORDS.overNote);
  });

  it("says where Sign in leads while it waits", () => {
    assert.equal(storeSheetNote(signedOut(PurchaseRecovery.Waiting)), PLAY_WORDS.purchase.signInNote);
    assert.equal(storeSheetNote(signedOut(PurchaseRecovery.Ready)), null);
  });

  it("says nothing on Ask, while paying, or once paid", () => {
    assert.equal(storeSheetNote(ASK), null);
    assert.equal(storeSheetNote(PAYING), null);
    assert.equal(storeSheetNote(PAID), null);
  });
});

describe("what the sheet says on a game's page instead of the item's description", () => {
  it("says where to find the item once paid", () => {
    assert.deepEqual(storeNotice(PAID), {
      title: null,
      body: "It's yours. Find it under Store › My items in every game it works in.",
    });
  });

  it("never sends the player back into a game they are not in", () => {
    for (const problem of Object.values(PurchaseProblem)) {
      const words = storeNotice(failed(problem));
      assert.ok(words, problem);
      assert.equal(words.title, PLAY_WORDS.purchase.failed[problem].title, problem);
      assert.doesNotMatch(words.body, /in the game/, problem);
    }
    const pending = storeNotice(PENDING);
    assert.equal(pending?.title, PLAY_WORDS.purchase.pendingTitle);
    assert.doesNotMatch(pending?.body ?? "", /Stick & Steel finishes/);
  });

  it("only a refund says the coin went back; the rest say none was charged", () => {
    assert.match(storeNotice(failed(PurchaseProblem.Refunded))?.body ?? "", /went back/);
    for (const problem of [PurchaseProblem.Expired, PurchaseProblem.Canceled, PurchaseProblem.Refused])
      assert.match(storeNotice(failed(problem))?.body ?? "", /No Nex was/, problem);
  });

  it("asks a signed-out player to sign in, then to review", () => {
    assert.equal(storeNotice(signedOut(PurchaseRecovery.Waiting))?.title, PLAY_WORDS.purchase.signedOutTitle);
    assert.equal(storeNotice(signedOut(PurchaseRecovery.Ready))?.title, PLAY_WORDS.purchase.signedInTitle);
  });

  it("lets the item's own description show while it can still be paid", () => {
    assert.equal(storeNotice(ASK), null);
    assert.equal(storeNotice(PAYING), null);
    assert.equal(storeNotice(short(PurchaseRecovery.Waiting)), null);
  });
});

describe("where the keyboard starts on the store sheet", () => {
  it("starts on ✕ when the button is Pay, so no key meant elsewhere pays", () => {
    assert.equal(storeSheetFocus(ASK), StoreFocus.Close);
    assert.equal(storeSheetFocus(sheetWith({ armed: false })), StoreFocus.Close);
  });

  it("starts on the button when it cannot pay", () => {
    assert.equal(storeSheetFocus(short(PurchaseRecovery.Waiting)), StoreFocus.Action);
    assert.equal(storeSheetFocus(short(PurchaseRecovery.Ready)), StoreFocus.Action);
    assert.equal(storeSheetFocus(PAID), StoreFocus.Action);
  });

  it("starts nowhere while paying", () => {
    assert.equal(storeSheetFocus(PAYING), null);
  });
});
