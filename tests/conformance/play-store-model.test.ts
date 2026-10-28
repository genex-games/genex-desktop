/**
 * A game's Store section on its Play page (marketplace plan 10.3, P5–P7), decided without a window:
 * what each card's line under its name says (price, Free, Owned; Works here, N left, Not in this
 * game), the "N games" badge of a shared item, whether the section shows at all, what pressing a
 * card offers, how the sheet goes on after `storeBuy` and `storeClaim` answer, and the profile
 * shelf's few items.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  afterBuy,
  afterClaim,
  CardLine,
  gamesBadge,
  ItemOffer,
  itemHue,
  myItemLine,
  myItemOffer,
  MyItemsStatus,
  myItemsRead,
  SheetPhase,
  sheetOpens,
  shelfGetIn,
  shelfShown,
  storeLine,
  storeOffer,
  storeShown,
} from "../../src/renderer/play/store-model.ts";
import {
  ITEM_SHELF_MAX,
  ItemPlace,
  ItemType,
  type MyItem,
  type ShelfItem,
  StoreBuyOutcome,
  type StoreItem,
  StoreRefusal,
} from "../../src/shared/store-items.ts";

/** Legendary Sword as Stick & Steel sells it: a shared durable for 50,000, not owned. */
const storeItem = (over: Partial<StoreItem> = {}): StoreItem => ({
  id: "fxi-legendary-sword",
  name: "Legendary Sword",
  description: "A blade from the old forge.",
  iconUrl: null,
  modelUrl: null,
  type: ItemType.Durable,
  priceCoins: 50_000,
  priceDisplayUsdCents: 50_000,
  shared: true,
  gamesCount: 4,
  homeGame: { slug: "stick-steel", title: "Stick & Steel" },
  owned: false,
  remaining: null,
  ...over,
});

/** An item the player owns, as My items lists it on Stick & Steel's page. */
const myItem = (over: Partial<MyItem> = {}): MyItem => ({
  ...storeItem(),
  place: ItemPlace.WorksHere,
  remaining: null,
  acquiredAt: 1_700_000_000_000,
  ...over,
});

describe("a Store card's line under its name (P6)", () => {
  it("prices an item the player does not own, and calls a price of 0 Free", () => {
    assert.deepEqual(storeLine(storeItem()), { line: CardLine.Price, coins: 50_000 });
    assert.deepEqual(storeLine(storeItem({ priceCoins: 0 })), { line: CardLine.Free });
  });

  it("says Owned for a durable the player owns, Free or paid", () => {
    assert.deepEqual(storeLine(storeItem({ owned: true })), { line: CardLine.Owned });
    assert.deepEqual(storeLine(storeItem({ owned: true, priceCoins: 0 })), { line: CardLine.Owned });
  });

  it("keeps pricing a consumable the player owns, since it is bought again (P3)", () => {
    const potion = storeItem({ type: ItemType.Consumable, priceCoins: 300, owned: true, remaining: 2 });
    assert.deepEqual(storeLine(potion), { line: CardLine.Price, coins: 300 });
  });

  it("says Owned for a Free consumable once claimed: it is claimed once per player (Q6)", () => {
    const badge = storeItem({ type: ItemType.Consumable, priceCoins: 0, owned: true, remaining: 1 });
    assert.deepEqual(storeLine(badge), { line: CardLine.Owned });
  });

  it("prices every item while signed out, when ownership is unknown", () => {
    assert.deepEqual(storeLine(storeItem({ owned: null })), { line: CardLine.Price, coins: 50_000 });
    assert.deepEqual(storeLine(storeItem({ owned: null, priceCoins: 0 })), { line: CardLine.Free });
  });
});

describe("a My items card's line (P5)", () => {
  it("says Works here for an item this game supports", () => {
    assert.deepEqual(myItemLine(myItem()), { line: CardLine.WorksHere });
  });

  it("counts what is left of a consumable that works here", () => {
    const potion = myItem({ type: ItemType.Consumable, remaining: 2 });
    assert.deepEqual(myItemLine(potion), { line: CardLine.Left, count: 2 });
  });

  it("says Not in this game for an item this game does not support, consumable or not", () => {
    assert.deepEqual(myItemLine(myItem({ place: ItemPlace.NotInThisGame })), { line: CardLine.NotHere });
    const potion = myItem({ place: ItemPlace.NotInThisGame, type: ItemType.Consumable, remaining: 2 });
    assert.deepEqual(myItemLine(potion), { line: CardLine.NotHere });
  });

  it("says Works here for a consumable genex.games gave no count for", () => {
    assert.deepEqual(myItemLine(myItem({ type: ItemType.Consumable, remaining: null })), {
      line: CardLine.WorksHere,
    });
  });
});

