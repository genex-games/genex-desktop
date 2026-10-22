/**
 * The purchase sheet's decisions, as the bar's layer draws them: how coin, dollars and the balance
 * read, which buttons each step offers and where the keyboard starts, what Esc, ✕ and a click
 * outside answer, the words of the steps that only tell, and a game's own words without the
 * characters that turn text around.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  afterPaying,
  BalanceLine,
  balanceView,
  coinText,
  gameText,
  moreNeeded,
  noticeWords,
  payLabel,
  purchaseEscape,
  quantityText,
  SheetLayout,
  sheetActions,
  sheetFocus,
  sheetLayout,
  sheetNote,
  usdText,
} from "../../src/renderer/play/purchase-model.ts";
import { PLAY_WORDS } from "../../src/renderer/words.ts";
import {
  type PlayPurchaseSheet,
  PurchaseAnswer,
  PurchaseProblem,
  PurchaseRecovery,
  PurchaseStep,
} from "../../src/shared/play-purchase.ts";

const WORDS = PLAY_WORDS.purchase;

/** An Ask sheet for a 75-coin gate, armed, with 1,240 coin to spend; `over` changes what the case needs. */
const sheetWith = (over: Partial<PlayPurchaseSheet> = {}): PlayPurchaseSheet => ({
  sheet: 1,
  step: PurchaseStep.Ask,
  problem: null,
  recovery: null,
  armed: true,
  game: { title: "Lantern Run", coverUrl: null },
  item: { name: "Open the iron gate", description: null, imageUrl: null, quantity: 1, unitPriceCoins: 75 },
  price: { coins: 75, usdCents: 75 },
  balance: 1240,
  ...over,
});

const ASK = sheetWith();
const PAYING = sheetWith({ step: PurchaseStep.Paying, armed: false });
const PAID = sheetWith({ step: PurchaseStep.Paid, armed: false, balance: 1165 });
const PENDING = sheetWith({ step: PurchaseStep.Pending, armed: false });
const failed = (problem: PurchaseProblem) => sheetWith({ step: PurchaseStep.Failed, problem, armed: false });
const notEnough = (recovery: PurchaseRecovery, balance = 40) =>
  sheetWith({ step: PurchaseStep.NotEnough, recovery, armed: false, balance });
const signedOut = (recovery: PurchaseRecovery) =>
  sheetWith({ step: PurchaseStep.SignedOut, recovery, armed: false, item: null, price: null, balance: null });

/** The buttons a sheet offers, as `[quiet, primary]` answers. */
const answers = (sheet: PlayPurchaseSheet) => {
  const { quiet, primary } = sheetActions(sheet);
  return [quiet?.answer ?? null, primary.answer];
};

