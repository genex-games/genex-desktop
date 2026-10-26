/**
 * The Listing draft card's model (marketplace P11, plan 8.3; screen 09): what the card shows for a
 * store item the game's agent made, and which presses it offers. Its words are the draft's (the
 * agent's latest `genex shop add|set`); whether it is on sale and shared is what genex.games last
 * answered a press with, else the draft's. Put on sale shows while the item is a draft or off sale;
 * an item an admin took off sale offers nothing (D14); "Other games can use it" is for a durable
 * only (P3). The presses themselves are the items store's (`state/items.ts`), carried out by main.
 *
 * A local draft (made before its game is on Genex) offers "Sell when published" instead: the person's
 * approval of what it holds now, which main honours after the game's publish only for that very
 * content. Once the publish uploaded it, its card is the item's on genex.games, with what became of
 * it: on sale, a draft (changed since the approval, or never approved), or refused with a reason.
 */
import {
  type ListingDraft,
  type LocalItemsView,
  type LocalListingDraft,
  type LocalOutcome,
  LocalOutcomeKind,
} from "../../shared/item-draft.ts";
import { type CreatorItem, ItemState, ItemType, type StoreRefusal } from "../../shared/store-items.ts";
import { ItemAction, type ItemChange, LocalAction } from "../state/items.ts";

/** Where the card's sale stands. */
export const ListingSale = {
  /** Put on sale is offered: the item is a draft, or its author took it off sale. */
  Offer: "offer",
  /** Put on sale was pressed and genex.games has not answered yet. */
  Pressing: "pressing",
  OnSale: "on-sale",
  /** An admin took it off sale after a complaint: nothing to press (D14). */
  TakenDown: "taken-down",
} as const;
export type ListingSale = (typeof ListingSale)[keyof typeof ListingSale];

/** What the card draws. */
export interface ListingCardView {
  itemId: string;
  name: string;
  description: string | null;
  iconUrl: string | null;
  priceCoins: number;
  /** Its state on genex.games, as last read. */
  state: ItemState;
  sale: ListingSale;
  /** Put on sale can be pressed now: offered, with no other press under way. */
  canPutOnSale: boolean;
  /** "Other games can use it", as it stands. */
  shared: boolean;
  /** The toggle can be pressed now. */
  canShare: boolean;
  /** A press on the toggle is under way. */
  sharing: boolean;
  /** Why genex.games refused the last press, if it did. */
  refusal: StoreRefusal | null;
}

/** Where the sale stands for an item in `state`, with `busy` the press under way. */
function saleOf(state: ItemState, busy: ItemAction | undefined): ListingSale {
  if (busy === ItemAction.PutOnSale) return ListingSale.Pressing;
  if (state === ItemState.OnSale) return ListingSale.OnSale;
  if (state === ItemState.TakenDown) return ListingSale.TakenDown;
  return ListingSale.Offer;
}

/**
 * The card for `draft`, with `latest` the item as genex.games last answered a press on it, `busy`
 * the press under way and `refusal` why the last one was refused.
 */
export function listingCardView(
  draft: ListingDraft,
  latest: Pick<CreatorItem, "state" | "shareable"> | undefined,
  busy: ItemAction | undefined,
  refusal: StoreRefusal | undefined,
): ListingCardView {
  const state = latest?.state ?? draft.state;
  const sharing = busy === ItemAction.Share || busy === ItemAction.Unshare;
  const shareable = draft.type === ItemType.Durable && state !== ItemState.TakenDown;
  const sale = saleOf(state, busy);
  return {
    itemId: draft.itemId,
    name: draft.name,
    description: draft.description,
    iconUrl: draft.iconUrl,
    priceCoins: draft.priceCoins,
    state,
    sale,
    canPutOnSale: sale === ListingSale.Offer && busy === undefined,
    shared: latest?.shareable ?? draft.shareable,
    canShare: shareable && busy === undefined,
    sharing,
    refusal: refusal ?? null,
  };
}

/** The press the toggle makes when set to `on`. */
export const shareChange = (on: boolean): ItemChange => (on ? ItemAction.Share : ItemAction.Unshare);

/** Where a local draft's sale stands before its game is published. */
export const LocalSale = {
  /** "Sell when published" is offered. */
  Offer: "offer",
  /** The person approved what it holds: it goes on sale once the game is published. */
  Approved: "approved",
  /** The person approved what it held before: it changed since, and the offer stands again. */
  Changed: "changed",
  /** The game's agent removed it: nothing to press. */
  Removed: "removed",
} as const;
export type LocalSale = (typeof LocalSale)[keyof typeof LocalSale];

