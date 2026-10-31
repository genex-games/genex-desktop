/**
 * The store client (marketplace plan 10.1): main reads genex.games' `/api/store` routes and the
 * creator `/api/coin` routes as the app's Genex account and hands the renderer only what reads as
 * an item. What genex.games answers is hostile input: an item whose id, name, type or price cannot
 * be trusted is left out, a malformed extra reads as absent, text loses the characters that turn it
 * around or control a terminal, and an id that is not one is never sent. A refusal comes back as its
 * code; an outage throws.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CoinIntentStatus } from "../../src/main/play/coin.ts";
import { type GalleryAnswer, GalleryError, type GalleryRequest } from "../../src/main/play/gallery.ts";
import { playStore, StoreRoute } from "../../src/main/play/store.ts";
import {
  AllowanceState,
  BROWSE_PAGE_SIZE,
  ItemPlace,
  ItemReportReason,
  ItemState,
  ItemType,
  StoreRefusal,
} from "../../src/shared/store-items.ts";

const TOKEN = "genex-cli-token";
const ICON = "https://assets.genex.games/items/sku1/icon.webp";
const MODEL = "https://assets.genex.games/items/sku1/model.glb";
/** Direction and control characters a server could hide in an item's words, by code point. */
const RLO = String.fromCodePoint(0x202e);
const PDF = String.fromCodePoint(0x202c);
const ESC = String.fromCodePoint(0x1b);
const NUL = String.fromCodePoint(0);

/** A Store card as genex.games serves one. */
const served = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "sku1",
  name: "Legendary Sword",
  description: "A blade from the old forge.",
  iconUrl: ICON,
  modelUrl: MODEL,
  type: "durable",
  priceCoins: 50_000,
  priceDisplayUsdCents: 50_000,
  shared: true,
  gamesCount: 4,
  homeGame: { slug: "stick-steel", title: "Stick & Steel" },
  owned: false,
  remaining: null,
  ...overrides,
});

/** A Selling row as genex.games serves one. */
const sellingRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "sku9",
  name: "Frost Axe",
  iconUrl: ICON,
  type: "durable",
  game: { id: "proj1", slug: "snowball", title: "Snowball" },
  gamesCount: 1,
  state: "draft",
  underReview: false,
  shareable: true,
  priceCoins: 1200,
  priceDisplayUsdCents: 1200,
  sold: 0,
  earned: 0,
  ...overrides,
});

/** An item as its author reads it back (`CreatorSku`). */
const creatorSku = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "sku9",
  projectId: "proj1",
  type: "durable",
  name: "Frost Axe",
  description: "Freezes on hit.",
  tags: ["axe", "ice"],
  iconUrl: ICON,
  modelUrl: null,
  priceCoins: 1200,
  priceDisplayUsdCents: 1200,
  state: "on_sale",
  active: true,
  shareable: true,
  resellable: false,
  retired: false,
  packageManifest: null,
  publishedAt: "2026-10-22T10:00:00.000Z",
  takenDownAt: null,
  createdAt: "2026-10-21T10:00:00.000Z",
  ...overrides,
});

/** A Browse item as genex.games serves one. */
const browseItem = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "sku5",
  name: "Phoenix Wings",
  description: "Wings of fire.",
  iconUrl: ICON,
  modelUrl: null,
  type: "durable",
  priceCoins: 8000,
  priceDisplayUsdCents: 8000,
  tags: ["wings", "fire"],
  author: { id: "user2", name: "Matthew G", handle: "matthewg" },
  homeGame: { slug: "skate-dog", title: "Skate Dog" },
  gamesCount: 7,
  youGetPerSale: 1200,
  ...overrides,
});

/** A page purchase's intent as genex.games serves one. */
const intent = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "int1",
  status: "requires_confirmation",
  projectId: "proj-ss",
  skuId: "sku1",
  orderId: null,
  description: null,
  projectName: "Stick & Steel",
  failureCode: null,
  name: "Legendary Sword",
  iconUrl: ICON,
  quantity: 1,
  unitPriceCoins: 50_000,
  totalCoins: 50_000,
  priceDisplayUsdCents: 50_000,
  expiresAt: "2026-10-23T12:02:00.000Z",
  confirmUrl: "https://genex.games/confirm/int1",
  ...overrides,
});

interface Call {
  route: string;
  method: string;
  body?: unknown;
  token?: string;
}

const ok = (body: unknown): GalleryAnswer => ({ status: 200, body });
const refusal = (status: number, error: unknown): GalleryAnswer => ({ status, body: { error } });

