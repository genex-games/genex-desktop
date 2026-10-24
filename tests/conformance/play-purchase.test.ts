/**
 * A game's coin purchase in Play's viewer. Main reads the purchase the game asked for on genex.games
 * and draws Studio's own sheet over the dimmed game in the bar's layer, only for a purchase of the
 * game on screen that is still open. Pay counts only once the page has shown Ask for the arm delay
 * with no press in it; main confirms or cancels only the purchase it holds. Every way a payment can
 * end is shown conservatively: a sheet never says nothing was charged when it cannot know, and no
 * timer ever moves a sheet out of Paying.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CoinFailure, type CoinIntent, CoinIntentStatus, CoinRefused, CoinRoute } from "../../src/main/play/coin.ts";
import { GalleryError, SignInNeeded } from "../../src/main/play/gallery.ts";
import {
  PURCHASE_COOLDOWN_MS,
  PURCHASE_EXPIRY_GRACE_MS,
  PURCHASE_EXPIRY_MIN_MS,
  PURCHASE_RECHECK_MS,
  PURCHASE_SETTLE_MS,
  PURCHASE_SETTLE_POLL_MS,
  PURCHASE_TTL_MS,
} from "../../src/main/play/viewer-purchase.ts";
import { PLAY_BAR_HEIGHT, PlayControl } from "../../src/shared/play.ts";
import {
  PURCHASE_ARM_MS,
  PurchaseAnswer,
  PurchaseProblem,
  PurchaseRecovery,
  PurchaseStep,
  playCoinPageUrl,
} from "../../src/shared/play-purchase.ts";
import { INTENT, type RigOverrides, rig, settle, WALLET, WINDOW } from "../helpers/play-viewer-rig.ts";

type Rig = ReturnType<typeof rig>;

/** When Lost Cathedral's purchase lapses and the sheet re-reads it. */
const LAPSE_MS = INTENT.expiresAt + PURCHASE_EXPIRY_GRACE_MS;
/** Longer than a purchase stays open, with its grace. */
const INTENT_LONG = LAPSE_MS * 2;

/** A promise the test settles when it chooses. */
function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

/** A viewer playing Lost Cathedral, its page loaded. */
async function playing(overrides: RigOverrides = {}): Promise<Rig> {
  const made = rig(overrides);
  made.viewer.open("lost-cathedral", "Lost Cathedral");
  await settle();
  made.viewer.loaded();
  return made;
}

/** A viewer playing Lost Cathedral whose game asked to pay for `id`, the purchase read. */
async function asked(overrides: RigOverrides = {}, id = INTENT.id): Promise<Rig> {
  const made = await playing(overrides);
  made.viewer.purchase(id);
  await settle();
  return made;
}

/** Answer the sheet on screen (or the one numbered `sheet`). */
function answer(made: Rig, value: PurchaseAnswer, sheet = made.sheet()?.sheet ?? 0): void {
  made.viewer.answerPurchase({ sheet, answer: value });
}

/** The page shows the sheet and the arm delay passes with no press: Pay counts. */
function arm(made: Rig): void {
  answer(made, PurchaseAnswer.Shown);
  made.advance(PURCHASE_ARM_MS);
}

/** Pay on an armed Ask, and let genex.games answer. */
async function pay(made: Rig): Promise<void> {
  arm(made);
  answer(made, PurchaseAnswer.Pay);
  await settle();
}

/** The coin calls a rig has made, by kind. */
const coinCalls = (made: Rig, kind: "intent" | "balance" | "confirm" | "cancel"): string[] =>
  made.log.filter((line) => line.startsWith(`coin.${kind}`));

/** What a sheet says, without its number or its words. */
const face = (made: Rig) => {
  const sheet = made.sheet();
  return sheet && { step: sheet.step, problem: sheet.problem, recovery: sheet.recovery };
};

const FAILED = (problem: PurchaseProblem) => ({ step: PurchaseStep.Failed, problem, recovery: null });
const NOT_ENOUGH = (recovery: PurchaseRecovery) => ({ step: PurchaseStep.NotEnough, problem: null, recovery });
const STEP = (step: PurchaseStep) => ({ step, problem: null, recovery: null });

/** genex.games refusing a confirm with `code`. */
const refused = (status: number, code: CoinFailure) => new CoinRefused(CoinRoute.confirm(INTENT.id), status, code);

