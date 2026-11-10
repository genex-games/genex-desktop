/**
 * The person's asset library on genex.games and sharing to the community: the shapes main and the
 * renderer share, and the pure rules both apply.
 *
 * Every Genex generation is in the library by itself; Save marks the good ones (genex.games'
 * `savedAt`) and sends a file Genex did not make (Blender, a drop) there first. Share puts an asset
 * on Play for everyone; stop sharing takes it off again. A file Genex did not make can be saved but
 * not shared.
 */
import { ASSET_PREVIEW_MIME } from "./asset-preview.ts";
import { type AssetKind, assetExtension, type ProjectAsset } from "./game-assets.ts";
import { t } from "./i18n.ts";

/** An asset filter's kinds, in genex.games' wire spelling (the `type` of `/api/generations`). */
export const LibraryKind = { Model: "3d", Image: "image", Sound: "sound", Video: "video" } as const;
export type LibraryKind = (typeof LibraryKind)[keyof typeof LibraryKind];

/** The kinds in the order the switchers list them. */
export const LIBRARY_KINDS: readonly LibraryKind[] = Object.values(LibraryKind);

/** Whether a value names a kind. */
export const isLibraryKind = (value: unknown): value is LibraryKind =>
  typeof value === "string" && (LIBRARY_KINDS as readonly string[]).includes(value);

/** A game file's kind as the library files it; null for a file the library takes no kind of. */
export const LIBRARY_KIND_OF = {
  model: LibraryKind.Model,
  image: LibraryKind.Image,
  audio: LibraryKind.Sound,
  video: LibraryKind.Video,
  other: null,
} as const satisfies Record<AssetKind, LibraryKind | null>;

/** Whose assets a filter shows: everyone's shared ones, or the person's own library. */
export const AssetScope = { Everyone: "everyone", Mine: "mine" } as const;
export type AssetScope = (typeof AssetScope)[keyof typeof AssetScope];

/** A shared asset's page on genex.games. */
export interface SharedAsset {
  projectId: string;
  slug: string;
  /** On Play now; false once sharing was stopped (the page stays reachable by its link). */
  live: boolean;
}

/** One asset in the signed-in account's genex.games library. */
export interface LibraryAsset {
  /** genex.games' generation id. */
  id: string;
  kind: LibraryKind;
  /** The words it was made from, or the name it was saved under. */
  title: string;
  thumbnailUrl: string | null;
  /** The file itself (a GLB, picture, sound or video), or null when genex.games lists none. */
  fileUrl: string | null;
  /**
   * What that file is, by the role genex.games keeps it under or its extension: a 3D asset whose
   * model is off the asset hosts may keep its preview picture. Null when neither says, or no file.
   */
  fileKind: LibraryKind | null;
  /**
   * The format that file was found to be, as an extension (`glb`, `fbx`): its content type's, its
   * `ext`, its address's or its role's. Null when nothing says.
   */
  fileFormat: string | null;
  saved: boolean;
  shared: SharedAsset | null;
  /** genex.games takes a share of it: Genex made it (not sent from a file, nor made from one) and its kind may go on Play (not music). */
  shareable: boolean;
  createdAt: string;
}

/**
 * Hosts a library file is read from: genex.games' asset buckets. The renderer's `img-src` and
 * `media-src` list each of them, so a tile can show an image's own file.
 */
const LIBRARY_FILE_HOSTS: ReadonlySet<string> = new Set([
  "assets.genex.technology",
  "assets.genex.games",
  "cdn.genex.technology",
]);

/** An https file on one of genex.games' asset hosts (no credentials, no port), else null. */
export function libraryFileUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    const plain = url.protocol === "https:" && !url.username && !url.password && !url.port;
    return plain && LIBRARY_FILE_HOSTS.has(url.hostname) ? url.href : null;
  } catch {
    return null;
  }
}

/** Why main read no file for a tile's picture. Wire values; the renderer decides what each means. */
export const LibraryFileMiss = {
  /** Over the picture's cap: the same file is refused again. */
  TooLarge: "too-large",
  /** Not on genex.games' asset hosts, a redirect, or a 4xx other than 408/429: asked again, refused again. */
  Refused: "refused",
  /** Anything that may pass: a 5xx, a 408 or 429, a timeout, the network. */
  Unavailable: "unavailable",
} as const;
export type LibraryFileMiss = (typeof LibraryFileMiss)[keyof typeof LibraryFileMiss];

/** A tile's picture file as main answers it: its bytes, or why there are none. */
export type LibraryFileAnswer = { bytes: Uint8Array<ArrayBuffer> } | { miss: LibraryFileMiss };

/** What to read from the library. */
export interface LibraryQuery {
  /** Words the title must contain. */
  query?: string;
  kind?: LibraryKind;
  /** Only the saved ones. */
  saved?: boolean;
  /** Only these generations (at most {@link LIBRARY_IDS_MAX}). */
  ids?: string[];
  /** The cursor of the page before. */
  before?: string;
}

