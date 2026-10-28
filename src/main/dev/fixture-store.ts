/**
 * The store in a fixture profile (marketplace plan 10.1): genex.games' store routes
 * (`/api/store/*`), the creator SKU routes and the purchases a game's page starts, answered here in
 * the shapes genex.games serves (`play/store.ts` reads them), over the launch's other fixture answers
 * (`fixture-play.ts`: the catalog's games, the people and the coin), so the Store section, My items,
 * the purchase sheet, the shelf and Create › Items show every state with no socket and no Genex
 * account. The store game is Stick & Steel: its own items, one shared item it added, and the
 * account owning some. The fixture account also makes items, in Snowball: a draft, one with no
 * picture yet, items on sale, off sale, taken down and one under review. Coin spent here comes off
 * the fixture coin's balance. State lives for the launch.
 */
import { handleBaseFromName } from "../../shared/handle.ts";
import {
  AllowanceState,
  ITEM_REPORT_MESSAGE_MAX,
  isItemReportReason,
  ItemState,
  ItemType,
  StoreRefusal,
} from "../../shared/store-items.ts";
import { CoinFailure, CoinIntentStatus, CoinRoute, ConfirmSurface } from "../play/coin.ts";
import { type GalleryAnswer, type GalleryRequest, isRecord, PlayRoute } from "../play/gallery.ts";
import { FIXTURE_EARNED_HOLD } from "./fixture-coin.ts";
import { FIXTURE_ME_ID, fixtureAuthorId, takenAccount } from "./fixture-people.ts";

/** The game whose page has the fixture store: Stick & Steel, by Simeon M. */
export const FIXTURE_STORE_GAME = "stick-steel";
/** The fixture account's own games, where its items are made and shared items are added. */
export const FIXTURE_STORE_ACCOUNT_GAMES = ["snowball", "claude-of-duty"] as const;
/** How long a page purchase stays open to pay: genex.games' own intent TTL. */
const INTENT_TTL_MS = 2 * 60 * 1000;
/** Complaints a launch takes before the report limiter answers, as genex.games' 5 an hour. */
const REPORTS_MAX = 5;
/** The share a selling game gets of a shared item's sale, in basis points (P14). */
const SELLING_GAME_BPS = 1500;
const BPS = 10_000;
/** One page of Browse when it asks for none, and the most it may ask for. */
const BROWSE_LIMIT = 24;
const BROWSE_LIMIT_MAX = 48;
/** "Works in N games" lists at most this many games; the shelf at most this many items. */
const GAMES_PREVIEW_MAX = 8;
const SHELF_MAX = 5;
/** Selling's strip, as the design shows it; its held coin is the fixture coin's balance's own. */
const STRIP = {
  earnedReady: 48_200,
  earnedHeld: FIXTURE_EARNED_HOLD.earnedHeld,
  holdDays: FIXTURE_EARNED_HOLD.holdDays,
} as const;

/** The fixture's items, by id. Values are SKU ids as genex.games hands them out. */
export const FixtureStoreItem = {
  LegendarySword: "fxi-legendary-sword",
  SteelBlade: "fxi-steel-blade",
  RagePotion: "fxi-rage-potion",
  KnightHelmet: "fxi-knight-helmet",
  RookieBadge: "fxi-rookie-badge",
  OldShield: "fxi-old-shield",
  IronGauntlet: "fxi-iron-gauntlet",
  PhoenixWings: "fxi-phoenix-wings",
  NeonSkateboard: "fxi-neon-skateboard",
  GoldenCrown: "fxi-golden-crown",
  PowerCrystal: "fxi-power-crystal",
  Air: "fxi-air",
  FrostAxe: "fxi-frost-axe",
  SnowMitten: "fxi-snow-mitten",
  IceCrown: "fxi-ice-crown",
  SnowShovel: "fxi-snow-shovel",
  SnowBadge: "fxi-snow-badge",
  HotCocoa: "fxi-hot-cocoa",
  YetiHelmet: "fxi-yeti-helmet",
  OakSled: "fxi-oak-sled",
  CopiedCape: "fxi-copied-cape",
} as const;
export type FixtureStoreItem = (typeof FixtureStoreItem)[keyof typeof FixtureStoreItem];

/** An item as the fixture holds it. */
interface FixtureItem {
  id: string;
  name: string;
  description: string | null;
  type: ItemType;
  priceCoins: number;
  /** Its home game's slug. */
  home: string;
  /** Its author's name, as the catalog names the author of its home game. */
  author: string;
  shareable: boolean;
  state: ItemState;
  tags: string[];
  /** The games it was added to and is sold in now (a live allowance, Q5), in the order they went live. */
  hosts: string[];
  /** Its drawn picture's hue; null while it has none (Put on sale refuses it). */
  hue: number | null;
  publishedAt: string | null;
  sold: number;
  earned: number;
  underReview: boolean;
  /** Files a game that adds it gets, as its package lists them. */
  files: Array<{ path: string; bytes: number }>;
}

const SIMEON = "Simeon M";
const MATTHEW = "Matthew G";
const ME = "Rab Neba";

/** An item with the fixture's defaults: a durable on sale, shared with nobody. */
const item = (id: string, name: string, fields: Partial<FixtureItem>): FixtureItem => ({
  id,
  name,
  description: null,
  type: ItemType.Durable,
  priceCoins: 100,
  home: FIXTURE_STORE_GAME,
  author: SIMEON,
  shareable: false,
  state: ItemState.OnSale,
  tags: [],
  hosts: [],
  hue: 200,
  publishedAt: "2026-09-01T10:00:00.000Z",
  sold: 0,
  earned: 0,
  underReview: false,
  files: [],
  ...fields,
});