describe("how coin, dollars and the balance read on the sheet", () => {
  it("writes coin grouped the way genex.games does, and dollars from cents", () => {
    assert.equal(coinText(1240), "1,240 coin");
    assert.equal(coinText(1), "1 coin");
    assert.equal(coinText(100000), "100,000 coin");
    assert.equal(usdText(75), "$0.75");
    assert.equal(usdText(1240), "$12.40");
    assert.equal(usdText(0), "$0.00");
    assert.equal(payLabel(75), "Pay 75 coin");
    assert.equal(payLabel(1240), "Pay 1,240 coin");
  });

  it("reckons the balance after paying and the coin still needed, and nothing it cannot know", () => {
    assert.equal(afterPaying(1240, 75), 1165);
    assert.equal(afterPaying(75, 75), 0);
    assert.equal(afterPaying(40, 75), null, "a balance short of the price is never paid down below zero");
    assert.equal(afterPaying(null, 75), null);
    assert.equal(moreNeeded(40, 75), 35);
    assert.equal(moreNeeded(75, 75), null, "enough is not short");
    assert.equal(moreNeeded(1240, 75), null);
    assert.equal(moreNeeded(null, 75), null, "an unread balance is never called short");
  });

  it("shows the balance going down before paying, what is left once paid, and what is missing when short", () => {
    assert.deepEqual(balanceView(ASK), { line: BalanceLine.After, now: 1240, after: 1165 });
    assert.deepEqual(balanceView(PAYING), { line: BalanceLine.After, now: 1240, after: 1165 });
    assert.deepEqual(balanceView(PAID), { line: BalanceLine.Left, now: 1165 });
    assert.deepEqual(balanceView(notEnough(PurchaseRecovery.Waiting)), { line: BalanceLine.Short, now: 40, more: 35 });
    assert.deepEqual(balanceView(notEnough(PurchaseRecovery.Over)), { line: BalanceLine.Short, now: 40, more: 35 });
    assert.deepEqual(balanceView(notEnough(PurchaseRecovery.Ready, 1240)), {
      line: BalanceLine.After,
      now: 1240,
      after: 1165,
    });
    assert.deepEqual(
      balanceView(notEnough(PurchaseRecovery.Over, 1240)),
      { line: BalanceLine.Left, now: 1240 },
      "a purchase genex.games already ended is never shown being paid",
    );
    assert.equal(balanceView(sheetWith({ balance: null })), null, "an unread balance: no line at all");
    assert.equal(balanceView(signedOut(PurchaseRecovery.Waiting)), null);
  });

  it("names how many only when there is more than one", () => {
    assert.equal(quantityText(1), null);
    assert.equal(quantityText(5), "× 5");
    assert.equal(quantityText(99), "× 99");
  });
});

