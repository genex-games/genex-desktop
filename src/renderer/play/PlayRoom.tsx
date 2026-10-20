/**
 * Play's dashboard: genex.games' published games, tools and assets inside the app. The sidebar picks
 * the shelf; its tabs (the Assets shelf's switchers, `PlayAssets.tsx`) and search ride a bar over the
 * grid that steps away while the cards scroll on down and comes back as soon as they scroll up. The grid reads its next page before it runs out, and
 * the players in multiplayer games are counted again while the page is in front. A tab read before
 * draws at once; one on its way draws its cards' shapes; one that failed says so with Try again.
 * Offline, the bar says so, what cannot load says it comes back by itself, and it does once the Mac
 * is online again.
 */
import { opensPage } from "./native-model.ts";
import type { JSX, KeyboardEvent, RefObject, UIEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { AssetScope } from "../../shared/asset-library.ts";
import { SECOND_MS } from "../../shared/duration.ts";
import { PlayCategory, type PlayGame, PlayShelf } from "../../shared/play.ts";
import { SIDEBAR_TOGGLE } from "../shell/use-shell-chrome.ts";
import { feedOf } from "../state/play.ts";
import { usePlay, useShallow } from "../state/hooks.ts";
import { studio } from "../state/studio.ts";
import { Icon } from "../ui/icons.tsx";
import { withViewTransition } from "../ui/view-transition.ts";
import { PLAY_WORDS } from "../words.ts";
import { useBackOnline, useOnline } from "../ui/use-online.ts";
import { gridColumns, setClipsCovered, topRowClip } from "./clip-playback.ts";
import { ClipsToggle } from "./CoverClip.tsx";
import { AssetSwitchers, AssetsBody } from "./PlayAssets.tsx";
import { PlayCard, PlayCardPlaceholder } from "./PlayCard.tsx";
import { MoreFailed, MoreMarker, Notice } from "./PlayFeedParts.tsx";
import { OfflineChip, OfflineNotice } from "./PlayOffline.tsx";
import { BAR_AT_TOP, barAfterScroll, FeedStatus, shelfTabs } from "./play-model.ts";
import { TopCreators } from "./TopCreators.tsx";

const WORDS = PLAY_WORDS;
/** How often the players in the shown multiplayer games are counted again. */
const ONLINE_POLL_MS = 20 * SECOND_MS;
/** A search waits for this pause in typing. */
const SEARCH_DEBOUNCE_MS = 200;
/** How many card shapes stand in for a tab on its way. */
const PLACEHOLDERS = 8;

/** The tabs on the header's line; arrow keys, Home and End move between them. */
function CategoryTabs({
  categories,
  active,
  onSelect,
}: {
  categories: readonly PlayCategory[];
  /** The tab shown; none while a search is. */
  active: PlayCategory | null;
  onSelect: (category: PlayCategory) => void;
}): JSX.Element {
  const focusable = active ?? categories[0];
  const keys = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    const last = categories.length - 1;
    const moves: Record<string, number> = { ArrowLeft: index - 1, ArrowRight: index + 1, Home: 0, End: last };
    const next = moves[event.key];
    if (next === undefined) return;
    event.preventDefault();
    const target = categories[Math.max(0, Math.min(last, next))];
    if (!target) return;
    onSelect(target);
    event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`[data-play-category="${target}"]`)?.focus();
  };
  return (
    <div role="tablist" aria-label={WORDS.categoriesLabel} className="play-tabs">
      {categories.map((category, index) => (
        <button
          key={category}
          type="button"
          role="tab"
          aria-selected={category === active}
          tabIndex={category === focusable ? 0 : -1}
          data-play-category={category}
          className="play-tab"
          onClick={() => onSelect(category)}
          onKeyDown={(event) => keys(event, index)}
        >
          {WORDS.categories[category]}
        </button>
      ))}
    </div>
  );
}