/** Every item of the launch, before it changes any. */
function seedItems(): FixtureItem[] {
  const I = FixtureStoreItem;
  const at = (day: number) => `2026-09-${String(day).padStart(2, "0")}T10:00:00.000Z`;
  const wingsFiles = [
    { path: "phoenix-wings.glb", bytes: 1_843_200 },
    { path: "phoenix-wings.js", bytes: 2048 },
  ];
  return [
    item(I.LegendarySword, "Legendary Sword", {
      description: "A blade from the old forge. It glows when an enemy is near.",
      priceCoins: 50_000,
      shareable: true,
      tags: ["sword", "legendary"],
      hosts: ["lost-cathedral", "skate-dog", "snowball"],
      hue: 220,
      publishedAt: at(1),
      files: [{ path: "legendary-sword.glb", bytes: 912_000 }],
    }),
    item(I.SteelBlade, "Steel Blade", {
      description: "Plain, sharp and honest.",
      priceCoins: 1200,
      hue: 210,
      publishedAt: at(2),
    }),
    item(I.RagePotion, "Rage Potion × 3", { type: ItemType.Consumable, priceCoins: 300, hue: 0, publishedAt: at(3) }),
    item(I.KnightHelmet, "Knight Helmet", { priceCoins: 800, hue: 40, publishedAt: at(4) }),
    item(I.RookieBadge, "Rookie Badge", { priceCoins: 0, hue: 50, publishedAt: at(5) }),
    item(I.OldShield, "Old Shield", { priceCoins: 500, state: ItemState.OffSale, hue: 30, publishedAt: at(6) }),
    item(I.IronGauntlet, "Iron Gauntlet", { priceCoins: 800, state: ItemState.Draft, publishedAt: null }),
    item(I.PhoenixWings, "Phoenix Wings", {
      description: "Wings of living fire. They leave a trail of sparks.",
      priceCoins: 8000,
      home: "skate-dog",
      author: MATTHEW,
      shareable: true,
      tags: ["wings", "fire"],
      hosts: [FIXTURE_STORE_GAME, "lost-cathedral", "snowball", "iron-tide", "frigate", "puck-rush"],
      hue: 20,
      files: wingsFiles,
    }),
    item(I.NeonSkateboard, "Neon Skateboard", {
      priceCoins: 2000,
      home: "skate-dog",
      author: MATTHEW,
      shareable: true,
      tags: ["skateboard"],
      hue: 300,
    }),
    item(I.GoldenCrown, "Golden Crown", {
      priceCoins: 5000,
      home: "samurai-template",
      author: "achref",
      shareable: true,
      tags: ["crown"],
      hosts: ["lost-cathedral"],
      hue: 48,
    }),
    item(I.PowerCrystal, "Power Crystal", {
      priceCoins: 800,
      home: "dust-runners",
      author: "Kir",
      shareable: true,
      tags: ["crystal"],
      hosts: ["iron-tide", "frigate"],
      hue: 180,
    }),
    item(I.Air, "Air", { priceCoins: 100, home: "dust-runners", author: "Kir", shareable: true, hue: 190 }),
    ...creatorItems(),
  ];
}

/** The fixture account's own items, in Snowball, newest first as Selling lists them. */
function creatorItems(): FixtureItem[] {
  const I = FixtureStoreItem;
  const mine = { home: "snowball", author: ME, publishedAt: "2026-10-01T10:00:00.000Z" };
  return [
    item(I.FrostAxe, "Frost Axe", {
      ...mine,
      description: "Ice-blue head. Freezes an enemy for a second on hit.",
      priceCoins: 1200,
      shareable: true,
      state: ItemState.Draft,
      tags: ["axe", "ice"],
      hue: 195,
      publishedAt: null,
    }),
    item(I.SnowMitten, "Snow Mitten", {
      ...mine,
      priceCoins: 300,
      state: ItemState.Draft,
      hue: null,
      publishedAt: null,
    }),
    item(I.IceCrown, "Ice Crown", {
      ...mine,
      priceCoins: 50_000,
      shareable: true,
      hosts: ["lost-cathedral", "skate-dog", "iron-tide"],
      hue: 190,
      sold: 1,
      earned: 35_000,
    }),
    item(I.SnowShovel, "Snow Shovel", { ...mine, priceCoins: 1200, hue: 210, sold: 12, earned: 12_240 }),
    // A Free item: Selling's price says Free, as the Store card does; claims count as sold.
    item(I.SnowBadge, "Snow Badge", { ...mine, priceCoins: 0, hue: 205, sold: 9, earned: 0 }),
    item(I.HotCocoa, "Hot Cocoa × 3", {
      ...mine,
      type: ItemType.Consumable,
      priceCoins: 300,
      hue: 25,
      sold: 22,
      earned: 5610,
    }),
    item(I.YetiHelmet, "Yeti Helmet", { ...mine, priceCoins: 800, hue: 200, sold: 2, earned: 1360, underReview: true }),
    item(I.OakSled, "Oak Sled", { ...mine, priceCoins: 500, state: ItemState.OffSale, hue: 35 }),
    item(I.CopiedCape, "Copied Cape", {
      ...mine,
      priceCoins: 300,
      state: ItemState.TakenDown,
      hue: 280,
      sold: 3,
      earned: 765,
    }),
  ];
}

/** A game of the launch's catalog, as its page says. */
interface FixtureGame {
  id: string;
  slug: string;
  title: string;
  coverUrl: string | null;
}

/** What the account owns of an item: a durable's `remaining` is null. */
interface Owned {
  remaining: number | null;
  acquiredAt: number;
}

/** A shared item in one of the account's games. */
interface Allowance {
  skuId: string;
  slug: string;
  state: AllowanceState;
  addedAt: number;
  removedAt: number | null;
  /** Sold there now: the game promoted a build since it was added (Q5). */
  live: boolean;
}

