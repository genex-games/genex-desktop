import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ESTIMATED_ROW_PX,
  heightEstimate,
  heldScrollTop,
  KEEP_SCREENS,
  LOAD_AHEAD_SCREENS,
  loadsEarlier,
  MOUNT_SCREENS,
  mountedRange,
  type RowRange,
  readingLine,
  resizedWidth,
  rowOffsets,
  retainedViewport,
  type TranscriptViewport,
} from "../../src/renderer/chat/transcript-window.ts";

const ROW_PX = 100;
const rows = (count: number) => Array.from({ length: count }, (_, id) => ({ id: String(id) }));
/** 300 rows of 100 px each, all measured. */
const uniform = () => {
  const items = rows(300);
  return rowOffsets(items, new Map(items.map((item) => [item.id, ROW_PX])));
};
/** Every row with some part within `screens` screens of the viewport. */
function rowsWithin(offsets: readonly number[], viewport: TranscriptViewport, screens: number): number[] {
  const reach = viewport.height * screens;
  const near = (i: number) =>
    (offsets[i + 1] ?? 0) > viewport.top - reach && (offsets[i] ?? 0) < viewport.top + viewport.height + reach;
  return Array.from({ length: offsets.length - 1 }, (_, i) => i).filter(near);
}
const mounted = (range: RowRange) => Array.from({ length: range.end - range.start }, (_, i) => range.start + i);

test("rows mount screens ahead of the reader in both directions, not just around the viewport", () => {
  const offsets = uniform();
  const viewport = { top: 15_000, height: 800 };
  const range = mountedRange(offsets, viewport);
  assert.deepEqual(mounted(range), rowsWithin(offsets, viewport, MOUNT_SCREENS));
  assert.ok(MOUNT_SCREENS >= 2, "a fast fling finds rows already drawn at least two screens ahead");
});

test("rows the reader scrolled past stay mounted until they are far behind, so scrolling back finds them", () => {
  const offsets = uniform();
  const screen = 800;
  const at = { top: 15_000, height: screen };
  const first = mountedRange(offsets, at);
  // Less than the margin between mounting and letting go: nothing behind the reader leaves.
  const step = ((KEEP_SCREENS - MOUNT_SCREENS) * screen) / 2;
  assert.ok(step >= screen / 2, "rows are kept at least half a screen past where they mount");
  const down = mountedRange(offsets, { top: at.top + step, height: screen }, first);
  assert.equal(down.start, first.start, "a little way down, the rows above are still mounted");
  const back = mountedRange(offsets, at, down);
  assert.deepEqual(back, down, "scrolling back up mounts and unmounts nothing");
  const far = { top: at.top + screen * (KEEP_SCREENS + MOUNT_SCREENS + 2), height: screen };
  const away = mountedRange(offsets, far, down);
  assert.deepEqual(away, mountedRange(offsets, far), "rows beyond the keeping distance are let go");
});

test("the mounted rows always cover the reader's reach and never hold rows past the keeping distance", () => {
  const offsets = uniform();
  const screen = 800;
  for (const top of [0, 3_000, 15_000, 29_000]) {
    for (const before of [0, 2_000, 12_000, 16_500, 29_500]) {
      const viewport = { top, height: screen };
      const previous = mountedRange(offsets, { top: before, height: screen });
      const range = mountedRange(offsets, viewport, previous);
      const rowsNow = mounted(range);
      for (const row of rowsWithin(offsets, viewport, MOUNT_SCREENS))
        assert.ok(rowsNow.includes(row), `row ${row} near ${top} is mounted (previously at ${before})`);
      const keep = new Set(rowsWithin(offsets, viewport, KEEP_SCREENS));
      for (const row of rowsNow) assert.ok(keep.has(row), `row ${row} is within keeping distance of ${top}`);
    }
  }
});

test("scrolling that mounts nothing new retains the rendered viewport", () => {
  const offsets = uniform();
  const current = { top: 15_001, height: 800 };
  const range = mountedRange(offsets, current);
  assert.equal(retainedViewport(offsets, current, { top: 15_002, height: 800 }, range), current);
  const farther = { top: 15_001 + 800 * 2, height: 800 };
  assert.notEqual(retainedViewport(offsets, current, farther, range), current, "new rows come into reach");
});

test("a row not yet measured is guessed from the measured rows of its kind and how much it holds", () => {
  const items = [
    { id: "a", kind: "reply", weight: 100 },
    { id: "b", kind: "reply", weight: 300 },
    { id: "c", kind: "reply", weight: 200 },
    { id: "d", kind: "card", weight: 1 },
    { id: "e", kind: "status", weight: 1 },
  ];
  const heights = new Map([
    ["a", 120],
    ["b", 360],
    ["d", 80],
  ]);
  const estimate = heightEstimate(items, heights, (item) => item);
  assert.equal(estimate(items[2] as (typeof items)[number]), 240, "a reply: 1.2 px for each unit it holds");
  assert.equal(
    estimate(items[4] as (typeof items)[number]),
    (120 + 360 + 80) / 3,
    "a kind never measured: the average row",
  );
  const none = heightEstimate(items, new Map(), (item) => item);
  assert.equal(none(items[0] as (typeof items)[number]), ESTIMATED_ROW_PX, "nothing measured yet: the default");
  const offsets = rowOffsets(items, heights, estimate);
  assert.deepEqual(offsets, [0, 120, 480, 720, 800, 800 + 560 / 3], "measured rows keep their own heights");
});