describe("A game's purchase sheet: asking", () => {
  it("draws Ask over the whole window from what genex.games says, and takes the keyboard once the page shows it", async () => {
    const made = await playing();
    made.log.length = 0;
    made.viewer.purchase(INTENT.id);
    await settle();
    assert.deepEqual(made.sheet(), {
      sheet: 1,
      step: PurchaseStep.Ask,
      problem: null,
      recovery: null,
      armed: false,
      game: { title: "Lost Cathedral", coverUrl: null },
      item: {
        name: "Lantern oil",
        description: "Keeps the lantern lit for one more floor.",
        imageUrl: null,
        quantity: 1,
        unitPriceCoins: 75,
      },
      price: { coins: 75, usdCents: 75 },
      balance: WALLET,
    });
    assert.ok(made.log.includes(`bar.show 0,0 ${WINDOW.width}x${WINDOW.height}`), "the layer covers the window");
    assert.ok(!made.log.includes("bar.focus"), "the keyboard waits for the page to show the sheet");
    answer(made, PurchaseAnswer.Shown);
    assert.equal(made.log.at(-1), "bar.focus");
    assert.deepEqual(coinCalls(made, "intent"), [`coin.intent ${INTENT.id}`]);
  });

  it("pays only once the page has shown Ask for the arm delay, then shows Paid and the balance left", async () => {
    const made = await asked();
    answer(made, PurchaseAnswer.Pay);
    made.advance(PURCHASE_ARM_MS);
    answer(made, PurchaseAnswer.Pay);
    assert.deepEqual(coinCalls(made, "confirm"), [], "the page never said it showed Ask");
    answer(made, PurchaseAnswer.Shown);
    made.advance(PURCHASE_ARM_MS - 1);
    answer(made, PurchaseAnswer.Pay);
    assert.deepEqual(coinCalls(made, "confirm"), [], "too soon");
    made.advance(1);
    assert.equal(made.sheet()?.armed, true);
    answer(made, PurchaseAnswer.Pay);
    assert.equal(made.sheet()?.step, PurchaseStep.Paying);
    await settle();
    assert.deepEqual(coinCalls(made, "confirm"), [`coin.confirm ${INTENT.id}`]);
    assert.deepEqual(face(made), STEP(PurchaseStep.Paid));
    assert.equal(made.sheet()?.balance, WALLET - INTENT.totalCoins);
    made.log.length = 0;
    answer(made, PurchaseAnswer.Back);
    assert.equal(made.sheet(), null);
    assert.ok(made.log.includes("game.focus"), "the keyboard goes back to the game");
    assert.equal(
      made.log.find((line) => line.startsWith("bar.")),
      `bar.show 0,0 ${WINDOW.width}x${PLAY_BAR_HEIGHT}`,
    );
  });
});

describe("A game's purchase sheet: arming Pay", () => {
  it("starts the arm delay again on a press in the bar's layer, a repeated key or the window's focus changing", async () => {
    const made = await asked();
    answer(made, PurchaseAnswer.Shown);
    made.advance(PURCHASE_ARM_MS - 1);
    made.viewer.barInput({ type: "mouseDown" });
    made.advance(PURCHASE_ARM_MS - 1);
    assert.equal(made.sheet()?.armed, false, "a press while unarmed restarts the wait");
    made.advance(1);
    assert.equal(made.sheet()?.armed, true);
    made.viewer.barInput({ type: "mouseMove" });
    made.viewer.barInput({ type: "keyDown", isAutoRepeat: false });
    assert.equal(made.sheet()?.armed, true, "a move, or the press that pays, leaves Pay armed");
    made.viewer.barInput({ type: "keyDown", isAutoRepeat: true });
    assert.equal(made.sheet()?.armed, false, "a key held down never pays");
    made.advance(PURCHASE_ARM_MS);
    assert.equal(made.sheet()?.armed, true);
    made.viewer.focusChanged();
    assert.equal(made.sheet()?.armed, false, "the window coming back (or going) disarms Pay");
    answer(made, PurchaseAnswer.Pay);
    assert.deepEqual(coinCalls(made, "confirm"), []);
    made.advance(PURCHASE_ARM_MS);
    assert.equal(made.sheet()?.armed, true);
    answer(made, PurchaseAnswer.Shown);
    assert.equal(made.sheet()?.armed, false, "a page that drew the sheet again (it reloaded) shows it unarmed");
    made.advance(PURCHASE_ARM_MS);
    assert.equal(made.sheet()?.armed, true);
  });

  it("takes one Pay at a time and nothing else while paying", async () => {
    const confirming = deferred<void>();
    const made = await asked({ coin: { confirm: () => confirming.promise } });
    arm(made);
    answer(made, PurchaseAnswer.Pay);
    for (const value of Object.values(PurchaseAnswer)) answer(made, value);
    await settle();
    assert.equal(made.sheet()?.step, PurchaseStep.Paying);
    assert.deepEqual(coinCalls(made, "cancel"), [], "Esc and Cancel wait for genex.games");
    confirming.resolve();
    await settle();
    assert.equal(made.sheet()?.step, PurchaseStep.Paid);
  });

  it("drops an answer for a sheet not on screen, and anything that is not an answer", async () => {
    const made = await asked();
    arm(made);
    const { sheet } = made.sheet() ?? { sheet: 0 };
    const hostile: unknown[] = [
      null,
      {},
      "pay",
      { sheet: String(sheet), answer: PurchaseAnswer.Pay },
      { sheet: sheet + 0.5, answer: PurchaseAnswer.Pay },
      { sheet: sheet + 1, answer: PurchaseAnswer.Pay },
      { sheet: sheet - 1, answer: PurchaseAnswer.Pay },
      { sheet, answer: "PAY" },
      { sheet, answer: "confirm" },
    ];
    for (const value of hostile) made.viewer.answerPurchase(value);
    await settle();
    assert.deepEqual(coinCalls(made, "confirm"), []);
    assert.equal(made.sheet()?.step, PurchaseStep.Ask);
    const idle = await playing();
    idle.viewer.answerPurchase({ sheet: 1, answer: PurchaseAnswer.Pay });
    await settle();
    assert.deepEqual(coinCalls(idle, "confirm"), [], "no sheet, nothing to pay");
  });
});

