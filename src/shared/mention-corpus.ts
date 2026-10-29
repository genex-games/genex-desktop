/**
 * What the @ picker offers and in what order: the person's games on this Mac, their own published
 * games, the assets in their genex.games library, and the genex.games assets, tools and games anyone
 * may take. Pure, so the rules are tested without a window; the genex.games half is read by main
 * (`studio:mentions.catalog`), the library by `studio:assets.library`.
 *
 * Only takeable things are offered: a stranger's game or tool only when genex.games marks it
 * remixable, and an absent mark reads as not takeable. The person's own work always qualifies.
 */
import { AssetScope, type LibraryAsset, type LibraryKind } from "./asset-library.ts";
import { PlayShelf } from "./play.ts";
import { handleOf, type MentionDoc, MentionKind, MentionOrigin } from "./prompt-mention.ts";

/** One genex.games project as the public search corpus lists it, narrowed to what a tag needs. */
export interface GenexCatalogItem {
  slug: string;
  title: string;
  description: string;
  /** The Play shelf it sits on: games, tools or assets. */
  shelf: PlayShelf;
  authorId: string | null;
  /** Who made it, as Play names them; empty when the catalog does not say. */
  authorName: string;
  thumbnailUrl: string | null;
  playsCount: number;
  remixable: boolean;
  /** An asset's kind; null for a game or a tool. */
  assetKind: LibraryKind | null;
}

/** The genex.games half of the picker: the public catalog, and who is signed in. */
export interface MentionCatalog {
  items: GenexCatalogItem[];
  /** The signed-in person's genex.games id, or null when signed out. */
  userId: string | null;
}

/** One game on this Mac as the picker needs it. */
export interface LocalMentionGame {
  name: string;
  title: string;
  /** A picture for its card when it has no published twin, or null. */
  coverUrl: string | null;
}

/** A shelf of the empty picker. */
export const MentionShelf = {
  Yours: "yours",
  YourAssets: "your-assets",
  Assets: "assets",
  Tools: "tools",
  Games: "games",
} as const;
export type MentionShelf = (typeof MentionShelf)[keyof typeof MentionShelf];

/** How many cards each shelf shows before anything is typed. */
export const SHELF_CAPS: Record<MentionShelf, number> = {
  [MentionShelf.Yours]: 6,
  [MentionShelf.YourAssets]: 6,
  [MentionShelf.Assets]: 6,
  [MentionShelf.Tools]: 3,
  [MentionShelf.Games]: 3,
};
/** How many cards a shelf shows when the picker shows one kind only. */
const NARROW_SHELF_CAP = 12;
/** How many cards a typed query shows. */
export const MENTION_RESULT_LIMIT = 8;
/** The most words a library asset's handle keeps from what it was made from. */
const LIBRARY_HANDLE_WORDS = 4;
/** Small words a library asset's handle never ends on (`@giant-mushroom-tree`, not `…-tree-with`). */
const HANDLE_TAIL_WORDS: ReadonlySet<string> = new Set([
  "a",
  "an",
  "the",
  "of",
  "on",
  "in",
  "with",
  "and",
  "for",
  "to",
]);

/** What the picker's left switcher shows: everything, or one kind. */
export const MentionWhat = { All: "all", Games: "games", Assets: "assets", Tools: "tools" } as const;
export type MentionWhat = (typeof MentionWhat)[keyof typeof MentionWhat];

/** The picker's two switchers: what it shows, and whose (everything you may tag, or only your own). */
export interface MentionFilter {
  what: MentionWhat;
  whose: AssetScope;
}

/** The picker as it first opens: everything you may tag. */
export const MENTION_FILTER_ALL: MentionFilter = { what: MentionWhat.All, whose: AssetScope.Everyone };

/** The one kind each narrowed view keeps; All keeps every kind, plugins too. */
const WHAT_KIND = {
  [MentionWhat.Games]: MentionKind.Game,
  [MentionWhat.Assets]: MentionKind.Asset,
  [MentionWhat.Tools]: MentionKind.Tool,
} as const satisfies Record<Exclude<MentionWhat, typeof MentionWhat.All>, MentionKind>;

/** Ranking multipliers: the short asset and tool shelves and the person's own work come first. */
const KIND_BOOST: Record<MentionKind, number> = { asset: 1.4, tool: 1.4, game: 1, plugin: 1 };
const OWN_BOOST = 1.5;

