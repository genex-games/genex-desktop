/**
 * The game-item store (marketplace plan 10.1, 10.2) as Studio's renderer and main share it: a
 * game's Store and My items tabs, "Works in N games", the profile shelf, an item complaint, and
 * Create › Items (Browse, Selling and the listing draft's actions). Main reads genex.games'
 * `/api/store` and creator `/api/coin` routes as the app's Genex account (`main/play/store.ts`),
 * reads every answer as hostile input, and hands the renderer these shapes only. An item is a SKU
 * (contract D1): every item id is the id a game passes to `buy({ skuId })`. Every coin price comes
 * with its real-money value from genex.games; nothing here computes either. Dates are milliseconds
 * since the epoch. Browser-safe.
 *
 * The wire vocabularies mirror genex-demo's `packages/contracts/src/store-vocabulary.ts` by hand
 * (this app cannot import it): values are genex.games' own spelling, never renamed.
 */
import type { PlayPurchaseSheet } from "./play-purchase.ts";

/** Where an item stands for sale (plan 4.1). Wire values: never rename one. */
export const ItemState = {
  /** Made by the agent, not on sale yet: only its author sees it (Selling, the staging preview's "New"). */
  Draft: "draft",
  OnSale: "on_sale",
  /** Its author took it off sale: owners keep it (P21), and it leaves every Store. */
  OffSale: "off_sale",
  /** An admin took it off sale after a complaint (11.4); shown as Off sale, with no Put on sale (D14). */
  TakenDown: "taken_down",
} as const;
export type ItemState = (typeof ItemState)[keyof typeof ItemState];

/** The only behavior flag an item has (P3): a consumable is bought again, a durable owned once. Wire values. */
export const ItemType = { Consumable: "consumable", Durable: "durable" } as const;
export type ItemType = (typeof ItemType)[keyof typeof ItemType];

/** Where an owned item works, as My items marks it in one game (P5, contract D2). Wire values. */
export const ItemPlace = {
  WorksHere: "works_here",
  /** Owned, but this game does not support it: drawn dimmed, "Not in this game". */
  NotInThisGame: "not_in_this_game",
} as const;
export type ItemPlace = (typeof ItemPlace)[keyof typeof ItemPlace];

/** Why a player reports an item (P22): Copy, Doesn't work, Inappropriate, Scam. Wire values. */
export const ItemReportReason = {
  Copy: "copy",
  Broken: "broken",
  Inappropriate: "inappropriate",
  Scam: "scam",
} as const;
export type ItemReportReason = (typeof ItemReportReason)[keyof typeof ItemReportReason];

/** A host game's permission to sell and support a shared item (plan 4.2); not a purchase. Wire values. */
export const AllowanceState = {
  Active: "active",
  /** The host took it out of their game; adding it again turns the same row back on (D19). */
  Removed: "removed",
  /** Reserved for v2: an admin revoked it. */
  Revoked: "revoked",
} as const;
export type AllowanceState = (typeof AllowanceState)[keyof typeof AllowanceState];

/**
 * Why genex.games refused a store call, by its code: the renderer says each in its own words and
 * branches on nothing else. Values are genex.games' `error` codes, except the app's own
 * `too_many_requests` (a 429 that names no code: the report limiter) and `unknown` (a code this
 * build does not know, or none). A signed-out account reads as `unauthorized`.
 */
