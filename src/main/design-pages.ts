/**
 * The design board's files, read and served by main: which pages a game's `docs/design/` holds,
 * and what a request of the Design tab's frames gets. A page is agent-written HTML, so it is served
 * as an inert document: Genex's bridge is the one script its policy runs, it reaches no network,
 * and beside the board's own pages it reads only pictures, sounds, videos and style sheets of the
 * game folder. A page's address carries its version, which changes when the page or a file it
 * shows does: a page being written reloads by itself, and only that page. Pure decisions over the
 * file system; `index.ts` turns them into responses.
 */
import { createHash, randomBytes } from "node:crypto";
import type { Dirent } from "node:fs";
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { compareIds } from "../shared/compare-ids.ts";
import {
  DESIGN_DROPS,
  DESIGN_FOLDER,
  DESIGN_SCHEME,
  designItemFile,
  DesignItemKind,
  designItemKind,
  designPageFile,
  designSection,
  DesignTheme,
  titleWords,
} from "../shared/design-board.ts";
import { assetFormat, type AssetKind } from "../shared/game-assets.ts";
import { DESIGN_BRIDGE, DESIGN_FONTS, DESIGN_FONTS_PATH, designPageStyle } from "./design-bridge.ts";
import { HttpStatus, resolveServed, servedRelative } from "./page-serve.ts";

export { DESIGN_BRIDGE } from "./design-bridge.ts";

/** The most artboards the canvas lays out; a board with more shows its first, in the board's order. */
export const DESIGN_ITEMS_MAX = 60;
/** The largest page served: past this a file is a dump, not a page. */
const DESIGN_PAGE_MAX_BYTES = 4 * 1024 * 1024;
/** How much of a board the stamp reads: folders this deep, this many files. */
const STAMP_DEPTH_MAX = 4;
const STAMP_FILES_MAX = 400;
/** The stamp's length, in hex characters. */
const STAMP_CHARS = 12;
/** A game's host on the board's scheme: random bytes, as hex. */
const HOST_BYTES = 12;
/** How many of the files a page shows count toward its version; a page that names more reloads for its first. */
const SHOWN_FILES_MAX = 64;

/** The kinds of the game's media a page may show. */
const MEDIA_KINDS: readonly AssetKind[] = ["image", "audio", "video"];
const HTML_TYPE = "text/html; charset=utf-8";
const CSS_TYPE = "text/css; charset=utf-8";
/** Folders of a game no page reads from, beside every hidden one. */
const CLOSED_FOLDERS: readonly string[] = ["node_modules"];
/** The schemes a frame of the app's window may load: the board's and plugin panels'. */
const FRAME_SCHEMES: readonly string[] = [`${DESIGN_SCHEME}:`, "studio-plugin:"];

/** An artboard of a board as main lists it, before it has an address. */
export interface DesignItemFile {
  file: string;
  name: string;
  kind: DesignItemKind;
  /** The board's folder it is in; empty at the board's top. */
  section: string;
  /** The title the page gives itself; empty for a page with none. */
  title: string;
  /** What changes when the page, or a file it shows, does. */
  version: string;
  modifiedAt: number;
}

/** What a page's text says about it: its title, and the game's files it shows. */
interface PageFacts {
  title: string;
  shows: string[];
}

/**
 * What main read in the pages it listed, by a page's path: a page of the same size and time is not
 * read again. One per lister (`DesignBoardService`); a listing drops its board's pages that are gone.
 */
export type DesignPageFacts = Map<string, PageFacts & { size: number; mtimeMs: number }>;

/** What a request for a board's file gets: the file, or a refusal that read nothing. */
export type DesignServed =
  | { status: typeof HttpStatus.Ok; type: string; body: { text: string } | { file: string } }
  | { status: typeof HttpStatus.BadRequest | typeof HttpStatus.Forbidden | typeof HttpStatus.NotFound };

const REFUSED = { status: HttpStatus.Forbidden } as const;

const boardFolder = (gameRoot: string): string => path.join(gameRoot, ...DESIGN_FOLDER.split("/"));

/** Whether every folder from the game down to the board is a real folder, never a link. */
async function boardIsFolder(gameRoot: string): Promise<boolean> {
  let folder = gameRoot;
  for (const part of DESIGN_FOLDER.split("/")) {
    folder = path.join(folder, part);
    const kind = await lstat(folder).catch(() => null);
    if (!kind?.isDirectory()) return false;
  }
  return true;
}

