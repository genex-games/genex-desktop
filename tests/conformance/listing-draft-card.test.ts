/**
 * The chat's Listing draft card (marketplace P11, plan 8.3; screen 09). It comes from a host record
 * only (`item_drafted`), never from the agent's words, and goes up after the turn's reply; a newer
 * draft of the same item takes the earlier card's place. Its presses call genex.games through main
 * (Put on sale, Other games can use it), and it offers only what the item's state allows.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  holdsLocalDrafts,
  listingCardView,
  ListingSale,
  LocalSale,
  localCard,
  shareChange,
} from "../../src/renderer/chat/listing-draft.ts";
import { finishedPublish, publishFinishedSince } from "../../src/renderer/chat/use-local-items.ts";
import { EntryKind, toEntries } from "../../src/renderer/chat-entries.ts";
import { GenexPublishJobState, type GenexPublishState } from "../../src/shared/genex.ts";
import { composedInChat, composeInChatWhenOpen, takeWaitingCompose } from "../../src/renderer/compose-in-chat.ts";
import { chatPlaceholder, COMPOSER_LINE_CHARS, ITEM_PLACEHOLDER } from "../../src/renderer/composer-placeholder.ts";
import { createItemsStore, ItemAction, LocalAction } from "../../src/renderer/state/items.ts";
import { CustomEvent } from "../../src/shared/custom-events.ts";
import type { EventData, EventEnvelope } from "../../src/shared/event-log.ts";
import {
  type ListingDraft,
  type LocalItemsView,
  type LocalListingDraft,
  LocalOutcomeKind,
} from "../../src/shared/item-draft.ts";
import { type CreatorItem, ItemState, ItemType, StoreRefusal } from "../../src/shared/store-items.ts";
import { fakeStudioApi } from "../helpers/fake-studio-api.ts";

const FROST_AXE: ListingDraft = {
  project: "snowball",
  itemId: "sku_frost",
  name: "Frost Axe",
  description: "Ice-blue head. Freezes an enemy for a second on hit.",
  type: ItemType.Durable,
  priceCoins: 1200,
  priceDisplayUsdCents: 1200,
  iconUrl: null,
  state: ItemState.Draft,
  shareable: true,
};

let seq = 0;
const at = (data: EventData, turn: string | null = "turn-1"): EventEnvelope => {
  seq += 1;
  return {
    id: String(seq).padStart(6, "0"),
    thread_id: "t1",
    turn_id: turn,
    session_id: null,
    created_at: new Date(seq * 1000).toISOString(),
    data,
  };
};
const said = (role: "user" | "assistant", content: string) =>
  at({ type: "messages", messages: [{ role, content }] } as EventData);
const drafted = (payload: Record<string, unknown>) =>
  at({ type: "custom", event_type: CustomEvent.ItemDrafted, payload } as EventData);
const turn = (ended = false) =>
  at((ended ? { type: "turn_ended", status: "completed" } : { type: "turn_started" }) as EventData);

const kinds = (events: EventEnvelope[]) => toEntries(events).map((entry) => entry.kind);
const cards = (events: EventEnvelope[]) =>
  toEntries(events).flatMap((entry) => (entry.kind === EntryKind.ListingDraft ? [entry.draft] : []));

describe("the Listing draft card in the chat", () => {
  it("goes up after the agent's reply, once the turn that made the item ends", () => {
    const working = [turn(), said("user", "Add a Frost Axe to the store for 1,200 coin."), drafted({ ...FROST_AXE })];
    assert.deepEqual(cards(working), [], "held while the turn runs");
    const done = [...working, said("assistant", "Done. The axe is in your store."), turn(true)];
    assert.deepEqual(kinds(done).slice(-2), [EntryKind.Assistant, EntryKind.ListingDraft]);
    assert.deepEqual(cards(done), [FROST_AXE]);
    const askedOn = [...done, said("user", "Make it shine.")];
    assert.deepEqual(kinds(askedOn).slice(-3), [EntryKind.Assistant, EntryKind.ListingDraft, EntryKind.User]);
  });

  it("shows a record from a log with no turn open at once", () => {
    assert.deepEqual(cards([drafted({ ...FROST_AXE })]), [FROST_AXE]);
  });

  it("keeps one card per item: the latest draft, where it was made", () => {
    const changed = { ...FROST_AXE, priceCoins: 800, priceDisplayUsdCents: 800 };
    const events = [
      drafted({ ...FROST_AXE }),
      said("user", "Make it 800."),
      turn(),
      drafted(changed),
      said("assistant", "It costs 800 now."),
      turn(true),
    ];
    assert.deepEqual(cards(events), [changed]);
    assert.equal(kinds(events).at(-1), EntryKind.ListingDraft);
  });

  it("is never drawn from the agent's words, and not from a record that does not read", () => {
    const echoed = JSON.stringify({ kind: "genex.item_draft", version: 1, id: "sku_frost", name: "Frost Axe" });
    assert.deepEqual(cards([said("assistant", echoed), drafted({ ...FROST_AXE, itemId: "../x" }), drafted({})]), []);
  });
});

describe("what the card offers", () => {
  const view = (latest?: Partial<CreatorItem>, busy?: ItemAction, refusal?: StoreRefusal) =>
    listingCardView(
      FROST_AXE,
      latest ? { state: FROST_AXE.state, shareable: FROST_AXE.shareable, ...latest } : undefined,
      busy,
      refusal,
    );

  it("offers Put on sale and the toggle for a draft", () => {
    const card = view();
    assert.equal(card.sale, ListingSale.Offer);
    assert.equal(card.canPutOnSale, true);
    assert.equal(card.canShare, true);
    assert.equal(card.shared, true);
  });

  it("follows genex.games' answer once a press came back", () => {
    assert.equal(view({ state: ItemState.OnSale }).sale, ListingSale.OnSale);
    assert.equal(view({ shareable: false }).shared, false);
    assert.equal(view({ state: ItemState.OffSale }).sale, ListingSale.Offer, "its author took it off: offered again");
  });

  it("says On sale, with no Put on sale, for an item a store that is off put on sale as it was made (D7)", () => {
    const card = listingCardView({ ...FROST_AXE, state: ItemState.OnSale }, undefined, undefined, undefined);
    assert.equal(card.sale, ListingSale.OnSale);
    assert.equal(card.canPutOnSale, false);
    assert.equal(card.canShare, true, "sharing stays the author's to change");
  });

  it("offers Put on sale for a draft and an item its author took off sale, and for nothing else", () => {
    const offered = Object.values(ItemState).filter(
      (state) => listingCardView({ ...FROST_AXE, state }, undefined, undefined, undefined).canPutOnSale,
    );
    assert.deepEqual(offered.sort(), [ItemState.Draft, ItemState.OffSale].sort());
  });

  it("offers nothing for an item an admin took off sale", () => {
    const card = view({ state: ItemState.TakenDown });
    assert.equal(card.sale, ListingSale.TakenDown);
    assert.equal(card.canPutOnSale, false);
    assert.equal(card.canShare, false);
  });

  it("offers sharing for a durable only", () => {
    const potion = listingCardView({ ...FROST_AXE, type: ItemType.Consumable }, undefined, undefined, undefined);
    assert.equal(potion.canShare, false);
  });

  it("takes no second press while one is under way, and says why the last was refused", () => {
    const pressing = view(undefined, ItemAction.PutOnSale);
    assert.equal(pressing.sale, ListingSale.Pressing);
    assert.equal(pressing.canShare, false);
    const sharing = view(undefined, ItemAction.Unshare);
    assert.equal(sharing.sharing, true);
    assert.equal(sharing.canPutOnSale, false);
    assert.equal(view(undefined, undefined, StoreRefusal.PictureMissing).refusal, StoreRefusal.PictureMissing);
  });
});

describe("the card's presses", () => {
  it("Put on sale and the toggle call main for this item, and the card shows the answer", async () => {
    // genex.games keeps the item: each answer is the item as it stands after the press.
    let held = item(FROST_AXE.itemId);
    const fake = fakeStudioApi({
      itemPutOnSale: async () => {
        held = { ...held, state: ItemState.OnSale };
        return held;
      },
      itemSetShared: async (_itemId, shared) => {
        held = { ...held, shareable: shared };
        return held;
      },
    });
    const items = createItemsStore(fake.api);
    await items.change(FROST_AXE.itemId, shareChange(false));
    await items.change(FROST_AXE.itemId, ItemAction.PutOnSale);
    assert.deepEqual(fake.callsOf("itemSetShared"), [["sku_frost", false]]);
    assert.deepEqual(fake.callsOf("itemPutOnSale"), [["sku_frost"]]);
    const { changed, busy, refused } = items.getState();
    const card = listingCardView(FROST_AXE, changed.sku_frost, busy.sku_frost, refused.sku_frost);
    assert.equal(card.sale, ListingSale.OnSale);
    assert.equal(card.shared, false);
  });
});

/** The item as genex.games answers its author. */
function item(id: string): CreatorItem {
  return {
    id,
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
  };
}

