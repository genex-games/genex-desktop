/**
 * A game's coin purchase in Play's viewer, the shapes both sides share: main draws Studio's own sheet
 * in the bar's layer and takes back only an answer to the sheet on screen. What the page sends is
 * hostile input: anything but a known answer naming a whole sheet number reads as nothing, and no
 * id the page sends is ever handed on.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SECOND_MS } from "../../src/shared/duration.ts";
import {
  isIntentId,
  PURCHASE_ARM_MS,
  PurchaseAnswer,
  PurchaseRecovery,
  PurchaseStep,
  playCoinPageUrl,
  purchaseOver,
  readPurchaseAnswer,
  withoutBidiControls,
} from "../../src/shared/play-purchase.ts";

describe("A purchase sheet's answer from the bar page", () => {
  it("reads a known answer to a numbered sheet, and nothing the page added", () => {
    assert.deepEqual(readPurchaseAnswer({ sheet: 3, answer: "pay" }), { sheet: 3, answer: PurchaseAnswer.Pay });
    for (const answer of Object.values(PurchaseAnswer))
      assert.deepEqual(readPurchaseAnswer({ sheet: 1, answer }), { sheet: 1, answer }, answer);
    assert.deepEqual(
      readPurchaseAnswer({ sheet: 7, answer: "cancel", intentId: "clx-other", coins: 1 }),
      { sheet: 7, answer: PurchaseAnswer.Cancel },
      "an id or a price the page names is never taken",
    );
  });

  it("reads anything else as no answer at all", () => {
    const inherited = Object.create({ sheet: 1, answer: "pay" }) as object;
    const hostile: unknown[] = [
      undefined,
      null,
      {},
      [],
      [1, "pay"],
      "pay",
      42,
      { answer: "pay" },
      { sheet: 1 },
      { sheet: "1", answer: "pay" },
      { sheet: 1.5, answer: "pay" },
      { sheet: -1, answer: "pay" },
      { sheet: 0, answer: "pay" },
      { sheet: Number.NaN, answer: "pay" },
      { sheet: Number.POSITIVE_INFINITY, answer: "pay" },
      { sheet: 2 ** 53, answer: "pay" },
      { sheet: 1, answer: "PAY" },
      { sheet: 1, answer: "confirm" },
      { sheet: 1, answer: "toString" },
      { sheet: 1, answer: "__proto__" },
      { sheet: 1, answer: ["pay"] },
      inherited,
      JSON.parse('{"__proto__": {"sheet": 1, "answer": "pay"}}'),
    ];
    for (const value of hostile) assert.equal(readPurchaseAnswer(value), null, JSON.stringify(value));
  });
});

describe("A purchase's own words", () => {
  it("takes only an id genex.games could have handed out", () => {
    for (const id of ["clx123", "cm9z_A-1", "a".repeat(64)]) assert.equal(isIntentId(id), true, id);
    const hostile = ["", "a".repeat(65), "../x", "x/y", "x?y", "x#y", "%2e%2e", "x y", "é", 42, null, undefined];
    for (const id of hostile) assert.equal(isIntentId(id), false, String(id));
  });

  it("waits long enough before Pay may count, and sends Get Nex to genex.games' own site", () => {
    assert.ok(PURCHASE_ARM_MS >= 0.8 * SECOND_MS, "a click or key meant for the game never lands on Pay");
    assert.equal(playCoinPageUrl("https://genex.games"), "https://genex.games/inventory");
    assert.equal(playCoinPageUrl("http://localhost:3000/"), "http://localhost:3000/inventory");
  });
});

describe("Where a purchase stands, read alike by main and the bar page", () => {
  it("is over once paid, pending, failed or refused for want of coin, and open before", () => {
    const rows: Array<[PurchaseStep, PurchaseRecovery | null, boolean]> = [
      [PurchaseStep.Ask, null, false],
      [PurchaseStep.Paying, null, false],
      [PurchaseStep.NotEnough, PurchaseRecovery.Waiting, false],
      [PurchaseStep.NotEnough, PurchaseRecovery.Ready, false],
      [PurchaseStep.NotEnough, PurchaseRecovery.Over, true],
      [PurchaseStep.SignedOut, PurchaseRecovery.Waiting, false],
      [PurchaseStep.SignedOut, PurchaseRecovery.Ready, false],
      [PurchaseStep.Paid, null, true],
      [PurchaseStep.Pending, null, true],
      [PurchaseStep.Failed, null, true],
    ];
    for (const [step, recovery, over] of rows)
      assert.equal(purchaseOver({ step, recovery }), over, `${step}/${recovery}`);
  });

  it("drops the characters that turn a game's words around, and nothing else", () => {
    assert.equal(withoutBidiControls("\u202EGem pack\u2066 × 5\u2069\u200F"), "Gem pack × 5");
    const hebrew = "\u05D7\u05D1\u05D9\u05EA \u05E9\u05DE\u05DF";
    assert.equal(withoutBidiControls(hebrew), hebrew, "right-to-left words stay as they are");
    assert.equal(withoutBidiControls("  Lantern oil  "), "  Lantern oil  ", "spaces are the caller's to trim");
  });
});
