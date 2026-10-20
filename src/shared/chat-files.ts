/**
 * Files a chat names, and how each one opens (the Chat page, docs/product/chat.md).
 *
 * Anything in a chat can name a file: a reply, a person's own message, a tool row, a plan. The
 * renderer finds the names here and asks main which of them exist; only those become links.
 * Markdown and images of the game open beside the chat; every other file opens in the app the
 * system uses for it. Main decides (src/main/chat-files.ts) and never launches programs.
 */

/**
 * How a file the chat names opens:
 * - `beside`: a tab next to the chat (Markdown and images the game or its build has)
 * - `app`: the file's default app
 * - `folder`: a folder, opened in the file manager
 * - `finder`: shown in the file manager, never launched (apps, scripts, installers, unknown types)
 */
export const ChatFileOpen = {
  Beside: "beside",
  App: "app",
  Folder: "folder",
  Finder: "finder",
} as const;
export type ChatFileOpen = (typeof ChatFileOpen)[keyof typeof ChatFileOpen];

/** Every way a click opens a file except beside the chat, which the renderer does itself. */
export type ChatFileOpenOutside = Exclude<ChatFileOpen, typeof ChatFileOpen.Beside>;

/** A name as the chat wrote it; `base` is the game document it appeared in, for its relative links. */
export interface ChatFileRef {
  name: string;
  base?: string;
}

export interface ChatFileLink {
  open: ChatFileOpen;
  /** Game-relative for `beside`; otherwise where it is on this computer, with `~` for home. */
  path: string;
  /** Only in the run's build so far: what opens is a read-only copy. */
  build?: true;
}

/** Undefined while main has not answered yet; null when the name is not a file on this computer. */
export type ChatFileLookup = (name: string, base?: string) => ChatFileLink | null | undefined;

export interface FileMention {
  start: number;
  end: number;
  name: string;
}

/** At most this many names are asked about at once, or linked in one piece of text. */
export const CHAT_FILE_LIMIT = 200;
/** The longest name the chat can mean as a file. */
export const CHAT_FILE_NAME_MAX = 1024;
/** Text longer than this is not searched for names: a pasted log is not a list of files. */
const SCANNED_TEXT_MAX = 400_000;
/** How far back a mention looks for the spaced folder name it may be the tail of. */
const CUT_LOOKBEHIND = 256;

// A path ends where prose resumes. Characters that never sit inside a path the chat writes:
const BT = "`";
const STOP = String.raw`\s"'` + BT + String.raw`<>|*?()\[\]{},;«»“”`;
// Letters of any script: people and agents write «Моя игра/герой.png» as often as hero.png.
const LETTERS = String.raw`\p{L}\p{N}_`;
const WORD = `[${LETTERS}]`;
const EXT = String.raw`\.[A-Za-z][A-Za-z0-9]{0,9}`;
// `src/game.ts:42`, `src/game.ts:42:7` or `#L42`, as editors and agents write them.
const POSITION = String.raw`(?::\d+(?::\d+)?|#L\d+(?:-L?\d+)?)?`;
const BEFORE = String.raw`(?<=^|[\s(\["'` + BT + String.raw`{<=,;«“‘—–])`;
const AFTER = String.raw`(?=$|[\s)\]}"'` + BT + String.raw`>,;:!?.»”’—–…])`;
const SEGMENT = String.raw`\.?${WORD}[${LETTERS}.@+\-]*`;
// Windows separates folders with either slash (`C:\Users\me`, `src\game.ts`); `\` is in no STOP.
const SEP = String.raw`[\\/]`;
const NOT_SEP = String.raw`\\/`;
/**
 * The rest of an absolute path after its `lead`. A space belongs to the path only inside a
 * capitalized folder name that goes on to a separator ("AI Games/", "Application Support/",
 * "Моя игра/"), and not after a file name or a full stop, so the next sentence, or the next
 * argument of a command (`cp /tmp/out src/a.js`), is not swallowed. Bounded look-around keeps a
 * long run of capitalized words linear.
 */
const absolute = (lead: string, sep: string, notSep: string) =>
  String.raw`${BEFORE}${lead}(?:[^${STOP}]|(?<=${sep}\p{Lu}[^${notSep}]{0,255})(?<![.:!?])(?<!${EXT})[ ](?=(?:\p{Lu}[^${STOP}${notSep}.:]{0,63} ){0,3}${WORD}[^${STOP}${notSep}]{0,127}${sep}))+`;
