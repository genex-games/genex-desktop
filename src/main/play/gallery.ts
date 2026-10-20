/**
 * Play's reads and writes against the genex.games API. Main makes every call: the API answers
 * only its own origins, never the renderer's file page. Reads are anonymous; a like, an identity
 * ticket and an invite code ride the Genex account's token when one is unlocked. Electron-free:
 * the request (the network, or a fixture's answers) and the token come in as deps.
 */
import { LibraryKind } from "../../shared/asset-library.ts";
import { MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";
import {
  isPlayCategory,
  isPlayShelf,
  isPlaySlug,
  PLAY_CATEGORIES,
  PLAY_SHELF_TABS,
  PLAY_SHELVES,
  PlayCategory,
  type PlayFeedPage,
  type PlayFeedRequest,
  type PlayGame,
  type PlayGameDetail,
  PlayShelf,
  type PlayShelves,
  shelfOf,
} from "../../shared/play.ts";
import {
  FIXTURE_BUILD_HOSTS,
  NATIVE_BUILD_HOSTS,
  type NativeHost,
  nativeOf,
  playableHere,
} from "../../shared/play-native.ts";
import { AvatarStyle, isAccountId } from "../../shared/play-people.ts";
import { isPlayMobileSupport, type PlayCuration, PlayMobileSupport } from "../../shared/play-manage.ts";
import type { GenexCatalogItem } from "../../shared/mention-corpus.ts";

/** One page of a tab: what the website loads at a time. */
export const FEED_PAGE_SIZE = 24;
/** The most slugs one online read may name (the API's own cap). */
export const ONLINE_MAX_SLUGS = 48;
/** The online counts' cache bucket, which the API needs to see past stale edge caches. */
const ONLINE_BUCKET_MS = 5 * SECOND_MS;
/** How long the tabs' counts, and the catalog search reads, are trusted before they are read again. */
const COUNTS_TTL_MS = 5 * MINUTE_MS;
/** The most games one search answers with. */
export const SEARCH_MAX_RESULTS = 48;
/** The longest search the app sends through. */
const QUERY_MAX = 80;
/** A tab's first page is kept this long, so switching back to it draws at once. */
const FIRST_PAGE_TTL_MS = MINUTE_MS;
/** HTTP statuses Play reads. A game page that answered without a game reads as a bad gateway. */
const HTTP_OK = 200;
export const HTTP_UNAUTHORIZED = 401;
const BAD_GATEWAY = 502;
/** The longest cursor the gallery hands out (an id), with room to spare; ids and codes are held to it too. */
const CURSOR_MAX = 64;
/** How much of a gallery item's text a card keeps; a game's own page keeps more of its description. */
const TEXT_MAX = { title: 200, author: 120, description: 400, about: 4000 } as const;
/** The most screenshots a game's page shows. */
const SHOTS_MAX = 4;
/** The most online reads one count makes: the shown games beyond them wait for the next count. */
const ONLINE_MAX_READS = 4;
/** How long one network call may take. */
const REQUEST_TIMEOUT_MS = 15 * SECOND_MS;
/** The most categories a card keeps, and the longest one: genex.games' own are short words. */
const CATEGORIES_MAX = 16;
const CATEGORY_MAX_LENGTH = 40;

/** Hosts a cover or an avatar may load from; `renderer/index.html`'s `img-src` lists the same. */
const IMAGE_HOSTS = new Set([
  "cdn.genex.technology",
  "assets.genex.games",
  "assets.genex.technology",
  "api.genex.games",
  "lh3.googleusercontent.com",
  "avatars.githubusercontent.com",
]);

/** The one host a cover clip plays from, and its folder; `renderer/index.html`'s `media-src` lists the host. */
const CLIP_HOST = "cdn.genex.technology";
const CLIP_FOLDER = "/covers/";
const CLIP_EXTENSION = ".mp4";

/** The routes Play calls. */
export const PlayRoute = {
  Feed: "/api/gallery",
  Counts: "/api/gallery/counts",
  Corpus: "/api/gallery/search-corpus",
  Online: "/api/gallery/online",
  Ticket: "/api/embed/ticket",
  Referral: "/api/referrals/me",
  world: (slug: string) => `/api/gallery/world/${encodeURIComponent(slug)}`,
  like: (id: string) => `/api/projects/${encodeURIComponent(id)}/like`,
  assetManifest: (slug: string) => `/api/projects/asset-manifest/${encodeURIComponent(slug)}`,
} as const;

const MESSAGE = {
  BadCategory: "Unknown Play category",
  BadSlug: "Not a game address",
  SignIn: "Connect Genex to do this",
} as const;

/** An answer from the API: its status and its parsed JSON body (null when it had none). */
export interface GalleryAnswer {
  status: number;
  body: unknown;
}

/** One API call: the route with its query, the method, a JSON body and the token to send. */
export type GalleryRequest = (
  route: string,
  init: { method?: "GET" | "PUT" | "DELETE" | "POST" | "PATCH"; body?: unknown; token?: string },
) => Promise<GalleryAnswer>;

/** What the gallery needs: a way to call the API, the account token and the time. */
export interface GalleryDeps {
  request: GalleryRequest;
  /** The unlocked Genex account's token, or undefined while there is none. */
  token(): Promise<string | undefined>;
  now(): number;
  /** A fixture launch: its drawn covers are let through, and its builds' made-up host. */
  localImages?: boolean;
  /**
   * This computer, when the app knows it: a game it cannot play at all (no web build, no build for
   * it) is left out of the tabs and search. Absent, every game is listed.
   */
  host?: NativeHost;
}

/** A failed call that keeps its status, so a sign-in problem reads apart from an outage. */
export class GalleryError extends Error {
  readonly status: number;
  constructor(route: string, status: number) {
    super(`Genex ${route.split("?")[0]}: HTTP ${status}`);
    this.status = status;
  }
}

/** The thrown answer when a write needs the Genex account and none is unlocked. */
export class SignInNeeded extends Error {
  constructor() {
    super(MESSAGE.SignIn);
  }
}

/** How the sign-in ticket for a game went. Main's own words: never sent anywhere. */
export const TicketStatus = {
  /** The account signs the player in: the ticket rides the game's address. */
  Minted: "minted",
  /** No Genex account is unlocked: the player is a guest, and the viewer offers the Genex plugin. */
  SignedOut: "signed-out",
  /** An account is there but no ticket came (refused, rejected token, offline): a guest this once. */
  NotMinted: "not-minted",
} as const;
export type TicketStatus = (typeof TicketStatus)[keyof typeof TicketStatus];

/** A ticket, or why there is none. */
export type PlayTicket =
  | { status: typeof TicketStatus.Minted; ticket: string }
  | { status: typeof TicketStatus.SignedOut | typeof TicketStatus.NotMinted };

/** The ticket a game's address carries, or undefined to play as a guest. */
export const mintedTicket = (result: PlayTicket): string | undefined =>
  result.status === TicketStatus.Minted ? result.ticket : undefined;

const NOT_MINTED: PlayTicket = { status: TicketStatus.NotMinted };

/** A game's page facts the viewer's menu needs: its id for likes, the likes and whether it may be remixed. */
export interface PlayWorld {
  id: string;
  slug: string;
  title: string;
  multiplayer: boolean;
  likes: number;
  liked: boolean;
  remixable: boolean;
  /** The public git address a remix clones, when the game may be remixed. */
  cloneUrl: string | null;
  /** Who made it, as the header names them, and their account. */
  author: string;
  authorId: string | null;
  plays: number;
  /** Players in it now; null for a single-player game or an unknown count. */
  online: number | null;
  /** How many comments it has. */
  comments: number;
  /** Its cover, as its card shows it; null when it has none Play may load. */
  coverUrl: string | null;
}

/** Whether a value is a plain object, as the API's JSON objects are. */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
/** A string field cut to `max`, or "" for anything else. */
export const text = (value: unknown, max: number = TEXT_MAX.description): string =>
  typeof value === "string" ? value.slice(0, max) : "";
const count = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;

/** A drawn image a fixture launch serves in place of a cover. */
const LOCAL_IMAGE = "data:image/svg+xml;";

/** An https image on a host the app loads images from (or, `local`, a drawn SVG), else null. */
export function imageUrl(value: unknown, local: boolean): string | null {
  if (typeof value !== "string") return null;
  if (local && value.startsWith(LOCAL_IMAGE)) return value;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && IMAGE_HOSTS.has(url.hostname) ? url.href : null;
  } catch {
    return null;
  }
}