/** The files of a board, at most `STAMP_FILES_MAX` of them, as posix paths below the board. */
async function boardFiles(folder: string, below = "", depth = 0, found: string[] = []): Promise<string[]> {
  const entries: Dirent[] = await readdir(path.join(folder, below), { withFileTypes: true }).catch(() => []);
  for (const entry of entries.sort((a, b) => compareIds(a.name, b.name))) {
    if (found.length >= STAMP_FILES_MAX) break;
    const at = below ? `${below}/${entry.name}` : entry.name;
    if (entry.isFile()) found.push(at);
    if (entry.isDirectory() && depth < STAMP_DEPTH_MAX) await boardFiles(folder, at, depth + 1, found);
  }
  return found;
}

/** The few named characters a title is written with, as their own. */
const TITLE_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  "#39": "'",
};

/** The title a page gives itself, in plain words; empty for a page with none. */
function pageTitle(html: string): string {
  const [, raw = ""] = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html) ?? [];
  const named = (whole: string, name: string): string => TITLE_ENTITIES[name.toLowerCase()] ?? whole;
  return titleWords(raw.replace(/&(#39|[a-z]+);/gi, named));
}

/** Every address a page's text names: its tags' `src`, `href` and `poster`, and its styles' `url()`. */
const NAMED_ADDRESS =
  /\b(?:src|href|poster)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+))|url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s"']+))\s*\)/gi;
/** An address with a scheme or a host of its own: never a file of the game. */
const ELSEWHERE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

