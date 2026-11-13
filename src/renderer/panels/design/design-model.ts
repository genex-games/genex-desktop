/**
 * The design wall's rules, pure: how large a page hangs, where each page goes, what its caption
 * says, whether the board holds something the person has not seen, and which page the tab was
 * asked to bring into view. `DesignStage.tsx` draws them.
 */
import { DesignItemKind } from "../../../shared/design-board.ts";
import { MINUTE_MS } from "../../../shared/duration.ts";
import type { CanvasBounds } from "../../canvas-view.ts";

/** A page's sheet before it says what it holds: a landscape page that reads at a glance. */
export const PAGE_WIDTH = 1200;
export const PAGE_HEIGHT = 800;
/** The largest sheet the wall hangs; a page that asks for more is cut at this. */
export const PAGE_MAX_WIDTH = 4000;
export const PAGE_MAX_HEIGHT = 12_000;
/**
 * The room between two artboards of a row and between two rows (captions keep their size on screen,
 * so a far canvas needs more room above them), the room an artboard's caption takes above it, the
 * room a section's name takes above its artboards, the room between two sections, and how wide a
 * row grows before the next artboard starts a new one.
 */
const PAGE_GAP = 120;
const ROW_GAP = 220;
export const CAPTION_HEIGHT = 44;
export const SECTION_LABEL_HEIGHT = 110;
const SECTION_GAP = 320;
const ROW_MAX_WIDTH = 5400;
/** A picture's height on the canvas, large enough to be seen and felt beside a page, and the widths it keeps between. */
const PICTURE_HEIGHT = 760;
const PICTURE_MIN_WIDTH = 480;
const PICTURE_MAX_WIDTH = 1800;
/** A picture's shape before it has loaded. */
const PICTURE_ASPECT = 16 / 9;
/** A 3D model's tile: a square as tall as a picture. */
export const MODEL_SIZE: PageSize = { width: PICTURE_HEIGHT, height: PICTURE_HEIGHT };

/** A page's size on the wall, in the wall's own pixels. */
export interface PageSize {
  width: number;
  height: number;
}

/** Where one page hangs: its sheet's corner and size; its caption sits in the room above. */
export interface WallFrame extends PageSize {
  file: string;
  x: number;
  y: number;
}

/** A reported length kept between the sheet's own and the wall's limit; anything that is no length is the sheet's own. */
function sheetLength(reported: number, least: number, most: number): number {
  return Number.isFinite(reported) ? Math.min(most, Math.max(least, Math.ceil(reported))) : least;
}

/**
 * A page's size after it reported what it holds: at least a sheet, at most the wall's limit, and
 * never smaller than it was. A page fills the frame it is given, so what it reports can only say
 * that it needs more; shrinking with it would make the two chase each other.
 */
export function sizeAfter(previous: PageSize | undefined, reported: PageSize | null): PageSize {
  const width = sheetLength(reported?.width ?? PAGE_WIDTH, PAGE_WIDTH, PAGE_MAX_WIDTH);
  const height = sheetLength(reported?.height ?? PAGE_HEIGHT, PAGE_HEIGHT, PAGE_MAX_HEIGHT);
  return { width: Math.max(width, previous?.width ?? 0), height: Math.max(height, previous?.height ?? 0) };
}

/** A picture's size on the canvas: one height for all, its own shape across, within the widths a row can hold. */
export function pictureSize(natural: PageSize | undefined): PageSize {
  const sound = natural && natural.width > 0 && natural.height > 0;
  const aspect = sound ? natural.width / natural.height : PICTURE_ASPECT;
  const width = Math.round(Math.min(PICTURE_MAX_WIDTH, Math.max(PICTURE_MIN_WIDTH, PICTURE_HEIGHT * aspect)));
  return { width, height: PICTURE_HEIGHT };
}

/** Where a section's name stands: above its first row, on the artboard that starts it. */
export interface SectionLabel {
  section: string;
  /** The section's first artboard. */
  file: string;
  x: number;
  y: number;
}

/** One row being filled: where its next artboard goes and how tall its tallest is. */
interface Row {
  x: number;
  top: number;
  height: number;
}