/** The store client over a recording fake of genex.games: `answer` decides each reply. */
/** `token` null: no Genex account is unlocked. */
function rig(answer: (call: Call) => GalleryAnswer, token: string | null = TOKEN) {
  const calls: Call[] = [];
  const refused: string[] = [];
  const request: GalleryRequest = async (route, init) => {
    const call = { route, method: init.method ?? "GET", body: init.body, token: init.token };
    calls.push(call);
    return answer(call);
  };
  const store = playStore({
    request,
    token: async () => token ?? undefined,
    now: () => 0,
    refused: (gone) => refused.push(gone),
  });
  return { store, calls, refused };
}

/** The one item a tab reads from `item` as genex.games served it, or undefined when it was left out. */
async function readCard(item: unknown) {
  const { store } = rig(() => ok({ items: [item], myItemsCount: 1 }));
  return (await store.items("stick-steel")).items[0];
}

describe("A game's Store tab", () => {
  it("reads every card as genex.games serves it, as the account", async () => {
    const { store, calls } = rig(() =>
      ok({ items: [served(), served({ id: "sku2", type: "consumable", owned: true, remaining: 2 })], myItemsCount: 6 }),
    );
    const tab = await store.items("stick-steel");
    assert.deepEqual(tab.items[0], {
      id: "sku1",
      name: "Legendary Sword",
      description: "A blade from the old forge.",
      iconUrl: ICON,
      modelUrl: MODEL,
      type: ItemType.Durable,
      priceCoins: 50_000,
      priceDisplayUsdCents: 50_000,
      shared: true,
      gamesCount: 4,
      homeGame: { slug: "stick-steel", title: "Stick & Steel" },
      owned: false,
      remaining: null,
    });
    assert.deepEqual([tab.items[1]?.owned, tab.items[1]?.remaining], [true, 2]);
    assert.equal(tab.myItemsCount, 6);
    assert.deepEqual(calls, [{ route: StoreRoute.items("stick-steel"), method: "GET", body: undefined, token: TOKEN }]);
  });

  it("is read anonymously while signed out: owning is unknown and there is no My items count", async () => {
    const { store, calls } = rig(() => ok({ items: [served({ owned: undefined, remaining: undefined })] }), null);
    const tab = await store.items("stick-steel");
    assert.deepEqual([tab.items[0]?.owned, tab.items[0]?.remaining, tab.myItemsCount], [null, null, null]);
    assert.equal(calls[0]?.token, undefined);
  });

  it("is empty when the store is off or genex.games knows no such game, so the section hides", async () => {
    for (const code of [StoreRefusal.NotFound, StoreRefusal.GameNotFound]) {
      const { store } = rig(() => refusal(404, code));
      assert.deepEqual(await store.items("stick-steel"), { items: [], myItemsCount: null }, code);
    }
  });

  it("ends a sign-in genex.games refuses and reads the tab again as a guest", async () => {
    const { store, calls, refused } = rig((call) =>
      call.token ? { status: 401, body: { error: "unauthorized" } } : ok({ items: [served()] }),
    );
    const tab = await store.items("stick-steel");
    assert.equal(tab.items.length, 1);
    assert.deepEqual(refused, [TOKEN]);
    assert.deepEqual(
      calls.map((call) => call.token),
      [TOKEN, undefined],
    );
  });

  it("throws for an outage and for an answer that is no tab, and never asks for a game that is not one", async () => {
    await assert.rejects(rig(() => ({ status: 503, body: null })).store.items("stick-steel"), GalleryError);
    await assert.rejects(rig(() => ok({ items: "nope" })).store.items("stick-steel"), GalleryError);
    const { store, calls } = rig(() => ok({ items: [] }));
    for (const slug of ["../admin", "Stick Steel", "", "a/b"]) await assert.rejects(store.items(slug), slug);
    assert.deepEqual(calls, []);
  });
});