/** A cover clip: an https MP4 in Genex's cover folder on its CDN, nothing else, else null. */
export function clipUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    const plain = url.protocol === "https:" && !url.username && !url.password && !url.port;
    const ours = url.hostname === CLIP_HOST && url.pathname.startsWith(CLIP_FOLDER);
    return plain && ours && url.pathname.endsWith(CLIP_EXTENSION) ? url.href : null;
  } catch {
    return null;
  }
}

/** The gallery's public git address for a game, when it is one the app will clone. */
function cloneUrlOf(item: Record<string, unknown>): string | null {
  const value = item.cloneUrl;
  if (typeof value !== "string" || item.private === true || item.purchaseUrl) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "git.genex.games" && url.pathname.endsWith(".git")
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/** A gallery item's categories as strings, each short, at most {@link CATEGORIES_MAX}. */
function categoriesOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const words = value.filter(
    (category): category is string => typeof category === "string" && category.length <= CATEGORY_MAX_LENGTH,
  );
  return words.slice(0, CATEGORIES_MAX);
}

/** What the card menu reads from a gallery item: its mobile flags, tags and whether remixing is off. */
function curationOf(item: Record<string, unknown>): PlayCuration {
  return {
    mobileSupport: isPlayMobileSupport(item.mobileSupport) ? item.mobileSupport : null,
    // The crash reports only ever decide "desktop only"; anything else is no decision.
    mobileAuto: item.mobileAutoStatus === PlayMobileSupport.DesktopOnly ? PlayMobileSupport.DesktopOnly : null,
    categories: categoriesOf(item.categories),
    remixOff: item.private === true,
  };
}