/** A purchase a game's page started. */
interface PageIntent {
  id: string;
  item: FixtureItem;
  game: FixtureGame;
  status: CoinIntentStatus;
  failureCode: CoinFailure | null;
  expiresAt: number;
}

/** What the fixture store needs: the time, and the launch's other fixture answers. */
export interface FixtureStoreDeps {
  now(): number;
  /** The catalog's, people's and coin's answers (`fixturePlayRequest`): every route the store does not answer. */
  fallback: GalleryRequest;
}

/** One launch's store. */
interface StoreState {
  deps: FixtureStoreDeps;
  items: FixtureItem[];
  owned: Map<string, Owned>;
  allowances: Map<string, Allowance>;
  intents: Map<string, PageIntent>;
  games: Map<string, Promise<FixtureGame | null>>;
  /** Coin the account spent here: it comes off the fixture coin's balance. */
  spent: number;
  reports: number;
  made: number;
}

/** One call, as a route handler reads it. */
interface Call {
  query: URLSearchParams;
  body: unknown;
  token: string | undefined;
  /** A fixture account is signed in (one genex.games still takes). */
  signedIn: boolean;
  /** The route's ids, in order. */
  ids: string[];
}

const HTTP = {
  Ok: 200,
  Created: 201,
  BadRequest: 400,
  Unauthorized: 401,
  PaymentRequired: 402,
  NotFound: 404,
  Conflict: 409,
  Unprocessable: 422,
  TooManyRequests: 429,
} as const;

const ok = (body: unknown): GalleryAnswer => ({ status: HTTP.Ok, body });
const refuse = (status: number, error: string): GalleryAnswer => ({ status, body: { error } });
const SIGNED_OUT = refuse(HTTP.Unauthorized, StoreRefusal.Unauthorized);
const iso = (at: number): string => new Date(at).toISOString();

