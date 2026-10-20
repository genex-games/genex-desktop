/**
 * Play: the page shown (a shelf, Friends or someone's profile), the shelves' counts and tabs, the
 * pages of genex.games' catalog read so far, Recent, and the game the viewer shows. A tab read once draws at once when it comes back, and is read again behind it once a
 * minute old. Opening a game shows its cover at once and remembers it in Recent; main's
 * `UiEvent.PlayViewer` then says how the viewer goes. The Assets shelf keeps its switchers' choice,
 * the person's own library as Mine reads it, and the whole catalog its kind switcher reads.
 */
import { createStore, type StoreApi } from "zustand/vanilla";
import type { LibraryPage, LibraryQuery } from "../../shared/asset-library.ts";
import { MINUTE_MS } from "../../shared/duration.ts";
import type { GenexCatalogItem } from "../../shared/mention-corpus.ts";
import {
  PLAY_SHELF_TABS,
  PLAY_SHELVES,
  type PlayCategory,
  type PlayFeedPage,
  type PlayGame,
  type PlayGameDetail,
  PlayShelf,
  type PlayShelves,
  type PlayViewerEvent,
  PlayViewerPhase,
  type RemixProgress,
  RemixStep,
} from "../../shared/play.ts";
import { type PlayChangeResult, PlayChangeOutcome, type PlayGameChange } from "../../shared/play-manage.ts";
import type { StudioApi } from "../../shared/studio-api.ts";
import {
  type NativeInstalls,
  type NativeSession,
  NativeSessionPhase,
  NO_INSTALLS,
  SessionAction,
} from "../../shared/play-native.ts";
import { opensPage } from "../play/native-model.ts";
import { changedGame } from "../play/card-menu/manage-model.ts";
import {
  ALL_ASSETS,
  type AssetView,
  EMPTY_LIBRARY,
  type LibraryFeed,
  type LibraryKey,
  libraryKind,
  sameLibraryKey,
  withLibraryPage,
} from "../play/asset-tiles.ts";
import {
  countedSlugs,
  EMPTY_FEED,
  type FeedState,
  FeedStatus,
  type PlayRecentEntry,
  readRecent,
  type ViewerShown,
  viewerAfter,
  withOnline,
  withPage,
  withRecent,
  writeRecent,
} from "../play/play-model.ts";
import type { KeyValueStorage } from "../storage.ts";

/** A tab this old is read again behind what it shows. */
export const FEED_STALE_MS = MINUTE_MS;

/**
 * Which page Play shows: a shelf's dashboard, the Friends page, someone's profile, the account's
 * stats, or a native game's own page.
 */
export const PlayPage = {
  Shelf: "shelf",
  Friends: "friends",
  Profile: "profile",
  Stats: "stats",
  Game: "game",
} as const;
export type PlayPage = (typeof PlayPage)[keyof typeof PlayPage];

/** The page a profile was opened from, where its Back goes. */
type ProfileFrom = typeof PlayPage.Shelf | typeof PlayPage.Friends;

/**
 * The page Play shows. A profile remembers the page it was opened from, where Back goes; the stats
 * page remembers the profile it was opened from (the account's own), where its Back goes. A game's
 * page remembers the whole page it was opened from, and a profile opened from a game's page goes
 * back to it (`back`).
 */
export type PlayView =
  | { page: typeof PlayPage.Shelf }
  | { page: typeof PlayPage.Friends }
  | { page: typeof PlayPage.Profile; userId: string; from: ProfileFrom; back?: PlayView }
  | { page: typeof PlayPage.Stats; userId: string; from: ProfileFrom; back?: PlayView }
  | { page: typeof PlayPage.Game; slug: string; back: PlayView };

const SHELF_VIEW: PlayView = { page: PlayPage.Shelf };
const FRIENDS_VIEW: PlayView = { page: PlayPage.Friends };

/**
 * Where a remix being made is: shown over Create, set aside while the person is elsewhere (its
 * sidebar row brings it back), or its new game opening under it.
 */
export const RemixView = { Shown: "shown", Aside: "aside", Opening: "opening" } as const;
export type RemixView = (typeof RemixView)[keyof typeof RemixView];

/** A remix being made: Create shows it, its step and its bytes, until the shell opens the new game. */
export interface RemixUnderway {
  slug: string;
  /** The game it copies, by its title. */
  title: string;
  coverUrl: string | null;
  step: RemixStep;
  done: number | null;
  total: number | null;
  /** The new game's library name, once the shell is opening it: its own sidebar row takes over. */
  name: string | null;
  view: RemixView;
}