function SearchField({
  query,
  noun,
  onQuery,
}: {
  query: string;
  /** What the shelf holds, as the placeholder names it. */
  noun: string;
  onQuery: (query: string) => void;
}): JSX.Element {
  return (
    <label className="play-search no-drag">
      <Icon name="search" size={14} />
      <span className="sr-only">{WORDS.searchLabel}</span>
      <input
        type="search"
        value={query}
        placeholder={WORDS.search(noun)}
        spellCheck={false}
        data-play-search
        onChange={(event) => onQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && query) {
            event.preventDefault();
            onQuery("");
          }
        }}
      />
    </label>
  );
}

/** A search's answer: the games, or that it is on its way or failed. */
export interface SearchState {
  query: string;
  games: PlayGame[];
  status: FeedStatus;
}

/** What on `shelf` answers `query`, read a moment after typing stops, and a way to read it again. */
function useSearch(query: string, shelf: PlayShelf): { search: SearchState | null; retry: () => void } {
  const [state, setState] = useState<SearchState | null>(null);
  const [attempt, setAttempt] = useState(0);
  const trimmed = query.trim();
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new attempt reads the same search again
  useEffect(() => {
    if (!trimmed) {
      setState(null);
      return;
    }
    let live = true;
    setState((current) => ({ query: trimmed, games: current?.games ?? [], status: FeedStatus.Loading }));
    const timer = window.setTimeout(() => {
      studio()
        .api.playSearch(trimmed, shelf)
        .then(
          (games) => live && setState({ query: trimmed, games, status: FeedStatus.Ready }),
          () => live && setState({ query: trimmed, games: [], status: FeedStatus.Failed }),
        );
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [trimmed, shelf, attempt]);
  const retry = useCallback(() => setAttempt((count) => count + 1), []);
  return { search: state, retry };
}

/** Count the players in the tab's multiplayer games now and again while the dashboard is what is seen. */
function useOnlineCounts(category: PlayCategory, ready: boolean): void {
  useEffect(() => {
    if (!ready) return;
    const play = studio().play;
    const count = () => {
      // Not while the window is hidden or a game is being played over the dashboard.
      if (document.visibilityState === "visible" && play.getState().viewer === null) void play.countOnline(category);
    };
    count();
    const timer = window.setInterval(count, ONLINE_POLL_MS);
    document.addEventListener("visibilitychange", count);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", count);
    };
  }, [category, ready]);
}

/** Remix from a card: Create shows the copy being made in main, and opens it (`usePlayRemixes`). */
export function useCardRemix(): (game: PlayGame) => void {
  // One change on screen: the card's Play turns into Create's remix (`usePlayRemixes`).
  return useCallback((game: PlayGame) => withViewTransition(() => void studio().play.remix(game)), []);
}

/** How many columns the grid lays out, measured again as it resizes; null until measured or when off. */
function useGridColumns(grid: RefObject<HTMLDivElement | null>, on: boolean): number | null {
  const [columns, setColumns] = useState<number | null>(null);
  useEffect(() => {
    const element = grid.current;
    if (!on || !element) return;
    const measure = () => setColumns(gridColumns(getComputedStyle(element).gridTemplateColumns));
    // The observer's first call measures once the grid is laid out, never forcing a layout mid-commit.
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [grid, on]);
  return on ? columns : null;
}

/** The grid of cards, with the shapes of the ones still coming. */
export function Grid({
  games,
  placeholders,
  onRemix,
  showAuthor = true,
  marquee = false,
  autoplayTopRow = false,
}: {
  games: readonly PlayGame[];
  placeholders: number;
  onRemix: (game: PlayGame) => void;
  /** Whether cards say who made them. */
  showAuthor?: boolean;
  /** Titles too long for their card scroll back and forth (a profile's cards). */
  marquee?: boolean;
  /** The measured first row plays its clips by itself (the dashboard's Games feed only). */
  autoplayTopRow?: boolean;
}): JSX.Element {
  const play = useCallback((game: PlayGame) => {
    const entry = { slug: game.slug, title: game.title, coverUrl: game.coverUrl };
    // A native game with no web build opens its own page.
    void studio().play.open(opensPage(game) ? { ...entry, page: true } : entry);
  }, []);
  const grid = useRef<HTMLDivElement>(null);
  const columns = useGridColumns(grid, autoplayTopRow);
  const topRow = (game: PlayGame, index: number): boolean =>
    topRowClip({ autoplayTopRow, measured: columns !== null, columns: columns ?? 0, index, hasClip: !!game.clipUrl });
  return (
    <div ref={grid} className="play-grid">
      {games.map((game, index) => (
        <PlayCard
          key={game.id}
          game={game}
          onPlay={play}
          onRemix={onRemix}
          showAuthor={showAuthor}
          marquee={marquee}
          autoplay={topRow(game, index)}
          index={index}
        />
      ))}
      {Array.from({ length: placeholders }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: placeholders are identical and only counted
        <PlayCardPlaceholder key={i} />
      ))}
    </div>
  );
}

/** One tab's games. */
function FeedBody({
  category,
  shelf,
  online,
  onRemix,
  scroller,
}: {
  category: PlayCategory;
  shelf: PlayShelf;
  online: boolean;
  onRemix: (game: PlayGame) => void;
  scroller: RefObject<HTMLDivElement | null>;
}): JSX.Element {
  const feed = usePlay((s) => feedOf(s, category));
  const play = studio().play;
  const noun = WORDS.nouns[shelf];
  const more = useCallback(() => void play.loadFeed(category, { more: true }), [play, category]);
  const reload = () => void play.loadFeed(category, { force: true });
  useOnlineCounts(category, feed.status === FeedStatus.Ready);
  if (feed.status === FeedStatus.Failed && !online)
    return <OfflineNotice text={WORDS.offline.shelf(WORDS.shelves[shelf])} onRetry={reload} />;
  if (feed.status === FeedStatus.Failed) return <Notice text={WORDS.failed(noun)} onRetry={reload} />;
  if (feed.status === FeedStatus.Loading && feed.games.length === 0)
    return (
      <div role="status" aria-busy="true" aria-label={WORDS.loading(noun)}>
        <Grid games={[]} placeholders={PLACEHOLDERS} onRemix={onRemix} />
      </div>
    );
  if (feed.games.length === 0) return <Notice text={WORDS.empty(noun)} />;
  return (
    <>
      <Grid
        games={feed.games}
        placeholders={feed.loadingMore ? PLACEHOLDERS / 2 : 0}
        onRemix={onRemix}
        autoplayTopRow={shelf === PlayShelf.Games}
      />
      {feed.moreFailed && <MoreFailed noun={noun} online={online} onRetry={more} />}
      {/* Made afresh for each page: a page too short to move the marker out of the look-ahead still reads the next. */}
      {feed.nextCursor && <MoreMarker key={feed.nextCursor} onNear={more} scroller={scroller} />}
      {feed.loadingMore && (
        <span className="sr-only" role="status">
          {WORDS.loadingMore}
        </span>
      )}
    </>
  );
}

/** A search's games. */
function SearchBody({
  search,
  noun,
  online,
  onRetry,
  onRemix,
}: {
  search: SearchState;
  noun: string;
  online: boolean;
  onRetry: () => void;
  onRemix: (game: PlayGame) => void;
}): JSX.Element {
  if (search.status === FeedStatus.Failed && !online)
    return <OfflineNotice text={WORDS.offline.search} onRetry={onRetry} />;
  if (search.status === FeedStatus.Failed) return <Notice text={WORDS.failed(noun)} onRetry={onRetry} />;
  if (search.status === FeedStatus.Ready && search.games.length === 0)
    return <Notice text={WORDS.noMatches(search.query, noun)} />;
  const waiting = search.status === FeedStatus.Loading && search.games.length === 0;
  return (
    <div aria-busy={search.status === FeedStatus.Loading}>
      <Grid games={search.games} placeholders={waiting ? PLACEHOLDERS : 0} onRemix={onRemix} />
    </div>
  );
}

/** The shown shelf's grid: the Assets shelf's tiles, a search's cards, or the tab's. */
function ShelfBody({
  shelf,
  category,
  query,
  search,
  online,
  onRetrySearch,
  onRemix,
  scroller,
}: {
  shelf: PlayShelf;
  category: PlayCategory;
  query: string;
  search: SearchState | null;
  online: boolean;
  onRetrySearch: () => void;
  onRemix: (game: PlayGame) => void;
  scroller: RefObject<HTMLDivElement | null>;
}): JSX.Element {
  if (shelf === PlayShelf.Assets)
    return (
      <AssetsBody query={query} search={search} online={online} onRetrySearch={onRetrySearch} scroller={scroller} />
    );
  const noun = WORDS.nouns[shelf];
  if (search)
    return <SearchBody search={search} noun={noun} online={online} onRetry={onRetrySearch} onRemix={onRemix} />;
  return <FeedBody category={category} shelf={shelf} online={online} onRemix={onRemix} scroller={scroller} />;
}

/**
 * The bar over the cards as they scroll: whether they are under it (its controls then wear a
 * backing) and whether it has stepped away; both start over when `reset` changes. What stands
 * above the bar (`lead`, Top creators) scrolls away first: the bar counts from where it sticks.
 */
function useBarScroll(reset: unknown) {
  const bar = useRef<HTMLElement>(null);
  const lead = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState(BAR_AT_TOP);
  const [scrolled, setScrolled] = useState(false);
  const [resetFor, setResetFor] = useState(reset);
  if (resetFor !== reset) {
    setResetFor(reset);
    setScroll(BAR_AT_TOP);
    setScrolled(false);
  }
  const onScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    const top = Math.max(0, event.currentTarget.scrollTop - (lead.current?.offsetHeight ?? 0));
    setScrolled(top > 0);
    setScroll((before) => barAfterScroll(before, top, bar.current?.offsetHeight ?? 0));
  }, []);
  return { bar, lead, scrolled, hidden: scroll.hidden, onScroll };
}

