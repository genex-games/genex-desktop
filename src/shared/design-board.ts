/**
 * The design board: a game's design as files in `docs/design/`, laid out as artboards on the
 * stage's Design tab. An artboard is a page (HTML and CSS the game's agent writes), a picture or a
 * 3D model; a folder of the board is a section of it, and `from-you` holds the pictures the person
 * dropped on the canvas. Main lists and serves the board (`main/design-pages.ts`) and the tab draws
 * it (`renderer/panels/design/`). A page runs no script of its own: Genex's bridge, the one script
 * on it, tells the tab the page's title and size and what the person pressed, as the signals below.
 */
import { assetFormat } from "./game-assets.ts";

/** Where a game keeps its design pages, relative to its folder: documents, so never part of an export. */
export const DESIGN_FOLDER = "docs/design";

/** The scheme main serves a game's design pages from, to the Design tab's frames only. */
export const DESIGN_SCHEME = "genex-design";

/** What every message of a design page's bridge carries as its `source`. */
export const DESIGN_MESSAGE_SOURCE = "genex-design";

/** The longest note an agent leaves on a page's card in the chat, in characters; the rest is cut. */
export const NOTE_MAX_CHARS = 200;
/** The longest title a page's caption shows, a page's file name, and a link a page may open. */
const TITLE_MAX_CHARS = 120;
const PAGE_NAME_MAX_CHARS = 120;
const LINK_MAX_CHARS = 2000;
/** The largest size a page may report and the largest move one message may carry, in pixels. */
const REPORTED_SIZE_MAX = 100_000;
const MOVE_MAX = 10_000;

/** The section of the board that holds what the person dropped on the canvas: `docs/design/from-you/`. */
export const DESIGN_DROPS = "from-you";

/** The folder, at the board's top or inside a section, for pictures only a page needs: never a section, never artboards. */
export const DESIGN_SUPPORT_FOLDER = "img";

/** The app's two looks a page is drawn in: the value a page's address carries as `t` (dark when it carries none). */
export const DesignTheme = { Dark: "dark", Light: "light" } as const;
export type DesignTheme = (typeof DesignTheme)[keyof typeof DesignTheme];

/** A page's address in the app's look: as it is for dark, with `t=light` for light. */
export const themedPageUrl = (url: string, theme: DesignTheme): string =>
  theme === DesignTheme.Light ? `${url}&t=${DesignTheme.Light}` : url;

/** What an artboard is, by its file: never rename a value. */
export const DesignItemKind = {
  /** An HTML page, drawn in a closed frame. */
  Page: "page",
  /** A picture, shown at a size that lets it be seen. */
  Picture: "picture",
  /** A 3D model, turned in the app's own viewer. */
  Model: "model",
} as const;
export type DesignItemKind = (typeof DesignItemKind)[keyof typeof DesignItemKind];

/** One artboard of a game's board, as the Design tab reads it. */
export interface DesignItem {
  /** Its file, posix-relative to the game folder: `docs/design/world/town.png`. */
  file: string;
  /** Its file's name without the extension: its caption when it has no title. */
  name: string;
  /** The title a page gives itself (`<title>`); empty for a page with none, and for a picture or a model. */
  title: string;
  kind: DesignItemKind;
  /** Its section, the board's folder it is in; empty for an artboard at the board's top. */
  section: string;
  /** The address a page's frame or a picture loads; it changes whenever the file, or a file a page shows, does. */
  url: string;
  modifiedAt: number;
}

/** A game's board: its artboards, section by section, and a stamp that changes when any file of the board does. */
export interface DesignBoard {
  items: DesignItem[];
  stamp: string;
}

/** A spot on an artboard: percent across and percent down, each 0 to 100. */
export interface DesignSpot {
  x: number;
  y: number;
}

/**
 * The game whose agent showed the person an artboard (`show_design`): which one, its few words on
 * it, and the spot it points at, if it pointed. The `design.shown` event.
 */
export interface DesignShown {
  project: string;
  file: string;
  note: string;
  spot?: DesignSpot;
}

/** The artboards a game's agent said it is about to make, in order: the `design.making` event. */
export interface DesignMaking {
  project: string;
  files: string[];
}

/** The artboards a game's agent offers the person to pick among: the `design.choices` event. */
export interface DesignChoices {
  project: string;
  files: string[];
}

/** The most artboards an agent may say it is making at once, and may offer to pick among. */
export const MAKING_MAX = 8;
export const CHOICES_MAX = 12;

/**
 * A `design_shown` record: the page a game's agent showed the person from a chat (`show_design`),
 * as its card in that chat reads it.
 */
export interface DesignShownPayload {
  project: string;
  /** The page's file in the game folder: `docs/design/concept.html`. */
  file: string;
  /** The page's title when it was shown: what the card still says once the page is gone. */
  title: string;
  /** The agent's few words on what to look at or what changed; empty when it gave none. */
  note: string;
}

