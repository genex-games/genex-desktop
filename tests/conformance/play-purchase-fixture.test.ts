/**
 * Coin in a fixture launch: the stand-in game asks for a purchase from a button (or a key) per case,
 * as the embed SDK does, and the launch answers genex.games' coin routes itself, so an owned
 * `studio:dev` fixture profile shows every state of Play's purchase sheet with no socket. The page's
 * own opens are judged by Play's real capture rule, and every answer is read through the real coin
 * client.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import vm from "node:vm";
import {
  createFixtureCoin,
  FIXTURE_BALANCE,
  FIXTURE_CONFIRM_ORIGIN,
  FIXTURE_EXPIRE_MS,
  FIXTURE_INTENT_TTL_MS,
  FIXTURE_SLOW_MS,
  FIXTURE_TOP_UP,
  FixtureCoinCase,
  fixtureIntentId,
} from "../../src/main/dev/fixture-coin.ts";
import { FixtureAccount, fixtureAccountToken } from "../../src/main/dev/fixture-people.ts";
import { fixtureGamePage, fixtureGetCoin, fixturePlayRequest } from "../../src/main/dev/fixture-play.ts";
import {
  CoinFailure,
  CoinIntentStatus,
  CoinRefused,
  CoinRoute,
  ConfirmSurface,
  PaymentPolicy,
  playCoin,
} from "../../src/main/play/coin.ts";
import { GalleryError, type GalleryRequest, isRecord, PlayRoute } from "../../src/main/play/gallery.ts";
import { classifyGameOpen, confirmIntentId, GameOpen } from "../../src/main/play/purchase-address.ts";
import {
  PURCHASE_COOLDOWN_MS,
  PURCHASE_EXPIRY_GRACE_MS,
  PURCHASE_RECHECK_MS,
  PURCHASE_SETTLE_POLL_MS,
} from "../../src/main/play/viewer-purchase.ts";
import {
  PURCHASE_ARM_MS,
  PurchaseAnswer,
  PurchaseProblem,
  PurchaseRecovery,
  PurchaseStep,
} from "../../src/shared/play-purchase.ts";
import { rig, settle, WORLD } from "../helpers/play-viewer-rig.ts";

const FULL = fixtureAccountToken(FixtureAccount.Full);
const SLUG = "lost-cathedral";
const CASES = Object.values(FixtureCoinCase);

/** A window the stand-in page opened, and the popup it got back. */
interface Opened {
  url: string;
  frameName: string;
  features: string;
  popup: { opener: unknown; closed: boolean; location: { href: string } };
}

/** An element of the fake page: its data, its words, its children and what it listens to. */
interface FakeElement {
  dataset: Record<string, string>;
  textContent: string;
  children: FakeElement[];
  listeners: Map<string, (event: unknown) => void>;
  append(...children: FakeElement[]): void;
  addEventListener(type: string, listener: (event: unknown) => void): void;
}

function fakeElement(): FakeElement {
  const element: FakeElement = {
    dataset: {},
    textContent: "",
    children: [],
    listeners: new Map(),
    append: (...children) => {
      element.children.push(...children);
    },
    addEventListener: (type, listener) => {
      element.listeners.set(type, listener);
    },
  };
  return element;
}

/** Whatever the stand-in's sky asks of its canvas: it draws, and nothing of it is checked. */
const anything: unknown = new Proxy(() => anything, { get: () => anything, apply: () => anything, set: () => true });

