/**
 * @ tags in the prompt: what a tag is, and the text rules the composer and the transcript share.
 *
 * The text is the source of truth. A pick inserts the literal `@handle` into the sentence; the
 * composer's map of picked things only says which words are tags. So a tag whose letters were
 * edited stops matching and is plain text again, the agent always reads a readable sentence, and a
 * hand-typed `@something` is never a tag: only a picked handle is.
 *
 * A handle is `[a-z0-9][a-z0-9-]*` (genex.games slugs already are; local game names are folded to
 * it), and the `@` must start a word, so `you@example.com` is never a tag.
 */

/** What a tagged thing is, as the picker's chip names it. */
export const MentionKind = { Game: "game", Tool: "tool", Asset: "asset", Plugin: "plugin" } as const;
export type MentionKind = (typeof MentionKind)[keyof typeof MentionKind];

/** Where a tagged thing comes from: a game folder on this Mac, or genex.games. */
export const MentionOrigin = { Local: "local", Genex: "genex" } as const;
export type MentionOrigin = (typeof MentionOrigin)[keyof typeof MentionOrigin];

/** How many things one message may tag; genex.games allows the same. */
export const PROMPT_MENTION_MAX = 5;

/** What the composer and the picker hold for one taggable thing. Display data: main re-checks it. */
export interface MentionDoc {
  /** The word after the @, unique in the picker. */
  handle: string;
  kind: MentionKind;
  origin: MentionOrigin;
  title: string;
  description: string;
  /** A picture for the card, or null for the plain card. */
  coverUrl: string | null;
  /** The person's own game. */
  own: boolean;
  /** Local: the library's game name, which main resolves to its folder. */
  game?: string;
  /** genex.games: the project's slug. */
  slug?: string;
  /** A plugin that is on: its id. */
  plugin?: string;
  /** genex.games: plays, which break ties in the ranking. */
  plays: number;
}

/** One tag as a message carries it to main: the identity, never a path. */
export interface MentionRef {
  handle: string;
  kind: MentionKind;
  origin: MentionOrigin;
  title: string;
  game?: string;
  slug?: string;
  plugin?: string;
  /** A genex.games cover the chat shows beside the tag's result; display only. */
  coverUrl?: string;
}

/** The part of a doc a message carries. */
export function mentionRef(doc: MentionDoc): MentionRef {
  return {
    handle: doc.handle,
    kind: doc.kind,
    origin: doc.origin,
    title: doc.title,
    ...(doc.game === undefined ? {} : { game: doc.game }),
    ...(doc.slug === undefined ? {} : { slug: doc.slug }),
    ...(doc.plugin === undefined ? {} : { plugin: doc.plugin }),
    ...(isCoverUrl(doc.coverUrl) ? { coverUrl: doc.coverUrl } : {}),
  };
}

/** A plugin that is on, as a tag: its name folded to a handle, so it paints like the others. */
export function pluginDoc(plugin: { id: string; name: string; icon?: string }): MentionDoc {
  return {
    handle: handleOf(plugin.name),
    kind: MentionKind.Plugin,
    origin: MentionOrigin.Local,
    title: plugin.name,
    description: "",
    coverUrl: plugin.icon ?? null,
    own: false,
    plugin: plugin.id,
    plays: 0,
  };
}

/** The longest cover address a tag keeps. */
const COVER_URL_MAX = 600;

/** A cover a tag may carry: an https address of reasonable length (never a data: picture). */
export function isCoverUrl(value: unknown): value is string {
  return typeof value === "string" && value.length <= COVER_URL_MAX && value.startsWith("https://");
}

/** A handle's letters, then any number of hyphenated runs. */
const HANDLE_BODY = "[a-z0-9][a-z0-9-]*";
const TOKEN_PATTERN = new RegExp(`@(${HANDLE_BODY})`, "g");
const HANDLE_PATTERN = new RegExp(`^${HANDLE_BODY}$`);

/** Whether `text` may be a handle. */
export function isHandle(text: string): boolean {
  return HANDLE_PATTERN.test(text);
}

/** A name folded to a handle: lower case, ASCII letters and digits, single hyphens. */
export function handleOf(name: string): string {
  const folded = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return folded || "game";
}

