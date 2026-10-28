/**
 * Buying an item from a game's page (marketplace plan 10.1, P7): main starts the purchase on
 * genex.games for the game whose page it is, then shows Play's own purchase sheet for it in the
 * studio window, run by the same machine as the viewer's (`viewer-purchase.ts`): Pay counts only
 * once the page has shown Ask for the arm delay, and main confirms (on `STUDIO_CONFIRM_SURFACE`,
 * through the coin client) or cancels only the purchase it started. `storeBuy` answers when the
 * sheet closes, with how it ended; a refusal before any sheet answers its code.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type CoinIntent, CoinIntentStatus } from "../../src/main/play/coin.ts";
import type { PlayWorld } from "../../src/main/play/gallery.ts";
import { followStudioWindow, STORE_SHEET_OPEN_MS, storeSheet } from "../../src/main/play/store-sheet.ts";
import {
  PURCHASE_ARM_MS,
  PurchaseAnswer,
  PurchaseRecovery,
  PurchaseStep,
  playCoinPageUrl,
} from "../../src/shared/play-purchase.ts";
import {
  type StoreBuyResult,
  StoreBuyOutcome,
  StoreRefusal,
  type StoreRefused,
  type StoreSheet,
} from "../../src/shared/store-items.ts";
import { fakeClock, settle } from "../helpers/play-viewer-rig.ts";

const WEB = "https://genex.games";
const WALLET = 62_450;

const WORLD: PlayWorld = {
  id: "proj-ss",
  slug: "stick-steel",
  title: "Stick & Steel",
  multiplayer: false,
  likes: 0,
  liked: false,
  remixable: false,
  cloneUrl: null,
  author: "Simeon M",
  authorId: null,
  plays: 0,
  online: null,
  comments: 0,
  coverUrl: null,
};

/** The purchase genex.games starts for the Legendary Sword on Stick & Steel's page. */
const INTENT: CoinIntent = {
  id: "int1",
  status: CoinIntentStatus.RequiresConfirmation,
  projectId: WORLD.id,
  dynamic: false,
  name: "Legendary Sword",
  description: null,
  iconUrl: null,
  quantity: 1,
  unitPriceCoins: 50_000,
  totalCoins: 50_000,
  usdCents: 50_000,
  expiresAt: 120_000,
  failure: null,
};

interface RigOptions {
  /** What starting the purchase answers. */
  started?: CoinIntent | StoreRefused;
  /** What reading it back answers; an Error rejects, and "hangs" never answers. */
  read?: CoinIntent | Error | "hangs";
  balance?: number;
  /** The earned coin on hold the balance answers with; absent: a coin client that reads the balance only. */
  held?: { coins: number; releaseAt: number } | null;
}

/** The store sheet over recording fakes: the log holds every call to genex.games and the browser. */
function rig(options: RigOptions = {}) {
  const { clock, advance } = fakeClock();
  const log: string[] = [];
  const pushed: Array<StoreSheet | null> = [];
  let balance = options.balance ?? WALLET;
  const sheet = storeSheet({
    purchase: async (itemId, slug) => {
      log.push(`purchase ${itemId} ${slug}`);
      return options.started ?? INTENT;
    },
    world: async (slug) => {
      log.push(`world ${slug}`);
      return WORLD;
    },
    coin: {
      intent: async (id) => {
        log.push(`coin.intent ${id}`);
        if (options.read instanceof Error) throw options.read;
        if (options.read === "hangs") return new Promise<CoinIntent>(() => {});
        return options.read ?? INTENT;
      },
      balance: async () => {
        log.push("coin.balance");
        return balance;
      },
      ...(options.held === undefined
        ? {}
        : {
            wallet: async () => {
              log.push("coin.balance");
              return { spendable: balance, held: options.held ?? null };
            },
          }),
      confirm: async (intent) => {
        log.push(`coin.confirm ${intent.id}`);
        balance -= intent.totalCoins;
      },
      cancel: async (id) => {
        log.push(`coin.cancel ${id}`);
        return CoinIntentStatus.Canceled;
      },
    },
    account: { signIn: () => log.push("sign-in") },
    openPage: (url) => log.push(`open ${url}`),
    web: WEB,
    clock,
    push: (shown) => pushed.push(shown),
  });
  const last = () => pushed.at(-1) ?? null;
  const answer = (value: PurchaseAnswer, number = last()?.sheet ?? 0) => sheet.answer({ sheet: number, answer: value });
  return { sheet, log, pushed, last, answer, advance };
}

