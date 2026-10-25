/**
 * Create › Items in the renderer (marketplace plan 10.3, P10–P12; screens 07–09). Browse holds
 * other creators' shared items, the search they answer and the one on show; Selling holds the
 * account's own items and the ready / on-hold strip. Both are read from genex.games through main,
 * which signs in as the app's Genex account: every price, share and count here is genex.games' own,
 * never computed. The store also keeps which of the account's local games are on Genex (each game's
 * Genex project, from its publish record), the game Add to and New item act on, and the item actions
 * Selling and the chat's Listing draft card share: Put on sale, Take off sale and Other games can
 * use it, each pressed by the person and carried out by main (D40). Browse's detail says which of the
 * account's games each item was added to, for Added and Remove from. A tab chosen and the window
 * coming back read the tab on show again, a burst of them once (`REREAD_GAP_MS`); a press that
 * changed something reads what it changed again at once. A game's local drafts (made before it is
 * on Genex) are main's record (`studio:items.local`): the person's "Sell when published", sharing one,
 * and the settle after the game's publish, each carried out by main. Pure actions; the store's
 * commands call `StudioApi`.
 */
import { createStore, type StoreApi } from "zustand/vanilla";
import { SECOND_MS } from "../../shared/duration.ts";
import { GENEX_PLUGIN_ID, GenexAction, GenexPublishStatusOperation } from "../../shared/genex.ts";
import type { LocalItemsView, LocalListingDraft, LocalShareResult } from "../../shared/item-draft.ts";
import { isPlayGameId } from "../../shared/play-manage.ts";
import {
  type BrowseDetail,
  type BrowseItem,
  type BrowsePage,
  BROWSE_PAGE_SIZE,
  BROWSE_QUERY_MAX,
  type CreatorItem,
  isStoreRefused,
  type ItemAdded,
  type ItemAllowance,
  type Selling,
  type StoreRefused,
  StoreRefusal,
} from "../../shared/store-items.ts";
import type { StudioApi } from "../../shared/studio-api.ts";
import { rereadDue } from "./refresher.ts";

/** How long Browse waits after the person's last key before it searches: one read per pause, not one per key. */
export const BROWSE_TYPING_MS = SECOND_MS / 4;

/** The items store's timer (Browse's wait for the typing to pause) and the clock re-reads are paced on. */
export interface ItemsTimers {
  setTimeout(run: () => void, ms: number): unknown;
  /** The wall clock; absent reads `Date.now`. */
  now?(): number;
}

const browserTimers: ItemsTimers = { setTimeout: (run, ms) => globalThis.setTimeout(run, ms) };

/** Create › Items' two tabs. */
export const ItemsTab = { Browse: "browse", Selling: "selling" } as const;
export type ItemsTab = (typeof ItemsTab)[keyof typeof ItemsTab];

/** Where a read of genex.games stands. */
export const ItemsRead = {
  Idle: "idle",
  Loading: "loading",
  Ready: "ready",
  Failed: "failed",
  /** The app's Genex account is signed out: the page asks for a sign-in. */
  SignedOut: "signed-out",
  /** genex.games' store is off (`STORE_MODE`, P23). */
  Off: "off",
} as const;
export type ItemsRead = (typeof ItemsRead)[keyof typeof ItemsRead];

/** What a press on an item asks genex.games to do. */
export const ItemAction = {
  PutOnSale: "put-on-sale",
  TakeOffSale: "take-off-sale",
  /** "Other games can use it", on. */
  Share: "share",
  /** "Other games can use it", off. */
  Unshare: "unshare",
  /** Add to \<game>. */
  Add: "add",
  /** Remove from \<game>. */
  Remove: "remove",
} as const;
export type ItemAction = (typeof ItemAction)[keyof typeof ItemAction];

/** A press on a local draft: the person's "Sell when published", its undo, and Other games can use it. */
export const LocalAction = {
  Approve: "approve",
  Withdraw: "withdraw",
  Share: "share",
  Unshare: "unshare",
} as const;
export type LocalAction = (typeof LocalAction)[keyof typeof LocalAction];

/** The actions that change the item itself, as genex.games answers them with the item. */
export type ItemChange = Exclude<ItemAction, typeof ItemAction.Add | typeof ItemAction.Remove>;

