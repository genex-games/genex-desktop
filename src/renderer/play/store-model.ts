/**
 * A game's Store section on its Play page and the profile's item shelf (marketplace plan 10.3,
 * P5–P8), decided without a window: the line under each card's name (a price, Free or Owned in
 * Store; Works here, N left or a dimmed Not in this game in My items), a shared item's "N games"
 * badge, whether the section shows at all, what pressing a card offers, how the item's sheet goes
 * on once `storeBuy` or `storeClaim` answers, the soft gradient behind an item's render, and the
 * shelf's few items. `GameStore.tsx`, `ItemSheet.tsx` and `ItemShelf.tsx` draw what these decide.
 */
import {
  isStoreRefused,
  ITEM_SHELF_MAX,
  ItemPlace,
  ItemType,
  type MyItem,
  type PlayerItem,
  type ShelfItem,
  StoreBuyOutcome,
  type StoreBuyResult,
  type StoreClaimed,
  type StoreItem,
  StoreRefusal,
  type StoreRefused,
  type StoreTab,
} from "../../shared/store-items.ts";

/** Which half of a game's Store section shows. Values are `data-game-store-view` selectors: never rename one. */
export const StoreView = { Store: "store", MyItems: "my-items" } as const;
export type StoreView = (typeof StoreView)[keyof typeof StoreView];

/** What a card's line under its name says. Values are `data-store-line` selectors: never rename one. */
export const CardLine = {
  /** The price in coin, with the coin mark. */
  Price: "price",
  Free: "free",
  /** A durable the player owns (or a Free item claimed): nothing more to buy. */
  Owned: "owned",
  WorksHere: "works-here",
  /** How many of a consumable are left: "2 left". */
  Left: "left",
  /** Owned, but this game does not support it: the card is dimmed. */
  NotHere: "not-here",
} as const;
export type CardLine = (typeof CardLine)[keyof typeof CardLine];

/** A card's line and the number it carries, if any. */
export type CardLineView =
  | { line: typeof CardLine.Price; coins: number }
  | { line: typeof CardLine.Left; count: number }
  | { line: typeof CardLine.Free | typeof CardLine.Owned | typeof CardLine.WorksHere | typeof CardLine.NotHere };

/** Whether an item has nothing more to sell its owner: a durable, or a Free item claimed once (Q6). */
const ownedOnce = (item: Pick<PlayerItem, "type" | "priceCoins">): boolean =>
  item.type === ItemType.Durable || item.priceCoins === 0;

/** A Store card's line: Owned for what the player has for good, else Free or the price (P6). */
export function storeLine(item: Pick<StoreItem, "owned" | "type" | "priceCoins">): CardLineView {
  if (item.owned === true && ownedOnce(item)) return { line: CardLine.Owned };
  if (item.priceCoins === 0) return { line: CardLine.Free };
  return { line: CardLine.Price, coins: item.priceCoins };
}

/** A My items card's line: Not in this game first, then how many of a consumable are left, else Works here (P5). */
export function myItemLine(item: Pick<MyItem, "place" | "type" | "remaining">): CardLineView {
  if (item.place === ItemPlace.NotInThisGame) return { line: CardLine.NotHere };
  if (item.type === ItemType.Consumable && item.remaining !== null)
    return { line: CardLine.Left, count: item.remaining };
  return { line: CardLine.WorksHere };
}

/** The "N games" badge of a shared item in more than one game; null draws none (P6). */
export const gamesBadge = (item: Pick<PlayerItem, "shared" | "gamesCount">): number | null =>
  item.shared && item.gamesCount > 1 ? item.gamesCount : null;

/** Whether a game's page shows its Store section: only once it sells something (the store off reads as nothing, D28). */
export const storeShown = (tab: StoreTab | null): tab is StoreTab => tab !== null && tab.items.length > 0;

/** Where My items stands. Values are `data-my-items` selectors: never rename one. */
export const MyItemsStatus = {
  Loading: "loading",
  Ready: "ready",
  /** No Genex account: My items asks to sign in. */
  SignedOut: "signed-out",
  Failed: "failed",
} as const;
export type MyItemsStatus = (typeof MyItemsStatus)[keyof typeof MyItemsStatus];

/** My items as read: the items when ready, none otherwise. */
export interface MyItemsRead {
  status: MyItemsStatus;
  items: MyItem[];
}

/** My items before they are read. */
export const MY_ITEMS_LOADING: MyItemsRead = { status: MyItemsStatus.Loading, items: [] };

/** Refusals of My items that mean there is nothing to list on this page: the store is off, or the game is gone. */
const NOTHING_HERE: ReadonlySet<StoreRefusal> = new Set([StoreRefusal.NotFound, StoreRefusal.GameNotFound]);

/** My items as `storeMyItems` answered: the items, Sign in, nothing, or a failure. */
export function myItemsRead(answer: MyItem[] | StoreRefused): MyItemsRead {
  if (!isStoreRefused(answer)) return { status: MyItemsStatus.Ready, items: answer };
  if (answer.refused === StoreRefusal.Unauthorized) return { status: MyItemsStatus.SignedOut, items: [] };
  if (NOTHING_HERE.has(answer.refused)) return { status: MyItemsStatus.Ready, items: [] };
  return { status: MyItemsStatus.Failed, items: [] };
}

