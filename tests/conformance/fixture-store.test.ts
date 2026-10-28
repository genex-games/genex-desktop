/**
 * The store in a fixture profile (`dev/fixture-store.ts`): genex.games' store and creator routes
 * answered from fixture data in the shapes genex.games serves, so the Store section, My items, the
 * purchase sheet, the shelf and Create › Items can be checked with no socket and no Genex account.
 * Every check here goes through the real store client (`play/store.ts`) over the launch's fixture
 * request, the gallery's and coin's included, so the ids line up as they do in a fixture launch.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fixturePlayRequest } from "../../src/main/dev/fixture-play.ts";
import { FIXTURE_ACCOUNT_TOKEN, FIXTURE_ME_ID, fixtureAuthorId } from "../../src/main/dev/fixture-people.ts";
import {
  createFixtureStore,
  FIXTURE_STORE_ACCOUNT_GAMES,
  FIXTURE_STORE_GAME,
  FixtureStoreItem,
} from "../../src/main/dev/fixture-store.ts";
import { playCoin } from "../../src/main/play/coin.ts";
import { type GalleryRequest, playGallery } from "../../src/main/play/gallery.ts";
import { playStore } from "../../src/main/play/store.ts";
import { storeSheet } from "../../src/main/play/store-sheet.ts";
import { PURCHASE_ARM_MS, PurchaseAnswer, PurchaseStep } from "../../src/shared/play-purchase.ts";
import {
  AllowanceState,
  isStoreRefused,
  ItemPlace,
  ItemReportReason,
  ItemState,
  StoreBuyOutcome,
  StoreRefusal,
  type StoreRefused,
  type StoreSheet,
} from "../../src/shared/store-items.ts";
import { fakeClock, settle } from "../helpers/play-viewer-rig.ts";

/** One launch: its store over the launch's other fixture answers, as the account `token` (null: signed out). */
function launch(token: string | null = FIXTURE_ACCOUNT_TOKEN) {
  const request: GalleryRequest = createFixtureStore({ now: Date.now, fallback: fixturePlayRequest });
  const deps = { request, token: async () => token ?? undefined, now: Date.now, localImages: true };
  return { request, store: playStore(deps), coin: playCoin(deps), gallery: playGallery(deps) };
}

type Launch = ReturnType<typeof launch>;

/** A value that is not a refusal, or a failed assertion. */
function answered<T>(value: T | StoreRefused): T {
  if (isStoreRefused(value)) assert.fail(`refused: ${value.refused}`);
  return value;
}

/** The launch's Genex project id of a catalog game, as its page says. */
const projectOf = async (made: Launch, slug: string): Promise<string> => (await made.gallery.world(slug)).id;

/** Buy `itemId` on the store game's page through the store sheet, pressing Pay once it is armed. */
async function buyThroughSheet(made: Launch, itemId: string) {
  const { clock, advance } = fakeClock();
  const pushed: Array<StoreSheet | null> = [];
  const sheet = storeSheet({
    purchase: made.store.purchase,
    world: made.gallery.world,
    coin: made.coin,
    account: { signIn: () => {} },
    openPage: () => {},
    web: "https://genex.games",
    clock,
    push: (shown) => pushed.push(shown),
  });
  const done = sheet.buy(itemId, FIXTURE_STORE_GAME);
  for (let turn = 0; turn < 12; turn += 1) await settle();
  const ask = pushed.at(-1);
  if (ask?.step === PurchaseStep.Ask) {
    sheet.answer({ sheet: ask.sheet, answer: PurchaseAnswer.Shown });
    advance(PURCHASE_ARM_MS);
    sheet.answer({ sheet: ask.sheet, answer: PurchaseAnswer.Pay });
    for (let turn = 0; turn < 12; turn += 1) await settle();
  }
  const last = pushed.at(-1);
  if (last)
    sheet.answer({
      sheet: last.sheet,
      answer: last.step === PurchaseStep.Paid ? PurchaseAnswer.Back : PurchaseAnswer.Cancel,
    });
  // Each step once, as the player sees it: a step drawn again (armed, a fresh balance) is the same step.
  const steps = pushed
    .map((one) => one?.step ?? null)
    .filter((step, index, all) => index === 0 || step !== all[index - 1]);
  return { result: await done, steps };
}