/** What Play holds between visits. */
export interface PlayState {
  /** The page shown: the chosen shelf's dashboard until Friends or a profile is opened. */
  view: PlayView;
  /** The shelf the sidebar has chosen: Games, Tools or Assets. */
  shelf: PlayShelf;
  /** Each shelf's size beside its name; null until it is read. */
  counts: PlayShelves["counts"];
  /** The tabs with something in them, shelf by shelf; each shelf's first alone until they are read. */
  categories: PlayCategory[];
  feeds: Partial<Record<PlayCategory, FeedState>>;
  recent: PlayRecentEntry[];
  /** The game the viewer shows, or null. */
  viewer: ViewerShown | null;
  /** The remix being made, shown in Create from the press until the new game opens; one at a time. */
  making: RemixUnderway | null;
  /** A finished remix's library name, waiting for the shell to open it in Create. */
  remixed: string | null;
  /** A remix failed: the shell says so once. */
  remixFailed: boolean;
  /** The viewer's guest card asked to sign in: the shell signs in to Genex once (`useGuestSignIn`). */
  installAsked: boolean;
  /** The Assets shelf's switchers: whose assets, and which kind; kept while other shelves show. */
  assetView: AssetView;
  /** The person's own library as Mine reads it, for one kind and search at a time. */
  library: LibraryFeed;
  /** The whole catalog, read once for the kind switcher's choices on Everyone. */
  assetCatalog: AssetCatalog;
  /** Native games' own pages as read, by slug. */
  games: Record<string, GamePageEntry>;
  /** What is installed and installing on this computer (`UiEvent.PlayInstalls`). */
  installs: NativeInstalls;
  /** The native games being played, and any that failed to start (`UiEvent.PlaySessions`). */
  sessions: NativeSession[];
}

/** A native game's page as read. */
export interface GamePageEntry {
  status: FeedStatus;
  game: PlayGameDetail | null;
}

/** The whole catalog as the Assets shelf read it. */
export interface AssetCatalog {
  items: GenexCatalogItem[];
  status: FeedStatus;
  at: number;
}

const EMPTY_CATALOG: AssetCatalog = { items: [], status: FeedStatus.Loading, at: 0 };

/** Play before anything is read: on Games, each shelf's first tab, and Recent as this profile remembers it. */
export const initialPlay = (recent: PlayRecentEntry[] = []): PlayState => ({
  view: SHELF_VIEW,
  shelf: PlayShelf.Games,
  counts: { [PlayShelf.Games]: null, [PlayShelf.Tools]: null, [PlayShelf.Assets]: null },
  categories: PLAY_SHELVES.map((shelf) => PLAY_SHELF_TABS[shelf][0]),
  feeds: {},
  recent,
  viewer: null,
  making: null,
  remixed: null,
  remixFailed: false,
  installAsked: false,
  assetView: ALL_ASSETS,
  library: EMPTY_LIBRARY,
  assetCatalog: EMPTY_CATALOG,
  games: {},
  installs: NO_INSTALLS,
  sessions: [],
});

/** A tab's state, or the empty one. */
export const feedOf = (state: PlayState, category: PlayCategory): FeedState => state.feeds[category] ?? EMPTY_FEED;

const withFeed = (state: PlayState, category: PlayCategory, feed: FeedState): PlayState => ({
  ...state,
  feeds: { ...state.feeds, [category]: feed },
});

/** The shelves were read: their counts, and their tabs when the read named any. */
export const shelvesLoaded = (state: PlayState, shelves: PlayShelves): PlayState =>
  shelves.categories.length > 0 ? { ...state, counts: shelves.counts, categories: shelves.categories } : state;

/** The sidebar turned to `shelf`: its dashboard shows, whatever page was up. */
export const shelfChosen = (state: PlayState, shelf: PlayShelf): PlayState =>
  state.shelf === shelf && state.view.page === PlayPage.Shelf ? state : { ...state, shelf, view: SHELF_VIEW };

/** The Friends page shows. */
export const friendsShown = (state: PlayState): PlayState =>
  state.view.page === PlayPage.Friends ? state : { ...state, view: FRIENDS_VIEW };

/** Someone's profile shows; Back returns to the page it was opened from (a game's page too). */
export function profileShown(state: PlayState, userId: string): PlayState {
  const current = state.view;
  if (current.page === PlayPage.Profile && current.userId === userId) return state;
  if (current.page === PlayPage.Game)
    return { ...state, view: { page: PlayPage.Profile, userId, from: PlayPage.Shelf, back: current } };
  const from = current.page === PlayPage.Profile || current.page === PlayPage.Stats ? current.from : current.page;
  const back = current.page === PlayPage.Profile || current.page === PlayPage.Stats ? current.back : undefined;
  return { ...state, view: { page: PlayPage.Profile, userId, from, ...(back ? { back } : {}) } };
}

