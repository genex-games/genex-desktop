/**
 * Managing a published game from its Play card, as genex.games' card menu does: the owner's items
 * (copy its link, turn remixing off or on, change its cover, unpublish, delete) and, for an account
 * genex.games names an admin, mobile support and tags on any game. genex.games' server checks every
 * one of these calls again (its admin list never leaves it), so what this module decides is only
 * what a card offers.
 */
import { GENEX_COVER_MAX_BYTES } from "./genex.ts";
import { PLAY_SHELF_TABS, PlayCategory, type PlayGame, PlayShelf } from "./play.ts";

/** A game's mobile flag, as an admin sets it. Wire values: never rename one. */
export const PlayMobileSupport = { DesktopOnly: "desktop_only", Supported: "supported" } as const;
export type PlayMobileSupport = (typeof PlayMobileSupport)[keyof typeof PlayMobileSupport];

/** Whether a value is a mobile flag. */
export const isPlayMobileSupport = (value: unknown): value is PlayMobileSupport =>
  value === PlayMobileSupport.DesktopOnly || value === PlayMobileSupport.Supported;

/** What the card menu reads from a gallery item. */
export interface PlayCuration {
  /** The admin's mobile flag; null leaves it to genex.games' crash reports. */
  mobileSupport: PlayMobileSupport | null;
  /** What the crash reports decided on their own: desktop only, or null. */
  mobileAuto: PlayMobileSupport | null;
  /** Its shelf marker and tags, as genex.games stores them (`["tools", "physics"]`). */
  categories: string[];
  /** Its owner turned remixing off. */
  remixOff: boolean;
}

/** One change to a published game. Kind values are the app's own, never sent. */
export const PlayChangeKind = {
  Mobile: "mobile",
  Tags: "tags",
  Remixing: "remixing",
  Unpublish: "unpublish",
  Delete: "delete",
} as const;
export type PlayChangeKind = (typeof PlayChangeKind)[keyof typeof PlayChangeKind];

/** A change to a game, as the card menu's items and dialogs ask for one. */
export type PlayGameChange =
  | { kind: typeof PlayChangeKind.Mobile; mobileSupport: PlayMobileSupport | null }
  | { kind: typeof PlayChangeKind.Tags; categories: string[] }
  | { kind: typeof PlayChangeKind.Remixing; allowed: boolean }
  | { kind: typeof PlayChangeKind.Unpublish }
  | { kind: typeof PlayChangeKind.Delete };

/** How a change went. Values are the app's own. */
export const PlayChangeOutcome = {
  Done: "done",
  /** Remixing cannot be turned on from here: the game's source is the owner's own repository. */
  OwnRepo: "own-repo",
} as const;
export type PlayChangeOutcome = (typeof PlayChangeOutcome)[keyof typeof PlayChangeOutcome];

/** What a change answers: Tags what was stored. */
export type PlayChangeResult =
  | { outcome: typeof PlayChangeOutcome.Done; categories?: string[] }
  | { outcome: typeof PlayChangeOutcome.OwnRepo };

/** Why genex.games kept the old cover. Wire values: never rename one. */
export const PlayCoverRefusal = {
  /** A cover that outranks an upload is kept (genex.games' own rule). */
  Outranked: "outranked",
  TooDark: "too_dark",
  Flat: "flat",
  Invalid: "invalid",
} as const;
export type PlayCoverRefusal = (typeof PlayCoverRefusal)[keyof typeof PlayCoverRefusal];

/** How a new cover went: shown at once, or kept back and why. */
export interface PlayCoverResult {
  applied: boolean;
  coverUrl: string | null;
  refusal: PlayCoverRefusal | null;
}

/** The picture types genex.games takes for a cover, as the website sends them. Wire values: never rename one. */
export const PlayCoverType = { Webp: "image/webp", Png: "image/png", Jpeg: "image/jpeg" } as const;
export type PlayCoverType = (typeof PlayCoverType)[keyof typeof PlayCoverType];

/** Whether a value is a cover picture type genex.games takes. */
export const isPlayCoverType = (value: unknown): value is PlayCoverType =>
  (Object.values(PlayCoverType) as unknown[]).includes(value);

/** The size every cover is cropped to before it is sent, as the website crops one. */
export const PLAY_COVER_SIZE = { width: 1536, height: 864 } as const;
/** The largest cover genex.games takes. */
export const PLAY_COVER_MAX_BYTES = GENEX_COVER_MAX_BYTES;

/** The most tags a game carries on the Games shelf; Tools and Assets carry their marker and two. */
const GAMES_TAGS_MAX = 3;
const SHELF_TAGS_MAX = 2;

/** A tag genex.games stores: a short lowercase word, which a game may carry from before its shelf's list. */
const TAG_SHAPE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** Whether a value is a tag Save tags may send. */
export const isPlayTag = (value: string): boolean => TAG_SHAPE.test(value);