describe("A game's purchase sheet: what is never shown", () => {
  it("draws nothing for another game's purchase, one already over, or one that cannot be read", async () => {
    const intentOf = (change: Partial<CoinIntent>) => async (id: string) => ({ ...INTENT, ...change, id });
    const fails = (error: Error) => async () => {
      throw error;
    };
    const settled = Object.values(CoinIntentStatus).filter(
      (status) => status !== CoinIntentStatus.RequiresConfirmation,
    );
    const cases: Array<[string, RigOverrides]> = [
      ["another game's", { coin: { intent: intentOf({ projectId: "cm-other" }) } }],
      ["no game's", { coin: { intent: intentOf({ projectId: null }) } }],
      ["a game whose page facts are unread", { world: fails(new Error("offline")) }],
      ...settled.map((status): [string, RigOverrides] => [status, { coin: { intent: intentOf({ status }) } }]),
      ["unreadable", { coin: { intent: fails(new GalleryError(CoinRoute.intent(INTENT.id), 502)) } }],
      [
        "not found",
        { coin: { intent: fails(new CoinRefused(CoinRoute.intent(INTENT.id), 404, CoinFailure.IntentNotFound)) } },
      ],
      ["offline", { coin: { intent: fails(new Error("fetch failed")) } }],
    ];
    for (const [name, overrides] of cases) {
      const made = await asked(overrides);
      assert.equal(made.sheet(), null, name);
      assert.ok(!made.log.includes(`bar.show 0,0 ${WINDOW.width}x${WINDOW.height}`), name);
      assert.deepEqual([...coinCalls(made, "confirm"), ...coinCalls(made, "cancel")], [], name);
      assert.deepEqual(
        coinCalls(made, "balance"),
        [],
        `${name}: the balance is read only for a purchase it may ask for`,
      );
      assert.equal(made.viewer.mayReserve(), false, `${name}: the game waits before it may ask again`);
      made.advance(PURCHASE_COOLDOWN_MS);
      assert.equal(made.viewer.mayReserve(), true, `${name}: then it may`);
    }
  });

  it("reads nothing for a second purchase while one is open or being read", async () => {
    const reading = deferred<CoinIntent>();
    const made = await playing({ coin: { intent: () => reading.promise } });
    assert.equal(made.viewer.mayReserve(), true);
    made.viewer.purchase(INTENT.id);
    assert.equal(made.viewer.mayReserve(), false, "being read");
    made.viewer.purchase("pi_2");
    reading.resolve(INTENT);
    await settle();
    assert.equal(made.viewer.mayReserve(), false, "open");
    made.viewer.purchase("pi_3");
    await settle();
    assert.equal(made.sheet()?.sheet, 1);
    assert.deepEqual(coinCalls(made, "intent"), [`coin.intent ${INTENT.id}`], "one purchase read");
  });

  it("drops a purchase read for a game left before it answered", async () => {
    const reading = deferred<CoinIntent>();
    const made = await playing({ coin: { intent: () => reading.promise } });
    made.viewer.purchase(INTENT.id);
    made.viewer.open("lost-cathedral", "Lost Cathedral");
    await settle();
    reading.resolve(INTENT);
    await settle();
    assert.ok(made.events.every((event) => !event.bar?.purchase));
    assert.equal(made.viewer.mayReserve(), true);
  });

  it("gives the player a few seconds after Cancel before a game may ask again", async () => {
    const made = await asked();
    answer(made, PurchaseAnswer.Cancel);
    await settle();
    assert.equal(made.sheet(), null);
    assert.deepEqual(coinCalls(made, "cancel"), [`coin.cancel ${INTENT.id}`]);
    assert.equal(made.viewer.mayReserve(), false);
    made.viewer.purchase("pi_2");
    await settle();
    assert.deepEqual(coinCalls(made, "intent"), [`coin.intent ${INTENT.id}`], "a sheet right after Cancel is not read");
    made.advance(PURCHASE_COOLDOWN_MS);
    assert.equal(made.viewer.mayReserve(), true);
    made.viewer.purchase("pi_2");
    await settle();
    assert.equal(made.sheet()?.step, PurchaseStep.Ask);
  });
});

