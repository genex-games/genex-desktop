/**
 * The profile's item shelf (marketplace P8, screen 06): under the handle and above the stats, a
 * decorative row of up to five items the person owns, as renders with no backgrounds. Hovering one,
 * focusing it or pressing it shows a small card: the item's name, an "Item" tag, and **Get in
 * \<game>** with that game's cover, which opens that game's page (only while that game still sells it).
 * Nothing draws while it is read, when it cannot be, or when the person owns none.
 */
import type { JSX } from "react";
import { useEffect, useState } from "react";
import type { ShelfItem } from "../../shared/store-items.ts";
import { studio } from "../state/studio.ts";
import { PLAY_STORE_WORDS } from "../words.ts";
import { ItemRender } from "./ItemRender.tsx";
import { gameText } from "./purchase-model.ts";
import { shelfGetIn, shelfShown } from "./store-model.ts";

const WORDS = PLAY_STORE_WORDS;

/** One item on the shelf, and its card while hovered, focused or pressed open. */
function ShelfEntry({ item }: { item: ShelfItem }): JSX.Element {
  const [open, setOpen] = useState(false);
  // An item its game no longer sells stays on the shelf, with no way to get it there.
  const game = shelfGetIn(item);
  return (
    <li
      className="item-shelf-entry"
      data-open={open || undefined}
      data-shelf-item={item.id}
      // A card pressed open closes once the keyboard or a click goes elsewhere.
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <button
        type="button"
        className="item-shelf-item"
        aria-label={gameText(item.name)}
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && open) {
            event.stopPropagation();
            setOpen(false);
          }
        }}
      >
        <ItemRender item={item} backdrop={false} className="item-shelf-render" />
      </button>
      <div className="item-shelf-card">
        <span className="item-shelf-name" dir="auto">
          {gameText(item.name)}
          <span className="item-shelf-tag">{WORDS.itemTag}</span>
        </span>
        {game && (
          <button
            type="button"
            className="item-shelf-get"
            data-shelf-get={game.slug}
            onClick={() => studio().play.showGame(game.slug)}
          >
            {game.coverUrl && (
              <img className="item-shelf-cover" src={game.coverUrl} alt="" draggable={false} decoding="async" />
            )}
            {WORDS.getIn(gameText(game.title))}
          </button>
        )}
      </div>
    </li>
  );
}

/** The shelf of the person `userId`; nothing when they own no items. */
export function ItemShelf({ userId }: { userId: string }): JSX.Element | null {
  const [items, setItems] = useState<ShelfItem[]>([]);
  useEffect(() => {
    let live = true;
    void studio()
      .api.storeShelf(userId)
      .then((read) => live && setItems(shelfShown(read)))
      // A shelf that cannot be read is decoration missing: the profile draws without it.
      .catch(() => live && setItems([]));
    return () => {
      live = false;
    };
  }, [userId]);
  if (items.length === 0) return null;
  return (
    <ul className="item-shelf" aria-label={WORDS.shelfLabel} data-item-shelf>
      {items.map((item) => (
        <ShelfEntry key={item.id} item={item} />
      ))}
    </ul>
  );
}