/** What a design page's frame tells the tab (a message's `type`). The bridge writes these: never rename a value. */
export const DesignSignal = {
  /** The page loaded or changed size: its title and what it needs to show whole. */
  Page: "page",
  /** The person pressed a link to another page of the board. */
  Open: "open",
  /** The person pressed a link to the web. */
  Link: "link",
  /** A wheel over the page: the wall zooms, the page never scrolls. */
  Wheel: "wheel",
  /** A drag that began on the page: the wall pans. */
  Drag: "drag",
} as const;
export type DesignSignal = (typeof DesignSignal)[keyof typeof DesignSignal];

/** A frame's message as the tab reads it: every field checked and cut, nothing else believed. */
export type DesignFrameSignal =
  | { type: typeof DesignSignal.Page; title: string; width: number; height: number }
  | { type: typeof DesignSignal.Open; file: string }
  | { type: typeof DesignSignal.Link; url: string }
  | { type: typeof DesignSignal.Wheel; dy: number; x: number; y: number; pinch: boolean }
  | { type: typeof DesignSignal.Drag; dx: number; dy: number; end: boolean };

type Fields = Record<string, unknown>;

const isRecord = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A finite number within ±`limit`, or null for anything else. */
function bounded(value: unknown, limit: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(limit, Math.max(-limit, value));
}

/** Plain words: control characters gone, trimmed, cut to `max`. */
function plainWords(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  return Array.from(value)
    .filter((char) => char === "\n" || (char.codePointAt(0) ?? 0) >= 0x20)
    .join("")
    .trim()
    .slice(0, max);
}

