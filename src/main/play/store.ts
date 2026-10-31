/**
 * The store client (marketplace plan 10.1): genex.games' `/api/store` routes and the creator
 * `/api/coin` routes, called from main as the app's Genex account, for a game's Store and My items
 * tabs, "Works in N games", the profile shelf, a complaint, a purchase or a claim from a game's page,
 * and Create › Items (Browse, adding a shared item to a game, Selling, and the author's Put on sale,
 * Take off sale and Other games can use it). What genex.games answers is hostile input: an item
 * whose id, name, type or price cannot be trusted is left out, a malformed extra reads as absent,
 * words lose the characters that turn their direction or control a terminal, lists and numbers are
 * bounded, and an id that is not one is never sent. A refusal answers its code
 * ({@link StoreRefusal}); an outage throws. Only a read ends the sign-in when genex.games refuses
 * the token, as in `coin.ts`. Electron-free: the request, the token and the refused-token report
 * come in as deps.
 */
import { isPlaySlug } from "../../shared/play.ts";
import { isPlayGameId } from "../../shared/play-manage.ts";
import { isAccountId } from "../../shared/play-people.ts";
import { isIntentId, withoutBidiControls } from "../../shared/play-purchase.ts";
import { isHandle } from "../../shared/handle.ts";
import {
  BROWSE_PAGE_MAX,
  BROWSE_PAGE_SIZE,
  BROWSE_QUERY_MAX,
  type BrowseDetail,
  type BrowseItem,
  type BrowsePage,
  type CreatorItem,
  ITEM_DESCRIPTION_MAX,
  ITEM_GAMES_PREVIEW_MAX,
  ITEM_NAME_MAX,
  ITEM_REPORT_MESSAGE_MAX,
  ITEM_SHELF_MAX,
  ITEM_TAG_LENGTH_MAX,
  ITEM_TAGS_MAX,
  type ItemAdded,
  type ItemAddedTo,
  type ItemAllowance,
  type ItemGame,
  type ItemGameRef,
  type ItemGames,
  type ItemPerson,
  type ItemReportReason,
  isAllowanceState,
  isItemId,
  isItemPlace,
  isItemReportReason,
  isItemState,
  isItemType,
  type MyItem,
  normalizeItemTags,
  type OwnedGameRef,
  type PlayerItem,
  SALE_BPS,
  type Selling,
  type SellingRow,
  type ShelfItem,
  type StoreClaimed,
  type StoreItem,
  StoreRefusal,
  type StoreRefused,
  type StoreTab,
  storeRefusalOf,
} from "../../shared/store-items.ts";
import { type CoinDeps, type CoinIntent, toCoinIntent } from "./coin.ts";
import { type GalleryAnswer, GalleryError, HTTP_UNAUTHORIZED, imageUrl, isCursor, isRecord } from "./gallery.ts";
import { refusingRequest } from "./people.ts";

/** The most coin one item may cost here: the cap of the surface Studio confirms on (`coin.ts`). */
const COINS_MAX = 100_000;
/** The most of anything a count may say: a consumable left, games an item works in. */
const COUNT_MAX = 1_000_000;
/** The most cards a tab, rows Selling or games a detail's "added to" keeps. */
const TAB_ITEMS_MAX = 400;
const SELLING_ROWS_MAX = 1000;
const ADDED_TO_MAX = 100;
/** The most files a package summary counts. */
const PACKAGE_FILES_MAX = 10_000;
/** genex.games' own limits on a game's title, a person's name and the hold's length in days. */
const TITLE_MAX = 200;
const PERSON_NAME_MAX = 120;
const HOLD_DAYS_MAX = 60;
/** A success that does not answer what was asked reads as a bad gateway, as the gallery's do. */
const BAD_GATEWAY = 502;
/** HTTP statuses from here on are genex.games failing, not refusing. */
const SERVER_ERROR = 500;
const TOO_MANY_REQUESTS = 429;
/**
 * Control characters (C0, DEL, C1), which could drive a terminal or hide text, and the characters
 * that turn the direction text runs in, which could make a price or a name read backwards.
 */