/**
 * Top creators at the head of Games, over the tabs and search; they stay while a search is typed
 * so the field does not jump, and the box is empty while there are none. `inset` clears the
 * window's buttons when the sidebar is hidden.
 */
function CreatorsLead({ lead, inset }: { lead: RefObject<HTMLDivElement | null>; inset: boolean }): JSX.Element {
  return (
    <div ref={lead} className={`play-top titlebar-drag ${inset ? "play-toolbar-inset" : ""}`}>
      <TopCreators />
    </div>
  );
}

/** Once the Mac is online again: the shelves' counts, and the shown tab's page that could not be read. */
function useReloadsWhenBack(shown: PlayCategory, search: SearchState | null, retrySearch: () => void): void {
  useBackOnline(() => {
    const play = studio().play;
    void play.loadShelves();
    const feed = feedOf(play.getState(), shown);
    if (feed.status === FeedStatus.Failed) void play.loadFeed(shown, { force: true });
    if (feed.moreFailed) void play.loadFeed(shown, { more: true });
    if (search?.status === FeedStatus.Failed) retrySearch();
  });
}

/** What a search on `shelf` asks Play's catalog: nothing on Mine, which searches the person's own library. */
const catalogQuery = (shelf: PlayShelf, scope: AssetScope, query: string): string =>
  shelf === PlayShelf.Assets && scope === AssetScope.Mine ? "" : query;

