/**
 * The Listing draft card (marketplace P11, plan 8.3; screen 09): a store item the game's agent made,
 * as its own `genex shop add --json` answered (`item_drafted`, a record only the host writes). It
 * shows the item's picture, name and description, its price, the "Other games can use it" toggle
 * and where its sale stands: a draft goes on sale when the game is published (Studio puts it on
 * sale then, `core/local-items.ts`), and an item an admin took off sale offers nothing (D14). The
 * toggle goes to genex.games through main (`itemSetShared`) as the person's own: the agent can
 * neither press it nor draw the card (D40). A local draft (made before the game is on Genex) has
 * no toggle, since no other game can reach it, and is the item's card on genex.games once the
 * publish uploaded it, with what became of it. Changes are the agent's: the chat's composer below,
 * or the Shop tab's pencil (`onAsk`), whose tiles show the picture on top (`ListingLook.Tile`).
 */
import type { JSX } from "react";
import { useId } from "react";
import {
  isLocalDraft,
  type ListingDraft,
  type ListingRecord,
  type LocalListingDraft,
} from "../../shared/item-draft.ts";
import { ItemState, type StoreRefusal } from "../../shared/store-items.ts";
import { CoinMark } from "../play/CoinMark.tsx";
import { ItemRender } from "../play/ItemRender.tsx";
import { coinNumber, coinText, gameText } from "../play/purchase-model.ts";
import { useItems } from "../state/hooks.ts";
import { useLocalPicture } from "./item-picture.ts";
import { studio } from "../state/studio.ts";
import { Icon } from "../ui/icons.tsx";
import { Switch } from "../ui/switch.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip.tsx";
import { ITEMS_WORDS, itemRefusalWords, PLAY_STORE_WORDS } from "../words.ts";
import {
  type ListingCardView,
  ListingSale,
  type LocalCardView,
  LocalSale,
  listingCardView,
  localCard,
  shareChange,
} from "./listing-draft.ts";

const WORDS = ITEMS_WORDS;

/** How a card is drawn: the chat's row, or the Shop tab's tile with its picture on top. */
export const ListingLook = { Row: "row", Tile: "tile" } as const;
export type ListingLook = (typeof ListingLook)[keyof typeof ListingLook];

/** Where an item's sale stands, as its card says it. */
const CardStatus = { Draft: "draft", OnSale: "on-sale", OffSale: "off-sale" } as const;
type CardStatus = (typeof CardStatus)[keyof typeof CardStatus];

/** A card's "Other games can use it" switch, on an item genex.games holds. */
interface ShareSwitch {
  itemId: string;
  checked: boolean;
  disabled: boolean;
  busy: boolean;
  onChange: (on: boolean) => void;
}

/** What a card shows, whichever look draws it. `share` is null for an item of a game not on Genex yet. */
interface CardFace {
  id: string;
  name: string;
  description: string | null;
  iconUrl: string | null;
  priceCoins: number;
  status: CardStatus;
  /** A local draft's status carries `data-listing-local-status`. */
  local: boolean;
  share: ShareSwitch | null;
}

/** The status in full, on the row. */
const STATUS_LINE: Record<CardStatus, string> = {
  [CardStatus.Draft]: WORDS.draftStatus,
  [CardStatus.OnSale]: WORDS.onSale,
  [CardStatus.OffSale]: WORDS.offSale,
};
/** The status in a word, on the tile's picture. */
const STATUS_WORD: Record<CardStatus, string> = {
  [CardStatus.Draft]: WORDS.draft,
  [CardStatus.OnSale]: WORDS.onSale,
  [CardStatus.OffSale]: WORDS.offSale,
};

/** Where an item on genex.games stands: on sale, a draft that goes on sale with the game's publish, or off sale. */
function statusOf(view: ListingCardView): CardStatus {
  if (view.sale === ListingSale.OnSale) return CardStatus.OnSale;
  return view.state === ItemState.Draft ? CardStatus.Draft : CardStatus.OffSale;
}

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