/** What pressing a card offers. Values are `data-item-offer` selectors: never rename one. */
export const ItemOffer = {
  /** Start the purchase: main's sheet shows it. */
  Buy: "buy",
  /** A Free item: Get claims it. */
  Get: "get",
  /** The player has it for good: the sheet only shows it. */
  Owned: "owned",
  /** Owned, but this game does not support it. */
  NotHere: "not-here",
} as const;
export type ItemOffer = (typeof ItemOffer)[keyof typeof ItemOffer];

/** What a Store card offers; while signed out (ownership unknown) the press finds out. */
export function storeOffer(item: Pick<StoreItem, "owned" | "type" | "priceCoins">): ItemOffer {
  if (item.owned === true && ownedOnce(item)) return ItemOffer.Owned;
  return item.priceCoins === 0 ? ItemOffer.Get : ItemOffer.Buy;
}

/** What a My items card offers: more of a priced consumable that works here, else the item as owned. */
export function myItemOffer(item: Pick<MyItem, "place" | "type" | "priceCoins">): ItemOffer {
  if (item.place === ItemPlace.NotInThisGame) return ItemOffer.NotHere;
  return ownedOnce(item) ? ItemOffer.Owned : ItemOffer.Buy;
}

/** Where the item's sheet stands before (or instead of) main's purchase sheet. Values are `data-item-sheet` selectors. */
export const SheetPhase = {
  /** Pay was pressed: main is starting the purchase, and its sheet takes over once it arrives. */
  Opening: "opening",
  /** A Free item: Get. */
  Get: "get",
  Claiming: "claiming",
  /** It's yours: a Free item claimed. */
  Done: "done",
  Owned: "owned",
  NotHere: "not-here",
  /** Signed out: Sign in. */
  SignIn: "sign-in",
  /** It is no longer sold here (off sale, taken out of this game, gone). */
  Gone: "gone",
  /** genex.games refused it or could not be reached: nothing was charged. */
  Failed: "failed",
} as const;
export type SheetPhase = (typeof SheetPhase)[keyof typeof SheetPhase];

const OPENS: Record<ItemOffer, SheetPhase> = {
  [ItemOffer.Buy]: SheetPhase.Opening,
  [ItemOffer.Get]: SheetPhase.Get,
  [ItemOffer.Owned]: SheetPhase.Owned,
  [ItemOffer.NotHere]: SheetPhase.NotHere,
};

/** The sheet a card's press opens. */
export const sheetOpens = (offer: ItemOffer): SheetPhase => OPENS[offer];

/** How the sheet goes on: its next phase (null closes it), and whether the store is read again. */
export interface SheetNext {
  phase: SheetPhase | null;
  reread: boolean;
}

/** Refusals that mean the item is not to be had on this page any more. */
const GONE: ReadonlySet<StoreRefusal> = new Set([
  StoreRefusal.ItemOffSale,
  StoreRefusal.NotSoldHere,
  StoreRefusal.SkuNotFound,
  StoreRefusal.GameNotFound,
  StoreRefusal.NotFound,
]);

/** What a refusal of a purchase or a claim shows. */
function refused({ refused: why }: StoreRefused): SheetNext {
  if (why === StoreRefusal.AlreadyOwned) return { phase: SheetPhase.Owned, reread: true };
  if (why === StoreRefusal.Unauthorized) return { phase: SheetPhase.SignIn, reread: false };
  if (GONE.has(why)) return { phase: SheetPhase.Gone, reread: true };
  return { phase: SheetPhase.Failed, reread: false };
}

/**
 * How the sheet goes on once `storeBuy` answers: main's sheet has closed by then (it said Paid,
 * Pending or nothing charged), it never opened, or genex.games refused before any sheet.
 */
export function afterBuy(result: StoreBuyResult): SheetNext {
  if (isStoreRefused(result)) return refused(result);
  switch (result.outcome) {
    case StoreBuyOutcome.Paid:
    case StoreBuyOutcome.Pending:
      return { phase: null, reread: true };
    case StoreBuyOutcome.NotShown:
      return { phase: SheetPhase.Failed, reread: false };
    default:
      return { phase: null, reread: false };
  }
}

/** How the sheet goes on once `storeClaim` answers: It's yours, a replay too. */
export const afterClaim = (result: StoreClaimed | StoreRefused): SheetNext =>
  isStoreRefused(result) ? refused(result) : { phase: SheetPhase.Done, reread: true };

/** FNV-1a's offset basis and prime: a small, stable spread of an id over the hue wheel. */
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const HUES = 360;

/** The hue of the soft gradient behind an item's render: the same item, the same hue, everywhere. */
export function itemHue(id: string): number {
  let hash = FNV_OFFSET;
  for (const char of id) hash = Math.imul(hash ^ (char.codePointAt(0) ?? 0), FNV_PRIME) >>> 0;
  return hash % HUES;
}

/** The profile shelf's items: genex.games' first five, newest first (P8, Q3); none draws nothing. */
export const shelfShown = (items: readonly ShelfItem[]): ShelfItem[] => items.slice(0, ITEM_SHELF_MAX);

/** The game a shelf item's Get in \<game> opens: only while that game still sells it; else none. */
export const shelfGetIn = (item: Pick<ShelfItem, "game" | "onSale">): ShelfItem["game"] =>
  item.onSale ? item.game : null;
