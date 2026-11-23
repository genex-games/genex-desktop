/**
 * The design wall's rules, pure: how large a page hangs, where each page goes, what its caption
 * says, whether the board holds something the person has not seen, and which page the tab was
 * asked to bring into view. `DesignStage.tsx` draws them.
 */
import { DesignItemKind, displayName } from "../../../shared/design-board.ts";
import { MINUTE_MS, SECOND_MS } from "../../../shared/duration.ts";
import { CANVAS_ZOOM_PROPERTY, type CanvasBounds } from "../../canvas-view.ts";

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
/** The widest a picture hangs, however wide its own shape. */
export const PICTURE_MAX_WIDTH = 1800;
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

/** A rectangle of the canvas an artboard laid out must keep clear of: one the person put somewhere, caption included. */
export type Obstacle = CanvasBounds;

/** The most times one artboard is moved on past what is in its way, so a layout always ends. */
const STEPS_PAST_MAX = 200;

/** Whether two rectangles come closer than an artboard's gap to each other. */
function crowds(a: CanvasBounds, b: CanvasBounds): boolean {
  const apart = PAGE_GAP;
  return a.x < b.x + b.w + apart && b.x < a.x + a.w + apart && a.y < b.y + b.h + apart && b.y < a.y + a.h + apart;
}

/** What an artboard at `x` of `row` would cover: itself, its caption, and a section's name above it when it starts one. */
function roomAt(row: Row, x: number, item: PageSize, labelled: boolean): CanvasBounds {
  const above = labelled ? SECTION_LABEL_HEIGHT : 0;
  return { x, y: row.top - above, w: item.width, h: above + CAPTION_HEIGHT + item.height };
}

/** The row under `row`: below its tallest artboard, or, for a row still empty, below what blocks it. */
function rowBelow(row: Row, blocking: readonly CanvasBounds[]): Row {
  const under = row.height > 0 ? row.top + CAPTION_HEIGHT + row.height : Math.min(...blocking.map((b) => b.y + b.h));
  return { x: 0, top: Math.max(row.top + 1, under) + ROW_GAP, height: 0 };
}

/**
 * Where in `row` an artboard goes so it crowds nothing in `around`: at the row's next place, else
 * just past what is in its way, else in a row below (the row it lands in is returned with it).
 */
function clearPlace(row: Row, item: PageSize, labelled: boolean, around: readonly Obstacle[]): { row: Row; x: number } {
  let at = row;
  let x = row.x;
  for (let step = 0; step < STEPS_PAST_MAX; step += 1) {
    const room = roomAt(at, x, item, labelled);
    const blocking = around.filter((obstacle) => crowds(room, obstacle));
    if (blocking.length === 0) return { row: at, x };
    const past = Math.max(...blocking.map((obstacle) => obstacle.x + obstacle.w)) + PAGE_GAP;
    if (past + item.width <= ROW_MAX_WIDTH) {
      x = past;
      continue;
    }
    at = rowBelow(at, blocking);
    x = 0;
  }
  return { row: at, x };
}

/**
 * The canvas: artboards in the board's order, section under section. A section's name stands above
 * its artboards (the board's top has none), which run in rows that wrap once a row is
 * `ROW_MAX_WIDTH` wide, each row hanging from one line with every caption's room above it. An
 * artboard never crowds what is `around` (the ones the person put somewhere): it goes on past them.
 * `bounds` is what a fit has to show; null for an empty canvas.
 */
export function boardLayout(
  items: ReadonlyArray<PageSize & { file: string; section: string }>,
  around: readonly Obstacle[] = [],
): {
  frames: WallFrame[];
  labels: SectionLabel[];
  bounds: CanvasBounds | null;
} {
  const frames: WallFrame[] = [];
  const labels: SectionLabel[] = [];
  let wide = 0;
  let deep = 0;
  let row: Row = { x: 0, top: 0, height: 0 };
  let section: string | null = null;
  for (const item of items) {
    const starts = item.section !== section;
    if (starts) {
      const below = section === null ? 0 : row.top + CAPTION_HEIGHT + row.height + SECTION_GAP;
      row = { x: 0, top: below + (item.section ? SECTION_LABEL_HEIGHT : 0), height: 0 };
      section = item.section;
    } else if (row.x + item.width > ROW_MAX_WIDTH) {
      row = { x: 0, top: row.top + CAPTION_HEIGHT + row.height + ROW_GAP, height: 0 };
    }
    const labelled = starts && item.section !== "";
    const clear = clearPlace(row, item, labelled, around);
    row = clear.row;
    if (labelled)
      labels.push({ section: item.section, file: item.file, x: clear.x, y: row.top - SECTION_LABEL_HEIGHT });
    frames.push({ file: item.file, x: clear.x, y: row.top + CAPTION_HEIGHT, width: item.width, height: item.height });
    wide = Math.max(wide, clear.x + item.width);
    deep = Math.max(deep, row.top + CAPTION_HEIGHT + item.height);
    row = { x: clear.x + item.width + PAGE_GAP, top: row.top, height: Math.max(row.height, item.height) };
  }
  if (frames.length === 0) return { frames, labels, bounds: null };
  return { frames, labels, bounds: { x: 0, y: 0, w: wide, h: deep } };
}

