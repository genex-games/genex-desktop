/**
 * The stage's Shop tab: every item the game sells, as its chat's cards show them, beside Live and
 * Builds. The person reviews them here and changes one through the game's agent: Ask for changes
 * (each tile's pencil) leaves the change prompt in the game's chat, beside the stage. Studio puts
 * every item on sale when the game is published (`core/local-items.ts`), so the tiles press nothing
 * on genex.games but "Other games can use it", which an item shows once its game is on Genex.
 */
import type { JSX } from "react";
import { type ListingRecord, listingKey } from "../../../shared/item-draft.ts";
import { ListingDraftCard, ListingLook } from "../../chat/ListingDraftCard.tsx";
import { chatPrompt, composeInChat } from "../../compose-in-chat.ts";
import { useItems } from "../../state/hooks.ts";
import { ITEMS_WORDS } from "../../words.ts";
import { changeItemPrompt } from "../items/items-prompts.ts";
import { shopItemId } from "./shop-model.ts";

/** The Shop tab: the game's items as tiles, each with its pencil for Ask for changes. */
export default function ShopStage({
  project,
  items,
}: {
  project: string;
  items: readonly ListingRecord[];
}): JSX.Element {
  const local = useItems((s) => s.local[project]);
  const ask = (record: ListingRecord) => {
    composeInChat({ project, text: changeItemPrompt(record.name, shopItemId(record, local)) });
    requestAnimationFrame(() => chatPrompt()?.focus());
  };
  return (
    <div data-shop-stage="" className="shop-stage absolute inset-0 overflow-y-auto">
      <p className="shop-note">{ITEMS_WORDS.draftsNote}</p>
      <div className="shop-grid">
        {items.map((record) => (
          <ListingDraftCard key={listingKey(record)} draft={record} look={ListingLook.Tile} onAsk={() => ask(record)} />
        ))}
      </div>
    </div>
  );
}