/** The stand-in page for `slug`, every script of it run against a fake page that records what it opens. */
function stagedPage(slug: string) {
  const page = fixtureGamePage(slug);
  const html = decodeURIComponent(page.slice(page.indexOf(",") + 1));
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1] ?? "");
  const opened: Opened[] = [];
  const timers: (() => void)[] = [];
  const listeners = new Map<string, (event: unknown) => void>();
  const body = fakeElement();
  const document = {
    body,
    getElementById: () => ({ getContext: () => anything }),
    createElement: fakeElement,
    addEventListener: (type: string, listener: (event: unknown) => void) => listeners.set(type, listener),
  };
  const window = {
    open: (url: string, frameName: string, features: string) => {
      const popup = { opener: {}, closed: false, location: { href: url } };
      opened.push({ url, frameName, features, popup });
      return popup;
    },
  };
  const context = vm.createContext({
    document,
    window,
    innerWidth: 1280,
    innerHeight: 720,
    requestAnimationFrame: () => 0,
    setTimeout: (run: () => void) => timers.push(run),
  });
  for (const script of scripts) vm.runInContext(script, context);
  const buttons = (): FakeElement[] => body.children.flatMap((child) => child.children);
  return {
    opened,
    buttons,
    press(kase: string): void {
      const button = buttons().find((candidate) => candidate.dataset.fixtureBuy === kase);
      assert.ok(button, `a button for ${kase}`);
      button.listeners.get("click")?.({});
    },
    key(key: string, repeat = false): void {
      listeners.get("keydown")?.({ key, repeat });
    },
    /** The replayed SDK's payment is made: a reserved popup is pointed at its confirm page. */
    settle(): void {
      for (const run of timers.splice(0)) run();
    },
  };
}
type StagedPage = ReturnType<typeof stagedPage>;

/** What Play makes of an open from the stand-in game: its capture rule, on a `data:` page (an opaque origin). */
const verdictOf = (open: Opened) =>
  classifyGameOpen(
    { ...open, disposition: "new-window", referrer: { url: "" } },
    { confirmOrigin: FIXTURE_CONFIRM_ORIGIN, gameOrigin: "null" },
  );

/** The purchase the page's one open asked for, as Play's capture hears it; and which SDK call opened it. */
function askedFor(page: StagedPage): { id: string; how: GameOpen } {
  assert.equal(page.opened.length, 1, "one open per ask");
  const [open] = page.opened;
  assert.ok(open);
  const verdict = verdictOf(open);
  if (verdict.kind === GameOpen.Confirm) {
    assert.equal(open.frameName, `genex_confirm_${verdict.intentId}`);
    return { id: verdict.intentId, how: verdict.kind };
  }
  assert.equal(verdict.kind, GameOpen.Reserve, `${open.url} is reserved`);
  assert.equal(open.popup.opener, null, "the SDK gives its reserved popup's opener up");
  page.settle();
  const id = confirmIntentId(open.popup.location.href, FIXTURE_CONFIRM_ORIGIN);
  assert.ok(id, `${open.popup.location.href} is a confirm page`);
  return { id, how: verdict.kind };
}

/** The coin client of the launch itself, signed in as the full fixture account. */
const launchCoin = playCoin({
  request: fixturePlayRequest,
  token: async () => FULL,
  now: Date.now,
  localImages: true,
});