type Rig = ReturnType<typeof rig>;

/** Let every awaited call of a buy settle: the start, the read back, the balance. */
async function settleAll(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) await settle();
}

/** A buy that has opened its sheet: `done` answers once it closes (wrapped, so awaiting this does not wait for it). */
async function opened(made: Rig, itemId = "sku1", slug = "stick-steel"): Promise<{ done: Promise<StoreBuyResult> }> {
  const done = made.sheet.buy(itemId, slug);
  await settleAll();
  return { done };
}

/** The page shows Ask, and the arm delay passes. */
function arm(made: Rig): void {
  made.answer(PurchaseAnswer.Shown);
  made.advance(PURCHASE_ARM_MS);
}

describe("Buying from a game's page", () => {
  it("starts the purchase for the game whose page it is and shows Play's sheet for it", async () => {
    const made = rig();
    const { done: result } = await opened(made);
    assert.deepEqual(made.log.slice(0, 2).sort(), ["purchase sku1 stick-steel", "world stick-steel"]);
    assert.deepEqual(made.last(), {
      sheet: 1,
      step: PurchaseStep.Ask,
      problem: null,
      recovery: null,
      armed: false,
      game: { title: "Stick & Steel", coverUrl: null },
      item: { name: "Legendary Sword", description: null, imageUrl: null, quantity: 1, unitPriceCoins: 50_000 },
      price: { coins: 50_000, usdCents: 50_000 },
      balance: WALLET,
      itemId: "sku1",
      slug: "stick-steel",
    });
    made.answer(PurchaseAnswer.Cancel);
    assert.deepEqual(await result, { outcome: StoreBuyOutcome.NotPaid });
  });

  it("pays only once the page has shown Ask for the arm delay, then answers Paid when the sheet closes", async () => {
    const made = rig();
    const { done: result } = await opened(made);
    made.answer(PurchaseAnswer.Pay);
    made.answer(PurchaseAnswer.Shown);
    made.answer(PurchaseAnswer.Pay);
    assert.ok(!made.log.some((line) => line.startsWith("coin.confirm")), "Pay before the arm delay counts for nothing");
    made.advance(PURCHASE_ARM_MS);
    made.answer(PurchaseAnswer.Pay);
    await settle();
    assert.ok(made.log.includes("coin.confirm int1"));
    assert.equal(made.last()?.step, PurchaseStep.Paid);
    assert.equal(made.last()?.balance, WALLET - 50_000);
    made.answer(PurchaseAnswer.Back);
    assert.equal(made.last(), null, "the sheet goes away");
    assert.deepEqual(await result, { outcome: StoreBuyOutcome.Paid });
  });

  it("cancels the purchase it started when the player closes the sheet unpaid", async () => {
    const made = rig();
    const { done: result } = await opened(made);
    made.answer(PurchaseAnswer.Cancel);
    await settle();
    assert.ok(made.log.includes("coin.cancel int1"));
    assert.deepEqual(await result, { outcome: StoreBuyOutcome.NotPaid });
  });

  it("shows Not enough coin when the balance is short, and Get Nex opens genex.games' coin page", async () => {
    const made = rig({ balance: 12_450 });
    const { done: result } = await opened(made);
    assert.deepEqual([made.last()?.step, made.last()?.recovery], [PurchaseStep.NotEnough, PurchaseRecovery.Waiting]);
    made.answer(PurchaseAnswer.GetCoin);
    assert.ok(made.log.includes(`open ${playCoinPageUrl(WEB)}`));
    made.answer(PurchaseAnswer.Cancel);
    assert.deepEqual(await result, { outcome: StoreBuyOutcome.NotPaid });
  });
});

