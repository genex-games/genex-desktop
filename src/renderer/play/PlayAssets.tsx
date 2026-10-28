/**
 * Play's Assets shelf as square tiles: the kind and whose switchers on the bar, and the grid under
 * them. Everyone shows the shared assets (the Assets feed page by page, the whole catalog for one
 * kind, or what a search answers); Mine shows the person's own genex.games library page by page,
 * each tile tagged Saved or Shared. A tile with no cover shows an image's own file or a picture drawn
 * from its 3D file (`use-tile-picture.ts`). A sound plays on its tile when the tile knows its file,
 * and Use adds an asset to one of the person's games.
 */
import type { JSX, RefObject } from "react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type AssetScope, LibraryKind } from "../../shared/asset-library.ts";
import { GenexAccountStatus } from "../../shared/genex-account.ts";
import type { GameProject } from "../../shared/game-project.ts";
import { gameCoverUrl } from "../../shared/game-cover.ts";
import { PlayCategory, PlayShelf } from "../../shared/play.ts";
import { useLibrary, usePeople, usePlay } from "../state/hooks.ts";
import { feedOf } from "../state/play.ts";
import { studio } from "../state/studio.ts";
import { ToastTone } from "../state/toasts.ts";
import { Button } from "../ui/Button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu.tsx";
import { Icon } from "../ui/icons.tsx";
import { useBackOnline } from "../ui/use-online.ts";
import { ViewSwitcher, type ViewSwitcherItem } from "../ui/view-switcher.tsx";
import { type FeedThings, PLAY_ASSET_WORDS, PLAY_WORDS } from "../words.ts";
import { KIND_GLYPH } from "../asset-library-view.ts";
import { CardTagMark } from "../panels/assets/CardMarks.tsx";
import {
  addTargets,
  type AssetTile,
  catalogTiles,
  gameTiles,
  KIND_CHOICES,
  KindChoice,
  type LibraryKey,
  libraryTile,
  SCOPE_CHOICES,
  sameLibraryKey,
  TileSource,
  tileSource,
} from "./asset-tiles.ts";
import { MoreFailed, MoreMarker, Notice } from "./PlayFeedParts.tsx";
import { OfflineNotice } from "./PlayOffline.tsx";
import type { SearchState } from "./PlayRoom.tsx";
import { SoundFace } from "./PlaySoundTile.tsx";
import { FeedStatus } from "./play-model.ts";
import { useGenexSignIn } from "./use-genex-sign-in.ts";
import { useTilePicture } from "./use-tile-picture.ts";

const WORDS = PLAY_ASSET_WORDS;
/** How many tile shapes stand in for a grid on its way: two rows of five. */
const PLACEHOLDERS = 10;
/** A search of the person's library waits for this pause in typing, as Play's search does. */
const SEARCH_DEBOUNCE_MS = 200;
/** Use's inset from the tile's edges, and on a sound tile its start, past the play button (`play-assets.css`). */
const USE_INSET_PX = 8;
const SOUND_USE_START_PX = 44;

/** What a kind's grid holds, as its messages name it: every kind together is the Assets shelf. */
const thingsOf = (kind: KindChoice): FeedThings => (kind === KindChoice.All ? PlayShelf.Assets : kind);

const KIND_ITEMS: readonly ViewSwitcherItem<KindChoice>[] = KIND_CHOICES.map((key) => ({
  key,
  label: WORDS.kinds[key],
}));
const SCOPE_ITEMS: readonly ViewSwitcherItem<AssetScope>[] = SCOPE_CHOICES.map((key) => ({
  key,
  label: WORDS.scopes[key],
}));

/** Where a tile's picture stands. */
const ImageState = { Loading: "loading", Shown: "shown", Failed: "failed" } as const;
type ImageState = (typeof ImageState)[keyof typeof ImageState];

/** The kind and whose switchers, today's switcher with its blue fill; `onChoose` follows a turn. */
export function AssetSwitchers({ onChoose }: { onChoose: () => void }): JSX.Element {
  const view = usePlay((s) => s.assetView);
  const choose = (change: { kind?: KindChoice; scope?: AssetScope }): void => {
    studio().play.chooseAssets(change);
    onChoose();
  };
  return (
    <div className="play-asset-switchers no-drag">
      <ViewSwitcher
        items={KIND_ITEMS}
        active={view.kind}
        onSelect={(kind) => choose({ kind })}
        label={WORDS.kindsLabel}
        dataAttribute="data-play-asset-kind"
      />
      <ViewSwitcher
        items={SCOPE_ITEMS}
        active={view.scope}
        onSelect={(scope) => choose({ scope })}
        label={WORDS.scopesLabel}
        dataAttribute="data-play-asset-scope"
      />
    </div>
  );
}