describe("Coin in a fixture launch", () => {
  it("the stand-in game asks for each case as the embed SDK does, and Play takes it for that game", async () => {
    const world = await fixturePlayRequest(PlayRoute.world(SLUG), { method: "GET" });
    const item = isRecord(world.body) && isRecord(world.body.item) ? world.body.item : {};
    const hows = new Set<GameOpen>();
    for (const kase of CASES) {
      const page = stagedPage(SLUG);
      page.press(kase);
      const { id, how } = askedFor(page);
      hows.add(how);
      const intent = await launchCoin.intent(id);
      assert.equal(intent.projectId, item.id, kase);
      assert.equal(intent.status, CoinIntentStatus.RequiresConfirmation, kase);
    }
    // Both of the SDK's ways: `buy()` opens the confirm page at once, `requestPayment()` reserves first.
    assert.deepEqual([...hows].sort(), [GameOpen.Confirm, GameOpen.Reserve]);
  });

  it("a key asks as its button does, each ask is a new purchase, and a held key asks nothing more", async () => {
    const byButton = stagedPage(SLUG);
    const first = byButton.buttons()[0]?.dataset.fixtureBuy;
    assert.ok(first);
    byButton.press(first);
    const pressed = await launchCoin.intent(askedFor(byButton).id);
    const byKey = stagedPage(SLUG);
    byKey.key("1");
    const keyed = await launchCoin.intent(askedFor(byKey).id);
    assert.equal(keyed.name, pressed.name);
    assert.notEqual(keyed.id, pressed.id);
    const held = stagedPage(SLUG);
    held.key("1", true);
    held.key("x");
    held.key("");
    assert.deepEqual(held.opened, []);
  });

  it("signed out, or with a token genex.games refused, every coin route is refused", async () => {
    const id = fixtureIntentId(FixtureCoinCase.Ask, "1", SLUG);
    const calls = [
      { route: CoinRoute.Balance, method: "GET" },
      { route: CoinRoute.intent(id), method: "GET" },
      { route: CoinRoute.confirm(id), method: "POST" },
      { route: CoinRoute.cancel(id), method: "POST" },
    ] as const;
    for (const token of [undefined, fixtureAccountToken(FixtureAccount.Ended)])
      for (const { route, method } of calls) {
        const answer = await fixturePlayRequest(route, { method, token });
        assert.equal(answer.status, 401, `${method} ${route} as ${token}`);
      }
    const confirm = await fixturePlayRequest(CoinRoute.confirm(id), { method: "POST" });
    assert.deepEqual(confirm.body, { error: CoinFailure.ConfirmRequiresSession });
  });

  it("the fixture account holds 1,240 coin, and Get coin adds some as though bought on genex.games", async () => {
    assert.equal(FIXTURE_BALANCE, 1240);
    assert.equal(await launchCoin.balance(), FIXTURE_BALANCE);
    fixtureGetCoin();
    assert.equal(await launchCoin.balance(), FIXTURE_BALANCE + FIXTURE_TOP_UP);
  });

  it("confirms on a website that resolves nowhere, so nothing the page opens could reach genex.games", () => {
    const origin = new URL(FIXTURE_CONFIRM_ORIGIN);
    assert.equal(origin.protocol, "https:");
    assert.match(origin.hostname, /\.invalid$/);
    assert.equal(origin.origin, FIXTURE_CONFIRM_ORIGIN);
  });
});

const NOW = Date.parse("2026-10-19T12:00:00.000Z");
const GAME = { id: "fx0042", title: "Moon Base" };
const GAME_SLUG = "moon-base";

/** One launch's coin on a clock the test moves, for the game `moon-base`, read by the real coin client. */
function coinRig() {
  const clock = { now: NOW };
  const coin = createFixtureCoin({ now: () => clock.now, project: (slug) => (slug === GAME_SLUG ? GAME : null) });
  const request: GalleryRequest = async (route, init) => coin.answer(route, init) ?? { status: 404, body: null };
  const client = playCoin({ request, token: async () => FULL, now: () => clock.now, localImages: true });
  const id = (kase: FixtureCoinCase, nonce = "1"): string => fixtureIntentId(kase, nonce, GAME_SLUG);
  return { clock, coin, request, client, id };
}

/** `run` rejects with genex.games' refusal `code` at HTTP `status`. */
async function refused(run: Promise<unknown>, code: CoinFailure, status: number): Promise<void> {
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof CoinRefused, String(error));
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    return true;
  });
}