describe("A game's purchase sheet: a game that keeps asking", () => {
  it("reads nothing more while a game keeps asking for purchases it may not, until the wait passes", async () => {
    const made = await asked({ coin: { intent: async (id) => ({ ...INTENT, id, projectId: "cm-other" }) } });
    for (let ask = 2; ask < 27; ask += 1) {
      made.viewer.purchase(`pi_${ask}`);
      await settle();
    }
    assert.deepEqual(coinCalls(made, "intent"), [`coin.intent ${INTENT.id}`], "one read for 26 asks");
    assert.deepEqual(coinCalls(made, "balance"), []);
    made.advance(PURCHASE_COOLDOWN_MS);
    made.viewer.purchase("pi_99");
    await settle();
    assert.deepEqual(coinCalls(made, "intent"), [`coin.intent ${INTENT.id}`, "coin.intent pi_99"], "one read per wait");
    assert.equal(made.sheet(), null);
  });
});

describe("A game's purchase sheet: not enough coin", () => {
  it("offers Get coin when the balance is short, and comes back to Ask only through Review once the coin lands", async () => {
    const balances = [40, 40, WALLET];
    const made = await asked({ coin: { balance: async () => balances.shift() ?? WALLET } });
    assert.deepEqual(face(made), NOT_ENOUGH(PurchaseRecovery.Waiting));
    assert.equal(made.sheet()?.balance, 40);
    made.advance(PURCHASE_RECHECK_MS * 3);
    await settle();
    assert.equal(balances.length, 2, "nothing is checked again before Get coin");
    answer(made, PurchaseAnswer.GetCoin);
    assert.deepEqual(made.pages, [playCoinPageUrl("https://genex.games")]);
    made.advance(PURCHASE_RECHECK_MS);
    await settle();
    assert.deepEqual(face(made), NOT_ENOUGH(PurchaseRecovery.Waiting));
    const waiting = made.sheet()?.sheet ?? 0;
    made.advance(PURCHASE_RECHECK_MS);
    await settle();
    assert.deepEqual(face(made), NOT_ENOUGH(PurchaseRecovery.Ready));
    assert.ok((made.sheet()?.sheet ?? 0) > waiting, "a new sheet: a press meant for Get coin is dropped");
    made.advance(PURCHASE_RECHECK_MS * 3);
    await settle();
    assert.deepEqual(face(made), NOT_ENOUGH(PurchaseRecovery.Ready), "never Ask by itself");
    answer(made, PurchaseAnswer.Review);
    assert.deepEqual(face(made), STEP(PurchaseStep.Ask));
    assert.equal(made.sheet()?.armed, false, "Pay waits for the page to show Ask again");
    assert.equal(made.sheet()?.balance, WALLET);
  });

  it("ends the purchase on a payment refused for want of coin: no second confirm, no recheck", async () => {
    const balances = [WALLET, 40];
    const made = await asked({
      coin: {
        balance: async () => balances.shift() ?? 40,
        confirm: async () => {
          throw refused(402, CoinFailure.InsufficientBalance);
        },
      },
    });
    await pay(made);
    assert.deepEqual(face(made), NOT_ENOUGH(PurchaseRecovery.Over));
    assert.equal(made.sheet()?.balance, 40, "the balance read afresh");
    answer(made, PurchaseAnswer.GetCoin);
    answer(made, PurchaseAnswer.Review);
    answer(made, PurchaseAnswer.Pay);
    made.advance(INTENT_LONG);
    await settle();
    assert.equal(made.pages.length, 1, "Get coin still opens genex.games");
    assert.equal(made.sheet()?.balance, 40);
    assert.deepEqual(face(made), NOT_ENOUGH(PurchaseRecovery.Over));
    assert.equal(coinCalls(made, "confirm").length, 1);
    assert.equal(coinCalls(made, "balance").length, 2, "nothing checked again: the purchase is over");
    assert.equal(coinCalls(made, "intent").length, 1, "nor re-read when it would have lapsed");
    answer(made, PurchaseAnswer.Back);
    assert.equal(made.sheet(), null);
    assert.deepEqual(coinCalls(made, "cancel"), [], "nothing left to cancel");
  });
});

