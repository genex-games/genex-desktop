/**
 * Play: the page shown (a shelf, Friends or someone's profile), the shelves' counts and tabs, the
 * pages of genex.games' catalog read so far, Recent, and the game the viewer shows. A tab read once draws at once when it comes back, and is read again behind it once a
 * minute old. Opening a game shows its cover at once and remembers it in Recent; main's
 * `UiEvent.PlayViewer` then says how the viewer goes.
 */
import { createStore, type StoreApi } from "zustand/vanilla";
import { MINUTE_MS } from "../../shared/duration.ts";
import {
  PLAY_SHELF_TABS,
  PLAY_SHELVES,
  type PlayCategory,
  type PlayFeedPage,
  type PlayGame,
  PlayShelf,
  type PlayShelves,
  type PlayViewerEvent,
  PlayViewerPhase,
  type RemixProgress,
  RemixStep,
} from "../../shared/play.ts";
import type { StudioApi } from "../../shared/studio-api.ts";
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

/** Which page Play shows: a shelf's dashboard, the Friends page, someone's profile, or the account's stats. */
export const PlayPage = { Shelf: "shelf", Friends: "friends", Profile: "profile", Stats: "stats" } as const;
export type PlayPage = (typeof PlayPage)[keyof typeof PlayPage];

/** The page a profile was opened from, where its Back goes. */
type ProfileFrom = typeof PlayPage.Shelf | typeof PlayPage.Friends;

/**
 * The page Play shows. A profile remembers the page it was opened from, where Back goes; the stats
 * page remembers the profile it was opened from (the account's own), where its Back goes.
 */
export type PlayView =
  | { page: typeof PlayPage.Shelf }
  | { page: typeof PlayPage.Friends }
  | { page: typeof PlayPage.Profile; userId: string; from: ProfileFrom }
  | { page: typeof PlayPage.Stats; userId: string; from: ProfileFrom };

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
}

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

/** Someone's profile shows; Back returns to the page it was opened from. */
export function profileShown(state: PlayState, userId: string): PlayState {
  const current = state.view;
  if (current.page === PlayPage.Profile && current.userId === userId) return state;
  const from = current.page === PlayPage.Profile || current.page === PlayPage.Stats ? current.from : current.page;
  return { ...state, view: { page: PlayPage.Profile, userId, from } };
}

/** The stats page shows, from the profile on screen; its Back returns to that profile. */
export function statsShown(state: PlayState): PlayState {
  const current = state.view;
  if (current.page !== PlayPage.Profile) return state;
  return { ...state, view: { page: PlayPage.Stats, userId: current.userId, from: current.from } };
}

/** Back: from the stats page to its profile, from a profile to the page it was opened from. */
export function backFromProfile(state: PlayState): PlayState {
  const current = state.view;
  if (current.page === PlayPage.Stats)
    return { ...state, view: { page: PlayPage.Profile, userId: current.userId, from: current.from } };
  if (current.page !== PlayPage.Profile) return state;
  return { ...state, view: current.from === PlayPage.Friends ? FRIENDS_VIEW : SHELF_VIEW };
}

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

/** Main's news about the viewer; the guest card's Sign in waits for the shell. */
export function viewerReported(state: PlayState, event: PlayViewerEvent): PlayState {
  const viewer = viewerAfter(state.viewer, event);
  const installAsked = state.installAsked || event.install === true;
  const same = viewer === state.viewer && installAsked === state.installAsked;
  return same ? state : { ...state, viewer, installAsked };
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
}

type PlayApi = Pick<StudioApi, "playFeed" | "playShelves" | "playOnline" | "playOpen" | "playClose" | "playRemix">;

/** Play's store over `api`, remembering Recent in `storage`. */
export function createPlayStore(
  api: PlayApi,
  storage: KeyValueStorage | null,
  now: () => number = Date.now,
): PlayStore {
  const store = createStore<PlayState>()(() => initialPlay(readRecent(storage)));
  const set = (change: (state: PlayState) => PlayState) => store.setState(change, true);
  const inFlight = new Map<string, Promise<void>>();
  /** Each tab's first-page reads so far: a further page read before the latest one lands nowhere. */
  const firstReads = new Map<PlayCategory, number>();

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
      const page = await api.playFeed({ category, cursor });
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

  const open = async (game: PlayRecentEntry): Promise<void> => {
    set((state) => gameOpened(state, game));
    writeRecent(store.getState().recent, storage);
    try {
      await api.playOpen(game.slug);
    } catch {
      set((state) => openRefused(state, game.slug));
    }
  };

  const close = async (): Promise<void> => {
    set(unansweredClosed);
    await api.playClose();
  };

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

  return Object.assign(store, {
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
  });
}
