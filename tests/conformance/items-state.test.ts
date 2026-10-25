/**
 * Create › Items' state (marketplace plan 10.3; screens 07–08): Browse's search, pages and the item
 * on show; Selling and its strip; which local games are on Genex and the game Add to acts on; and
 * the presses Selling and the Listing draft card share, each carried out by main and shown as
 * genex.games answered it. Numbers are genex.games' own: nothing here computes a price or a share.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  addTarget,
  askedForItem,
  BROWSE_TYPING_MS,
  browseAnswered,
  browseAsked,
  browseQuery,
  createItemsStore,
  hostedGames,
  initialItems,
  ItemAction,
  itemChanged,
  itemChosen,
  ItemsRead,
  type ItemsState,
  ItemsTab,
  localGameOf,
  sellingAnswered,
  targetChosen,
} from "../../src/renderer/state/items.ts";
import { addedIn, browseIntro, youGetLabel } from "../../src/renderer/panels/items/browse-model.ts";
import { rowMenu, sellingPrice, SellingStatus, sellingStatus } from "../../src/renderer/panels/items/selling-model.ts";
import { REREAD_GAP_MS } from "../../src/renderer/state/refresher.ts";
import { ITEMS_WORDS, PLAY_STORE_WORDS } from "../../src/renderer/words.ts";
import { GENEX_PLUGIN_ID, GenexAction } from "../../src/shared/genex.ts";
import {
  type BrowseDetail,
  type BrowseItem,
  type CreatorItem,
  ItemState,
  ItemType,
  type Selling,
  StoreRefusal,
} from "../../src/shared/store-items.ts";
import { fakeStudioApi } from "../helpers/fake-studio-api.ts";
import { fakeClock, settle } from "../helpers/play-viewer-rig.ts";

const browseItem = (id: string, fields: Partial<BrowseItem> = {}): BrowseItem => ({
  id,
  name: id,
  description: null,
  iconUrl: null,
  modelUrl: null,
  type: ItemType.Durable,
  priceCoins: 8000,
  priceDisplayUsdCents: 8000,
  tags: [],
  author: { id: "u_mira", name: "mira_makes", handle: "mira_makes" },
  homeGame: { slug: "skate-dog", title: "Skate Dog" },
  gamesCount: 7,
  youGetPerSale: 1200,
  ...fields,
});

const page = (ids: string[], nextCursor: string | null = null) => ({
  items: ids.map((id) => browseItem(id)),
  nextCursor,
});

const creatorItem = (fields: Partial<CreatorItem> = {}): CreatorItem => ({
  id: "sku_frost",
  projectId: "proj_snow",
  type: ItemType.Durable,
  name: "Frost Axe",
  description: null,
  tags: [],
  iconUrl: null,
  modelUrl: null,
  priceCoins: 1200,
  priceDisplayUsdCents: 1200,
  state: ItemState.Draft,
  shareable: true,
  publishedAt: null,
  takenDownAt: null,
  ...fields,
});

const selling = (): Selling => ({
  earnedReady: 48_200,
  earnedHeld: 36_800,
  nextReleaseAt: null,
  holdDays: 7,
  items: [
    {
      id: "sku_frost",
      name: "Frost Axe",
      iconUrl: null,
      type: ItemType.Durable,
      game: { id: "proj_snow", slug: "snowball", title: "Snowball" },
      gamesCount: 1,
      state: ItemState.Draft,
      underReview: false,
      shareable: false,
      priceCoins: 1200,
      priceDisplayUsdCents: 1200,
      sold: 0,
      earned: 0,
    },
  ],
});

describe("Browse", () => {
  it("shows the first item of a search, and keeps the item on show while the next search still lists it", () => {
    const first = browseAnswered(browseAsked(initialItems(), "wings"), "wings", page(["a", "b"]));
    assert.equal(first.browse.read, ItemsRead.Ready);
    assert.equal(first.browse.selectedId, "a");
    const chosen = itemChosen(first, "b");
    const again = browseAnswered(browseAsked(chosen, "w"), "w", page(["b", "c"]));
    assert.equal(again.browse.selectedId, "b");
    const gone = browseAnswered(browseAsked(again, "crown"), "crown", page(["d"]));
    assert.equal(gone.browse.selectedId, "d");
  });

  it("keeps the selling game's share Browse's pages name, which a page without one leaves as it was", () => {
    const first = browseAnswered(browseAsked(initialItems(), ""), "", { ...page(["a"], "next"), sellerShareBps: 1500 });
    assert.equal(first.browse.sellerShareBps, 1500);
    const later = browseAnswered(first, "", page(["b"]), true);
    assert.equal(later.browse.sellerShareBps, 1500);
    const older = browseAnswered(browseAsked(initialItems(), ""), "", page(["a"]));
    assert.equal(older.browse.sellerShareBps, undefined, "an older API names none");
  });

  it("says the selling game's share from genex.games, and the design's words when it names none", () => {
    assert.equal(browseIntro(undefined), ITEMS_WORDS.intro);
    assert.equal(
      browseIntro(1500),
      "Items other creators made. Free to add to your game, and you get 15% of every sale in it.",
    );
    assert.match(browseIntro(1250), /you get 12\.5% of every sale/);
    assert.match(browseIntro(2000), /you get 20% of every sale/);
    assert.equal(youGetLabel(undefined), ITEMS_WORDS.youGet);
    assert.equal(youGetLabel(1500), "You get per sale (15%)");
  });

  it("drops the answer to a search the person already typed past", () => {
    const typedOn = browseAsked(browseAsked(initialItems(), "w"), "wings");
    assert.equal(browseAnswered(typedOn, "w", page(["late"])), typedOn);
  });

  it("adds a later page under the first, without listing an item twice", () => {
    const first = browseAnswered(browseAsked(initialItems(), ""), "", page(["a", "b"], "next"));
    const both = browseAnswered(first, "", page(["b", "c"]), true);
    assert.deepEqual(
      both.browse.items.map((item) => item.id),
      ["a", "b", "c"],
    );
    assert.equal(both.browse.nextCursor, null);
  });

  it("says signed out or store off from genex.games' refusal, and failed otherwise", () => {
    const asked = browseAsked(initialItems(), "");
    const read = (refused: StoreRefusal) => browseAnswered(asked, "", { refused }).browse.read;
    assert.equal(read(StoreRefusal.Unauthorized), ItemsRead.SignedOut);
    assert.equal(read(StoreRefusal.NotFound), ItemsRead.Off);
    assert.equal(read(StoreRefusal.Unknown), ItemsRead.Failed);
  });

  it("sends a search trimmed and no longer than Studio sends one", () => {
    assert.equal(browseQuery("  wings  "), "wings");
    assert.equal(browseQuery("x".repeat(500)).length, 120);
  });
});

describe("the games items go to", () => {
  const hosted = { snowball: "proj_snow", "fixture-game": null, "claude-of-duty": "proj_cod" };

  it("offers the local games that are on Genex, in the order given", () => {
    assert.deepEqual(hostedGames(hosted, ["fixture-game", "claude-of-duty", "snowball", "unread"]), [
      "claude-of-duty",
      "snowball",
    ]);
  });

  it("adds to the chosen game when it is on Genex, else to the first that is", () => {
    const games = ["fixture-game", "snowball", "claude-of-duty"];
    assert.equal(addTarget({ hosted, target: "claude-of-duty" }, games), "claude-of-duty");
    assert.equal(addTarget({ hosted, target: "fixture-game" }, games), "snowball");
    assert.equal(addTarget({ hosted: {}, target: null }, games), null);
    assert.equal(targetChosen(initialItems(), "snowball").target, "snowball");
  });

  it("finds the local game an item's Genex project is", () => {
    assert.equal(localGameOf(hosted, "proj_cod"), "claude-of-duty");
    assert.equal(localGameOf(hosted, "proj_elsewhere"), null);
    assert.equal(localGameOf(hosted, undefined), null);
  });
});

describe("a press on an item", () => {
  it("shows the item as genex.games answered it, in its Selling row too", () => {
    const shown = sellingAnswered(initialItems(), selling());
    const changed = itemChanged(shown, creatorItem({ state: ItemState.OnSale, shareable: true }));
    const [row] = changed.selling.selling?.items ?? [];
    assert.equal(row?.state, ItemState.OnSale);
    assert.equal(row?.shareable, true);
    assert.equal(changed.changed.sku_frost?.state, ItemState.OnSale);
  });

  it("New item's ask lasts until it is cleared, one game at a time", () => {
    const asking = askedForItem(initialItems(), "snowball");
    assert.equal(asking.askingIn, "snowball");
    assert.equal(askedForItem(asking, null).askingIn, null);
  });
});

describe("the items store over Studio's calls", () => {
  it("Put on sale asks main to publish exactly that item, and shows what genex.games answered", async () => {
    const fake = fakeStudioApi({ itemPutOnSale: async () => creatorItem({ state: ItemState.OnSale }) });
    const items = createItemsStore(fake.api);
    const outcome = await items.change("sku_frost", ItemAction.PutOnSale);
    assert.deepEqual(fake.callsOf("itemPutOnSale"), [["sku_frost"]]);
    assert.deepEqual(outcome, { item: creatorItem({ state: ItemState.OnSale }) });
    assert.equal(items.getState().changed.sku_frost?.state, ItemState.OnSale);
    assert.deepEqual(items.getState().busy, {});
  });

  it("Other games can use it sets sharing on and off, and Take off sale unpublishes", async () => {
    const fake = fakeStudioApi({
      itemSetShared: async (_id, shared) => creatorItem({ shareable: shared }),
      itemTakeOffSale: async () => creatorItem({ state: ItemState.OffSale }),
    });
    const items = createItemsStore(fake.api);
    await items.change("sku_frost", ItemAction.Share);
    await items.change("sku_frost", ItemAction.Unshare);
    await items.change("sku_frost", ItemAction.TakeOffSale);
    assert.deepEqual(fake.callsOf("itemSetShared"), [
      ["sku_frost", true],
      ["sku_frost", false],
    ]);
    assert.deepEqual(fake.callsOf("itemTakeOffSale"), [["sku_frost"]]);
    assert.deepEqual(fake.callsOf("itemPutOnSale"), []);
  });

  it("keeps genex.games' refusal on the item, and reads an outage as one it cannot name", async () => {
    const fake = fakeStudioApi({ itemPutOnSale: async () => ({ refused: StoreRefusal.PictureMissing }) });
    const items = createItemsStore(fake.api);
    await items.change("sku_frost", ItemAction.PutOnSale);
    assert.equal(items.getState().refused.sku_frost, StoreRefusal.PictureMissing);
    fake.stub("itemPutOnSale", async () => {
      throw new Error("offline");
    });
    assert.deepEqual(await items.change("sku_frost", ItemAction.PutOnSale), { refused: StoreRefusal.Unknown });
  });

  it("adds an item to a local game by that game's Genex project, read from its publish record", async () => {
    const fake = fakeStudioApi({
      pluginAction: async (_id, _name, _args, project) => (project === "snowball" ? { projectId: "proj_snow" } : {}),
      itemsAddToGame: async () => ({
        allowance: { itemId: "a", projectId: "proj_snow", state: "active", addedAt: 1, liveAt: null },
        replayed: false,
      }),
    });
    const items = createItemsStore(fake.api);
    await items.readHosted(["snowball", "fixture-game"]);
    assert.deepEqual(items.getState().hosted, { snowball: "proj_snow", "fixture-game": null });
    assert.deepEqual(
      fake.callsOf("pluginAction").map(([id, name, , project]) => [id, name, project]),
      [
        [GENEX_PLUGIN_ID, GenexAction.PublishStatus, "snowball"],
        [GENEX_PLUGIN_ID, GenexAction.PublishStatus, "fixture-game"],
      ],
    );
    await items.addToGame("a", "snowball");
    assert.deepEqual(fake.callsOf("itemsAddToGame"), [["a", "proj_snow"]]);
    const refused = await items.addToGame("a", "fixture-game");
    assert.deepEqual(refused, { refused: StoreRefusal.ProjectNotFound });
    assert.equal(fake.callsOf("itemsAddToGame").length, 1);
  });

  it("searches Browse once the person pauses typing, not at every key", async () => {
    const { clock, advance } = fakeClock();
    const fake = fakeStudioApi({ itemsBrowse: async () => page(["a"]) });
    const items = createItemsStore(fake.api, clock);
    items.searchTyped("w");
    items.searchTyped("wi");
    advance(BROWSE_TYPING_MS - 1);
    items.searchTyped(" wings ");
    assert.equal(items.getState().browse.query, "wings", "the field shows what was typed at once");
    advance(BROWSE_TYPING_MS - 1);
    assert.deepEqual(fake.callsOf("itemsBrowse"), [], "no read while the keys keep coming");
    advance(1);
    await settle();
    assert.deepEqual(fake.callsOf("itemsBrowse"), [["wings", null]]);
    assert.deepEqual(
      items.getState().browse.items.map((item) => item.id),
      ["a"],
    );
  });

  it("reads Browse page by page, and the next page only once", async () => {
    const fake = fakeStudioApi({
      itemsBrowse: async (_query, cursor) => (cursor ? page(["c"]) : page(["a", "b"], "next")),
    });
    const items = createItemsStore(fake.api);
    await items.search(" wings ");
    await Promise.all([items.more(), items.more()]);
    assert.deepEqual(fake.callsOf("itemsBrowse"), [
      ["wings", null],
      ["wings", "next"],
    ]);
    const state: ItemsState = items.getState();
    assert.deepEqual(
      state.browse.items.map((item) => item.id),
      ["a", "b", "c"],
    );
  });
});

/** Browse's detail of `id`, added to the games named (project id → live). */
const detail = (id: string, added: Record<string, boolean> = {}): BrowseDetail => ({
  item: browseItem(id),
  package: null,
  addedTo: Object.entries(added).map(([projectId, live]) => ({ projectId, slug: projectId, title: projectId, live })),
});