describe("A game's purchase sheet: how a refused payment ends", () => {
  it("says the purchase timed out when genex.games says so", async () => {
    const made = await asked({
      coin: {
        confirm: async () => {
          throw refused(409, CoinFailure.IntentExpired);
        },
      },
    });
    await pay(made);
    assert.deepEqual(face(made), FAILED(PurchaseProblem.Expired));
  });

  it("reads the purchase again after any other refusal, and shows what it says, conservatively", async () => {
    const after: Array<[CoinIntentStatus, CoinFailure | null, ReturnType<typeof face>]> = [
      [CoinIntentStatus.Succeeded, null, STEP(PurchaseStep.Paid)],
      [CoinIntentStatus.Consumed, null, STEP(PurchaseStep.Paid)],
      [CoinIntentStatus.Processing, null, STEP(PurchaseStep.Pending)],
      [CoinIntentStatus.Canceled, null, FAILED(PurchaseProblem.Canceled)],
      [CoinIntentStatus.Expired, CoinFailure.IntentExpired, FAILED(PurchaseProblem.Expired)],
      [CoinIntentStatus.Failed, CoinFailure.InsufficientBalance, NOT_ENOUGH(PurchaseRecovery.Over)],
      [CoinIntentStatus.Failed, CoinFailure.SkuInactive, FAILED(PurchaseProblem.Refused)],
      [CoinIntentStatus.Refunded, null, FAILED(PurchaseProblem.Refunded)],
      [CoinIntentStatus.RequiresConfirmation, null, FAILED(PurchaseProblem.Refused)],
    ];
    for (const [status, failure, expected] of after) {
      const reads = [INTENT, { ...INTENT, status, failure }];
      const made = await asked({
        coin: {
          intent: async () => reads.shift() ?? { ...INTENT, status, failure },
          confirm: async () => {
            throw refused(403, CoinFailure.SurfaceCap);
          },
        },
      });
      await pay(made);
      assert.deepEqual(face(made), expected, status);
      assert.equal(coinCalls(made, "intent").length, 2, `${status}: read once more`);
      assert.equal(coinCalls(made, "confirm").length, 1, `${status}: never confirmed again`);
    }
  });

  it("keeps a refusal it cannot read again as refused, or pending when the purchase was already moving", async () => {
    const cases: Array<[CoinFailure, ReturnType<typeof face>]> = [
      [CoinFailure.SurfaceCap, FAILED(PurchaseProblem.Refused)],
      [CoinFailure.Unknown, FAILED(PurchaseProblem.Refused)],
      [CoinFailure.IntentNotPending, STEP(PurchaseStep.Pending)],
    ];
    for (const [code, expected] of cases) {
      let reads = 0;
      const made = await asked({
        coin: {
          intent: async () => {
            reads += 1;
            if (reads > 1) throw new Error("fetch failed");
            return INTENT;
          },
          confirm: async () => {
            throw refused(409, code);
          },
        },
      });
      await pay(made);
      assert.deepEqual(face(made), expected, code);
    }
  });

  it("takes genex.games refusing Studio's confirm as a refusal, never as the account signing out", async () => {
    const made = await asked({
      coin: {
        confirm: async () => {
          throw refused(401, CoinFailure.ConfirmRequiresSession);
        },
      },
    });
    await pay(made);
    assert.deepEqual(face(made), FAILED(PurchaseProblem.Refused));
    assert.equal(made.bar()?.signedIn, true);
  });

  it("offers Sign in when the account signed out before Pay reached genex.games", async () => {
    const made = await asked({
      coin: {
        confirm: async () => {
          throw new SignInNeeded();
        },
      },
    });
    await pay(made);
    assert.deepEqual(face(made), { step: PurchaseStep.SignedOut, problem: null, recovery: PurchaseRecovery.Waiting });
    assert.equal(made.sheet()?.item?.name, INTENT.name, "the purchase is still known");
    assert.equal(made.bar()?.signedIn, false);
  });
});

