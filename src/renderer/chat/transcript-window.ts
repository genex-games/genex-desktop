/**
 * The transcript's variable-height window, as arithmetic: where each row starts, how tall a row
 * not yet measured is guessed to be, which rows are mounted around the viewport, how far the
 * scroll must move to keep the top row in place when rows above it change height, which line the
 * reader is on while the chat's width changes, and when earlier history loads ahead of the reader.
 */

/** A row's height before anything has been measured, in pixels. */
export const ESTIMATED_ROW_PX = 100;
/**
 * Rows mount this many screens ahead of the viewport, both ways. A fast fling outruns a frame
 * the GPU is slow to draw (a heavy game in Live beside the chat): rows mounted screens ahead
 * are drawn before they scroll into view, where rows mounted just in time show as a blank block.
 */
export const MOUNT_SCREENS = 3;
/** Mounted rows stay until they are this many screens away, so a reader scrolling back finds them drawn. */
export const KEEP_SCREENS = 4;
/** The viewport assumed until the scroller has been measured, in pixels. */
export const INITIAL_VIEWPORT: TranscriptViewport = { top: 0, height: 900 };
/** Within this many screens of the loaded top, the next page of earlier history loads. */
export const LOAD_AHEAD_SCREENS = 3;

/** The visible part of the transcript, in its own coordinates. */
export interface TranscriptViewport {
  top: number;
  height: number;
}

/** Mounted rows, from `start` up to but not including `end`. */
export interface RowRange {
  start: number;
  end: number;
}

/** A laid-out transcript: its row ids and where each starts, the total height last. */
export interface TranscriptLayout {
  ids: readonly string[];
  offsets: readonly number[];
}

/** What a row's height is guessed from before it is measured: its kind, and how much it holds (1 for a row of one size). */
export interface RowSize {
  kind: string;
  weight: number;
}

/** Each row's top, then the total height: a measured row counts its height, others their `estimate`. */
export function rowOffsets<T extends { id: string }>(
  items: readonly T[],
  heights: ReadonlyMap<string, number>,
  estimate: (item: T) => number = () => ESTIMATED_ROW_PX,
): number[] {
  const offsets = [0];
  let top = 0;
  for (const item of items) {
    top += heights.get(item.id) ?? estimate(item);
    offsets.push(top);
  }
  return offsets;
}

/**
 * Guesses an unmeasured row's height from the rows already measured: rows of its kind give the
 * height per unit of weight, a kind never measured takes the average measured row, and before
 * anything is measured every row is `ESTIMATED_ROW_PX`. Close guesses keep the rows above the
 * reader where they will measure, so the scroll is not corrected as they mount.
 */
export function heightEstimate<T extends { id: string }>(
  items: readonly T[],
  heights: ReadonlyMap<string, number>,
  sizeOf: (item: T) => RowSize,
): (item: T) => number {
  const kinds = new Map<string, { height: number; weight: number }>();
  let total = 0;
  let count = 0;
  for (const item of items) {
    const height = heights.get(item.id);
    if (height === undefined) continue;
    const { kind, weight } = sizeOf(item);
    const sum = kinds.get(kind) ?? { height: 0, weight: 0 };
    sum.height += height;
    sum.weight += weight;
    kinds.set(kind, sum);
    total += height;
    count++;
  }
  const average = count ? total / count : ESTIMATED_ROW_PX;
  return (item) => {
    const { kind, weight } = sizeOf(item);
    const sum = kinds.get(kind);
    return sum?.weight ? (sum.height / sum.weight) * weight : average;
  };
}

/** Every row with some part within `reach` pixels of the viewport. */
function rowsNear(offsets: readonly number[], viewport: TranscriptViewport, reach: number): RowRange {
  const count = offsets.length - 1;
  const top = (index: number): number => offsets[index] ?? 0;
  let start = 0;
  while (start < count && top(start + 1) <= viewport.top - reach) start++;
  let end = start;
  while (end < count && top(end) < viewport.top + viewport.height + reach) end++;
  return { start, end };
}