/** The canvas's zoom as a mark drawn against it reads it, from the canvas's layer, in the same frame as the canvas. */
const ZOOM = `var(${CANVAS_ZOOM_PROPERTY})`;

/** The transform that undoes the canvas's zoom: what it is drawn on keeps its size on screen. */
export const UNZOOMED = `scale(calc(1 / ${ZOOM}))`;

/** A canvas width as wide as it shows on screen: the room an unzoomed caption has over an artboard. */
export const zoomedWidth = (width: number): string => `calc(${width}px * ${ZOOM})`;

/** A length that stays `px` on screen whatever the zoom, for what cannot be unzoomed by a transform (a ring). */
export const screenPx = (px: number): string => `calc(${px}px / ${ZOOM})`;

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
 * are laid out as if it were not in the board's order (`boardLayout`), going on past it wherever it
 * hangs so nothing lands on it, and a section's name stands on its first artboard that was not moved. Frames stay in the board's order, and `bounds` takes in
 * everything, a moved artboard's caption included.
 */
export function placedLayout(
  items: ReadonlyArray<PageSize & { file: string; section: string }>,
  places: Readonly<Record<string, { x: number; y: number }>>,
): ReturnType<typeof boardLayout> {
  const placeOf = (file: string): { x: number; y: number } | undefined =>
    Object.hasOwn(places, file) ? places[file] : undefined;
  const around = items.flatMap((item) => {
    const place = placeOf(item.file);
    return place ? [{ x: place.x, y: place.y - CAPTION_HEIGHT, w: item.width, h: item.height + CAPTION_HEIGHT }] : [];
  });
  const auto = boardLayout(
    items.filter((item) => !placeOf(item.file)),
    around,
  );
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
 * How long what an agent said it is making stays while no chat of its game is working: long enough
 * for the turn that said it to be seen working, short enough that a stopped turn's leave at once.
 */
export const MAKING_IDLE_MS = 10 * SECOND_MS;

/** An artboard as `makingNow` reads the board: its file, and when it last changed. */
export interface HeldFile {
  file: string;
  modifiedAt: number;
}

/**
 * The artboards still to come of what an agent said it is making, in the order it will make them:
 * the ones the board does not hold yet, and the ones it holds that have not changed since the agent
 * said it (being made again). None once the list has gone stale (an agent that never made them),
 * once no chat of the game has been working for a moment (`working`: a turn that ended or was
 * stopped), or when it said nothing.
 */
export function makingNow(
  said: { files: readonly string[]; at: number } | null,
  held: readonly HeldFile[],
  now: number,
  working = true,
): string[] {
  if (!said || makingEnded(said, now, working)) return [];
  const changedAt = new Map(held.map((item) => [item.file, item.modifiedAt]));
  return said.files.filter((file) => {
    const at = changedAt.get(file);
    return at === undefined || at < said.at;
  });
}

/**
 * Whether what an agent said it is making is over: gone stale, or said a moment before no chat of
 * the game was working any more. An ended list is forgotten, so a later turn does not revive it.
 */
export function makingEnded(said: { at: number } | null, now: number, working: boolean): boolean {
  if (!said) return true;
  const stale = now - said.at > MAKING_FRESH_MS;
  return stale || (!working && now - said.at > MAKING_IDLE_MS);
}

/** Where an artboard of the board stands in what the agent is making: drawn now, waiting its turn, or neither. */
export const Redraw = { Drawing: "drawing", Next: "next" } as const;
export type Redraw = (typeof Redraw)[keyof typeof Redraw];

/** Where `file` stands in `making`: the first is being drawn, the others wait; null for one not in it. */
export function redrawOf(making: readonly string[], file: string): Redraw | null {
  const at = making.indexOf(file);
  if (at < 0) return null;
  return at === 0 ? Redraw.Drawing : Redraw.Next;
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