const CONTROLS = /\p{Cc}/gu;
const CONTROLS_BUT_NEWLINE = /(?!\n)\p{Cc}/gu;

/** A malformed call from Studio's own renderer: stays English for its developer. */
const MESSAGE = {
  BadItem: "Not an item on genex.games",
  BadGame: "Not a game address",
  BadProject: "Not a game on genex.games",
  BadPerson: "Not a Genex account",
  BadReason: "Not a reason an item is reported for",
  BadMessage: "A complaint's message is too long",
  BadCursor: "Not a Browse cursor",
  BadFlag: "Not a yes or no",
} as const;

const segment = encodeURIComponent;

/** The routes the store client calls. */
export const StoreRoute = {
  items: (slug: string) => `/api/store/games/${segment(slug)}/items`,
  myItems: (slug: string) => `/api/store/games/${segment(slug)}/my-items`,
  itemGames: (id: string) => `/api/store/items/${segment(id)}/games`,
  purchase: (id: string) => `/api/store/items/${segment(id)}/purchase`,
  claim: (id: string) => `/api/store/items/${segment(id)}/claim`,
  reports: (id: string) => `/api/store/items/${segment(id)}/reports`,
  shelf: (userId: string) => `/api/store/users/${segment(userId)}/shelf`,
  Catalog: "/api/store/catalog",
  catalogItem: (id: string) => `/api/store/catalog/${segment(id)}`,
  allowances: (projectId: string) => `/api/store/projects/${segment(projectId)}/allowances`,
  allowance: (projectId: string, id: string) => `/api/store/projects/${segment(projectId)}/allowances/${segment(id)}`,
  Selling: "/api/store/selling",
  sku: (id: string) => `/api/coin/skus/${segment(id)}`,
  publish: (id: string) => `/api/coin/skus/${segment(id)}/publish`,
  unpublish: (id: string) => `/api/coin/skus/${segment(id)}/unpublish`,
} as const;

/** What a Browse page asks for. */
export interface BrowseRequest {
  query: string;
  cursor: string | null;
  tags: readonly string[];
}

/** What the store client needs: the coin client's deps (the request, the token, the refused-token report). */
export type StoreDeps = CoinDeps;

const refused = (code: StoreRefusal): StoreRefused => ({ refused: code });
const SIGN_IN = refused(StoreRefusal.Unauthorized);

// ---------------------------------------------------------------------------------------------
// Reading genex.games' words, numbers, ids and addresses
// ---------------------------------------------------------------------------------------------

const wholeIn = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;

/** One line of genex.games' words, cleaned: null when it is not text, empty, or longer than `max`. */
function line(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const clean = withoutBidiControls(value).replace(CONTROLS, "").trim();
  return clean && clean.length <= max ? clean : null;
}

/** An item's description, its lines kept: null with none, undefined when it is longer than an item may have. */
function prose(value: unknown): string | null | undefined {
  if (typeof value !== "string") return null;
  const clean = withoutBidiControls(value).replace(CONTROLS_BUT_NEWLINE, "").trim();
  if (clean.length > ITEM_DESCRIPTION_MAX) return undefined;
  return clean || null;
}

/** A count to show ("in N games", "2 left"): a whole number in range, else `fallback`. */
const countOr = <T>(value: unknown, fallback: T): number | T => (wholeIn(value, 0, COUNT_MAX) ? value : fallback);

/** A time genex.games wrote (ISO), in milliseconds since the epoch; null when it is not one. */
function timeOf(value: unknown): number | null {
  const at = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(at) ? at : null;
}

/**
 * The hosts an item's model may come from: Genex's asset buckets (`R2_ASSETS_BASE`, where genex.games
 * keeps every item's files, contract D62). The sheet fetches a model itself, so these are exactly the
 * hosts `renderer/index.html`'s `connect-src` lets the window read.
 */