describe("A game's purchase sheet: a payment genex.games has not answered", () => {
  it("waits on a payment genex.games failed to answer until it settles, then shows Paid", async () => {
    const statuses = [CoinIntentStatus.Processing, CoinIntentStatus.Processing, CoinIntentStatus.Succeeded];
    let reads = 0;
    const made = await asked({
      coin: {
        intent: async (id) => {
          reads += 1;
          return reads === 1 ? INTENT : { ...INTENT, id, status: statuses.shift() ?? CoinIntentStatus.Succeeded };
        },
        confirm: async () => {
          throw new GalleryError(CoinRoute.confirm(INTENT.id), 503);
        },
      },
    });
    await pay(made);
    assert.deepEqual(face(made), STEP(PurchaseStep.Pending));
    const pending = made.sheet()?.sheet;
    made.advance(PURCHASE_SETTLE_POLL_MS);
    await settle();
    assert.deepEqual(face(made), STEP(PurchaseStep.Pending));
    assert.equal(made.sheet()?.sheet, pending, "still the same sheet");
    made.advance(PURCHASE_SETTLE_POLL_MS);
    await settle();
    made.advance(PURCHASE_SETTLE_POLL_MS);
    await settle();
    assert.deepEqual(face(made), STEP(PurchaseStep.Paid));
    made.advance(PURCHASE_SETTLE_POLL_MS * 5);
    await settle();
    assert.equal(reads, 4, "asking stops once it settles");
  });

  it("ends a pending payment as timed out once its purchase lapses unpaid", async () => {
    const made = await asked({
      coin: {
        confirm: async () => {
          throw new Error("fetch failed");
        },
      },
    });
    await pay(made);
    assert.deepEqual(face(made), STEP(PurchaseStep.Pending));
    made.advance(PURCHASE_SETTLE_POLL_MS);
    await settle();
    assert.deepEqual(face(made), STEP(PurchaseStep.Pending), "released but still open: maybe still landing");
    while (made.now() < LAPSE_MS + PURCHASE_SETTLE_POLL_MS) {
      made.advance(PURCHASE_SETTLE_POLL_MS);
      await settle();
    }
    assert.deepEqual(face(made), FAILED(PurchaseProblem.Expired));
  });

  it("stops asking once the player goes back to the game from Pending", async () => {
    let reads = 0;
    const made = await asked({
      coin: {
        confirm: async () => {
          throw new GalleryError(CoinRoute.confirm(INTENT.id), 503);
        },
        intent: async (id) => {
          reads += 1;
          return reads === 1 ? INTENT : { ...INTENT, id, status: CoinIntentStatus.Processing };
        },
      },
    });
    await pay(made);
    answer(made, PurchaseAnswer.Back);
    assert.equal(made.sheet(), null);
    const before = coinCalls(made, "intent").length;
    made.advance(INTENT_LONG);
    await settle();
    assert.equal(coinCalls(made, "intent").length, before);
    assert.deepEqual(coinCalls(made, "cancel"), [], "a payment that may land is never canceled");
  });
});

describe("A game's purchase sheet: a payment that never settles", () => {
  it("stops asking after a while and stays Pending, never saying how it went", async () => {
    let reads = 0;
    const made = await asked({
      coin: {
        intent: async (id) => {
          reads += 1;
          const open = { ...INTENT, id, expiresAt: PURCHASE_SETTLE_MS * 10 };
          return reads === 1 ? open : { ...open, status: CoinIntentStatus.Processing };
        },
        confirm: async () => {
          throw new Error("fetch failed");
        },
      },
    });
    await pay(made);
    while (made.now() < PURCHASE_SETTLE_MS * 2) {
      made.advance(PURCHASE_SETTLE_POLL_MS);
      await settle();
    }
    const count = reads;
    assert.ok(count > 2 && count <= PURCHASE_SETTLE_MS / PURCHASE_SETTLE_POLL_MS + 2, `${count} reads`);
    made.advance(PURCHASE_SETTLE_MS);
    await settle();
    assert.equal(reads, count, "asking stopped");
    assert.deepEqual(face(made), STEP(PurchaseStep.Pending));
  });
});