/** The stats page shows, from the profile on screen; its Back returns to that profile. */
export function statsShown(state: PlayState): PlayState {
  const current = state.view;
  if (current.page !== PlayPage.Profile) return state;
  const { userId, from, back } = current;
  return { ...state, view: { page: PlayPage.Stats, userId, from, ...(back ? { back } : {}) } };
}

/** Back: from the stats page to its profile, from a profile to the page it was opened from. */
export function backFromProfile(state: PlayState): PlayState {
  const current = state.view;
  if (current.page === PlayPage.Stats) {
    const { userId, from, back } = current;
    return { ...state, view: { page: PlayPage.Profile, userId, from, ...(back ? { back } : {}) } };
  }
  if (current.page === PlayPage.Game) return { ...state, view: current.back };
  if (current.page !== PlayPage.Profile) return state;
  if (current.back) return { ...state, view: current.back };
  return { ...state, view: current.from === PlayPage.Friends ? FRIENDS_VIEW : SHELF_VIEW };
}

/** A native game's own page shows; Back returns to the page it was opened from. */
export function gameShown(state: PlayState, slug: string): PlayState {
  const current = state.view;
  if (current.page === PlayPage.Game && current.slug === slug) return state;
  return { ...state, view: { page: PlayPage.Game, slug, back: current } };
}

/** Whether a game Play has read opens its page: a native game with no web build. */
export function opensItsPage(state: PlayState, slug: string): boolean {
  const page = state.games[slug]?.game;
  if (page) return opensPage(page);
  for (const feed of Object.values(state.feeds)) {
    const card = feed?.games.find((game) => game.slug === slug);
    if (card) return opensPage(card);
  }
  return false;
}

/** A game's page is on its way: one already read stays shown while it is read again. */
export function gameRequested(state: PlayState, slug: string): PlayState {
  const entry = state.games[slug];
  if (entry?.game) return state;
  return { ...state, games: { ...state.games, [slug]: { status: FeedStatus.Loading, game: null } } };
}

/** A game's page arrived. */
export const gameLoaded = (state: PlayState, game: PlayGameDetail): PlayState => ({
  ...state,
  games: { ...state.games, [game.slug]: { status: FeedStatus.Ready, game } },
});

/** A game's page could not be read: one read before stays. */
export function gameFailed(state: PlayState, slug: string): PlayState {
  const entry = state.games[slug];
  if (entry?.game) return state;
  return { ...state, games: { ...state.games, [slug]: { status: FeedStatus.Failed, game: null } } };
}

/** Whether `slug`'s native app is being played in its own window (or starting). */
export const beingPlayed = (state: PlayState, slug: string): boolean =>
  state.sessions.some((session) => session.slug === slug && session.phase !== NativeSessionPhase.Failed);

/** Main's word on what is installed and installing here. */
export const installsReported = (state: PlayState, installs: NativeInstalls): PlayState => ({ ...state, installs });

/** Main's word on the games being played. */
export const sessionsReported = (state: PlayState, sessions: NativeSession[]): PlayState => ({ ...state, sessions });

/** A page is on its way: a tab with nothing yet says it is loading; one with games keeps them. */
export function feedRequested(state: PlayState, category: PlayCategory, more: boolean): PlayState {
  const feed = feedOf(state, category);
  if (more) return withFeed(state, category, { ...feed, loadingMore: true, moreFailed: false });
  if (feed.games.length > 0) return state;
  return withFeed(state, category, { ...feed, status: FeedStatus.Loading });
}

/** A page arrived. */
export const feedLoaded = (
  state: PlayState,
  category: PlayCategory,
  page: PlayFeedPage,
  more: boolean,
  at: number,
): PlayState => withFeed(state, category, withPage(feedOf(state, category), page, more, at));

/**
 * A page could not be read: a tab with games keeps them (a further page's failure is said under
 * them), an empty one says it failed.
 */
export function feedFailed(state: PlayState, category: PlayCategory, more: boolean): PlayState {
  const feed = feedOf(state, category);
  if (more) return withFeed(state, category, { ...feed, loadingMore: false, moreFailed: true });
  if (feed.games.length > 0) return withFeed(state, category, { ...feed, loadingMore: false });
  return withFeed(state, category, { ...feed, status: FeedStatus.Failed, loadingMore: false });
}

/** A further page arrived for a list a newer first page has replaced: it lands nowhere. */
const moreDropped = (state: PlayState, category: PlayCategory): PlayState =>
  withFeed(state, category, { ...feedOf(state, category), loadingMore: false });

/** Players were counted for a tab's games. */
export function onlineCounted(state: PlayState, category: PlayCategory, counts: Record<string, number>): PlayState {
  const feed = feedOf(state, category);
  const games = withOnline(feed.games, counts);
  return games === feed.games ? state : withFeed(state, category, { ...feed, games });
}