/** Where the item's sale stands: a line on the row, a word on the tile's picture. */
function SaleState({ face, look }: { face: CardFace; look: ListingLook }): JSX.Element {
  const tile = look === ListingLook.Tile;
  const quiet = face.status === CardStatus.Draft ? "listing-local-status" : "listing-sale-state";
  return (
    <p
      className={tile ? "listing-pill" : quiet}
      data-listing-on-sale={face.status === CardStatus.OnSale || undefined}
      data-listing-local-status={face.local || undefined}
    >
      {tile ? STATUS_WORD[face.status] : STATUS_LINE[face.status]}
    </p>
  );
}

/** "Other games can use it", the person's own switch. */
function Share({ share }: { share: ShareSwitch }): JSX.Element {
  const id = useId();
  return (
    <span className="listing-chip listing-share">
      <Switch
        id={id}
        data-listing-share={share.itemId}
        checked={share.checked}
        disabled={share.disabled}
        aria-busy={share.busy || undefined}
        onCheckedChange={share.onChange}
      />
      <label htmlFor={id}>{WORDS.shared}</label>
    </span>
  );
}

/** The tile's pencil: asks the game's agent for a change, named by its tooltip. */
function AskButton({ onAsk }: { onAsk: () => void }): JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" className="listing-ask" aria-label={WORDS.askForChanges} data-listing-ask onClick={onAsk}>
          <Icon name="rename" size={16} />
        </button>
      </TooltipTrigger>
      <TooltipContent>{WORDS.askForChanges}</TooltipContent>
    </Tooltip>
  );
}

/** The chat's card: picture beside the words, the price and sharing below, changes asked in the composer below. */
function RowFace({ face, askable }: { face: CardFace; askable: boolean }): JSX.Element {
  return (
    <>
      <div className="listing-head">
        <ItemRender item={{ id: face.id, iconUrl: face.iconUrl, modelUrl: null }} className="listing-render" />
        <div className="listing-words">
          <h3 className="listing-name" dir="auto">
            {face.name}
          </h3>
          <SaleState face={face} look={ListingLook.Row} />
          {face.description && (
            <p className="listing-description" dir="auto">
              {face.description}
            </p>
          )}
        </div>
      </div>
      <div className="listing-chips">
        <Price coins={face.priceCoins} />
        {face.share && <Share share={face.share} />}
      </div>
      {askable && <p className="listing-or">{WORDS.askBelow}</p>}
    </>
  );
}

/** The Shop's tile: the picture on top with its status and pencil, then the name and price, the description, sharing. */
function TileFace({ face, onAsk }: { face: CardFace; onAsk: (() => void) | null }): JSX.Element {
  return (
    <>
      <div className="listing-picture">
        <ItemRender item={{ id: face.id, iconUrl: face.iconUrl, modelUrl: null }} className="listing-render" />
        <SaleState face={face} look={ListingLook.Tile} />
        {onAsk && <AskButton onAsk={onAsk} />}
      </div>
      <div className="listing-title">
        <h3 className="listing-name" dir="auto" title={face.name}>
          {face.name}
        </h3>
        <Price coins={face.priceCoins} />
      </div>
      {face.description && (
        <p className="listing-description" dir="auto">
          {face.description}
        </p>
      )}
      {face.share && <Share share={face.share} />}
    </>
  );
}

/** The card's face in `look`; `askable` is false where nothing may change (a removed or unseen item). */
function Face({
  face,
  look,
  askable,
  onAsk,
}: {
  face: CardFace;
  look: ListingLook;
  askable: boolean;
  onAsk: (() => void) | undefined;
}): JSX.Element {
  if (look === ListingLook.Tile) return <TileFace face={face} onAsk={askable && onAsk ? onAsk : null} />;
  return <RowFace face={face} askable={askable} />;
}

/** The card's class: every card's, and the tile's own. */
const cardClass = (look: ListingLook): string =>
  look === ListingLook.Tile ? "listing-card listing-tile" : "listing-card";

/** The card for one draft: an item on genex.games, or a local draft; `onAsk` asks the game's agent to change it. */
export function ListingDraftCard({
  draft,
  look = ListingLook.Row,
  onAsk,
}: {
  draft: ListingRecord;
  look?: ListingLook;
  onAsk?: () => void;
}): JSX.Element {
  if (isLocalDraft(draft)) return <LocalListingCard draft={draft} look={look} onAsk={onAsk} />;
  return <ItemListingCard draft={draft} look={look} onAsk={onAsk} />;
}