describe("the N games badge of a shared item (P6)", () => {
  it("shows how many games a shared item works in", () => {
    assert.equal(gamesBadge(storeItem({ shared: true, gamesCount: 7 })), 7);
  });

  it("shows nothing for an item only its own game sells, or a shared one in one game so far", () => {
    assert.equal(gamesBadge(storeItem({ shared: false, gamesCount: 1 })), null);
    assert.equal(gamesBadge(storeItem({ shared: false, gamesCount: 3 })), null);
    assert.equal(gamesBadge(storeItem({ shared: true, gamesCount: 1 })), null);
  });
});

describe("whether a game's page shows its Store section", () => {
  it("shows it once the game sells something", () => {
    assert.equal(storeShown({ items: [storeItem()], myItemsCount: 3 }), true);
  });

  it("hides it while unread, for a game that sells nothing, and with the store off (D28)", () => {
    assert.equal(storeShown(null), false);
    assert.equal(storeShown({ items: [], myItemsCount: 3 }), false);
    assert.equal(storeShown({ items: [], myItemsCount: null }), false);
  });
});

describe("what pressing a card offers", () => {
  it("buys a priced item the player does not own, and gets a Free one", () => {
    assert.equal(storeOffer(storeItem()), ItemOffer.Buy);
    assert.equal(storeOffer(storeItem({ priceCoins: 0 })), ItemOffer.Get);
  });

  it("shows a durable the player owns as theirs, and offers a consumable again", () => {
    assert.equal(storeOffer(storeItem({ owned: true })), ItemOffer.Owned);
    assert.equal(storeOffer(storeItem({ owned: true, type: ItemType.Consumable, priceCoins: 300 })), ItemOffer.Buy);
    assert.equal(storeOffer(storeItem({ owned: true, type: ItemType.Consumable, priceCoins: 0 })), ItemOffer.Owned);
  });

  it("offers what genex.games will judge while signed out: the press finds out", () => {
    assert.equal(storeOffer(storeItem({ owned: null })), ItemOffer.Buy);
    assert.equal(storeOffer(storeItem({ owned: null, priceCoins: 0 })), ItemOffer.Get);
  });

  it("in My items: more of a consumable that works here, the item as owned, or Not in this game", () => {
    assert.equal(myItemOffer(myItem({ type: ItemType.Consumable, priceCoins: 300, remaining: 2 })), ItemOffer.Buy);
    assert.equal(myItemOffer(myItem()), ItemOffer.Owned);
    assert.equal(myItemOffer(myItem({ type: ItemType.Consumable, priceCoins: 0, remaining: 1 })), ItemOffer.Owned);
    const elsewhere = myItem({ place: ItemPlace.NotInThisGame, type: ItemType.Consumable, priceCoins: 300 });
    assert.equal(myItemOffer(elsewhere), ItemOffer.NotHere);
  });
});

describe("the sheet a card opens", () => {
  it("starts the purchase for Buy, and shows the item for every other offer", () => {
    assert.equal(sheetOpens(ItemOffer.Buy), SheetPhase.Opening);
    assert.equal(sheetOpens(ItemOffer.Get), SheetPhase.Get);
    assert.equal(sheetOpens(ItemOffer.Owned), SheetPhase.Owned);
    assert.equal(sheetOpens(ItemOffer.NotHere), SheetPhase.NotHere);
  });
});

describe("how the sheet goes on once storeBuy answers", () => {
  it("closes once main's sheet closed, reading the store again after a payment", () => {
    assert.deepEqual(afterBuy({ outcome: StoreBuyOutcome.Paid }), { phase: null, reread: true });
    assert.deepEqual(afterBuy({ outcome: StoreBuyOutcome.Pending }), { phase: null, reread: true });
    assert.deepEqual(afterBuy({ outcome: StoreBuyOutcome.NotPaid }), { phase: null, reread: false });
  });

  it("says it failed when genex.games could not be read to show the purchase", () => {
    assert.deepEqual(afterBuy({ outcome: StoreBuyOutcome.NotShown }), { phase: SheetPhase.Failed, reread: false });
  });

  it("shows an item owned already as the player's, and reads the store again", () => {
    assert.deepEqual(afterBuy({ refused: StoreRefusal.AlreadyOwned }), { phase: SheetPhase.Owned, reread: true });
  });

  it("asks a signed-out player to sign in", () => {
    assert.deepEqual(afterBuy({ refused: StoreRefusal.Unauthorized }), { phase: SheetPhase.SignIn, reread: false });
  });

  it("says an item no longer sold here is gone, and reads the store again", () => {
    for (const refused of [
      StoreRefusal.ItemOffSale,
      StoreRefusal.NotSoldHere,
      StoreRefusal.SkuNotFound,
      StoreRefusal.GameNotFound,
      StoreRefusal.NotFound,
    ])
      assert.deepEqual(afterBuy({ refused }), { phase: SheetPhase.Gone, reread: true }, refused);
  });

  it("says any other refusal failed with nothing charged", () => {
    for (const refused of [StoreRefusal.SurfaceCap, StoreRefusal.NoPayee, StoreRefusal.Unknown, StoreRefusal.FreeItem])
      assert.deepEqual(afterBuy({ refused }), { phase: SheetPhase.Failed, reread: false }, refused);
  });
});