/**
 * A game was changed from its card's menu: every tab and Recent show `next` in its place, or drop
 * it once it left the catalog (null).
 */
export function gameChanged(state: PlayState, game: Pick<PlayGame, "id" | "slug">, next: PlayGame | null): PlayState {
  const feeds: PlayState["feeds"] = {};
  for (const [category, feed] of Object.entries(state.feeds) as Array<[PlayCategory, FeedState]>) {
    const at = feed.games.findIndex((shown) => shown.id === game.id);
    if (at === -1) {
      feeds[category] = feed;
      continue;
    }
    const games = next ? feed.games.with(at, next) : feed.games.filter((shown) => shown.id !== game.id);
    feeds[category] = { ...feed, games };
  }
  const recent = next
    ? state.recent.map((entry) =>
        entry.slug === game.slug ? { slug: next.slug, title: next.title, coverUrl: next.coverUrl } : entry,
      )
    : state.recent.filter((entry) => entry.slug !== game.slug);
  return { ...state, feeds, recent };
}

/** A game was opened: its cover shows at once, and it leads Recent. */
export function gameOpened(state: PlayState, game: PlayRecentEntry): PlayState {
  return {
    ...state,
    recent: withRecent(state.recent, { slug: game.slug, title: game.title, coverUrl: game.coverUrl }),
    viewer: {
      slug: game.slug,
      title: game.title,
      coverUrl: game.coverUrl,
      phase: PlayViewerPhase.Loading,
      openId: null,
    },
  };
}

/** Whether main's news is the viewer shown closing for its bar's Remix: the app makes the copy then. */
export const remixClosed = (shown: ViewerShown | null, event: PlayViewerEvent): boolean =>
  event.remix === true && shown?.slug === event.slug && shown.openId === event.openId;

/**
 * Main's news about the viewer; the guest card's Sign in waits for the shell. The maker's name
 * closes the viewer onto their profile.
 */
export function viewerReported(state: PlayState, event: PlayViewerEvent): PlayState {
  const viewer = viewerAfter(state.viewer, event);
  const installAsked = state.installAsked || event.install === true;
  const same = viewer === state.viewer && installAsked === state.installAsked;
  if (same) return state;
  const next = { ...state, viewer, installAsked };
  const closed = state.viewer !== null && viewer === null;
  return closed && event.profile ? profileShown(next, event.profile) : next;
}

/** Main never answered the opening shown: its cover says it failed, with Try again. */
export function openRefused(state: PlayState, slug: string): PlayState {
  const shown = state.viewer;
  if (shown?.slug !== slug || shown.openId !== null) return state;
  return { ...state, viewer: { ...shown, phase: PlayViewerPhase.Failed } };
}

/**
 * Back from an opening main never answered: main has no game to close for it, so its cover goes
 * here; any other viewer goes when main says it closed.
 */
export function unansweredClosed(state: PlayState): PlayState {
  return state.viewer?.openId === null ? { ...state, viewer: null } : state;
}

/** A remix was pressed: Create shows it at its first step. A second waits for the first to end. */
export function remixStarted(state: PlayState, game: PlayRecentEntry): PlayState {
  if (state.making) return state;
  const { slug, title, coverUrl } = game;
  const making = { slug, title, coverUrl, step: RemixStep.Copy, done: null, total: null, name: null };
  return { ...state, making: { ...making, view: RemixView.Shown } };
}

/** Main's news of the remix being made: its step and bytes. News of any other, or after the end, changes nothing. */
export function remixProgressed(state: PlayState, progress: RemixProgress): PlayState {
  const making = state.making;
  if (making?.slug !== progress.slug) return state;
  const { step, done, total } = progress;
  const name = progress.name ?? making.name;
  const same = making.step === step && making.done === done && making.total === total && making.name === name;
  return same ? state : { ...state, making: { ...making, step, done, total, name } };
}

/** A card's remix was made: its name waits for the shell. */
const remixAnswered = (state: PlayState, name: string): PlayState => ({ ...state, remixed: name });

/** A remix failed: the shell says so once. */
const remixRefused = (state: PlayState): PlayState => ({ ...state, remixFailed: true });

/** The new game is open in Create: nothing shows the remix being made any more. */
export const remixEnded = (state: PlayState): PlayState => (state.making === null ? state : { ...state, making: null });

/** The shell is opening the remix in Create: the copy being made stays over it, with its name, until it is open. */
export function remixOpened(state: PlayState): PlayState {
  const { remixed: name, making } = state;
  if (name === null) return state;
  return { ...state, remixed: null, making: making && { ...making, name, view: RemixView.Opening } };
}