/**
 * An item on genex.games. `note` says what became of a local draft its game's publish uploaded, and
 * `settled` why genex.games refused to put it on sale then; a later press's own refusal wins. A
 * `locked` card shows content Genex no longer holds: it offers neither sharing nor changes.
 */
function ItemListingCard({
  draft,
  look,
  note = null,
  settled = null,
  locked = false,
  onAsk,
}: {
  draft: ListingDraft;
  look: ListingLook;
  note?: string | null;
  settled?: StoreRefusal | null;
  locked?: boolean;
  onAsk?: (() => void) | undefined;
}): JSX.Element {
  // A press's answer is the newest; else Selling's row, which follows a sale Studio made after a publish.
  const pressed = useItems((s) => s.changed[draft.itemId]);
  const listed = useItems((s) => s.selling.selling?.items.find((row) => row.id === draft.itemId));
  const latest = pressed ?? (listed ? { state: listed.state, shareable: listed.shareable } : undefined);
  const busy = useItems((s) => s.busy[draft.itemId]);
  const refusal = useItems((s) => s.refused[draft.itemId]) ?? settled ?? undefined;
  const view = listingCardView(draft, latest, busy, refusal);
  const name = gameText(view.name);
  const face: CardFace = {
    id: view.itemId,
    name,
    description: view.description ? gameText(view.description) : null,
    iconUrl: view.iconUrl ?? listed?.iconUrl ?? null,
    priceCoins: view.priceCoins,
    status: statusOf(view),
    local: false,
    share: {
      itemId: view.itemId,
      checked: view.shared,
      disabled: !view.canShare || locked,
      busy: view.sharing,
      onChange: (on) => void studio().items.change(view.itemId, shareChange(on)),
    },
  };
  return (
    <section
      className={cardClass(look)}
      data-listing-draft={view.itemId}
      data-listing-sale={view.sale}
      aria-label={WORDS.listingLabel(name)}
    >
      <Face face={face} look={look} askable={!locked} onAsk={onAsk} />
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
function LocalListingCard({
  draft,
  look,
  onAsk,
}: {
  draft: LocalListingDraft;
  look: ListingLook;
  onAsk?: (() => void) | undefined;
}): JSX.Element {
  const view = useItems((s) => s.local[draft.project]);
  const busy = useItems((s) => s.localBusy[draft.localId]);
  const failed = useItems((s) => s.localFailed[draft.localId] === true);
  const card = localCard(draft, view, busy, failed);
  if ("uploaded" in card)
    return (
      <ItemListingCard
        draft={card.uploaded}
        look={look}
        note={uploadedNote(card)}
        settled={card.refusal}
        locked={card.unseen}
        onAsk={onAsk}
      />
    );
  return <LocalCard view={card.local} look={look} onAsk={onAsk} />;
}

/** What an uploaded local draft's card says of it: a version it never showed, or a change since approval. */
function uploadedNote(card: { changed: boolean; unseen: boolean }): string | null {
  if (card.unseen) return WORDS.unseenVersion;
  return card.changed ? WORDS.stayedDraft : null;
}

/** A local draft's card: it goes on sale when the game is published, and shares nothing until then. */
function LocalCard({
  view,
  look,
  onAsk,
}: {
  view: LocalCardView;
  look: ListingLook;
  onAsk?: (() => void) | undefined;
}): JSX.Element {
  const { draft } = view;
  const picture = useLocalPicture(draft.project, draft.picture, draft.contentHash);
  const name = gameText(draft.name);
  const removed = view.sale === LocalSale.Removed;
  const face: CardFace = {
    id: draft.localId,
    name,
    description: draft.description ? gameText(draft.description) : null,
    iconUrl: picture,
    priceCoins: draft.priceCoins,
    status: CardStatus.Draft,
    local: true,
    share: null,
  };
  return (
    <section
      className={cardClass(look)}
      data-listing-draft={draft.localId}
      data-listing-local={view.sale}
      aria-label={WORDS.listingLabel(name)}
    >
      <Face face={face} look={look} askable={!removed} onAsk={onAsk} />
      {removed && <p className="listing-sale-state">{WORDS.localRemoved}</p>}
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