describe("What each fixture case sells", () => {
  it("a purchase is made the first time Studio reads it, for its game, open to pay as long as genex.games keeps one", async () => {
    const { clock, client, id } = coinRig();
    const intent = await client.intent(id(FixtureCoinCase.Ask));
    assert.equal(intent.status, CoinIntentStatus.RequiresConfirmation);
    assert.equal(intent.projectId, GAME.id);
    assert.equal(intent.dynamic, false);
    assert.equal(intent.totalCoins, 75);
    assert.equal(intent.usdCents, 75);
    assert.match(intent.iconUrl ?? "", /^data:image\/svg\+xml;/);
    assert.equal(intent.expiresAt, NOW + FIXTURE_INTENT_TTL_MS);
    clock.now += FIXTURE_INTENT_TTL_MS;
    assert.equal((await client.intent(id(FixtureCoinCase.Ask))).status, CoinIntentStatus.Expired);
  });

  it("covers several of one item, a payment the game priced with no picture, and the longest words a game may write", async () => {
    const { client, id } = coinRig();
    const many = await client.intent(id(FixtureCoinCase.Many));
    assert.equal(many.quantity, 5);
    assert.equal(many.totalCoins, many.quantity * many.unitPriceCoins);
    const bare = await client.intent(id(FixtureCoinCase.NoImage));
    assert.equal(bare.dynamic, true);
    assert.equal(bare.iconUrl, null);
    assert.ok(bare.description);
    const long = await client.intent(id(FixtureCoinCase.Long));
    assert.equal(long.name.length, 80);
    assert.equal(long.description?.length, 1000);
  });

  it("Pay takes the coin once; paying again answers paid and takes nothing more", async () => {
    const { client, id } = coinRig();
    const intent = await client.intent(id(FixtureCoinCase.Ask));
    await client.confirm(intent);
    assert.equal((await client.intent(intent.id)).status, CoinIntentStatus.Succeeded);
    assert.equal(await client.balance(), FIXTURE_BALANCE - 75);
    await client.confirm(intent);
    assert.equal(await client.balance(), FIXTURE_BALANCE - 75);
  });

  it("a payment the game priced is paid only with its terms named, and only on a surface genex.games knows", async () => {
    const { request, client, id } = coinRig();
    const intent = await client.intent(id(FixtureCoinCase.NoImage));
    const confirm = (body: unknown) => request(CoinRoute.confirm(intent.id), { method: "POST", token: FULL, body });
    const bare = await confirm({ confirmSurface: ConfirmSurface.NativeModal });
    assert.deepEqual(bare, { status: 409, body: { error: CoinFailure.PaymentConfirmationRequired } });
    const nowhere = await confirm({ confirmSurface: "dashboard", paymentPolicy: PaymentPolicy.DynamicV1 });
    assert.equal(nowhere.status, 400);
    assert.equal(await client.balance(), FIXTURE_BALANCE);
    await client.confirm(intent);
    assert.equal(await client.balance(), FIXTURE_BALANCE - intent.totalCoins);
  });
});