describe("A short sheet and coin on hold", () => {
  const held = { coins: 7500, releaseAt: Date.parse("2026-10-30T12:00:00.000Z") };

  it("carries the earned coin still on hold, and when it is ready", async () => {
    const made = rig({ balance: 12_450, held });
    await opened(made);
    assert.equal(made.last()?.step, PurchaseStep.NotEnough);
    assert.deepEqual(made.last()?.held, held);
    made.answer(PurchaseAnswer.Cancel);
  });

  it("carries nothing when no coin is on hold", async () => {
    const made = rig({ balance: 12_450, held: null });
    await opened(made);
    assert.equal(made.last()?.step, PurchaseStep.NotEnough);
    assert.equal(made.last() && "held" in made.last()!, false);
    made.answer(PurchaseAnswer.Cancel);
  });
});

describe("Buying from a game's page, when it does not go as asked", () => {
  it("answers a refusal before any sheet, by its code", async () => {
    for (const code of [StoreRefusal.AlreadyOwned, StoreRefusal.NotSoldHere, StoreRefusal.Unauthorized]) {
      const made = rig({ started: { refused: code } });
      assert.deepEqual(await made.sheet.buy("sku1", "stick-steel"), { refused: code });
      assert.deepEqual(made.pushed, [], code);
    }
  });

  it("shows no sheet for a purchase of another game, or one already moving, and cancels it", async () => {
    for (const started of [
      { ...INTENT, projectId: "proj-other" },
      { ...INTENT, status: CoinIntentStatus.Processing },
    ]) {
      const made = rig({ started });
      assert.deepEqual(await made.sheet.buy("sku1", "stick-steel"), { outcome: StoreBuyOutcome.NotShown });
      assert.deepEqual(made.pushed, []);
      await settle();
      assert.ok(made.log.includes("coin.cancel int1"));
    }
  });

  it("answers Not shown at once when the purchase cannot be read back", async () => {
    const made = rig({ read: new Error("offline") });
    const result = made.sheet.buy("sku1", "stick-steel");
    await settleAll();
    assert.deepEqual(await result, { outcome: StoreBuyOutcome.NotShown });
    assert.deepEqual(made.pushed, []);
  });

  it("gives up waiting for a sheet that never opens, and cancels its purchase", async () => {
    const made = rig({ read: "hangs" });
    const result = made.sheet.buy("sku1", "stick-steel");
    await settleAll();
    made.advance(STORE_SHEET_OPEN_MS - 1);
    await settle();
    assert.deepEqual(made.pushed, []);
    made.advance(1);
    assert.deepEqual(await result, { outcome: StoreBuyOutcome.NotShown });
    await settle();
    assert.ok(made.log.includes("coin.cancel int1"));
  });

  it("refuses a second purchase while the first is still being started", async () => {
    const made = rig();
    const first = made.sheet.buy("sku1", "stick-steel");
    await assert.rejects(made.sheet.buy("sku2", "stick-steel"));
    await settleAll();
    assert.equal(made.log.filter((line) => line.startsWith("purchase")).length, 1);
    made.answer(PurchaseAnswer.Cancel);
    assert.deepEqual(await first, { outcome: StoreBuyOutcome.NotPaid });
  });

  it("opens the next purchase at once after a sheet closes, with no wait", async () => {
    const made = rig();
    const { done: first } = await opened(made);
    made.answer(PurchaseAnswer.Cancel);
    await first;
    const { done: second } = await opened(made, "sku2");
    assert.equal(made.last()?.step, PurchaseStep.Ask, "no wait after the player closed a sheet");
    assert.equal(made.last()?.itemId, "sku2");
    made.answer(PurchaseAnswer.Cancel);
    assert.deepEqual(await second, { outcome: StoreBuyOutcome.NotPaid });
  });

  it("lets a sheet left open (its page reloaded) give way to the next purchase, canceling it unpaid", async () => {
    const made = rig();
    const { done: first } = await opened(made);
    const { done: second } = await opened(made, "sku2");
    assert.deepEqual(await first, { outcome: StoreBuyOutcome.NotPaid });
    assert.ok(made.log.includes("coin.cancel int1"));
    assert.equal(made.last()?.itemId, "sku2");
    made.answer(PurchaseAnswer.Cancel);
    await second;
  });

  it("drops an answer meant for an earlier sheet, and one that is not an answer", async () => {
    const made = rig();
    const { done: result } = await opened(made);
    arm(made);
    made.answer(PurchaseAnswer.Pay, 99);
    made.sheet.answer({ sheet: 1, answer: "pay-twice" });
    made.sheet.answer("pay");
    assert.ok(!made.log.some((line) => line.startsWith("coin.confirm")));
    made.answer(PurchaseAnswer.Cancel);
    await result;
  });

  it("never asks genex.games about an item or a game that is not one", async () => {
    const made = rig();
    await assert.rejects(made.sheet.buy("../sku", "stick-steel"));
    await assert.rejects(made.sheet.buy("sku1", "Stick Steel"));
    assert.deepEqual(made.log, []);
  });

  it("cancels an unpaid purchase when the studio window goes away", async () => {
    const made = rig();
    const { done: result } = await opened(made);
    made.sheet.drop();
    await settle();
    assert.ok(made.log.includes("coin.cancel int1"));
    assert.equal(made.last(), null);
    assert.deepEqual(await result, { outcome: StoreBuyOutcome.NotPaid });
  });
});