/** The calls Create › Items reads with, every one recorded. */
const reads = (fake: ReturnType<typeof fakeStudioApi>) => ({
  browse: fake.callsOf("itemsBrowse").length,
  selling: fake.callsOf("itemsSelling").length,
  detail: fake.callsOf("itemsBrowseDetail").map(([id]) => id),
});

describe("Create › Items read again", () => {
  it("reads the tab chosen, and a tab chosen back and forth only once its last read is old", async () => {
    const { clock, advance } = fakeClock();
    const fake = fakeStudioApi({ itemsSelling: async () => selling(), itemsBrowse: async () => page(["a"]) });
    const items = createItemsStore(fake.api, clock);
    await items.chooseTab(ItemsTab.Selling);
    assert.equal(items.getState().tab, ItemsTab.Selling);
    await items.chooseTab(ItemsTab.Browse);
    await items.chooseTab(ItemsTab.Selling);
    await items.chooseTab(ItemsTab.Browse);
    assert.deepEqual([reads(fake).selling, reads(fake).browse], [1, 1], "a quick back and forth reads each once");
    advance(REREAD_GAP_MS);
    await items.chooseTab(ItemsTab.Selling);
    assert.deepEqual([reads(fake).selling, reads(fake).browse], [2, 1], "a tab chosen again later is read again");
  });

  it("reads the tab on show once for a burst of window focus, and again after the gap", async () => {
    const { clock, advance } = fakeClock();
    const fake = fakeStudioApi({ itemsSelling: async () => selling() });
    const items = createItemsStore(fake.api, clock);
    items.setState((state) => ({ ...state, tab: ItemsTab.Selling }), true);
    await Promise.all([items.refresh(), items.refresh(), items.refresh()]);
    assert.equal(reads(fake).selling, 1);
    assert.equal(reads(fake).browse, 0, "the tab not on show is not read");
    advance(REREAD_GAP_MS - 1);
    await items.refresh();
    assert.equal(reads(fake).selling, 1);
    advance(1);
    await items.refresh();
    assert.equal(reads(fake).selling, 2);
  });

  it("reads Selling again after Put on sale, Take off sale or sharing, however recently it was read", async () => {
    const { clock } = fakeClock();
    const fake = fakeStudioApi({
      itemsSelling: async () => selling(),
      itemPutOnSale: async () => creatorItem({ state: ItemState.OnSale }),
      itemTakeOffSale: async () => ({ refused: StoreRefusal.TakenDown }),
    });
    const items = createItemsStore(fake.api, clock);
    await items.readSelling();
    await items.change("sku_frost", ItemAction.PutOnSale);
    await settle();
    assert.equal(reads(fake).selling, 2, "Sold, Earned and the strip move with the sale");
    await items.change("sku_frost", ItemAction.TakeOffSale);
    await settle();
    assert.equal(reads(fake).selling, 2, "a refused press changed nothing to read");
  });

  it("reads the detail of the item on show, and again after Add to and Remove from", async () => {
    const { clock } = fakeClock();
    let added = false;
    const fake = fakeStudioApi({
      pluginAction: async () => ({ projectId: "proj_snow" }),
      itemsBrowse: async () => page(["a", "b"]),
      itemsBrowseDetail: async (id) => detail(id, added ? { proj_snow: false } : {}),
      itemsAddToGame: async () => {
        added = true;
        return {
          allowance: { itemId: "a", projectId: "proj_snow", state: "active", addedAt: 1, liveAt: null },
          replayed: false,
        };
      },
      itemsRemoveFromGame: async () => {
        added = false;
        return { itemId: "a", projectId: "proj_snow", state: "removed", addedAt: 1, liveAt: null };
      },
    });
    const items = createItemsStore(fake.api, clock);
    await items.readHosted(["snowball"]);
    await items.search("");
    await settle();
    assert.deepEqual(reads(fake).detail, ["a"], "the first item shows, with where it was added");
    await items.choose("b");
    assert.equal(items.getState().browse.selectedId, "b");
    await items.choose("a");
    assert.deepEqual(reads(fake).detail, ["a", "b", "a"]);
    await items.addToGame("a", "snowball");
    await settle();
    assert.deepEqual(
      items.getState().browse.details.a?.addedTo.map((game) => game.projectId),
      ["proj_snow"],
    );
    await items.removeFromGame("a", "snowball");
    await settle();
    assert.deepEqual(fake.callsOf("itemsRemoveFromGame"), [["a", "proj_snow"]]);
    assert.deepEqual(items.getState().browse.details.a?.addedTo, []);
    assert.deepEqual(items.getState().busy, {});
    assert.deepEqual(reads(fake).detail, ["a", "b", "a", "a", "a"]);
  });

  it("keeps genex.games' refusal of a Remove on the item, and removes nothing from a game not on Genex", async () => {
    const fake = fakeStudioApi({
      pluginAction: async (_id, _name, _args, project) => (project === "snowball" ? { projectId: "proj_snow" } : {}),
      itemsRemoveFromGame: async () => ({ refused: StoreRefusal.AllowanceNotFound }),
    });
    const items = createItemsStore(fake.api);
    await items.readHosted(["snowball", "fixture-game"]);
    assert.deepEqual(await items.removeFromGame("a", "fixture-game"), { refused: StoreRefusal.ProjectNotFound });
    assert.deepEqual(fake.callsOf("itemsRemoveFromGame"), []);
    await items.removeFromGame("a", "snowball");
    assert.equal(items.getState().refused.a, StoreRefusal.AllowanceNotFound);
    assert.deepEqual(items.getState().busy, {});
  });
});