/**
 * The canvas: artboards in the board's order, section under section. A section's name stands above
 * its artboards (the board's top has none), which run in rows that wrap once a row is
 * `ROW_MAX_WIDTH` wide, each row hanging from one line with every caption's room above it. `bounds`
 * is what a fit has to show; null for an empty canvas.
 */
export function boardLayout(items: ReadonlyArray<PageSize & { file: string; section: string }>): {
  frames: WallFrame[];
  labels: SectionLabel[];
  bounds: CanvasBounds | null;
} {
  const frames: WallFrame[] = [];
  const labels: SectionLabel[] = [];
  let wide = 0;
  let row: Row = { x: 0, top: 0, height: 0 };
  let section: string | null = null;
  for (const item of items) {
    if (item.section !== section) {
      const below = section === null ? 0 : row.top + CAPTION_HEIGHT + row.height + SECTION_GAP;
      if (item.section) labels.push({ section: item.section, file: item.file, x: 0, y: below });
      row = { x: 0, top: below + (item.section ? SECTION_LABEL_HEIGHT : 0), height: 0 };
      section = item.section;
    } else if (row.x + item.width > ROW_MAX_WIDTH) {
      row = { x: 0, top: row.top + CAPTION_HEIGHT + row.height + ROW_GAP, height: 0 };
    }
    frames.push({ file: item.file, x: row.x, y: row.top + CAPTION_HEIGHT, width: item.width, height: item.height });
    wide = Math.max(wide, row.x + item.width);
    row = { x: row.x + item.width + PAGE_GAP, top: row.top, height: Math.max(row.height, item.height) };
  }
  if (frames.length === 0) return { frames, labels, bounds: null };
  return { frames, labels, bounds: { x: 0, y: 0, w: wide, h: row.top + CAPTION_HEIGHT + row.height } };
}

/**
 * A file's or a section's name as the person reads it: its dashes and underscores as spaces, the
 * number that only orders it gone, and a capital first: `01-the-warden` is "The warden".
 */
export function displayName(name: string): string {
  const words = name
    .replace(/^\d+[-_. ]+/, "")
    .replace(/[-_]+/g, " ")
    .trim();
  const shown = words || name;
  return shown.charAt(0).toUpperCase() + shown.slice(1);
}

/** An artboard's caption: the title its frame says, else the one its file gives, else its file's name as it reads. */
export function pageCaption(page: { name: string; title?: string }, told: string | undefined): string {
  return told?.trim() || page.title?.trim() || displayName(page.name);
}

/**
 * Which addresses a page's sheet frames: the one it shows, and, once the page changed, the new one
 * loading behind it (`next`). The old sheet stays up until the new one has loaded, so a page being
 * written never blinks through an empty sheet. A page with nothing held shows its address at once.
 */
export function heldFrames(held: string | undefined, url: string): { shown: string; next: string | null } {
  if (held === undefined || held === url) return { shown: url, next: null };
  return { shown: held, next: url };
}

/**
 * What the wall holds up after its board was read again: every page's shown address as it was, a
 * page that is new to the wall at its own, and nothing for a page that left. The same record when
 * nothing was added or dropped.
 */
export function heldAfter(
  held: Readonly<Record<string, string>>,
  pages: ReadonlyArray<{ file: string; url: string }>,
): Readonly<Record<string, string>> {
  const same = pages.length === Object.keys(held).length && pages.every((page) => page.file in held);
  if (same) return held;
  return Object.fromEntries(pages.map((page) => [page.file, held[page.file] ?? page.url]));
}

/**
 * The artboards that are new or changed since the board was last read: every file whose address is
 * not the one it had. Nothing is new on a board read for the first time (`before` null).
 */
export function changedFiles(
  before: ReadonlyMap<string, string> | null,
  items: ReadonlyArray<{ file: string; url: string }>,
): string[] {
  if (!before) return [];
  return items.filter((item) => before.get(item.file) !== item.url).map((item) => item.file);
}

/** How many artboards the board's block in the chat stacks. */
const STACK_ITEMS = 3;

/**
 * The artboards the board's block in the chat stacks: the one that was shown on top, then the
 * others, pictures before the rest and what changed last first, three at most. Nothing when the
 * board no longer holds the shown one.
 */