describe("A game's purchase sheet: its time running out", () => {
  it("reads the purchase again when it lapses: timed out unpaid, or paid elsewhere", async () => {
    const unpaid = await asked();
    unpaid.advance(LAPSE_MS - 1);
    await settle();
    assert.equal(unpaid.sheet()?.step, PurchaseStep.Ask);
    unpaid.advance(1);
    await settle();
    assert.deepEqual(face(unpaid), FAILED(PurchaseProblem.Expired));
    assert.equal(coinCalls(unpaid, "intent").length, 2, "read again rather than assumed");

    let reads = 0;
    const elsewhere = await asked({
      coin: {
        intent: async (id) => {
          reads += 1;
          return reads === 1 ? INTENT : { ...INTENT, id, status: CoinIntentStatus.Succeeded };
        },
      },
    });
    elsewhere.advance(LAPSE_MS);
    await settle();
    assert.deepEqual(face(elsewhere), STEP(PurchaseStep.Paid));
  });

  it("never leaves Paying on a timer", async () => {
    const confirming = deferred<void>();
    const made = await asked({ coin: { confirm: () => confirming.promise } });
    arm(made);
    made.advance(LAPSE_MS - PURCHASE_ARM_MS - 1);
    answer(made, PurchaseAnswer.Pay);
    made.advance(INTENT_LONG);
    await settle();
    assert.equal(made.sheet()?.step, PurchaseStep.Paying);
    assert.equal(coinCalls(made, "intent").length, 1, "the lapse's re-read was cleared with Ask");
    confirming.resolve();
    await settle();
    assert.equal(made.sheet()?.step, PurchaseStep.Paid);

    const lapsing = deferred<CoinIntent>();
    let reads = 0;
    const racing = await asked({
      coin: {
        intent: async () => {
          reads += 1;
          return reads === 1 ? INTENT : lapsing.promise;
        },
      },
    });
    arm(racing);
    racing.advance(LAPSE_MS);
    answer(racing, PurchaseAnswer.Pay);
    lapsing.resolve({ ...INTENT, status: CoinIntentStatus.Expired });
    await settle();
    assert.equal(racing.sheet()?.step, PurchaseStep.Paid, "a re-read started before Pay is dropped");
  });

  it("keeps Ask while genex.games still holds the purchase open, however far ahead the app's clock runs", async () => {
    // genex.games has just made the purchase, yet by the app's clock its time passed a minute ago.
    const made = await asked({ coin: { intent: async (id) => ({ ...INTENT, id, expiresAt: -60_000 }) } });
    arm(made);
    const shown = made.sheet()?.sheet;
    made.advance(PURCHASE_EXPIRY_MIN_MS - PURCHASE_ARM_MS - 1);
    await settle();
    assert.equal(coinCalls(made, "intent").length, 1, "a few seconds at least before it is read again");
    made.advance(1);
    await settle();
    assert.equal(coinCalls(made, "intent").length, 2, "read again rather than assumed");
    assert.deepEqual(face(made), STEP(PurchaseStep.Ask), "genex.games still says it is open to pay");
    assert.equal(made.sheet()?.sheet, shown, "the same sheet");
    assert.equal(made.sheet()?.armed, true, "Pay still counts");
    while (made.now() + PURCHASE_EXPIRY_MIN_MS <= PURCHASE_TTL_MS) {
      made.advance(PURCHASE_EXPIRY_MIN_MS);
      await settle();
    }
    assert.deepEqual(face(made), STEP(PurchaseStep.Ask), "a whole TTL has not passed on the app's own clock");
    assert.ok(coinCalls(made, "intent").length > 3, "asked again every few seconds");
    made.advance(PURCHASE_EXPIRY_MIN_MS);
    await settle();
    assert.deepEqual(face(made), FAILED(PurchaseProblem.Expired), "it has now, and genex.games never took the coin");
  });
});

describe("A game's purchase sheet: signed out", () => {
  it("offers Sign in when the account cannot read the purchase, and Review once it can", async () => {
    let refusals = 2;
    const made = await asked({
      coin: {
        intent: async (id) => {
          if (refusals-- > 0) throw new SignInNeeded();
          return { ...INTENT, id };
        },
      },
    });
    assert.deepEqual(face(made), { step: PurchaseStep.SignedOut, problem: null, recovery: PurchaseRecovery.Waiting });
    assert.deepEqual([made.sheet()?.item, made.sheet()?.price], [null, null]);
    assert.equal(made.bar()?.signedIn, false);
    made.advance(PURCHASE_RECHECK_MS);
    await settle();
    assert.equal(coinCalls(made, "intent").length, 1, "nothing is read again before Sign in");
    answer(made, PurchaseAnswer.SignIn);
    assert.ok(made.log.includes("account.signIn"));
    made.advance(PURCHASE_RECHECK_MS);
    await settle();
    assert.equal(made.sheet()?.recovery, PurchaseRecovery.Waiting);
    made.advance(PURCHASE_RECHECK_MS);
    await settle();
    assert.deepEqual(face(made), { step: PurchaseStep.SignedOut, problem: null, recovery: PurchaseRecovery.Ready });
    assert.equal(made.sheet()?.item?.name, INTENT.name);
    assert.equal(made.bar()?.signedIn, true, "the account reads again: the bar is signed in too");
    answer(made, PurchaseAnswer.Review);
    assert.deepEqual(face(made), STEP(PurchaseStep.Ask));
    answer(made, PurchaseAnswer.Cancel);
    made.viewer.control(PlayControl.Install);
    assert.equal(made.viewer.showing(), "lost-cathedral", "the bar's Sign in no longer leaves the game");
  });

  it("closes a sign-in sheet whose purchase turns out to be another game's, canceling nothing", async () => {
    let refusals = 1;
    const made = await asked({
      coin: {
        intent: async (id) => {
          if (refusals-- > 0) throw new SignInNeeded();
          return { ...INTENT, id, projectId: "cm-other" };
        },
      },
    });
    answer(made, PurchaseAnswer.SignIn);
    made.advance(PURCHASE_RECHECK_MS);
    await settle();
    assert.equal(made.sheet(), null);
    assert.deepEqual(coinCalls(made, "cancel"), []);
    assert.equal(made.bar()?.signedIn, true, "the account read it: signed in all the same");
  });

  it("gives up on a purchase it never could read once genex.games would have let it lapse", async () => {
    const made = await asked({
      coin: {
        intent: async () => {
          throw new SignInNeeded();
        },
      },
    });
    made.advance(PURCHASE_TTL_MS + PURCHASE_EXPIRY_GRACE_MS);
    await settle();
    assert.deepEqual(face(made), FAILED(PurchaseProblem.Expired));
    answer(made, PurchaseAnswer.Back);
    assert.equal(made.sheet(), null);
    assert.deepEqual(coinCalls(made, "cancel"), []);
  });

  it("cancels nothing for a purchase it could not read", async () => {
    const made = await asked({
      coin: {
        intent: async () => {
          throw new SignInNeeded();
        },
      },
    });
    answer(made, PurchaseAnswer.Cancel);
    await settle();
    assert.equal(made.sheet(), null);
    assert.deepEqual(coinCalls(made, "cancel"), []);
  });
});