/** The hosts a build may download from: genex.games' build CDN, or a fixture launch's made-up one. */
export const buildHostsFor = (local: boolean): ReadonlySet<string> =>
  local ? FIXTURE_BUILD_HOSTS : NATIVE_BUILD_HOSTS;

/**
 * One gallery item as the dashboard shows it, or null when it lacks what a card needs. `local`
 * (fixture launches only) also lets drawn SVG covers through. Its native builds are kept only from
 * `hosts`, and only an item that names builds gets a native side.
 */
export function toPlayGame(item: unknown, local = false, hosts = buildHostsFor(local)): PlayGame | null {
  if (!isRecord(item)) return null;
  const id = text(item.id, CURSOR_MAX);
  const title = text(item.title, TEXT_MAX.title).trim();
  if (!id || !title || !isPlaySlug(item.slug)) return null;
  const author = isRecord(item.author) ? item.author : {};
  const online = typeof item.online === "number" && Number.isFinite(item.online) ? count(item.online) : null;
  const coverUrl = imageUrl(item.thumbnailUrl, local);
  const native = nativeOf(item, hosts);
  return {
    id,
    slug: item.slug,
    title,
    description: text(item.description).trim(),
    coverUrl,
    // A clip plays over its still, never in place of it.
    clipUrl: coverUrl ? clipUrl(item.coverClipUrl) : null,
    multiplayer: item.multiplayer === true,
    plays: count(item.playsCount),
    online: item.multiplayer === true ? online : null,
    author: {
      id: isAccountId(author.id) ? author.id : null,
      name: text(author.name, TEXT_MAX.author).trim(),
      // A photo only when they chose one; everyone else gets their generated avatar.
      imageUrl: author.avatarStyle === AvatarStyle.Photo ? imageUrl(author.image, local) : null,
    },
    remixable: cloneUrlOf(item) !== null,
    assetKind: assetKindOf(item.assetKind),
    curation: curationOf(item),
    ...(native ? { native } : {}),
  };
}

/** genex.games' asset kinds by the library kind they show as (a character is a 3D model). */
const ASSET_KIND: Readonly<Record<string, LibraryKind>> = {
  "3d": LibraryKind.Model,
  character: LibraryKind.Model,
  image: LibraryKind.Image,
  sound: LibraryKind.Sound,
  video: LibraryKind.Video,
};

/** A gallery item's asset kind, or null for a game, a tool or a kind the app doesn't know. */
export const assetKindOf = (value: unknown): LibraryKind | null =>
  typeof value === "string" && Object.hasOwn(ASSET_KIND, value) ? (ASSET_KIND[value] ?? null) : null;

/**
 * The shelf a gallery item sits on, as the website buckets it: Assets, then Tools, when its
 * categories say so, else Games. A category such as physics spans the shelves, so a tab keeps only
 * its own shelf's items.
 */