/** What a local draft's card draws. */
export interface LocalCardView {
  /** The draft as it is now: Studio's record after the person's own change, else the card's. */
  draft: LocalListingDraft;
  sale: LocalSale;
  /** "Sell when published" or its undo can be pressed now. */
  canPress: boolean;
  /** The press under way, if one is. */
  busy: LocalAction | null;
  shared: boolean;
  canShare: boolean;
  /** Why genex.games refused to upload it after the publish; it stays local. */
  refusal: StoreRefusal | null;
  /** Main could not carry out the last press. */
  failed: boolean;
}

/** A local draft's card: still local, or the item genex.games holds since the publish uploaded it. */
export type LocalCard =
  | { local: LocalCardView }
  | {
      uploaded: ListingDraft;
      /** It changed since the person approved it, so it stayed a draft. */
      changed: boolean;
      /**
       * Genex got content this card never showed (an edit outside Studio): the card offers neither Put
       * on sale nor sharing, and sends the person to Create › Items, which shows the item as it is.
       */
      unseen: boolean;
      /** Why genex.games refused to put it on sale after the publish. */
      refusal: StoreRefusal | null;
    };

/** Where a local draft's sale stands, by the person's approval and what it holds now. */
function localSaleOf(draft: LocalListingDraft, view: LocalItemsView | undefined): LocalSale {
  if (view?.removed.includes(draft.localId)) return LocalSale.Removed;
  const approval = view?.approvals[draft.localId];
  if (!approval) return LocalSale.Offer;
  return approval.contentHash === draft.contentHash ? LocalSale.Approved : LocalSale.Changed;
}

/** The item genex.games holds for an uploaded local draft, as the item's own card shows it. */
function uploadedListing(draft: LocalListingDraft, outcome: LocalOutcome, skuId: string): ListingDraft {
  return {
    project: draft.project,
    itemId: skuId,
    name: draft.name,
    description: draft.description,
    type: draft.type,
    priceCoins: draft.priceCoins,
    // The card shows the coin price only.
    priceDisplayUsdCents: 0,
    iconUrl: null,
    state: outcome.kind === LocalOutcomeKind.OnSale ? ItemState.OnSale : ItemState.Draft,
    shareable: draft.shareable,
  };
}

/**
 * The card for the local draft `record` (its chat record), with `view` main's record of the game's
 * local drafts, `busy` the press under way and `failed` whether the last one failed.
 */
export function localCard(
  record: LocalListingDraft,
  view: LocalItemsView | undefined,
  busy: LocalAction | undefined,
  failed: boolean,
): LocalCard {
  const draft = view?.drafts[record.localId] ?? record;
  const outcome = view?.outcomes[record.localId];
  if (outcome?.skuId)
    return {
      uploaded: uploadedListing(draft, outcome, outcome.skuId),
      changed: outcome.kind === LocalOutcomeKind.Changed,
      unseen: outcome.contentHash !== draft.contentHash,
      refusal: outcome.kind === LocalOutcomeKind.Refused ? outcome.refusal : null,
    };
  const sale = localSaleOf(draft, view);
  const open = sale !== LocalSale.Removed && busy === undefined;
  return {
    local: {
      draft,
      sale,
      canPress: open,
      busy: busy ?? null,
      shared: draft.shareable,
      canShare: open && draft.type === ItemType.Durable,
      refusal: outcome?.kind === LocalOutcomeKind.Refused ? outcome.refusal : null,
      failed,
    },
  };
}

/**
 * Whether main's record of a game (`view`, once read) holds a local draft still waiting to go up:
 * neither uploaded nor removed. Every chat of that game then watches for its publish.
 */
export function holdsLocalDrafts(view: LocalItemsView | undefined): boolean {
  if (!view) return false;
  return Object.keys(view.drafts).some((localId) => !view.outcomes[localId]?.skuId && !view.removed.includes(localId));
}

/** The press "Sell when published" makes as it stands: approve, or take the approval back. */
export const sellWhenPublished = (sale: LocalSale): LocalAction =>
  sale === LocalSale.Approved ? LocalAction.Withdraw : LocalAction.Approve;
