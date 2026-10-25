/**
 * Create › Items › Browse (marketplace P10, screen 07): other creators' shared items, free to add to
 * the account's games. The intro, then a grid of cards (the render on its gradient, the name, the
 * price and "in N games"); pressing one shows it in the detail panel beside the grid
 * (`ItemDetail.tsx`). The search lives in the page's head (`ItemsPage.tsx`).
 */
import type { JSX, ReactNode } from "react";
import type { BrowseItem } from "../../../shared/store-items.ts";
import { CoinMark } from "../../play/CoinMark.tsx";
import { ItemRender } from "../../play/ItemRender.tsx";
import { coinNumber, coinText, gameText } from "../../play/purchase-model.ts";
import { useItems } from "../../state/hooks.ts";
import { ItemAction, ItemsRead } from "../../state/items.ts";
import { studio } from "../../state/studio.ts";
import { Button } from "../../ui/Button.tsx";
import { ITEMS_WORDS, itemRefusalWords, PLAY_STORE_WORDS } from "../../words.ts";
import { addedIn, browseIntro } from "./browse-model.ts";
import { ItemDetail, type OfferedGame } from "./ItemDetail.tsx";
import { ReadNote } from "./ReadNote.tsx";

const WORDS = ITEMS_WORDS;

/** One card: the render, the name, then the price and "in N games". */
function Card({ item, selected }: { item: BrowseItem; selected: boolean }): JSX.Element {
  return (
    <button
      type="button"
      className="store-card items-card"
      data-items-card={item.id}
      aria-pressed={selected}
      onClick={() => void studio().items.choose(item.id)}
    >
      <ItemRender item={item} className="store-card-render" />
      <span className="store-card-name" dir="auto">
        {gameText(item.name)}
      </span>
      <span className="items-card-line">
        {item.priceCoins === 0 ? (
          <span>{PLAY_STORE_WORDS.free}</span>
        ) : (
          <span className="items-coin">
            <CoinMark size={14} />
            <span aria-hidden="true">{coinNumber(item.priceCoins)}</span>
            <span className="sr-only">{coinText(item.priceCoins)}</span>
          </span>
        )}
        <span>{WORDS.inGames(item.gamesCount)}</span>
      </span>
    </button>
  );
}

/** What Add to needs from the page: the games it offers, the one it adds to, and the presses. */
export interface AddToGame {
  games: readonly OfferedGame[];
  target: OfferedGame | null;
  onChoose: (game: string) => void;
  onAdd: (item: BrowseItem, game: string) => void;
  onRemove: (item: BrowseItem, game: string) => void;
}

/** Browse: the page's head, the intro and the grid, with the detail panel of the item on show beside them. */
export function BrowseTab({
  head,
  panel,
  add,
  onRetry,
}: {
  head: ReactNode;
  /** The tab panel's id, which the tabs control. */
  panel: string;
  add: AddToGame;
  onRetry: () => void;
}): JSX.Element {
  const browse = useItems((s) => s.browse);
  const busy = useItems((s) => (browse.selectedId ? s.busy[browse.selectedId] : undefined));
  const refused = useItems((s) => (browse.selectedId ? s.refused[browse.selectedId] : undefined));
  const targetProject = useItems((s) => (add.target ? (s.hosted[add.target.name] ?? null) : null));
  const shown = browse.items.find((item) => item.id === browse.selectedId) ?? null;
  const added = shown ? addedIn(browse.details[shown.id], targetProject) : null;
  const listed = browse.read === ItemsRead.Ready || browse.items.length > 0;
  return (
    <div className="items-browse" data-items-browse>
      <div className="items-browse-main">
        {head}
        <div id={panel} role="tabpanel" className="items-browse-list">
          <p className="items-intro">{browseIntro(browse.sellerShareBps)}</p>
          {!listed && <ReadNote read={browse.read} onRetry={onRetry} />}
          {listed && browse.items.length === 0 && (
            <p className="items-note">{browse.query ? WORDS.noMatch : WORDS.noneShared}</p>
          )}
          {browse.items.length > 0 && (
            <div className="items-grid" data-items-grid>
              {browse.items.map((item) => (
                <Card key={item.id} item={item} selected={item.id === browse.selectedId} />
              ))}
            </div>
          )}
          {browse.nextCursor && (
            <Button
              variant="secondary"
              className="items-more"
              busy={browse.more}
              onClick={() => void studio().items.more()}
            >
              {WORDS.more}
            </Button>
          )}
        </div>
      </div>
      {shown && (
        <ItemDetail
          item={shown}
          games={add.games}
          target={add.target}
          added={added}
          busy={{ add: busy === ItemAction.Add, remove: busy === ItemAction.Remove }}
          sellerShareBps={browse.sellerShareBps}
          refusal={refused ? itemRefusalWords(refused) : null}
          onChoose={add.onChoose}
          onAdd={add.onAdd}
          onRemove={add.onRemove}
        />
      )}
    </div>
  );
}