export function itemShelf(item: unknown): PlayShelf {
  const categories = isRecord(item) && Array.isArray(item.categories) ? item.categories.map(String) : [];
  if (categories.includes(PlayShelf.Assets)) return PlayShelf.Assets;
  return categories.includes(PlayShelf.Tools) ? PlayShelf.Tools : PlayShelf.Games;
}

/** Whether `game` plays on `host` at all; every game does while the computer is not known. */
const playsOn = (game: PlayGame, host: NativeHost | undefined): boolean => !host || playableHere(game, host);

/**
 * A page of the gallery: its valid items (on `shelf` alone when one is named), each once, and the
 * next cursor. Given `host`, a game it cannot play at all is left out.
 */
export function toFeedPage(body: unknown, local = false, shelf?: PlayShelf, host?: NativeHost): PlayFeedPage {
  const items = isRecord(body) && Array.isArray(body.items) ? body.items : [];
  const seen = new Set<string>();
  const games: PlayGame[] = [];
  for (const item of items) {
    if (shelf && itemShelf(item) !== shelf) continue;
    const game = toPlayGame(item, local);
    if (!game || seen.has(game.id)) continue;
    if (!playsOn(game, host)) continue;
    seen.add(game.id);
    games.push(game);
  }
  const next = isRecord(body) ? body.nextCursor : null;
  return { games, nextCursor: typeof next === "string" && next ? next.slice(0, CURSOR_MAX) : null };
}

/**
 * One search-catalog item as a card, or null. The catalog is slimmer than a page: its author is a
 * name, and it says outright whether a stranger may remix the game. That is not whether its owner
 * turned remixing off (a game for sale is not remixable either), and it names no mobile flag, so a
 * search's card carries no curation and offers no menu.
 */
export function toSearchGame(item: unknown, local = false): PlayGame | null {
  if (!isRecord(item)) return null;
  const game = toPlayGame(
    { ...item, author: { name: item.author }, private: item.remixable !== true, online: null },
    local,
  );
  if (!game) return null;
  const { curation: _unread, ...card } = game;
  return card;
}

/** A search-catalog item with the shelf it sits on. */
interface CorpusEntry {
  shelf: PlayShelf;
  game: PlayGame;
}

/** Lowercase, accents folded: how a search and what it searches are compared. */
const folded = (value: string): string =>
  value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase();

/** What a matching word is worth, by where it matched. */
const SEARCH_WEIGHT = { TitleStart: 6, Title: 4, Author: 2, Description: 1 } as const;

/** What one search word is worth against a game's folded fields: 0 when it matches none. */
function wordScore(word: string, fields: { title: string; author: string; description: string }): number {
  if (fields.title.startsWith(word)) return SEARCH_WEIGHT.TitleStart;
  if (fields.title.includes(word)) return SEARCH_WEIGHT.Title;
  if (fields.author.includes(word)) return SEARCH_WEIGHT.Author;
  return fields.description.includes(word) ? SEARCH_WEIGHT.Description : 0;
}

/** How well `game` answers every word of a search: 0 when one word matches nothing. */
export function searchScore(game: PlayGame, words: readonly string[]): number {
  const fields = { title: folded(game.title), author: folded(game.author.name), description: folded(game.description) };
  let score = 0;
  for (const word of words) {
    const hit = wordScore(word, fields);
    if (hit === 0) return 0;
    score += hit;
  }
  return score;
}

/** Each shelf's first tab: what a shelf shows whatever the counts say. */
const FIRST_TABS: ReadonlySet<PlayCategory> = new Set(PLAY_SHELVES.map((shelf) => PLAY_SHELF_TABS[shelf][0]));

/**
 * The shelves' counts and the tabs worth showing: each shelf's first tab always, every other one
 * the gallery has something in.
 */
export function visibleShelves(body: unknown): PlayShelves {
  const values = isRecord(body) && isRecord(body.values) ? body.values : {};
  const buckets = isRecord(body) && isRecord(body.buckets) ? body.buckets : {};
  const sized = (shelf: PlayShelf): number | null =>
    typeof buckets[shelf] === "number" ? count(buckets[shelf]) : null;
  return {
    counts: {
      [PlayShelf.Games]: sized(PlayShelf.Games),
      [PlayShelf.Tools]: sized(PlayShelf.Tools),
      [PlayShelf.Assets]: sized(PlayShelf.Assets),
    },
    categories: PLAY_CATEGORIES.filter((category) => FIRST_TABS.has(category) || count(values[category]) > 0),
  };
}

