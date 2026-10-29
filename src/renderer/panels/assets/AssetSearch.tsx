/**
 * Search on the Assets canvas: the box pinned at its top left, and, while it has words, the matches
 * over the dot grid in up to three groups — this game's own cards, the person's library and the
 * community's shared assets. A library or community asset comes in with Add.
 */
import type { JSX, ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import type { AddSource, GameLibraryStates, LibraryAsset } from "../../../shared/asset-library.ts";
import type { ProjectAsset } from "../../../shared/game-assets.ts";
import { type PlayGame, PlayShelf } from "../../../shared/play.ts";
import { communityMatches, gameMatches, generationsInGame, libraryMatches } from "../../asset-library-view.ts";
import { CARD_IMAGE_H, CARD_W, cardHeight } from "../../assets-layout.ts";
import { useLibrary } from "../../state/hooks.ts";
import { studio } from "../../state/studio.ts";
import { type Notify, notifyProblem, ToastTone } from "../../state/toasts.ts";
import { Icon } from "../../ui/icons.tsx";
import { useMoreBelow } from "../../ui/scroll-fade.ts";
import { ASSET_LIBRARY_WORDS as WORDS } from "../../words.ts";

/** How long typing rests before the library and the community are asked. */
const SEARCH_DEBOUNCE_MS = 200;
/** How many skeleton tiles stand in for a group on its way. */
const SKELETON_TILES = 3;

/** Where a remote group is: on its way, answered, or not shown (signed out, or it failed). */
const GroupStatus = { Loading: "loading", Ready: "ready", Hidden: "hidden" } as const;
type GroupStatus = (typeof GroupStatus)[keyof typeof GroupStatus];

interface RemoteGroup<T> {
  status: GroupStatus;
  items: readonly T[];
}

const HIDDEN = { status: GroupStatus.Hidden, items: [] } as const;
const LOADING = { status: GroupStatus.Loading, items: [] } as const;

/** The box: the search mark, the words, and a quiet Clear while there are any. */
export function AssetSearchField({ query, onQuery }: { query: string; onQuery: (query: string) => void }): JSX.Element {
  return (
    <label className="asset-search no-drag" data-keeps-escape={query ? "" : undefined}>
      <Icon name="search" size={14} />
      <span className="sr-only">{WORDS.searchLabel}</span>
      <input
        type="text"
        value={query}
        placeholder={WORDS.search}
        spellCheck={false}
        data-assets-search
        onChange={(event) => onQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Escape" || !query) return;
          event.preventDefault();
          event.stopPropagation();
          onQuery("");
        }}
      />
      {query && (
        <button
          type="button"
          data-assets-search-clear
          aria-label={WORDS.clearSearch}
          className="asset-underlined asset-underlined-quiet"
          onClick={() => onQuery("")}
        >
          {WORDS.clear}
        </button>
      )}
    </label>
  );
}