/** The tabs a shelf opens on or names itself by, which are no tags of their own. */
const MARKERS = new Set<string>([PlayCategory.Featured, PlayShelf.Tools, PlayShelf.Assets, PlayShelf.Games]);

/** The tags a game on `shelf` may carry, in the website's order. */
export const shelfTags = (shelf: PlayShelf): string[] =>
  PLAY_SHELF_TABS[shelf].filter((category) => !MARKERS.has(category));

/** How many tags a game on `shelf` may carry. */
export const shelfTagsMax = (shelf: PlayShelf): number => (shelf === PlayShelf.Games ? GAMES_TAGS_MAX : SHELF_TAGS_MAX);

/** The shelf a game's categories put it on: Assets, then Tools, else Games, as the website buckets them. */
export function categoriesShelf(categories: readonly string[]): PlayShelf {
  if (categories.includes(PlayShelf.Assets)) return PlayShelf.Assets;
  return categories.includes(PlayShelf.Tools) ? PlayShelf.Tools : PlayShelf.Games;
}

/** A game's tags without its shelf marker. */
export const categoriesTags = (categories: readonly string[]): string[] =>
  categories.filter((category) => !MARKERS.has(category));

/** What Save tags stores: the shelf's marker (none for Games) and at most the shelf's number of tags. */
export function taggedCategories(shelf: PlayShelf, tags: readonly string[]): string[] {
  const marker = shelf === PlayShelf.Games ? [] : [shelf];
  return [...marker, ...[...new Set(tags)].slice(0, shelfTagsMax(shelf))];
}

/**
 * Whether `categories` is something Save tags could have stored: a shelf's marker and tags within
 * its limit, each a tag of its list or one the game already carried (a short lowercase word).
 */
export function isTaggedCategories(categories: unknown): categories is string[] {
  if (!Array.isArray(categories) || !categories.every((value) => typeof value === "string")) return false;
  const shelf = categoriesShelf(categories);
  const tags = categoriesTags(categories);
  return (
    tags.every(isPlayTag) &&
    new Set(tags).size === tags.length &&
    tags.length <= shelfTagsMax(shelf) &&
    categories.join() === taggedCategories(shelf, tags).join()
  );
}

/** A gallery id the app will put in an address: letters, digits, dashes and underscores. */
export const isPlayGameId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value);

/**
 * Whether a value is a change the card menu could have asked for. Every field is checked: a change
 * reaches genex.games only in the shape its own website sends.
 */
export function isPlayGameChange(value: unknown): value is PlayGameChange {
  if (typeof value !== "object" || value === null) return false;
  const change = value as Record<string, unknown>;
  switch (change.kind) {
    case PlayChangeKind.Mobile:
      return change.mobileSupport === null || isPlayMobileSupport(change.mobileSupport);
    case PlayChangeKind.Tags:
      return isTaggedCategories(change.categories);
    case PlayChangeKind.Remixing:
      return typeof change.allowed === "boolean";
    case PlayChangeKind.Unpublish:
    case PlayChangeKind.Delete:
      return true;
    default:
      return false;
  }
}

/** What the card menu offers. Values are the app's own `data-play-card-action` hooks: never rename one. */
export const PlayCardAction = {
  CopyLink: "copy-link",
  Remixing: "remixing",
  Cover: "cover",
  Mobile: "mobile",
  Tags: "tags",
  Unpublish: "unpublish",
  Delete: "delete",
} as const;
export type PlayCardAction = (typeof PlayCardAction)[keyof typeof PlayCardAction];

/** Who is looking: the signed-in account and whether genex.games names it an admin. */
export interface PlayViewerRights {
  accountId: string;
  isAdmin: boolean;
}

/** The card menu's three blocks: the game's own items, an admin's, and the two that take the game down. */
export interface PlayCardMenu {
  game: PlayCardAction[];
  admin: PlayCardAction[];
  end: PlayCardAction[];
}

/**
 * The card menu a viewer gets on a published game, by genex.games' own rules: the owner gets their
 * items, an admin mobile support and tags on any game, and both Change cover, Unpublish and Delete.
 * Null when the viewer gets nothing (signed out, or someone else's game): that card shows no ⋯.
 */
export function playCardMenu(game: Pick<PlayGame, "author">, viewer: PlayViewerRights | null): PlayCardMenu | null {
  if (!viewer) return null;
  const own = game.author.id !== null && game.author.id === viewer.accountId;
  if (!own && !viewer.isAdmin) return null;
  return {
    game: own ? [PlayCardAction.CopyLink, PlayCardAction.Remixing, PlayCardAction.Cover] : [PlayCardAction.Cover],
    admin: viewer.isAdmin ? [PlayCardAction.Mobile, PlayCardAction.Tags] : [],
    end: [PlayCardAction.Unpublish, PlayCardAction.Delete],
  };
}
