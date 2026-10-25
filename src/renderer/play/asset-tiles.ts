/**
 * Play's Assets shelf as square tiles, pure: the kind and whose switchers' choices, where the tiles
 * come from for each choice (the Assets feed, the whole catalog for one kind, a search, or the
 * person's own library), the tiles themselves and the picture each shows, a library page added to the
 * ones read, and the games Use offers to add an asset to. `PlayAssets.tsx` draws what these decide.
 */
import {
  type AddSource,
  AssetScope,
  type LibraryAsset,
  LibraryKind,
  type LibraryPage,
  libraryFileUrl,
} from "../../shared/asset-library.ts";
import type { GameProject } from "../../shared/game-project.ts";
import type { GenexCatalogItem } from "../../shared/mention-corpus.ts";
import { type PlayGame, PlayShelf } from "../../shared/play.ts";
import { type CardTag, cardTagOf } from "../asset-library-view.ts";
import { FeedStatus } from "./play-model.ts";

/** The kind switcher's choice: every kind, or one. Values are the switcher's `data-play-asset-kind`. */
export const KindChoice = { All: "all", ...LibraryKind } as const;
export type KindChoice = (typeof KindChoice)[keyof typeof KindChoice];

/** The kinds in the switcher's order. */
export const KIND_CHOICES: readonly KindChoice[] = Object.values(KindChoice);

/** The whose switcher's choices in its order. */
export const SCOPE_CHOICES: readonly AssetScope[] = Object.values(AssetScope);

/** What the two switchers have chosen. */
export interface AssetView {
  scope: AssetScope;
  kind: KindChoice;
}

/** The shelf as it opens: everyone's assets of every kind. */
export const ALL_ASSETS: AssetView = { scope: AssetScope.Everyone, kind: KindChoice.All };

/** One asset as a tile draws it, whichever list it came from. */
export interface AssetTile {
  /** Unique in its grid: the slug of a shared asset, the generation id of a library one. */
  key: string;
  title: string;
  /** Who made it; null when nobody is named (the person's own). */
  author: string | null;
  coverUrl: string | null;
  kind: LibraryKind | null;
  /** The file itself, which a sound tile plays; null when the tile does not know it. */
  fileUrl: string | null;
  /** What that file is (a 3D asset may keep a picture); null when nothing says, or no file. */
  fileKind: LibraryKind | null;
  /** That file's format as an extension (`fbx`), which picks the 3D loader; null when nothing says. */
  fileFormat: string | null;
  /** What Add copies into a game. */
  source: AddSource;
  /** The page on Play the cover opens, or null for an asset with none. */
  slug: string | null;
  /** The person's own asset, saved or shared on Play, as the Assets tab's cards tag it. */
  tag: CardTag | null;
}

/** Where a grid's tiles come from. */
export const TileSource = {
  /** The Assets feed, page by page, as today. */
  Feed: "feed",
  /** The whole catalog, read once, for one kind: a kind is never empty because a first page had none. */
  Catalog: "catalog",
  /** What a search on the Assets shelf answers. */
  Search: "search",
  /** The person's own library, page by page. */
  Library: "library",
} as const;
export type TileSource = (typeof TileSource)[keyof typeof TileSource];

/** Where the grid reads its tiles for the switchers' choice and the search typed. */
export function tileSource(view: AssetView, query: string): TileSource {
  if (view.scope === AssetScope.Mine) return TileSource.Library;
  if (query.trim()) return TileSource.Search;
  return view.kind === KindChoice.All ? TileSource.Feed : TileSource.Catalog;
}

/** Whether an asset of `kind` shows under the kind switcher's `choice`. */
export const kindShown = (choice: KindChoice, kind: LibraryKind | null): boolean =>
  choice === KindChoice.All || kind === choice;

/** The kind a library read asks for: none for every kind. */
export const libraryKind = (choice: KindChoice): LibraryKind | undefined =>
  choice === KindChoice.All ? undefined : choice;

/** A shared asset from the feed or a search as a tile. */
export function gameTile(game: PlayGame): AssetTile {
  return {
    key: game.slug,
    title: game.title,
    author: game.author.name || null,
    coverUrl: game.coverUrl,
    kind: game.assetKind,
    fileUrl: null,
    fileKind: null,
    fileFormat: null,
    source: { slug: game.slug },
    slug: game.slug,
    tag: null,
  };
}

/** A catalog asset as a tile. */
export function catalogTile(item: GenexCatalogItem): AssetTile {
  return {
    key: item.slug,
    title: item.title,
    author: item.authorName || null,
    coverUrl: item.thumbnailUrl,
    kind: item.assetKind,
    fileUrl: null,
    fileKind: null,
    fileFormat: null,
    source: { slug: item.slug },
    slug: item.slug,
    tag: null,
  };
}

/** One of the person's own library assets as a tile; its cover opens its page on Play while shared. */
export function libraryTile(asset: LibraryAsset): AssetTile {
  return {
    key: asset.id,
    title: asset.title,
    author: null,
    coverUrl: asset.thumbnailUrl,
    kind: asset.kind,
    fileUrl: asset.fileUrl,
    fileKind: asset.fileKind,
    fileFormat: asset.fileFormat,
    source: { generationId: asset.id },
    slug: asset.shared?.live ? asset.shared.slug : null,
    tag: cardTagOf(asset),
  };
}