/** The person went elsewhere while the remix is made: it goes on in its sidebar row. Not once its game is opening. */
export function remixSetAside(state: PlayState): PlayState {
  const making = state.making;
  if (making?.view !== RemixView.Shown) return state;
  return { ...state, making: { ...making, view: RemixView.Aside } };
}

/** The person came back to the remix from its sidebar row. */
export function remixReturnedTo(state: PlayState): PlayState {
  const making = state.making;
  if (making?.view !== RemixView.Aside) return state;
  return { ...state, making: { ...making, view: RemixView.Shown } };
}

/** The shell told a remix's failure; nothing shows it being made any more. */
export const remixFailureTold = (state: PlayState): PlayState =>
  state.remixFailed ? { ...state, remixFailed: false, making: null } : state;

/** The shell ran the guest card's Sign in. */
export const installAnswered = (state: PlayState): PlayState =>
  state.installAsked ? { ...state, installAsked: false } : state;

/** A switcher on the Assets shelf turned: whose assets, or which kind. The same choice changes nothing. */
export function assetViewChosen(state: PlayState, change: Partial<AssetView>): PlayState {
  const view = { ...state.assetView, ...change };
  const same = view.scope === state.assetView.scope && view.kind === state.assetView.kind;
  return same ? state : { ...state, assetView: view };
}

/**
 * A library page is on its way: a further one marks itself coming; a first one keeps the list it
 * reads again, and otherwise starts the new list empty and loading.
 */
export function libraryRequested(state: PlayState, key: LibraryKey, more: boolean): PlayState {
  const feed = state.library;
  if (more) return { ...state, library: { ...feed, loadingMore: true, moreFailed: false } };
  if (sameLibraryKey(feed, key) && feed.assets.length > 0) return state;
  return { ...state, library: { ...EMPTY_LIBRARY, kind: key.kind, query: key.query.trim() } };
}

/** A library page arrived. */
export const libraryLoaded = (
  state: PlayState,
  key: LibraryKey,
  page: LibraryPage,
  more: boolean,
  at: number,
): PlayState => ({ ...state, library: withLibraryPage(state.library, key, page, more, at) });

/**
 * A library page could not be read: a list with assets keeps them (a further page's failure is
 * said under them), an empty one says it failed.
 */
export function libraryFailed(state: PlayState, more: boolean): PlayState {
  const feed = state.library;
  if (more) return { ...state, library: { ...feed, loadingMore: false, moreFailed: true } };
  if (feed.assets.length > 0) return { ...state, library: { ...feed, loadingMore: false } };
  return { ...state, library: { ...feed, status: FeedStatus.Failed, loadingMore: false } };
}

/** The catalog is on its way: what was read stays; nothing read yet says it is loading. */
export const catalogRequested = (state: PlayState): PlayState =>
  state.assetCatalog.items.length > 0 ? state : { ...state, assetCatalog: { ...EMPTY_CATALOG } };

/** The catalog arrived. */
export const catalogLoaded = (state: PlayState, items: GenexCatalogItem[], at: number): PlayState => ({
  ...state,
  assetCatalog: { items, status: FeedStatus.Ready, at },
});

/** The catalog could not be read: what was read stays; nothing read says it failed. */
export const catalogFailed = (state: PlayState): PlayState =>
  state.assetCatalog.items.length > 0
    ? state
    : { ...state, assetCatalog: { ...state.assetCatalog, status: FeedStatus.Failed } };

/** The library read a key asks genex.games for, the page after `cursor` when there is one. */
function libraryQuery(key: LibraryKey, cursor: string | null): LibraryQuery {
  const kind = libraryKind(key.kind);
  const query = key.query.trim();
  return { ...(kind ? { kind } : {}), ...(query ? { query } : {}), ...(cursor ? { before: cursor } : {}) };
}