describe("the chat's composer while it makes an item", () => {
  it("asks for an item or a change, on one line", () => {
    const words = chatPlaceholder({ revisingPlan: false, studio: false, draft: false, item: true });
    assert.equal(words, ITEM_PLACEHOLDER);
    assert.equal(ITEM_PLACEHOLDER, "Ask for an item or a change…");
    assert.ok(words.length <= COMPOSER_LINE_CHARS);
    assert.equal(
      chatPlaceholder({ revisingPlan: true, studio: false, draft: false, item: true }),
      "Describe the changes to the plan…",
    );
  });
});

describe("words left for a game's chat before it opens", () => {
  it("wait for that game's chat, are taken once, and go once a chat took them", () => {
    const scope = globalThis as { window?: EventTarget };
    const hadWindow = "window" in scope;
    scope.window ??= new EventTarget();
    try {
      const request = { project: "snowball", text: "Add the shared item", send: true };
      composeInChatWhenOpen(request);
      assert.equal(takeWaitingCompose("claude-of-duty"), null, "another game's chat leaves them");
      assert.equal(takeWaitingCompose("snowball"), request);
      assert.equal(takeWaitingCompose("snowball"), null, "taken once");
      composeInChatWhenOpen(request);
      composedInChat(request);
      assert.equal(takeWaitingCompose("snowball"), null, "an open chat took them already");
    } finally {
      if (!hadWindow) delete scope.window;
    }
  });
});