describe("what each step of the sheet offers", () => {
  it("offers each step its own buttons: Cancel beside the one thing to do, or Back once the purchase is over", () => {
    const rows: [string, PlayPurchaseSheet, (PurchaseAnswer | null)[]][] = [
      ["ask", ASK, [PurchaseAnswer.Cancel, PurchaseAnswer.Pay]],
      ["paying", PAYING, [PurchaseAnswer.Cancel, PurchaseAnswer.Pay]],
      ["paid", PAID, [null, PurchaseAnswer.Back]],
      ["pending", PENDING, [null, PurchaseAnswer.Back]],
      ["expired", failed(PurchaseProblem.Expired), [null, PurchaseAnswer.Back]],
      ["canceled", failed(PurchaseProblem.Canceled), [null, PurchaseAnswer.Back]],
      ["refused", failed(PurchaseProblem.Refused), [null, PurchaseAnswer.Back]],
      ["short, before paying", notEnough(PurchaseRecovery.Waiting), [PurchaseAnswer.Cancel, PurchaseAnswer.GetCoin]],
      ["short, coin arrived", notEnough(PurchaseRecovery.Ready, 1240), [PurchaseAnswer.Cancel, PurchaseAnswer.Review]],
      [
        "short, after a refused payment",
        notEnough(PurchaseRecovery.Over),
        [PurchaseAnswer.Back, PurchaseAnswer.GetCoin],
      ],
      ["signed out", signedOut(PurchaseRecovery.Waiting), [PurchaseAnswer.Cancel, PurchaseAnswer.SignIn]],
      ["signed in since", signedOut(PurchaseRecovery.Ready), [PurchaseAnswer.Cancel, PurchaseAnswer.Review]],
    ];
    for (const [name, sheet, expected] of rows) assert.deepEqual(answers(sheet), expected, name);
  });

  it("holds Pay until main has armed it, and keeps it busy, with Cancel out of reach, while paying", () => {
    assert.equal(sheetActions(sheetWith({ armed: false })).primary.disabled, true, "not armed yet");
    assert.equal(sheetActions(ASK).primary.disabled, false);
    assert.equal(sheetActions(ASK).primary.label, "Pay 75 coin");
    assert.equal(sheetActions(sheetWith({ price: null })).primary.disabled, true, "no price read: nothing to pay");
    const paying = sheetActions(PAYING);
    assert.equal(paying.primary.busy, true);
    assert.equal(paying.primary.label, WORDS.paying);
    assert.equal(paying.quiet?.disabled, true, "Cancel waits for genex.games' answer");
    for (const sheet of [ASK, PAID, PENDING, notEnough(PurchaseRecovery.Waiting)])
      assert.equal(sheetActions(sheet).primary.busy, false, sheet.step);
  });

  it("marks only Get coin as opening the browser", () => {
    assert.equal(sheetActions(notEnough(PurchaseRecovery.Waiting)).primary.outside, true);
    assert.equal(sheetActions(notEnough(PurchaseRecovery.Over)).primary.outside, true);
    for (const sheet of [ASK, PAID, signedOut(PurchaseRecovery.Waiting), notEnough(PurchaseRecovery.Ready, 1240)])
      assert.equal(sheetActions(sheet).primary.outside, false, sheet.step);
  });

  it("starts the keyboard on Cancel whenever there is one, never on Pay, Review, Get coin or Sign in", () => {
    const rows: [PlayPurchaseSheet, PurchaseAnswer | null][] = [
      [ASK, PurchaseAnswer.Cancel],
      [sheetWith({ armed: false }), PurchaseAnswer.Cancel],
      [PAYING, null],
      [PAID, PurchaseAnswer.Back],
      [PENDING, PurchaseAnswer.Back],
      [failed(PurchaseProblem.Expired), PurchaseAnswer.Back],
      [notEnough(PurchaseRecovery.Waiting), PurchaseAnswer.Cancel],
      [notEnough(PurchaseRecovery.Ready, 1240), PurchaseAnswer.Cancel],
      [notEnough(PurchaseRecovery.Over), PurchaseAnswer.Back],
      [signedOut(PurchaseRecovery.Waiting), PurchaseAnswer.Cancel],
      [signedOut(PurchaseRecovery.Ready), PurchaseAnswer.Cancel],
    ];
    for (const [sheet, expected] of rows)
      assert.equal(sheetFocus(sheetActions(sheet))?.answer ?? null, expected, `${sheet.step}/${sheet.recovery}`);
  });

  it("answers Esc, ✕ and a click outside with Cancel while the purchase is open, Back once it is over, nothing while paying", () => {
    const rows: [PlayPurchaseSheet, PurchaseAnswer | null][] = [
      [ASK, PurchaseAnswer.Cancel],
      [sheetWith({ armed: false }), PurchaseAnswer.Cancel],
      [PAYING, null],
      [PAID, PurchaseAnswer.Back],
      [PENDING, PurchaseAnswer.Back],
      [failed(PurchaseProblem.Expired), PurchaseAnswer.Back],
      [failed(PurchaseProblem.Canceled), PurchaseAnswer.Back],
      [failed(PurchaseProblem.Refused), PurchaseAnswer.Back],
      [notEnough(PurchaseRecovery.Waiting), PurchaseAnswer.Cancel],
      [notEnough(PurchaseRecovery.Ready, 1240), PurchaseAnswer.Cancel],
      [notEnough(PurchaseRecovery.Over), PurchaseAnswer.Back],
      [signedOut(PurchaseRecovery.Waiting), PurchaseAnswer.Cancel],
      [signedOut(PurchaseRecovery.Ready), PurchaseAnswer.Cancel],
    ];
    for (const [sheet, expected] of rows)
      assert.equal(purchaseEscape(sheet), expected, `${sheet.step}/${sheet.recovery}`);
  });

  it("lays the purchase out in full until it is paid, as a receipt once paid, and as a notice when there is only news", () => {
    assert.equal(sheetLayout(ASK), SheetLayout.Item);
    assert.equal(sheetLayout(PAYING), SheetLayout.Item);
    assert.equal(sheetLayout(notEnough(PurchaseRecovery.Over)), SheetLayout.Item);
    assert.equal(sheetLayout(PAID), SheetLayout.Receipt);
    for (const sheet of [PENDING, failed(PurchaseProblem.Expired), signedOut(PurchaseRecovery.Waiting)])
      assert.equal(sheetLayout(sheet), SheetLayout.Notice, sheet.step);
  });
});

