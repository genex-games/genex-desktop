/**
 * The Shop tab's items, pure: every item a game sells, as its chat's cards show them. Its local
 * drafts first (main's record, `items.local`), then its items on genex.games that Selling lists for
 * the game's hosted project, less those a local draft's upload already shows. Changes are the
 * agent's: Ask for changes leaves `changeItemPrompt` in the game's chat, naming the id the agent
 * acts on (a local draft's, or its SKU once uploaded).
 */
import {
  isLocalDraft,
  type ListingDraft,
  type ListingRecord,
  type LocalItemsView,
} from "../../../shared/item-draft.ts";
import type { SellingRow } from "../../../shared/store-items.ts";

/** One of the game's items on genex.games as its card shows it: Selling names no description. */
function sellingListing(project: string, row: SellingRow): ListingDraft {
  return {
    project,
    itemId: row.id,
    name: row.name,
    description: null,
    type: row.type,
    priceCoins: row.priceCoins,
    priceDisplayUsdCents: row.priceDisplayUsdCents,
    iconUrl: row.iconUrl,
    state: row.state,
    shareable: row.shareable,
  };
}

/**
 * The game `project`'s items: `local` its drafts as main last answered (removed ones left out),
 * `hostedId` its project on genex.games (null or unread: none), `rows` Selling's items.
 */
export function shopItems(
  project: string,
  local: LocalItemsView | undefined,
  hostedId: string | null | undefined,
  rows: readonly SellingRow[] | undefined,
): ListingRecord[] {
  const drafts = local ? Object.values(local.drafts).filter((draft) => !local.removed.includes(draft.localId)) : [];
  const uploaded = new Set(drafts.map((draft) => local?.outcomes[draft.localId]?.skuId).filter(Boolean));
  const hosted = hostedId ? (rows ?? []).filter((row) => row.game?.id === hostedId && !uploaded.has(row.id)) : [];
  return [...drafts, ...hosted.map((row) => sellingListing(project, row))];
}

/** The id the agent changes an item by: a local draft's SKU once its upload made one, else its local id. */
export function shopItemId(record: ListingRecord, local: LocalItemsView | undefined): string {
  if (!isLocalDraft(record)) return record.itemId;
  return local?.outcomes[record.localId]?.skuId ?? record.localId;
}