export function boardStack<Item extends { file: string; modifiedAt: number; kind: string }>(
  items: readonly Item[],
  shown: string,
): Item[] {
  const top = items.find((item) => item.file === shown);
  if (!top) return [];
  const seen = (item: Item): number => (item.kind === DesignItemKind.Picture ? 1 : 0);
  const others = items.filter((item) => item !== top).sort((a, b) => seen(b) - seen(a) || b.modifiedAt - a.modifiedAt);
  return [top, ...others].slice(0, STACK_ITEMS);
}

/** The most models the canvas turns by itself: each is a 3D scene of its own, and a browser keeps only so many. */
export const MODELS_TURNED_MAX = 4;

/**
 * The models the canvas shows turning without a press: the board's first few, in its order. A
 * model past that waits as a tile until the person presses it.
 */
export function turnedModels(items: readonly { file: string; kind: string }[]): ReadonlySet<string> {
  const models = items.filter((item) => item.kind === DesignItemKind.Model).slice(0, MODELS_TURNED_MAX);
  return new Set(models.map((item) => item.file));
}

/**
 * The canvas with the artboards the person moved: one that has a place hangs there, and the others
 * are laid out as if it were not on the board (`boardLayout`), so a section's name stands on its
 * first artboard that was not moved. Frames stay in the board's order, and `bounds` takes in
 * everything, a moved artboard's caption included.
 */
export function placedLayout(
  items: ReadonlyArray<PageSize & { file: string; section: string }>,
  places: Readonly<Record<string, { x: number; y: number }>>,
): ReturnType<typeof boardLayout> {
  const placeOf = (file: string): { x: number; y: number } | undefined =>
    Object.hasOwn(places, file) ? places[file] : undefined;
  const auto = boardLayout(items.filter((item) => !placeOf(item.file)));
  const hung = new Map(auto.frames.map((frame) => [frame.file, frame]));
  let left = auto.bounds?.x ?? Number.POSITIVE_INFINITY;
  let top = auto.bounds?.y ?? Number.POSITIVE_INFINITY;
  let right = auto.bounds ? auto.bounds.x + auto.bounds.w : Number.NEGATIVE_INFINITY;
  let bottom = auto.bounds ? auto.bounds.y + auto.bounds.h : Number.NEGATIVE_INFINITY;
  for (const item of items) {
    const place = placeOf(item.file);
    if (!place) continue;
    hung.set(item.file, { file: item.file, x: place.x, y: place.y, width: item.width, height: item.height });
    left = Math.min(left, place.x);
    top = Math.min(top, place.y - CAPTION_HEIGHT);
    right = Math.max(right, place.x + item.width);
    bottom = Math.max(bottom, place.y + item.height);
  }
  const frames = items.flatMap((item) => hung.get(item.file) ?? []);
  const bounds = frames.length === 0 ? null : { x: left, y: top, w: right - left, h: bottom - top };
  return { frames, labels: auto.labels, bounds };
}

/** How long what an agent said it is making stays on the canvas while its file has not arrived. */
export const MAKING_FRESH_MS = 15 * MINUTE_MS;

/**
 * The artboards still to come of what an agent said it is making: the ones the board does not hold
 * yet, in the order it will make them. None once the list has gone stale (an agent that never made
 * them), or when it said nothing.
 */
export function makingNow(
  said: { files: readonly string[]; at: number } | null,
  held: readonly string[],
  now: number,
): string[] {
  if (!said || now - said.at > MAKING_FRESH_MS) return [];
  return said.files.filter((file) => !held.includes(file));
}

/**
 * The board's artboards with the ones being made among them: each hangs at the end of its own
 * section, and one of a section the board does not have yet at the end of the board (a top-level
 * one after the board's other top-level artboards).
 */
export function withGhosts<Item extends { file: string; section: string }>(
  items: readonly Item[],
  ghosts: readonly Item[],
): Item[] {
  const all = [...items];
  for (const ghost of ghosts) {
    const last = all.findLastIndex((item) => item.section === ghost.section);
    const top = ghost.section === "" && last < 0;
    if (top) all.unshift(ghost);
    else all.splice(last < 0 ? all.length : last + 1, 0, ghost);
  }
  return all;
}