describe("An item genex.games serves is hostile input", () => {
  const LEFT_OUT: Array<[string, Record<string, unknown>]> = [
    ["an oversized name", { name: "x".repeat(81) }],
    ["a name of nothing but direction controls and spaces", { name: `${RLO} ${PDF} ` }],
    ["a name that is not text", { name: 42 }],
    ["an id that is a path", { id: "../../api/admin" }],
    ["an id with a slash", { id: "sku/1" }],
    ["an id that is too long", { id: "a".repeat(65) }],
    ["an id that is a number", { id: 7 }],
    ["a price written as text", { priceCoins: "100" }],
    ["a negative price", { priceCoins: -1 }],
    ["a fractional price", { priceCoins: 1.5 }],
    ["a price over what Studio may confirm", { priceCoins: 100_001 }],
    ["a huge price", { priceCoins: 1e21 }],
    ["a negative dollar value", { priceDisplayUsdCents: -5 }],
    ["an unknown type", { type: "weapon" }],
    ["a shared flag that is not a boolean", { shared: "yes" }],
    ["an oversized description", { description: "d".repeat(1001) }],
  ];
  for (const [what, overrides] of LEFT_OUT) {
    it(`leaves out a card with ${what}`, async () => {
      assert.equal(await readCard(served(overrides)), undefined);
    });
  }

  const ABSENT: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
    ["a negative games count", { gamesCount: -3 }, { gamesCount: 0 }],
    ["a games count written as text", { gamesCount: "4" }, { gamesCount: 0 }],
    ["a remaining count below zero", { remaining: -1 }, { remaining: null }],
    ["an owned flag that is not a boolean", { owned: "true" }, { owned: null }],
    ["a picture over plain http", { iconUrl: "http://assets.genex.games/x.webp" }, { iconUrl: null }],
    ["a picture on another host", { iconUrl: "https://evil.example/x.webp" }, { iconUrl: null }],
    ["a script address as its picture", { iconUrl: "javascript:alert(1)" }, { iconUrl: null }],
    ["a model on another host", { modelUrl: "https://evil.example/m.glb" }, { modelUrl: null }],
    // The sheet fetches a model itself, so only Genex's asset hosts (renderer CSP connect-src) hold one:
    // a picture host the window only shows images from is not one.
    ["a model on a picture-only host", { modelUrl: "https://lh3.googleusercontent.com/m.glb" }, { modelUrl: null }],
    ["a model on the covers CDN", { modelUrl: "https://cdn.genex.technology/m.glb" }, { modelUrl: null }],
    ["a model over plain http", { modelUrl: "http://assets.genex.technology/m.glb" }, { modelUrl: null }],
    ["a home game whose slug is a path", { homeGame: { slug: "../x", title: "X" } }, { homeGame: null }],
    ["a home game with no title", { homeGame: { slug: "x" } }, { homeGame: null }],
    ["a description that is not text", { description: 12 }, { description: null }],
  ];
  for (const [what, overrides, read] of ABSENT) {
    it(`reads ${what} as absent`, async () => {
      const card = await readCard(served(overrides));
      assert.ok(card, what);
      for (const [key, value] of Object.entries(read)) assert.deepEqual(card[key as keyof typeof card], value, key);
    });
  }

  it("keeps a model on either of Genex's asset hosts", async () => {
    for (const modelUrl of [MODEL, "https://assets.genex.technology/items/sku1/model-1.glb"]) {
      assert.equal((await readCard(served({ modelUrl })))?.modelUrl, modelUrl);
    }
  });

  it("takes the direction and control characters out of an item's words", async () => {
    const card = await readCard(
      served({ name: `Sword${RLO} of 9${PDF}${ESC}[31m`, description: `Line one${NUL}\nline ${RLO}two` }),
    );
    assert.equal(card?.name, "Sword of 9[31m");
    assert.equal(card?.description, "Line one\nline two");
  });

  it("keeps a tab to a bounded number of cards", async () => {
    const many = Array.from({ length: 450 }, (_, index) => served({ id: `sku${index}` }));
    const { store } = rig(() => ok({ items: many }));
    assert.equal((await store.items("stick-steel")).items.length, 400);
  });

  it("reads a My items count that is not a whole number as unknown", async () => {
    for (const count of [-1, "6", 1.5]) {
      const { store } = rig(() => ok({ items: [], myItemsCount: count }));
      assert.equal((await store.items("stick-steel")).myItemsCount, null, String(count));
    }
  });
});