/** A cursor as the gallery hands them out: an id, nothing else. Comment ids are held to it too. */
export const isCursor = (value: unknown): value is string =>
  typeof value === "string" && value.length <= CURSOR_MAX && /^[A-Za-z0-9_-]+$/.test(value);

/** A GET that throws {@link GalleryError} for any answer but a 2xx. */
export async function readRoute(request: GalleryRequest, route: string, auth?: string): Promise<unknown> {
  const answer = await request(route, { method: "GET", ...(auth ? { token: auth } : {}) });
  if (answer.status < 200 || answer.status >= 300) throw new GalleryError(route, answer.status);
  return answer.body;
}

/**
 * The whole search catalog, every shelf, read at most every few minutes (once, however many searches
 * wait on it); `forget` drops it, and a read under way then keeps nothing of what it read.
 */
function corpusReads(deps: GalleryDeps) {
  const { request, now } = deps;
  const local = deps.localImages === true;
  let corpus: { at: number; entries: CorpusEntry[] } | null = null;
  let corpusRead: Promise<CorpusEntry[]> | null = null;
  let generation = 0;

  const catalog = (): Promise<CorpusEntry[]> => {
    if (corpus && now() - corpus.at < COUNTS_TTL_MS) return Promise.resolve(corpus.entries);
    if (corpusRead) return corpusRead;
    const started = generation;
    const read = readRoute(request, PlayRoute.Corpus)
      .then((body) => {
        const items = isRecord(body) && Array.isArray(body.items) ? body.items : [];
        const entries = items.flatMap((item) => {
          const game = toSearchGame(item, local);
          return game ? [{ shelf: itemShelf(item), game }] : [];
        });
        if (started === generation) corpus = { at: now(), entries };
        return entries;
      })
      .finally(() => {
        if (corpusRead === read) corpusRead = null;
      });
    corpusRead = read;
    return read;
  };

  const forget = (): void => {
    generation++;
    corpus = null;
    corpusRead = null;
  };

  return { catalog, forget };
}