/** Where a tile's picture comes from: an image's address, or a preview drawn from a 3D file. */
export const PictureFrom = { Image: "image", Model: "model" } as const;
export type PictureFrom = (typeof PictureFrom)[keyof typeof PictureFrom];

/** What a tile's square shows in place of the kind's glyph: a picture's address, or a 3D file and its format. */
export type TilePicture =
  | { from: typeof PictureFrom.Image; url: string }
  | { from: typeof PictureFrom.Model; url: string; format: string | null };

/**
 * A tile's picture: its cover; else, for a file on genex.games' asset hosts, by what that file is
 * (not the asset's kind): a picture as itself, a 3D file as a preview drawn from it. Null keeps the
 * kind's glyph: a sound, a video, a file nothing names, a tile that knows no file, a file anywhere else.
 */
export function tilePicture(
  tile: Pick<AssetTile, "coverUrl" | "fileUrl" | "fileKind" | "fileFormat">,
): TilePicture | null {
  if (tile.coverUrl) return { from: PictureFrom.Image, url: tile.coverUrl };
  const file = libraryFileUrl(tile.fileUrl);
  if (!file) return null;
  if (tile.fileKind === LibraryKind.Image) return { from: PictureFrom.Image, url: file };
  if (tile.fileKind === LibraryKind.Model) return { from: PictureFrom.Model, url: file, format: tile.fileFormat };
  return null;
}

/** Everyone's assets of one kind from the whole catalog, in its order. */
export const catalogTiles = (items: readonly GenexCatalogItem[], choice: KindChoice): AssetTile[] =>
  items.filter((item) => item.shelf === PlayShelf.Assets && kindShown(choice, item.assetKind)).map(catalogTile);

/** Feed or search cards of the chosen kind as tiles. */
export const gameTiles = (games: readonly PlayGame[], choice: KindChoice): AssetTile[] =>
  games.filter((game) => kindShown(choice, game.assetKind)).map(gameTile);

/** What the library read for: the kind chosen and the words typed. Another key starts a new list. */
export interface LibraryKey {
  kind: KindChoice;
  query: string;
}

/** The person's library as the Mine grid has it. */
export interface LibraryFeed extends LibraryKey {
  assets: LibraryAsset[];
  nextCursor: string | null;
  status: FeedStatus;
  loadingMore: boolean;
  moreFailed: boolean;
  /** When its first page arrived; a list older than a minute is read again behind what it shows. */
  at: number;
}

/** Mine before anything is read. */
export const EMPTY_LIBRARY: LibraryFeed = {
  kind: KindChoice.All,
  query: "",
  assets: [],
  nextCursor: null,
  status: FeedStatus.Loading,
  loadingMore: false,
  moreFailed: false,
  at: 0,
};

/** Whether `feed` is the list read for `key`. */
export const sameLibraryKey = (feed: LibraryKey, key: LibraryKey): boolean =>
  feed.kind === key.kind && feed.query === key.query.trim();

/**
 * The library after a page: a first page replaces the list (and its key), a further one adds the
 * assets it does not have yet.
 */
export function withLibraryPage(
  feed: LibraryFeed,
  key: LibraryKey,
  page: LibraryPage,
  more: boolean,
  at: number,
): LibraryFeed {
  if (!more)
    return {
      ...EMPTY_LIBRARY,
      kind: key.kind,
      query: key.query.trim(),
      assets: [...page.assets],
      nextCursor: page.nextCursor,
      status: FeedStatus.Ready,
      at,
    };
  const seen = new Set(feed.assets.map((asset) => asset.id));
  const added = page.assets.filter((asset) => !seen.has(asset.id));
  return { ...feed, assets: [...feed.assets, ...added], nextCursor: page.nextCursor, loadingMore: false };
}

/** The games Use can add an asset to: the person's, the most recently opened first. */
export function addTargets(games: readonly GameProject[]): GameProject[] {
  const opened = (game: GameProject): string => game.lastOpenedAt ?? game.createdAt ?? "";
  return [...games].sort((a, b) => opened(b).localeCompare(opened(a)));
}

/** How many bars a sound tile's drawing has. */
export const WAVE_BARS = 28;

/**
 * A sound tile's waveform drawing: bar heights between 0.18 and 1, the same for the same title,
 * louder in the middle so it reads as a sound.
 */
export function waveDrawing(seed: string, bars: number = WAVE_BARS): number[] {
  let hash = 2166136261;
  for (const char of seed) hash = Math.imul(hash ^ (char.codePointAt(0) ?? 0), 16777619);
  return Array.from({ length: bars }, (_, index) => {
    hash = Math.imul(hash ^ (hash >>> 13), 1274126177);
    const noise = ((hash >>> 0) % 1000) / 1000;
    const middle = Math.sin((Math.PI * (index + 0.5)) / bars);
    return Math.round((0.18 + 0.82 * middle * (0.45 + 0.55 * noise)) * 100) / 100;
  });
}