/** Play's dashboard, in place of the workspace while Play is up. */
export function PlayRoom({
  sidebarHidden,
  onToggleSidebar,
}: {
  sidebarHidden: boolean;
  onToggleSidebar: () => void;
}): JSX.Element {
  const shelf = usePlay((s) => s.shelf);
  const categories = usePlay(useShallow((s) => s.categories));
  // The tab last chosen on each shelf: turning back to a shelf shows it again.
  const [chosen, setChosen] = useState<Partial<Record<PlayShelf, PlayCategory>>>({});
  const [query, setQuery] = useState("");
  // A search belongs to the shelf it was typed on: another shelf starts without one.
  const [searchedShelf, setSearchedShelf] = useState(shelf);
  if (searchedShelf !== shelf) {
    setSearchedShelf(shelf);
    setQuery("");
  }
  const scope = usePlay((s) => s.assetView.scope);
  const { search, retry } = useSearch(catalogQuery(shelf, scope, query), shelf);
  const remix = useCardRemix();
  const { bar, lead, scrolled, hidden, onScroll } = useBarScroll(shelf);
  const online = useOnline();
  const scroll = useRef<HTMLDivElement>(null);
  const tabs = shelfTabs(categories, shelf);
  const picked = chosen[shelf];
  const shown = picked && tabs.includes(picked) ? picked : (tabs[0] ?? PlayCategory.Featured);
  const noun = WORDS.nouns[shelf];
  useEffect(() => {
    void studio().play.loadShelves();
    // The cards of native games show what is installed and installing on this computer.
    void studio().play.loadNative();
  }, []);
  useEffect(() => {
    void studio().play.loadFeed(shown);
  }, [shown]);
  useReloadsWhenBack(shown, search, retry);
  // The viewer over the dashboard holds its clips: nobody sees them play.
  const covered = usePlay((s) => s.viewer !== null);
  useEffect(() => setClipsCovered(covered), [covered]);
  const choose = (next: PlayCategory): void => {
    setChosen((current) => ({ ...current, [shelf]: next }));
    setQuery("");
    scroll.current?.scrollTo({ top: 0 });
  };
  const toTop = (): void => scroll.current?.scrollTo({ top: 0 });
  return (
    <section data-play-page aria-label={WORDS.page} className="play-page">
      {/* Keyed by shelf: another shelf starts at the top. The cards scroll under the bar. */}
      <div ref={scroll} key={shelf} className="play-scroll" onScroll={onScroll}>
        {shelf === PlayShelf.Games && <CreatorsLead lead={lead} inset={sidebarHidden} />}
        <header
          ref={bar}
          className={`play-toolbar titlebar-drag window-controls-end ${sidebarHidden ? "play-toolbar-inset" : ""}`}
          data-scrolled={scrolled ? true : undefined}
          data-hidden={hidden ? true : undefined}
        >
          {sidebarHidden && (
            <button
              type="button"
              className="no-drag sidebar-toggle"
              aria-label={SIDEBAR_TOGGLE.Show}
              aria-controls="studio-sidebar"
              aria-expanded="false"
              onClick={onToggleSidebar}
            >
              <Icon name="sidebar" />
            </button>
          )}
          {shelf === PlayShelf.Assets && <AssetSwitchers onChoose={toTop} />}
          {tabs.length > 1 && <CategoryTabs categories={tabs} active={search ? null : shown} onSelect={choose} />}
          <ClipsToggle />
          {!online && <OfflineChip />}
          <SearchField query={query} noun={noun} onQuery={setQuery} />
        </header>
        <div className="play-content">
          <ShelfBody
            shelf={shelf}
            category={shown}
            query={query}
            search={search}
            online={online}
            onRetrySearch={retry}
            onRemix={remix}
            scroller={scroll}
          />
        </div>
      </div>
      {/* The cards fade out under the bar once they scroll, and at the foot of the page. */}
      <span
        className="play-fade play-fade-top"
        aria-hidden="true"
        data-shown={scrolled ? true : undefined}
        data-bar-away={hidden ? true : undefined}
      />
      <span className="play-fade play-fade-bottom" aria-hidden="true" />
    </section>
  );
}