/** Play's store and the reads and actions it runs. */
export interface PlayStore extends StoreApi<PlayState> {
  /** Read the shelves' counts and which tabs have something in them. */
  loadShelves(): Promise<void>;
  /** Show another shelf. */
  chooseShelf(shelf: PlayShelf): void;
  /** Show the Friends page. */
  showFriends(): void;
  /** Show someone's profile (the account's own too). */
  showProfile(userId: string): void;
  /** Show the account's stats, from its profile. */
  showStats(): void;
  /** Back from the stats page or a profile. */
  back(): void;
  /** Read a tab's first page (when it has none or is stale), or with `more` its next one. */
  loadFeed(category: PlayCategory, options?: { more?: boolean; force?: boolean }): Promise<void>;
  /** Count the players in a tab's multiplayer games. */
  countOnline(category: PlayCategory): Promise<void>;
  /** Open a game in the viewer. */
  open(game: PlayRecentEntry): Promise<void>;
  close(): Promise<void>;
  retry(): Promise<void>;
  /** Copy a card's game into a new game of the person's own; its name or its failure waits for the shell. */
  remix(game: PlayGame): Promise<void>;
  /** Copy the viewer's game as a card's is: the viewer closes at once. */
  remixViewed(): Promise<void>;
  /** Turn the Assets shelf's switchers. */
  chooseAssets(change: Partial<AssetView>): void;
  /** Read the person's library for a kind and search (when it has none or is stale), or with `more` its next page. */
  loadLibrary(key: LibraryKey, options?: { more?: boolean; force?: boolean }): Promise<void>;
  /** Read the whole catalog for the kind switcher (when it has none or is stale). */
  loadAssetCatalog(options?: { force?: boolean }): Promise<void>;
  /**
   * Change a published game from its card's menu; its cards change at once. Throws when
   * genex.games refused it or could not be reached.
   */
  manage(game: PlayGame, change: PlayGameChange): Promise<PlayChangeResult>;
  /** A game's new cover took: its cards show it. */
  coverChanged(game: PlayGame, coverUrl: string): void;
  /** Show a native game's own page, and read it. */
  showGame(slug: string): void;
  /** Read a native game's page (again). */
  loadGame(slug: string): Promise<void>;
  /** Read what is installed and installing here, and the games being played. */
  loadNative(): Promise<void>;
  /** Install a game on this computer; how it goes arrives as main's news. */
  install(slug: string): Promise<void>;
  /** Stop an install, or forget how a failed one ended. */
  cancelInstall(slug: string): Promise<void>;
  /** Remove a game from this computer; its saves stay. */
  uninstall(slug: string): Promise<void>;
  /** Play an installed game in its own window. */
  launch(slug: string): Promise<void>;
  /** Bring a running game forward. */
  showWindow(slug: string): Promise<void>;
  /** Quit a running game, or forget how one failed to start. */
  quitGame(slug: string): Promise<void>;
}

type PlayApi = Pick<
  StudioApi,
  | "playFeed"
  | "playShelves"
  | "playOnline"
  | "playOpen"
  | "playClose"
  | "playRemix"
  | "playManage"
  | "assetLibrary"
  | "playCatalog"
  | "playGame"
  | "playInstalls"
  | "playSessions"
  | "playInstall"
  | "playInstallCancel"
  | "playUninstall"
  | "playLaunch"
  | "playSession"
>;

/** The store's `manage`: send the change, then show it on every card of the game at once. */
function managing(api: PlayApi, shown: (game: PlayGame, next: PlayGame | null) => void): PlayStore["manage"] {
  return async (game, change) => {
    const result = await api.playManage(game.id, change);
    if (result.outcome !== PlayChangeOutcome.Done) return result;
    shown(game, changedGame(game, change, result));
    return result;
  };
}

/** Told a game changed from a card's menu, with its card after (null once it left the catalog). */
export type GameChangeListener = (gameId: string, next: PlayGame | null) => void;

/** A page without the games that left the catalog from a card's menu: a read begun before cannot bring one back. */
const withoutGone = (page: PlayFeedPage, gone: ReadonlySet<string>): PlayFeedPage =>
  gone.size === 0 ? page : { ...page, games: page.games.filter((game) => !gone.has(game.id)) };

/**
 * Show a game's change on every card and in Recent (kept in `storage`), remember one that left the
 * catalog in `gone`, and tell `onGameChanged`.
 */
function showing(
  store: StoreApi<PlayState>,
  storage: KeyValueStorage | null,
  gone: Set<string>,
  onGameChanged: GameChangeListener,
) {
  return (game: PlayGame, next: PlayGame | null): void => {
    if (!next) gone.add(game.id);
    store.setState((state) => gameChanged(state, game, next), true);
    writeRecent(store.getState().recent, storage);
    onGameChanged(game.id, next);
  };
}

/**
 * Play's store over `api`, remembering Recent in `storage`; `onGameChanged` hears every change made
 * from a card's menu, so the cards other stores show (a profile's) change too.
 */
