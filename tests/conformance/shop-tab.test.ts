/**
 * The stage's Shop tab: beside Live and Builds once the game sells something, every item of the game
 * as its chat's cards show it (its local drafts, then its items on genex.games that a draft's upload
 * does not already show), and Ask for changes naming the id the agent acts on. The native game view
 * gives the stage back while Shop is open, as it does for Builds and Assets.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LiveView } from "../../src/renderer/live-views.ts";
import { shopItemId, shopItems } from "../../src/renderer/panels/shop/shop-model.ts";
import { resolveStageView, stageFlags } from "../../src/renderer/panels/stage/stage-flags.ts";
import { stageTabs, tabChoice, tabGlyph } from "../../src/renderer/panels/stage/stage-tabs.ts";
import { isStageView, StageView } from "../../src/renderer/stage.ts";
import type { LocalItemsView, LocalListingDraft } from "../../src/shared/item-draft.ts";
import { LocalOutcomeKind, localDraftOf } from "../../src/shared/item-draft.ts";
import { ObserverLive, PREVIEW_OBSERVER } from "../../src/shared/observers.ts";
import { ItemState, ItemType, type SellingRow } from "../../src/shared/store-items.ts";

const preview: LiveView = { live: ObserverLive.Preview, at: ".", observer: PREVIEW_OBSERVER };
const GAME = "fisher-game";
const HASH = "a".repeat(64);
const ROD = "local_750042e04a1c";
const BAIT = "local_0123456789ab";

const draft = (localId: string, name: string): LocalListingDraft => ({
  project: GAME,
  state: "local",
  localId,
  name,
  description: null,
  type: ItemType.Durable,
  priceCoins: 100,
  tags: [],
  shareable: false,
  contentHash: HASH,
  picture: null,
});

const row = (id: string, game: string | null, state: ItemState = ItemState.Draft): SellingRow => ({
  id,
  name: id,
  iconUrl: null,
  type: ItemType.Durable,
  game: game ? { id: game, slug: game, title: game } : null,
  gamesCount: 1,
  state,
  underReview: false,
  shareable: false,
  priceCoins: 300,
  priceDisplayUsdCents: 300,
  sold: 0,
  earned: 0,
});

const view = (fields: Partial<LocalItemsView> = {}): LocalItemsView => ({
  project: GAME,
  approvals: {},
  drafts: { [ROD]: draft(ROD, "Fishing Rod"), [BAIT]: draft(BAIT, "Golden Bait") },
  removed: [],
  outcomes: {},
  ...fields,
});

describe("the Shop tab on the stage strip", () => {
  it("joins between Builds and Assets once the game sells something, and is a plain view", () => {
    const tabs = (hasShop: boolean) =>
      stageTabs({ views: [preview], plugins: [], hasBuilds: true, buildsLive: false, hasShop, beside: null }).map(
        (tab) => tab.key,
      );
    assert.deepEqual(tabs(false), ["live", "builds", "assets"]);
    assert.deepEqual(tabs(true), ["live", "builds", "shop", "assets"]);
    assert.deepEqual(tabChoice("shop", [preview]), { view: StageView.Shop });
    assert.equal(tabGlyph({ key: StageView.Shop, label: "Shop" }, [preview]), "layers");
    assert.equal(isStageView("shop"), true, "a remembered Shop opens again");
  });

  it("shows only for a game that sells something, else the stage falls back to Live", () => {
    const has = { beside: false, builds: false, project: true };
    assert.equal(resolveStageView(StageView.Shop, { ...has, shop: true }), StageView.Shop);
    assert.equal(resolveStageView(StageView.Shop, has), StageView.Live);
    assert.equal(resolveStageView(StageView.Shop, { ...has, project: false, shop: true }), StageView.Live);
  });

  it("takes the stage from the running game while it is open", () => {
    const flags = stageFlags({
      view: StageView.Shop,
      beside: null,
      graph: null,
      planning: false,
      project: GAME,
      liveView: ObserverLive.Preview,
      pending: false,
      live: { state: null, liveLoad: null, stopped: false },
      shop: true,
    });
    assert.equal(flags.stageView, StageView.Shop);
    assert.equal(flags.shopOpen, true);
    assert.equal(flags.previewOnStage, false);
  });
});

describe("a local draft's picture", () => {
  const printed = (picture: unknown) => ({
    kind: "genex.item_draft",
    version: 1,
    state: "local",
    localId: ROD,
    name: "Fishing Rod",
    description: null,
    priceCoins: 100,
    type: "durable",
    tags: [],
    shareable: false,
    contentHash: HASH,
    ...(picture === undefined ? {} : { picture }),
  });
  it("is the file the CLI names in the draft's own folder, and none for anything else", () => {
    assert.equal(
      localDraftOf(printed(`.genex/items/${ROD}/image.png`), GAME)?.picture,
      `.genex/items/${ROD}/image.png`,
    );
    assert.equal(localDraftOf(printed(undefined), GAME)?.picture, null);
    for (const bad of [
      `.genex/items/${BAIT}/image.png`,
      `.genex/items/${ROD}/../image.png`,
      `.genex/items/${ROD}/sub/image.png`,
      `/.genex/items/${ROD}/image.png`,
      "assets/rod.png",
      42,
    ])
      assert.equal(localDraftOf(printed(bad), GAME)?.picture, null, String(bad));
  });
});

describe("the game's items on the Shop tab", () => {
  it("are its local drafts, then its own items on genex.games, never another game's", () => {
    const items = shopItems(GAME, view(), "proj_fish", [row("sku_hat", "proj_fish"), row("sku_axe", "proj_other")]);
    assert.deepEqual(
      items.map((item) => item.name),
      ["Fishing Rod", "Golden Bait", "sku_hat"],
    );
  });

  it("leave out a draft the agent removed, and an item a draft's upload already shows", () => {
    const uploaded = view({
      removed: [BAIT],
      outcomes: {
        [ROD]: {
          kind: LocalOutcomeKind.OnSale,
          skuId: "sku_rod",
          contentHash: HASH,
          refusal: null,
          field: null,
          at: 1,
        },
      },
    });
    const items = shopItems(GAME, uploaded, "proj_fish", [row("sku_rod", "proj_fish", ItemState.OnSale)]);
    assert.deepEqual(
      items.map((item) => item.name),
      ["Fishing Rod"],
    );
  });

  it("are the local drafts alone before the game is on Genex, and nothing before anything is read", () => {
    assert.equal(shopItems(GAME, view(), null, [row("sku_hat", "proj_fish")]).length, 2);
    assert.deepEqual(shopItems(GAME, undefined, undefined, undefined), []);
  });

  it("are changed by the id the agent acts on: the SKU once uploaded, else the local id", () => {
    const local = view({
      outcomes: {
        [ROD]: {
          kind: LocalOutcomeKind.OnSale,
          skuId: "sku_rod",
          contentHash: HASH,
          refusal: null,
          field: null,
          at: 1,
        },
      },
    });
    const [rod, bait] = shopItems(GAME, local, null, []);
    assert.ok(rod && bait);
    assert.equal(shopItemId(rod, local), "sku_rod");
    assert.equal(shopItemId(bait, local), BAIT);
    const [hat] = shopItems(GAME, undefined, "proj_fish", [row("sku_hat", "proj_fish")]);
    assert.ok(hat);
    assert.equal(shopItemId(hat, undefined), "sku_hat");
  });
});