/** A genex.games project's kind, from its Play shelf. */
const SHELF_KIND: Record<PlayShelf, MentionKind> = {
  [PlayShelf.Games]: MentionKind.Game,
  [PlayShelf.Tools]: MentionKind.Tool,
  [PlayShelf.Assets]: MentionKind.Asset,
};

/** A handle not yet taken: the wanted one, else it with `-2`, `-3`… */
function freeHandle(wanted: string, taken: Set<string>): string {
  let handle = wanted;
  for (let n = 2; taken.has(handle); n += 1) handle = `${wanted}-${n}`;
  taken.add(handle);
  return handle;
}

/**
 * Every takeable thing: local games, then genex.games, then the library. A local game whose own
 * published twin has its name's slug stands for that twin (one card, the twin's cover), a library
 * asset for its own shared page, and handles are made unique in that order.
 */
export function mentionCorpus(
  local: readonly LocalMentionGame[],
  catalog: MentionCatalog,
  library: readonly LibraryAsset[] = [],
): MentionDoc[] {
  const taken = new Set<string>();
  const takeable = library.filter((asset) => asset.fileUrl !== null);
  const sharedPages = new Set(takeable.flatMap((asset) => (asset.shared ? [asset.shared.slug] : [])));
  const ownBySlug = new Map(
    catalog.items.filter((item) => isOwn(item, catalog.userId)).map((item) => [item.slug, item]),
  );
  const twins = new Set<string>();
  const localDocs = local.map((game): MentionDoc => {
    const twin = ownBySlug.get(handleOf(game.name));
    if (twin) twins.add(twin.slug);
    return {
      handle: freeHandle(handleOf(game.name), taken),
      kind: MentionKind.Game,
      origin: MentionOrigin.Local,
      title: game.title || game.name,
      description: twin?.description ?? "",
      coverUrl: twin?.thumbnailUrl ?? game.coverUrl,
      own: true,
      game: game.name,
      plays: twin?.playsCount ?? 0,
    };
  });
  const genexDocs = catalog.items
    .filter((item) => !twins.has(item.slug) && !sharedPages.has(item.slug))
    .filter((item) => item.remixable || isOwn(item, catalog.userId))
    .map(
      (item): MentionDoc => ({
        handle: freeHandle(handleOf(item.slug), taken),
        kind: SHELF_KIND[item.shelf] ?? MentionKind.Game,
        origin: MentionOrigin.Genex,
        title: item.title,
        description: item.description,
        coverUrl: item.thumbnailUrl,
        own: isOwn(item, catalog.userId),
        slug: item.slug,
        plays: item.playsCount,
        ...(item.assetKind ? { assetKind: item.assetKind } : {}),
      }),
    );
  return [...localDocs, ...genexDocs, ...takeable.map((asset) => libraryDoc(asset, taken))];
}

/** A library asset as a card: the person's own, its kind and its marks; main copies its file into the game. */
function libraryDoc(asset: LibraryAsset, taken: Set<string>): MentionDoc {
  return {
    handle: freeHandle(libraryHandle(asset.title), taken),
    kind: MentionKind.Asset,
    origin: MentionOrigin.Library,
    title: asset.title,
    description: "",
    coverUrl: asset.thumbnailUrl,
    own: true,
    generation: asset.id,
    plays: 0,
    assetKind: asset.kind,
    ...(asset.saved ? { saved: true } : {}),
    ...(asset.shared?.live ? { shared: true } : {}),
  };
}

/** A library asset's handle: the first few words of what it was made from, never ending on a small word. */
export function libraryHandle(title: string): string {
  const words = handleOf(title, MentionKind.Asset).split("-").slice(0, LIBRARY_HANDLE_WORDS);
  while (words.length > 1 && HANDLE_TAIL_WORDS.has(words.at(-1) ?? "")) words.pop();
  return words.join("-");
}

function isOwn(item: GenexCatalogItem, userId: string | null): boolean {
  return userId !== null && item.authorId === userId;
}

