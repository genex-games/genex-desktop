/**
 * Browse's detail panel (marketplace P10, screen 07): the item's render, its name, By \<author>, its
 * description, what players pay and what the selling game gets per sale (genex.games' own number,
 * never computed here, with the share genex.games configures when it names one), then the split button Add to \<game> ▾, whose arrow picks which of the
 * account's games on Genex takes it, and "Your agent puts it in the game." Add allows the item in
 * that game and hands the game's chat agent the prompt that puts it in (`ItemsPage`). An item already
 * in that game says Added to \<game> instead (with when players see it, Q5) and offers Remove from
 * \<game>, which asks first.
 */
import type { JSX, RefObject } from "react";
import { useRef, useState } from "react";
import type { BrowseItem } from "../../../shared/store-items.ts";
import { DialogFoot } from "../../play/card-menu/DialogFoot.tsx";
import { CoinMark } from "../../play/CoinMark.tsx";
import { ItemRender } from "../../play/ItemRender.tsx";
import { coinNumber, coinText, gameText } from "../../play/purchase-model.ts";
import { Button } from "../../ui/Button.tsx";
import { DialogSurface } from "../../ui/dialog.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "../../ui/dropdown-menu.tsx";
import { Icon } from "../../ui/icons.tsx";
import { ITEMS_WORDS, PLAY_STORE_WORDS } from "../../words.ts";
import { youGetLabel } from "./browse-model.ts";

const WORDS = ITEMS_WORDS;

/** One of the account's games Add to offers: its local name and its title. */
export interface OfferedGame {
  name: string;
  title: string;
}

/** An amount of coin with the coin mark, read aloud as coin. */
function Coin({ coins, className }: { coins: number; className?: string }): JSX.Element {
  if (coins === 0) return <span className={className}>{PLAY_STORE_WORDS.free}</span>;
  return (
    <span className={className}>
      <CoinMark size={14} />
      <span aria-hidden="true">{coinNumber(coins)}</span>
      <span className="sr-only">{coinText(coins)}</span>
    </span>
  );
}

/** Where the item stands in the game Add to acts on: added there (and sold there yet), or null. */
export type AddedIn = { live: boolean } | null;