describe("how the sheet goes on once storeClaim answers", () => {
  it("says it's yours after a claim, the first or a replay, and reads the store again", () => {
    assert.deepEqual(afterClaim({ itemId: "fxi-rookie-badge", replayed: false }), {
      phase: SheetPhase.Done,
      reread: true,
    });
    assert.deepEqual(afterClaim({ itemId: "fxi-rookie-badge", replayed: true }), {
      phase: SheetPhase.Done,
      reread: true,
    });
  });

  it("reads a claim's refusal as a purchase's", () => {
    assert.deepEqual(afterClaim({ refused: StoreRefusal.AlreadyOwned }), { phase: SheetPhase.Owned, reread: true });
    assert.deepEqual(afterClaim({ refused: StoreRefusal.Unauthorized }), { phase: SheetPhase.SignIn, reread: false });
    assert.deepEqual(afterClaim({ refused: StoreRefusal.ItemOffSale }), { phase: SheetPhase.Gone, reread: true });
    assert.deepEqual(afterClaim({ refused: StoreRefusal.NotFree }), { phase: SheetPhase.Failed, reread: false });
  });
});

describe("My items as storeMyItems answers", () => {
  it("lists what the player owns, works here first as genex.games ordered it", () => {
    const items = [myItem(), myItem({ id: "fxi-neon-skateboard", place: ItemPlace.NotInThisGame })];
    assert.deepEqual(myItemsRead(items), { status: MyItemsStatus.Ready, items });
  });

  it("asks a signed-out player to sign in", () => {
    assert.deepEqual(myItemsRead({ refused: StoreRefusal.Unauthorized }), {
      status: MyItemsStatus.SignedOut,
      items: [],
    });
  });

  it("lists nothing for a game or a store that is gone, and fails on any other refusal", () => {
    for (const refused of [StoreRefusal.NotFound, StoreRefusal.GameNotFound])
      assert.deepEqual(myItemsRead({ refused }), { status: MyItemsStatus.Ready, items: [] }, refused);
    assert.deepEqual(myItemsRead({ refused: StoreRefusal.ForbiddenOrigin }), {
      status: MyItemsStatus.Failed,
      items: [],
    });
  });
});

describe("the soft gradient behind an item's render", () => {
  it("gives each item one hue of the wheel, the same every time", () => {
    const hue = itemHue("fxi-legendary-sword");
    assert.ok(Number.isInteger(hue) && hue >= 0 && hue < 360, String(hue));
    assert.equal(itemHue("fxi-legendary-sword"), hue);
  });

  it("spreads different items over the wheel", () => {
    const ids = ["fxi-legendary-sword", "fxi-steel-blade", "fxi-rage-potion", "fxi-knight-helmet", "fxi-rookie-badge"];
    assert.ok(new Set(ids.map(itemHue)).size >= 4);
  });
});

describe("the profile shelf (P8)", () => {
  const shelfItem = (id: string, onSale = true): ShelfItem => ({
    id,
    name: id,
    iconUrl: null,
    modelUrl: null,
    game: { slug: "stick-steel", title: "Stick & Steel", coverUrl: null },
    onSale,
  });

  it("offers Get in <game> only while that game still sells the item, which stays on the shelf (P21)", () => {
    assert.deepEqual(shelfGetIn(shelfItem("a")), { slug: "stick-steel", title: "Stick & Steel", coverUrl: null });
    assert.equal(shelfGetIn(shelfItem("a", false)), null);
    assert.equal(shelfGetIn({ ...shelfItem("a"), game: null }), null);
    assert.deepEqual(
      shelfShown([shelfItem("a", false)]).map((item) => item.id),
      ["a"],
    );
  });

  it("shows at most five items, in genex.games' order", () => {
    const items = ["a", "b", "c", "d", "e", "f", "g"].map((id) => shelfItem(id));
    assert.deepEqual(
      shelfShown(items).map((item) => item.id),
      ["a", "b", "c", "d", "e"],
    );
    assert.equal(shelfShown(items).length, ITEM_SHELF_MAX);
  });

  it("shows nothing when the person owns none", () => {
    assert.deepEqual(shelfShown([]), []);
  });
});