describe("How genex.games answers a fixture case's Pay", () => {
  it("poor: costs more than the balance, until Get coin tops it up", async () => {
    const { coin, client, id } = coinRig();
    const poor = await client.intent(id(FixtureCoinCase.Poor));
    assert.ok(poor.totalCoins > (await client.balance()));
    coin.topUp();
    assert.equal(await client.balance(), FIXTURE_BALANCE + FIXTURE_TOP_UP);
    await client.confirm(poor);
    assert.equal(await client.balance(), FIXTURE_BALANCE + FIXTURE_TOP_UP - poor.totalCoins);
    // A new one is still short of what is left.
    const again = await client.intent(id(FixtureCoinCase.Poor, "2"));
    assert.ok(again.totalCoins > (await client.balance()));
  });

  it("short: genex.games refuses Pay for want of coin and ends the purchase, taking nothing", async () => {
    const { client, id } = coinRig();
    const intent = await client.intent(id(FixtureCoinCase.Short));
    await refused(client.confirm(intent), CoinFailure.InsufficientBalance, 402);
    const after = await client.intent(intent.id);
    assert.equal(after.status, CoinIntentStatus.Failed);
    assert.equal(after.failure, CoinFailure.InsufficientBalance);
    assert.equal(await client.balance(), FIXTURE_BALANCE);
  });

  it("slow: genex.games does not answer Pay, and the payment lands a few seconds later", async () => {
    const { clock, client, id } = coinRig();
    const intent = await client.intent(id(FixtureCoinCase.Slow));
    await assert.rejects(client.confirm(intent), (error: unknown) => {
      assert.ok(error instanceof GalleryError && !(error instanceof CoinRefused), String(error));
      return true;
    });
    assert.equal((await client.intent(intent.id)).status, CoinIntentStatus.Processing);
    assert.equal(await client.balance(), FIXTURE_BALANCE);
    clock.now += FIXTURE_SLOW_MS;
    assert.equal((await client.intent(intent.id)).status, CoinIntentStatus.Succeeded);
    assert.equal(await client.balance(), FIXTURE_BALANCE - intent.totalCoins);
  });

  it("refuse and canceled: a refusal leaves the purchase open; one canceled elsewhere reads canceled", async () => {
    const { client, id } = coinRig();
    const refuse = await client.intent(id(FixtureCoinCase.Refuse));
    await refused(client.confirm(refuse), CoinFailure.SurfaceCap, 403);
    assert.equal((await client.intent(refuse.id)).status, CoinIntentStatus.RequiresConfirmation);
    const gone = await client.intent(id(FixtureCoinCase.Canceled));
    await refused(client.confirm(gone), CoinFailure.IntentNotPending, 409);
    assert.equal((await client.intent(gone.id)).status, CoinIntentStatus.Canceled);
    assert.equal(await client.balance(), FIXTURE_BALANCE);
  });

  it("expire: lapses seconds after it is made, and Pay then answers that it expired", async () => {
    const { clock, client, id } = coinRig();
    const intent = await client.intent(id(FixtureCoinCase.Expire));
    assert.equal(intent.expiresAt, NOW + FIXTURE_EXPIRE_MS);
    clock.now += FIXTURE_EXPIRE_MS;
    assert.equal((await client.intent(intent.id)).status, CoinIntentStatus.Expired);
    await refused(client.confirm(intent), CoinFailure.IntentExpired, 409);
    assert.equal(await client.balance(), FIXTURE_BALANCE);
  });

  it("Cancel ends a purchase still open to pay, and answers paid for one already paid", async () => {
    const { client, id } = coinRig();
    const open = await client.intent(id(FixtureCoinCase.Ask, "1"));
    assert.equal(await client.cancel(open.id), CoinIntentStatus.Canceled);
    await refused(client.confirm(open), CoinFailure.IntentNotPending, 409);
    const bought = await client.intent(id(FixtureCoinCase.Ask, "2"));
    await client.confirm(bought);
    assert.equal(await client.cancel(bought.id), CoinIntentStatus.Succeeded);
    assert.equal(await client.balance(), FIXTURE_BALANCE - bought.totalCoins);
  });
});

describe("What the fixture's coin answers at all", () => {
  it("answers no purchase for an id that is not a fixture case of a fixture game, and takes no coin for it", async () => {
    const { request } = coinRig();
    const hostile = [
      "fx-ask-1--nowhere",
      "fx-nope-1--moon-base",
      "fx-toString-1--moon-base",
      "fx-constructor-1--moon-base",
      "fx-__proto__-1--moon-base",
      "fx-ASK-1--moon-base",
      "fx-ask--moon-base",
      "fx-ask-1-moon-base",
      "fx-ask-1--",
      "fx-ask-1--Moon-Base",
      "fx-ask-1--moon-base--x",
      "fx-ask-1--moon-base/..",
      "ask-1--moon-base",
      "",
    ];
    for (const raw of hostile) {
      const read = await request(CoinRoute.intent(raw), { method: "GET", token: FULL });
      assert.equal(read.status, 404, `read ${raw}`);
      const body = { confirmSurface: ConfirmSurface.NativeModal, paymentPolicy: PaymentPolicy.DynamicV1 };
      const confirm = await request(CoinRoute.confirm(raw), { method: "POST", token: FULL, body });
      assert.equal(confirm.status, 404, `confirm ${raw}`);
      const cancel = await request(CoinRoute.cancel(raw), { method: "POST", token: FULL });
      assert.equal(cancel.status, 404, `cancel ${raw}`);
    }
    const balance = await request(CoinRoute.Balance, { method: "GET", token: FULL });
    assert.equal(isRecord(balance.body) ? balance.body.spendable : null, FIXTURE_BALANCE);
  });

  it("answers only genex.games' coin routes, each by its own method", async () => {
    const { coin, id } = coinRig();
    const known = id(FixtureCoinCase.Ask);
    assert.equal(coin.answer(PlayRoute.world(GAME_SLUG), { method: "GET", token: FULL }), null);
    assert.equal(coin.answer(`${CoinRoute.intent(known)}/refund`, { method: "POST", token: FULL })?.status, 404);
    assert.equal(coin.answer(CoinRoute.confirm(known), { method: "GET", token: FULL })?.status, 404);
    assert.equal(coin.answer(CoinRoute.intent(known), { method: "DELETE", token: FULL })?.status, 404);
    assert.equal(coin.answer(CoinRoute.Balance, { method: "POST", token: FULL })?.status, 404);
  });
});