export function createPlayStore(
  api: PlayApi,
  storage: KeyValueStorage | null,
  now: () => number = Date.now,
  onGameChanged: GameChangeListener = () => {},
): PlayStore {
  const store = createStore<PlayState>()(() => initialPlay(readRecent(storage)));
  const set = (change: (state: PlayState) => PlayState) => store.setState(change, true);
  const inFlight = new Map<string, Promise<void>>();
  /** Each tab's first-page reads so far: a further page read before the latest one lands nowhere. */
  const firstReads = new Map<PlayCategory, number>();
  /** The games unpublished or deleted from a card's menu, which no later page shows again. */
  const gone = new Set<string>();

  const loadShelves = async (): Promise<void> => {
    try {
      const shelves = await api.playShelves();
      set((state) => shelvesLoaded(state, shelves));
    } catch {
      // Each shelf's first tab stays; the next visit asks again.
    }
  };

  const read = async (category: PlayCategory, more: boolean): Promise<void> => {
    const cursor = more ? feedOf(store.getState(), category).nextCursor : null;
    if (!more) firstReads.set(category, (firstReads.get(category) ?? 0) + 1);
    const generation = firstReads.get(category) ?? 0;
    // A further page continues the list it was asked for; a first page read since replaced that list.
    const stale = () => more && firstReads.get(category) !== generation;
    set((state) => feedRequested(state, category, more));
    try {
      const page = withoutGone(await api.playFeed({ category, cursor }), gone);
      set((state) => (stale() ? moreDropped(state, category) : feedLoaded(state, category, page, more, now())));
    } catch {
      set((state) => feedFailed(state, category, more));
    }
  };

  const loadFeed = (category: PlayCategory, options: { more?: boolean; force?: boolean } = {}): Promise<void> => {
    const more = options.more === true;
    const feed = feedOf(store.getState(), category);
    if (more && (!feed.nextCursor || feed.loadingMore)) return Promise.resolve();
    const fresh = feed.status === FeedStatus.Ready && now() - feed.at < FEED_STALE_MS;
    if (!more && fresh && !options.force) return Promise.resolve();
    const key = `${category}:${more ? "more" : "first"}`;
    const running = inFlight.get(key);
    if (running) return running;
    const started = read(category, more).finally(() => inFlight.delete(key));
    inFlight.set(key, started);
    return started;
  };

  const countOnline = async (category: PlayCategory): Promise<void> => {
    const slugs = countedSlugs(feedOf(store.getState(), category).games);
    if (slugs.length === 0) return;
    try {
      const counts = await api.playOnline(slugs);
      set((state) => onlineCounted(state, category, counts));
    } catch {
      // The last counts stay.
    }
  };

  const native = nativeActions(api, set);
  const { open, close } = opening(api, store, set, storage, native.showGame);

  /** Make a game a new one of the person's own: shown from the press, its name or its failure kept for the shell. */
  const remix = async (game: PlayRecentEntry): Promise<void> => {
    if (store.getState().making) return;
    set((state) => remixStarted(state, game));
    try {
      const name = await api.playRemix(game.slug);
      set((state) => remixAnswered(state, name));
    } catch {
      set(remixRefused);
    }
  };

  const assets = assetReads(api, store, set, now);
  const shown = showing(store, storage, gone, onGameChanged);
  const manage = managing(api, shown);

  return Object.assign(store, {
    ...assets,
    ...native,
    loadShelves,
    chooseShelf: (shelf: PlayShelf) => set((state) => shelfChosen(state, shelf)),
    showFriends: () => set(friendsShown),
    showProfile: (userId: string) => set((state) => profileShown(state, userId)),
    showStats: () => set(statsShown),
    back: () => set(backFromProfile),
    loadFeed,
    countOnline,
    open,
    close,
    retry: async () => {
      const shown = store.getState().viewer;
      if (shown) await open(shown);
    },
    remix,
    remixViewed: async () => {
      const shown = store.getState().viewer;
      if (!shown || store.getState().making) return;
      const made = remix(shown);
      // The viewer gives way at once: Create shows the copy being made.
      await close().catch(() => {});
      await made;
    },
    manage,
    coverChanged: (game: PlayGame, coverUrl: string) => shown(game, { ...game, coverUrl }),
  });
}

/**
 * Opening a game and closing its viewer. A native game with no web build opens its own page, never
 * a viewer with nothing to play; any other game's cover shows at once and leads Recent.
 */
function opening(
  api: Pick<PlayApi, "playOpen" | "playClose" | "playSession">,
  store: StoreApi<PlayState>,
  set: (change: (state: PlayState) => PlayState) => void,
  storage: KeyValueStorage | null,
  showGame: (slug: string) => void,
) {
  const open = async (game: PlayRecentEntry): Promise<void> => {
    // One copy of a game at a time: its native app being played comes forward instead.
    if (beingPlayed(store.getState(), game.slug)) return api.playSession(game.slug, SessionAction.Show);
    if (game.page || opensItsPage(store.getState(), game.slug)) {
      set((state) => ({ ...state, recent: withRecent(state.recent, { ...game, page: true }) }));
      writeRecent(store.getState().recent, storage);
      return showGame(game.slug);
    }
    set((state) => gameOpened(state, game));
    writeRecent(store.getState().recent, storage);
    try {
      await api.playOpen(game.slug, game.title);
    } catch {
      set((state) => openRefused(state, game.slug));
    }
  };
  const close = async (): Promise<void> => {
    set(unansweredClosed);
    await api.playClose();
  };
  return { open, close };
}