describe("The fixture store: a game's page", () => {
  it("sells the game's own items, then the shared one it added, as the account owns them", async () => {
    const tab = await launch().store.items(FIXTURE_STORE_GAME);
    assert.deepEqual(
      tab.items.map((item) => item.id),
      [
        FixtureStoreItem.LegendarySword,
        FixtureStoreItem.SteelBlade,
        FixtureStoreItem.RagePotion,
        FixtureStoreItem.KnightHelmet,
        FixtureStoreItem.RookieBadge,
        FixtureStoreItem.PhoenixWings,
      ],
    );
    const byId = new Map(tab.items.map((item) => [item.id, item]));
    const sword = byId.get(FixtureStoreItem.LegendarySword);
    assert.deepEqual([sword?.shared, sword?.gamesCount, sword?.priceCoins, sword?.owned], [true, 4, 50_000, false]);
    assert.equal(byId.get(FixtureStoreItem.KnightHelmet)?.owned, true);
    assert.deepEqual(
      [byId.get(FixtureStoreItem.RagePotion)?.owned, byId.get(FixtureStoreItem.RagePotion)?.remaining],
      [true, 2],
    );
    assert.equal(byId.get(FixtureStoreItem.RookieBadge)?.priceCoins, 0);
    const wings = byId.get(FixtureStoreItem.PhoenixWings);
    assert.deepEqual([wings?.shared, wings?.gamesCount, wings?.homeGame?.slug], [true, 7, "skate-dog"]);
    assert.ok(sword?.iconUrl?.startsWith("data:image/svg+xml;"), "a drawn picture a fixture launch lets through");
    assert.equal(tab.myItemsCount, 3);
  });

  it("signed out, owns nothing it knows of, and My items asks to sign in", async () => {
    const made = launch(null);
    const tab = await made.store.items(FIXTURE_STORE_GAME);
    assert.ok(tab.items.length > 0);
    assert.ok(tab.items.every((item) => item.owned === null));
    assert.equal(tab.myItemsCount, null);
    assert.deepEqual(await made.store.myItems(FIXTURE_STORE_GAME), { refused: StoreRefusal.Unauthorized });
  });

  it("lists My items with what works here first, and the skateboard dimmed as not in this game", async () => {
    const items = answered(await launch().store.myItems(FIXTURE_STORE_GAME));
    assert.deepEqual(
      items.map((item) => [item.id, item.place, item.remaining]),
      [
        [FixtureStoreItem.RagePotion, ItemPlace.WorksHere, 2],
        [FixtureStoreItem.KnightHelmet, ItemPlace.WorksHere, null],
        [FixtureStoreItem.NeonSkateboard, ItemPlace.NotInThisGame, null],
      ],
    );
  });

  it("says which games a shared item works in, and an unknown game sells nothing", async () => {
    const made = launch();
    const games = await made.store.itemGames(FixtureStoreItem.PhoenixWings);
    assert.equal(games.total, 7);
    assert.equal(games.games[0]?.slug, "skate-dog", "its home game first");
    assert.deepEqual(await made.store.items("no-such-game"), { items: [], myItemsCount: null });
  });

  it("shelves the account's durables newest first, and a creator's own", async () => {
    const made = launch();
    const mine = await made.store.shelf(FIXTURE_ME_ID);
    assert.deepEqual(
      mine.map((item) => [item.id, item.game?.slug]),
      [
        [FixtureStoreItem.KnightHelmet, FIXTURE_STORE_GAME],
        [FixtureStoreItem.NeonSkateboard, "skate-dog"],
      ],
    );
    assert.equal((await made.store.shelf(fixtureAuthorId("Simeon M"))).length, 3);
    assert.deepEqual(await made.store.shelf("not-a-fixture-person"), []);
  });

  it("keeps an owned item on the shelf once its game stops selling it, without Get in <game> (P21)", async () => {
    const made = launch();
    const started = answered(await made.store.purchase(FixtureStoreItem.SnowShovel, "snowball"));
    await made.coin.confirm(await made.coin.intent(started.id));
    const before = (await made.store.shelf(FIXTURE_ME_ID)).find((item) => item.id === FixtureStoreItem.SnowShovel);
    assert.deepEqual([before?.game?.slug, before?.onSale], ["snowball", true]);
    answered(await made.store.takeOffSale(FixtureStoreItem.SnowShovel));
    const after = (await made.store.shelf(FIXTURE_ME_ID)).find((item) => item.id === FixtureStoreItem.SnowShovel);
    assert.deepEqual([after?.game?.slug, after?.onSale], ["snowball", false]);
  });

  it("gives each shelf item's Get in <game> that game's cover, as genex.games does (D48)", async () => {
    const made = launch();
    const [skateboard] = (await made.store.shelf(FIXTURE_ME_ID)).filter((item) => item.game?.slug === "skate-dog");
    const [home] = (await made.store.itemGames(FixtureStoreItem.PhoenixWings)).games;
    assert.equal(home?.slug, "skate-dog");
    assert.ok(home?.coverUrl, "the fixture's Skate Dog has a cover");
    assert.equal(skateboard?.game?.coverUrl, home?.coverUrl);
  });
});