describe("My items", () => {
  const mine = (overrides: Record<string, unknown> = {}) =>
    served({ place: "works_here", remaining: null, acquiredAt: "2026-10-20T10:00:00.000Z", ...overrides });

  it("reads the items the player owns, each marked for this game", async () => {
    const { store, calls } = rig(() =>
      ok({ items: [mine(), mine({ id: "sku7", place: "not_in_this_game", type: "consumable", remaining: 2 })] }),
    );
    const items = await store.myItems("stick-steel");
    assert.ok(Array.isArray(items));
    assert.deepEqual(
      items.map((item) => [item.id, item.place, item.remaining, item.acquiredAt]),
      [
        ["sku1", ItemPlace.WorksHere, null, Date.parse("2026-10-20T10:00:00.000Z")],
        ["sku7", ItemPlace.NotInThisGame, 2, Date.parse("2026-10-20T10:00:00.000Z")],
      ],
    );
    assert.deepEqual(calls[0], {
      route: StoreRoute.myItems("stick-steel"),
      method: "GET",
      body: undefined,
      token: TOKEN,
    });
  });

  it("leaves out a row with an unknown place or no time it was acquired", async () => {
    const { store } = rig(() => ok({ items: [mine({ place: "elsewhere" }), mine({ acquiredAt: "soon" }), mine()] }));
    const items = await store.myItems("stick-steel");
    assert.ok(Array.isArray(items));
    assert.equal(items.length, 1);
  });

  it("asks a signed-out player to sign in without calling genex.games", async () => {
    const { store, calls } = rig(() => ok({ items: [] }), null);
    assert.deepEqual(await store.myItems("stick-steel"), { refused: StoreRefusal.Unauthorized });
    assert.deepEqual(calls, []);
  });

  it("ends a sign-in genex.games refuses", async () => {
    const { store, refused } = rig(() => refusal(401, "unauthorized"));
    assert.deepEqual(await store.myItems("stick-steel"), { refused: StoreRefusal.Unauthorized });
    assert.deepEqual(refused, [TOKEN]);
  });
});

describe("Works in N games, the shelf and a complaint", () => {
  it("reads at most eight games, and never a total below what it lists", async () => {
    const game = (index: number) => ({ slug: `game-${index}`, title: `Game ${index}`, coverUrl: ICON });
    const { store, calls } = rig(() => ok({ total: 3, games: Array.from({ length: 12 }, (_, i) => game(i)) }));
    const games = await store.itemGames("sku1");
    assert.equal(games.games.length, 8);
    assert.equal(games.total, 8);
    assert.equal(calls[0]?.route, StoreRoute.itemGames("sku1"));
    assert.equal(calls[0]?.token, undefined, "a public read carries no token");
  });

  it("reads an unknown item's games as none", async () => {
    const { store } = rig(() => refusal(404, "sku_not_found"));
    assert.deepEqual(await store.itemGames("sku1"), { total: 0, games: [] });
  });

  it("reads at most five shelf items, and none for a person genex.games does not know", async () => {
    const shelfItem = (index: number) => ({
      id: `sku${index}`,
      name: `Item ${index}`,
      iconUrl: ICON,
      modelUrl: null,
      game: index === 0 ? null : { slug: "stick-steel", title: "Stick & Steel" },
    });
    const { store } = rig(() => ok({ items: Array.from({ length: 7 }, (_, i) => shelfItem(i)) }));
    const shelf = await store.shelf("user1");
    assert.equal(shelf.length, 5);
    assert.equal(shelf[0]?.game, null);
    assert.deepEqual(await rig(() => refusal(404, "user_not_found")).store.shelf("user1"), []);
    await assert.rejects(store.shelf("../me"));
  });

  it("reads whether the shelf's game still sells each item, and an API that does not say as still selling it", async () => {
    const shelfItem = (onSale: unknown) => ({
      id: "sku1",
      name: "Rage Potion",
      iconUrl: ICON,
      modelUrl: null,
      game: { slug: "stick-steel", title: "Stick & Steel" },
      ...(onSale === undefined ? {} : { onSale }),
    });
    // At most five: the shelf's own limit.
    const answers = [false, true, undefined, "false", null];
    const { store } = rig(() => ok({ items: answers.map(shelfItem) }));
    const shelf = await store.shelf("user1");
    assert.deepEqual(
      shelf.map((item) => item.onSale),
      [false, true, true, true, true],
    );
  });

  it("keeps a shelf item's game cover for Get in <game> only from a host the app loads pictures from", async () => {
    const shelfItem = (coverUrl: unknown) => ({
      id: "sku1",
      name: "Phoenix Wings",
      iconUrl: ICON,
      modelUrl: null,
      game: { slug: "midnight-asphalt", title: "Midnight Asphalt", coverUrl },
    });
    const covers = ["https://cdn.genex.technology/covers/ma.webp", "https://evil.example/ma.webp", 7, undefined];
    const { store } = rig(() => ok({ items: covers.map(shelfItem) }));
    const shelf = await store.shelf("user1");
    assert.deepEqual(
      shelf.map((item) => item.game),
      [
        {
          slug: "midnight-asphalt",
          title: "Midnight Asphalt",
          coverUrl: "https://cdn.genex.technology/covers/ma.webp",
        },
        { slug: "midnight-asphalt", title: "Midnight Asphalt", coverUrl: null },
        { slug: "midnight-asphalt", title: "Midnight Asphalt", coverUrl: null },
        { slug: "midnight-asphalt", title: "Midnight Asphalt", coverUrl: null },
      ],
    );
  });

  it("sends a complaint with its reason and a trimmed message, as the account when there is one", async () => {
    const { store, calls } = rig(() => ({ status: 201, body: { ok: true } }));
    assert.equal(await store.report("sku1", ItemReportReason.Copy, "  It is my sword.  "), true);
    assert.equal(await store.report("sku1", ItemReportReason.Scam, "   "), true);
    assert.deepEqual(
      calls.map((call) => [call.route, call.method, call.body, call.token]),
      [
        [StoreRoute.reports("sku1"), "POST", { reason: "copy", message: "It is my sword." }, TOKEN],
        [StoreRoute.reports("sku1"), "POST", { reason: "scam" }, TOKEN],
      ],
    );
    const anonymous = rig(() => ({ status: 201, body: { ok: true } }), null);
    await anonymous.store.report("sku1", ItemReportReason.Broken, null);
    assert.equal(anonymous.calls[0]?.token, undefined);
  });

  it("reads the report limiter's answer, and refuses a message or reason it would not take before sending", async () => {
    const { store, calls } = rig(() => ({ status: 429, body: { error: "Too many requests" } }));
    assert.deepEqual(await store.report("sku1", ItemReportReason.Copy, null), {
      refused: StoreRefusal.TooManyRequests,
    });
    calls.length = 0;
    await assert.rejects(store.report("sku1", ItemReportReason.Copy, "m".repeat(501)));
    await assert.rejects(store.report("sku1", "spam" as ItemReportReason, null));
    assert.deepEqual(calls, []);
  });
});