/**
 * Play's viewer playing Lost Cathedral over one launch's fixture coin, read by the real coin client on
 * the viewer's own clock: the sheet as a fixture profile shows it. Get coin and Sign in are wired as a
 * fixture launch wires them (`topUp`, the fixture sign-in's account).
 */
async function playingOnFixture(signedIn = true) {
  let clockNow = (): number => 0;
  let token: string | undefined = signedIn ? FULL : undefined;
  const game = { id: WORLD.id, title: WORLD.title };
  const fixture = createFixtureCoin({ now: () => clockNow(), project: (slug) => (slug === WORLD.slug ? game : null) });
  const request: GalleryRequest = async (route, init) => fixture.answer(route, init) ?? { status: 404, body: null };
  const coin = playCoin({ request, token: async () => token, now: () => clockNow(), localImages: true });
  const made = rig({ coin });
  clockNow = made.now;
  made.viewer.open(WORLD.slug, WORLD.title);
  await settle();
  made.viewer.loaded();
  const answer = (value: PurchaseAnswer): void =>
    made.viewer.answerPurchase({ sheet: made.sheet()?.sheet ?? 0, answer: value });
  return {
    ...made,
    fixture,
    answer,
    signIn: (): void => {
      token = FULL;
    },
    /** The stand-in game asks for `kase`'s purchase, and the viewer reads it. */
    ask: async (kase: FixtureCoinCase): Promise<void> => {
      made.viewer.purchase(fixtureIntentId(kase, "1", WORLD.slug));
      await settle();
    },
    /** The page shows Ask, the arm delay passes, and Pay is pressed. */
    pay: async (): Promise<void> => {
      answer(PurchaseAnswer.Shown);
      made.advance(PURCHASE_ARM_MS);
      answer(PurchaseAnswer.Pay);
      await settle();
    },
    /** Time passes, and what it set off settles. */
    wait: async (ms: number): Promise<void> => {
      made.advance(ms);
      await settle();
    },
    face: () => {
      const sheet = made.sheet();
      return sheet && { step: sheet.step, problem: sheet.problem, recovery: sheet.recovery };
    },
  };
}

const STEP = (step: PurchaseStep) => ({ step, problem: null, recovery: null });
const FAILED = (problem: PurchaseProblem) => ({ step: PurchaseStep.Failed, problem, recovery: null });
const NOT_ENOUGH = (recovery: PurchaseRecovery) => ({ step: PurchaseStep.NotEnough, problem: null, recovery });
const SIGNED_OUT = (recovery: PurchaseRecovery) => ({ step: PurchaseStep.SignedOut, problem: null, recovery });