/** The game's file an address on a page names, as a path from the game folder; null for one that is not the game's. */
function namedFile(address: string, pageFolder: string): string | null {
  const [plain = ""] = address.trim().split(/[?#]/);
  if (!plain || ELSEWHERE.test(plain)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(plain);
  } catch {
    return null;
  }
  const from = decoded.startsWith("/") ? decoded.slice(1) : `${pageFolder}/${decoded}`;
  const relative = path.posix.normalize(from);
  return relative.startsWith("..") || path.posix.isAbsolute(relative) ? null : relative;
}

/**
 * The game's files a page shows: the media and style sheets its text names, as paths a frame may
 * be served (`servedType`), at most `SHOWN_FILES_MAX`. Another page it links to is not shown on it.
 */
function pageShows(html: string, file: string): string[] {
  const shows = new Set<string>();
  const pageFolder = path.posix.dirname(file);
  for (const match of html.matchAll(NAMED_ADDRESS)) {
    if (shows.size >= SHOWN_FILES_MAX) break;
    const address = match.slice(1).find((group) => group !== undefined) ?? "";
    const named = namedFile(address, pageFolder);
    const type = named ? servedType(named) : null;
    if (named && type && type !== HTML_TYPE) shows.add(named);
  }
  return [...shows];
}

/** What a page says about itself, read once for each size and time its file has had. */
async function pageFacts(
  at: string,
  file: string,
  info: { size: number; mtimeMs: number },
  known: DesignPageFacts,
): Promise<PageFacts> {
  const read = known.get(at);
  if (read && read.size === info.size && read.mtimeMs === info.mtimeMs) return read;
  const html = info.size > DESIGN_PAGE_MAX_BYTES ? "" : await readFile(at, "utf8").catch(() => "");
  const facts = { size: info.size, mtimeMs: info.mtimeMs, title: pageTitle(html), shows: pageShows(html, file) };
  known.set(at, facts);
  return facts;
}

/** A page's version: its own file's mark, and each file it shows as it is now (never through a link), there or not. */
async function pageVersion(gameRoot: string, mark: string, shows: readonly string[]): Promise<string> {
  const hash = createHash("sha256").update(mark);
  for (const shown of shows) {
    const info = await lstat(path.join(gameRoot, ...shown.split("/"))).catch(() => null);
    hash.update(info?.isFile() ? `${shown}\n${info.size}\n${info.mtimeMs}\n` : `${shown}\n-\n`);
  }
  return hash.digest("hex").slice(0, STAMP_CHARS);
}

/** A file's name without its folder and its extension: an artboard's caption when it has no title. */
const itemName = (file: string): string => path.posix.basename(file).replace(/\.[^.]+$/, "");

/** Where a section stands among the others: the board's top first, what the person dropped last. */
function sectionRank(section: string): number {
  if (section === "") return 0;
  return section === DESIGN_DROPS ? 2 : 1;
}

/**
 * The board's order: the artboards at its top first, then section by section by name (the person's
 * own section last), each by its file's name.
 */
function byPlace(a: DesignItemFile, b: DesignItemFile): number {
  if (a.section !== b.section) {
    const rank = sectionRank(a.section) - sectionRank(b.section);
    return rank === 0 ? compareIds(a.section, b.section) : rank;
  }
  return compareIds(a.file, b.file);
}

/**
 * A game's board: the pages, pictures and models at the top of its `docs/design/` and in each
 * folder of it, a section (never a link, never a hidden file, never the support folder), each with
 * its title and its version, and a stamp that changes when any file of the board or any artboard's
 * version does. `known` keeps what was read in a page between listings.
 */
export async function listDesignBoard(
  gameRoot: string,
  known: DesignPageFacts = new Map(),
): Promise<{ items: DesignItemFile[]; stamp: string }> {
  if (!(await boardIsFolder(gameRoot))) return { items: [], stamp: "" };
  const folder = boardFolder(gameRoot);
  const files = await boardFiles(folder);
  const hash = createHash("sha256");
  const items: DesignItemFile[] = [];
  const listed = new Set<string>();
  for (const below of files) {
    const at = path.join(folder, below);
    const info = await stat(at).catch(() => null);
    if (!info) continue;
    const mark = `${below}\n${info.size}\n${info.mtimeMs}\n`;
    hash.update(mark);
    const file = designItemFile(below);
    const kind = file ? designItemKind(file) : null;
    if (!file || !kind) continue;
    listed.add(at);
    const page = kind === DesignItemKind.Page ? await pageFacts(at, file, info, known) : { title: "", shows: [] };
    const version = await pageVersion(gameRoot, mark, page.shows);
    hash.update(version);
    const section = designSection(file);
    items.push({ file, name: itemName(file), title: page.title, kind, section, version, modifiedAt: info.mtimeMs });
  }
  for (const at of known.keys()) if (at.startsWith(folder + path.sep) && !listed.has(at)) known.delete(at);
  return { items: items.sort(byPlace).slice(0, DESIGN_ITEMS_MAX), stamp: hash.digest("hex").slice(0, STAMP_CHARS) };
}

/** The font file a frame asks for at Genex's reserved folder of the scheme, or null for any other address. */
export function designFontFile(pathname: string): string | null {
  if (!pathname.startsWith(DESIGN_FONTS_PATH)) return null;
  const name = pathname.slice(DESIGN_FONTS_PATH.length);
  return Object.values<string>(DESIGN_FONTS).includes(name) ? name : null;
}

/** What a path of the game folder is to a page: a page of the board, media, a style sheet, or nothing it may read. */
function servedType(relative: string): string | null {
  const parts = relative.split("/");
  const closed = parts.some((part) => !part || part.startsWith(".") || CLOSED_FOLDERS.includes(part));
  if (closed || relative.includes("\\")) return null;
  if (designPageFile(relative) === relative) return HTML_TYPE;
  if (/\.css$/i.test(relative)) return CSS_TYPE;
  const format = assetFormat(relative);
  return format && MEDIA_KINDS.includes(format.kind) ? format.mime : null;
}

/**
 * What a frame's request for `pathname` gets from the game at `gameRoot`. Only a page of the board,
 * or media or a style sheet of the game, is read, and only where both the name asked for and the
 * real file it leads to are one: a link to a file a page may not read is refused as that file is.
 */
export async function serveDesignFile(
  gameRoot: string,
  pathname: string,
  theme: DesignTheme = DesignTheme.Dark,
): Promise<DesignServed> {
  const relative = servedRelative(pathname);
  if (relative === null) return { status: HttpStatus.BadRequest };
  const type = servedType(relative);
  if (!type) return REFUSED;
  const served = await resolveServed(gameRoot, relative);
  if (!served.ok) return { status: served.status };
  const realRoot = await realpath(gameRoot).catch(() => null);
  const realRelative = realRoot ? path.relative(realRoot, served.path).split(path.sep).join("/") : "";
  if (servedType(realRelative) !== type) return REFUSED;
  const info = await stat(served.path).catch(() => null);
  if (!info?.isFile()) return REFUSED;
  if (type !== HTML_TYPE) return { status: HttpStatus.Ok, type, body: { file: served.path } };
  if (info.size > DESIGN_PAGE_MAX_BYTES) return REFUSED;
  const text = await readFile(served.path, "utf8");
  return { status: HttpStatus.Ok, type, body: { text: withDesignBridge(text, theme) } };
}

/** Where an opening tag that starts at `from` ends, reading past `>` inside its quoted values; -1 when it never does. */
function tagEnd(html: string, from: number): number {
  let quote = "";
  for (let at = from; at < html.length; at += 1) {
    const char = html[at];
    if (quote) {
      if (char === quote) quote = "";
    } else if (char === '"' || char === "'") quote = char;
    else if (char === ">") return at + 1;
  }
  return -1;
}

/** Just past the first opening tag named `name` (or the doctype), or -1 when the page has none. */
function afterTag(html: string, name: string): number {
  const start = html.search(new RegExp(`<${name}(?=[\\s>/])`, "i"));
  return start < 0 ? -1 : tagEnd(html, start);
}

/** What goes on a served page: Genex's default styles in the app's look, then its bridge. */
const onPage = (theme: DesignTheme): string =>
  `<style>${designPageStyle(theme)}</style><script>${DESIGN_BRIDGE}</script>`;

/**
 * The page with Genex's styles and bridge in it, before anything of the page's own: first in its
 * head, else just inside its html element, else after its doctype (never before it: a page keeps
 * its mode), else at its start. The page's own text is left whole.
 */
export function withDesignBridge(html: string, theme: DesignTheme = DesignTheme.Dark): string {
  const places = [afterTag(html, "head"), afterTag(html, "html"), afterTag(html, "!doctype")];
  const at = places.find((place) => place >= 0) ?? 0;
  return `${html.slice(0, at)}${onPage(theme)}${html.slice(at)}`;
}

/** The bridge's hash, as a page's policy names it: the only script a page runs. */
const BRIDGE_HASH = createHash("sha256").update(DESIGN_BRIDGE).digest("base64");

/**
 * A design page's policy: Genex's bridge by its hash and no other script (none of the page's own,
 * inline or in a file), styles of its own, media only from the board's scheme, and no network,
 * frame, form or base. `sandbox` keeps a page that is opened outside a frame just as closed.
 */
export function designCsp(): string {
  return [
    "default-src 'none'",
    `script-src 'sha256-${BRIDGE_HASH}'`,
    `style-src ${DESIGN_SCHEME}: 'unsafe-inline'`,
    `img-src ${DESIGN_SCHEME}: data:`,
    `media-src ${DESIGN_SCHEME}:`,
    `font-src ${DESIGN_SCHEME}: data:`,
    "connect-src 'none'",
    "frame-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "sandbox allow-scripts",
  ].join("; ");
}

/** A media file or style sheet opened as a document: it runs nothing and loads nothing. */
const DESIGN_FILE_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

/** The headers of a served file: its type and nothing sniffed, its policy, and never a cached copy of a file being rewritten. */
export function designHeaders(served: Extract<DesignServed, { status: typeof HttpStatus.Ok }>): Record<string, string> {
  return {
    "Content-Type": served.type,
    "Content-Security-Policy": "text" in served.body ? designCsp() : DESIGN_FILE_CSP,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
  };
}

/**
 * Which game a host of the board's scheme is, for this launch: a random name per game, so a page
 * cannot name another game's board, and a game's folder name never has to be a valid host.
 */
export class DesignHosts {
  readonly #hosts = new Map<string, string>();
  readonly #projects = new Map<string, string>();

  /** The game's host, made the first time it is asked for. */
  hostFor(project: string): string {
    const known = this.#hosts.get(project);
    if (known) return known;
    const host = randomBytes(HOST_BYTES).toString("hex");
    this.#hosts.set(project, host);
    this.#projects.set(host, project);
    return host;
  }

  /** The game a host was made for, or null for a host this launch never made. */
  projectOf(host: string): string | null {
    return this.#projects.get(host) ?? null;
  }
}

/** An artboard's address, for a page's frame or a picture: its game's host, its file, and its version so a change reloads it. */
export function designPageUrl(host: string, file: string, version: string): string {
  return `${DESIGN_SCHEME}://${host}/${file.split("/").map(encodeURIComponent).join("/")}?v=${version}`;
}

/** Whether a frame inside the app's window may load `url`: only the board's pages and plugin panels. */
export function subframeMayLoad(url: string): boolean {
  if (url === "about:blank" || url === "about:srcdoc") return true;
  return FRAME_SCHEMES.some((scheme) => url.startsWith(`${scheme}//`));
}