describe("Buying and claiming from a game's page", () => {
  it("starts a purchase of one item for the game whose page it is", async () => {
    const { store, calls } = rig(() => ok(intent()));
    const started = await store.purchase("sku1", "stick-steel");
    assert.ok(!("refused" in started));
    assert.deepEqual(
      [started.id, started.status, started.projectId, started.totalCoins],
      ["int1", CoinIntentStatus.RequiresConfirmation, "proj-ss", 50_000],
    );
    assert.deepEqual(calls, [
      { route: StoreRoute.purchase("sku1"), method: "POST", body: { slug: "stick-steel" }, token: TOKEN },
    ]);
  });

  it("answers genex.games' refusals by their codes", async () => {
    const cases: Array<[number, string | null, StoreRefusal]> = [
      [409, "already_owned", StoreRefusal.AlreadyOwned],
      [409, "not_sold_here", StoreRefusal.NotSoldHere],
      [409, "item_off_sale", StoreRefusal.ItemOffSale],
      [409, "free_item", StoreRefusal.FreeItem],
      [404, "sku_not_found", StoreRefusal.SkuNotFound],
      [404, "not_found", StoreRefusal.NotFound],
      [403, "forbidden_origin", StoreRefusal.ForbiddenOrigin],
      [409, "something_new", StoreRefusal.Unknown],
      [400, null, StoreRefusal.Unknown],
      [401, "unauthorized", StoreRefusal.Unauthorized],
    ];
    for (const [status, code, read] of cases) {
      const { store, refused } = rig(() => refusal(status, code));
      assert.deepEqual(await store.purchase("sku1", "stick-steel"), { refused: read }, String(code));
      assert.deepEqual(refused, [], "a write never ends the sign-in");
    }
  });

  it("asks a signed-out player to sign in without starting anything", async () => {
    const { store, calls } = rig(() => ok(intent()), null);
    assert.deepEqual(await store.purchase("sku1", "stick-steel"), { refused: StoreRefusal.Unauthorized });
    assert.deepEqual(calls, []);
  });

  it("throws for an answer that is not this item's purchase of one, or an outage", async () => {
    const bad = [
      intent({ skuId: "sku2" }),
      intent({ quantity: 2, totalCoins: 100_000 }),
      intent({ id: "../x" }),
      intent({ totalCoins: 100_001, unitPriceCoins: 100_001 }),
      intent({ name: `${RLO}` }),
      "nope",
    ];
    for (const body of bad)
      await assert.rejects(rig(() => ok(body)).store.purchase("sku1", "stick-steel"), GalleryError);
    await assert.rejects(rig(() => ({ status: 502, body: null })).store.purchase("sku1", "stick-steel"), GalleryError);
  });

  it("never sends an item or a game that is not one", async () => {
    const { store, calls } = rig(() => ok(intent()));
    await assert.rejects(store.purchase("../sku", "stick-steel"));
    await assert.rejects(store.purchase("sku1", "Stick Steel"));
    await assert.rejects(store.claim("sku 1", "stick-steel"));
    assert.deepEqual(calls, []);
  });

  it("claims a Free item, and reads a replay as the same claim", async () => {
    const { store, calls } = rig(() => ok({ entitlementId: "ent1", skuId: "sku6", replayed: true }));
    assert.deepEqual(await store.claim("sku6", "stick-steel"), { itemId: "sku6", replayed: true });
    assert.deepEqual(calls[0], {
      route: StoreRoute.claim("sku6"),
      method: "POST",
      body: { slug: "stick-steel" },
      token: TOKEN,
    });
    assert.deepEqual(await rig(() => refusal(409, "not_free")).store.claim("sku6", "stick-steel"), {
      refused: StoreRefusal.NotFree,
    });
    await assert.rejects(
      rig(() => ok({ entitlementId: "ent1", skuId: "other", replayed: false })).store.claim("sku6", "stick-steel"),
      GalleryError,
    );
  });
});

