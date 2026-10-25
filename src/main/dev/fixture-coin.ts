/**
 * Coin in a fixture profile: a game's purchases and the account's balance answered here, in the
 * shapes genex.games serves (`play/coin.ts` reads them), so Play's purchase sheet shows every state
 * with no socket. The stand-in game (`fixture-play.ts`) asks for a purchase from a button or a key
 * per case, as the embed SDK does, on a confirm website that resolves nowhere. A purchase is made the
 * first time Studio reads it, named by its case, a nonce and the game's slug; each case is one of the
 * sheet's states: what it sells, how long it stays open, and how genex.games answers its Pay.
 */
import { DAY_MS, MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";
import { CoinFailure, CoinIntentStatus, CoinRoute, ConfirmSurface, PaymentPolicy } from "../play/coin.ts";
import { type GalleryAnswer, type GalleryRequest, isRecord } from "../play/gallery.ts";
import { takenAccount } from "./fixture-people.ts";

/**
 * Where the stand-in game's purchases are confirmed: a host that resolves nowhere (RFC 2606), so an
 * open Play failed to catch could never reach genex.games.
 */
export const FIXTURE_CONFIRM_ORIGIN = "https://confirm.genex.invalid";
/** The coin a fixture account holds when the launch starts. */
export const FIXTURE_BALANCE = 1240;
/** What Get Nex adds in a fixture launch, as though it were bought on genex.games. */
export const FIXTURE_TOP_UP = 1000;
/** How long a purchase stays open to pay: genex.games' own intent TTL. */
export const FIXTURE_INTENT_TTL_MS = 2 * MINUTE_MS;
/** How long the expire case stays open to pay. */
export const FIXTURE_EXPIRE_MS = 8 * SECOND_MS;
/** How long the slow case's payment takes to land once genex.games failed to answer its Pay. */
export const FIXTURE_SLOW_MS = 4 * SECOND_MS;
/** How much more than the balance the poor case costs. */
const POOR_BY = 35;
/** The most one purchase may cost on the surface Studio confirms on: genex.games' cap. */
const PRICE_MAX = 100_000;
/** How long the replayed `requestPayment()` takes to make its payment before it points its popup. */
const CREATE_MS = 150;
/** The window features the SDK opens its confirm popup with. */
const POPUP_FEATURES = "popup,width=420,height=640";
/** The keys that ask for each case in turn: 1 to 9, then 0. */
const CASE_KEYS = "1234567890";

/** The stand-in game's purchases, one per state of the sheet. Values name its buttons (`data-fixture-buy`). */
export const FixtureCoinCase = {
  /** One item with its picture, asked with `buy()`: Ask, then Paid. */
  Ask: "ask",
  /** Five of one item: `× 5`. */
  Many: "many",
  /** A payment the game priced (`requestPayment()`), with its terms and, as the SDK's come, no picture. */
  NoImage: "noimage",
  /** The longest name and terms a game may write. */
  Long: "long",
  /** Costs more than the balance: Not enough coin before Pay, until Get Nex tops the balance up. */
  Poor: "poor",
  /** genex.games refuses Pay for want of coin (402) and ends the purchase. */
  Short: "short",
  /** genex.games does not answer Pay (503), and the payment lands a few seconds later: Pending, then Paid. */
  Slow: "slow",
  /** genex.games refuses Pay (403, over the surface's cap): Failed, refused. */
  Refuse: "refuse",
  /** Canceled elsewhere before Pay (409): Failed, canceled. */
  Canceled: "canceled",
  /** Lapses seconds after it is made: Failed, timed out. */
  Expire: "expire",
} as const;
export type FixtureCoinCase = (typeof FixtureCoinCase)[keyof typeof FixtureCoinCase];

/** What a case sells and how long it stays open. */
interface CaseSpec {
  /** Asked with `buy()`: one of the game's items, its confirm page opened at once. Else `requestPayment()`. */
  buy: boolean;
  name: string;
  description: string | null;
  /** The hue of its drawn picture; null with none. */
  picture: number | null;
  quantity: number;
  /** One item's price, given the balance when the purchase is made. */
  unitPrice(balance: number): number;
  /** How long it stays open to pay. */
  openMs: number;
}

/** The longest name a game may give an item (80 characters). */
const LONG_NAME = "Founder's collector bundle: every skin, emote, banner and soundtrack of season 1";
/** The longest terms a game may write for its own price (1,000 characters), shown whole. */
const LONG_TERMS = [
  "The bundle stays on the account that bought it and carries over to every later season of the game, on every device you play on.",
  "Skins, emotes and banners unlock at once; the soundtrack downloads the next time the game starts, and it plays in menus and in the hub.",
  "Coin spent on the bundle is not refunded once any item in it has been used, equipped or shown to other players in a match or a lobby.",
  "Items in it cannot be traded, gifted or sold, and they stay yours if the bundle leaves the shop later; a season pass does not include it.",
  "If a match ends while the bundle is being delivered, its items arrive at the start of your next match, and nothing is charged twice for it.",
  "Prices are shown in coin; the US dollar figure beside the price is only a guide to what the coin is worth and is not what you are charged.",
  "Questions about this purchase go to the game’s maker through its page on genex.games, where its comments and its support link are.",
  "Any tax that applies is already included in the price.",
].join(" ");

const price = (coins: number) => (): number => coins;
const SPECS: Record<FixtureCoinCase, CaseSpec> = {
  [FixtureCoinCase.Ask]: {
    buy: true,
    name: "Gem pack",
    description: null,
    picture: 200,
    quantity: 1,
    unitPrice: price(75),
    openMs: FIXTURE_INTENT_TTL_MS,
  },
  [FixtureCoinCase.Many]: {
    buy: true,
    name: "Arrow bundle",
    description: null,
    picture: 30,
    quantity: 5,
    unitPrice: price(12),
    openMs: FIXTURE_INTENT_TTL_MS,
  },
  [FixtureCoinCase.NoImage]: {
    buy: false,
    name: "Extra life",
    description: "Continue from the last checkpoint with your score kept.",
    picture: null,
    quantity: 1,
    unitPrice: price(40),
    openMs: FIXTURE_INTENT_TTL_MS,
  },
  [FixtureCoinCase.Long]: {
    buy: false,
    name: LONG_NAME,
    description: LONG_TERMS,
    picture: null,
    quantity: 1,
    unitPrice: price(250),
    openMs: FIXTURE_INTENT_TTL_MS,
  },
  [FixtureCoinCase.Poor]: {
    buy: true,
    name: "Castle skin",
    description: null,
    picture: 280,
    quantity: 1,
    unitPrice: (balance) => Math.min(PRICE_MAX, balance + POOR_BY),
    openMs: FIXTURE_INTENT_TTL_MS,
  },
  [FixtureCoinCase.Short]: {
    buy: false,
    name: "Speed boost",
    description: "Twice as fast for the next three races.",
    picture: null,
    quantity: 1,
    unitPrice: price(60),
    openMs: FIXTURE_INTENT_TTL_MS,
  },
  [FixtureCoinCase.Slow]: {
    buy: true,
    name: "Gem chest",
    description: null,
    picture: 160,
    quantity: 1,
    unitPrice: price(120),
    openMs: FIXTURE_INTENT_TTL_MS,
  },
  [FixtureCoinCase.Refuse]: {
    buy: false,
    name: "Golden armour",
    description: "Shines in every arena.",
    picture: null,
    quantity: 1,
    unitPrice: price(90),
    openMs: FIXTURE_INTENT_TTL_MS,
  },
  [FixtureCoinCase.Canceled]: {
    buy: true,
    name: "Gem pack",
    description: null,
    picture: 200,
    quantity: 1,
    unitPrice: price(75),
    openMs: FIXTURE_INTENT_TTL_MS,
  },
  [FixtureCoinCase.Expire]: {
    buy: false,
    name: "Daily deal",
    description: "Today only.",
    picture: null,
    quantity: 1,
    unitPrice: price(30),
    openMs: FIXTURE_EXPIRE_MS,
  },
};

/** Every case, in the order of its button and its key. */
const CASES: readonly FixtureCoinCase[] = Object.values(FixtureCoinCase);
const CASE_NAMES: ReadonlySet<string> = new Set(CASES);
const isCase = (value: string): value is FixtureCoinCase => CASE_NAMES.has(value);
const SURFACES: ReadonlySet<unknown> = new Set(Object.values(ConfirmSurface));
/** Statuses of a purchase that was paid: Pay again answers it as it is. */
const PAID: ReadonlySet<CoinIntentStatus> = new Set([CoinIntentStatus.Succeeded, CoinIntentStatus.Consumed]);

/** A fixture purchase's id: its case, a nonce that makes each ask a new purchase, and the game's slug. */
const FIXTURE_ID = /^fx-([a-z]+)-([0-9a-z]+)--(.+)$/;

/** The id of a fixture purchase of `kase` in the game `slug`; the stand-in page makes the same. */
export const fixtureIntentId = (kase: FixtureCoinCase, nonce: string, slug: string): string =>
  `fx-${kase}-${nonce}--${slug}`;

/** The case and the game a fixture purchase's id names, or null when it names none. */
function readFixtureId(id: string): { kase: FixtureCoinCase; slug: string } | null {
  const match = FIXTURE_ID.exec(id);
  const kase = match?.[1];
  const slug = match?.[3];
  return kase !== undefined && slug !== undefined && isCase(kase) ? { kase, slug } : null;
}

/** HTTP statuses the fixture answers with. */
const HTTP = {
  Ok: 200,
  BadRequest: 400,
  Unauthorized: 401,
  PaymentRequired: 402,
  Forbidden: 403,
  NotFound: 404,
  Conflict: 409,
  Unavailable: 503,
} as const;

const ok = (body: unknown): GalleryAnswer => ({ status: HTTP.Ok, body });
const refusal = (status: number, error: CoinFailure): GalleryAnswer => ({ status, body: { error } });
const SIGNED_OUT: GalleryAnswer = { status: HTTP.Unauthorized, body: null };
const CONFIRM_SIGNED_OUT = refusal(HTTP.Unauthorized, CoinFailure.ConfirmRequiresSession);
const NOT_FOUND: GalleryAnswer = { status: HTTP.NotFound, body: null };
const NO_INTENT = refusal(HTTP.NotFound, CoinFailure.IntentNotFound);

/** The game a fixture purchase is for, as the launch's catalog has it. */
export interface FixtureCoinGame {
  id: string;
  title: string;
}

/** What the fixture's coin needs: the time, and the launch's game by its slug. */
export interface FixtureCoinDeps {
  now(): number;
  project(slug: string): FixtureCoinGame | null;
}

/** A purchase as the fixture holds it. */
interface FixtureIntent {
  id: string;
  kase: FixtureCoinCase;
  project: FixtureCoinGame;
  unitPriceCoins: number;
  status: CoinIntentStatus;
  failureCode: CoinFailure | null;
  expiresAt: number;
  /** When a payment genex.games did not answer lands; null with none under way. */
  landsAt: number | null;
}

/**
 * The fixture account's earned coin still inside genex.games' spend hold (Create › Items › Selling's
 * strip, `fixture-store.ts`): never spendable, so a short sheet says how much and until when.
 */
export const FIXTURE_EARNED_HOLD = { earnedHeld: 36_800, readyInMs: 3 * DAY_MS, holdDays: 7 } as const;

/** One launch's coin: the balance and every purchase made so far. */
interface CoinState {
  deps: FixtureCoinDeps;
  balance: number;
  intents: Map<string, FixtureIntent>;
}

/** A drawn 72px item picture: a cut gem in `hue` on a dark tile. */
function gem(hue: number): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 72 72"><rect width="72" height="72" rx="14" fill="hsl(${hue} 45% 16%)"/><path d="M20 30 L29 18 H43 L52 30 L36 56 Z" fill="hsl(${hue} 80% 62%)"/><path d="M20 30 H52 L36 56 Z" fill="hsl(${hue} 70% 46%)"/><path d="M29 18 L36 30 L43 18" fill="none" stroke="hsl(${hue} 90% 84%)" stroke-width="1.5"/></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

const totalOf = (intent: FixtureIntent): number => SPECS[intent.kase].quantity * intent.unitPriceCoins;

/** A purchase as genex.games serves one (`GET /api/coin/intents/:id`). */
function view(intent: FixtureIntent) {
  const spec = SPECS[intent.kase];
  const totalCoins = totalOf(intent);
  return {
    id: intent.id,
    status: intent.status,
    projectId: intent.project.id,
    skuId: spec.buy ? `sku-${intent.kase}` : null,
    orderId: spec.buy ? null : `order-${intent.id}`,
    description: spec.description,
    projectName: intent.project.title,
    failureCode: intent.failureCode,
    name: spec.name,
    iconUrl: spec.picture === null ? null : gem(spec.picture),
    quantity: spec.quantity,
    unitPriceCoins: intent.unitPriceCoins,
    totalCoins,
    priceDisplayUsdCents: totalCoins,
    expiresAt: new Date(intent.expiresAt).toISOString(),
  };
}

/** Time moves every purchase on: a payment under way lands, one left open to pay lapses. */
function settle(state: CoinState): void {
  const now = state.deps.now();
  for (const intent of state.intents.values()) {
    if (intent.status === CoinIntentStatus.Processing && intent.landsAt !== null && now >= intent.landsAt) {
      state.balance = Math.max(0, state.balance - totalOf(intent));
      intent.status = CoinIntentStatus.Succeeded;
      intent.landsAt = null;
    }
    if (intent.status === CoinIntentStatus.RequiresConfirmation && now >= intent.expiresAt)
      intent.status = CoinIntentStatus.Expired;
  }
}

/** The purchase with this id, made now if it names a case of a game in the launch; else null. */
function intentFor(state: CoinState, id: string): FixtureIntent | null {
  const known = state.intents.get(id);
  if (known) return known;
  const named = readFixtureId(id);
  const project = named ? state.deps.project(named.slug) : null;
  if (!named || !project) return null;
  const spec = SPECS[named.kase];
  const made: FixtureIntent = {
    id,
    kase: named.kase,
    project,
    unitPriceCoins: spec.unitPrice(state.balance),
    status: CoinIntentStatus.RequiresConfirmation,
    failureCode: null,
    expiresAt: state.deps.now() + spec.openMs,
    landsAt: null,
  };
  state.intents.set(id, made);
  return made;
}

/** How genex.games answers a case's Pay before the balance is weighed; a case not listed pays as usual. */
const PAY_ANSWERS: Partial<Record<FixtureCoinCase, (state: CoinState, intent: FixtureIntent) => GalleryAnswer>> = {
  [FixtureCoinCase.Short]: (_state, intent) => {
    intent.status = CoinIntentStatus.Failed;
    intent.failureCode = CoinFailure.InsufficientBalance;
    return refusal(HTTP.PaymentRequired, CoinFailure.InsufficientBalance);
  },
  [FixtureCoinCase.Slow]: (state, intent) => {
    intent.status = CoinIntentStatus.Processing;
    intent.landsAt = state.deps.now() + FIXTURE_SLOW_MS;
    return { status: HTTP.Unavailable, body: null };
  },
  [FixtureCoinCase.Refuse]: () => refusal(HTTP.Forbidden, CoinFailure.SurfaceCap),
  [FixtureCoinCase.Canceled]: (_state, intent) => {
    intent.status = CoinIntentStatus.Canceled;
    return refusal(HTTP.Conflict, CoinFailure.IntentNotPending);
  },
};

/** Pay, checked in genex.games' order: the surface and terms named, paid already, lapsed, still open, then the coin. */
function confirm(state: CoinState, intent: FixtureIntent, body: unknown): GalleryAnswer {
  if (!isRecord(body) || !SURFACES.has(body.confirmSurface)) return { status: HTTP.BadRequest, body: null };
  const termsNamed = SPECS[intent.kase].buy || body.paymentPolicy === PaymentPolicy.DynamicV1;
  if (!termsNamed) return refusal(HTTP.Conflict, CoinFailure.PaymentConfirmationRequired);
  if (PAID.has(intent.status)) return ok(view(intent));
  if (intent.status === CoinIntentStatus.Expired) return refusal(HTTP.Conflict, CoinFailure.IntentExpired);
  if (intent.status !== CoinIntentStatus.RequiresConfirmation)
    return refusal(HTTP.Conflict, CoinFailure.IntentNotPending);
  const answer = PAY_ANSWERS[intent.kase];
  if (answer) return answer(state, intent);
  const total = totalOf(intent);
  if (total > state.balance) {
    intent.status = CoinIntentStatus.Failed;
    intent.failureCode = CoinFailure.InsufficientBalance;
    return refusal(HTTP.PaymentRequired, CoinFailure.InsufficientBalance);
  }
  state.balance -= total;
  intent.status = CoinIntentStatus.Succeeded;
  return ok(view(intent));
}

/** Cancel: a purchase still open to pay is canceled; any other answers as it stands (a paid one, paid). */
function cancel(intent: FixtureIntent): GalleryAnswer {
  if (intent.status === CoinIntentStatus.RequiresConfirmation) intent.status = CoinIntentStatus.Canceled;
  return ok(view(intent));
}

/** The account's coin, as `GET /api/coin/balance` answers it: what it bought, and what it earned still on hold. */
function balanceAnswer(state: CoinState): GalleryAnswer {
  settle(state);
  const spendable = state.balance;
  const { earnedHeld, readyInMs, holdDays } = FIXTURE_EARNED_HOLD;
  return ok({
    purchased: spendable,
    earned: earnedHeld,
    promo: 0,
    traded: 0,
    spendable,
    earnedHeld,
    earnedEligible: 0,
    displayUsdCents: spendable,
    earnedReady: 0,
    nextReleaseAt: new Date(state.deps.now() + readyInMs).toISOString(),
    holdDays,
  });
}

/** The id an intents route names, decoded; "" when it names none. */
function idIn(pathname: string, prefix: string): string {
  const segment = pathname.slice(prefix.length).split("/")[0] ?? "";
  try {
    return decodeURIComponent(segment);
  } catch {
    return "";
  }
}

const INTENTS = CoinRoute.intent("");

/** The answer to a route under `/api/coin/intents/`: read, Pay or Cancel, signed in as a fixture account. */
function intentAnswer(state: CoinState, pathname: string, init: Parameters<GalleryRequest>[1]): GalleryAnswer {
  const id = idIn(pathname, INTENTS);
  const method = init.method ?? "GET";
  const read = pathname === CoinRoute.intent(id);
  const write = pathname === CoinRoute.confirm(id) || pathname === CoinRoute.cancel(id);
  if (!takenAccount(init.token)) return write ? CONFIRM_SIGNED_OUT : SIGNED_OUT;
  settle(state);
  if (read && method === "GET") {
    const intent = intentFor(state, id);
    return intent ? ok(view(intent)) : NO_INTENT;
  }
  if (!write || method !== "POST") return NOT_FOUND;
  const intent = state.intents.get(id);
  if (!intent) return NO_INTENT;
  return pathname === CoinRoute.confirm(id) ? confirm(state, intent, init.body) : cancel(intent);
}

/**
 * One launch's coin: `answer` answers genex.games' coin routes (null for any other route), and
 * `topUp` adds {@link FIXTURE_TOP_UP} coin, as Get Nex does in a fixture launch.
 */
export function createFixtureCoin(deps: FixtureCoinDeps) {
  const state: CoinState = { deps, balance: FIXTURE_BALANCE, intents: new Map() };
  return {
    answer: (route: string, init: Parameters<GalleryRequest>[1]): GalleryAnswer | null => {
      const [pathname = ""] = route.split("?");
      if (pathname === CoinRoute.Balance) {
        if ((init.method ?? "GET") !== "GET") return NOT_FOUND;
        return takenAccount(init.token) ? balanceAnswer(state) : SIGNED_OUT;
      }
      return pathname.startsWith(INTENTS) ? intentAnswer(state, pathname, init) : null;
    },
    topUp: (): void => {
      state.balance += FIXTURE_TOP_UP;
    },
  };
}

/** What the stand-in game's purchase buttons need, as its page reads them. */
interface BuyPage {
  slug: string;
  confirmOrigin: string;
  /** Every case, in the order of its button and its key. */
  cases: readonly string[];
  /** The cases asked with `buy()`; the rest with `requestPayment()`. */
  buyCases: readonly string[];
  keys: string;
  features: string;
  createMs: number;
}

/**
 * Run in the stand-in game's page, serialized there, so it names nothing outside itself: a button
 * per case (`data-fixture-buy`) and its key. Each asks as the embed SDK 0.33.0 does: `buy()` opens
 * genex.games' confirm page at once; `requestPayment()` reserves a blank popup before its payment
 * exists, gives the popup's opener up, and points it at the confirm page once the payment is made.
 * Every ask is a new purchase, its id as {@link fixtureIntentId} makes one.
 */
function buyButtons(page: BuyPage): void {
  let asked = 0;
  const ask = (kase: string): void => {
    asked += 1;
    // A page reloaded at once starts its count again: the random part keeps its asks new.
    const nonce = `${Math.random().toString(36).slice(2, 10)}${asked.toString(36)}`;
    const id = `fx-${kase}-${nonce}--${page.slug}`;
    const confirmUrl = `${page.confirmOrigin}/confirm/${encodeURIComponent(id)}`;
    if (page.buyCases.includes(kase)) {
      window.open(confirmUrl, `genex_confirm_${id}`, page.features);
      return;
    }
    const popup = window.open("about:blank", "_blank", page.features);
    if (!popup) return;
    popup.opener = null;
    setTimeout(() => {
      if (!popup.closed) popup.location.href = confirmUrl;
    }, page.createMs);
  };
  const bar = document.createElement("nav");
  bar.dataset.fixtureBuys = "";
  for (const [at, kase] of page.cases.entries()) {
    const button = document.createElement("button");
    button.dataset.fixtureBuy = kase;
    button.textContent = `${page.keys[at] ?? ""} ${kase}`;
    button.addEventListener("click", () => ask(kase));
    bar.append(button);
  }
  document.body.append(bar);
  document.addEventListener("keydown", (event) => {
    const kase = event.key.length === 1 && !event.repeat ? page.cases[page.keys.indexOf(event.key)] : undefined;
    if (kase) ask(kase);
  });
}

/** The stand-in game's purchase buttons, laid along its foot under the bar's layer. */
export const FIXTURE_BUY_STYLE =
  "nav[data-fixture-buys]{position:fixed;left:12px;right:12px;bottom:12px;display:flex;flex-wrap:wrap;gap:6px}nav[data-fixture-buys] button{font:500 12px/1 ui-monospace,Menlo,monospace;color:#fff;background:rgb(0 0 0/.5);border:1px solid rgb(255 255 255/.28);border-radius:6px;padding:6px 8px;cursor:pointer}";

/** The script that gives the stand-in game for `slug` its purchase buttons and keys. */
export function fixtureBuyScript(slug: string): string {
  const page: BuyPage = {
    slug,
    confirmOrigin: FIXTURE_CONFIRM_ORIGIN,
    cases: CASES,
    buyCases: CASES.filter((kase) => SPECS[kase].buy),
    keys: CASE_KEYS,
    features: POPUP_FEATURES,
    createMs: CREATE_MS,
  };
  // No `<` reaches the page inside the script: it could end the script element early.
  return `(${buyButtons.toString()})(${JSON.stringify(page).replace(/</g, "\\u003c")});`;
}