/** The catalog's anonymous reads: tabs, their pages and search, each kept a while. */
function catalogReads(deps: GalleryDeps) {
  const { request, now } = deps;
  const local = deps.localImages === true;
  let counts: { at: number; shelves: PlayShelves } | null = null;
  const firstPages = new Map<PlayCategory, { at: number; page: PlayFeedPage }>();
  const corpus = corpusReads(deps);
  const { catalog } = corpus;
  /** Bumped by `forget`: a read that started before it keeps nothing of what it read. */
  let generation = 0;

  /** One page of a tab. A tab's first page is answered from a minute-old copy when there is one. */
  const feed = async ({ category, cursor }: PlayFeedRequest): Promise<PlayFeedPage> => {
    if (!isPlayCategory(category)) throw new Error(MESSAGE.BadCategory);
    const first = !cursor;
    const kept = first ? firstPages.get(category) : undefined;
    if (kept && now() - kept.at < FIRST_PAGE_TTL_MS) return kept.page;
    const query = new URLSearchParams({ limit: String(FEED_PAGE_SIZE) });
    if (category !== PlayCategory.Featured) query.set("category", category);
    if (isCursor(cursor)) query.set("cursor", cursor);
    const started = generation;
    const body = await readRoute(request, `${PlayRoute.Feed}?${query}`);
    const page = toFeedPage(body, local, shelfOf(category), deps.host);
    if (first && started === generation) firstPages.set(category, { at: now(), page });
    return page;
  };

  /** The shelves' counts and tabs. A failed read throws, so the dashboard keeps the ones it has (offline too). */
  const shelves = async (): Promise<PlayShelves> => {
    if (counts && now() - counts.at < COUNTS_TTL_MS) return counts.shelves;
    const started = generation;
    const shelves = visibleShelves(await readRoute(request, PlayRoute.Counts));
    if (started === generation) counts = { at: now(), shelves };
    return shelves;
  };

  /** Drop the kept first pages, counts and search catalog: a change to a game shows on the next read. */
  const forget = (): void => {
    generation++;
    counts = null;
    firstPages.clear();
    corpus.forget();
  };

  /** What on `shelf` (Games unless it names another) answers every word of `query`, best first (more plays break a tie). */
  const search = async (query: string, shelf?: PlayShelf): Promise<PlayGame[]> => {
    const words = folded(String(query).slice(0, QUERY_MAX)).split(/\s+/).filter(Boolean);
    if (words.length === 0) return [];
    const searched = isPlayShelf(shelf) ? shelf : PlayShelf.Games;
    const scored = (await catalog())
      .filter((entry) => entry.shelf === searched && playsOn(entry.game, deps.host))
      .map(({ game }) => ({ game, score: searchScore(game, words) }))
      .filter((hit) => hit.score > 0);
    scored.sort((a, b) => b.score - a.score || b.game.plays - a.game.plays);
    return scored.slice(0, SEARCH_MAX_RESULTS).map((hit) => hit.game);
  };

  /** The whole catalog as the composer's @ picker reads it: who made each, and whether anyone may take it. */
  const mentionItems = async (): Promise<GenexCatalogItem[]> =>
    (await catalog()).map(({ shelf, game }) => ({
      slug: game.slug,
      title: game.title,
      description: game.description,
      shelf,
      authorId: game.author.id,
      authorName: game.author.name,
      thumbnailUrl: game.coverUrl,
      playsCount: game.plays,
      remixable: game.remixable,
      assetKind: game.assetKind,
    }));

  /** An asset's manifest, which carries its whole module: a public read for a published asset. */
  const assetManifest = (slug: string): Promise<unknown> => {
    if (!isPlaySlug(slug)) throw new Error(MESSAGE.BadSlug);
    return readRoute(request, PlayRoute.assetManifest(slug));
  };

  /** Players in up to {@link ONLINE_MAX_SLUGS} games, in one read. */
  const onlineRead = async (slugs: readonly string[]): Promise<Array<[string, number]>> => {
    const query = new URLSearchParams({ slugs: slugs.join(","), t: String(Math.floor(now() / ONLINE_BUCKET_MS)) });
    const body = await readRoute(request, `${PlayRoute.Online}?${query}`);
    const counted = isRecord(body) && isRecord(body.online) ? body.online : {};
    return slugs.filter((slug) => typeof counted[slug] === "number").map((slug) => [slug, count(counted[slug])]);
  };

  /** Players in each named game now, read in groups the API takes; a game it does not count is left out. */
  const online = async (slugs: readonly unknown[]): Promise<Record<string, number>> => {
    const wanted = [...new Set(slugs.filter(isPlaySlug))].slice(0, ONLINE_MAX_SLUGS * ONLINE_MAX_READS);
    const groups: string[][] = [];
    for (let at = 0; at < wanted.length; at += ONLINE_MAX_SLUGS) groups.push(wanted.slice(at, at + ONLINE_MAX_SLUGS));
    const read = await Promise.all(groups.map(onlineRead));
    return Object.fromEntries(read.flat());
  };

  return { feed, shelves, search, mentionItems, assetManifest, online, forget };
}

/** When a game last changed: the API's own date, else its newest build's, else null. */
function updatedAtOf(item: Record<string, unknown>, game: PlayGame): string | null {
  const at = typeof item.updatedAt === "string" ? Date.parse(item.updatedAt) : Number.NaN;
  if (Number.isFinite(at)) return new Date(at).toISOString();
  const published = game.native?.builds.map((build) => build.publishedAt).sort() ?? [];
  return published.at(-1) ?? null;
}