const MODEL_HOSTS: ReadonlySet<string> = new Set(["assets.genex.technology", "assets.genex.games"]);

/** A model file over https on one of Genex's asset hosts; never a drawn stand-in. */
function modelUrl(value: unknown): string | null {
  const url = imageUrl(value, false);
  return url && MODEL_HOSTS.has(new URL(url).hostname) ? url : null;
}

/** A game as the store names one, or null. */
function gameRefOf(value: unknown): ItemGameRef | null {
  if (!isRecord(value) || !isPlaySlug(value.slug)) return null;
  const title = line(value.title, TITLE_MAX);
  return title ? { slug: value.slug, title } : null;
}

/** A game the account owns, as Selling names one, or null. */
function ownedGameOf(value: unknown): OwnedGameRef | null {
  const game = gameRefOf(value);
  return game && isRecord(value) && isPlayGameId(value.id) ? { id: value.id, ...game } : null;
}

/** An item's author, or null when they cannot be named. */
function personOf(value: unknown): ItemPerson | null {
  if (!isRecord(value) || !isAccountId(value.id)) return null;
  const name = line(value.name, PERSON_NAME_MAX);
  if (!name) return null;
  return { id: value.id, name, handle: isHandle(value.handle) ? value.handle : null };
}

/** Tags as genex.games stores them, at most ten, each short and with no comma (Browse's `tags` splits on it). */
const keptTags = (raw: readonly string[]): string[] =>
  normalizeItemTags(raw)
    .filter((tag) => tag.length <= ITEM_TAG_LENGTH_MAX && !tag.includes(","))
    .slice(0, ITEM_TAGS_MAX);

/** An item's tags from an answer, each cleaned as a line of words; any that is not one is dropped. */
function tagsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const words = value.filter((tag): tag is string => typeof tag === "string").map((tag) => line(tag, TITLE_MAX) ?? "");
  return keptTags(words);
}

/** A list from an answer, cut to `max` and read item by item; items that do not read are left out. */
function listOf<T>(value: unknown, max: number, read: (item: unknown) => T | null): T[] | null {
  if (!Array.isArray(value)) return null;
  const items: T[] = [];
  for (const item of value) {
    const one = read(item);
    if (one) items.push(one);
    if (items.length === max) break;
  }
  return items;
}

/** What an item's price is: whole coin Studio may confirm, and its dollar value; null when either is not. */
function priceOf(item: Record<string, unknown>): { priceCoins: number; priceDisplayUsdCents: number } | null {
  const { priceCoins, priceDisplayUsdCents } = item;
  const priced = wholeIn(priceCoins, 0, COINS_MAX) && wholeIn(priceDisplayUsdCents, 0, Number.MAX_SAFE_INTEGER);
  return priced ? { priceCoins, priceDisplayUsdCents } : null;
}

/** What every item carries, or null when its id, name, type, price or description cannot be trusted. */
function itemCoreOf(item: Record<string, unknown>, local: boolean) {
  const { id, type } = item;
  const name = line(item.name, ITEM_NAME_MAX);
  const description = prose(item.description);
  const price = priceOf(item);
  if (!isItemId(id) || !isItemType(type) || !name || !price || description === undefined) return null;
  return {
    id,
    name,
    description,
    iconUrl: imageUrl(item.iconUrl, local),
    modelUrl: modelUrl(item.modelUrl),
    type,
    ...price,
  };
}

/** An item a player sees, or null. */
function playerItemOf(value: unknown, local: boolean): PlayerItem | null {
  if (!isRecord(value) || typeof value.shared !== "boolean") return null;
  const core = itemCoreOf(value, local);
  if (!core) return null;
  return {
    ...core,
    shared: value.shared,
    gamesCount: countOr(value.gamesCount, 0),
    homeGame: gameRefOf(value.homeGame),
  };
}

