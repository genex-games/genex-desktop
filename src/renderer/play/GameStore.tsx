/**
 * A game's Store section on its Play page (marketplace plan 10.3, P5–P7; screens 01–02): the Store
 * title with a Store / My items toggle (My items with the count of what the player owns), then a
 * grid of up to six cards a row. Store shows the game's own items on sale and the shared items it
 * added: each card the item's render on a soft gradient, its name, and its price, Free or Owned,
 * with "N games" on a shared one. My items shows everything the player owns, each Works here, N left
 * or dimmed Not in this game. Pressing a card opens the item's sheet (`ItemSheet.tsx`); a purchase or
 * a claim reads the store again. The section shows only once the game sells something (D28).
 */
import type { JSX, KeyboardEvent } from "react";
import { useId, useState } from "react";
import type { MyItem, PlayerItem, StoreItem } from "../../shared/store-items.ts";
import { usePeople } from "../state/hooks.ts";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/icons.tsx";
import { PLAY_STORE_WORDS, PLAY_WORDS } from "../words.ts";
import { CoinMark } from "./CoinMark.tsx";
import { type ChosenItem, ItemSheet } from "./ItemSheet.tsx";
import { ItemRender } from "./ItemRender.tsx";
import { coinNumber, coinText, gameText } from "./purchase-model.ts";
import { SignInNote } from "./SignInNote.tsx";
import {
  CardLine,
  type CardLineView,
  gamesBadge,
  type ItemOffer,
  MyItemsStatus,
  myItemLine,
  myItemOffer,
  StoreView,
  storeLine,
  storeOffer,
  storeShown,
} from "./store-model.ts";
import { formatCount } from "./play-model.ts";
import { type GameStoreRead, useGameStore } from "./use-game-store.ts";

const WORDS = PLAY_STORE_WORDS;
const VIEWS = [StoreView.Store, StoreView.MyItems] as const;

/** A card's line under its name. */
function Line({ view }: { view: CardLineView }): JSX.Element {
  const text = (() => {
    switch (view.line) {
      case CardLine.Price:
        return (
          <>
            <CoinMark size={14} />
            <span aria-hidden="true">{coinNumber(view.coins)}</span>
            <span className="sr-only">{coinText(view.coins)}</span>
          </>
        );
      case CardLine.Left:
        return WORDS.left(view.count);
      case CardLine.Free:
        return WORDS.free;
      case CardLine.Owned:
        return WORDS.owned;
      case CardLine.WorksHere:
        return WORDS.worksHere;
      default:
        return WORDS.notHere;
    }
  })();
  return (
    <span className="store-card-line" data-store-line={view.line}>
      {text}
    </span>
  );
}

/** One card: the render on its gradient with a shared item's badge, the name, and the line. */
function Card({
  item,
  line,
  offer,
  onChoose,
}: {
  item: PlayerItem;
  line: CardLineView;
  offer: ItemOffer;
  onChoose: (chosen: ChosenItem) => void;
}): JSX.Element {
  const badge = gamesBadge(item);
  const dimmed = line.line === CardLine.NotHere;
  return (
    <button
      type="button"
      className="store-card"
      data-store-item={item.id}
      data-item-offer={offer}
      data-dimmed={dimmed || undefined}
      onClick={() => onChoose({ item, offer })}
    >
      <ItemRender
        item={item}
        dimmed={dimmed}
        className="store-card-render"
        badge={
          badge === null ? null : (
            <span className="store-card-badge" data-store-games={badge}>
              <Icon name="boxes" size={12} />
              {WORDS.games(badge)}
            </span>
          )
        }
      />
      <span className="store-card-name" dir="auto">
        {gameText(item.name)}
      </span>
      <Line view={line} />
    </button>
  );
}

/** The Store / My items toggle; arrow keys move between its halves. */
function StoreTabs({
  view,
  count,
  panel,
  onChoose,
}: {
  view: StoreView;
  count: number | null;
  panel: string;
  onChoose: (view: StoreView) => void;
}): JSX.Element {
  const keys = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const next = view === StoreView.Store ? StoreView.MyItems : StoreView.Store;
    onChoose(next);
    event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`[data-game-store-view="${next}"]`)?.focus();
  };
  return (
    <div className="store-tabs" role="tablist" aria-label={WORDS.tabsLabel}>
      {VIEWS.map((one) => (
        <button
          key={one}
          type="button"
          role="tab"
          className="store-tab"
          aria-selected={one === view}
          aria-controls={panel}
          tabIndex={one === view ? 0 : -1}
          data-game-store-view={one}
          onClick={() => onChoose(one)}
          onKeyDown={keys}
        >
          {one === StoreView.Store ? WORDS.storeTab : WORDS.myItemsTab}
          {one === StoreView.MyItems && count !== null && <span className="store-tab-count">{formatCount(count)}</span>}
        </button>
      ))}
    </div>
  );
}

/** The Store tab's cards. */
function StoreGrid({ items, onChoose }: { items: StoreItem[]; onChoose: (chosen: ChosenItem) => void }) {
  return (
    <div className="store-grid">
      {items.map((item) => (
        <Card key={item.id} item={item} line={storeLine(item)} offer={storeOffer(item)} onChoose={onChoose} />
      ))}
    </div>
  );
}

/** My items: the cards, or Sign in, nothing owned yet, or a failure with Retry. */
function MyItemsPanel({ store, onChoose }: { store: GameStoreRead; onChoose: (chosen: ChosenItem) => void }) {
  const { status, items } = store.mine;
  if (status === MyItemsStatus.SignedOut) return <SignInNote text={WORDS.signInForItems} />;
  if (status === MyItemsStatus.Failed)
    return (
      <div className="people-note" data-my-items={status}>
        {WORDS.itemsFailed}
        <Button variant="secondary" onClick={store.reread}>
          {PLAY_WORDS.retry}
        </Button>
      </div>
    );
  if (status === MyItemsStatus.Ready && items.length === 0)
    return (
      <p className="people-note" data-my-items="empty">
        {WORDS.noItems}
      </p>
    );
  return (
    <div className="store-grid" data-my-items={status}>
      {items.map((item: MyItem) => (
        <Card key={item.id} item={item} line={myItemLine(item)} offer={myItemOffer(item)} onChoose={onChoose} />
      ))}
    </div>
  );
}

/** The Store section of the game `slug`'s page; nothing while the game sells nothing. */
export function GameStore({ slug }: { slug: string }): JSX.Element | null {
  const account = usePeople((s) => s.me?.id ?? null);
  const store = useGameStore(slug, account);
  const [chosen, setChosen] = useState<ChosenItem | null>(null);
  const ids = useId();
  if (!storeShown(store.tab)) return null;
  const heading = `${ids}-title`;
  const panel = `${ids}-panel`;
  return (
    <section className="game-store" aria-labelledby={heading} data-game-store={slug}>
      <div className="game-store-head">
        <h2 id={heading} className="game-store-title">
          {WORDS.title}
        </h2>
        <StoreTabs view={store.view} count={store.tab.myItemsCount} panel={panel} onChoose={store.choose} />
      </div>
      <div id={panel} role="tabpanel" aria-labelledby={heading} data-game-store-panel={store.view}>
        {store.view === StoreView.Store ? (
          <StoreGrid items={store.tab.items} onChoose={setChosen} />
        ) : (
          <MyItemsPanel store={store} onChoose={setChosen} />
        )}
      </div>
      {chosen && (
        <ItemSheet
          key={chosen.item.id}
          chosen={chosen}
          slug={slug}
          account={account}
          onClose={() => setChosen(null)}
          onReread={store.reread}
        />
      )}
    </section>
  );
}