/** The Assets shelf's reads: the person's library page by page, and the whole catalog. */
function assetReads(
  api: Pick<PlayApi, "assetLibrary" | "playCatalog">,
  store: StoreApi<PlayState>,
  set: (change: (state: PlayState) => PlayState) => void,
  now: () => number,
) {
  const inFlight = new Map<string, Promise<void>>();
  /** First reads of the library so far: a further page asked before a newer first read lands nowhere. */
  let libraryReads = 0;
  const once = (key: string, read: () => Promise<void>): Promise<void> => {
    const running = inFlight.get(key);
    if (running) return running;
    const started = read().finally(() => inFlight.delete(key));
    inFlight.set(key, started);
    return started;
  };

  /**
   * One library read. Its answer lands only while the list is still the one it was asked for (a
   * list the person turned away from is not shown under another's switchers), and a further page
   * only while no first read has started since.
   */
  const readLibrary = async (key: LibraryKey, more: boolean): Promise<void> => {
    const cursor = more ? store.getState().library.nextCursor : null;
    const generation = libraryReads;
    const current = (state: PlayState) => sameLibraryKey(state.library, key) && (!more || generation === libraryReads);
    try {
      const page = await api.assetLibrary(libraryQuery(key, cursor));
      set((state) => (current(state) ? libraryLoaded(state, key, page, more, now()) : state));
    } catch {
      set((state) => (current(state) ? libraryFailed(state, more) : state));
    }
  };

  const loadLibrary = (key: LibraryKey, options: { more?: boolean; force?: boolean } = {}): Promise<void> => {
    const more = options.more === true;
    const feed = store.getState().library;
    const same = sameLibraryKey(feed, key);
    if (more && (!same || !feed.nextCursor || feed.loadingMore)) return Promise.resolve();
    const fresh = same && feed.status === FeedStatus.Ready && now() - feed.at < FEED_STALE_MS;
    if (!more && fresh && !options.force) return Promise.resolve();
    if (!more) libraryReads += 1;
    // The list takes the key before a read is joined: coming back to a list whose read is still on
    // its way shows that list again, and its answer lands there.
    set((state) => libraryRequested(state, key, more));
    return once(`library:${key.kind}:${key.query.trim()}:${more}`, () => readLibrary(key, more));
  };

  const loadAssetCatalog = (options: { force?: boolean } = {}): Promise<void> => {
    const catalog = store.getState().assetCatalog;
    const fresh = catalog.status === FeedStatus.Ready && now() - catalog.at < FEED_STALE_MS;
    if (fresh && !options.force) return Promise.resolve();
    return once("catalog", async () => {
      set(catalogRequested);
      try {
        const items = await api.playCatalog();
        set((state) => catalogLoaded(state, items, now()));
      } catch {
        set(catalogFailed);
      }
    });
  };

  const chooseAssets = (change: Partial<AssetView>) => set((state) => assetViewChosen(state, change));
  return { loadLibrary, loadAssetCatalog, chooseAssets };
}

/** A native game's page, its installs and its sessions: reads, and what its buttons ask of main. */
function nativeActions(
  api: Pick<
    PlayApi,
    | "playGame"
    | "playInstalls"
    | "playSessions"
    | "playInstall"
    | "playInstallCancel"
    | "playUninstall"
    | "playLaunch"
    | "playSession"
  >,
  set: (change: (state: PlayState) => PlayState) => void,
) {
  const reading = new Map<string, Promise<void>>();
  const loadGame = (slug: string): Promise<void> => {
    const running = reading.get(slug);
    if (running) return running;
    const read = (async () => {
      set((state) => gameRequested(state, slug));
      try {
        const game = await api.playGame(slug);
        set((state) => gameLoaded(state, game));
      } catch {
        set((state) => gameFailed(state, slug));
      }
    })().finally(() => reading.delete(slug));
    reading.set(slug, read);
    return read;
  };
  const loadNative = async (): Promise<void> => {
    const [installs, sessions] = await Promise.all([api.playInstalls(), api.playSessions()]).catch(() => [null, null]);
    if (installs) set((state) => installsReported(state, installs));
    if (sessions) set((state) => sessionsReported(state, sessions));
  };
  return {
    showGame: (slug: string) => {
      set((state) => gameShown(state, slug));
      void loadGame(slug);
    },
    loadGame,
    loadNative,
    install: (slug: string) => api.playInstall(slug),
    cancelInstall: (slug: string) => api.playInstallCancel(slug),
    uninstall: (slug: string) => api.playUninstall(slug),
    launch: (slug: string) => api.playLaunch(slug),
    showWindow: (slug: string) => api.playSession(slug, SessionAction.Show),
    quitGame: (slug: string) => api.playSession(slug, SessionAction.Quit),
  };
}