/** A drawn item render on a transparent background: a cut gem in `hue`. */
function picture(hue: number | null): string | null {
  if (hue === null) return null;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><path d="M28 30 L40 16 H56 L68 30 L48 82 Z" fill="hsl(${hue} 70% 52%)"/><path d="M28 30 H68 L48 82 Z" fill="hsl(${hue} 80% 64%)"/><path d="M40 16 L48 30 L56 16" fill="none" stroke="hsl(${hue} 90% 86%)" stroke-width="2"/></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** The catalog game `slug`, read once from the launch's own answers; null when it has none. */
function gameOf(state: StoreState, slug: string): Promise<FixtureGame | null> {
  const known = state.games.get(slug);
  if (known) return known;
  const read = state.deps.fallback(PlayRoute.world(slug), { method: "GET" }).then((answer) => {
    const game = isRecord(answer.body) ? answer.body.item : null;
    if (answer.status !== HTTP.Ok || !isRecord(game) || typeof game.id !== "string") return null;
    const coverUrl = typeof game.thumbnailUrl === "string" ? game.thumbnailUrl : null;
    return { id: game.id, slug, title: typeof game.title === "string" ? game.title : slug, coverUrl };
  });
  state.games.set(slug, read);
  return read;
}

/** The account's game with Genex project id `projectId`, or null for anyone else's. */
async function accountGame(state: StoreState, projectId: string): Promise<FixtureGame | null> {
  const games = await Promise.all(FIXTURE_STORE_ACCOUNT_GAMES.map((slug) => gameOf(state, slug)));
  return games.find((game) => game?.id === projectId) ?? null;
}

const itemOf = (state: StoreState, id: string): FixtureItem | undefined => state.items.find((one) => one.id === id);
const isMine = (one: FixtureItem): boolean => fixtureAuthorId(one.author) === FIXTURE_ME_ID;
const gamesCount = (one: FixtureItem): number => 1 + one.hosts.length;
const soldIn = (one: FixtureItem, slug: string): boolean => one.home === slug || one.hosts.includes(slug);
/** An item genex.games lets a player find at all: anything but a draft. */
const findable = (one: FixtureItem | undefined): one is FixtureItem =>
  one !== undefined && one.state !== ItemState.Draft;
/** Owned and not used up: a durable, or a consumable with some left. */
const held = (owned: Owned | undefined): owned is Owned => owned !== undefined && owned.remaining !== 0;
const heldCount = (state: StoreState): number => [...state.owned.values()].filter(held).length;
const allowanceKey = (slug: string, skuId: string): string => `${slug}:${skuId}`;

/** A game as the store names one. */
const refOf = (game: FixtureGame | null) => game && { slug: game.slug, title: game.title };

/** What every item a player sees carries, as genex.games serves it on `slug`'s page (or none). */
async function playerView(state: StoreState, one: FixtureItem, slug: string | null) {
  return {
    id: one.id,
    name: one.name,
    description: one.description,
    iconUrl: picture(one.hue),
    modelUrl: null,
    type: one.type,
    priceCoins: one.priceCoins,
    priceDisplayUsdCents: one.priceCoins,
    shared: one.shareable || (slug !== null && one.home !== slug),
    gamesCount: gamesCount(one),
    homeGame: refOf(await gameOf(state, one.home)),
  };
}

/** What the account owns of `one`: the card's Owned and how many are left. */
function ownership(state: StoreState, one: FixtureItem) {
  const owned = state.owned.get(one.id);
  const remaining = one.type === ItemType.Consumable ? (owned?.remaining ?? 0) : null;
  return { owned: held(owned), remaining };
}

/** A game's Store tab: its own items on sale as published, then the shared items it added as they went live. */
async function storeTab(state: StoreState, call: Call): Promise<GalleryAnswer> {
  const [slug = ""] = call.ids;
  if (!(await gameOf(state, slug))) return refuse(HTTP.NotFound, StoreRefusal.GameNotFound);
  const onSale = state.items.filter((one) => one.state === ItemState.OnSale);
  const own = onSale
    .filter((one) => one.home === slug)
    .sort((a, b) => (a.publishedAt ?? "").localeCompare(b.publishedAt ?? ""));
  const added = onSale.filter((one) => one.hosts.includes(slug));
  const items = await Promise.all(
    [...own, ...added].map(async (one) => ({
      ...(await playerView(state, one, slug)),
      ...(call.signedIn ? ownership(state, one) : {}),
    })),
  );
  return ok(call.signedIn ? { items, myItemsCount: heldCount(state) } : { items });
}

/** My items on `slug`'s page: everything the account holds, what works here first, newest first. */
async function myItems(state: StoreState, call: Call): Promise<GalleryAnswer> {
  const [slug = ""] = call.ids;
  if (!call.signedIn) return SIGNED_OUT;
  if (!(await gameOf(state, slug))) return refuse(HTTP.NotFound, StoreRefusal.GameNotFound);
  const rows = state.items.flatMap((one) => {
    const owned = state.owned.get(one.id);
    return held(owned) ? [{ one, owned, here: soldIn(one, slug) }] : [];
  });
  rows.sort((a, b) => Number(b.here) - Number(a.here) || b.owned.acquiredAt - a.owned.acquiredAt);
  const items = await Promise.all(
    rows.map(async ({ one, owned, here }) => ({
      ...(await playerView(state, one, slug)),
      place: here ? "works_here" : "not_in_this_game",
      remaining: owned.remaining,
      acquiredAt: iso(owned.acquiredAt),
    })),
  );
  return ok({ items });
}

/** "Works in N games": the home game, then the games it went live in. */
async function itemGames(state: StoreState, call: Call): Promise<GalleryAnswer> {
  const one = itemOf(state, call.ids[0] ?? "");
  if (!findable(one)) return refuse(HTTP.NotFound, StoreRefusal.SkuNotFound);
  const games = await Promise.all([one.home, ...one.hosts].map((slug) => gameOf(state, slug)));
  const listed = games.flatMap((game) => (game ? [{ ...refOf(game), coverUrl: game.coverUrl }] : []));
  return ok({ total: gamesCount(one), games: listed.slice(0, GAMES_PREVIEW_MAX) });
}

/** Why `one` cannot be had on `slug`'s page (genex.games' order), or null when it can. */
async function notHere(state: StoreState, one: FixtureItem | undefined, slug: unknown): Promise<GalleryAnswer | null> {
  if (!findable(one)) return refuse(HTTP.NotFound, StoreRefusal.SkuNotFound);
  if (typeof slug !== "string" || !(await gameOf(state, slug))) return refuse(HTTP.NotFound, StoreRefusal.GameNotFound);
  if (!soldIn(one, slug)) return refuse(HTTP.Conflict, StoreRefusal.NotSoldHere);
  return one.state === ItemState.OnSale ? null : refuse(HTTP.Conflict, StoreRefusal.ItemOffSale);
}

/** A page purchase as genex.games serves it. */
function intentView(intent: PageIntent) {
  const { item: one } = intent;
  return {
    id: intent.id,
    status: intent.status,
    projectId: intent.game.id,
    skuId: one.id,
    orderId: null,
    description: null,
    projectName: intent.game.title,
    failureCode: intent.failureCode,
    name: one.name,
    iconUrl: picture(one.hue),
    quantity: 1,
    unitPriceCoins: one.priceCoins,
    totalCoins: one.priceCoins,
    priceDisplayUsdCents: one.priceCoins,
    expiresAt: iso(intent.expiresAt),
    confirmUrl: `https://confirm.genex.invalid/confirm/${intent.id}`,
  };
}

/** Buy from a game's page: a purchase of one, to confirm with the coin routes. */
async function purchase(state: StoreState, call: Call): Promise<GalleryAnswer> {
  if (!call.signedIn) return SIGNED_OUT;
  const one = itemOf(state, call.ids[0] ?? "");
  const slug = isRecord(call.body) ? call.body.slug : undefined;
  const refused = await notHere(state, one, slug);
  if (refused || !one || typeof slug !== "string") return refused ?? refuse(HTTP.BadRequest, StoreRefusal.Unknown);
  if (one.priceCoins === 0) return refuse(HTTP.Conflict, StoreRefusal.FreeItem);
  const ownedOnce = one.type === ItemType.Durable && held(state.owned.get(one.id));
  if (ownedOnce) return refuse(HTTP.Conflict, StoreRefusal.AlreadyOwned);
  const game = await gameOf(state, slug);
  if (!game) return refuse(HTTP.NotFound, StoreRefusal.GameNotFound);
  state.made += 1;
  const intent: PageIntent = {
    id: `fxs-${state.made}`,
    item: one,
    game,
    status: CoinIntentStatus.RequiresConfirmation,
    failureCode: null,
    expiresAt: state.deps.now() + INTENT_TTL_MS,
  };
  state.intents.set(intent.id, intent);
  return ok(intentView(intent));
}

/** The account now holds one more of `one`. */
function own(state: StoreState, one: FixtureItem): void {
  const had = state.owned.get(one.id);
  const remaining = one.type === ItemType.Consumable ? (had?.remaining ?? 0) + 1 : null;
  state.owned.set(one.id, { remaining, acquiredAt: state.deps.now() });
}

/** Claim a Free item: once per player (Q6); a second claim replays the first. */
async function claim(state: StoreState, call: Call): Promise<GalleryAnswer> {
  if (!call.signedIn) return SIGNED_OUT;
  const one = itemOf(state, call.ids[0] ?? "");
  const refused = await notHere(state, one, isRecord(call.body) ? call.body.slug : undefined);
  if (refused || !one) return refused ?? refuse(HTTP.BadRequest, StoreRefusal.Unknown);
  if (one.priceCoins !== 0) return refuse(HTTP.Conflict, StoreRefusal.NotFree);
  const replayed = state.owned.has(one.id);
  if (!replayed) own(state, one);
  return ok({ entitlementId: `fxe-${one.id}`, skuId: one.id, replayed });
}

/** A complaint: anyone may send one, until the report limiter answers. */
function report(state: StoreState, call: Call): GalleryAnswer {
  if (!findable(itemOf(state, call.ids[0] ?? ""))) return refuse(HTTP.NotFound, StoreRefusal.SkuNotFound);
  const body = isRecord(call.body) ? call.body : {};
  const message =
    body.message === undefined || (typeof body.message === "string" && body.message.length <= ITEM_REPORT_MESSAGE_MAX);
  if (!isItemReportReason(body.reason) || !message) return refuse(HTTP.BadRequest, StoreRefusal.Unknown);
  if (state.reports >= REPORTS_MAX) return refuse(HTTP.TooManyRequests, "Too many requests");
  state.reports += 1;
  return { status: HTTP.Created, body: { ok: true } };
}

/** A profile's shelf: the account's durables newest first, a creator's own picks, nobody else's. */
async function shelf(state: StoreState, call: Call): Promise<GalleryAnswer> {
  const [userId = ""] = call.ids;
  const picks = shelfPicks(state, userId);
  if (!picks) return refuse(HTTP.NotFound, StoreRefusal.UserNotFound);
  const items = await Promise.all(
    picks.slice(0, SHELF_MAX).map(async (one) => {
      const game = await gameOf(state, one.home);
      // Get in <game> draws the game's cover (D48), while that game (its home) still sells it.
      return {
        id: one.id,
        name: one.name,
        iconUrl: picture(one.hue),
        modelUrl: null,
        game: game && { ...refOf(game), coverUrl: game.coverUrl },
        onSale: one.state === ItemState.OnSale,
      };
    }),
  );
  return ok({ items });
}

/** Whose shelf holds what: null for a person the fixture does not know. */
function shelfPicks(state: StoreState, userId: string): FixtureItem[] | null {
  if (userId === FIXTURE_ME_ID) {
    const durables = state.items.filter((one) => one.type === ItemType.Durable && held(state.owned.get(one.id)));
    const at = (one: FixtureItem) => state.owned.get(one.id)?.acquiredAt ?? 0;
    return durables.sort((a, b) => at(b) - at(a));
  }
  if (userId === fixtureAuthorId(SIMEON)) {
    const picks = [FixtureStoreItem.LegendarySword, FixtureStoreItem.PhoenixWings, FixtureStoreItem.GoldenCrown];
    return picks.flatMap((id) => itemOf(state, id) ?? []);
  }
  return userId.startsWith("fx-") ? [] : null;
}

/** An item another creator lets games add: a shareable durable on sale, not the account's own. */
const browsable = (one: FixtureItem | undefined): one is FixtureItem =>
  one?.shareable === true && one.state === ItemState.OnSale && one.type === ItemType.Durable && !isMine(one);

/** A Browse item as genex.games serves it. */
async function browseView(state: StoreState, one: FixtureItem) {
  const { shared: _shared, ...item } = await playerView(state, one, null);
  const author = { id: fixtureAuthorId(one.author), name: one.author, handle: handleBaseFromName(one.author) };
  const youGetPerSale = Math.floor((one.priceCoins * SELLING_GAME_BPS) / BPS);
  return { ...item, tags: one.tags, author, youGetPerSale };
}

/** Whether `one` matches every word of the search and every tag asked for. */
function matches(one: FixtureItem, words: string[], tags: string[]): boolean {
  const text = [one.name, one.description ?? "", ...one.tags].join(" ").toLowerCase();
  return words.every((word) => text.includes(word)) && tags.every((tag) => one.tags.includes(tag));
}

/** Browse: other creators' shared items, most games first, a page from the cursor on. */
async function browse(state: StoreState, call: Call): Promise<GalleryAnswer> {
  if (!call.signedIn) return SIGNED_OUT;
  const words = (call.query.get("q") ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const tags = (call.query.get("tags") ?? "").split(",").filter(Boolean);
  const found = state.items.filter((one) => browsable(one) && matches(one, words, tags));
  found.sort((a, b) => gamesCount(b) - gamesCount(a));
  const from = Number((call.query.get("cursor") ?? "o0").slice(1)) || 0;
  const asked = Number(call.query.get("limit")) || BROWSE_LIMIT;
  const limit = Math.min(Math.max(asked, 1), BROWSE_LIMIT_MAX);
  const page = found.slice(from, from + limit);
  const nextCursor = from + limit < found.length ? `o${from + limit}` : null;
  const items = await Promise.all(page.map((one) => browseView(state, one)));
  // The share genex.games configures for a selling game (contract: Browse names it).
  return ok({ items, nextCursor, sellerShareBps: SELLING_GAME_BPS });
}

/** An allowance as genex.games serves one. */
async function allowanceView(state: StoreState, allowance: Allowance) {
  const game = await gameOf(state, allowance.slug);
  return {
    skuId: allowance.skuId,
    projectId: game?.id ?? null,
    state: allowance.state,
    addedAt: iso(allowance.addedAt),
    removedAt: allowance.removedAt === null ? null : iso(allowance.removedAt),
    liveFromBuildAt: allowance.live ? iso(allowance.addedAt) : null,
  };
}

/** Browse's detail panel: the item, its package's manifest, and which of the account's games added it. */
async function browseDetail(state: StoreState, call: Call): Promise<GalleryAnswer> {
  if (!call.signedIn) return SIGNED_OUT;
  const one = itemOf(state, call.ids[0] ?? "");
  if (!browsable(one)) return refuse(HTTP.NotFound, StoreRefusal.SkuNotFound);
  const active = [...state.allowances.values()].filter((a) => a.skuId === one.id && a.state === AllowanceState.Active);
  const addedTo = await Promise.all(
    active.map(async (allowance) => {
      const view = await allowanceView(state, allowance);
      return {
        ...refOf(await gameOf(state, allowance.slug)),
        projectId: view.projectId,
        liveFromBuildAt: view.liveFromBuildAt,
      };
    }),
  );
  const files = one.files.map((file) => ({ ...file, sha256: "fixture" }));
  const packageManifest = files.length > 0 ? { files } : null;
  return ok({ item: await browseView(state, one), packageManifest, addedTo, sellerShareBps: SELLING_GAME_BPS });
}

/** Why `one` cannot be added to `game` (genex.games' order), or null when it can. */
function notAddable(one: FixtureItem | undefined, game: FixtureGame): GalleryAnswer | null {
  if (!findable(one)) return refuse(HTTP.NotFound, StoreRefusal.SkuNotFound);
  if (!one.shareable) return refuse(HTTP.Conflict, StoreRefusal.NotShareable);
  if (one.state === ItemState.TakenDown) return refuse(HTTP.Conflict, StoreRefusal.TakenDown);
  if (one.state !== ItemState.OnSale) return refuse(HTTP.Conflict, StoreRefusal.ItemOffSale);
  return one.home === game.slug ? refuse(HTTP.Conflict, StoreRefusal.HomeGame) : null;
}

/** Add to \<game>: a new allowance, a removed one active again, or the active one replayed (D19, D38). */
async function addAllowance(state: StoreState, call: Call): Promise<GalleryAnswer> {
  if (!call.signedIn) return SIGNED_OUT;
  const game = await accountGame(state, call.ids[0] ?? "");
  if (!game) return refuse(HTTP.NotFound, StoreRefusal.ProjectNotFound);
  const skuId = isRecord(call.body) && typeof call.body.skuId === "string" ? call.body.skuId : "";
  const refused = notAddable(itemOf(state, skuId), game);
  if (refused) return refused;
  const key = allowanceKey(game.slug, skuId);
  const known = state.allowances.get(key);
  const replayed = known?.state === AllowanceState.Active;
  const allowance: Allowance =
    known && replayed
      ? known
      : {
          skuId,
          slug: game.slug,
          state: AllowanceState.Active,
          addedAt: state.deps.now(),
          removedAt: null,
          live: false,
        };
  state.allowances.set(key, allowance);
  return ok({ allowance: await allowanceView(state, allowance), package: null, replayed });
}

/** Remove from \<game>: the allowance is removed, and the item is no longer sold there. */
async function removeAllowance(state: StoreState, call: Call): Promise<GalleryAnswer> {
  if (!call.signedIn) return SIGNED_OUT;
  const [projectId = "", skuId = ""] = call.ids;
  const game = await accountGame(state, projectId);
  if (!game) return refuse(HTTP.NotFound, StoreRefusal.ProjectNotFound);
  const allowance = state.allowances.get(allowanceKey(game.slug, skuId));
  if (!allowance) return refuse(HTTP.NotFound, StoreRefusal.AllowanceNotFound);
  if (allowance.state === AllowanceState.Active) {
    Object.assign(allowance, { state: AllowanceState.Removed, removedAt: state.deps.now(), live: false });
    const one = itemOf(state, skuId);
    if (one) one.hosts = one.hosts.filter((slug) => slug !== game.slug);
  }
  return ok({ allowance: await allowanceView(state, allowance) });
}

/** Selling: the strip, and the account's items as made. */
async function selling(state: StoreState, call: Call): Promise<GalleryAnswer> {
  if (!call.signedIn) return SIGNED_OUT;
  const items = await Promise.all(
    state.items.filter(isMine).map(async (one) => {
      const game = await gameOf(state, one.home);
      return {
        id: one.id,
        name: one.name,
        iconUrl: picture(one.hue),
        type: one.type,
        game: game && { id: game.id, ...refOf(game) },
        gamesCount: gamesCount(one),
        state: one.state,
        underReview: one.underReview,
        shareable: one.shareable,
        priceCoins: one.priceCoins,
        priceDisplayUsdCents: one.priceCoins,
        sold: one.sold,
        earned: one.earned,
      };
    }),
  );
  return ok({ ...STRIP, nextReleaseAt: iso(state.deps.now() + FIXTURE_EARNED_HOLD.readyInMs), items });
}

/** An item as its author reads it back (`CreatorSku`). */
async function creatorView(state: StoreState, one: FixtureItem) {
  const game = await gameOf(state, one.home);
  return {
    id: one.id,
    projectId: game?.id ?? null,
    type: one.type,
    name: one.name,
    description: one.description,
    tags: one.tags,
    iconUrl: picture(one.hue),
    modelUrl: null,
    priceCoins: one.priceCoins,
    priceDisplayUsdCents: one.priceCoins,
    state: one.state,
    active: one.state === ItemState.OnSale,
    shareable: one.shareable,
    resellable: false,
    retired: false,
    packageManifest: null,
    publishedAt: one.publishedAt,
    takenDownAt: one.state === ItemState.TakenDown ? "2026-10-15T10:00:00.000Z" : null,
    createdAt: "2026-09-01T09:00:00.000Z",
  };
}

/** The account's own item a creator route names, or why genex.games refuses to touch it. */
function authorsItem(state: StoreState, call: Call): FixtureItem | GalleryAnswer {
  if (!call.signedIn) return SIGNED_OUT;
  const one = itemOf(state, call.ids[0] ?? "");
  if (!one || !isMine(one)) return refuse(HTTP.NotFound, StoreRefusal.SkuNotFound);
  return one.state === ItemState.TakenDown ? refuse(HTTP.Conflict, StoreRefusal.TakenDown) : one;
}

const isAnswer = (value: FixtureItem | GalleryAnswer): value is GalleryAnswer => "status" in value;

/** The hue a new item's drawn picture takes: the fixture's stand-in for the picture it was made with. */
const MADE_HUE = 200;

/** A new item's fields as `genex shop add` and `shop sync` send them, or null when they do not read. */
function newItemOf(
  body: unknown,
): Pick<FixtureItem, "name" | "description" | "type" | "priceCoins" | "tags" | "shareable"> | null {
  if (!isRecord(body)) return null;
  const { name, description, type, priceCoins, tags, shareable } = body;
  const named = typeof name === "string" && name.trim() !== "";
  const priced = typeof priceCoins === "number" && Number.isSafeInteger(priceCoins) && priceCoins >= 0;
  const typed = type === ItemType.Durable || type === ItemType.Consumable;
  if (!named || !priced || !typed) return null;
  return {
    name,
    description: typeof description === "string" ? description : null,
    type,
    priceCoins,
    tags: Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === "string") : [],
    shareable: shareable === true,
  };
}

/** A new item in one of the account's games, as the CLI's `shop add` and `shop sync` make one: a draft, with its picture. */
async function createSku(state: StoreState, call: Call): Promise<GalleryAnswer> {
  if (!call.signedIn) return SIGNED_OUT;
  const game = await accountGame(state, call.ids[0] ?? "");
  if (!game) return refuse(HTTP.NotFound, StoreRefusal.ProjectNotFound);
  const fields = newItemOf(call.body);
  if (!fields) return { status: HTTP.Unprocessable, body: { error: StoreRefusal.NameRefused, field: "name" } };
  state.made += 1;
  const one = item(`fxm-${state.made}`, fields.name, {
    ...fields,
    home: game.slug,
    author: ME,
    state: ItemState.Draft,
    hue: MADE_HUE,
    publishedAt: null,
  });
  state.items.push(one);
  return ok(await creatorView(state, one));
}

/** Put on sale: a draft or an item off sale goes on sale at once (P12); one with no picture is refused. */
async function publish(state: StoreState, call: Call): Promise<GalleryAnswer> {
  const one = authorsItem(state, call);
  if (isAnswer(one)) return one;
  if (one.hue === null)
    return { status: HTTP.Unprocessable, body: { error: StoreRefusal.PictureMissing, field: "picture" } };
  if (one.state !== ItemState.OnSale) {
    one.state = ItemState.OnSale;
    one.publishedAt ??= iso(state.deps.now());
  }
  return ok(await creatorView(state, one));
}

/** Take off sale: owners keep it, and it leaves every Store. */
async function unpublish(state: StoreState, call: Call): Promise<GalleryAnswer> {
  const one = authorsItem(state, call);
  if (isAnswer(one)) return one;
  if (one.state === ItemState.OnSale) one.state = ItemState.OffSale;
  return ok(await creatorView(state, one));
}

/** Other games can use it: only a durable may be shared (P3). */
async function patchSku(state: StoreState, call: Call): Promise<GalleryAnswer> {
  const one = authorsItem(state, call);
  if (isAnswer(one)) return one;
  const shareable = isRecord(call.body) ? call.body.shareable : undefined;
  if (shareable === true && one.type !== ItemType.Durable) return refuse(HTTP.BadRequest, StoreRefusal.NotDurable);
  if (typeof shareable === "boolean") one.shareable = shareable;
  return ok(await creatorView(state, one));
}

/** The fixture coin's spendable balance for `token`, less what was spent here; null when it answers none. */
async function balanceFor(state: StoreState, token: string | undefined): Promise<GalleryAnswer> {
  const answer = await state.deps.fallback(CoinRoute.Balance, { method: "GET", ...(token ? { token } : {}) });
  if (answer.status !== HTTP.Ok || !isRecord(answer.body)) return answer;
  const take = (value: unknown) => (typeof value === "number" ? Math.max(0, value - state.spent) : value);
  const { spendable, purchased, displayUsdCents } = answer.body;
  return ok({
    ...answer.body,
    spendable: take(spendable),
    purchased: take(purchased),
    displayUsdCents: take(displayUsdCents),
  });
}

/** A page purchase still open past its time has lapsed. */
function lapse(state: StoreState, intent: PageIntent): void {
  const open = intent.status === CoinIntentStatus.RequiresConfirmation;
  if (open && state.deps.now() >= intent.expiresAt) intent.status = CoinIntentStatus.Expired;
}

/** Pay for a page purchase from the account's coin, in genex.games' order of checks. */
async function confirm(state: StoreState, call: Call, intent: PageIntent): Promise<GalleryAnswer> {
  const surfaces: ReadonlySet<unknown> = new Set(Object.values(ConfirmSurface));
  if (!isRecord(call.body) || !surfaces.has(call.body.confirmSurface))
    return refuse(HTTP.BadRequest, StoreRefusal.Unknown);
  if (intent.status === CoinIntentStatus.Succeeded) return ok(intentView(intent));
  if (intent.status === CoinIntentStatus.Expired) return refuse(HTTP.Conflict, CoinFailure.IntentExpired);
  if (intent.status !== CoinIntentStatus.RequiresConfirmation)
    return refuse(HTTP.Conflict, CoinFailure.IntentNotPending);
  const balance = await balanceFor(state, call.token);
  const spendable = isRecord(balance.body) && typeof balance.body.spendable === "number" ? balance.body.spendable : 0;
  if (intent.item.priceCoins > spendable) {
    Object.assign(intent, { status: CoinIntentStatus.Failed, failureCode: CoinFailure.InsufficientBalance });
    return refuse(HTTP.PaymentRequired, CoinFailure.InsufficientBalance);
  }
  state.spent += intent.item.priceCoins;
  intent.status = CoinIntentStatus.Succeeded;
  own(state, intent.item);
  return ok(intentView(intent));
}

/** What a page purchase's coin route does. The fixture's own words. */
const IntentAction = { Read: "read", Confirm: "confirm", Cancel: "cancel" } as const;
type IntentAction = (typeof IntentAction)[keyof typeof IntentAction];

/** A page purchase's coin routes: read, Pay or Cancel, signed in as a fixture account. */
async function pageIntent(state: StoreState, call: Call, action: IntentAction): Promise<GalleryAnswer> {
  if (!call.signedIn)
    return action === IntentAction.Read ? SIGNED_OUT : refuse(HTTP.Unauthorized, CoinFailure.ConfirmRequiresSession);
  const intent = state.intents.get(call.ids[0] ?? "");
  if (!intent) return refuse(HTTP.NotFound, CoinFailure.IntentNotFound);
  lapse(state, intent);
  if (action === IntentAction.Confirm) return confirm(state, call, intent);
  if (action === IntentAction.Cancel && intent.status === CoinIntentStatus.RequiresConfirmation)
    intent.status = CoinIntentStatus.Canceled;
  return ok(intentView(intent));
}

type Handler = (state: StoreState, call: Call) => GalleryAnswer | Promise<GalleryAnswer>;

/** The routes the store answers, by method and shape (`:` for an id). */
const ROUTES: Readonly<Record<string, Handler>> = {
  "GET store/games/:/items": storeTab,
  "GET store/games/:/my-items": myItems,
  "GET store/items/:/games": itemGames,
  "POST store/items/:/purchase": purchase,
  "POST store/items/:/claim": claim,
  "POST store/items/:/reports": report,
  "GET store/users/:/shelf": shelf,
  "GET store/catalog": browse,
  "GET store/catalog/:": browseDetail,
  "POST store/projects/:/allowances": addAllowance,
  "DELETE store/projects/:/allowances/:": removeAllowance,
  "GET store/selling": selling,
  "POST coin/projects/:/skus": createSku,
  "POST coin/skus/:/publish": publish,
  "POST coin/skus/:/unpublish": unpublish,
  "PATCH coin/skus/:": patchSku,
  "GET coin/balance": (state, call) => balanceFor(state, call.token),
  "GET coin/intents/:": (state, call) => pageIntent(state, call, IntentAction.Read),
  "POST coin/intents/:/confirm": (state, call) => pageIntent(state, call, IntentAction.Confirm),
  "POST coin/intents/:/cancel": (state, call) => pageIntent(state, call, IntentAction.Cancel),
};

/** The id of a page purchase this store started: the coin routes of any other go to the fixture coin. */
const PAGE_INTENT = /^fxs-\d+$/;

/** A route's parts after `/api/`, decoded; null when it is not one under `/api/` or does not decode. */
function partsOf(pathname: string): string[] | null {
  const [api, ...rest] = pathname.split("/").filter(Boolean);
  if (api !== "api") return null;
  try {
    return rest.map((part) => decodeURIComponent(part));
  } catch {
    return null;
  }
}

/** The store's answer to a route, or null when the launch's other fixture answers it. */
async function storeAnswer(
  state: StoreState,
  route: string,
  init: Parameters<GalleryRequest>[1],
): Promise<GalleryAnswer | null> {
  const [pathname = "", search = ""] = route.split("?");
  const parts = partsOf(pathname);
  if (!parts) return null;
  const method = init.method ?? "GET";
  // Ids sit at every other place after the section: games/:slug/items, projects/:id/allowances/:sku.
  const shape = parts.map((part, index) => (index % 2 === 0 && index > 0 ? ":" : part)).join("/");
  const handler = ROUTES[`${method} ${shape}`];
  const ids = parts.filter((_, index) => index % 2 === 0 && index > 0);
  const otherIntent = parts[0] === "coin" && parts[1] === "intents" && !PAGE_INTENT.test(ids[0] ?? "");
  if (!handler || otherIntent) return parts[0] === "store" ? refuse(HTTP.NotFound, StoreRefusal.NotFound) : null;
  const signedIn = takenAccount(init.token) !== null;
  const call: Call = { query: new URLSearchParams(search), body: init.body, token: init.token, signedIn, ids };
  return handler(state, call);
}

/** The account's holdings and its games' shared items when the launch starts. */
function seedState(deps: FixtureStoreDeps): StoreState {
  const owned = new Map<string, Owned>([
    [FixtureStoreItem.KnightHelmet, { remaining: null, acquiredAt: Date.parse("2026-10-01T10:00:00.000Z") }],
    [FixtureStoreItem.RagePotion, { remaining: 2, acquiredAt: Date.parse("2026-10-10T10:00:00.000Z") }],
    [FixtureStoreItem.NeonSkateboard, { remaining: null, acquiredAt: Date.parse("2026-09-20T10:00:00.000Z") }],
  ]);
  const live = (skuId: string): [string, Allowance] => [
    allowanceKey("snowball", skuId),
    {
      skuId,
      slug: "snowball",
      state: AllowanceState.Active,
      addedAt: Date.parse("2026-10-05T10:00:00.000Z"),
      removedAt: null,
      live: true,
    },
  ];
  const allowances = new Map([live(FixtureStoreItem.PhoenixWings), live(FixtureStoreItem.LegendarySword)]);
  return {
    deps,
    items: seedItems(),
    owned,
    allowances,
    intents: new Map(),
    games: new Map(),
    spent: 0,
    reports: 0,
    made: 0,
  };
}

/**
 * One launch's store, as a request: genex.games' store routes, its creator SKU routes, the page
 * purchases it started and the balance they spend are answered here; every other route goes to
 * `deps.fallback`, the launch's other fixture answers.
 */
export function createFixtureStore(deps: FixtureStoreDeps): GalleryRequest {
  const state = seedState(deps);
  return async (route, init) => (await storeAnswer(state, route, init)) ?? deps.fallback(route, init);
}