const ICE: LocalListingDraft = {
  project: "ice-palace",
  state: "local",
  localId: "local_ab12cd34ef56",
  name: "Ice Shield",
  description: "Blocks one hit.",
  type: ItemType.Durable,
  priceCoins: 300,
  tags: [],
  shareable: false,
  contentHash: "3f9a".repeat(16),
};
const NEWER = "b".repeat(64);

const localView = (fields: Partial<LocalItemsView> = {}): LocalItemsView => ({
  project: "ice-palace",
  approvals: {},
  drafts: {},
  removed: [],
  outcomes: {},
  ...fields,
});
const approved = (contentHash = ICE.contentHash) => ({ [ICE.localId]: { contentHash, at: 1 } });
const local = (view?: LocalItemsView, busy?: LocalAction, failed = false) => {
  const card = localCard(ICE, view, busy, failed);
  assert.ok("local" in card, "still a local draft");
  return card.local;
};

describe("a local draft's card, before its game is published", () => {
  it("is drawn from its host record, and replaced by a newer draft of it only", () => {
    const sled = { ...ICE, localId: "local_0123456789ab", name: "Oak Sled" };
    const events = [
      drafted({ ...ICE }),
      drafted({ ...sled }),
      drafted({ ...ICE, priceCoins: 250, contentHash: NEWER }),
    ];
    const shown = cards(events);
    assert.deepEqual(
      shown.map((card) => [card.name, card.priceCoins]),
      [
        ["Oak Sled", 300],
        ["Ice Shield", 250],
      ],
    );
  });

  it("is never confused with an item on genex.games of the same id", () => {
    const shown = cards([drafted({ ...ICE }), drafted({ ...FROST_AXE, itemId: ICE.localId })]);
    assert.equal(shown.length, 2);
  });

  it("offers Sell when published, and sharing for a durable", () => {
    const card = local(localView());
    assert.equal(card.sale, LocalSale.Offer);
    assert.equal(card.canPress, true);
    assert.equal(card.canShare, true);
    assert.equal(local(undefined).sale, LocalSale.Offer, "before Studio's record is read");
  });

  it("says it will go on sale once the person approved what it holds", () => {
    assert.equal(local(localView({ approvals: approved() })).sale, LocalSale.Approved);
  });

  it("says it changed since the approval when it holds something else now", () => {
    const changed = local(
      localView({ approvals: approved(), drafts: { [ICE.localId]: { ...ICE, contentHash: NEWER } } }),
    );
    assert.equal(changed.sale, LocalSale.Changed);
    assert.equal(changed.canPress, true, "Sell when published is offered again");
    assert.equal(changed.draft.contentHash, NEWER);
  });

  it("shows the draft after the person's own change, from Studio's record", () => {
    const shared = local(localView({ drafts: { [ICE.localId]: { ...ICE, shareable: true, contentHash: NEWER } } }));
    assert.equal(shared.shared, true);
  });

  it("offers nothing once the agent removed it, and nothing twice while a press is under way", () => {
    const removed = local(localView({ removed: [ICE.localId] }));
    assert.equal(removed.sale, LocalSale.Removed);
    assert.equal(removed.canPress, false);
    assert.equal(removed.canShare, false);
    const pressing = local(localView(), LocalAction.Approve);
    assert.equal(pressing.canPress, false);
    assert.equal(pressing.canShare, false);
  });

  it("says why genex.games refused its upload; it stays local", () => {
    const outcomes = {
      [ICE.localId]: {
        kind: LocalOutcomeKind.Refused,
        skuId: null,
        contentHash: ICE.contentHash,
        refusal: StoreRefusal.PriceOffGrid,
        field: "price",
        at: 1,
      },
    };
    assert.equal(local(localView({ outcomes })).refusal, StoreRefusal.PriceOffGrid);
  });
});