/** Browse: the search, its items, and the one on show (each item carries all its panel shows). */
export interface BrowseView {
  query: string;
  read: ItemsRead;
  items: BrowseItem[];
  nextCursor: string | null;
  /** The next page is being read. */
  more: boolean;
  selectedId: string | null;
  /** The selling game's share genex.games configures, in basis points; absent until a page names it. */
  sellerShareBps?: number;
  /** Each item's detail as last read, by item id: which of the account's games it was added to. */
  details: Record<string, BrowseDetail>;
}

/** Selling: the account's items and the strip. */
export interface SellingView {
  read: ItemsRead;
  selling: Selling | null;
}

export interface ItemsState {
  tab: ItemsTab;
  browse: BrowseView;
  selling: SellingView;
  /** Each local game's Genex project id by its name; null when the game is not on Genex. Absent: not read yet. */
  hosted: Record<string, string | null>;
  /** The local game Add to and New item act on; null takes the default. */
  target: string | null;
  /** A press under way, by item id. */
  busy: Record<string, ItemAction>;
  /** Each item as genex.games last answered a press on it: what its card and its row show. */
  changed: Record<string, CreatorItem>;
  /** Why genex.games refused the last press on an item, by item id. */
  refused: Record<string, StoreRefusal>;
  /** New item opened this game's chat: its composer asks for an item until the person sends. */
  askingIn: string | null;
  /** Each game's local drafts as main last answered, by game. */
  local: Record<string, LocalItemsView>;
  /** A press on a local draft under way, by local id. */
  localBusy: Record<string, LocalAction>;
  /** Local drafts whose last press main could not carry out, by local id. */
  localFailed: Record<string, true>;
}

/** Nothing read yet. */
export const initialItems = (): ItemsState => ({
  tab: ItemsTab.Browse,
  browse: {
    query: "",
    read: ItemsRead.Idle,
    items: [],
    nextCursor: null,
    more: false,
    selectedId: null,
    details: {},
  },
  selling: { read: ItemsRead.Idle, selling: null },
  hosted: {},
  target: null,
  busy: {},
  changed: {},
  refused: {},
  askingIn: null,
  local: {},
  localBusy: {},
  localFailed: {},
});

/** How a refused read shows: signed out, the store off, or a failure. */
export function readOf(refused: StoreRefused): ItemsRead {
  if (refused.refused === StoreRefusal.Unauthorized) return ItemsRead.SignedOut;
  if (refused.refused === StoreRefusal.NotFound) return ItemsRead.Off;
  return ItemsRead.Failed;
}

const without = <T>(record: Record<string, T>, key: string): Record<string, T> => {
  if (!(key in record)) return record;
  const { [key]: _gone, ...rest } = record;
  return rest;
};

/** The search Browse sends: trimmed, and no longer than Studio sends one. */
export const browseQuery = (typed: string): string => typed.trim().slice(0, BROWSE_QUERY_MAX);

export const tabChosen = (state: ItemsState, tab: ItemsTab): ItemsState =>
  state.tab === tab ? state : { ...state, tab };

/** A search starts: the list it answers comes next; the item on show stays until the answer. */
export function browseAsked(state: ItemsState, query: string): ItemsState {
  return { ...state, browse: { ...state.browse, query, read: ItemsRead.Loading, more: false } };
}

/** The next page of the search starts. */
export const moreAsked = (state: ItemsState): ItemsState => ({ ...state, browse: { ...state.browse, more: true } });

/**
 * A page of Browse came for `query`: an answer to an older search is dropped. The first page
 * replaces the list, a later one adds to it; the item on show stays while it is listed, else the
 * first item shows.
 */
export function browseAnswered(
  state: ItemsState,
  query: string,
  answer: BrowsePage | StoreRefused,
  later = false,
): ItemsState {
  if (query !== state.browse.query) return state;
  if (isStoreRefused(answer)) return { ...state, browse: { ...state.browse, read: readOf(answer), more: false } };
  const listed = later ? state.browse.items : [];
  const known = new Set(listed.map((item) => item.id));
  const items = [...listed, ...answer.items.filter((item) => !known.has(item.id))];
  const kept = items.some((item) => item.id === state.browse.selectedId);
  const selectedId = kept ? state.browse.selectedId : (items[0]?.id ?? null);
  // A page that names no share (an older API) leaves the one Browse already knows.
  const sellerShareBps = answer.sellerShareBps ?? state.browse.sellerShareBps;
  const browse: BrowseView = {
    ...state.browse,
    read: ItemsRead.Ready,
    items,
    nextCursor: answer.nextCursor,
    more: false,
    selectedId,
    ...(sellerShareBps === undefined ? {} : { sellerShareBps }),
  };
  return { ...state, browse };
}