/** A Store card, or null. */
function storeItemOf(value: unknown, local: boolean): StoreItem | null {
  const item = playerItemOf(value, local);
  if (!item || !isRecord(value)) return null;
  const owned = typeof value.owned === "boolean" ? value.owned : null;
  return { ...item, owned, remaining: countOr(value.remaining, null) };
}

/** A My items row, or null. */
function myItemOf(value: unknown, local: boolean): MyItem | null {
  const item = playerItemOf(value, local);
  if (!item || !isRecord(value) || !isItemPlace(value.place)) return null;
  const acquiredAt = timeOf(value.acquiredAt);
  if (acquiredAt === null) return null;
  return { ...item, place: value.place, remaining: countOr(value.remaining, null), acquiredAt };
}

/** A game in "Works in N games", or null. */
function itemGameOf(value: unknown, local: boolean): ItemGame | null {
  const game = gameRefOf(value);
  return game && isRecord(value) ? { ...game, coverUrl: imageUrl(value.coverUrl, local) } : null;
}

/** A shelf item, or null. */
function shelfItemOf(value: unknown, local: boolean): ShelfItem | null {
  if (!isRecord(value) || !isItemId(value.id)) return null;
  const name = line(value.name, ITEM_NAME_MAX);
  if (!name) return null;
  const game = itemGameOf(value.game, local);
  const iconUrl = imageUrl(value.iconUrl, local);
  // Only a plain false takes Get in <game> away: an API that does not send it still sells it there.
  return { id: value.id, name, iconUrl, modelUrl: modelUrl(value.modelUrl), game, onSale: value.onSale !== false };
}

/** A Browse item, or null: one with no author it can name is left out. */
function browseItemOf(value: unknown, local: boolean): BrowseItem | null {
  if (!isRecord(value)) return null;
  const core = itemCoreOf(value, local);
  const author = personOf(value.author);
  if (!core || !author) return null;
  return {
    ...core,
    tags: tagsOf(value.tags),
    author,
    homeGame: gameRefOf(value.homeGame),
    gamesCount: countOr(value.gamesCount, 0),
    youGetPerSale: wholeIn(value.youGetPerSale, 0, COINS_MAX) ? value.youGetPerSale : 0,
  };
}

/** One of the account's games an item was added to, or null. */
function addedToOf(value: unknown): ItemAddedTo | null {
  const game = gameRefOf(value);
  if (!game || !isRecord(value) || !isPlayGameId(value.projectId)) return null;
  return { projectId: value.projectId, ...game, live: timeOf(value.liveFromBuildAt) !== null };
}

/** A package's manifest in short: its files and their bytes together; null with none or one it cannot count. */
function packageOf(value: unknown): BrowseDetail["package"] {
  if (!isRecord(value) || !Array.isArray(value.files) || value.files.length > PACKAGE_FILES_MAX) return null;
  let bytes = 0;
  for (const file of value.files) {
    const size = isRecord(file) ? file.bytes : undefined;
    if (!wholeIn(size, 0, Number.MAX_SAFE_INTEGER)) return null;
    bytes += size;
  }
  return wholeIn(bytes, 0, Number.MAX_SAFE_INTEGER) ? { files: value.files.length, bytes } : null;
}

/** An allowance, or null. */
function allowanceOf(value: unknown): ItemAllowance | null {
  if (!isRecord(value) || !isItemId(value.skuId) || !isPlayGameId(value.projectId)) return null;
  const addedAt = timeOf(value.addedAt);
  if (!isAllowanceState(value.state) || addedAt === null) return null;
  return {
    itemId: value.skuId,
    projectId: value.projectId,
    state: value.state,
    addedAt,
    liveAt: timeOf(value.liveFromBuildAt),
  };
}

/** What a Selling row counts: sold and earned, whole and not below zero; null when either is not. */
function salesOf(row: Record<string, unknown>): { sold: number; earned: number } | null {
  const { sold, earned } = row;
  return wholeIn(sold, 0, Number.MAX_SAFE_INTEGER) && wholeIn(earned, 0, Number.MAX_SAFE_INTEGER)
    ? { sold, earned }
    : null;
}

