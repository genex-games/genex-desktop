/**
 * The Listing draft card (marketplace P11, plan 8.3; screen 09): a store item the game's agent made,
 * as its own `genex shop add --json` answered (`item_drafted`, a record only the host writes). It
 * shows the item's picture, name and description, its price, the "Other games can use it" toggle
 * and Put on sale, "or ask for changes below". Its presses go to genex.games through main
 * (`itemSetShared`, `itemPutOnSale`) as the person's own: the agent can neither press them nor draw
 * the card (D40). Once on sale it says so; an item an admin took off sale offers nothing (D14).
 * A local draft (made before the game is on Genex) says it goes on sale when the game is published
 * and offers "Sell when published", the person's approval kept by main; once the publish uploaded
 * it, the card is the item's on genex.games, with what became of it.
 */
import type { JSX } from "react";
import { useId } from "react";
import {
  isLocalDraft,
  type ListingDraft,
  type ListingRecord,
  type LocalListingDraft,
} from "../../shared/item-draft.ts";
import type { StoreRefusal } from "../../shared/store-items.ts";
import { CoinMark } from "../play/CoinMark.tsx";
import { ItemRender } from "../play/ItemRender.tsx";
import { coinNumber, coinText, gameText } from "../play/purchase-model.ts";
import { useItems } from "../state/hooks.ts";
import { ItemAction, LocalAction } from "../state/items.ts";
import { studio } from "../state/studio.ts";
import { Button } from "../ui/Button.tsx";
import { Switch } from "../ui/switch.tsx";
import { ITEMS_WORDS, itemRefusalWords, PLAY_STORE_WORDS } from "../words.ts";
import {
  type ListingCardView,
  ListingSale,
  type LocalCardView,
  LocalSale,
  listingCardView,
  localCard,
  localShareChange,
  sellWhenPublished,
  shareChange,
} from "./listing-draft.ts";

const WORDS = ITEMS_WORDS;

/** The price chip: the coin and the amount, or Free. */
function Price({ coins }: { coins: number }): JSX.Element {
  if (coins === 0) return <span className="listing-chip">{PLAY_STORE_WORDS.free}</span>;
  return (
    <span className="listing-chip listing-price">
      <CoinMark size={14} />
      <span aria-hidden="true">{coinNumber(coins)}</span>
      <span className="sr-only">{coinText(coins)}</span>
    </span>
  );
}

/** Put on sale and what follows it, or where the sale stands once it is past. */
function Sale({ view }: { view: ListingCardView }): JSX.Element {
  if (view.sale === ListingSale.OnSale)
    return (
      <p className="listing-sale-state" data-listing-on-sale>
        {WORDS.onSale}
      </p>
    );
  if (view.sale === ListingSale.TakenDown) return <p className="listing-sale-state">{WORDS.offSale}</p>;
  return (
    <div className="listing-actions">
      <Button
        variant="default"
        data-listing-put-on-sale={view.itemId}
        busy={view.sale === ListingSale.Pressing}
        disabled={!view.canPutOnSale && view.sale !== ListingSale.Pressing}
        onClick={() => void studio().items.change(view.itemId, ItemAction.PutOnSale)}
      >
        {WORDS.putOnSale}
      </Button>
      <span className="listing-or">{WORDS.orAsk}</span>
    </div>
  );
}

/** The card for one draft: an item on genex.games, or a local draft. */
export function ListingDraftCard({ draft }: { draft: ListingRecord }): JSX.Element {
  if (isLocalDraft(draft)) return <LocalListingCard draft={draft} />;
  return <ItemListingCard draft={draft} />;
}

/**
 * An item on genex.games. `note` says what became of a local draft its game's publish uploaded, and
 * `settled` why genex.games refused to put it on sale then; a later press's own refusal wins. A
 * `locked` card shows content Genex no longer holds: it offers neither Put on sale nor sharing.
 */
function ItemListingCard({
  draft,
  note = null,
  settled = null,
  locked = false,
}: {
  draft: ListingDraft;
  note?: string | null;
  settled?: StoreRefusal | null;
  locked?: boolean;
}): JSX.Element {
  const latest = useItems((s) => s.changed[draft.itemId]);
  const busy = useItems((s) => s.busy[draft.itemId]);
  const refusal = useItems((s) => s.refused[draft.itemId]) ?? settled ?? undefined;
  const view = listingCardView(draft, latest, busy, refusal);
  const shareId = useId();
  const name = gameText(view.name);
  return (
    <section
      className="listing-card"
      data-listing-draft={view.itemId}
      data-listing-sale={view.sale}
      aria-label={WORDS.listingLabel(name)}
    >
      <div className="listing-head">
        <ItemRender item={{ id: view.itemId, iconUrl: view.iconUrl, modelUrl: null }} className="listing-render" />
        <div className="listing-words">
          <h3 className="listing-name" dir="auto">
            {name}
          </h3>
          {view.description && (
            <p className="listing-description" dir="auto">
              {gameText(view.description)}
            </p>
          )}
        </div>
      </div>
      <div className="listing-chips">
        <Price coins={view.priceCoins} />
        <span className="listing-chip listing-share">
          <Switch
            id={shareId}
            data-listing-share={view.itemId}
            checked={view.shared}
            disabled={!view.canShare || locked}
            aria-busy={view.sharing || undefined}
            onCheckedChange={(on) => void studio().items.change(view.itemId, shareChange(on))}
          />
          <label htmlFor={shareId}>{WORDS.shared}</label>
        </span>
      </div>
      {!locked && <Sale view={view} />}
      {note && (
        <p className="listing-note" data-listing-stayed-draft>
          {note}
        </p>
      )}
      {view.refusal && (
        <p role="alert" className="listing-refusal">
          {itemRefusalWords(view.refusal)}
        </p>
      )}
    </section>
  );
}