describe("Every state of the purchase sheet, from the fixture's cases", () => {
  it("ask, many and noimage: Ask with the item as sold, then Paid with what is left", async () => {
    const made = await playingOnFixture();
    await made.ask(FixtureCoinCase.Ask);
    assert.deepEqual(made.face(), STEP(PurchaseStep.Ask));
    assert.match(made.sheet()?.item?.imageUrl ?? "", /^data:image\/svg\+xml;/);
    await made.pay();
    assert.deepEqual(made.face(), STEP(PurchaseStep.Paid));
    assert.equal(made.sheet()?.balance, FIXTURE_BALANCE - 75);
    made.answer(PurchaseAnswer.Back);
    await made.wait(PURCHASE_COOLDOWN_MS);
    await made.ask(FixtureCoinCase.Many);
    assert.equal(made.sheet()?.item?.quantity, 5);
    made.answer(PurchaseAnswer.Cancel);
    await made.wait(PURCHASE_COOLDOWN_MS);
    await made.ask(FixtureCoinCase.NoImage);
    assert.deepEqual(made.face(), STEP(PurchaseStep.Ask));
    assert.equal(made.sheet()?.item?.imageUrl, null);
  });

  it("poor: Not enough coin; Get coin tops the balance up, and Review brings Ask back", async () => {
    const made = await playingOnFixture();
    await made.ask(FixtureCoinCase.Poor);
    assert.deepEqual(made.face(), NOT_ENOUGH(PurchaseRecovery.Waiting));
    made.answer(PurchaseAnswer.GetCoin);
    assert.equal(made.pages.length, 1);
    made.fixture.topUp();
    await made.wait(PURCHASE_RECHECK_MS);
    assert.deepEqual(made.face(), NOT_ENOUGH(PurchaseRecovery.Ready));
    made.answer(PurchaseAnswer.Review);
    assert.deepEqual(made.face(), STEP(PurchaseStep.Ask));
  });

  it("short, refuse and canceled: how a refused Pay ends", async () => {
    const outcomes = [
      [FixtureCoinCase.Short, NOT_ENOUGH(PurchaseRecovery.Over)],
      [FixtureCoinCase.Refuse, FAILED(PurchaseProblem.Refused)],
      [FixtureCoinCase.Canceled, FAILED(PurchaseProblem.Canceled)],
    ] as const;
    for (const [kase, face] of outcomes) {
      const made = await playingOnFixture();
      await made.ask(kase);
      await made.pay();
      await settle();
      assert.deepEqual(made.face(), face, kase);
    }
  });

  it("slow: Pending while genex.games has not answered, then Paid once the payment lands", async () => {
    const made = await playingOnFixture();
    await made.ask(FixtureCoinCase.Slow);
    await made.pay();
    assert.deepEqual(made.face(), STEP(PurchaseStep.Pending));
    await made.wait(PURCHASE_SETTLE_POLL_MS);
    assert.deepEqual(made.face(), STEP(PurchaseStep.Pending));
    await made.wait(FIXTURE_SLOW_MS);
    assert.deepEqual(made.face(), STEP(PurchaseStep.Paid));
  });

  it("expire: timed out once its few seconds pass", async () => {
    const made = await playingOnFixture();
    await made.ask(FixtureCoinCase.Expire);
    assert.deepEqual(made.face(), STEP(PurchaseStep.Ask));
    await made.wait(FIXTURE_EXPIRE_MS + PURCHASE_EXPIRY_GRACE_MS);
    assert.deepEqual(made.face(), FAILED(PurchaseProblem.Expired));
  });

  it("signed out: Sign in, then Review once the account can read the purchase", async () => {
    const made = await playingOnFixture(false);
    await made.ask(FixtureCoinCase.Ask);
    assert.deepEqual(made.face(), SIGNED_OUT(PurchaseRecovery.Waiting));
    assert.equal(made.sheet()?.item, null);
    made.answer(PurchaseAnswer.SignIn);
    made.signIn();
    await made.wait(PURCHASE_RECHECK_MS);
    await settle();
    assert.deepEqual(made.face(), SIGNED_OUT(PurchaseRecovery.Ready));
    made.answer(PurchaseAnswer.Review);
    assert.deepEqual(made.face(), STEP(PurchaseStep.Ask));
  });
});