/** The character before `index` lets an @ start a word there. */
function startsWord(value: string, index: number): boolean {
  if (index === 0) return true;
  return /[\s([{"'“‘]/.test(value.charAt(index - 1));
}

/** One tag's place in the text; `end` is exclusive, so `value.slice(start, end)` is `@handle`. */
export interface MentionToken {
  handle: string;
  start: number;
  end: number;
}

/**
 * The tags in `value`: each `@handle` that starts a word and is a known handle. A longer known
 * handle wins over a shorter one it begins with, and a trailing hyphen is never part of a tag.
 */
export function scanMentionTokens(
  value: string,
  known: ReadonlySet<string> | ReadonlyMap<string, unknown>,
): MentionToken[] {
  if (known.size === 0) return [];
  const tokens: MentionToken[] = [];
  for (const match of value.matchAll(TOKEN_PATTERN)) {
    const start = match.index;
    if (!startsWord(value, start)) continue;
    const handle = knownPrefix(match[1] ?? "", known);
    if (handle) tokens.push({ handle, start, end: start + 1 + handle.length });
  }
  return tokens;
}

/** The longest known handle that `word` is, or begins with at a hyphen. */
function knownPrefix(word: string, known: ReadonlySet<string> | ReadonlyMap<string, unknown>): string | null {
  let candidate = word;
  while (candidate) {
    if (known.has(candidate)) return candidate;
    const cut = candidate.lastIndexOf("-");
    if (cut <= 0) return null;
    candidate = candidate.slice(0, cut);
  }
  return null;
}

/** The text cut into plain runs and tags, in order, for painting. */
export function splitMentions(
  value: string,
  known: ReadonlySet<string> | ReadonlyMap<string, unknown>,
): { text: string; handle: string | null }[] {
  const out: { text: string; handle: string | null }[] = [];
  let cursor = 0;
  for (const token of scanMentionTokens(value, known)) {
    if (token.start > cursor) out.push({ text: value.slice(cursor, token.start), handle: null });
    out.push({ text: value.slice(token.start, token.end), handle: token.handle });
    cursor = token.end;
  }
  if (cursor < value.length) out.push({ text: value.slice(cursor), handle: null });
  return out;
}

/** The @ being typed at the caret: where it starts and what follows it. */
export interface MentionQuery {
  start: number;
  query: string;
}

/**
 * The open `@query` ending at the caret, or null. Read from the text each time rather than kept as
 * state, because the caret also moves by click, undo and paste.
 */
export function mentionQueryAt(value: string, caret: number | null): MentionQuery | null {
  if (caret === null || caret < 1 || caret > value.length) return null;
  for (let i = caret; i > 0; i -= 1) {
    const char = value.charAt(i - 1);
    if (char === "@") return startsWord(value, i - 1) ? { start: i - 1, query: value.slice(i, caret) } : null;
    if (/\s/.test(char)) return null;
  }
  return null;
}

/** The text after a pick, and where the caret goes. */
export interface MentionInsertion {
  value: string;
  caret: number;
}

/**
 * Replace the open `@query` (or insert at the caret) with `@handle ` and a space, which ends the
 * query so typing goes on; no second space when one already follows.
 */
export function insertMention(
  value: string,
  caret: number,
  handle: string,
  open: MentionQuery | null,
): MentionInsertion {
  const from = open ? open.start : caret;
  const before = value.slice(0, from);
  const after = value.slice(caret);
  const token = `@${handle}${after.startsWith(" ") ? "" : " "}`;
  return { value: before + token + after, caret: before.length + token.length };
}

/**
 * The range one Backspace removes when the caret sits right after a whole tag, or null where the
 * text box's own Backspace is right (a selection, the caret inside a tag or after plain text).
 */
export function atomicBackspaceRange(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  known: ReadonlySet<string> | ReadonlyMap<string, unknown>,
): { start: number; end: number } | null {
  if (selectionStart !== selectionEnd) return null;
  const token = scanMentionTokens(value, known).find((t) => t.end === selectionStart);
  return token ? { start: token.start, end: token.end } : null;
}

/** The tags a message sends: those in both the map and the text, in text order, once each, capped. */
export function sentMentions<T>(value: string, picked: ReadonlyMap<string, T>): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const token of scanMentionTokens(value, picked)) {
    const item = picked.get(token.handle);
    if (seen.has(token.handle) || item === undefined) continue;
    seen.add(token.handle);
    out.push(item);
    if (out.length >= PROMPT_MENTION_MAX) break;
  }
  return out;
}

/** What a tag gave the agent once main had resolved it. Persisted: never rename a value. */
export const MentionResult = {
  /** A game on this Mac the agent may read. */
  Read: "read",
  /** A genex.games game or tool copied beside the game to read. */
  Copied: "copied",
  /** An asset's module added to the game. */
  Added: "added",
  /** Nothing could be attached; `miss` says why. */
  Unavailable: "unavailable",
  /** The person took the tag off after it failed. */
  Removed: "removed",
} as const;
export type MentionResult = (typeof MentionResult)[keyof typeof MentionResult];

/** Why a tag attached nothing. Persisted: never rename a value. */
export const MentionMiss = {
  /** The game is no longer in the library, or no longer on genex.games. */
  Gone: "gone",
  /** genex.games no longer lets anyone take it. */
  NotTakeable: "not-takeable",
  /** Its download or its module did not arrive. */
  NotDownloaded: "not-downloaded",
  /** An asset is three.js code, and this game is not a web game. */
  NotWebGame: "not-web-game",
} as const;
export type MentionMiss = (typeof MentionMiss)[keyof typeof MentionMiss];

/** One resolved tag, as the chat shows it after the message, with what it takes to try it again. */
export interface MentionOutcome {
  handle: string;
  title: string;
  kind: MentionKind;
  origin: MentionOrigin;
  game?: string;
  slug?: string;
  plugin?: string;
  coverUrl?: string;
  result: MentionResult;
  /** Where it landed, relative to the game (`src/assets/fireplace.ts`, `.studio/refs/neon-rush`). */
  path?: string;
  miss?: MentionMiss;
}

/** What the chat can do with a tag that attached nothing: fetch it again, or take it off. */
export const MentionRetry = { Again: "again", Remove: "remove" } as const;
export type MentionRetry = (typeof MentionRetry)[keyof typeof MentionRetry];

/** Whether trying a failed tag again can help: only a download that did not arrive. */
export function retriable(tag: Pick<MentionOutcome, "result" | "miss">): boolean {
  return tag.result === MentionResult.Unavailable && tag.miss === MentionMiss.NotDownloaded;
}

/** The tag a result came from, to try it again. */
export function refOf(tag: MentionOutcome): MentionRef {
  return {
    handle: tag.handle,
    kind: tag.kind,
    origin: tag.origin,
    title: tag.title,
    ...(tag.game ? { game: tag.game } : {}),
    ...(tag.slug ? { slug: tag.slug } : {}),
    ...(tag.plugin ? { plugin: tag.plugin } : {}),
    ...(tag.coverUrl ? { coverUrl: tag.coverUrl } : {}),
  };
}

/**
 * Each tag's latest result for one message: records for the same message (a first send, then
 * Try again or Remove) replace a tag's result by its handle and keep the first order.
 */
export function mergeMentionResults(
  current: readonly MentionOutcome[],
  next: readonly MentionOutcome[],
): MentionOutcome[] {
  const byHandle = new Map(current.map((tag) => [tag.handle, tag]));
  for (const tag of next) byHandle.set(tag.handle, tag);
  return [...byHandle.values()];
}

/** Thread custom event `mention_tagged`: what each tag of one message gave the agent. */
export interface MentionTaggedPayload {
  /** The queue's id of the message the tags came with. */
  messageId?: string;
  tags?: MentionOutcome[];
}

/**
 * What separates the person's words from the lines main adds about their tags in the text the
 * agent reads. The chat shows only the words before it, and a rewind gives back only those.
 */
export const MENTION_CONTEXT_HEADING = "\n\nTagged in this message:\n";

/** The person's own words of a sent message: everything before the tags' lines. */
export function withoutMentionContext(text: string): string {
  const at = text.indexOf(MENTION_CONTEXT_HEADING);
  return at < 0 ? text : text.slice(0, at);
}

/** The longest title or name a tag carries. */
const TAG_TEXT_MAX = 200;

const KINDS: ReadonlySet<unknown> = new Set(Object.values(MentionKind));
const ORIGINS: ReadonlySet<unknown> = new Set(Object.values(MentionOrigin));
const isKind = (value: unknown): value is MentionKind => KINDS.has(value);
const isOrigin = (value: unknown): value is MentionOrigin => ORIGINS.has(value);
/** A non-empty string cut to the tag text limit, or undefined. */
const tagText = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value.slice(0, TAG_TEXT_MAX) : undefined;

/** One tag from untrusted input, or null when it is not well formed. */
function readMentionRef(item: unknown): MentionRef | null {
  if (typeof item !== "object" || item === null) return null;
  const read = (key: keyof MentionRef): unknown => Reflect.get(item, key);
  const [handle, kind, origin, title, game, slug, plugin, coverUrl] = (
    ["handle", "kind", "origin", "title", "game", "slug", "plugin", "coverUrl"] as const
  ).map(read);
  const named = typeof handle === "string" && isHandle(handle) && typeof title === "string";
  if (!named || !isKind(kind) || !isOrigin(origin)) return null;
  const gameName = tagText(game);
  const slugName = tagText(slug);
  const pluginId = tagText(plugin);
  return {
    handle,
    kind,
    origin,
    title: title.slice(0, TAG_TEXT_MAX),
    ...(gameName ? { game: gameName } : {}),
    ...(slugName ? { slug: slugName } : {}),
    ...(pluginId ? { plugin: pluginId } : {}),
    ...(isCoverUrl(coverUrl) ? { coverUrl } : {}),
  };
}

/** The tags a send names, read from untrusted input: well-formed ones only, at most five. */
export function readMentionRefs(value: unknown): MentionRef[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(readMentionRef)
    .filter((ref): ref is MentionRef => ref !== null)
    .slice(0, PROMPT_MENTION_MAX);
}