/** The shelf a doc sits on before anything is typed. */
export function shelfOf(doc: MentionDoc): MentionShelf {
  if (doc.own && doc.kind === MentionKind.Game) return MentionShelf.Yours;
  // Your own assets (your library, your published ones) sit apart, so everyone's still show beside them.
  if (doc.own && doc.kind === MentionKind.Asset) return MentionShelf.YourAssets;
  if (doc.kind === MentionKind.Asset) return MentionShelf.Assets;
  if (doc.kind === MentionKind.Tool) return MentionShelf.Tools;
  return MentionShelf.Games;
}

/** The person's own first, then by plays; a tie keeps the corpus's order (the library's newest first). */
const ownThenPlays = (a: MentionDoc, b: MentionDoc): number => Number(b.own) - Number(a.own) || b.plays - a.plays;

/**
 * The empty picker: each shelf in order with its first cards. Your games keep their order; your
 * published assets come before your library's, and on the other shelves your own work leads.
 */
export function mentionShelves(
  docs: readonly MentionDoc[],
  caps: Record<MentionShelf, number> = SHELF_CAPS,
): { shelf: MentionShelf; docs: MentionDoc[] }[] {
  return Object.values(MentionShelf)
    .map((shelf) => {
      const onShelf = docs.filter((doc) => shelfOf(doc) === shelf);
      const sorted = shelf === MentionShelf.Yours ? onShelf : [...onShelf].sort(ownThenPlays);
      return { shelf, docs: sorted.slice(0, caps[shelf]) };
    })
    .filter((group) => group.docs.length > 0);
}

/** Each shelf's cap for the switchers: one kind alone gets a longer shelf. */
export function shelfCaps(filter: MentionFilter): Record<MentionShelf, number> {
  if (filter.what === MentionWhat.All) return SHELF_CAPS;
  return {
    [MentionShelf.Yours]: NARROW_SHELF_CAP,
    [MentionShelf.YourAssets]: NARROW_SHELF_CAP,
    [MentionShelf.Assets]: NARROW_SHELF_CAP,
    [MentionShelf.Tools]: NARROW_SHELF_CAP,
    [MentionShelf.Games]: NARROW_SHELF_CAP,
  };
}

/**
 * Whether the switchers let a thing through: Mine keeps only the person's own (games, published
 * work, library assets); a kind keeps only that kind, so plugins show under All alone.
 */
export function mentionAdmits(item: Pick<MentionDoc, "kind" | "own">, filter: MentionFilter): boolean {
  if (filter.whose === AssetScope.Mine && !item.own) return false;
  return filter.what === MentionWhat.All || WHAT_KIND[filter.what] === item.kind;
}

/** The docs the switchers let through, in their order. */
export function filterMentions(docs: readonly MentionDoc[], filter: MentionFilter): MentionDoc[] {
  return docs.filter((doc) => mentionAdmits(doc, filter));
}

/** How well one field answers one query word: whole, at a word's start, or anywhere. */
function fieldScore(field: string, word: string, weights: readonly [number, number, number]): number {
  if (!field) return 0;
  if (field === word) return weights[0];
  if (field.startsWith(word) || field.includes(` ${word}`) || field.includes(`-${word}`)) return weights[1];
  return field.includes(word) ? weights[2] : 0;
}

/** A doc's score for a query: every word must match somewhere, titles and handles weigh most. */
function docScore(doc: MentionDoc, words: readonly string[]): number {
  const title = doc.title.toLowerCase();
  const description = doc.description.toLowerCase();
  let total = 0;
  for (const word of words) {
    const score = Math.max(
      fieldScore(title, word, [10, 6, 3]),
      fieldScore(doc.handle, word, [10, 6, 3]),
      fieldScore(description, word, [0, 1.5, 1]),
    );
    if (score === 0) return 0;
    total += score;
  }
  return total * KIND_BOOST[doc.kind] * (doc.own ? OWN_BOOST : 1);
}

/** The best matches for a typed query, highest score first and then by plays. */
export function searchMentions(docs: readonly MentionDoc[], query: string, limit = MENTION_RESULT_LIMIT): MentionDoc[] {
  const words = query
    .toLowerCase()
    .split(/[\s-]+/)
    .filter(Boolean);
  if (words.length === 0) return [];
  return docs
    .map((doc) => ({ doc, score: docScore(doc, words) }))
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score || b.doc.plays - a.doc.plays)
    .slice(0, limit)
    .map((hit) => hit.doc);
}