describe("Browse's detail for the game Add to acts on", () => {
  it("says whether the item is in that game, and whether players can get it there yet", () => {
    const shown = detail("a", { proj_snow: false, proj_dog: true });
    assert.deepEqual(addedIn(shown, "proj_snow"), { live: false });
    assert.deepEqual(addedIn(shown, "proj_dog"), { live: true });
    assert.equal(addedIn(shown, "proj_other"), null);
    assert.equal(addedIn(shown, null), null);
    assert.equal(addedIn(undefined, "proj_snow"), null, "not read yet: Add to stays");
  });
});

describe("a Selling row", () => {
  const row = (state: ItemState, fields: { underReview?: boolean; type?: ItemType } = {}) => ({
    state,
    underReview: fields.underReview ?? false,
    type: fields.type ?? ItemType.Durable,
  });

  it("says Draft, Report under review or Off sale, and nothing for an item on sale", () => {
    assert.equal(sellingStatus(row(ItemState.Draft)), SellingStatus.Draft);
    assert.equal(sellingStatus(row(ItemState.OnSale, { underReview: true })), SellingStatus.UnderReview);
    assert.equal(sellingStatus(row(ItemState.OffSale)), SellingStatus.OffSale);
    assert.equal(
      sellingStatus(row(ItemState.TakenDown)),
      SellingStatus.OffSale,
      "an admin's take-down reads as off sale",
    );
    assert.equal(sellingStatus(row(ItemState.OnSale)), null);
  });

  it("offers Put on sale for a draft or an item off sale, Take off sale otherwise, and sharing for a durable", () => {
    assert.deepEqual(rowMenu(row(ItemState.Draft), true), { putOnSale: true, share: true, ask: true });
    assert.deepEqual(rowMenu(row(ItemState.OffSale), false), { putOnSale: true, share: true, ask: false });
    assert.deepEqual(rowMenu(row(ItemState.OnSale, { type: ItemType.Consumable }), true), {
      putOnSale: false,
      share: false,
      ask: true,
    });
  });

  it("offers nothing on an item an admin took off sale", () => {
    assert.equal(rowMenu(row(ItemState.TakenDown), true), null);
  });

  it("prices a Free item Free, as the Store card and the sheet say", () => {
    assert.equal(sellingPrice({ priceCoins: 0 }), PLAY_STORE_WORDS.free);
    assert.equal(sellingPrice({ priceCoins: 1200 }), "1,200");
  });
});