/** A search could not be read: genex.games was out of reach. */
export function browseFailed(state: ItemsState, query: string): ItemsState {
  if (query !== state.browse.query) return state;
  return { ...state, browse: { ...state.browse, read: ItemsRead.Failed, more: false } };
}

/** An item is chosen to show in the detail panel. */
export const itemChosen = (state: ItemsState, itemId: string): ItemsState => ({
  ...state,
  browse: { ...state.browse, selectedId: itemId },
});

/** An item's detail came: what its panel says of the account's games it was added to. */
export const detailRead = (state: ItemsState, detail: BrowseDetail): ItemsState => ({
  ...state,
  browse: { ...state.browse, details: { ...state.browse.details, [detail.item.id]: detail } },
});

/** Selling is read (again): what it showed stays while it is. */
export function sellingAsked(state: ItemsState): ItemsState {
  if (state.selling.selling) return state;
  return { ...state, selling: { ...state.selling, read: ItemsRead.Loading } };
}

/** Selling came, or genex.games refused it; a refusal keeps nothing of the account's items. */
export function sellingAnswered(state: ItemsState, answer: Selling | StoreRefused): ItemsState {
  if (isStoreRefused(answer)) return { ...state, selling: { read: readOf(answer), selling: null } };
  return { ...state, selling: { read: ItemsRead.Ready, selling: answer } };
}

/** Selling could not be read; what it showed before stays. */
export function sellingFailed(state: ItemsState): ItemsState {
  if (state.selling.selling) return state;
  return { ...state, selling: { ...state.selling, read: ItemsRead.Failed } };
}

/** Which local games are on Genex, as their publish records say. */
export const hostedRead = (state: ItemsState, hosted: Record<string, string | null>): ItemsState => ({
  ...state,
  hosted: { ...state.hosted, ...hosted },
});

/** The game Add to and New item act on. */
export const targetChosen = (state: ItemsState, game: string): ItemsState => ({ ...state, target: game });

/** A press on an item starts: its last refusal goes. */
export function actionStarted(state: ItemsState, itemId: string, action: ItemAction): ItemsState {
  return { ...state, busy: { ...state.busy, [itemId]: action }, refused: without(state.refused, itemId) };
}

/** genex.games answered a press with the item as it is now: its row in Selling follows. */
export function itemChanged(state: ItemsState, item: CreatorItem): ItemsState {
  const selling = state.selling.selling;
  const rows = selling?.items.map((row) =>
    row.id === item.id ? { ...row, state: item.state, shareable: item.shareable } : row,
  );
  return {
    ...state,
    busy: without(state.busy, item.id),
    changed: { ...state.changed, [item.id]: item },
    refused: without(state.refused, item.id),
    selling: selling && rows ? { ...state.selling, selling: { ...selling, items: rows } } : state.selling,
  };
}

/** genex.games refused a press, or could not be reached (`Unknown`): the item says why. */
export function itemRefused(state: ItemsState, itemId: string, code: StoreRefusal): ItemsState {
  return { ...state, busy: without(state.busy, itemId), refused: { ...state.refused, [itemId]: code } };
}

/** A press ended with nothing to show for it (an item added to a game). */
export const actionEnded = (state: ItemsState, itemId: string): ItemsState => ({
  ...state,
  busy: without(state.busy, itemId),
});

/** Main answered a game's local drafts. */
export const localRead = (state: ItemsState, view: LocalItemsView): ItemsState => ({
  ...state,
  local: { ...state.local, [view.project]: view },
});

/** A press on a local draft starts: its last failure goes. */
export const localStarted = (state: ItemsState, localId: string, action: LocalAction): ItemsState => ({
  ...state,
  localBusy: { ...state.localBusy, [localId]: action },
  localFailed: without(state.localFailed, localId),
});

/** A press on a local draft ended; `failed` when main could not carry it out. */
export function localEnded(state: ItemsState, localId: string, failed: boolean): ItemsState {
  const localBusy = without(state.localBusy, localId);
  if (!failed) return { ...state, localBusy };
  return { ...state, localBusy, localFailed: { ...state.localFailed, [localId]: true } };
}

/** New item opened `game`'s chat (or, null, the person sent from it): its composer asks for an item meanwhile. */
export const askedForItem = (state: ItemsState, game: string | null): ItemsState =>
  state.askingIn === game ? state : { ...state, askingIn: game };