/**
 * The rows to mount: every row within `MOUNT_SCREENS` of the viewport, and of the rows mounted
 * before (`previous`), those still within `KEEP_SCREENS`. A jump far away mounts only its own
 * neighbourhood.
 */
export function mountedRange(offsets: readonly number[], viewport: TranscriptViewport, previous?: RowRange): RowRange {
  const wanted = rowsNear(offsets, viewport, viewport.height * MOUNT_SCREENS);
  const touches = previous && previous.start <= wanted.end && previous.end >= wanted.start;
  if (!touches) return wanted;
  const kept = rowsNear(offsets, viewport, viewport.height * KEEP_SCREENS);
  return {
    start: Math.max(kept.start, Math.min(wanted.start, previous.start)),
    end: Math.min(kept.end, Math.max(wanted.end, previous.end)),
  };
}

/** Whether two ranges mount the same rows. */
export const sameRange = (a: RowRange, b: RowRange): boolean => a.start === b.start && a.end === b.end;

/**
 * How far the row that was at the top of the viewport moved in the new layout: the scroll adds
 * this so the row stays put. Zero when that row is gone.
 */
export function anchorShift(previous: TranscriptLayout, next: TranscriptLayout, viewportTop: number): number {
  const reachesViewport = (index: number): boolean =>
    index < previous.ids.length && (previous.offsets[index + 1] ?? 0) > viewportTop;
  const index = Math.max(
    0,
    previous.offsets.findIndex((_offset, i) => reachesViewport(i)),
  );
  const id = previous.ids[index];
  if (id === undefined) return 0;
  const moved = next.ids.indexOf(id);
  if (moved < 0) return 0;
  return (next.offsets[moved] ?? 0) - (previous.offsets[index] ?? 0);
}

/** A block of the transcript and where it lies, relative to the scroller's top edge. */
export interface PlacedBlock<T> {
  item: T;
  top: number;
  bottom: number;
}

/** The line a reader is on: the first block with height that reaches below `viewTop`, and its top. */
export function readingLine<T>(blocks: readonly PlacedBlock<T>[], viewTop: number): { item: T; top: number } | null {
  const block = blocks.find((candidate) => candidate.bottom > candidate.top && candidate.bottom > viewTop);
  return block ? { item: block.item, top: block.top - viewTop } : null;
}

/**
 * The chat was resized: its outer width (a scrollbar appearing does not change it) went from one
 * shown width to another. Hiding or showing the chat (a width of 0) is not a resize.
 */
export function resizedWidth(previous: number, next: number): boolean {
  return previous > 0 && next > 0 && previous !== next;
}

/** The scroll that puts a line that now sits at `top` back where it was held (`heldTop`). */
export function heldScrollTop(scrollTop: number, top: number, heldTop: number): number {
  return scrollTop + top - heldTop;
}

/** Keep React state when scrolling neither mounts nor unmounts a row of the `mounted` ones. */
export function retainedViewport(
  offsets: readonly number[],
  previous: TranscriptViewport,
  next: TranscriptViewport,
  mounted: RowRange,
): TranscriptViewport {
  return sameRange(mountedRange(offsets, next, mounted), mounted) ? previous : next;
}

/** The scroller's position: how far it is scrolled from the top, how tall a screen is, and the whole. */
export interface ScrollPosition {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}

/** What the chat knows about its earlier history. */
export interface EarlierHistory {
  hasMore: boolean;
  paging: boolean;
  pageError?: string;
}

/**
 * Whether the next page of earlier history should load now: a reader who has left the bottom is
 * within a few screens of the loaded top, so it lands before they reach it. A chat following its
 * bottom reads its newest page and no more, unless it is too short to scroll at all. One page at
 * a time; a failed page waits for the reader's Try again rather than retrying on every scroll.
 */
export function loadsEarlier(position: ScrollPosition, history: EarlierHistory, following: boolean): boolean {
  if (!history.hasMore || history.paging || history.pageError) return false;
  if (position.scrollHeight <= position.clientHeight) return true;
  return !following && position.scrollTop < position.clientHeight * LOAD_AHEAD_SCREENS;
}
