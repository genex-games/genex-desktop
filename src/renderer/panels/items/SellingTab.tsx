/**
 * Create › Items › Selling (marketplace P10–P13, screen 08): the strip with the coin ready to use and
 * the coin on hold ("Nex you earn is spent in games, like any Nex."; there is no exchange to
 * credits, P16), then the account's items, newest first: each with its game, "in N games" and its
 * status (Draft, put on sale; Report under review; Off sale, dimmed), its price, how many sold and
 * what it earned, and a ⋯ menu: Put on sale, Take off sale, Other games can use it, and Ask the agent
 * to change it, which opens the item's game's chat with words to finish. Every number is
 * genex.games' own; every press is carried out by main.
 */
import type { JSX, ReactNode } from "react";
import { isStoreRefused, ItemState, type SellingRow } from "../../../shared/store-items.ts";
import { CoinMark } from "../../play/CoinMark.tsx";
import { ItemRender } from "../../play/ItemRender.tsx";
import { coinNumber, coinText, gameText } from "../../play/purchase-model.ts";
import { useItems } from "../../state/hooks.ts";
import { ItemAction, type ItemChange } from "../../state/items.ts";
import { studio } from "../../state/studio.ts";
import { ToastTone } from "../../state/toasts.ts";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../ui/dropdown-menu.tsx";
import { Icon } from "../../ui/icons.tsx";
import { ITEMS_WORDS, itemRefusalWords } from "../../words.ts";
import { ReadNote } from "./ReadNote.tsx";
import { rowMenu, sellingPrice, SellingStatus, sellingStatus } from "./selling-model.ts";

const WORDS = ITEMS_WORDS;
/** What Selling shows for a number an item has none of yet (a draft's sales). */
const NONE = "–";

/** Ask genex.games through main; a refusal or an outage is said in a toast. */
function change(itemId: string, action: ItemChange): void {
  const app = studio();
  void app.items.change(itemId, action).then((outcome) => {
    if (isStoreRefused(outcome)) app.notify(itemRefusalWords(outcome.refused), ToastTone.Error);
  });
}

/** An amount of coin with the coin mark. */
function Coin({ coins, size }: { coins: number; size: number }): JSX.Element {
  return (
    <span className="items-coin">
      <CoinMark size={size} />
      <span aria-hidden="true">{coinNumber(coins)}</span>
      <span className="sr-only">{coinText(coins)}</span>
    </span>
  );
}

/** The strip: the coin ready to use, the coin on hold (when there is a hold), and the note. */
function Strip(): JSX.Element | null {
  const selling = useItems((s) => s.selling.selling);
  if (!selling) return null;
  return (
    <section className="items-strip">
      <div className="items-strip-figure">
        <span className="items-strip-label">{WORDS.readyToUse}</span>
        <Coin coins={selling.earnedReady} size={20} />
      </div>
      {selling.holdDays > 0 && (
        <div className="items-strip-figure" data-items-held>
          <span className="items-strip-label">{WORDS.onHold(selling.holdDays)}</span>
          <Coin coins={selling.earnedHeld} size={20} />
        </div>
      )}
      <p className="items-strip-note">{WORDS.coinNote}</p>
    </section>
  );
}

/** The status cell: Draft, put on sale (one press, P12), Report under review, or Off sale. */
function Status({ row, busy }: { row: SellingRow; busy: boolean }): JSX.Element | null {
  const status = sellingStatus(row);
  if (status === SellingStatus.Draft)
    return (
      <button
        type="button"
        className="items-status"
        data-items-status={status}
        data-items-put-on-sale={row.id}
        disabled={busy}
        aria-busy={busy || undefined}
        onClick={() => change(row.id, ItemAction.PutOnSale)}
      >
        <span className="items-status-dot" aria-hidden="true" />
        <span className="items-status-link">{WORDS.draftPutOnSale}</span>
      </button>
    );
  if (status === null) return null;
  return (
    <span className="items-status" data-items-status={status}>
      <span className="items-status-dot" aria-hidden="true" />
      {status === SellingStatus.UnderReview ? WORDS.underReview : WORDS.offSale}
    </span>
  );
}