export const StoreRefusal = {
  /** The store is off (`STORE_MODE`, P23): the whole surface answers 404 `not_found` and hides. */
  NotFound: "not_found",
  Unauthorized: "unauthorized",
  /** genex.games refused a session call that crossed games from somewhere other than Genex itself. */
  ForbiddenOrigin: "forbidden_origin",
  SkuNotFound: "sku_not_found",
  GameNotFound: "game_not_found",
  ProjectNotFound: "project_not_found",
  UserNotFound: "user_not_found",
  AllowanceNotFound: "allowance_not_found",
  InsufficientBalance: "insufficient_balance",
  /** The price is over what the surface Studio confirms on may approve. */
  SurfaceCap: "surface_cap",
  /** A durable (or a once-only free consumable) the player owns already; nothing was charged. */
  AlreadyOwned: "already_owned",
  /** The item is neither this game's own nor added to it with a live allowance. */
  NotSoldHere: "not_sold_here",
  ItemOffSale: "item_off_sale",
  /** A purchase of a Free item: it is claimed instead. */
  FreeItem: "free_item",
  /** A claim of a paid item: it is bought instead. */
  NotFree: "not_free",
  NoPayee: "no_payee",
  /** Its author does not let other games use it (P20). */
  NotShareable: "not_shareable",
  /** Only a durable may be shared (P3). */
  NotDurable: "not_durable",
  /** An admin took it off sale: its author can change nothing (11.4). */
  TakenDown: "taken_down",
  /** An item is never added to its own home game. */
  HomeGame: "home_game",
  TypeLocked: "type_locked",
  PictureMissing: "picture_missing",
  PictureInvalid: "picture_invalid",
  ModelInvalid: "model_invalid",
  NameRefused: "name_refused",
  DescriptionRefused: "description_refused",
  PriceOffGrid: "price_off_grid",
  PackageInvalid: "package_invalid",
  PackageTooLarge: "package_too_large",
  TooManySkus: "too_many_skus",
  PublishRateLimited: "publish_rate_limited",
  /** The app's own: a 429 that names no code (the report limiter's "Too many requests"). */
  TooManyRequests: "too_many_requests",
  /** The app's own: a code this build does not know, or none at all. */
  Unknown: "unknown",
} as const;
export type StoreRefusal = (typeof StoreRefusal)[keyof typeof StoreRefusal];

/** How a store purchase's sheet ended (`storeBuy`). The app's own words: never sent anywhere. */
export const StoreBuyOutcome = {
  /** It closed after Paid: the item is the player's. */
  Paid: "paid",
  /** It closed while genex.games had not said how the payment went: read the tab again later. */
  Pending: "pending",
  /** It closed with nothing charged: canceled, timed out, refused or short of coin. */
  NotPaid: "not-paid",
  /** The purchase could not be read to show, so no sheet opened (genex.games was unreachable). */
  NotShown: "not-shown",
} as const;
export type StoreBuyOutcome = (typeof StoreBuyOutcome)[keyof typeof StoreBuyOutcome];

/** The longest name genex.games gives an item. */
export const ITEM_NAME_MAX = 80;
/** The longest description genex.games keeps for an item. */
export const ITEM_DESCRIPTION_MAX = 1000;
/** The most tags an item has, and the longest one. */
export const ITEM_TAGS_MAX = 10;
export const ITEM_TAG_LENGTH_MAX = 32;
/** A whole sale in basis points: a selling game's share is always less (the author's leg comes first). */
export const SALE_BPS = 10_000;
/** The longest message a complaint may carry. */
export const ITEM_REPORT_MESSAGE_MAX = 500;
/** "Works in N games" shows at most this many covers beside the total. */
export const ITEM_GAMES_PREVIEW_MAX = 8;
/** The profile shelf shows at most this many items (P8, Q3). */
export const ITEM_SHELF_MAX = 5;
/** One page of Browse, as Studio asks for it. */
export const BROWSE_PAGE_SIZE = 24;
/** The most items one Browse page may hold. */
export const BROWSE_PAGE_MAX = 48;
/** The longest Browse search Studio sends. */
export const BROWSE_QUERY_MAX = 120;

/** An id as genex.games hands them out (a cuid): letters, digits, dashes and underscores, never a path. */
const ID = /^[A-Za-z0-9_-]{1,64}$/;

const STATES: ReadonlySet<string> = new Set(Object.values(ItemState));
const TYPES: ReadonlySet<string> = new Set(Object.values(ItemType));
const PLACES: ReadonlySet<string> = new Set(Object.values(ItemPlace));
const REASONS: ReadonlySet<string> = new Set(Object.values(ItemReportReason));
const ALLOWANCE_STATES: ReadonlySet<string> = new Set(Object.values(AllowanceState));
const REFUSALS: ReadonlySet<string> = new Set(Object.values(StoreRefusal));