/** Add to \<game>, or Added to \<game> for an item already in it, with the game picker; nothing to add to says so. */
function AddTo({
  item,
  games,
  target,
  added,
  busy,
  chooser,
  onChoose,
  onAdd,
}: {
  item: BrowseItem;
  games: readonly OfferedGame[];
  target: OfferedGame | null;
  added: AddedIn;
  busy: boolean;
  /** The game picker's button: the focus comes back to it, which stays whether the item is added or not. */
  chooser: RefObject<HTMLButtonElement | null>;
  onChoose: (game: string) => void;
  onAdd: (item: BrowseItem, game: string) => void;
}): JSX.Element {
  if (!target) return <p className="items-detail-note">{WORDS.noGame}</p>;
  return (
    <div className="items-split">
      {added ? (
        <span className="items-split-main items-added control-quiet font-mono text-sm" data-items-added={target.name}>
          <Icon name="check" size={14} />
          <span className="truncate">{WORDS.addedTo(gameText(target.title))}</span>
        </span>
      ) : (
        <Button
          variant="default"
          className="items-split-main"
          busy={busy}
          data-items-add-to={target.name}
          onClick={() => onAdd(item, target.name)}
        >
          <span className="truncate">{WORDS.addTo(gameText(target.title))}</span>
        </Button>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            ref={chooser}
            variant={added ? "secondary" : "default"}
            className="items-split-more"
            aria-label={WORDS.chooseGame}
            data-items-choose-game
            disabled={busy}
          >
            <Icon name="chevron-down" size={14} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-56">
          <DropdownMenuRadioGroup value={target.name} onValueChange={onChoose}>
            {games.map((game) => (
              <DropdownMenuRadioItem key={game.name} value={game.name} data-items-game={game.name}>
                <span className="truncate">{gameText(game.title)}</span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** Remove from \<game>, asked first: the game's Store stops selling it, and its owners keep it. */
function RemoveDialog({
  item,
  game,
  returnFocus,
  onClose,
  onRemove,
}: {
  item: BrowseItem;
  game: OfferedGame;
  returnFocus: RefObject<HTMLElement | null>;
  onClose: () => void;
  onRemove: (item: BrowseItem, game: string) => void;
}): JSX.Element {
  return (
    <DialogSurface
      title={WORDS.removeTitle(gameText(item.name), gameText(game.title))}
      description={WORDS.removeBody}
      onDismiss={onClose}
      returnFocus={returnFocus}
    >
      <DialogFoot problem={null} busy={false} onCancel={onClose}>
        <Button
          variant="destructive"
          data-items-remove-confirm={game.name}
          onClick={() => {
            onClose();
            onRemove(item, game.name);
          }}
        >
          {WORDS.remove}
        </Button>
      </DialogFoot>
    </DialogSurface>
  );
}

/** What an item already in the game says under Added: when players see it, and Remove from \<game>. */
function Added({
  item,
  target,
  added,
  busy,
  returnFocus,
  onRemove,
}: {
  item: BrowseItem;
  target: OfferedGame;
  added: { live: boolean };
  busy: boolean;
  returnFocus: RefObject<HTMLElement | null>;
  onRemove: (item: BrowseItem, game: string) => void;
}): JSX.Element {
  const [asking, setAsking] = useState(false);
  return (
    <>
      {!added.live && <p className="items-detail-note">{WORDS.addedNextRelease}</p>}
      <Button
        variant="ghost"
        className="items-remove"
        busy={busy}
        data-items-remove-from={target.name}
        onClick={() => setAsking(true)}
      >
        <span className="truncate">{WORDS.removeFrom(gameText(target.title))}</span>
      </Button>
      {asking && (
        <RemoveDialog
          item={item}
          game={target}
          returnFocus={returnFocus}
          onClose={() => setAsking(false)}
          onRemove={onRemove}
        />
      )}
    </>
  );
}

/** The panel for the item on show. */
export function ItemDetail({
  item,
  games,
  target,
  added,
  busy,
  sellerShareBps,
  refusal,
  onChoose,
  onAdd,
  onRemove,
}: {
  item: BrowseItem;
  games: readonly OfferedGame[];
  target: OfferedGame | null;
  /** The item in the game Add to acts on: added there (and sold there yet), or null. */
  added: AddedIn;
  /** A press under way on the item: Add to, or Remove from. */
  busy: { add: boolean; remove: boolean };
  /** The selling game's share genex.games configures, in basis points; absent from an older API. */
  sellerShareBps: number | undefined;
  refusal: string | null;
  onChoose: (game: string) => void;
  onAdd: (item: BrowseItem, game: string) => void;
  onRemove: (item: BrowseItem, game: string) => void;
}): JSX.Element {
  const chooser = useRef<HTMLButtonElement | null>(null);
  const pressing = busy.add || busy.remove;
  return (
    <aside className="items-detail" data-items-detail={item.id} aria-label={gameText(item.name)}>
      <ItemRender item={item} turnable className="items-detail-render" />
      <div className="items-detail-words">
        <h2 className="items-detail-name" dir="auto">
          {gameText(item.name)}
        </h2>
        <p className="items-detail-by">{WORDS.by(gameText(item.author.handle ?? item.author.name))}</p>
        {item.description && (
          <p className="items-detail-description" dir="auto">
            {gameText(item.description)}
          </p>
        )}
      </div>
      <dl className="items-detail-money">
        <div>
          <dt>{WORDS.playersPay}</dt>
          <dd>
            <Coin coins={item.priceCoins} className="items-coin" />
          </dd>
        </div>
        <div>
          <dt>{youGetLabel(sellerShareBps)}</dt>
          <dd className="items-gain">{WORDS.gain(coinNumber(item.youGetPerSale))}</dd>
        </div>
      </dl>
      <div className="items-detail-add">
        <AddTo
          item={item}
          games={games}
          target={target}
          added={added}
          busy={pressing}
          chooser={chooser}
          onChoose={onChoose}
          onAdd={onAdd}
        />
        {target && added && (
          <Added
            item={item}
            target={target}
            added={added}
            busy={busy.remove}
            returnFocus={chooser}
            onRemove={onRemove}
          />
        )}
        {refusal ? (
          <p role="alert" className="items-detail-refusal">
            {refusal}
          </p>
        ) : (
          target && !added && <p className="items-detail-note">{WORDS.agentPutsIt}</p>
        )}
      </div>
    </aside>
  );
}