describe("what the sheet says", () => {
  it("tells a purchase that timed out, was canceled or was refused apart, each without claiming a charge", () => {
    const expired = noticeWords(failed(PurchaseProblem.Expired));
    assert.deepEqual(expired, {
      title: "This purchase timed out",
      body: "Try again in the game. No coin was reserved or charged.",
    });
    const canceled = noticeWords(failed(PurchaseProblem.Canceled));
    const refused = noticeWords(failed(PurchaseProblem.Refused));
    const refunded = noticeWords(failed(PurchaseProblem.Refunded));
    const titles = new Set([expired?.title, canceled?.title, refused?.title, refunded?.title]);
    assert.equal(titles.size, 4, "each ending has its own title");
    assert.doesNotMatch(canceled?.title ?? "", /timed out/);
    assert.doesNotMatch(refused?.title ?? "", /timed out/);
  });

  it("says a refunded purchase's coin came back, never that none was charged", () => {
    assert.deepEqual(noticeWords(failed(PurchaseProblem.Refunded)), {
      title: "This purchase was refunded",
      body: "Try again in the game. The coin went back to your balance.",
    });
  });

  it("says who finishes a pending purchase, and asks a signed-out player to sign in, then to review", () => {
    assert.deepEqual(noticeWords(PENDING), {
      title: "Still checking the payment",
      body: "Genex hasn’t confirmed it yet. Lantern Run finishes the purchase once it does. You won’t be charged twice.",
    });
    assert.deepEqual(noticeWords(signedOut(PurchaseRecovery.Waiting)), {
      title: "Sign in to buy things in games",
      body: "Coin lives in your Genex account. Sign in once, then pay here.",
    });
    assert.notEqual(noticeWords(signedOut(PurchaseRecovery.Ready))?.title, WORDS.signedOutTitle);
    for (const sheet of [ASK, PAYING, PAID, notEnough(PurchaseRecovery.Waiting)])
      assert.equal(noticeWords(sheet), null, sheet.step);
  });

  it("notes where Get coin and Sign in lead, and that a refused payment is tried again in the game", () => {
    assert.equal(
      sheetNote(notEnough(PurchaseRecovery.Waiting)),
      "Opens genex.games. Pay comes back once the coin lands.",
    );
    assert.equal(sheetNote(notEnough(PurchaseRecovery.Over)), "Try again in the game once the coin lands.");
    assert.equal(sheetNote(signedOut(PurchaseRecovery.Waiting)), "Opens your browser. You’ll come back here to pay.");
    assert.ok(sheetNote(notEnough(PurchaseRecovery.Ready, 1240)), "coin arrived: say so before Review");
    for (const sheet of [
      ASK,
      PAYING,
      PAID,
      PENDING,
      failed(PurchaseProblem.Refused),
      signedOut(PurchaseRecovery.Ready),
    ])
      assert.equal(sheetNote(sheet), null, `${sheet.step}/${sheet.recovery}`);
  });

  it("names the game in the receipt", () => {
    assert.equal(WORDS.receipt("Lantern Run"), "Lantern Run has your receipt.");
  });

  it("takes out of a game's words every character that turns the direction text runs in, and nothing else", () => {
    const controls = [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x200e, 0x200f, 0x061c];
    for (const control of controls) {
      const mark = String.fromCodePoint(control);
      assert.equal(gameText(`${mark}Gem pack${mark}`), "Gem pack", control.toString(16));
    }
    const override = String.fromCodePoint(0x202e);
    assert.equal(gameText(`Free ${override}nioc 0001`), "Free nioc 0001", "a reversed price reads as written");
    const hebrew = "חבילת אבני חן";
    assert.equal(gameText(hebrew), hebrew, "right-to-left words stay as they are");
    assert.equal(gameText("Gem pack × 5 — 75 coin"), "Gem pack × 5 — 75 coin");
  });
});