/** Whether a value is an item (SKU) id genex.games could have handed out: all a route may carry. */
export const isItemId = (value: unknown): value is string => typeof value === "string" && ID.test(value);
/** Whether a value is a state an item can be in. */
export const isItemState = (value: unknown): value is ItemState => typeof value === "string" && STATES.has(value);
/** Whether a value is consumable or durable. */
export const isItemType = (value: unknown): value is ItemType => typeof value === "string" && TYPES.has(value);
/** Whether a value says where an owned item works. */
export const isItemPlace = (value: unknown): value is ItemPlace => typeof value === "string" && PLACES.has(value);
/** Whether a value is a reason a player may report an item for. */
export const isItemReportReason = (value: unknown): value is ItemReportReason =>
  typeof value === "string" && REASONS.has(value);
/** Whether a value is a state an allowance can be in. */
export const isAllowanceState = (value: unknown): value is AllowanceState =>
  typeof value === "string" && ALLOWANCE_STATES.has(value);
const isStoreRefusal = (value: unknown): value is StoreRefusal => typeof value === "string" && REFUSALS.has(value);
/** A refusal code, known or not: an unknown one reads as {@link StoreRefusal.Unknown}. */
export const storeRefusalOf = (code: unknown): StoreRefusal => (isStoreRefusal(code) ? code : StoreRefusal.Unknown);

/**
 * Tags as genex.games stores them: trimmed, inner whitespace collapsed, lowercased, empty ones
 * dropped, the first of each kept. Tags are search words, never a type (P2).
 */
export function normalizeItemTags(raw: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const tag of raw) {
    const normalized = tag.trim().replace(/\s+/g, " ").toLowerCase();
    if (normalized !== "") seen.add(normalized);
  }
  return [...seen];
}

/** A store call genex.games refused: `refused` says why. */
export interface StoreRefused {
  refused: StoreRefusal;
}

/** Whether a store call's answer is a refusal rather than what it asked for. */
export const isStoreRefused = (value: unknown): value is StoreRefused =>
  typeof value === "object" && value !== null && "refused" in value;

/** A game as the store names one: enough to open its page and print its title. */
export interface ItemGameRef {
  slug: string;
  title: string;
}

/** A game the account owns, as Selling names one: its id is what a chat or an allowance takes. */
export interface OwnedGameRef extends ItemGameRef {
  id: string;
}

/** A game in "Works in N games": its cover for the stack of thumbnails. */
export interface ItemGame extends ItemGameRef {
  coverUrl: string | null;
}

/** An item's author: `handle` is null on an old account that has none yet. */
export interface ItemPerson {
  id: string;
  name: string;
  handle: string | null;
}

/** What every item a player sees carries. */
export interface PlayerItem {
  id: string;
  name: string;
  description: string | null;
  /** The 3D render on a transparent background, on a host the app loads images from; else null. */
  iconUrl: string | null;
  /** The GLB behind "Drag to turn", on a host the app loads from; null when there is none. */
  modelUrl: string | null;
  type: ItemType;
  /** 0 is Free. */
  priceCoins: number;
  priceDisplayUsdCents: number;
  /** Other games may use it, or it reached this game from another (D3). */
  shared: boolean;
  /** "Works in N games": the card's "N games" badge shows when `shared` and above 1. */
  gamesCount: number;
  /** Its home game; null once that game is gone (its owners keep it, P21). */
  homeGame: ItemGameRef | null;
}

/** A Store card (P6). */
export interface StoreItem extends PlayerItem {
  /** The player owns it ("Owned" on a durable); null while signed out. */
  owned: boolean | null;
  /** How many of a consumable are left ("2 left"); null for a durable, or while signed out. */
  remaining: number | null;
}

/** A game's Store tab: its own items on sale, then the shared items it added. */
export interface StoreTab {
  /** Empty when the game sells nothing or the store is off: the section hides (D28). */
  items: StoreItem[];
  /** "My items N": everything the player owns anywhere; null while signed out. */
  myItemsCount: number | null;
}

/** A My items row: one per item the player owns anywhere, marked for this game. */
export interface MyItem extends PlayerItem {
  place: ItemPlace;
  remaining: number | null;
  acquiredAt: number;
}

/** "Works in N games": the total, and the first published games with their covers. */
export interface ItemGames {
  total: number;
  games: ItemGame[];
}