/**
 * The picture: fades in once loaded; a missing, broken or still-drawing one leaves the kind's glyph on
 * the tile. An image's own file can be a full-size original, so it loads only as its tile nears the
 * screen.
 */
export function TileImage({ src, kind }: { src: string | null; kind: LibraryKind | null }): JSX.Element {
  const [state, setState] = useState<ImageState>(ImageState.Loading);
  const glyph = (!src || state === ImageState.Failed) && (
    <Icon name={KIND_GLYPH[kind ?? LibraryKind.Model]} size={22} className="play-asset-glyph" />
  );
  return (
    <>
      {glyph}
      {src && state !== ImageState.Failed && (
        <img
          className="play-asset-image"
          src={src}
          alt=""
          draggable={false}
          loading="lazy"
          decoding="async"
          data-shown={state === ImageState.Shown || undefined}
          onLoad={() => setState(ImageState.Shown)}
          onError={() => setState(ImageState.Failed)}
        />
      )}
    </>
  );
}

/** Copy a tile's asset into `game`; a toast says where it went, or that it did not. */
async function addTo(tile: AssetTile, game: GameProject): Promise<void> {
  try {
    await studio().api.assetAdd(game.name, tile.source);
    studio().notify(WORDS.added(game.title), ToastTone.Ok);
  } catch {
    studio().notify(WORDS.addFailed(game.title), ToastTone.Error);
  }
}

/** Use's menu spans the whole tile: Use's own width, and the tile's edges Use leaves free. */
const menuWidth = (kind: LibraryKind | null): string => {
  const start = kind === LibraryKind.Sound ? SOUND_USE_START_PX : USE_INSET_PX;
  return `max(200px, calc(var(--radix-dropdown-menu-trigger-width) + ${start + USE_INSET_PX}px))`;
};

