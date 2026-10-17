/**
 * What the @ picker offers and in what order: the person's games on this Mac, their own published
 * games, and the genex.games assets, tools and games anyone may take. Pure, so the rules are tested
 * without a window; the genex.games half is read by main (`studio:mentions.catalog`).
 *
 * Only takeable things are offered: a stranger's game or tool only when genex.games marks it
 * remixable, and an absent mark reads as not takeable. The person's own work always qualifies.
 */
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
  thumbnailUrl: string | null;
  playsCount: number;
  remixable: boolean;
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
export const MentionShelf = { Yours: "yours", Assets: "assets", Tools: "tools", Games: "games" } as const;
export type MentionShelf = (typeof MentionShelf)[keyof typeof MentionShelf];

/** How many cards each shelf shows before anything is typed. */
export const SHELF_CAPS: Record<MentionShelf, number> = { yours: 6, assets: 6, tools: 3, games: 3 };
/** How many cards a typed query shows. */
export const MENTION_RESULT_LIMIT = 8;

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
 * Every takeable thing, local games first. A local game whose own published twin has its name's
 * slug stands for that twin (one card, the twin's cover), and handles are made unique in that order.
 */
export function mentionCorpus(local: readonly LocalMentionGame[], catalog: MentionCatalog): MentionDoc[] {
  const taken = new Set<string>();
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
    .filter((item) => !twins.has(item.slug))
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
      }),
    );
  return [...localDocs, ...genexDocs];
}

function isOwn(item: GenexCatalogItem, userId: string | null): boolean {
  return userId !== null && item.authorId === userId;
}

/** The shelf a doc sits on before anything is typed. */
export function shelfOf(doc: MentionDoc): MentionShelf {
  if (doc.own && doc.kind === MentionKind.Game) return MentionShelf.Yours;
  if (doc.kind === MentionKind.Asset) return MentionShelf.Assets;
  if (doc.kind === MentionKind.Tool) return MentionShelf.Tools;
  return MentionShelf.Games;
}

/** The empty picker: each shelf in order with its first cards; local games keep their order. */
export function mentionShelves(docs: readonly MentionDoc[]): { shelf: MentionShelf; docs: MentionDoc[] }[] {
  const order = [MentionShelf.Yours, MentionShelf.Assets, MentionShelf.Tools, MentionShelf.Games];
  return order
    .map((shelf) => {
      const onShelf = docs.filter((doc) => shelfOf(doc) === shelf);
      const sorted = shelf === MentionShelf.Yours ? onShelf : [...onShelf].sort((a, b) => b.plays - a.plays);
      return { shelf, docs: sorted.slice(0, SHELF_CAPS[shelf]) };
    })
    .filter((group) => group.docs.length > 0);
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