describe("A game's purchase sheet: leaving it", () => {
  it("cancels an unpaid purchase when the viewer closes or another game opens, never one being paid", async () => {
    const closing = await asked();
    closing.viewer.close();
    await settle();
    assert.deepEqual(coinCalls(closing, "cancel"), [`coin.cancel ${INTENT.id}`]);

    const short = await asked({ coin: { balance: async () => 40 } });
    short.viewer.open("lost-cathedral", "Lost Cathedral");
    await settle();
    assert.deepEqual(coinCalls(short, "cancel"), [`coin.cancel ${INTENT.id}`], "NotEnough before Pay");

    const paying = await asked({ coin: { confirm: () => new Promise(() => {}) } });
    arm(paying);
    answer(paying, PurchaseAnswer.Pay);
    paying.viewer.close();
    await settle();
    assert.deepEqual(coinCalls(paying, "cancel"), []);
  });

  it("closes an unpaid sheet when the game's page changes or dies, and keeps one whose payment is moving", async () => {
    for (const leave of ["navigated", "failed"] as const) {
      const made = await asked();
      made.viewer[leave]();
      await settle();
      assert.equal(made.sheet(), null, leave);
      assert.deepEqual(coinCalls(made, "cancel"), [`coin.cancel ${INTENT.id}`], leave);
      assert.equal(made.viewer.mayReserve(), true, `${leave}: the new page may ask at once`);
    }
    const paying = await asked({ coin: { confirm: () => new Promise(() => {}) } });
    arm(paying);
    answer(paying, PurchaseAnswer.Pay);
    paying.viewer.navigated();
    await settle();
    assert.equal(paying.sheet()?.step, PurchaseStep.Paying);
    assert.deepEqual(coinCalls(paying, "cancel"), []);
  });

  it("shows Paid when a Cancel finds the purchase already paid", async () => {
    const made = await asked({ coin: { cancel: async () => CoinIntentStatus.Succeeded } });
    answer(made, PurchaseAnswer.Cancel);
    assert.equal(made.sheet(), null, "Cancel closes at once");
    await settle();
    assert.deepEqual(face(made), STEP(PurchaseStep.Paid));
  });

  it("keeps the keyboard on the sheet while it is open, and gives it back to the game after", async () => {
    const made = rig();
    made.viewer.open("lost-cathedral", "Lost Cathedral");
    await settle();
    made.viewer.purchase(INTENT.id);
    await settle();
    answer(made, PurchaseAnswer.Shown);
    made.log.length = 0;
    made.viewer.loaded();
    made.viewer.hold({ comments: true });
    made.viewer.hold({ comments: false });
    made.viewer.control(PlayControl.Resume);
    assert.ok(
      !made.log.includes("game.focus"),
      "loading, Comments closing and Resume leave the keyboard with the sheet",
    );
    assert.ok(!made.log.includes("bar.hide"));
    answer(made, PurchaseAnswer.Cancel);
    assert.ok(made.log.includes("game.focus"));
  });
});