describe("Create › Items: Browse", () => {
  it("asks for a page with the search, its tags, the cursor and the page size", async () => {
    const { store, calls } = rig(() => ok({ items: [browseItem()], nextCursor: "c2" }));
    const page = await store.browse({ query: "  wings ", cursor: "c1", tags: [" Fire ", "fire", "WINGS"] });
    assert.ok(!("refused" in page));
    assert.equal(page.nextCursor, "c2");
    assert.deepEqual(page.items[0], {
      id: "sku5",
      name: "Phoenix Wings",
      description: "Wings of fire.",
      iconUrl: ICON,
      modelUrl: null,
      type: ItemType.Durable,
      priceCoins: 8000,
      priceDisplayUsdCents: 8000,
      tags: ["wings", "fire"],
      author: { id: "user2", name: "Matthew G", handle: "matthewg" },
      homeGame: { slug: "skate-dog", title: "Skate Dog" },
      gamesCount: 7,
      youGetPerSale: 1200,
    });
    const url = new URL(calls[0]?.route ?? "", "https://api.test");
    assert.equal(url.pathname, StoreRoute.Catalog);
    assert.deepEqual(Object.fromEntries(url.searchParams), {
      q: "wings",
      tags: "fire,wings",
      cursor: "c1",
      limit: String(BROWSE_PAGE_SIZE),
    });
    assert.equal(calls[0]?.token, TOKEN);
  });

  it("sends no empty search, cursor or tags, and drops a tag a comma would split", async () => {
    const { store, calls } = rig(() => ok({ items: [], nextCursor: null }));
    await store.browse({ query: "   ", cursor: null, tags: ["a,b", "x".repeat(33), ""] });
    const url = new URL(calls[0]?.route ?? "", "https://api.test");
    assert.deepEqual(Object.fromEntries(url.searchParams), { limit: String(BROWSE_PAGE_SIZE) });
    await assert.rejects(store.browse({ query: "", cursor: "../next", tags: [] }));
  });

  it("leaves out an item with no author it can name, and reads a cursor that is not one as the last page", async () => {
    const { store } = rig(() =>
      ok({
        items: [browseItem({ author: null }), browseItem({ id: "sku6", tags: ["ok", 5, "t".repeat(40)] })],
        nextCursor: "has spaces",
      }),
    );
    const page = await store.browse({ query: "", cursor: null, tags: [] });
    assert.ok(!("refused" in page));
    assert.deepEqual(
      page.items.map((item) => [item.id, item.tags]),
      [["sku6", ["ok"]]],
    );
    assert.equal(page.nextCursor, null);
  });

  it("reads the selling game's share genex.games configures, and none from an older API or a value that is no share", async () => {
    const rows: Array<[string, unknown, number | undefined]> = [
      ["the configured share", 1500, 1500],
      ["no share at all", 0, 0],
      ["an older API that sends none", undefined, undefined],
      ["null", null, undefined],
      ["text", "1500", undefined],
      ["a fraction", 1500.5, undefined],
      ["below nothing", -1, undefined],
      ["the whole sale", 10_000, undefined],
      ["past the whole sale", 1e9, undefined],
    ];
    for (const [name, sent, read] of rows) {
      const body = { items: [browseItem()], nextCursor: null, ...(sent === undefined ? {} : { sellerShareBps: sent }) };
      const page = await rig(() => ok(body)).store.browse({ query: "", cursor: null, tags: [] });
      assert.ok(!("refused" in page));
      assert.equal(page.sellerShareBps, read, `Browse: ${name}`);
      const detailBody = { item: browseItem(), addedTo: [], ...(sent === undefined ? {} : { sellerShareBps: sent }) };
      const detail = await rig(() => ok(detailBody)).store.browseDetail("sku5");
      assert.ok(!("refused" in detail));
      assert.equal(detail.sellerShareBps, read, `detail: ${name}`);
    }
  });

  it("answers a signed-out account and a store that is off by their codes", async () => {
    assert.deepEqual(await rig(() => ok({}), null).store.browse({ query: "", cursor: null, tags: [] }), {
      refused: StoreRefusal.Unauthorized,
    });
    assert.deepEqual(await rig(() => refusal(404, "not_found")).store.browse({ query: "", cursor: null, tags: [] }), {
      refused: StoreRefusal.NotFound,
    });
  });

  it("reads the detail panel: the package in short and the account's games it was added to", async () => {
    const { store, calls } = rig(() =>
      ok({
        item: browseItem(),
        packageManifest: {
          files: [
            { path: "wings.glb", bytes: 1000, sha256: "a" },
            { path: "wings.js", bytes: 24, sha256: "b" },
          ],
        },
        addedTo: [
          { projectId: "proj1", slug: "snowball", title: "Snowball", liveFromBuildAt: "2026-10-22T10:00:00.000Z" },
          { projectId: "proj2", slug: "claude-of-duty", title: "Claude of Duty", liveFromBuildAt: null },
          { projectId: "../x", slug: "bad", title: "Bad", liveFromBuildAt: null },
        ],
      }),
    );
    const detail = await store.browseDetail("sku5");
    assert.ok(!("refused" in detail));
    assert.deepEqual(detail.package, { files: 2, bytes: 1024 });
    assert.deepEqual(detail.addedTo, [
      { projectId: "proj1", slug: "snowball", title: "Snowball", live: true },
      { projectId: "proj2", slug: "claude-of-duty", title: "Claude of Duty", live: false },
    ]);
    assert.equal(calls[0]?.route, StoreRoute.catalogItem("sku5"));
    await assert.rejects(rig(() => ok({ item: browseItem({ id: "sku6" }) })).store.browseDetail("sku5"), GalleryError);
  });
});