/** One page of the library, newest first. */
export interface LibraryPage {
  assets: LibraryAsset[];
  nextCursor: string | null;
}

/** How many files one Save or Share call carries; more go in runs of this many ({@link inBatches}). */
export const LIBRARY_BATCH_MAX = 50;

/** `items` in runs of at most {@link LIBRARY_BATCH_MAX}, in order: what Save and Share send call by call. */
export function inBatches<T>(items: readonly T[]): T[][] {
  const runs: T[][] = [];
  for (let start = 0; start < items.length; start += LIBRARY_BATCH_MAX) {
    runs.push(items.slice(start, start + LIBRARY_BATCH_MAX));
  }
  return runs;
}

/** Share `items` run by run; every file gets its outcome. */
export async function shareInBatches(
  share: (items: ShareItem[]) => Promise<ShareOutcome[]>,
  items: readonly ShareItem[],
): Promise<ShareOutcome[]> {
  const outcomes: ShareOutcome[] = [];
  for (const run of inBatches(items)) outcomes.push(...(await share(run)));
  return outcomes;
}

/** How many generations one state read asks about; genex.games answers at most as many. */
export const LIBRARY_IDS_MAX = 100;
/** The longest search a library read sends. */
export const LIBRARY_QUERY_MAX = 100;
/** The longest name a shared asset keeps on Play: genex.games shortens a longer one. */
export const SHARE_NAME_MAX = 40;
/** The longest title a file sent to the library carries. */
export const LIBRARY_TITLE_MAX = 80;
/** A clause or phrase that stands as a whole name is at least this long: "Fire, a huge jet…" is not "Fire". */
const SHARE_WHOLE_MIN = 12;
/** A run this short after a joining word dangles and is cut off with it: "with a tall twisted". */
const DANGLING_WORDS_MAX = 2;
/** Punctuation that ends a clause when a space or the end follows it: "1.5" and "16:9" stay whole. */
const CLAUSE_END = /[,;:.!?]/;
/** Punctuation a shortened name never ends on. */
const TRAILING_PUNCTUATION = /[\s,;:.!?\-\u2013\u2014]+$/;
/**
 * Articles, conjunctions and prepositions: words that join what follows to what came before. A
 * shortened name never ends on one, and a phrase ends before one.
 */
const JOINING_WORDS = new Set(
  (
    "a an the and or but nor that which while " +
    "about above across after against along around as at before behind below beneath beside between by during " +
    "for from in inside into near of off on onto over through to toward towards under upon with within without"
  ).split(" "),
);

/** A genex.games generation id as the app accepts one. */
const GENERATION_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** Whether a value can be a genex.games generation id. */
export const isGenerationId = (value: unknown): value is string =>
  typeof value === "string" && GENERATION_ID.test(value);

/** Where one file of a game stands with the library: what it is there, and what can be done. */
export interface AssetLibraryState {
  /** The game file, posix-relative to the game. */
  file: string;
  /** Its generation in the library, or null while it is only in the game. */
  generationId: string | null;
  saved: boolean;
  shared: SharedAsset | null;
  /** Save can act on it: it is in the library, or it is a kind genex.games takes from the app. */
  saveable: boolean;
  /** Share can act on it: Genex made it. */
  shareable: boolean;
}

/** One game's files and where each stands with the library, read in one go. */
export interface GameLibraryStates {
  project: string;
  states: AssetLibraryState[];
  /** The library could not be read (signed out, offline): every file reads as only in the game. */
  unread: boolean;
}

/** One file to share, under the name it gets on Play. */
export interface ShareItem {
  file: string;
  name: string;
}

/** Why sharing one file did not put it on Play. Wire values; the renderer words them. */
export const ShareMiss = {
  /** genex.games' check refused it. */
  Refused: "refused",
  /** genex.games is still checking it; it goes live on its own when the check passes. */
  Checking: "checking",
  /** Only what Genex made can be shared. */
  NotShareable: "not-shareable",
  /** genex.games takes no shares of this kind (music). */
  KindNotShareable: "kind-not-shareable",
  /** Too many shares in a short time. */
  TooMany: "too-many",
  /** Anything else: offline, an outage. */
  Failed: "failed",
} as const;
export type ShareMiss = (typeof ShareMiss)[keyof typeof ShareMiss];

/** How sharing one file went. */
export type ShareOutcome = { file: string; shared: SharedAsset } | { file: string; miss: ShareMiss; detail?: string };

/** Something to bring into a game: a library generation, or a shared asset by its Play slug. */
export type AddSource = { generationId: string } | { slug: string };

/** Where an added asset landed in the game, posix-relative; or the module path for a code asset. */
export interface AddOutcome {
  files: string[];
}