const MENTION = new RegExp(
  [
    // file:///Users/me/a.md
    String.raw`${BEFORE}file:\/\/[^${STOP}]+`,
    // /Users/me/AI Games/rift/a.js, ~/Movies/intro.mp4, never `//` (a comment).
    absolute(String.raw`(?:~|)\/(?!\/)`, String.raw`\/`, "/"),
    // C:\Users\me\AI Games\rift\a.js, C:/Users/me/a.md
    absolute(String.raw`[A-Za-z]:${SEP}(?=[^${STOP}])`, SEP, NOT_SEP),
    // src/game.js, ./docs/DESIGN.md, ../shared/a.ts, and with backslashes on Windows
    String.raw`${BEFORE}(?:(?:\.{1,2}${SEP})+|${SEGMENT}${SEP})(?:${SEGMENT}${SEP})*${SEGMENT}${EXT}${POSITION}${AFTER}`,
    // package.json, intro.mp4 (main looks for these in the game)
    String.raw`${BEFORE}${WORD}[${LETTERS}.+\-]*\.[A-Za-z][A-Za-z0-9]{1,9}${POSITION}${AFTER}`,
  ]
    .map((part) => `(?:${part})`)
    .join("|"),
  "gu",
);
// A scheme is short; bounding it keeps a long run of dotted words from being re-scanned.
const URL_LIKE = /\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s<>"'`]+/gi;
const TRAILING = /[.,;:!?'")\]}>»”’—–…]+$/u;
// "assets/Hero Sprite.png": a relative path stops at the space, so the words after it are the
// rest of a spaced name, not a file of their own.
const CUT_BEFORE = /[\\/][^\s\\/.]+ $/u;
/** The position an editor adds to a name (`:42`, `:42:7`, `#L12-L20`). */
const TRAILING_POSITION = /(?::\d+(?::\d+)?|#L\d+(?:-L?\d+)?)$/;

/** A mention's own text, cut at the punctuation that closes the sentence around it. */
function trimMention(raw: string): string {
  let value = raw;
  let next = value.replace(TRAILING, "");
  // `a.js:12:` keeps its position, but `a.js:` does not keep the colon.
  while (next !== value) {
    value = next;
    next = value.replace(TRAILING, "");
  }
  return value.replace(/ +$/, "");
}

/** A Windows drive's path: `C:\Users`, `d:/out`. */
const DRIVE_PATH = /^[A-Za-z]:[\\/]/;

/**
 * An absolute or `~/` name worth asking about: `/tmp/a.png`, `/Users/me/Game` and
 * `C:\Users\me\Game`, not `/usr`, `C:\Users` or `</div>`.
 */
function plausibleAbsolute(name: string): boolean {
  const bare = name.replace(TRAILING_POSITION, "");
  // `//` starts a code comment; slashes alone are never a file.
  if (bare.startsWith("//") || !/[^/~]/.test(bare)) return false;
  const folders = bare.replace(DRIVE_PATH, "/").match(/[\\/]/g)?.length ?? 0;
  return /\.[A-Za-z][A-Za-z0-9]{0,9}$/.test(bare) || folders >= 2;
}

function plausible(name: string): boolean {
  if (name.length < 2 || name.length > CHAT_FILE_NAME_MAX) return false;
  if (name.startsWith("file://")) return name.length > 8;
  if (name.startsWith("/") || name.startsWith("~/") || DRIVE_PATH.test(name)) return plausibleAbsolute(name);
  return true;
}

/** Where the text's web links are: a name inside one is part of the link, not a file. */
function webLinkSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (const match of text.matchAll(URL_LIKE)) {
    if (!/^file:/i.test(match[0])) spans.push([match.index, match.index + match[0].length]);
  }
  return spans;
}

/** One match as a mention, or null when it sits in a web link, is not a file name, or ends a spaced one. */
function mentionAt(text: string, match: RegExpExecArray, blocked: Array<[number, number]>): FileMention | null {
  const start = match.index;
  if (blocked.some(([from, to]) => start >= from && start < to)) return null;
  const name = trimMention(match[0]);
  if (!plausible(name)) return null;
  if (!/[\\/]/.test(name) && CUT_BEFORE.test(text.slice(Math.max(0, start - CUT_LOOKBEHIND), start))) return null;
  return { start, end: start + name.length, name };
}

/** Every file name in plain text, in order. URLs (other than `file:`) are never file names. */
export function fileMentions(text: string): FileMention[] {
  if (!text || text.length > SCANNED_TEXT_MAX) return [];
  const blocked = webLinkSpans(text);
  const found: FileMention[] = [];
  for (const match of text.matchAll(MENTION)) {
    const mention = mentionAt(text, match, blocked);
    if (!mention) continue;
    found.push(mention);
    if (found.length >= CHAT_FILE_LIMIT) break;
  }
  return found;
}

/**
 * Inline code that is one file name as a whole (`docs/DESIGN.md`, `~/AI Games/rift/a.js`), which
 * becomes a file chip. Code that only contains a name (`node scripts/build.mjs`) links that name.
 */
export function wholeFileName(code: string): string | null {
  const value = code.trim();
  if (!value || /[\n\r]/.test(value)) return null;
  if (/^(?:~\/|\/|file:\/\/|[A-Za-z]:[\\/])/.test(value))
    return plausible(value) && !/[<>"'`|*?]/.test(value) ? value : null;
  const [only, ...more] = fileMentions(value);
  const whole = only !== undefined && more.length === 0 && only.start === 0 && only.end === value.length;
  return whole ? value : null;
}

/** The key a name is cached under: the same words in another document are another name. */
export function chatFileKey(name: string, base?: string): string {
  return `${base ?? ""}\n${name}`;
}