describe("a local draft's card after its game's publish", () => {
  const settled = (kind: LocalOutcomeKind, refusal: StoreRefusal | null = null, contentHash = ICE.contentHash) =>
    localCard(
      ICE,
      localView({ outcomes: { [ICE.localId]: { kind, skuId: "sku_ice", contentHash, refusal, field: null, at: 1 } } }),
      undefined,
      false,
    );

  it("is the item's card on genex.games: On sale once Studio put it on sale", () => {
    const card = settled(LocalOutcomeKind.OnSale);
    assert.ok("uploaded" in card);
    assert.equal(card.uploaded.itemId, "sku_ice");
    assert.equal(listingCardView(card.uploaded, undefined, undefined, undefined).sale, ListingSale.OnSale);
  });

  it("shows the item as last changed before the upload, not as its chat card first said", () => {
    const card = localCard(
      ICE,
      localView({
        drafts: { [ICE.localId]: { ...ICE, shareable: true, contentHash: NEWER } },
        outcomes: {
          [ICE.localId]: {
            kind: LocalOutcomeKind.OnSale,
            skuId: "sku_ice",
            contentHash: NEWER,
            refusal: null,
            field: null,
            at: 1,
          },
        },
      }),
      undefined,
      false,
    );
    assert.ok("uploaded" in card);
    assert.equal(card.uploaded.shareable, true);
    assert.equal(card.unseen, false);
  });

  it("offers nothing on a card whose item Genex got in a version the card never showed", () => {
    for (const kind of [LocalOutcomeKind.Draft, LocalOutcomeKind.Changed, LocalOutcomeKind.OnSale]) {
      const card = settled(kind, null, NEWER);
      assert.ok("uploaded" in card);
      assert.equal(card.unseen, true, kind);
    }
    const unknown = localCard(
      ICE,
      localView({
        outcomes: {
          [ICE.localId]: {
            kind: LocalOutcomeKind.Draft,
            skuId: "sku_ice",
            contentHash: null,
            refusal: null,
            field: null,
            at: 1,
          },
        },
      }),
      undefined,
      false,
    );
    assert.ok("uploaded" in unknown);
    assert.equal(unknown.unseen, true, "a record that does not say what went up offers nothing either");
  });

  it("offers Put on sale for an uploaded draft the person never approved", () => {
    const card = settled(LocalOutcomeKind.Draft);
    assert.ok("uploaded" in card);
    assert.equal(listingCardView(card.uploaded, undefined, undefined, undefined).canPutOnSale, true);
    assert.equal(card.changed, false);
    assert.equal(card.unseen, false);
  });

  it("says a draft that changed since its approval stayed a draft", () => {
    const card = settled(LocalOutcomeKind.Changed);
    assert.ok("uploaded" in card);
    assert.equal(card.changed, true);
    assert.equal(listingCardView(card.uploaded, undefined, undefined, undefined).sale, ListingSale.Offer);
  });

  it("carries genex.games' refusal of Put on sale", () => {
    const card = settled(LocalOutcomeKind.Refused, StoreRefusal.PictureMissing);
    assert.ok("uploaded" in card);
    assert.equal(card.refusal, StoreRefusal.PictureMissing);
  });
});