/** The ⋯ menu: what the item's state allows, and Ask the agent when its game is on this computer. */
function Actions({
  row,
  busy,
  onAsk,
}: {
  row: SellingRow;
  busy: boolean;
  onAsk: ((row: SellingRow) => void) | null;
}): JSX.Element | null {
  const menu = rowMenu(row, onAsk !== null);
  if (!menu) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="items-row-more"
          aria-label={WORDS.actions(gameText(row.name))}
          data-items-actions={row.id}
          disabled={busy}
        >
          <Icon name="more" size={16} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-60">
        {menu.putOnSale ? (
          <DropdownMenuItem
            data-items-action={ItemAction.PutOnSale}
            onSelect={() => change(row.id, ItemAction.PutOnSale)}
          >
            {WORDS.putOnSale}
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem
            data-items-action={ItemAction.TakeOffSale}
            onSelect={() => change(row.id, ItemAction.TakeOffSale)}
          >
            {WORDS.takeOffSale}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          data-items-action={row.shareable ? ItemAction.Unshare : ItemAction.Share}
          role="menuitemcheckbox"
          aria-checked={row.shareable}
          disabled={!menu.share}
          onSelect={() => change(row.id, row.shareable ? ItemAction.Unshare : ItemAction.Share)}
        >
          <span className="flex-1">{WORDS.shared}</span>
          {row.shareable && <Icon name="check" size={14} />}
        </DropdownMenuItem>
        {onAsk && menu.ask && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem data-items-action="ask" onSelect={() => onAsk(row)}>
              {WORDS.askAgent}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** One item's row. */
function Row({ row, onAsk }: { row: SellingRow; onAsk: ((row: SellingRow) => void) | null }): JSX.Element {
  const busy = useItems((s) => s.busy[row.id] !== undefined);
  const draft = row.state === ItemState.Draft;
  const game = row.game ? gameText(row.game.title) : null;
  const games = row.gamesCount > 1 ? WORDS.inGames(row.gamesCount) : null;
  const where = game && games ? WORDS.gameLine(game, games) : (game ?? games);
  return (
    <tr
      className="items-row"
      data-items-row={row.id}
      data-dimmed={sellingStatus(row) === SellingStatus.OffSale || undefined}
    >
      <td>
        <div className="items-row-item">
          <ItemRender item={{ id: row.id, iconUrl: row.iconUrl, modelUrl: null }} className="items-row-render" />
          <span className="items-row-words">
            <span className="items-row-name" dir="auto">
              {gameText(row.name)}
            </span>
            {where && <span className="items-row-game">{where}</span>}
          </span>
        </div>
      </td>
      <td className="items-row-status">
        <Status row={row} busy={busy} />
      </td>
      <td className="items-num">{sellingPrice(row)}</td>
      <td className="items-num">{draft ? NONE : coinNumber(row.sold)}</td>
      <td className="items-num">{draft ? NONE : coinNumber(row.earned)}</td>
      <td className="items-row-actions">
        <Actions row={row} busy={busy} onAsk={onAsk} />
      </td>
    </tr>
  );
}

/** Selling: the page's head, then the strip and the table, or why they are not there. */
export function SellingTab({
  head,
  panel,
  onAsk,
  askable,
  onRetry,
}: {
  head: ReactNode;
  /** The tab panel's id, which the tabs control. */
  panel: string;
  /** Ask the agent to change an item, in its game's chat. */
  onAsk: (row: SellingRow) => void;
  /** Whether the item's game is on this computer, so its chat can be asked. */
  askable: (row: SellingRow) => boolean;
  onRetry: () => void;
}): JSX.Element {
  const read = useItems((s) => s.selling.read);
  const rows = useItems((s) => s.selling.selling?.items ?? null);
  return (
    <div className="items-scroll">
      <div className="items-selling" data-items-selling>
        {head}
        <div id={panel} role="tabpanel" className="items-selling-body">
          {rows ? (
            <SellingTable rows={rows} onAsk={onAsk} askable={askable} />
          ) : (
            <ReadNote read={read} onRetry={onRetry} />
          )}
        </div>
      </div>
    </div>
  );
}

/** The strip and the table of the account's items. */
function SellingTable({
  rows,
  onAsk,
  askable,
}: {
  rows: SellingRow[];
  onAsk: (row: SellingRow) => void;
  askable: (row: SellingRow) => boolean;
}): JSX.Element {
  return (
    <>
      <Strip />
      {rows.length === 0 ? (
        <p className="items-note">{WORDS.noItems}</p>
      ) : (
        <table className="items-table">
          <thead>
            <tr>
              <th scope="col">{WORDS.item}</th>
              <th scope="col">
                <span className="sr-only">{WORDS.status}</span>
              </th>
              <th scope="col" className="items-num">
                {WORDS.price}
              </th>
              <th scope="col" className="items-num">
                {WORDS.sold}
              </th>
              <th scope="col" className="items-num">
                {WORDS.earned}
              </th>
              <th scope="col">
                <span className="sr-only">{WORDS.actionsColumn}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <Row key={row.id} row={row} onAsk={askable(row) ? onAsk : null} />
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