describe("Create › Items: adding a shared item to a game", () => {
  const allowance = (overrides: Record<string, unknown> = {}) => ({
    skuId: "sku5",
    projectId: "proj1",
    state: "active",
    addedAt: "2026-10-23T08:00:00.000Z",
    removedAt: null,
    liveFromBuildAt: null,
    ...overrides,
  });

  it("adds it to the game the account owns, and reads the allowance back", async () => {
    const { store, calls } = rig(() => ok({ allowance: allowance(), package: null, replayed: false }));
    assert.deepEqual(await store.addToGame("sku5", "proj1"), {
      allowance: {
        itemId: "sku5",
        projectId: "proj1",
        state: AllowanceState.Active,
        addedAt: Date.parse("2026-10-23T08:00:00.000Z"),
        liveAt: null,
      },
      replayed: false,
    });
    assert.deepEqual(calls[0], {
      route: StoreRoute.allowances("proj1"),
      method: "POST",
      body: { skuId: "sku5" },
      token: TOKEN,
    });
  });

  it("removes it, and answers refusals by their codes", async () => {
    const { store, calls } = rig(() => ok({ allowance: allowance({ state: "removed" }) }));
    const removed = await store.removeFromGame("sku5", "proj1");
    assert.ok(!("refused" in removed));
    assert.equal(removed.state, AllowanceState.Removed);
    assert.deepEqual([calls[0]?.route, calls[0]?.method], [StoreRoute.allowance("proj1", "sku5"), "DELETE"]);
    for (const code of ["not_shareable", "home_game", "item_off_sale", "taken_down", "project_not_found"]) {
      assert.deepEqual(await rig(() => refusal(409, code)).store.addToGame("sku5", "proj1"), { refused: code }, code);
    }
  });

  it("throws for an allowance of another item or game, and never sends a game id that is not one", async () => {
    await assert.rejects(rig(() => ok({ allowance: allowance({ skuId: "sku6" }) })).store.addToGame("sku5", "proj1"));
    await assert.rejects(rig(() => ok({ allowance: allowance({ state: "gone" }) })).store.addToGame("sku5", "proj1"));
    const { store, calls } = rig(() => ok({ allowance: allowance() }));
    await assert.rejects(store.addToGame("sku5", "../proj"));
    await assert.rejects(store.removeFromGame("sku5", "proj/1"));
    assert.deepEqual(calls, []);
  });
});