describe("The fixture store: buying", () => {
  it("pays for the Steel Blade from the fixture's coin through Studio's sheet, then owns it", async () => {
    const made = launch();
    const before = await made.coin.balance();
    const bought = await buyThroughSheet(made, FixtureStoreItem.SteelBlade);
    assert.deepEqual(bought.result, { outcome: StoreBuyOutcome.Paid });
    assert.deepEqual(bought.steps, [PurchaseStep.Ask, PurchaseStep.Paying, PurchaseStep.Paid, null]);
    assert.equal(await made.coin.balance(), before - 1200);
    const tab = await made.store.items(FIXTURE_STORE_GAME);
    assert.equal(tab.items.find((item) => item.id === FixtureStoreItem.SteelBlade)?.owned, true);
    assert.equal(tab.myItemsCount, 4);
    assert.deepEqual(await made.store.purchase(FixtureStoreItem.SteelBlade, FIXTURE_STORE_GAME), {
      refused: StoreRefusal.AlreadyOwned,
    });
  });

  it("starts the purchase for the store game's own project, as the sheet checks", async () => {
    const made = launch();
    const started = answered(await made.store.purchase(FixtureStoreItem.PhoenixWings, FIXTURE_STORE_GAME));
    assert.equal(started.projectId, await projectOf(made, FIXTURE_STORE_GAME));
    await made.coin.cancel(started.id);
  });

  it("shows Not enough coin for the Legendary Sword", async () => {
    const bought = await buyThroughSheet(launch(), FixtureStoreItem.LegendarySword);
    assert.equal(bought.steps[0], PurchaseStep.NotEnough);
    assert.deepEqual(bought.result, { outcome: StoreBuyOutcome.NotPaid });
  });

  it("refuses what genex.games refuses: owned, off sale, a draft, Free, not sold here", async () => {
    const { store } = launch();
    const cases: Array<[string, string, StoreRefusal]> = [
      [FixtureStoreItem.KnightHelmet, FIXTURE_STORE_GAME, StoreRefusal.AlreadyOwned],
      [FixtureStoreItem.OldShield, FIXTURE_STORE_GAME, StoreRefusal.ItemOffSale],
      [FixtureStoreItem.IronGauntlet, FIXTURE_STORE_GAME, StoreRefusal.SkuNotFound],
      [FixtureStoreItem.RookieBadge, FIXTURE_STORE_GAME, StoreRefusal.FreeItem],
      [FixtureStoreItem.Air, FIXTURE_STORE_GAME, StoreRefusal.NotSoldHere],
      [FixtureStoreItem.SteelBlade, "no-such-game", StoreRefusal.GameNotFound],
    ];
    for (const [item, slug, code] of cases) assert.deepEqual(await store.purchase(item, slug), { refused: code }, item);
    assert.deepEqual(await launch(null).store.purchase(FixtureStoreItem.SteelBlade, FIXTURE_STORE_GAME), {
      refused: StoreRefusal.Unauthorized,
    });
  });

  it("claims the Free badge once, and a second claim replays it", async () => {
    const { store } = launch();
    assert.deepEqual(await store.claim(FixtureStoreItem.RookieBadge, FIXTURE_STORE_GAME), {
      itemId: FixtureStoreItem.RookieBadge,
      replayed: false,
    });
    assert.deepEqual(await store.claim(FixtureStoreItem.RookieBadge, FIXTURE_STORE_GAME), {
      itemId: FixtureStoreItem.RookieBadge,
      replayed: true,
    });
    assert.deepEqual(await store.claim(FixtureStoreItem.SteelBlade, FIXTURE_STORE_GAME), {
      refused: StoreRefusal.NotFree,
    });
  });

  it("takes complaints until the report limiter answers", async () => {
    const { store } = launch(null);
    for (let report = 0; report < 5; report += 1)
      assert.equal(await store.report(FixtureStoreItem.PhoenixWings, ItemReportReason.Copy, "Mine."), true);
    assert.deepEqual(await store.report(FixtureStoreItem.PhoenixWings, ItemReportReason.Scam, null), {
      refused: StoreRefusal.TooManyRequests,
    });
  });
});