/** The studio window's events, as `followStudioWindow` listens to them: `emit` plays one. */
function studioWindow() {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const on = (event: string, listener: (...args: unknown[]) => void) => {
    listeners.set(event, [...(listeners.get(event) ?? []), listener]);
  };
  const emit = (event: string, ...args: unknown[]) => {
    for (const listener of listeners.get(event) ?? []) listener(...args);
  };
  return { win: { on, webContents: { on } }, emit };
}

describe("The studio window around a store sheet", () => {
  it("makes an armed Pay wait again when the window loses or regains focus", async () => {
    for (const event of ["blur", "focus"]) {
      const made = rig();
      const studio = studioWindow();
      followStudioWindow(studio.win, made.sheet);
      const { done: result } = await opened(made);
      arm(made);
      assert.equal(made.last()?.armed, true);
      studio.emit(event);
      assert.equal(made.last()?.armed, false, `${event}: Pay waits again`);
      made.answer(PurchaseAnswer.Pay);
      await settle();
      assert.ok(
        !made.log.some((line) => line.startsWith("coin.confirm")),
        `${event}: a click bringing it back never pays`,
      );
      made.advance(PURCHASE_ARM_MS);
      made.answer(PurchaseAnswer.Pay);
      await settle();
      assert.ok(made.log.includes("coin.confirm int1"), `${event}: Pay counts once it armed again`);
      made.answer(PurchaseAnswer.Back);
      assert.deepEqual(await result, { outcome: StoreBuyOutcome.Paid });
    }
  });

  it("takes the sheet away and cancels its unpaid purchase when the page reloads, dies or the window closes", async () => {
    const goes: Array<[string, unknown[]]> = [
      ["did-start-navigation", [{}, "file:///index.html", false, true]],
      ["render-process-gone", [{}, { reason: "crashed" }]],
      ["closed", []],
    ];
    for (const [event, args] of goes) {
      const made = rig();
      const studio = studioWindow();
      followStudioWindow(studio.win, made.sheet);
      const { done: result } = await opened(made);
      studio.emit(event, ...args);
      await settle();
      assert.ok(made.log.includes("coin.cancel int1"), event);
      assert.equal(made.last(), null, `${event}: the sheet goes`);
      assert.deepEqual(await result, { outcome: StoreBuyOutcome.NotPaid }, event);
    }
  });

  it("keeps the sheet when only a frame inside the page navigates, or the page moves within itself", async () => {
    for (const args of [
      [{}, "about:blank", false, false],
      [{}, "file:///index.html#play", true, true],
    ]) {
      const made = rig();
      const studio = studioWindow();
      followStudioWindow(studio.win, made.sheet);
      const { done: result } = await opened(made);
      studio.emit("did-start-navigation", ...args);
      await settle();
      assert.ok(!made.log.includes("coin.cancel int1"));
      assert.equal(made.last()?.step, PurchaseStep.Ask);
      made.answer(PurchaseAnswer.Cancel);
      await result;
    }
  });
});