/** What one remote search answers, read a moment after typing rests; `enabled` false hides it. */
function useRemote<T>(query: string, enabled: boolean, read: (query: string) => Promise<readonly T[]>): RemoteGroup<T> {
  const [group, setGroup] = useState<RemoteGroup<T>>(HIDDEN);
  const trimmed = query.trim();
  // biome-ignore lint/correctness/useExhaustiveDependencies: `read` is a stable call on the api
  useEffect(() => {
    if (!trimmed || !enabled) {
      setGroup(HIDDEN);
      return;
    }
    let live = true;
    setGroup(LOADING);
    const timer = window.setTimeout(() => {
      read(trimmed).then(
        (items) => live && setGroup({ status: GroupStatus.Ready, items }),
        () => live && setGroup(HIDDEN),
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [trimmed, enabled]);
  return group;
}

const readLibrary = (query: string): Promise<LibraryAsset[]> =>
  studio()
    .api.assetLibrary({ query })
    .then((page) => page.assets);
const readCommunity = (query: string): Promise<PlayGame[]> => studio().api.playSearch(query, PlayShelf.Assets);

/** A group's heading: its name, and its count (or "no matches") quiet after it. */
function GroupHead({ name, count }: { name: string; count: number | null }): JSX.Element {
  return (
    <div className="asset-search-head">
      <span>{name}</span>
      {count !== null && <span className="asset-search-count">{count > 0 ? count : WORDS.noMatches}</span>}
    </div>
  );
}

/** A group: its heading over its tiles, or real-size shimmering stand-ins while it loads. */
function SearchGroup({
  id,
  name,
  status,
  count,
  children,
}: {
  id: string;
  name: string;
  status: GroupStatus;
  count: number;
  children: ReactNode;
}): JSX.Element | null {
  if (status === GroupStatus.Hidden) return null;
  const loading = status === GroupStatus.Loading;
  return (
    <section data-search-group={id} data-search-status={status} className="flex flex-col gap-2.5">
      <GroupHead name={name} count={loading ? null : count} />
      {(loading || count > 0) && (
        <div className="asset-search-tiles">
          {loading
            ? Array.from({ length: SKELETON_TILES }, (_, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: stand-ins have nothing else to key by
                <span
                  key={index}
                  aria-hidden
                  className="asset-skeleton"
                  style={{ width: CARD_W, height: CARD_IMAGE_H }}
                />
              ))
            : children}
        </div>
      )}
    </section>
  );
}

/** A library or community asset: its picture, its name on hover, and Add. */
function AddTile({
  id,
  title,
  picture,
  onAdd,
}: {
  id: string;
  title: string;
  picture: string | null;
  onAdd: () => Promise<void>;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const add = (): void => {
    setBusy(true);
    void onAdd().finally(() => setBusy(false));
  };
  return (
    <div
      data-search-tile={id}
      title={title}
      className="asset-tile asset-search-tile"
      style={{ width: CARD_W, height: CARD_IMAGE_H }}
    >
      {picture ? (
        <img src={picture} alt="" draggable={false} className="h-full w-full object-cover" />
      ) : (
        <span className="absolute inset-0 grid place-items-center px-3 text-center text-micro text-ink-3">{title}</span>
      )}
      <button
        type="button"
        data-search-add={id}
        aria-label={WORDS.addLabel(title)}
        disabled={busy}
        className="asset-add asset-glass"
        onClick={add}
      >
        <Icon name="plus" size={12} strokeWidth={2} />
        {WORDS.add}
      </button>
    </div>
  );
}

export interface SearchResultsProps {
  project: string;
  query: string;
  assets: ProjectAsset[];
  library: GameLibraryStates | null;
  /** This game's card as the canvas draws it, sized. */
  tile: (asset: ProjectAsset) => JSX.Element;
  onNotice: Notify;
}

/** Bring a found asset into the game, say so, and read the game's files again. */
function useAdd(project: string, onNotice: Notify) {
  const title = useLibrary((s) => s.games.find((game) => game.name === project)?.title ?? project);
  return (source: AddSource): Promise<void> =>
    studio()
      .api.assetAdd(project, source)
      .then(() => {
        onNotice(WORDS.added(title), ToastTone.Ok);
        studio().library.refreshAssets(project);
      })
      .catch(notifyProblem(onNotice));
}

/** The matches over the dot grid: This game, My library (signed in), Community. */
export function AssetSearchResults({
  project,
  query,
  assets,
  library,
  tile,
  onNotice,
}: SearchResultsProps): JSX.Element {
  const more = useMoreBelow<HTMLDivElement>();
  const signedIn = library !== null && !library.unread;
  const found = useRemote(query, signedIn, readLibrary);
  const shared = useRemote(query, true, readCommunity);
  const add = useAdd(project, onNotice);
  const own = useMemo(() => gameMatches(assets, query), [assets, query]);
  const mine = useMemo(() => libraryMatches(found.items, generationsInGame(assets, library)), [found, assets, library]);
  const theirs = useMemo(() => communityMatches(shared.items, library), [shared, library]);
  return (
    <div ref={more} data-assets-search-results className="asset-search-results scroll-fade">
      <SearchGroup id="game" name={WORDS.thisGame} status={GroupStatus.Ready} count={own.length}>
        {own.map((asset) => (
          <div key={asset.file} data-search-own={asset.file} style={{ width: CARD_W, height: cardHeight(asset.kind) }}>
            {tile(asset)}
          </div>
        ))}
      </SearchGroup>
      <SearchGroup id="library" name={WORDS.myLibrary} status={found.status} count={mine.length}>
        {mine.map((asset) => (
          <AddTile
            key={asset.id}
            id={asset.id}
            title={asset.title}
            picture={asset.thumbnailUrl}
            onAdd={() => add({ generationId: asset.id })}
          />
        ))}
      </SearchGroup>
      <SearchGroup id="community" name={WORDS.community} status={shared.status} count={theirs.length}>
        {theirs.map((game) => (
          <AddTile
            key={game.slug}
            id={game.slug}
            title={game.title}
            picture={game.coverUrl}
            onAdd={() => add({ slug: game.slug })}
          />
        ))}
      </SearchGroup>
    </div>
  );
}