/** The local game an item's Genex project is, when it is on this computer. */
export function localGameOf(hosted: Record<string, string | null>, projectId: string | undefined): string | null {
  if (!projectId) return null;
  return Object.keys(hosted).find((game) => hosted[game] === projectId) ?? null;
}

/** The games Add to offers: the local ones on Genex, in the order given. */
export const hostedGames = (hosted: Record<string, string | null>, games: readonly string[]): string[] =>
  games.filter((game) => typeof hosted[game] === "string");

/** The game Add to acts on: the one chosen when it is on Genex, else the first that is; null with none. */
export function addTarget(state: Pick<ItemsState, "hosted" | "target">, games: readonly string[]): string | null {
  const offered = hostedGames(state.hosted, games);
  if (state.target && offered.includes(state.target)) return state.target;
  return offered[0] ?? null;
}

/** How a press on an item ended: the item as it is now, or why not. */
export type ItemOutcome = { item: CreatorItem } | StoreRefused;

/** Browse holds no more than its first page: a re-read of that page loses nothing "Show more" added. */
const firstPageOnly = (browse: BrowseView): boolean => browse.items.length <= BROWSE_PAGE_SIZE;

/** The call each change makes: Studio main asks genex.games as the app's account. */
const CHANGE_CALL: Record<ItemChange, (api: StudioApi, itemId: string) => Promise<CreatorItem | StoreRefused>> = {
  [ItemAction.PutOnSale]: (api, itemId) => api.itemPutOnSale(itemId),
  [ItemAction.TakeOffSale]: (api, itemId) => api.itemTakeOffSale(itemId),
  [ItemAction.Share]: (api, itemId) => api.itemSetShared(itemId, true),
  [ItemAction.Unshare]: (api, itemId) => api.itemSetShared(itemId, false),
};

/** A game's Genex project id from its publish record, or null when it has none (or none could be read). */
async function hostedProject(api: StudioApi, game: string): Promise<string | null> {
  const args = { operation: GenexPublishStatusOperation.Status };
  const record = await api.pluginAction(GENEX_PLUGIN_ID, GenexAction.PublishStatus, args, game).catch(() => null);
  const projectId = typeof record === "object" && record !== null ? Reflect.get(record, "projectId") : null;
  return isPlayGameId(projectId) ? projectId : null;
}

export interface ItemsStore extends StoreApi<ItemsState> {
  /** Read Browse for what was typed (from its first page). */
  search(typed: string): Promise<void>;
  /** The person typed in Browse's search: it shows at once, and is read once the typing pauses. */
  searchTyped(typed: string): void;
  /** Read Browse's next page. */
  more(): Promise<void>;
  /** Read Selling (again). */
  readSelling(): Promise<void>;
  /** Show a tab, read again when its last read is old. */
  chooseTab(tab: ItemsTab): Promise<void>;
  /** The page came back to the front: the tab on show is read again when its last read is old. */
  refresh(): Promise<void>;
  /** Show an item in Browse's detail panel, with the games it was added to read afresh. */
  choose(itemId: string): Promise<void>;
  /** Read which of these local games are on Genex. */
  readHosted(games: readonly string[]): Promise<void>;
  /** Press Put on sale, Take off sale, or Other games can use it on an item. */
  change(itemId: string, action: ItemChange): Promise<ItemOutcome>;
  /** Add to \<game>: allow the item in a local game that is on Genex. */
  addToGame(itemId: string, game: string): Promise<ItemAdded | StoreRefused>;
  /** Remove from \<game>: take a shared item out of a local game that is on Genex. */
  removeFromGame(itemId: string, game: string): Promise<ItemAllowance | StoreRefused>;
  /** Read a game's local drafts from main. */
  readLocal(project: string): Promise<void>;
  /** Press "Sell when published", its undo, or Other games can use it on a local draft as its card shows it. */
  pressLocal(draft: LocalListingDraft, action: LocalAction): Promise<void>;
  /** Settle a game's local drafts (main paces it; `force` right after its publish finished). */
  settleLocal(project: string, force: boolean): Promise<void>;
}

/** What the store's reads and presses share: the store, its setter, Studio's calls and the clock. */
interface ItemsContext {
  store: StoreApi<ItemsState>;
  set(next: (state: ItemsState) => ItemsState): void;
  api: StudioApi;
  timers: ItemsTimers;
  now(): number;
  /** When each tab was last read, for the re-reads a focus or a tab asks for. */
  lastRead: Partial<Record<ItemsTab, number>>;
}