/** A Selling row, or null. */
function sellingRowOf(value: unknown, local: boolean): SellingRow | null {
  if (!isRecord(value) || !isItemId(value.id) || !isItemType(value.type) || !isItemState(value.state)) return null;
  const name = line(value.name, ITEM_NAME_MAX);
  const price = priceOf(value);
  const sales = salesOf(value);
  if (!name || !price || !sales) return null;
  return {
    id: value.id,
    name,
    iconUrl: imageUrl(value.iconUrl, local),
    type: value.type,
    game: ownedGameOf(value.game),
    gamesCount: countOr(value.gamesCount, 0),
    state: value.state,
    underReview: value.underReview === true,
    shareable: value.shareable === true,
    ...price,
    ...sales,
  };
}

/** An item as its author reads it back, or null (also the CLI's `--json` draft, `core/item-draft.ts`). */
export function creatorItemOf(value: unknown, local: boolean): CreatorItem | null {
  if (!isRecord(value)) return null;
  const { state, shareable } = value;
  const core = itemCoreOf(value, local);
  const projectId = value.projectId === null || isPlayGameId(value.projectId) ? value.projectId : undefined;
  if (!core || projectId === undefined || !isItemState(state) || typeof shareable !== "boolean") return null;
  return {
    ...core,
    projectId,
    tags: tagsOf(value.tags),
    state,
    shareable,
    publishedAt: timeOf(value.publishedAt),
    takenDownAt: timeOf(value.takenDownAt),
  };
}

/** Selling's strip, or null when any of it is not coin. */
function stripOf(body: Record<string, unknown>) {
  const { earnedReady, earnedHeld, holdDays } = body;
  const coin = wholeIn(earnedReady, 0, Number.MAX_SAFE_INTEGER) && wholeIn(earnedHeld, 0, Number.MAX_SAFE_INTEGER);
  if (!coin || !wholeIn(holdDays, 0, HOLD_DAYS_MAX)) return null;
  return { earnedReady, earnedHeld, holdDays, nextReleaseAt: timeOf(body.nextReleaseAt) };
}

// ---------------------------------------------------------------------------------------------
// Calling genex.games
// ---------------------------------------------------------------------------------------------

/** A call's body, or why genex.games refused it. */
type Answered = { body: unknown } | StoreRefused;

const succeeded = (status: number): boolean => status >= 200 && status < 300;

/** A failed answer: a refusal answers its code; an outage throws, since a payment may still land. */
function refusalOf(route: string, answer: GalleryAnswer): StoreRefused {
  if (answer.status >= SERVER_ERROR) throw new GalleryError(route, answer.status);
  if (answer.status === HTTP_UNAUTHORIZED) return SIGN_IN;
  const code = storeRefusalOf(isRecord(answer.body) ? answer.body.error : undefined);
  const unnamed = code === StoreRefusal.Unknown && answer.status === TOO_MANY_REQUESTS;
  return refused(unnamed ? StoreRefusal.TooManyRequests : code);
}

/** An answer that does not read as what was asked: thrown as a bad gateway. */
const unreadable = (route: string): GalleryError => new GalleryError(route, BAD_GATEWAY);

