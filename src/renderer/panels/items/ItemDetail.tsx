/**
 * Browse's detail panel (marketplace P10, screen 07): the item's render, its name, By \<author>, its
 * description, what players pay and what the selling game gets per sale (genex.games' own number,
 * never computed here, with the share genex.games configures when it names one), then For \<game ▾>,
 * which picks which of the account's games on Genex takes it, Add to game and "Your agent puts it in
 * the game." Add allows the item in that game and hands the game's chat agent the prompt that puts
 * it in (`ItemsPage`). An item already in that game says so instead (Added to your game until a
 * build that has it goes live, Q5; then On sale in your game) and offers Remove from game, which
 * asks first.
 */
import type { JSX, RefObject } from "react";
import { useId, useRef, useState } from "react";
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

/** For \<game ▾>: which of the account's games on Genex the item is for. */
function GamePicker({
  games,
  target,
  busy,
  chooser,
  onChoose,
}: {
  games: readonly OfferedGame[];
  target: OfferedGame;
  busy: boolean;
  /** The picker's button: the focus comes back to it, which stays whether the item is added or not. */
  chooser: RefObject<HTMLButtonElement | null>;
  onChoose: (game: string) => void;
}): JSX.Element {
  const label = useId();
  const value = useId();
  return (
    <div className="items-for">
      <span id={label} className="items-for-label">
        {WORDS.forGame}
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            ref={chooser}
            type="button"
            className="items-for-pick"
            aria-labelledby={`${label} ${value}`}
            title={WORDS.chooseGame}
            data-items-choose-game
            disabled={busy}
          >
            <span id={value} className="truncate">
              {gameText(target.title)}
            </span>
            <Icon name="chevron-down" size={14} />
          </button>
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

/** An item already in the game: where it stands there, and Remove from game, asked first. */
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
      <div role="status" className="items-added" data-items-added={target.name}>
        <Icon name="check" size={18} />
        <span className="items-added-words">
          <span>{added.live ? WORDS.onSaleInGame : WORDS.addedToGame}</span>
          <span className="items-added-sub">{added.live ? WORDS.buyableNow : WORDS.seenAfterPublish}</span>
        </span>
      </div>
      <Button variant="secondary" busy={busy} data-items-remove-from={target.name} onClick={() => setAsking(true)}>
        {WORDS.removeFromGame}
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
        {target ? (
          <GamePicker games={games} target={target} busy={pressing} chooser={chooser} onChoose={onChoose} />
        ) : (
          <p className="items-detail-note">{WORDS.noGame}</p>
        )}
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
        {target && !added && (
          <Button
            variant="default"
            busy={busy.add}
            data-items-add-to={target.name}
            onClick={() => onAdd(item, target.name)}
          >
            {WORDS.addToGame}
          </Button>
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