/** The file types genex.games takes when Save sends a file Genex did not make. */
export const SENDABLE_TYPES: ReadonlySet<string> = new Set([
  "model/gltf-binary",
  "image/png",
  "image/jpeg",
  "image/webp",
  "audio/mpeg",
  "audio/wav",
  "audio/ogg",
  "video/mp4",
]);

/** The largest file genex.games takes from the app: a model or a video, else a picture or a sound. */
const SEND_MAX_BYTES = { large: 64 * 1024 * 1024, small: 32 * 1024 * 1024 } as const;
const LARGE_TYPES: ReadonlySet<string> = new Set(["model/gltf-binary", "video/mp4"]);

/** The largest `file` genex.games takes when Save sends it. */
export const sendMaxBytes = (file: string): number =>
  LARGE_TYPES.has(ASSET_PREVIEW_MIME[assetExtension(file)] ?? "") ? SEND_MAX_BYTES.large : SEND_MAX_BYTES.small;

/** Whether Save can send a game file to the library: genex.games takes its type and its size. */
export const isSendable = (file: string, bytes = 0): boolean =>
  SENDABLE_TYPES.has(ASSET_PREVIEW_MIME[assetExtension(file)] ?? "") && bytes <= sendMaxBytes(file);

/** A file's library kind, or null for one the library takes no kind of. */
export const libraryKindOf = (asset: Pick<ProjectAsset, "kind">): LibraryKind | null => LIBRARY_KIND_OF[asset.kind];

const isJoiningWord = (word: string): boolean => JOINING_WORDS.has(word.toLowerCase());

/** `text` without the punctuation and joining words a cut left at its end. */
function tidyEnd(text: string): string {
  const name = text.replace(TRAILING_PUNCTUATION, "");
  const lastSpace = name.lastIndexOf(" ");
  const endsOnJoiningWord = lastSpace >= 0 && isJoiningWord(name.slice(lastSpace + 1));
  return endsOnJoiningWord ? tidyEnd(name.slice(0, lastSpace)) : name;
}

/** Whether a clause of `name` ends just before `index`. */
function endsClause(name: string, index: number): boolean {
  const after = name.charAt(index + 1);
  return CLAUSE_END.test(name.charAt(index)) && (after === "" || after === " ");
}

/** `name` ended at its last whole clause that fits Play, or null when none stands as a name. */
function lastClause(name: string): string | null {
  for (let end = SHARE_NAME_MAX; end >= SHARE_WHOLE_MIN; end--) {
    const clause = endsClause(name, end) ? tidyEnd(name.slice(0, end)) : "";
    if (clause.length >= SHARE_WHOLE_MIN) return clause;
  }
  return null;
}

/**
 * `head`, the whole words that fit, ended where a phrase does; `cutOff` is the first word that did
 * not fit. Words that stop mid-phrase ("Giant mushroom tree with a tall twisted", and "stem" is cut
 * off) go back to before their last joining word ("Giant mushroom tree"). Only a short dangling run
 * is given up, and never so much that too little is left to be a name.
 */
function lastPhrase(head: string, cutOff: string): string {
  const whole = tidyEnd(head);
  if (whole.length < head.length || isJoiningWord(cutOff)) return whole;
  const words = whole.split(" ");
  const joining = words.findLastIndex((word, index) => index > 0 && isJoiningWord(word));
  const dangling = words.length - 1 - joining;
  if (joining <= 0 || dangling > DANGLING_WORDS_MAX) return whole;
  const phrase = tidyEnd(words.slice(0, joining).join(" "));
  return phrase.length >= SHARE_WHOLE_MIN ? phrase : whole;
}

/**
 * A name as Play keeps it, the way genex.games shortens one itself: accents folded to plain
 * letters, whole when it fits, else ended at its last whole clause that fits, else at its last
 * whole phrase or word, else at the limit and never through a character pair.
 */
function fitShareName(text: string): string {
  const name = text
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  if (name.length <= SHARE_NAME_MAX) return name;
  const clause = lastClause(name);
  if (clause) return clause;
  const wordEnd = name.lastIndexOf(" ", SHARE_NAME_MAX);
  if (wordEnd <= 0) return name.slice(0, SHARE_NAME_MAX).replace(/[\uD800-\uDBFF]$/, "");
  return lastPhrase(name.slice(0, wordEnd), name.slice(wordEnd + 1).split(" ", 1)[0] ?? "");
}

/** A name for Play from what an asset was made from: its first line, shortened to what Play keeps. */
export function shareNameOf(prompt: string | undefined, file: string): string {
  const fromPrompt = (prompt ?? "").split("\n")[0]?.trim() ?? "";
  const stem = (file.split("/").at(-1) ?? file)
    .replace(/\.[^.]+$/, "")
    .replace(/[-_]+/g, " ")
    .trim();
  const name = fitShareName(fromPrompt || stem || t("Asset"));
  return name.charAt(0).toUpperCase() + name.slice(1);
}