/** Browse's reads: a search, the typing that waits for a pause, the next page, an item's detail and a re-read. */
function browseReads(ctx: ItemsContext) {
  const { store, set, api } = ctx;
  /** Each key typed in the search: only the read the last one asked for goes out. */
  let keys = 0;
  /** The detail of `itemId`, read again; a refusal or an outage keeps what it showed. */
  const readDetail = async (itemId: string): Promise<void> => {
    const answer = await api.itemsBrowseDetail(itemId).catch(() => null);
    if (answer && !isStoreRefused(answer)) set((state) => detailRead(state, answer));
  };
  const readPage = async (query: string, cursor: string | null, later: boolean): Promise<void> => {
    try {
      const answer = await api.itemsBrowse(query, cursor);
      const shown = store.getState().browse.selectedId;
      set((state) => browseAnswered(state, query, answer, later));
      // A first page shows its first item: read where that one was added.
      const selected = store.getState().browse.selectedId;
      if (selected && (selected !== shown || !later)) await readDetail(selected);
    } catch {
      set((state) => browseFailed(state, query));
    }
  };
  const search = async (typed: string): Promise<void> => {
    const query = browseQuery(typed);
    ctx.lastRead[ItemsTab.Browse] = ctx.now();
    set((state) => browseAsked(state, query));
    await readPage(query, null, false);
  };
  return {
    search,
    readDetail,
    searchTyped: (typed: string) => {
      const query = browseQuery(typed);
      set((state) => browseAsked(state, query));
      keys += 1;
      const key = keys;
      ctx.timers.setTimeout(() => {
        if (key === keys) void readPage(query, null, false);
      }, BROWSE_TYPING_MS);
    },
    more: async () => {
      const { query, nextCursor, more } = store.getState().browse;
      if (!nextCursor || more) return;
      set(moreAsked);
      await readPage(query, nextCursor, true);
    },
    /** Browse again: its first page, unless Show more added to it, and the item on show. */
    reread: async (): Promise<void> => {
      const { browse } = store.getState();
      if (firstPageOnly(browse)) return search(browse.query);
      ctx.lastRead[ItemsTab.Browse] = ctx.now();
      if (browse.selectedId) await readDetail(browse.selectedId);
    },
  };
}

/** Selling read (again): what it showed stays while it is. */
async function readSellingOf(ctx: ItemsContext): Promise<void> {
  const { set } = ctx;
  ctx.lastRead[ItemsTab.Selling] = ctx.now();
  set(sellingAsked);
  try {
    const answer = await ctx.api.itemsSelling();
    set((state) => sellingAnswered(state, answer));
  } catch {
    set(sellingFailed);
  }
}

/**
 * Add to and Remove from \<game>, each by the game's Genex project from its publish record; what
 * genex.games refuses stays on the item, and what it did is read again in the item's detail.
 */
function gamePresses(ctx: ItemsContext, readDetail: (itemId: string) => Promise<void>) {
  const { store, set } = ctx;
  const press = async <T>(
    itemId: string,
    game: string,
    action: typeof ItemAction.Add | typeof ItemAction.Remove,
    call: (projectId: string) => Promise<T | StoreRefused>,
  ): Promise<T | StoreRefused> => {
    const projectId = store.getState().hosted[game];
    if (!projectId) return { refused: StoreRefusal.ProjectNotFound };
    set((state) => actionStarted(state, itemId, action));
    const answer = await call(projectId).catch((): StoreRefused => ({ refused: StoreRefusal.Unknown }));
    if (isStoreRefused(answer)) set((state) => itemRefused(state, itemId, answer.refused));
    else {
      set((state) => actionEnded(state, itemId));
      void readDetail(itemId);
    }
    return answer;
  };
  return {
    addToGame: (itemId: string, game: string) =>
      press(itemId, game, ItemAction.Add, (projectId) => ctx.api.itemsAddToGame(itemId, projectId)),
    removeFromGame: (itemId: string, game: string) =>
      press(itemId, game, ItemAction.Remove, (projectId) => ctx.api.itemsRemoveFromGame(itemId, projectId)),
  };
}

/** The call each local press makes: main records the approval, or runs the CLI's `shop set` for sharing. */
const LOCAL_CALL: Record<
  LocalAction,
  (api: StudioApi, draft: LocalListingDraft) => Promise<LocalItemsView | LocalShareResult>