test("learned guesses keep the rows above the reader close to where they will measure", () => {
  // Replies whose height follows their length, as Markdown does at one width.
  const items = Array.from({ length: 200 }, (_, i) => ({
    id: String(i),
    kind: "reply",
    weight: 200 + ((i * 37) % 900),
  }));
  const truth = (item: (typeof items)[number]) => item.weight * 0.45;
  const measured = new Map(items.slice(150).map((item) => [item.id, truth(item)]));
  const actual = items.slice(0, 150).reduce((sum, item) => sum + truth(item), 0);
  const learned =
    rowOffsets(
      items,
      measured,
      heightEstimate(items, measured, (item) => item),
    )[150] ?? 0;
  const flat = rowOffsets(items, measured)[150] ?? 0;
  assert.ok(Math.abs(learned - actual) / actual < 0.1, `learned guesses land within 10% (${learned} vs ${actual})`);
  assert.ok(Math.abs(flat - actual) / actual > 0.5, "a flat guess is far off");
});

test("earlier history loads while a reader scrolling up is still screens away from its top", () => {
  const screen = 800;
  const more = { hasMore: true, paging: false };
  const tall = screen * 20;
  const within = { scrollTop: screen * LOAD_AHEAD_SCREENS - 1, clientHeight: screen, scrollHeight: tall };
  const beyond = { scrollTop: screen * LOAD_AHEAD_SCREENS, clientHeight: screen, scrollHeight: tall };
  assert.equal(loadsEarlier(within, more, false), true, "within reach of the top: the next page loads ahead");
  assert.equal(loadsEarlier(beyond, more, false), false, "far from the top: nothing loads yet");
});

test("an opened chat reads its newest page and no more until the reader scrolls up", () => {
  const screen = 800;
  const more = { hasMore: true, paging: false };
  // A short first page with the reader at its bottom, within reach of its top: nothing loads.
  const short = { scrollTop: screen * 2, clientHeight: screen, scrollHeight: screen * 3 };
  assert.equal(loadsEarlier(short, more, true), false, "following the bottom loads nothing");
  // A chat too short to scroll could never be scrolled up: it fills in at once.
  const unscrollable = { scrollTop: 0, clientHeight: screen, scrollHeight: screen };
  assert.equal(loadsEarlier(unscrollable, more, true), true, "a chat that cannot scroll fills in");
});

test("earlier history does not load twice, past its start, or again after a failure", () => {
  const top = { scrollTop: 0, clientHeight: 800, scrollHeight: 8000 };
  assert.equal(loadsEarlier(top, { hasMore: false, paging: false }, false), false, "the chat's start is loaded");
  assert.equal(loadsEarlier(top, { hasMore: true, paging: true }, false), false, "a page is already on its way");
  assert.equal(
    loadsEarlier(top, { hasMore: true, paging: false, pageError: "disk" }, false),
    false,
    "a failed page waits for Try again",
  );
});

test("the reading line is the first block that reaches the top of the view", () => {
  const blocks = [
    { item: "above", top: -200, bottom: -40 },
    { item: "empty", top: -10, bottom: -10 },
    { item: "crossing", top: -12, bottom: 30 },
    { item: "below", top: 40, bottom: 90 },
  ];
  assert.deepEqual(readingLine(blocks, 0), { item: "crossing", top: -12 });
  assert.deepEqual(readingLine(blocks, 35), { item: "below", top: 5 });
  assert.equal(readingLine(blocks, 100), null);
  assert.equal(readingLine([], 0), null);
});

test("holding the reading line moves the scroll by however far the line moved", () => {
  // Text above it wrapped onto two more lines: the line sits 44 px lower, so the scroll follows it.
  assert.equal(heldScrollTop(840, 56, 12), 884);
  // An image above it got shorter: the line came up, so the scroll comes back.
  assert.equal(heldScrollTop(840, 9, 12), 837);
  assert.equal(heldScrollTop(840, 12, 12), 840);
});

test("only the chat's own width changing holds the reading line", () => {
  // Widths are the scroller's outer box, which a scrollbar appearing does not change.
  const cases: [number, number, boolean][] = [
    [433, 423, true],
    [423, 433, true],
    [433, 433, false],
    [0, 433, false],
    [433, 0, false],
    [0, 0, false],
  ];
  for (const [previous, next, holds] of cases)
    assert.equal(resizedWidth(previous, next), holds, `${previous} → ${next}`);
});