/** The store client's calls over `deps`: reads end a refused sign-in, writes never do. */
function caller(deps: StoreDeps) {
  const reads = refusingRequest(deps.request, deps.refused);

  /** One call: `auth` is the token to send, if any. */
  const call = async (
    route: string,
    init: { method: "GET" | "POST" | "PATCH" | "DELETE"; body?: unknown },
    auth: string | undefined,
  ): Promise<Answered> => {
    const request = init.method === "GET" ? reads : deps.request;
    const answer = await request(route, { ...init, ...(auth ? { token: auth } : {}) });
    return succeeded(answer.status) ? { body: answer.body } : refusalOf(route, answer);
  };

  /** A call that needs the account: none unlocked answers Sign in, and nothing is sent. */
  const signed = async (route: string, init: Parameters<typeof call>[1]): Promise<Answered> => {
    const auth = await deps.token();
    return auth ? call(route, init, auth) : SIGN_IN;
  };

  /** A public call that carries the account when there is one. */
  const optional = async (route: string, init: Parameters<typeof call>[1]): Promise<Answered> =>
    call(route, init, await deps.token());

  /** A public read: as the account, or again as a guest when genex.games refused the account's token. */
  const publicRead = async (route: string): Promise<Answered> => {
    const auth = await deps.token();
    const first = await call(route, { method: "GET" }, auth);
    const signedOut = auth !== undefined && "refused" in first && first.refused === StoreRefusal.Unauthorized;
    return signedOut ? call(route, { method: "GET" }, undefined) : first;
  };

  return { signed, optional, publicRead, anonymous: (route: string) => call(route, { method: "GET" }, undefined) };
}

/** Read a successful answer with `read`, or pass the refusal on; an answer `read` cannot read throws. */
function readWith<T>(route: string, answered: Answered, read: (body: unknown) => T | null): T | StoreRefused {
  if ("refused" in answered) return answered;
  const value = read(answered.body);
  if (value === null) throw unreadable(route);
  return value;
}

// ---------------------------------------------------------------------------------------------
// The checks on what main sends
// ---------------------------------------------------------------------------------------------

function itemIdOf(value: unknown): string {
  if (!isItemId(value)) throw new Error(MESSAGE.BadItem);
  return value;
}

function slugOf(value: unknown): string {
  if (!isPlaySlug(value)) throw new Error(MESSAGE.BadGame);
  return value;
}

function projectIdOf(value: unknown): string {
  if (!isPlayGameId(value)) throw new Error(MESSAGE.BadProject);
  return value;
}

/** A complaint's message as sent: trimmed, left out when blank; one longer than genex.games takes throws. */
function complaintOf(reason: unknown, message: unknown): { reason: ItemReportReason; message?: string } {
  if (!isItemReportReason(reason)) throw new Error(MESSAGE.BadReason);
  const text = typeof message === "string" ? message.trim() : "";
  if (text.length > ITEM_REPORT_MESSAGE_MAX) throw new Error(MESSAGE.BadMessage);
  return text ? { reason, message: text } : { reason };
}

/** A Browse page's address: the search, its tags (no comma, which splits them), the cursor and the page size. */
function catalogRoute({ query, cursor, tags }: BrowseRequest): string {
  if (cursor !== null && !isCursor(cursor)) throw new Error(MESSAGE.BadCursor);
  const params = new URLSearchParams();
  const words = query.trim().slice(0, BROWSE_QUERY_MAX);
  if (words) params.set("q", words);
  const kept = keptTags(tags);
  if (kept.length > 0) params.set("tags", kept.join(","));
  if (cursor) params.set("cursor", cursor);
  params.set("limit", String(BROWSE_PAGE_SIZE));
  return `${StoreRoute.Catalog}?${params}`;
}

// ---------------------------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------------------------

/** A page purchase's answer as Studio may show and confirm it: this item, one of it, on genex.games' terms. */
function pagePurchaseOf(body: unknown, itemId: string, local: boolean): CoinIntent | null {
  const intent = toCoinIntent(body, local);
  const forItem = isRecord(body) && body.skuId === itemId && isIntentId(body.id);
  return intent && forItem && intent.quantity === 1 ? intent : null;
}