> = {
  [LocalAction.Approve]: (api, draft) => api.itemsLocalApprove(draft.project, draft.localId, draft.contentHash),
  [LocalAction.Withdraw]: (api, draft) => api.itemsLocalWithdraw(draft.project, draft.localId),
  [LocalAction.Share]: (api, draft) => api.itemsLocalShare(draft.project, draft.localId, draft.contentHash, true),
  [LocalAction.Unshare]: (api, draft) => api.itemsLocalShare(draft.project, draft.localId, draft.contentHash, false),
};

/** Whether main's answer is a game's local drafts (an approval or its undo), not a sharing result. */
const isLocalView = (answer: LocalItemsView | LocalShareResult): answer is LocalItemsView => "approvals" in answer;

/** The local-draft presses, each carried out by main; a sharing press reads the game's drafts again. */
function localPresses(ctx: ItemsContext, readSelling: () => Promise<void>) {
  const { set, api } = ctx;
  const readLocal = async (project: string): Promise<void> => {
    const view = await api.itemsLocal(project).catch(() => null);
    if (view) set((state) => localRead(state, view));
  };
  const pressLocal = async (draft: LocalListingDraft, action: LocalAction): Promise<void> => {
    set((state) => localStarted(state, draft.localId, action));
    const answer = await LOCAL_CALL[action](api, draft).catch((): LocalShareResult => ({ failed: true }));
    if (isLocalView(answer)) set((state) => localRead(state, answer));
    else if ("draft" in answer) await readLocal(draft.project);
    set((state) => localEnded(state, draft.localId, !isLocalView(answer) && "failed" in answer));
  };
  const settleLocal = async (project: string, force: boolean): Promise<void> => {
    const view = await api.itemsLocalSettle(project, force).catch(() => null);
    if (!view) return;
    const before = ctx.store.getState().local[project];
    set((state) => localRead(state, view));
    const uploaded = Object.keys(view.outcomes).some((localId) => !before?.outcomes[localId]);
    // An item that went up is the account's on genex.games now: Selling, once shown, reads it again.
    if (uploaded && ctx.store.getState().selling.read !== ItemsRead.Idle) await readSelling();
  };
  return { readLocal, pressLocal, settleLocal };
}

/** The store and its commands over `api`; `timers` paces Browse's search while the person types, and the re-reads. */
export function createItemsStore(api: StudioApi, timers: ItemsTimers = browserTimers): ItemsStore {
  const store = createStore<ItemsState>()(initialItems);
  const ctx: ItemsContext = {
    store,
    set: (next) => store.setState(next, true),
    api,
    timers,
    now: () => (timers.now ?? Date.now)(),
    lastRead: {},
  };
  const { set } = ctx;
  const browse = browseReads(ctx);
  const readSelling = () => readSellingOf(ctx);
  /** The tab `tab` read again, once its last read is old. */
  const reread = async (tab: ItemsTab): Promise<void> => {
    if (!rereadDue(ctx.lastRead[tab], ctx.now())) return;
    await (tab === ItemsTab.Selling ? readSelling() : browse.reread());
  };
  return Object.assign(store, {
    search: browse.search,
    searchTyped: browse.searchTyped,
    more: browse.more,
    readSelling,
    chooseTab: async (tab: ItemsTab) => {
      set((state) => tabChosen(state, tab));
      await reread(tab);
    },
    refresh: () => reread(store.getState().tab),
    choose: async (itemId: string) => {
      set((state) => itemChosen(state, itemId));
      await browse.readDetail(itemId);
    },
    readHosted: async (games: readonly string[]) => {
      const read = await Promise.all(games.map(async (game) => [game, await hostedProject(api, game)] as const));
      set((state) => hostedRead(state, Object.fromEntries(read)));
    },
    change: async (itemId: string, action: ItemChange): Promise<ItemOutcome> => {
      set((state) => actionStarted(state, itemId, action));
      const answer = await CHANGE_CALL[action](api, itemId).catch(() => ({ refused: StoreRefusal.Unknown }));
      if (isStoreRefused(answer)) {
        set((state) => itemRefused(state, itemId, answer.refused));
        return answer;
      }
      set((state) => itemChanged(state, answer));
      // Sold, Earned and the strip move with a sale or its end: Selling is read again at once.
      void readSelling();
      return { item: answer };
    },
    ...gamePresses(ctx, browse.readDetail),
    ...localPresses(ctx, readSelling),
  });
}