/** What the signed-in account adds: a game's likes, a like, a sign-in ticket and an invite code. */
function accountCalls(deps: GalleryDeps) {
  const { request, token } = deps;
  const local = deps.localImages === true;
  let invite: { token: string; code: string } | null = null;

  /** A game's page item and its card, read with the account's token so the API says whether it likes it. */
  const worldItem = async (slug: string): Promise<{ item: Record<string, unknown>; game: PlayGame }> => {
    if (!isPlaySlug(slug)) throw new Error(MESSAGE.BadSlug);
    const body = await readRoute(request, PlayRoute.world(slug), await token());
    const item = isRecord(body) && isRecord(body.item) ? body.item : {};
    const game = toPlayGame(item, local);
    if (!game) throw new GalleryError(PlayRoute.world(slug), BAD_GATEWAY);
    return { item, game };
  };

  /** The game's page facts, with whether this account likes it when one is signed in. */
  const world = async (slug: string): Promise<PlayWorld> => {
    const { item, game } = await worldItem(slug);
    const { id, title, multiplayer, remixable, plays, online } = game;
    return {
      id,
      slug,
      title,
      multiplayer,
      likes: count(item.likesCount),
      liked: item.likedByMe === true,
      remixable,
      cloneUrl: cloneUrlOf(item),
      author: game.author.name,
      authorId: game.author.id,
      plays,
      online,
      comments: count(item.commentsCount),
      coverUrl: game.coverUrl,
    };
  };

  /** A game's own page: its card, likes and comments, its whole description, screenshots and when it changed. */
  const game = async (slug: string): Promise<PlayGameDetail> => {
    const { item, game: card } = await worldItem(slug);
    const shots = Array.isArray(item.shots) ? item.shots.map((shot) => imageUrl(shot, local)) : [];
    return {
      ...card,
      description: text(item.description, TEXT_MAX.about).trim(),
      likes: count(item.likesCount),
      liked: item.likedByMe === true,
      comments: count(item.commentsCount),
      shots: shots.filter((shot): shot is string => shot !== null).slice(0, SHOTS_MAX),
      updatedAt: updatedAtOf(item, card),
    };
  };

  /** Like or unlike a game as the signed-in account. */
  const setLiked = async (id: string, liked: boolean): Promise<{ liked: boolean; likes: number }> => {
    const auth = await token();
    if (!auth) throw new SignInNeeded();
    const route = PlayRoute.like(id);
    const answer = await request(route, { method: liked ? "PUT" : "DELETE", token: auth });
    if (answer.status === HTTP_UNAUTHORIZED) throw new SignInNeeded();
    if (answer.status < 200 || answer.status >= 300) throw new GalleryError(route, answer.status);
    const body = isRecord(answer.body) ? answer.body : {};
    return { liked: body.liked === true, likes: count(body.likesCount) };
  };

  /**
   * A single-use ticket that signs the player in when the game's page loads with it in its address
   * fragment; else whether that is for want of an account (signed out) or because none could be
   * minted for the one there. Either way the game plays as a guest.
   */
  const ticket = async (slug: string): Promise<PlayTicket> => {
    if (!isPlaySlug(slug)) return NOT_MINTED;
    const auth = await token();
    if (!auth) return { status: TicketStatus.SignedOut };
    try {
      const body = { slug, delivery: "redirect", channel: "production" };
      const answer = await request(PlayRoute.Ticket, { method: "POST", token: auth, body });
      const minted = isRecord(answer.body) ? answer.body.ticket : undefined;
      if (answer.status !== HTTP_OK || typeof minted !== "string" || !minted) return NOT_MINTED;
      return { status: TicketStatus.Minted, ticket: minted };
    } catch {
      return NOT_MINTED;
    }
  };

  /** The signed-in account's referral code, read once per account; undefined signed out or on failure. */
  const inviteCode = async (): Promise<string | undefined> => {
    const auth = await token();
    if (!auth) return undefined;
    if (invite?.token === auth) return invite.code;
    try {
      const body = await readRoute(request, PlayRoute.Referral, auth);
      const code = isRecord(body) ? text(body.code, CURSOR_MAX) : "";
      if (!/^[A-Za-z0-9_-]+$/.test(code)) return undefined;
      invite = { token: auth, code };
      return code;
    } catch {
      return undefined;
    }
  };

  return { world, game, setLiked, ticket, inviteCode };
}

/** Play's gallery over `deps`. */
export function playGallery(deps: GalleryDeps) {
  return { ...catalogReads(deps), ...accountCalls(deps) };
}

/** Play's gallery as `playGallery` makes it. */
export type PlayGallery = ReturnType<typeof playGallery>;

/**
 * The network request: JSON in and out, the token as a Bearer header, a bounded wait. A refusal's
 * body comes back too (a write says why it was refused there); one that is not JSON reads as none.
 */
export function networkRequest(
  fetchImpl: typeof fetch,
  origin: string,
  timeoutMs = REQUEST_TIMEOUT_MS,
): GalleryRequest {
  return async (route, init) => {
    const res = await fetchImpl(origin + route, {
      method: init.method ?? "GET",
      headers: {
        Accept: "application/json",
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body: unknown = await res.json().catch(() => null);
    return { status: res.status, body };
  };
}