describe("The fixture store: Create › Items", () => {
  it("browses other creators' shared items only, and narrows by words and tags", async () => {
    const { store } = launch();
    const page = answered(await store.browse({ query: "", cursor: null, tags: [] }));
    const ids = page.items.map((item) => item.id);
    assert.ok(ids.includes(FixtureStoreItem.PhoenixWings) && ids.includes(FixtureStoreItem.LegendarySword));
    assert.ok(!ids.includes(FixtureStoreItem.IceCrown), "the account's own item is not in Browse");
    assert.ok(!ids.includes(FixtureStoreItem.SteelBlade), "an item its author does not share is not in Browse");
    const wings = page.items.find((item) => item.id === FixtureStoreItem.PhoenixWings);
    assert.deepEqual([wings?.priceCoins, wings?.youGetPerSale, wings?.author.name], [8000, 1200, "Matthew G"]);
    const searched = answered(await store.browse({ query: "wings", cursor: null, tags: [] }));
    assert.deepEqual(
      searched.items.map((item) => item.id),
      [FixtureStoreItem.PhoenixWings],
    );
    const tagged = answered(await store.browse({ query: "", cursor: null, tags: ["sword"] }));
    assert.deepEqual(
      tagged.items.map((item) => item.id),
      [FixtureStoreItem.LegendarySword],
    );
    assert.deepEqual(await launch(null).store.browse({ query: "", cursor: null, tags: [] }), {
      refused: StoreRefusal.Unauthorized,
    });
  });

  it("says in the detail panel which of the account's games already added an item", async () => {
    const made = launch();
    const detail = answered(await made.store.browseDetail(FixtureStoreItem.PhoenixWings));
    assert.deepEqual(detail.addedTo, [
      { projectId: await projectOf(made, "snowball"), slug: "snowball", title: "Snowball", live: true },
    ]);
    assert.ok(detail.package && detail.package.files > 0);
    assert.deepEqual(await made.store.browseDetail(FixtureStoreItem.IceCrown), { refused: StoreRefusal.SkuNotFound });
  });

  it("adds a shared item to one of the account's games, again as a replay, and removes it", async () => {
    const made = launch();
    const [game] = FIXTURE_STORE_ACCOUNT_GAMES;
    const projectId = await projectOf(made, game ?? "");
    const added = answered(await made.store.addToGame(FixtureStoreItem.GoldenCrown, projectId));
    assert.deepEqual(
      [added.replayed, added.allowance.state, added.allowance.liveAt],
      [false, AllowanceState.Active, null],
    );
    assert.equal(answered(await made.store.addToGame(FixtureStoreItem.GoldenCrown, projectId)).replayed, true);
    const detail = answered(await made.store.browseDetail(FixtureStoreItem.GoldenCrown));
    assert.deepEqual(
      detail.addedTo.map((one) => [one.slug, one.live]),
      [[game, false]],
    );
    assert.equal(
      answered(await made.store.removeFromGame(FixtureStoreItem.GoldenCrown, projectId)).state,
      AllowanceState.Removed,
    );
    assert.deepEqual(await made.store.removeFromGame(FixtureStoreItem.Air, projectId), {
      refused: StoreRefusal.AllowanceNotFound,
    });
    assert.deepEqual(await made.store.addToGame(FixtureStoreItem.SteelBlade, projectId), {
      refused: StoreRefusal.NotShareable,
    });
    const notMine = await projectOf(made, FIXTURE_STORE_GAME);
    assert.deepEqual(await made.store.addToGame(FixtureStoreItem.GoldenCrown, notMine), {
      refused: StoreRefusal.ProjectNotFound,
    });
    assert.deepEqual(await made.store.addToGame(FixtureStoreItem.IceCrown, projectId), {
      refused: StoreRefusal.HomeGame,
    });
  });

  it("sells drafts, items on sale, off sale, taken down and one under review, with the strip", async () => {
    const selling = answered(await launch().store.selling());
    assert.deepEqual([selling.earnedReady, selling.earnedHeld, selling.holdDays], [48_200, 36_800, 7]);
    assert.ok(selling.nextReleaseAt !== null);
    const states = new Set(selling.items.map((row) => row.state));
    for (const state of Object.values(ItemState)) assert.ok(states.has(state), state);
    assert.ok(selling.items.some((row) => row.underReview));
    assert.equal(selling.items[0]?.id, FixtureStoreItem.FrostAxe);
    assert.equal(selling.items[0]?.game?.slug, "snowball");
    assert.deepEqual(await launch(null).store.selling(), { refused: StoreRefusal.Unauthorized });
  });

  it("puts a draft on sale, refuses one with no picture, takes an item off sale and shares it", async () => {
    const { store } = launch();
    const put = answered(await store.putOnSale(FixtureStoreItem.FrostAxe));
    assert.deepEqual([put.state, put.publishedAt !== null], [ItemState.OnSale, true]);
    assert.deepEqual(await store.putOnSale(FixtureStoreItem.SnowMitten), { refused: StoreRefusal.PictureMissing });
    assert.equal(answered(await store.takeOffSale(FixtureStoreItem.FrostAxe)).state, ItemState.OffSale);
    assert.equal(answered(await store.setShared(FixtureStoreItem.SnowShovel, true)).shareable, true);
    assert.deepEqual(await store.setShared(FixtureStoreItem.HotCocoa, true), { refused: StoreRefusal.NotDurable });
    assert.deepEqual(await store.putOnSale(FixtureStoreItem.CopiedCape), { refused: StoreRefusal.TakenDown });
    assert.deepEqual(await store.putOnSale(FixtureStoreItem.SteelBlade), { refused: StoreRefusal.SkuNotFound });
  });
});