/** The player's calls: a game's tabs, an item's games, the shelf, a complaint, a purchase and a claim. */
function playerCalls(deps: StoreDeps, local: boolean) {
  const { signed, optional, publicRead, anonymous } = caller(deps);

  const items = async (slug: string): Promise<StoreTab> => {
    const route = StoreRoute.items(slugOf(slug));
    const answered = await publicRead(route);
    if ("refused" in answered) return { items: [], myItemsCount: null };
    const body = answered.body;
    const cards = isRecord(body) ? listOf(body.items, TAB_ITEMS_MAX, (item) => storeItemOf(item, local)) : null;
    if (!cards || !isRecord(body)) throw unreadable(route);
    return { items: cards, myItemsCount: countOr(body.myItemsCount, null) };
  };

  const myItems = async (slug: string): Promise<MyItem[] | StoreRefused> => {
    const route = StoreRoute.myItems(slugOf(slug));
    return readWith(route, await signed(route, { method: "GET" }), (body) =>
      isRecord(body) ? listOf(body.items, TAB_ITEMS_MAX, (item) => myItemOf(item, local)) : null,
    );
  };

  const itemGames = async (itemId: string): Promise<ItemGames> => {
    const route = StoreRoute.itemGames(itemIdOf(itemId));
    const answered = await anonymous(route);
    if ("refused" in answered) return { total: 0, games: [] };
    const body = answered.body;
    const games = isRecord(body) ? listOf(body.games, ITEM_GAMES_PREVIEW_MAX, (game) => itemGameOf(game, local)) : null;
    if (!games || !isRecord(body)) throw unreadable(route);
    return { total: Math.max(countOr(body.total, 0), games.length), games };
  };

  const shelf = async (userId: string): Promise<ShelfItem[]> => {
    if (!isAccountId(userId)) throw new Error(MESSAGE.BadPerson);
    const route = StoreRoute.shelf(userId);
    const answered = await anonymous(route);
    if ("refused" in answered) return [];
    const body = answered.body;
    const shelved = isRecord(body) ? listOf(body.items, ITEM_SHELF_MAX, (item) => shelfItemOf(item, local)) : null;
    if (!shelved) throw unreadable(route);
    return shelved;
  };

  const report = async (
    itemId: string,
    reason: ItemReportReason,
    message: string | null,
  ): Promise<true | StoreRefused> => {
    const route = StoreRoute.reports(itemIdOf(itemId));
    const answered = await optional(route, { method: "POST", body: complaintOf(reason, message) });
    return "refused" in answered ? answered : true;
  };

  const purchase = async (itemId: string, slug: string): Promise<CoinIntent | StoreRefused> => {
    const route = StoreRoute.purchase(itemIdOf(itemId));
    const answered = await signed(route, { method: "POST", body: { slug: slugOf(slug) } });
    return readWith(route, answered, (body) => pagePurchaseOf(body, itemId, local));
  };

  const claim = async (itemId: string, slug: string): Promise<StoreClaimed | StoreRefused> => {
    const route = StoreRoute.claim(itemIdOf(itemId));
    const answered = await signed(route, { method: "POST", body: { slug: slugOf(slug) } });
    return readWith(route, answered, (body) =>
      isRecord(body) && body.skuId === itemId && typeof body.replayed === "boolean"
        ? { itemId, replayed: body.replayed }
        : null,
    );
  };

  return { items, myItems, itemGames, shelf, report, purchase, claim };
}

/**
 * The selling game's share of a sale as an answer names it (`sellerShareBps`): a whole number of basis
 * points under the whole sale, or nothing, so the app says the design's words instead.
 */
function shareOf(body: Record<string, unknown>): { sellerShareBps?: number } {
  const bps = body.sellerShareBps;
  return wholeIn(bps, 0, SALE_BPS - 1) ? { sellerShareBps: bps } : {};
}