describe("Create › Items: Selling", () => {
  it("reads the strip and the rows", async () => {
    const { store, calls } = rig(() =>
      ok({
        earnedReady: 48_200,
        earnedHeld: 36_800,
        nextReleaseAt: "2026-10-26T00:00:00.000Z",
        holdDays: 7,
        items: [sellingRow(), sellingRow({ id: "sku10", state: "on_sale", underReview: true, sold: 2, earned: 1360 })],
      }),
    );
    const selling = await store.selling();
    assert.ok(!("refused" in selling));
    assert.deepEqual([selling.earnedReady, selling.earnedHeld, selling.holdDays], [48_200, 36_800, 7]);
    assert.equal(selling.nextReleaseAt, Date.parse("2026-10-26T00:00:00.000Z"));
    assert.deepEqual(selling.items[0], {
      id: "sku9",
      name: "Frost Axe",
      iconUrl: ICON,
      type: ItemType.Durable,
      game: { id: "proj1", slug: "snowball", title: "Snowball" },
      gamesCount: 1,
      state: ItemState.Draft,
      underReview: false,
      shareable: true,
      priceCoins: 1200,
      priceDisplayUsdCents: 1200,
      sold: 0,
      earned: 0,
    });
    assert.equal(selling.items[1]?.underReview, true);
    assert.deepEqual([calls[0]?.route, calls[0]?.token], [StoreRoute.Selling, TOKEN]);
  });

  it("leaves out a row it cannot trust, and throws for a strip that is not coin", async () => {
    const strip = { earnedReady: 1, earnedHeld: 2, nextReleaseAt: null, holdDays: 7 };
    const { store } = rig(() =>
      ok({
        ...strip,
        items: [sellingRow({ state: "sold_out" }), sellingRow({ sold: -1 }), sellingRow({ earned: "5" }), sellingRow()],
      }),
    );
    const selling = await store.selling();
    assert.ok(!("refused" in selling));
    assert.equal(selling.items.length, 1);
    for (const broken of [{ earnedReady: -1 }, { earnedHeld: "2" }, { holdDays: 1.5 }]) {
      await assert.rejects(rig(() => ok({ ...strip, ...broken, items: [] })).store.selling(), GalleryError);
    }
  });
});

describe("Create › Items: the author's actions", () => {
  it("puts an item on sale, takes it off and lets other games use it, each on its own route", async () => {
    const { store, calls } = rig((call) =>
      ok(creatorSku({ state: call.route.endsWith("/unpublish") ? "off_sale" : "on_sale" })),
    );
    const put = await store.putOnSale("sku9");
    assert.ok(!("refused" in put));
    assert.equal(put.state, ItemState.OnSale);
    assert.equal(put.publishedAt, Date.parse("2026-10-22T10:00:00.000Z"));
    const off = await store.takeOffSale("sku9");
    assert.ok(!("refused" in off));
    assert.equal(off.state, ItemState.OffSale);
    await store.setShared("sku9", false);
    assert.deepEqual(
      calls.map((call) => [call.route, call.method, call.body, call.token]),
      [
        [StoreRoute.publish("sku9"), "POST", undefined, TOKEN],
        [StoreRoute.unpublish("sku9"), "POST", undefined, TOKEN],
        [StoreRoute.sku("sku9"), "PATCH", { shareable: false }, TOKEN],
      ],
    );
  });

  it("answers a refused publish by its code", async () => {
    for (const code of ["picture_missing", "name_refused", "price_off_grid", "publish_rate_limited", "taken_down"]) {
      const status = code === "publish_rate_limited" ? 429 : 422;
      assert.deepEqual(await rig(() => refusal(status, code)).store.putOnSale("sku9"), { refused: code }, code);
    }
    assert.deepEqual(await rig(() => refusal(400, "not_durable")).store.setShared("sku9", true), {
      refused: StoreRefusal.NotDurable,
    });
  });

  it("throws for an answer about another item or one it cannot read, and never sends a bad id or flag", async () => {
    await assert.rejects(rig(() => ok(creatorSku({ id: "sku8" }))).store.putOnSale("sku9"), GalleryError);
    await assert.rejects(rig(() => ok(creatorSku({ state: "live" }))).store.putOnSale("sku9"), GalleryError);
    await assert.rejects(rig(() => ok(creatorSku({ name: "n".repeat(81) }))).store.takeOffSale("sku9"), GalleryError);
    const { store, calls } = rig(() => ok(creatorSku()));
    await assert.rejects(store.putOnSale("sku 9"));
    await assert.rejects(store.setShared("sku9", "yes" as unknown as boolean));
    assert.deepEqual(calls, []);
  });

  it("asks a signed-out author to sign in without calling genex.games", async () => {
    const { store, calls } = rig(() => ok(creatorSku()), null);
    assert.deepEqual(await store.putOnSale("sku9"), { refused: StoreRefusal.Unauthorized });
    assert.deepEqual(await store.selling(), { refused: StoreRefusal.Unauthorized });
    assert.deepEqual(calls, []);
  });
});