/** An item on a profile's shelf (P8): **Get in \<game>** opens `game`, with its cover; null draws no button. */
export interface ShelfItem {
  id: string;
  name: string;
  iconUrl: string | null;
  modelUrl: string | null;
  game: ItemGame | null;
  /**
   * `game` still sells it (on sale there). Owned items stay on the shelf when it does not (P21), with
   * no Get in \<game>; an API that does not say reads as true.
   */
  onSale: boolean;
}

/** A Free item claimed: a replay answers the same claim. */
export interface StoreClaimed {
  itemId: string;
  replayed: boolean;
}

/** A store purchase's sheet, as main draws it in the studio window: Play's sheet, for one item of one game. */
export interface StoreSheet extends PlayPurchaseSheet {
  itemId: string;
  slug: string;
}

/** How `storeBuy` went: the sheet's end, or why genex.games would not start the purchase. */
export type StoreBuyResult = { outcome: StoreBuyOutcome } | StoreRefused;

/** A shared item in Browse (other creators' only). */
export interface BrowseItem {
  id: string;
  name: string;
  description: string | null;
  iconUrl: string | null;
  modelUrl: string | null;
  type: ItemType;
  priceCoins: number;
  priceDisplayUsdCents: number;
  tags: string[];
  author: ItemPerson;
  homeGame: ItemGameRef | null;
  gamesCount: number;
  /** "You get per sale": genex.games' share for a game that sells it, in coin. */
  youGetPerSale: number;
}

/** One page of Browse. */
export interface BrowsePage {
  items: BrowseItem[];
  /** The next page's cursor; null on the last. */
  nextCursor: string | null;
  /**
   * What a game that sells another creator's item gets of each sale, in basis points, as genex.games
   * configures it (`crossGameSellerBps`); absent from an API that does not send it.
   */
  sellerShareBps?: number;
}

/** One of the account's games a shared item was added to. */
export interface ItemAddedTo {
  projectId: string;
  slug: string;
  title: string;
  /** The game has promoted a live build since adding it (Q5): it is sold there now. */
  live: boolean;
}

/** Browse's detail panel. */
export interface BrowseDetail {
  item: BrowseItem;
  /** What the item's package holds, when it has one: its files and their bytes together. */
  package: { files: number; bytes: number } | null;
  addedTo: ItemAddedTo[];
  /** As Browse's page carries it; absent from an API that does not send it. */
  sellerShareBps?: number;
}

/** A shared item's place in one of the account's games. */
export interface ItemAllowance {
  itemId: string;
  projectId: string;
  state: AllowanceState;
  addedAt: number;
  /** Sold and supported there since this time (Q5); null until the game promotes a newer live build. */
  liveAt: number | null;
}

/** Add to \<game>: the allowance, and whether it was there already. */
export interface ItemAdded {
  allowance: ItemAllowance;
  replayed: boolean;
}

/** A row of Selling: one item the account made. */
export interface SellingRow {
  id: string;
  name: string;
  iconUrl: string | null;
  type: ItemType;
  game: OwnedGameRef | null;
  gamesCount: number;
  state: ItemState;
  /** A complaint about it is open: "Report under review". */
  underReview: boolean;
  shareable: boolean;
  priceCoins: number;
  priceDisplayUsdCents: number;
  sold: number;
  earned: number;
}

/** Selling: the ready / on-hold strip, and the account's items, newest first. */
export interface Selling {
  /** "Ready to use": earned coin past the hold. */
  earnedReady: number;
  /** "On hold for N days": earned coin still inside the hold. */
  earnedHeld: number;
  /** When the oldest held coin is ready; null with none held. */
  nextReleaseAt: number | null;
  /** The hold's length in days; 0 when it is off. */
  holdDays: number;
  items: SellingRow[];
}

/** An item as its author changed it (Put on sale, Take off sale, Other games can use it). */
export interface CreatorItem {
  id: string;
  projectId: string | null;
  type: ItemType;
  name: string;
  description: string | null;
  tags: string[];
  iconUrl: string | null;
  modelUrl: string | null;
  priceCoins: number;
  priceDisplayUsdCents: number;
  state: ItemState;
  /** "Other games can use it". */
  shareable: boolean;
  publishedAt: number | null;
  takenDownAt: number | null;
}