/** Use, at the tile's foot while hovered: a small menu of the person's games to add the asset to. */
function UseMenu({ tile }: { tile: AssetTile }): JSX.Element | null {
  const games = useLibrary((s) => s.games);
  const targets = useMemo(() => addTargets(games), [games]);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  if (targets.length === 0) return null;
  const add = (game: GameProject): void => {
    setBusy(true);
    void addTo(tile, game).finally(() => setBusy(false));
  };
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="default"
          className="play-asset-use"
          aria-label={WORDS.addLabel(tile.title)}
          busy={busy}
          data-play-asset-use={tile.key}
          data-open={open || undefined}
        >
          {!busy && <Icon name="plus" size={12} />}
          {busy ? WORDS.adding : WORDS.use}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={USE_INSET_PX}
        alignOffset={-USE_INSET_PX}
        className="play-asset-menu"
        style={{ minWidth: menuWidth(tile.kind) }}
      >
        <DropdownMenuLabel>{WORDS.addTo}</DropdownMenuLabel>
        {targets.map((game) => (
          <DropdownMenuItem key={game.name} data-play-asset-add={game.name} onSelect={() => add(game)}>
            <img className="play-asset-menu-cover" src={gameCoverUrl(game.cover, game.name)} alt="" />
            <span className="min-w-0 truncate">{game.title}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** One asset: its square cover (a sound's drawing), its tag, Use on hover, its title and who made it. */
const AssetTileView = memo(function AssetTileView({ tile }: { tile: AssetTile }): JSX.Element {
  const { slug } = tile;
  const cover = useRef<HTMLDivElement>(null);
  const picture = useTilePicture(tile, cover);
  const open = slug ? () => void studio().play.open({ slug, title: tile.title, coverUrl: tile.coverUrl }) : undefined;
  return (
    <article className="play-asset" data-play-asset={tile.key} data-kind={tile.kind ?? undefined}>
      <div ref={cover} className="play-asset-cover">
        {open && (
          <button type="button" className="play-asset-open" aria-label={WORDS.open(tile.title)} onClick={open} />
        )}
        {tile.kind === LibraryKind.Sound ? (
          <SoundFace title={tile.title} seed={tile.key} fileUrl={tile.fileUrl} />
        ) : (
          <TileImage src={picture} kind={tile.kind} />
        )}
        {tile.tag && <CardTagMark tag={tile.tag} />}
        <UseMenu tile={tile} />
      </div>
      <div className="play-asset-meta">
        <h3 className="play-asset-title" title={tile.title}>
          {tile.title}
        </h3>
        {tile.author && <p className="play-asset-author">{tile.author}</p>}
      </div>
    </article>
  );
});

/** A tile still on its way: the square and the title's and author's lines, shimmering. */
function AssetTilePlaceholder(): JSX.Element {
  return (
    <div className="play-asset play-asset-placeholder" aria-hidden="true">
      <span className="play-asset-cover" />
      <span className="play-asset-meta">
        <span className="play-bar play-bar-title" />
        <span className="play-bar play-bar-author" />
      </span>
    </div>
  );
}

/** The grid of tiles, with the shapes of the ones still coming. */
function AssetGrid({ tiles, placeholders }: { tiles: readonly AssetTile[]; placeholders: number }): JSX.Element {
  return (
    <div className="play-asset-grid">
      {tiles.map((tile) => (
        <AssetTileView key={tile.key} tile={tile} />
      ))}
      {Array.from({ length: placeholders }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: placeholders are identical and only counted
        <AssetTilePlaceholder key={i} />
      ))}
    </div>
  );
}

/** A grid on its way: real-size tile shapes. */
function Loading({ things }: { things: FeedThings }): JSX.Element {
  return (
    <div role="status" aria-busy="true" aria-label={PLAY_WORDS.loading(things)}>
      <AssetGrid tiles={[]} placeholders={PLACEHOLDERS} />
    </div>
  );
}

/** Under a paged grid: the next page's failure, the marker that reads it, and that it is coming. */
function Paging({
  list,
  things,
  online,
  onMore,
  scroller,
}: {
  list: { nextCursor: string | null; loadingMore: boolean; moreFailed: boolean };
  things: FeedThings;
  online: boolean;
  onMore: () => void;
  scroller: RefObject<HTMLDivElement | null>;
}): JSX.Element {
  return (
    <>
      {list.moreFailed && <MoreFailed things={things} online={online} onRetry={onMore} />}
      {/* Made afresh for each page: a page too short to move the marker out of the look-ahead still reads the next. */}
      {list.nextCursor && <MoreMarker key={list.nextCursor} onNear={onMore} scroller={scroller} />}
      {list.loadingMore && (
        <span className="sr-only" role="status">
          {PLAY_WORDS.loadingMore}
        </span>
      )}
    </>
  );
}

/** A list that could not be read: offline it waits for the network, else Try again. */
function Failed({
  things,
  online,
  onRetry,
}: {
  things: FeedThings;
  online: boolean;
  onRetry: () => void;
}): JSX.Element {
  if (!online) return <OfflineNotice text={PLAY_WORDS.offline.shelf(PlayShelf.Assets)} onRetry={onRetry} />;
  return <Notice text={PLAY_WORDS.failed(things)} onRetry={onRetry} />;
}

/** Everyone, every kind: the Assets feed, page by page as today. */
function FeedTiles({ online, scroller }: { online: boolean; scroller: RefObject<HTMLDivElement | null> }): JSX.Element {
  const feed = usePlay((s) => feedOf(s, PlayCategory.Assets));
  const play = studio().play;
  const more = useCallback(() => void play.loadFeed(PlayCategory.Assets, { more: true }), [play]);
  const tiles = useMemo(() => gameTiles(feed.games, KindChoice.All), [feed.games]);
  const things = thingsOf(KindChoice.All);
  const reload = () => void play.loadFeed(PlayCategory.Assets, { force: true });
  if (feed.status === FeedStatus.Failed) return <Failed things={things} online={online} onRetry={reload} />;
  if (feed.status === FeedStatus.Loading && tiles.length === 0) return <Loading things={things} />;
  if (tiles.length === 0) return <Notice text={PLAY_WORDS.empty(things)} />;
  return (
    <>
      <AssetGrid tiles={tiles} placeholders={feed.loadingMore ? PLACEHOLDERS / 2 : 0} />
      <Paging list={feed} things={things} online={online} onMore={more} scroller={scroller} />
    </>
  );
}

/** Everyone, one kind: the whole catalog's assets of it, read once. */
function CatalogTiles({ kind, online }: { kind: KindChoice; online: boolean }): JSX.Element {
  const catalog = usePlay((s) => s.assetCatalog);
  useEffect(() => void studio().play.loadAssetCatalog(), []);
  const tiles = useMemo(() => catalogTiles(catalog.items, kind), [catalog.items, kind]);
  const things = thingsOf(kind);
  const reload = () => void studio().play.loadAssetCatalog({ force: true });
  if (catalog.status === FeedStatus.Failed) return <Failed things={things} online={online} onRetry={reload} />;
  if (catalog.status === FeedStatus.Loading && catalog.items.length === 0) return <Loading things={things} />;
  if (tiles.length === 0) return <Notice text={PLAY_WORDS.empty(things)} />;
  return <AssetGrid tiles={tiles} placeholders={0} />;
}

/** Everyone, searched: what the Assets shelf's search answers, of the chosen kind. */
function SearchTiles({
  search,
  kind,
  online,
  onRetry,
}: {
  search: SearchState;
  kind: KindChoice;
  online: boolean;
  onRetry: () => void;
}): JSX.Element {
  const tiles = useMemo(() => gameTiles(search.games, kind), [search.games, kind]);
  const things = thingsOf(kind);
  if (search.status === FeedStatus.Failed && !online)
    return <OfflineNotice text={PLAY_WORDS.offline.search} onRetry={onRetry} />;
  if (search.status === FeedStatus.Failed) return <Notice text={PLAY_WORDS.failed(things)} onRetry={onRetry} />;
  if (search.status === FeedStatus.Ready && tiles.length === 0)
    return <Notice text={PLAY_WORDS.noMatches(search.query, things)} />;
  const waiting = search.status === FeedStatus.Loading && tiles.length === 0;
  return (
    <div aria-busy={search.status === FeedStatus.Loading}>
      <AssetGrid tiles={tiles} placeholders={waiting ? PLACEHOLDERS : 0} />
    </div>
  );
}

/** Mine while signed out: one line, and Sign in as the plate signs in. */
function SignInNotice(): JSX.Element {
  const { busy, signIn } = useGenexSignIn();
  return (
    <div className="play-notice play-asset-sign-in" role="status" data-play-assets-sign-in>
      <p>{WORDS.signedOut}</p>
      <Button variant="secondary" disabled={busy} onClick={signIn}>
        {WORDS.signIn}
      </Button>
    </div>
  );
}

/** `value` once it has stayed the same for `ms`. */
function useSettled(value: string, ms: number): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), ms);
    return () => window.clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/** What Mine says with nothing to show: no match for the words typed, or nothing of the kind yet. */
const mineEmpty = (key: LibraryKey): string => {
  if (key.query) return PLAY_WORDS.noMatches(key.query, thingsOf(key.kind));
  return key.kind === KindChoice.All ? WORDS.mineEmpty : PLAY_WORDS.empty(thingsOf(key.kind));
};

/** Mine: the person's own library, newest first, page by page; signed out it asks to sign in. */
function MineTiles({
  kind,
  query,
  online,
  scroller,
}: {
  kind: KindChoice;
  query: string;
  online: boolean;
  scroller: RefObject<HTMLDivElement | null>;
}): JSX.Element {
  const account = usePeople((s) => s.account);
  const typed = useSettled(query.trim(), SEARCH_DEBOUNCE_MS);
  const key = useMemo(() => ({ kind, query: typed }), [kind, typed]);
  const signedIn = account === GenexAccountStatus.SignedIn;
  const feed = usePlay((s) => s.library);
  const play = studio().play;
  useEffect(() => {
    if (signedIn) void play.loadLibrary(key);
  }, [play, key, signedIn]);
  const more = useCallback(() => void play.loadLibrary(key, { more: true }), [play, key]);
  const tiles = useMemo(() => feed.assets.map(libraryTile), [feed.assets]);
  const things = thingsOf(kind);
  if (account !== null && !signedIn) return <SignInNotice />;
  const shown = sameLibraryKey(feed, key);
  if (shown && feed.status === FeedStatus.Failed)
    return <Failed things={things} online={online} onRetry={() => void play.loadLibrary(key, { force: true })} />;
  if (!shown || (feed.status === FeedStatus.Loading && tiles.length === 0)) return <Loading things={things} />;
  if (tiles.length === 0) return <Notice text={mineEmpty(key)} />;
  return (
    <>
      <AssetGrid tiles={tiles} placeholders={feed.loadingMore ? PLACEHOLDERS / 2 : 0} />
      <Paging list={feed} things={things} online={online} onMore={more} scroller={scroller} />
    </>
  );
}

/** Once the Mac is online again: the catalog or the library that could not be read. */
function useAssetsWhenBack(): void {
  useBackOnline(() => {
    const play = studio().play;
    const { assetCatalog, library } = play.getState();
    if (assetCatalog.status === FeedStatus.Failed) void play.loadAssetCatalog({ force: true });
    const key = { kind: library.kind, query: library.query };
    if (library.status === FeedStatus.Failed) void play.loadLibrary(key, { force: true });
    if (library.moreFailed) void play.loadLibrary(key, { more: true });
  });
}

/** The Assets shelf's grid for the switchers' choice and the search typed. */
export function AssetsBody({
  query,
  search,
  online,
  onRetrySearch,
  scroller,
}: {
  query: string;
  search: SearchState | null;
  online: boolean;
  onRetrySearch: () => void;
  scroller: RefObject<HTMLDivElement | null>;
}): JSX.Element {
  const view = usePlay((s) => s.assetView);
  useAssetsWhenBack();
  switch (tileSource(view, query)) {
    case TileSource.Library:
      return <MineTiles kind={view.kind} query={query} online={online} scroller={scroller} />;
    case TileSource.Search:
      if (!search) return <Loading things={thingsOf(view.kind)} />;
      return <SearchTiles search={search} kind={view.kind} online={online} onRetry={onRetrySearch} />;
    case TileSource.Catalog:
      return <CatalogTiles kind={view.kind} online={online} />;
    default:
      return <FeedTiles online={online} scroller={scroller} />;
  }
}
