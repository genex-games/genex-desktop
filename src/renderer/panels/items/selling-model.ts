/**
 * Selling's rows (marketplace P10, screen 08), pure: the status each row shows, the line under its
 * name, its price, and what its ⋯ menu offers for the item's state.
 */
import { ItemState, ItemType, type SellingRow } from "../../../shared/store-items.ts";
import { coinNumber } from "../../play/purchase-model.ts";
import { PLAY_STORE_WORDS } from "../../words.ts";

/** A row's status, as the design names it. */
export const SellingStatus = {
  /** "Draft, put on sale": one press puts it on sale (P12). */
  Draft: "draft",
  UnderReview: "under-review",
  /** Off sale, dimmed: its author took it off, or an admin did (D14). */
  OffSale: "off-sale",
} as const;
export type SellingStatus = (typeof SellingStatus)[keyof typeof SellingStatus];

/** The status a row shows: a complaint first, then a draft, then off sale; null for an item on sale. */
export function sellingStatus(row: Pick<SellingRow, "state" | "underReview">): SellingStatus | null {
  if (row.underReview) return SellingStatus.UnderReview;
  if (row.state === ItemState.Draft) return SellingStatus.Draft;
  const off = row.state === ItemState.OffSale || row.state === ItemState.TakenDown;
  return off ? SellingStatus.OffSale : null;
}

/** What a row's ⋯ menu offers. */
export interface RowMenu {
  /** Put on sale (a draft or an item its author took off), else Take off sale. */
  putOnSale: boolean;
  /** "Other games can use it" can be set: a durable only (P3). */
  share: boolean;
  /** Ask the agent to change it: its game is on this computer. */
  ask: boolean;
}

/** The menu for `row`, or null for an item an admin took off sale: its author can change nothing (D14). */
export function rowMenu(row: Pick<SellingRow, "state" | "type">, local: boolean): RowMenu | null {
  if (row.state === ItemState.TakenDown) return null;
  return {
    putOnSale: row.state === ItemState.Draft || row.state === ItemState.OffSale,
    share: row.type === ItemType.Durable,
    ask: local,
  };
}

/** A row's price: Free for an item that costs nothing, as the Store card and the sheet say, else its coin. */
export const sellingPrice = (row: Pick<SellingRow, "priceCoins">): string =>
  row.priceCoins === 0 ? PLAY_STORE_WORDS.free : coinNumber(row.priceCoins);