/** A local draft: the item's own card once its game's publish uploaded it, else its local card. */
function LocalListingCard({ draft }: { draft: LocalListingDraft }): JSX.Element {
  const view = useItems((s) => s.local[draft.project]);
  const busy = useItems((s) => s.localBusy[draft.localId]);
  const failed = useItems((s) => s.localFailed[draft.localId] === true);
  const card = localCard(draft, view, busy, failed);
  if ("uploaded" in card)
    return (
      <ItemListingCard draft={card.uploaded} note={uploadedNote(card)} settled={card.refusal} locked={card.unseen} />
    );
  return <LocalCard view={card.local} />;
}

/** What an uploaded local draft's card says of it: a version it never showed, or a change since approval. */
function uploadedNote(card: { changed: boolean; unseen: boolean }): string | null {
  if (card.unseen) return WORDS.unseenVersion;
  return card.changed ? WORDS.stayedDraft : null;
}

/** "Sell when published" as it stands: offered, or pressed with its undo; nothing once removed. */
function LocalSaleArea({ view }: { view: LocalCardView }): JSX.Element {
  const { localId } = view.draft;
  if (view.sale === LocalSale.Removed) return <p className="listing-sale-state">{WORDS.localRemoved}</p>;
  const press = () => void studio().items.pressLocal(view.draft, sellWhenPublished(view.sale));
  const approving = view.busy === LocalAction.Approve || view.busy === LocalAction.Withdraw;
  if (view.sale === LocalSale.Approved)
    return (
      <div className="listing-actions">
        <Button
          variant="accent-outline"
          aria-pressed="true"
          data-listing-sell-when-published={localId}
          busy={approving}
          disabled={!view.canPress && !approving}
          onClick={press}
        >
          {WORDS.willSell}
        </Button>
        <Button variant="ghost" data-listing-undo-sell={localId} disabled={!view.canPress} onClick={press}>
          {WORDS.undoSell}
        </Button>
      </div>
    );
  return (
    <div className="listing-actions">
      <Button
        variant="default"
        aria-pressed="false"
        data-listing-sell-when-published={localId}
        busy={approving}
        disabled={!view.canPress && !approving}
        onClick={press}
      >
        {WORDS.sellWhenPublished}
      </Button>
      <span className="listing-or">{WORDS.orAsk}</span>
    </div>
  );
}

/** A local draft's card: it goes on sale when the game is published, if the person says so. */
function LocalCard({ view }: { view: LocalCardView }): JSX.Element {
  const shareId = useId();
  const { draft } = view;
  const name = gameText(draft.name);
  const sharing = view.busy === LocalAction.Share || view.busy === LocalAction.Unshare;
  return (
    <section
      className="listing-card"
      data-listing-draft={draft.localId}
      data-listing-local={view.sale}
      aria-label={WORDS.listingLabel(name)}
    >
      <div className="listing-head">
        <ItemRender item={{ id: draft.localId, iconUrl: null, modelUrl: null }} className="listing-render" />
        <div className="listing-words">
          <h3 className="listing-name" dir="auto">
            {name}
          </h3>
          <p className="listing-local-status" data-listing-local-status>
            {WORDS.localStatus}
          </p>
          {draft.description && (
            <p className="listing-description" dir="auto">
              {gameText(draft.description)}
            </p>
          )}
        </div>
      </div>
      <div className="listing-chips">
        <Price coins={draft.priceCoins} />
        <span className="listing-chip listing-share">
          <Switch
            id={shareId}
            data-listing-share={draft.localId}
            checked={view.shared}
            disabled={!view.canShare}
            aria-busy={sharing || undefined}
            onCheckedChange={(on) => void studio().items.pressLocal(draft, localShareChange(on))}
          />
          <label htmlFor={shareId}>{WORDS.shared}</label>
        </span>
      </div>
      <LocalSaleArea view={view} />
      {view.sale === LocalSale.Changed && (
        <p className="listing-note" data-listing-local-changed>
          {WORDS.changedSinceApproved}
        </p>
      )}
      {view.refusal && (
        <p role="alert" className="listing-refusal">
          {itemRefusalWords(view.refusal)}
        </p>
      )}
      {view.failed && (
        <p role="alert" className="listing-refusal">
          {WORDS.localFailed}
        </p>
      )}
    </section>
  );
}