/** One line of plain words, cut to `max`: every run of white space is one space; anything that is no text is empty. */
function oneLine(value: unknown, max: number): string {
  return (plainWords(value, Number.MAX_SAFE_INTEGER) ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

/** A page's title as a caption shows it: one line, cut where a caption is. */
export const titleWords = (value: unknown): string => oneLine(value, TITLE_MAX_CHARS);

/** An agent's note on a shown page as its card shows it: one line, cut to `NOTE_MAX_CHARS`. */
export const noteWords = (value: unknown): string => oneLine(value, NOTE_MAX_CHARS);

/** A name on the board, a file's or a section's: no folder in it, not hidden, bounded. */
const BOARD_NAME = /^[^/\\]+$/;

function isBoardName(name: string): boolean {
  return BOARD_NAME.test(name) && name.length <= PAGE_NAME_MAX_CHARS && !name.startsWith(".");
}

/** What kind of artboard a file is, by its name: a page, a picture, a model the app can turn; null for anything else. */
export function designItemKind(file: string): DesignItemKind | null {
  if (/\.html$/i.test(file)) return DesignItemKind.Page;
  const format = assetFormat(file);
  if (format?.kind === "image" && format.preview === "image") return DesignItemKind.Picture;
  if (format?.kind === "model" && format.preview === "model") return DesignItemKind.Model;
  return null;
}

/**
 * Where on the board a reference points: a file at the board's top or in one section of it, named
 * from the game folder (`docs/design/world/town.png`, with or without `./`) or from the board
 * (`world/town.png`). Null for a reference that steps up, goes deeper, or names a hidden name or
 * the support folder.
 */
function boardPlace(reference: unknown): { section: string; name: string } | null {
  if (typeof reference !== "string") return null;
  const plain = reference.replace(/^\.\//, "");
  const below = plain.startsWith(`${DESIGN_FOLDER}/`) ? plain.slice(DESIGN_FOLDER.length + 1) : plain;
  const parts = below.split("/");
  const name = parts.pop() ?? "";
  const [section = "", ...deeper] = parts;
  if (deeper.length > 0 || !isBoardName(name)) return null;
  const sectionFits = section === "" || (isBoardName(section) && section !== DESIGN_SUPPORT_FOLDER);
  return sectionFits ? { section, name } : null;
}

/** The artboard of the board a reference names, as its file in the game folder; null for anything that is not one. */
export function designItemFile(reference: unknown): string | null {
  const place = boardPlace(reference);
  if (!place || designItemKind(place.name) === null) return null;
  return [DESIGN_FOLDER, ...(place.section ? [place.section] : []), place.name].join("/");
}

/** The page of the board a reference names, as its file in the game folder; null for anything that is not a page of it. */
export function designPageFile(reference: unknown): string | null {
  const file = designItemFile(reference);
  return file && designItemKind(file) === DesignItemKind.Page ? file : null;
}

/** The section an artboard's file is in: the board's folder that holds it, empty at the board's top. */
export const designSection = (file: string): string => boardPlace(file)?.section ?? "";

/**
 * The board's page a file name written in a chat means: the page's own path from the game folder
 * (with or without `./`), named from no other folder (`base`); null for any other name. A press on
 * such a name opens the Design tab on the page.
 */
export function namedDesignPage(name: string, base?: string | null): string | null {
  if (base) return null;
  const plain = name.replace(/^\.\//, "");
  return designPageFile(plain) === plain ? plain : null;
}

/** Only numbers, their separators and percent signs: how a spot is written. */
const SPOT_WORDS = /^[\s\d.,%+-]+$/;
const SPOT_NUMBER = /-?\d+(?:\.\d+)?/g;

/** A share of an artboard as a whole percentage within it; null for anything that is no finite number. */
function percentOf(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.round(Math.min(100, Math.max(0, value)));
}

/** The two numbers a spot is written with, or null when it is written with any other count of them. */
function spotNumbers(value: unknown): [unknown, unknown] | null {
  if (typeof value === "string") {
    const numbers = SPOT_WORDS.test(value) ? (value.match(SPOT_NUMBER) ?? []).map(Number) : [];
    return numbers.length === 2 ? [numbers[0], numbers[1]] : null;
  }
  if (Array.isArray(value)) return value.length === 2 ? [value[0], value[1]] : null;
  if (typeof value !== "object" || value === null) return null;
  const { x, y } = value as { x?: unknown; y?: unknown };
  return [x, y];
}

/**
 * A spot as an agent wrote it ("40,70", "40% 70%", an x and a y, a pair of numbers): percent across
 * and percent down, kept within the artboard. Null for anything else.
 */
export function readDesignSpot(value: unknown): DesignSpot | null {
  const numbers = spotNumbers(value);
  const x = percentOf(numbers?.[0]);
  const y = percentOf(numbers?.[1]);
  return x === null || y === null ? null : { x, y };
}

/** What stands between two artboard names written as one text: a line break or a comma. */
const NAME_BREAK = /[\n,]+/;

/**
 * Artboards as an agent named them (a list, or names one to a line or between commas), as the
 * board's own files: each once, `most` at most.
 */
export function readDesignFiles(value: unknown, most: number): string[] {
  const named = typeof value === "string" ? value.split(NAME_BREAK).map((name) => name.trim()) : value;
  const files = (Array.isArray(named) ? named : []).flatMap((one) => designItemFile(one) ?? []);
  return [...new Set(files)].slice(0, most);
}

/** The artboards an agent said it is about to make. */
export const readDesignMaking = (value: unknown): string[] => readDesignFiles(value, MAKING_MAX);

/** A record's card, or null for an old or partial one that names no game or no artboard of a board. */
export function readDesignShown(payload: Partial<DesignShownPayload> | null): DesignShownPayload | null {
  const file = designItemFile(payload?.file);
  const project = payload?.project;
  if (!file || file !== payload?.file || typeof project !== "string" || !project) return null;
  return { project, file, title: titleWords(payload.title), note: noteWords(payload.note) };
}

/** An address on the web a page may send the person to: https only. */
function webLink(value: unknown): string | null {
  if (typeof value !== "string" || value.length > LINK_MAX_CHARS) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

const READERS: Record<DesignSignal, (fields: Fields) => DesignFrameSignal | null> = {
  [DesignSignal.Page]: ({ title, width, height }) => {
    const words = plainWords(title, TITLE_MAX_CHARS);
    const wide = bounded(width, REPORTED_SIZE_MAX);
    const tall = bounded(height, REPORTED_SIZE_MAX);
    if (words === null || wide === null || tall === null) return null;
    return { type: DesignSignal.Page, title: words, width: Math.ceil(wide), height: Math.ceil(tall) };
  },
  [DesignSignal.Open]: ({ file }) =>
    designPageFile(file) === file && typeof file === "string" ? { type: DesignSignal.Open, file } : null,
  [DesignSignal.Link]: ({ url }) => {
    const link = webLink(url);
    return link ? { type: DesignSignal.Link, url: link } : null;
  },
  [DesignSignal.Wheel]: ({ dy, x, y, pinch }) => {
    const turn = bounded(dy, MOVE_MAX);
    const left = bounded(x, REPORTED_SIZE_MAX);
    const top = bounded(y, REPORTED_SIZE_MAX);
    if (turn === null || left === null || top === null) return null;
    return { type: DesignSignal.Wheel, dy: turn, x: left, y: top, pinch: pinch === true };
  },
  [DesignSignal.Drag]: ({ dx, dy, end }) => {
    const across = bounded(dx, MOVE_MAX);
    const down = bounded(dy, MOVE_MAX);
    if (across === null || down === null) return null;
    return { type: DesignSignal.Drag, dx: across, dy: down, end: end === true };
  },
};

/** A design page's message, read as data: null for anything that is not one of the signals above. */
export function readDesignSignal(data: unknown): DesignFrameSignal | null {
  if (!isRecord(data) || data.source !== DESIGN_MESSAGE_SOURCE) return null;
  const { type } = data;
  if (typeof type !== "string" || !Object.hasOwn(READERS, type)) return null;
  const reader = Object.entries(READERS).find(([name]) => name === type)?.[1];
  return reader ? reader(data) : null;
}