/** The creator's calls: Browse, adding a shared item to a game, Selling and the author's actions. */
function creatorCalls(deps: StoreDeps, local: boolean) {
  const { signed } = caller(deps);

  const browse = async (request: BrowseRequest): Promise<BrowsePage | StoreRefused> => {
    const route = catalogRoute(request);
    return readWith(route, await signed(route, { method: "GET" }), (body) => {
      const items = isRecord(body) ? listOf(body.items, BROWSE_PAGE_MAX, (item) => browseItemOf(item, local)) : null;
      if (!items || !isRecord(body)) return null;
      return { items, nextCursor: isCursor(body.nextCursor) ? body.nextCursor : null, ...shareOf(body) };
    });
  };

  const browseDetail = async (itemId: string): Promise<BrowseDetail | StoreRefused> => {
    const route = StoreRoute.catalogItem(itemIdOf(itemId));
    return readWith(route, await signed(route, { method: "GET" }), (body) => {
      const item = isRecord(body) ? browseItemOf(body.item, local) : null;
      if (!item || item.id !== itemId || !isRecord(body)) return null;
      const addedTo = listOf(body.addedTo, ADDED_TO_MAX, addedToOf) ?? [];
      return { item, package: packageOf(body.packageManifest), addedTo, ...shareOf(body) };
    });
  };

  /** An allowance of this item in this game, as an answer gives it, or null. */
  const allowanceFor = (body: unknown, itemId: string, projectId: string): ItemAllowance | null => {
    const allowance = isRecord(body) ? allowanceOf(body.allowance) : null;
    return allowance && allowance.itemId === itemId && allowance.projectId === projectId ? allowance : null;
  };

  const addToGame = async (itemId: string, projectId: string): Promise<ItemAdded | StoreRefused> => {
    const route = StoreRoute.allowances(projectIdOf(projectId));
    const answered = await signed(route, { method: "POST", body: { skuId: itemIdOf(itemId) } });
    return readWith(route, answered, (body) => {
      const allowance = allowanceFor(body, itemId, projectId);
      return allowance && isRecord(body) ? { allowance, replayed: body.replayed === true } : null;
    });
  };

  const removeFromGame = async (itemId: string, projectId: string): Promise<ItemAllowance | StoreRefused> => {
    const route = StoreRoute.allowance(projectIdOf(projectId), itemIdOf(itemId));
    return readWith(route, await signed(route, { method: "DELETE" }), (body) => allowanceFor(body, itemId, projectId));
  };

  const selling = async (): Promise<Selling | StoreRefused> => {
    const route = StoreRoute.Selling;
    return readWith(route, await signed(route, { method: "GET" }), (body) => {
      const strip = isRecord(body) ? stripOf(body) : null;
      const items = isRecord(body) ? listOf(body.items, SELLING_ROWS_MAX, (row) => sellingRowOf(row, local)) : null;
      return strip && items ? { ...strip, items } : null;
    });
  };

  /** One of the author's changes to `itemId`, read back as the item it made. */
  const change = async (
    itemId: string,
    route: string,
    init: { method: "POST" | "PATCH"; body?: unknown },
  ): Promise<CreatorItem | StoreRefused> =>
    readWith(route, await signed(route, init), (body) => {
      const item = creatorItemOf(body, local);
      return item?.id === itemId ? item : null;
    });

  const putOnSale = async (itemId: string): Promise<CreatorItem | StoreRefused> =>
    change(itemId, StoreRoute.publish(itemIdOf(itemId)), { method: "POST" });
  const takeOffSale = async (itemId: string): Promise<CreatorItem | StoreRefused> =>
    change(itemId, StoreRoute.unpublish(itemIdOf(itemId)), { method: "POST" });
  const setShared = async (itemId: string, shared: boolean): Promise<CreatorItem | StoreRefused> => {
    if (typeof shared !== "boolean") throw new Error(MESSAGE.BadFlag);
    return change(itemId, StoreRoute.sku(itemIdOf(itemId)), { method: "PATCH", body: { shareable: shared } });
  };

  return { browse, browseDetail, addToGame, removeFromGame, selling, putOnSale, takeOffSale, setShared };
}

/** The store client over `deps`. */
export function playStore(deps: StoreDeps) {
  const local = deps.localImages === true;
  return { ...playerCalls(deps, local), ...creatorCalls(deps, local) };
}

/** The store client as `playStore` makes it. */
export type PlayStore = ReturnType<typeof playStore>;