describe("the local card's presses", () => {
  it("approve the hash the card shows, undo it, and share through main", async () => {
    const view = localView({ approvals: approved() });
    const fake = fakeStudioApi({
      itemsLocalApprove: async () => view,
      itemsLocalWithdraw: async () => localView(),
      itemsLocalShare: async () => ({ draft: { ...ICE, shareable: true, contentHash: NEWER } }),
      itemsLocal: async () => localView({ drafts: { [ICE.localId]: { ...ICE, shareable: true, contentHash: NEWER } } }),
    });
    const items = createItemsStore(fake.api);
    await items.pressLocal(ICE, LocalAction.Approve);
    assert.deepEqual(fake.callsOf("itemsLocalApprove"), [["ice-palace", ICE.localId, ICE.contentHash]]);
    assert.equal(local(items.getState().local["ice-palace"]).sale, LocalSale.Approved);
    await items.pressLocal(ICE, LocalAction.Withdraw);
    assert.deepEqual(fake.callsOf("itemsLocalWithdraw"), [["ice-palace", ICE.localId]]);
    assert.equal(local(items.getState().local["ice-palace"]).sale, LocalSale.Offer);
    await items.pressLocal(ICE, LocalAction.Share);
    assert.deepEqual(fake.callsOf("itemsLocalShare"), [["ice-palace", ICE.localId, ICE.contentHash, true]]);
    assert.equal(local(items.getState().local["ice-palace"]).shared, true);
  });

  it("says when main could not change the draft", async () => {
    const fake = fakeStudioApi({ itemsLocalShare: async () => ({ failed: true as const }) });
    const items = createItemsStore(fake.api);
    await items.pressLocal(ICE, LocalAction.Unshare);
    assert.equal(local(undefined, undefined, items.getState().localFailed[ICE.localId] === true).failed, true);
    assert.equal(items.getState().localBusy[ICE.localId], undefined);
  });

  it("settles the game through main, and reads Selling again once something went up", async () => {
    const outcomes = {
      [ICE.localId]: {
        kind: LocalOutcomeKind.OnSale,
        skuId: "sku_ice",
        contentHash: ICE.contentHash,
        refusal: null,
        field: null,
        at: 1,
      },
    };
    const fake = fakeStudioApi({ itemsLocalSettle: async () => localView({ outcomes }) });
    const items = createItemsStore(fake.api);
    await items.readSelling();
    await items.settleLocal("ice-palace", true);
    assert.deepEqual(fake.callsOf("itemsLocalSettle"), [["ice-palace", true]]);
    assert.equal(fake.callsOf("itemsSelling").length, 2);
    assert.ok("uploaded" in localCard(ICE, items.getState().local["ice-palace"], undefined, false));
  });
});

describe("when a chat with a local draft asks main to settle it at once", () => {
  const record = (state: GenexPublishJobState, finishedAt?: string) =>
    ({ job: { state, ...(finishedAt ? { finishedAt } : {}) } }) as unknown as GenexPublishState;

  it("is when the game's publish record names a publish finished since the last read", () => {
    const done = finishedPublish(record(GenexPublishJobState.Done, "2026-10-23T12:00:00.000Z"));
    assert.equal(done, "2026-10-23T12:00:00.000Z");
    assert.equal(publishFinishedSince(null, done), true, "the first publish since the chat opened");
    assert.equal(publishFinishedSince("2026-10-22T12:00:00.000Z", done), true, "a newer publish");
  });

  it("is never on the first read, for the same publish again, or while none finished", () => {
    const done = "2026-10-23T12:00:00.000Z";
    assert.equal(publishFinishedSince(undefined, done), false, "the first read names an earlier publish");
    assert.equal(publishFinishedSince(done, done), false);
    assert.equal(finishedPublish(record(GenexPublishJobState.Running)), null);
    assert.equal(finishedPublish(record(GenexPublishJobState.Failed, done)), null);
    assert.equal(finishedPublish(null), null);
  });
});

describe("which of a game's chats watch for its publish", () => {
  const uploadedAs = (kind: LocalOutcomeKind, skuId: string | null) => ({
    [ICE.localId]: { kind, skuId, contentHash: ICE.contentHash, refusal: null, field: null, at: 1 },
  });

  it("every chat of a game whose record holds a local draft still waiting to go up", () => {
    assert.equal(holdsLocalDrafts(localView({ drafts: { [ICE.localId]: ICE } })), true);
    const refused = localView({
      drafts: { [ICE.localId]: ICE },
      outcomes: uploadedAs(LocalOutcomeKind.Refused, null),
    });
    assert.equal(holdsLocalDrafts(refused), true, "a refused upload stays local, and is tried again");
  });

  it("none once every draft went up or was removed, or before main's record is read", () => {
    const up = localView({ drafts: { [ICE.localId]: ICE }, outcomes: uploadedAs(LocalOutcomeKind.OnSale, "sku_ice") });
    assert.equal(holdsLocalDrafts(up), false);
    assert.equal(holdsLocalDrafts(localView({ drafts: { [ICE.localId]: ICE }, removed: [ICE.localId] })), false);
    assert.equal(holdsLocalDrafts(localView()), false);
    assert.equal(holdsLocalDrafts(undefined), false);
  });
});
