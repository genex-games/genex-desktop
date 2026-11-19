/**
 * The kit every game analytics report is drawn with: its formatters (a missing number is a dash,
 * never zero; numbers and dates in the app's language; days in UTC), the pure geometry of its charts
 * (axes, gaps where a value is missing, stacked sums, marks, buckets, heat), what the canvas charts
 * draw (on a canvas that records it), and each component's face as React's server renderer draws it
 * from the plain renderer build.
 *
 * The English app writes numbers the computer's own way, so the tables here run in languages the
 * app sets itself: Japanese, whose digits read like English ones, and German, whose do not.
 */
import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { build } from "esbuild";
import type { ReactElement } from "react";
import { rendererBuildOptions } from "../../scripts/renderer-build.mjs";
import { setLocale } from "../../src/shared/i18n.ts";
import { Locale } from "../../src/shared/locale.ts";
import {
  DASH,
  difference,
  formatAgo,
  formatAxisPercent,
  formatCompact,
  formatDay,
  formatDayRange,
  formatDayTime,
  formatDuration,
  formatHour,
  formatHours,
  formatNex,
  formatNexAmount,
  formatNexPerPlayer,
  formatNumber,
  formatPercent,
  formatPoints,
  formatSeconds,
  formatSigned,
  formatSignedDuration,
  formatWeekday,
  periodLabels,
  ratio,
  weekdayName,
} from "../../src/renderer/play/game-analytics/kit/format.ts";
import {
  barShares,
  bucketHeights,
  cursorTarget,
  funnelFlow,
  HEAT_MAX,
  HEAT_MIN,
  heatLevel,
  marksOf,
  weekRows,
} from "../../src/renderer/play/game-analytics/kit/geometry.ts";
import {
  allWhole,
  axisScale,
  bandAt,
  barBands,
  divergingScale,
  drawBars,
  drawLines,
  drawSpark,
  hangingBars,
  indexAt,
  linePoints,
  lineRuns,
  markLanes,
  markXs,
  plotBox,
  pointX,
  stackedBars,
  stackTotals,
  valueY,
} from "../../src/renderer/play/stats-chart.ts";
import { LineTone, SeriesSlot } from "../../src/renderer/play/stats-chart.ts";
import { AnnotationKind, WEEK_HOURS } from "../../src/shared/game-analytics.ts";

/** Text with every kind of space (thin, narrow, no-break) as a plain one: ICU's spacing is not the point. */
const plain = (text: string): string => text.replace(/\s/gu, " ");
const japanese = (): void => setLocale(Locale.Japanese, {});
const german = (): void => setLocale(Locale.German, {});
const MINUS = "−";

describe("the game analytics formatters", () => {
  afterEach(() => setLocale(Locale.English, {}));

  it("divide and subtract safely: nothing to divide by, or a missing side, is null", () => {
    const table: [number | null | undefined, number | null | undefined, number | null][] = [
      [1, 4, 0.25],
      [0, 4, 0],
      [3, 0, null],
      [0, 0, null],
      [null, 4, null],
      [4, null, null],
      [undefined, 4, null],
      [Number.NaN, 4, null],
      [4, Number.NaN, null],
      [Number.POSITIVE_INFINITY, 4, null],
      [4, Number.POSITIVE_INFINITY, null],
      [-2, 4, -0.5],
    ];
    for (const [part, whole, expected] of table) assert.equal(ratio(part, whole), expected, `ratio(${part}, ${whole})`);
    assert.equal(difference(5, 3), 2);
    assert.equal(difference(3, 5), -2);
    assert.equal(difference(null, 3), null);
    assert.equal(difference(3, null), null);
    assert.equal(difference(Number.NaN, 3), null);
  });

  it("write a count grouped, with the decimals asked for, and a dash for nothing", () => {
    japanese();
    const table: [number | null, number | undefined, string][] = [
      [9300, undefined, "9,300"],
      [0, undefined, "0"],
      [1.38, 2, "1.38"],
      [1.4, 2, "1.40"],
      [1_234_567.891, 1, "1,234,567.9"],
      [1e12, undefined, "1,000,000,000,000"],
      [-1240, undefined, `${MINUS}1,240`],
      [null, undefined, DASH],
      [Number.NaN, undefined, DASH],
      [Number.POSITIVE_INFINITY, undefined, DASH],
    ];
    for (const [value, digits, expected] of table)
      assert.equal(formatNumber(value, digits), expected, `formatNumber(${value}, ${digits})`);
    german();
    assert.equal(formatNumber(9300), "9.300");
    assert.equal(formatNumber(1.38, 2), "1,38");
  });

  it("write a rate as a percentage with a chosen precision", () => {
    japanese();
    const table: [number | null, number | undefined, string][] = [
      [0.345, undefined, "34.5%"],
      [0.345, 0, "35%"],
      [0.3456, 2, "34.56%"],
      [0, undefined, "0.0%"],
      [1, 0, "100%"],
      [12.5, undefined, "1,250.0%"],
      [-0.05, undefined, `${MINUS}5.0%`],
      [null, undefined, DASH],
      [Number.NaN, undefined, DASH],
    ];
    for (const [rate, digits, expected] of table)
      assert.equal(formatPercent(rate, digits), expected, `formatPercent(${rate}, ${digits})`);
    german();
    assert.equal(plain(formatPercent(0.345)), "34,5 %");
  });

  it("write a rate on a chart's axis in whole percents, with decimals only for a step that has them", () => {
    japanese();
    const table: [number | null, string][] = [
      [0.4, "40%"],
      [0, "0%"],
      [1, "100%"],
      [0.025, "2.5%"],
      [0.075, "7.5%"],
      [0.0025, "0.25%"],
      [-0.1, `${MINUS}10%`],
      [null, DASH],
      [Number.NaN, DASH],
    ];
    for (const [rate, expected] of table) assert.equal(formatAxisPercent(rate), expected, `formatAxisPercent(${rate})`);
    german();
    assert.equal(plain(formatAxisPercent(0.4)), "40 %");
  });

  it("write a change between two rates in points, signed, and never a signed zero", () => {
    japanese();
    const table: [number | null, number | undefined, string][] = [
      [0.021, undefined, "+2.1 pts"],
      [-0.002, undefined, `${MINUS}0.2 pts`],
      [0, undefined, "0.0 pts"],
      [0.0004, undefined, "0.0 pts"],
      [-0.0004, undefined, "0.0 pts"],
      [0.5, 0, "+50 pts"],
      [null, undefined, DASH],
    ];
    for (const [change, digits, expected] of table)
      assert.equal(formatPoints(change, digits), expected, `formatPoints(${change}, ${digits})`);
    german();
    assert.equal(formatPoints(0.021), "+2,1 pts");
  });

  it("write a change in a number with its sign", () => {
    japanese();
    assert.equal(formatSigned(124), "+124");
    assert.equal(formatSigned(1240), "+1,240");
    assert.equal(formatSigned(-0.14, 2), `${MINUS}0.14`);
    assert.equal(formatSigned(0), "0");
    assert.equal(formatSigned(0.004, 2), "0.00");
    assert.equal(formatSigned(null), DASH);
  });

  it("write a length of time the short way: seconds, minutes and seconds, hours and minutes, then hours", () => {
    japanese();
    const table: [number | null, string][] = [
      [340, "5m 40s"],
      [3.8, "3.8 s"],
      [52, "52 s"],
      [9, "9 s"],
      [0, "0 s"],
      [59.6, "1m"],
      [1860, "31m"],
      [3725, "1h 2m"],
      [7200, "2h"],
      [16_063_200, "4,462 h"],
      [-5, DASH],
      [null, DASH],
      [Number.NaN, DASH],
    ];
    for (const [seconds, expected] of table)
      assert.equal(formatDuration(seconds), expected, `formatDuration(${seconds})`);
    assert.equal(formatSignedDuration(22), "+22 s");
    assert.equal(formatSignedDuration(-65), `${MINUS}1m 5s`);
    assert.equal(formatSignedDuration(0.7), "+0.7 s");
    assert.equal(formatSignedDuration(0), "0 s");
    assert.equal(formatSignedDuration(null), DASH);
  });

  it("write seconds with their decimals, and a total in hours", () => {
    japanese();
    assert.equal(formatSeconds(3.8), "3.8 s");
    assert.equal(formatSeconds(11.23), "11.2 s");
    assert.equal(formatSeconds(3), "3.0 s");
    assert.equal(formatSeconds(52, 0), "52 s");
    assert.equal(formatSeconds(null), DASH);
    assert.equal(formatHours(16_063_200), "4,462 h");
    assert.equal(formatHours(1800), "0.5 h");
    assert.equal(formatHours(0), "0 h");
    assert.equal(formatHours(null), DASH);
    german();
    assert.equal(formatSeconds(3.8), "3,8 s");
    assert.equal(formatHours(16_063_200), "4.462 h");
  });

  it("write Nex whole when there is a lot of it and with its decimals when there is little", () => {
    japanese();
    const table: [number | null, string][] = [
      [48_610, "48,610"],
      [118.4, "118"],
      [2.17, "2.17"],
      [3.1, "3.1"],
      [9, "9"],
      [0, "0"],
      [-0.14, `${MINUS}0.14`],
      [null, DASH],
    ];
    for (const [amount, expected] of table)
      assert.equal(formatNexAmount(amount), expected, `formatNexAmount(${amount})`);
    assert.equal(formatNex(1.9), "1.9 Nex");
    assert.equal(formatNex(48_610), "48,610 Nex");
    assert.equal(formatNex(null), DASH);
  });

  it("write Nex per player with two decimals, however much or little it is", () => {
    japanese();
    const table: [number | null, string][] = [
      [4.6, "4.60"],
      [0.857, "0.86"],
      [6, "6.00"],
      [0, "0.00"],
      [1240, "1,240.00"],
      [null, DASH],
      [Number.NaN, DASH],
    ];
    for (const [amount, expected] of table)
      assert.equal(formatNexPerPlayer(amount), expected, `formatNexPerPlayer(${amount})`);
    german();
    assert.equal(formatNexPerPlayer(4.6), "4,60");
  });

  it("shorten a large count for an axis or a small cell", () => {
    german();
    assert.equal(plain(formatCompact(1_240_000)), "1,2 Mio.");
    assert.equal(formatCompact(950), "950");
    assert.equal(formatCompact(null), DASH);
  });

  it("write a day and a range of days in UTC, and an instant on the clock handed in, whatever the computer's own time zone", () => {
    const zone = process.env.TZ;
    process.env.TZ = "America/Los_Angeles";
    try {
      japanese();
      assert.equal(formatDay("2026-11-17"), "11月17日");
      german();
      assert.equal(formatDay("2026-11-17"), "17. Nov.");
      assert.equal(plain(formatDayRange("2026-10-19", "2026-11-17")), "19. Okt. – 17. Nov.");
      assert.equal(plain(formatWeekday("2026-11-07")), "Sa., 7. Nov.");
      assert.equal(plain(formatDayTime("2026-11-07T20:00:00.000Z", 0)), "Sa., 7. Nov., 20:00");
      assert.equal(
        plain(formatDayTime("2026-11-07T20:00:00.000Z", -300)),
        "Sa., 7. Nov., 15:00",
        "the clock handed in",
      );
      assert.equal(plain(formatDayTime("2026-11-07T20:00:00.000Z", 330)), "So., 8. Nov., 01:30");
      assert.equal(formatHour(20), "20:00");
      assert.equal(formatHour(0), "00:00");
      assert.deepEqual([weekdayName(0), weekdayName(5), weekdayName(6)], ["Mo", "Sa", "So"]);
      assert.deepEqual(periodLabels({ days: 7, endsOn: "2026-11-17" }), [
        "11. Nov.",
        "12. Nov.",
        "13. Nov.",
        "14. Nov.",
        "15. Nov.",
        "16. Nov.",
        "17. Nov.",
      ]);
    } finally {
      if (zone === undefined) delete process.env.TZ;
      else process.env.TZ = zone;
    }
    assert.equal(formatDay("not a day"), DASH);
    assert.equal(formatDayRange("2026-10-19", "nope"), DASH);
    assert.equal(formatDayTime(null, 0), DASH);
  });

  it("say how long ago a time was, against a clock it is handed", () => {
    const now = Date.parse("2026-11-17T12:00:00.000Z");
    german();
    const table: [string | null, string][] = [
      ["2026-11-17T11:59:48.000Z", "vor 12 Sek."],
      ["2026-11-17T11:56:00.000Z", "vor 4 Min."],
      ["2026-11-17T09:00:00.000Z", "vor 3 Std."],
      ["2026-11-15T12:00:00.000Z", "vor 2 Tagen"],
      ["2026-11-17T11:59:58.000Z", "just now"],
      ["2026-11-17T12:00:30.000Z", "just now"],
      [null, DASH],
      ["yesterday-ish", DASH],
    ];
    for (const [at, expected] of table) assert.equal(plain(formatAgo(at, now)), expected, `formatAgo(${at})`);
    japanese();
    assert.equal(plain(formatAgo("2026-11-17T11:56:00.000Z", now)), "4 分前");
  });
});

/** Numbers rounded to a hundredth of a pixel, so a sum of fractions compares. */
const near = (values: readonly (number | null)[]): (number | null)[] =>
  values.map((value) => (value === null ? null : Math.round(value * 100) / 100));

describe("the game analytics charts' geometry", () => {
  /** A 656 × 260 canvas: the plot is 600 × 222, from 46 across and 12 down. */
  const box = plotBox(656, 260);
  /** A plot with no margins, 400 × 100. */
  const bare = { left: 0, top: 0, width: 400, height: 100 };

  it("leaves room for the values on the left and the dates below", () => {
    assert.deepEqual(box, { left: 46, top: 12, width: 600, height: 222 });
    assert.deepEqual(plotBox(40, 20), { left: 46, top: 12, width: 1, height: 1 }, "a box too small keeps a plot");
  });

  it("gives the value axis a round top and even steps, whole for counts", () => {
    assert.deepEqual(near(axisScale(0.345).ticks), [0, 0.1, 0.2, 0.3, 0.4]);
    assert.equal(axisScale(0.345).top, 0.4);
    assert.deepEqual(axisScale(1510), { top: 2000, ticks: [0, 500, 1000, 1500, 2000] });
    assert.deepEqual(axisScale(950), { top: 1000, ticks: [0, 250, 500, 750, 1000] });
    assert.deepEqual(axisScale(100), { top: 100, ticks: [0, 25, 50, 75, 100] });
    assert.deepEqual(axisScale(111, 2), { top: 200, ticks: [0, 100, 200] });
    assert.deepEqual(axisScale(3, 4, true), { top: 3, ticks: [0, 1, 2, 3] }, "a count has no half steps");
    assert.deepEqual(axisScale(9, 4, true), { top: 10, ticks: [0, 5, 10] });
    assert.deepEqual(axisScale(0), { top: 1, ticks: [0, 0.25, 0.5, 0.75, 1] }, "nothing to show keeps an axis");
    assert.deepEqual(axisScale(0, 4, true), { top: 4, ticks: [0, 1, 2, 3, 4] });
    assert.deepEqual(axisScale(Number.NaN), { top: 1, ticks: [0, 0.25, 0.5, 0.75, 1] });
  });

  it("tells counts from rates by their values, so a small count's axis never steps by halves", () => {
    assert.equal(allWhole([3, 0, 12]), true);
    assert.equal(allWhole([0.345, 1]), false);
    assert.equal(allWhole([]), true);
  });

  it("places a point by its index and its value", () => {
    assert.equal(pointX(0, 7, box), 46);
    assert.equal(pointX(6, 7, box), 646);
    assert.equal(pointX(0, 1, box), 46, "a single point sits at the left");
    assert.equal(valueY(0, 40, box), 234);
    assert.equal(valueY(40, 40, box), 12);
    assert.equal(valueY(20, 40, box), 123);
  });

  it("breaks a line where a value is missing, and never draws the gap as zero", () => {
    assert.deepEqual(lineRuns([1, 2, null, 3, null, null, 4, 5]), [
      [0, 1],
      [3, 3],
      [6, 7],
    ]);
    assert.deepEqual(lineRuns([null, null]), []);
    assert.deepEqual(lineRuns([]), []);
    assert.deepEqual(lineRuns([0, 0]), [[0, 1]], "zero is a value");
    assert.deepEqual(linePoints([10, null, 20], 20, box), [[46, 123], null, [646, 12]]);
  });

  it("finds the point under the pointer, held to the series", () => {
    assert.equal(indexAt(46, box, 7), 0);
    assert.equal(indexAt(646, box, 7), 6);
    assert.equal(indexAt(-50, box, 7), 0);
    assert.equal(indexAt(9000, box, 7), 6);
    assert.equal(indexAt(300, box, 1), 0);
    assert.equal(indexAt(300, box, 0), 0);
  });

  it("lays bars out one per day, thin when there are many and never wider than a thumb", () => {
    assert.deepEqual(barBands(4, bare), [
      { x: 36, width: 28 },
      { x: 136, width: 28 },
      { x: 236, width: 28 },
      { x: 336, width: 28 },
    ]);
    const many = barBands(40, bare);
    assert.equal(many.length, 40);
    assert.deepEqual(near([many[0]?.x ?? null, many[0]?.width ?? null]), [1.4, 7.2]);
    assert.deepEqual(barBands(0, bare), []);
    assert.equal(bandAt(0, bare, 4), 0);
    assert.equal(bandAt(199, bare, 4), 1);
    assert.equal(bandAt(399, bare, 4), 3);
    assert.equal(bandAt(-10, bare, 4), 0);
    assert.equal(bandAt(900, bare, 4), 3);
  });

  it("stacks series on one another: a day's bar is the sum of its parts", () => {
    assert.deepEqual(stackTotals([[1, 2, 3], [4, 5, 6], [10]]), [15, 7, 9]);
    assert.deepEqual(stackTotals([]), []);
    const bars = stackedBars(
      [
        [10, 0],
        [30, 5],
      ],
      40,
      bare,
    );
    assert.deepEqual(
      bars.map((bar) => bar.total),
      [40, 5],
    );
    assert.deepEqual(bars[0]?.segments, [
      { series: 0, y: 75, height: 25 },
      { series: 1, y: 0, height: 75 },
    ]);
    assert.deepEqual(bars[1]?.segments, [{ series: 1, y: 87.5, height: 12.5 }], "a part of nothing draws nothing");
    const heights = (bars[0]?.segments ?? []).reduce((sum, segment) => sum + segment.height, 0);
    assert.equal(heights, valueY(0, 40, bare) - valueY(40, 40, bare));
  });

  it("hangs what left under the baseline on the same scale as what is stacked over it", () => {
    assert.deepEqual(divergingScale(4359, 2839), {
      top: 6000,
      bottom: 4000,
      ticks: [-4000, -2000, 0, 2000, 4000, 6000],
    });
    assert.deepEqual(
      divergingScale(30, 0),
      { top: 30, bottom: 0, ticks: [0, 10, 20, 30] },
      "nothing under: a plain axis",
    );
    assert.deepEqual(divergingScale(0, 0, 4, true), { top: 4, bottom: 0, ticks: [0, 1, 2, 3, 4] });
    assert.equal(valueY(0, 60, bare, 40), 60, "the baseline sits where the two sides meet");
    assert.equal(valueY(60, 60, bare, 40), 0);
    assert.equal(valueY(-40, 60, bare, 40), 100);
    const over = stackedBars([[30], [30]], 60, bare, 40);
    assert.deepEqual(over[0]?.segments, [
      { series: 0, y: 30, height: 30 },
      { series: 1, y: 0, height: 30 },
    ]);
    assert.deepEqual(hangingBars([20, 0], 60, 40, bare), [
      { x: 86, width: 28, y: 60, height: 20 },
      { x: 286, width: 28, y: 60, height: 0 },
    ]);
  });

  it("puts a mark on its day, drops one outside the period, and keeps the marks' labels apart", () => {
    const at = (index: number): number => pointX(index, 30, box);
    assert.deepEqual(near(markXs([17, 40, -1, 2.5], 30, at)), [397.72, null, null, null]);
    const lanes = markLanes(
      [
        { x: 100, width: 80 },
        { x: 150, width: 60 },
        { x: 160, width: 60 },
        { x: 390, width: 80 },
      ],
      bare,
    );
    assert.deepEqual(lanes, [{ left: 106, lane: 0 }, { left: 156, lane: 1 }, null, { left: 304, lane: 0 }]);
  });

  it("measures a bucket against the tallest, with a missing one flat", () => {
    assert.deepEqual(bucketHeights([52, 78, null, 140, 0]), [52 / 140, 78 / 140, 0, 1, 0]);
    assert.deepEqual(bucketHeights([0, 0]), [0, 0]);
    assert.deepEqual(bucketHeights([]), []);
  });

  it("gives a row its share of the whole and its bar against the longest", () => {
    assert.deepEqual(barShares([30, 10, 60]), [
      { share: 0.3, width: 0.5 },
      { share: 0.1, width: 10 / 60 },
      { share: 0.6, width: 1 },
    ]);
    assert.deepEqual(barShares([40, 10], 200), [
      { share: 0.2, width: 1 },
      { share: 0.05, width: 0.25 },
    ]);
    assert.deepEqual(barShares([0, 0]), [
      { share: null, width: 0 },
      { share: null, width: 0 },
    ]);
  });

  it("shades a cell by its value against the busiest, keeps zero faint and a missing one bare", () => {
    assert.equal(heatLevel(null, 100), null);
    assert.equal(heatLevel(0, 100), HEAT_MIN);
    assert.equal(heatLevel(100, 100), HEAT_MAX);
    assert.equal(heatLevel(50, 100), 0.34, "halfway between the two");
    assert.equal(heatLevel(500, 100), HEAT_MAX, "never past the top");
    assert.equal(heatLevel(5, 0), HEAT_MIN);
    assert.equal(heatLevel(Number.NaN, 100), null);
  });

  it("follows a funnel: who goes on from each step, who is lost, and the share of the first", () => {
    const flow = funnelFlow([19_380, 8560, 7840, 5960, 2270]);
    assert.equal(flow.length, 5);
    assert.deepEqual(flow[0], { ofFirst: 1, onward: 8560 / 19_380, lost: 10_820 });
    assert.deepEqual(flow[3], { ofFirst: 5960 / 19_380, onward: 2270 / 5960, lost: 3690 });
    assert.deepEqual(flow[4], { ofFirst: 2270 / 19_380, onward: null, lost: null });
    assert.deepEqual(funnelFlow([0, 0]), [
      { ofFirst: null, onward: null, lost: 0 },
      { ofFirst: null, onward: null, lost: null },
    ]);
    assert.equal(funnelFlow([10, 12])[0]?.lost, 0, "a later step that grew loses nobody");
    assert.deepEqual(funnelFlow([]), []);
  });

  it("cuts a week of hours into seven days of 24, missing hours left empty", () => {
    const hours = Array.from({ length: WEEK_HOURS }, (_, hour) => hour);
    const rows = weekRows(hours);
    assert.equal(rows.length, 7);
    assert.ok(rows.every((row) => row.length === 24));
    assert.equal(rows[0]?.[0], 0);
    assert.equal(rows[5]?.[20], 140);
    assert.equal(rows[6]?.[23], 167);
    const short = weekRows([1, 2, 3]);
    assert.deepEqual(short[0]?.slice(0, 4), [1, 2, 3, null]);
    assert.equal(short[6]?.[23], null);
  });

  it("moves a chart's readout with the keyboard: the arrows step and stop at the ends, Home and End jump", () => {
    const table: [string, number | null, number | null][] = [
      ["ArrowRight", null, 0],
      ["ArrowRight", 3, 4],
      ["ArrowRight", 29, 29],
      ["ArrowLeft", null, 29],
      ["ArrowLeft", 3, 2],
      ["ArrowLeft", 0, 0],
      ["Home", 12, 0],
      ["End", 12, 29],
      ["Enter", 12, null],
      ["a", null, null],
    ];
    for (const [key, from, expected] of table)
      assert.equal(cursorTarget(key, from, 30), expected, `${key} from ${from}`);
    assert.equal(cursorTarget("ArrowRight", null, 0), null, "a chart with no places has nowhere to go");
  });

  it("turns a report's annotations into marks on the days they fall on", () => {
    const days = ["2026-11-03", "2026-11-04", "2026-11-05"];
    const marks = marksOf(
      [
        { on: "2026-11-05", kind: AnnotationKind.Campaign, label: "launch_trailer" },
        { on: "2026-11-03", kind: AnnotationKind.Version, label: "1.4.0" },
        { on: "2026-10-01", kind: AnnotationKind.Version, label: "1.3.2" },
      ],
      days,
    );
    assert.deepEqual(marks, [
      { index: 0, kind: AnnotationKind.Version, label: "Version 1.4.0" },
      { index: 2, kind: AnnotationKind.Campaign, label: "Campaign launch_trailer" },
    ]);
  });
});

/** A line or an outline as it was stroked: its colour, its dashes and the points it runs through. */
interface Stroke {
  style: string;
  dash: number[];
  points: [number, number][];
}

/**
 * A canvas that keeps what is drawn on it: every stroked path, every filled shape's colour and
 * every written text. Colours are the names of the tokens they were read from (see `tokens`).
 */
function recordingCanvas(width = 656, height = 260) {
  const strokes: Stroke[] = [];
  const fills: string[] = [];
  const texts: string[] = [];
  const transforms: unknown[][] = [];
  const state: Record<string, unknown> = { strokeStyle: "", fillStyle: "" };
  let dash: number[] = [];
  let points: [number, number][] = [];
  const methods: Record<string, (...args: never[]) => unknown> = {
    measureText: (text: string) => ({ width: text.length * 6 }),
    createLinearGradient: () => ({ addColorStop: () => undefined }),
    setLineDash: (segments: number[]) => {
      dash = segments;
    },
    setTransform: (...args: unknown[]) => transforms.push(args),
    beginPath: () => {
      points = [];
    },
    moveTo: (x: number, y: number) => points.push([x, y]),
    lineTo: (x: number, y: number) => points.push([x, y]),
    roundRect: (x: number, y: number) => points.push([x, y]),
    stroke: () => strokes.push({ style: String(state.strokeStyle), dash, points }),
    fill: () => fills.push(String(state.fillStyle)),
    fillText: (text: string) => texts.push(text),
  };
  const ctx = new Proxy(state, {
    get: (target, key: string) => (key in target ? target[key] : (methods[key] ?? (() => undefined))),
    set: (target, key: string, value) => {
      target[key] = value;
      return true;
    },
  });
  const canvas = { clientWidth: width, clientHeight: height, width: 0, height: 0, getContext: () => ctx };
  return { canvas: canvas as unknown as HTMLCanvasElement, strokes, fills, texts, transforms };
}

describe("the game analytics charts on a canvas", () => {
  const page = globalThis as { getComputedStyle?: unknown; devicePixelRatio?: number };
  const style = page.getComputedStyle;
  const density = page.devicePixelRatio;
  // Every colour reads as the name of its token, so a test can say which token painted what.
  before(() => {
    page.getComputedStyle = () => ({ getPropertyValue: (name: string) => name });
    page.devicePixelRatio = 3;
  });
  after(() => {
    page.getComputedStyle = style;
    page.devicePixelRatio = density;
  });
  const labels = ["Oct 19", "Oct 20", "Oct 21", "Oct 22", "Oct 23"];
  const format = (value: number | null): string => (value === null ? DASH : String(value));
  const box = plotBox(656, 260);
  const xs = (stroke: Stroke): number[] => stroke.points.map(([x]) => x);

  it("draws at the screen's density, up to twice, whatever the box's size", () => {
    const { canvas, transforms } = recordingCanvas(656, 260);
    drawLines(canvas, { series: [], labels, hovered: null, format });
    assert.deepEqual([canvas.width, canvas.height], [1312, 520]);
    assert.deepEqual(transforms[0], [2, 0, 0, 2, 0, 0]);
  });

  it("steps a small count's axis by whole numbers and a rate's by fractions", () => {
    const line = (values: number[]) => [{ id: "now", label: "Now", tone: LineTone.Main, values }];
    const counts = recordingCanvas();
    drawLines(counts.canvas, { series: line([0, 1, 2]), labels: labels.slice(0, 3), hovered: null, format });
    assert.deepEqual(counts.texts.slice(0, 3), ["0", "1", "2"]);
    const rates = recordingCanvas();
    drawLines(rates.canvas, { series: line([0.1, 0.345, 0.2]), labels: labels.slice(0, 3), hovered: null, format });
    assert.deepEqual(rates.texts.slice(0, 5), ["0", "0.1", "0.2", "0.3", "0.4"]);
  });

  it("writes the axis's steps in the axis's own format, and the readout and callouts in the values'", () => {
    const { canvas, texts } = recordingCanvas();
    drawLines(canvas, {
      series: [{ id: "now", label: "Now", tone: LineTone.Main, values: [0.1, 0.345, 0.2] }],
      labels: labels.slice(0, 3),
      hovered: 1,
      callouts: [1],
      format: (value) => (value === null ? DASH : `${(value * 100).toFixed(1)}%`),
      axisFormat: (value) => `${Math.round(value * 100)}%`,
    });
    assert.deepEqual(texts.slice(0, 5), ["0%", "10%", "20%", "30%", "40%"]);
    assert.equal(texts.filter((text) => text === "34.5%").length, 2, "the callout and the readout keep the decimal");
  });

  it("draws a line through each stretch of values and never across a gap", () => {
    const { canvas, strokes } = recordingCanvas();
    const main = { id: "now", label: "Now", tone: LineTone.Main, values: [10, 20, null, 30, 40] };
    drawLines(canvas, { series: [main], labels, hovered: null, format });
    const lines = strokes.filter((stroke) => stroke.style === "--stats-line" && stroke.points.length > 1);
    assert.deepEqual(
      lines.map((line) => xs(line)),
      [
        [pointX(0, 5, box), pointX(1, 5, box)],
        [pointX(3, 5, box), pointX(4, 5, box)],
      ],
    );
    assert.ok(
      lines.every((line) => line.dash.length === 0),
      "this period's line is solid",
    );
  });

  it("dashes the period before and dots similar games, each in its own grey", () => {
    const { canvas, strokes } = recordingCanvas();
    drawLines(canvas, {
      labels,
      hovered: null,
      format,
      series: [
        { id: "now", label: "Now", tone: LineTone.Main, values: [1, 2, 3, 4, 5] },
        { id: "before", label: "Before", tone: LineTone.Before, values: [2, 2, 2, 2, 2] },
        { id: "similar", label: "Similar", tone: LineTone.Similar, values: [3, 3, 3, 3, 3] },
      ],
    });
    const dashOf = (token: string): number[] | undefined =>
      strokes.find((stroke) => stroke.style === token && stroke.points.length === 5)?.dash;
    assert.deepEqual(dashOf("--stats-line"), []);
    assert.deepEqual(dashOf("--stats-before"), [5, 4]);
    assert.deepEqual(dashOf("--stats-similar"), [1, 4]);
  });

  it("marks a day with a line in the mark's colour and its label, and reads the day under the pointer", () => {
    const { canvas, strokes, texts } = recordingCanvas();
    drawLines(canvas, {
      labels,
      hovered: 2,
      format,
      marks: [{ index: 2, kind: AnnotationKind.Campaign, label: "Campaign launch_trailer" }],
      series: [
        { id: "now", label: "Now", tone: LineTone.Main, values: [10, 20, null, 30, 40] },
        { id: "before", label: "Before", tone: LineTone.Before, values: [5, 6, 7, 8, 9] },
      ],
    });
    const mark = strokes.find((stroke) => stroke.style === "--stats-mark-campaign");
    const hairline = Math.round(pointX(2, 5, box)) + 0.5;
    assert.deepEqual(mark ? xs(mark) : [], [hairline, hairline], "a hairline down the marked day");
    const readout = texts.slice(texts.lastIndexOf("Oct 21"));
    assert.deepEqual(readout, ["Oct 21", "Now", DASH, "Before", "7", "Campaign launch_trailer", ""]);
  });

  it("fills each part of a stacked bar in its series' colour and outlines what hangs under the baseline", () => {
    const { canvas, fills, strokes, texts } = recordingCanvas();
    drawBars(canvas, {
      labels: labels.slice(0, 2),
      hovered: 1,
      format: (value) => String(value),
      totalLabel: "Total",
      series: [
        { id: "genex", label: "Genex", slot: SeriesSlot.First, values: [100, 40] },
        { id: "campaigns", label: "Campaigns", slot: SeriesSlot.Second, values: [0, 25] },
      ],
      below: { label: "Did not return", values: [0, 30] },
    });
    assert.equal(fills.filter((fill) => fill === "--stats-series-1").length, 3, "two bars and the readout's swatch");
    assert.equal(
      fills.filter((fill) => fill === "--stats-series-2").length,
      2,
      "one bar (a part of nothing draws nothing) and its swatch",
    );
    assert.equal(
      strokes.filter((stroke) => stroke.style === "--stats-before").length,
      2,
      "the outlined bar and its swatch",
    );
    const readout = texts.slice(texts.lastIndexOf("Oct 20"));
    assert.deepEqual(readout, ["Oct 20", "Genex", "40", "Campaigns", "25", "Total", "65", "Did not return", "-30"]);
  });

  it("leaves a gap in a sparkline where a day is missing", () => {
    const { canvas, strokes } = recordingCanvas(170, 30);
    drawSpark(canvas, [1, 2, null, 4, 5]);
    assert.deepEqual(
      strokes.map((stroke) => stroke.points.length),
      [2, 2],
      "two stretches, the missing day in neither",
    );
    const whole = recordingCanvas(170, 30);
    drawSpark(whole.canvas, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert.deepEqual(
      whole.strokes.map((stroke) => [stroke.style, stroke.points.length]),
      [
        ["--stats-soft", 3],
        ["--stats-line", 8],
      ],
      "with every day there, the earlier days soft and the latest week in the accent, as before",
    );
    const none = recordingCanvas(170, 30);
    drawSpark(none.canvas, [null, null]);
    assert.equal(none.strokes.length, 0);
  });
});

/** What the tests reach in the bundle: the kit as its index exports it, and React's server renderer. */
interface KitBundle {
  kit: typeof import("../../src/renderer/play/game-analytics/kit/index.ts");
  createElement: (type: unknown, props: object | null, ...children: unknown[]) => ReactElement;
  renderToStaticMarkup: (element: ReactElement) => string;
}

/** The kit as the plain renderer build compiles it. */
async function kitBundle(): Promise<KitBundle> {
  const result = await build({
    stdin: {
      contents: [
        'export * as kit from "./src/renderer/play/game-analytics/kit/index.ts";',
        'export { createElement } from "react";',
        'export { renderToStaticMarkup } from "react-dom/server.edge";',
      ].join("\n"),
      resolveDir: process.cwd(),
      loader: "tsx",
    },
    bundle: true,
    write: false,
    format: "esm",
    jsx: "automatic",
    logLevel: "silent",
    platform: "browser",
    ...rendererBuildOptions(),
  });
  const code = result.outputFiles[0]?.text ?? "";
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
}

/** The words a reader meets in `markup`: tags gone, spaces single, the markup's escapes read back. */
const words = (markup: string): string =>
  markup
    .replace(/<[^>]*>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
/** Every opening tag in `markup` that matches `pattern`. */
const tags = (markup: string, pattern: RegExp): string[] => markup.match(new RegExp(pattern.source, "g")) ?? [];
/** The row of a text-equivalent table whose row heading is `place`. */
const tableRow = (markup: string, place: string): string =>
  new RegExp(`<tr><th scope="row">${place}</th>.*?</tr>`).exec(markup)?.[0] ?? "";

describe("the game analytics kit's components", () => {
  let kit: KitBundle["kit"];
  /** A component of the kit as markup. */
  let draw: (component: unknown, props: object, ...children: unknown[]) => string;
  before(async () => {
    const bundle = await kitBundle();
    kit = bundle.kit;
    draw = (component, props, ...children) =>
      bundle.renderToStaticMarkup(bundle.createElement(component, props, ...children));
  });
  // The bundle reads the same language slot as this file: numbers the English way, whatever the computer's.
  beforeEach(japanese);
  after(() => setLocale(Locale.English, {}));

  describe("a metric tile", () => {
    it("shows a dash for a number that cannot be known, never zero", () => {
      const tile = draw(kit.MetricTile, { id: "day7", label: "Day 7 retention", value: null });
      assert.match(tile, /data-game-analytics-tile="day7"/);
      assert.match(tile, /<span class="stats-tile-value" data-missing="true">—<\/span>/);
      assert.equal(words(tile), "Day 7 retention —");
      assert.doesNotMatch(tile, /<button/, "a tile nobody can press is no button");
    });

    it("is a button that says whether it is the one picked, when it picks the chart's measure", () => {
      const picked = draw(kit.MetricTile, {
        id: "players",
        label: "Players",
        value: "9,300",
        pressed: true,
        onPress: () => undefined,
      });
      assert.equal(tags(picked, /<button[^>]*>/).length, 1);
      assert.match(picked, /<button[^>]*type="button"[^>]*aria-pressed="true"/);
      const other = draw(kit.MetricTile, { id: "plays", label: "Plays", value: "30,889", onPress: () => undefined });
      assert.match(other, /<button[^>]*aria-pressed="false"/);
    });

    it("says how the number moved: a percentage, points between two rates, or an amount in its unit", () => {
      const tile = (delta: object): string => draw(kit.MetricTile, { id: "t", label: "Tile", value: "1", delta });
      const percent = tile({ kind: kit.DeltaKind.Percent, now: 9300, before: 5600 });
      assert.match(percent, /class="stats-change" data-change="up"/);
      assert.match(words(percent), /\+66%/);
      const points = tile({ kind: kit.DeltaKind.Points, now: 0.345, before: 0.324 });
      assert.match(points, /data-direction="up" data-tone="good"/);
      assert.match(words(points), /\+2\.1 pts/);
      const fewer = tile({ kind: kit.DeltaKind.Points, now: 0.098, before: 0.11, lowerIsBetter: true });
      assert.match(fewer, /data-direction="down" data-tone="good"/);
      assert.match(words(fewer), new RegExp(`${MINUS}1\\.2 pts`));
      const worse = tile({ kind: kit.DeltaKind.Points, now: 0.3, before: 0.35 });
      assert.match(worse, /data-direction="down" data-tone="bad"/);
      const amount = tile({
        kind: kit.DeltaKind.Amount,
        now: 340,
        before: 318,
        format: formatSignedDuration,
        digits: 1,
      });
      assert.match(words(amount), /\+22 s/);
      const held = tile({ kind: kit.DeltaKind.Points, now: 0.3, before: 0.3 });
      assert.match(held, /data-direction="flat" data-tone="flat"/);
      assert.doesNotMatch(held, /data-icon/, "a number that held wears no arrow");
    });

    it("tells the direction from the number, whatever words a language puts around it", () => {
      const tile = (delta: object): string => draw(kit.MetricTile, { id: "t", label: "Tile", value: "1", delta });
      const wordFirst = (change: number) => `by ${formatSigned(Math.abs(change), 1)} less`;
      const fewer = tile({
        kind: kit.DeltaKind.Amount,
        now: 0.9,
        before: 3,
        format: wordFirst,
        digits: 1,
        lowerIsBetter: true,
      });
      assert.match(fewer, /data-direction="down" data-tone="good"/);
      assert.match(fewer, /data-icon/, "it keeps its arrow");
      const tiny = tile({ kind: kit.DeltaKind.Amount, now: 1.004, before: 1, format: wordFirst, digits: 2 });
      assert.match(tiny, /data-direction="flat" data-tone="flat"/, "a change too small to show goes neither way");
      const shown = tile({ kind: kit.DeltaKind.Amount, now: 1.006, before: 1, format: wordFirst, digits: 2 });
      assert.match(shown, /data-direction="up"/);
      const points = tile({ kind: kit.DeltaKind.Points, now: 0.3004, before: 0.3 });
      assert.match(points, /data-direction="flat"/, "0.04 points at one decimal shows as none");
    });

    it("keeps the arrow and the sign but no good or bad colour for a number whose direction is neither", () => {
      const tile = (delta: object): string => draw(kit.MetricTile, { id: "t", label: "Tile", value: "1", delta });
      const percent = tile({ kind: kit.DeltaKind.Percent, now: 1400, before: 1000, neutral: true });
      assert.match(percent, /class="game-analytics-neutral"><span class="stats-change" data-change="up"/);
      assert.match(words(percent), /\+40%/);
      const amount = tile({
        kind: kit.DeltaKind.Amount,
        now: 4.1,
        before: 4.4,
        format: (change: number) => formatSigned(change, 1),
        digits: 1,
        neutral: true,
      });
      assert.match(amount, /data-direction="down" data-tone="neutral"/);
      assert.match(amount, /data-icon/);
    });

    it("writes a percentage that held as no change, with no arrow", () => {
      const tile = (delta: object): string => draw(kit.MetricTile, { id: "t", label: "Tile", value: "1", delta });
      const held = tile({ kind: kit.DeltaKind.Percent, now: 1001, before: 1000 });
      assert.match(held, /data-change="flat"/);
      assert.doesNotMatch(held, /data-icon/);
      assert.doesNotMatch(words(held), /\+/, "no plus for a number that did not move");
    });

    it("shows a dash for a change with a side missing", () => {
      const tile = (delta: object): string => draw(kit.MetricTile, { id: "t", label: "Tile", value: "1", delta });
      for (const kind of [kit.DeltaKind.Percent, kit.DeltaKind.Points, kit.DeltaKind.Amount]) {
        const markup = tile({ kind, now: null, before: 0.3, format: formatSigned });
        assert.equal(words(markup), "Tile 1 —", kind);
      }
    });

    it("carries a note and a sparkline that screen readers skip", () => {
      const tile = draw(kit.MetricTile, {
        id: "plays",
        label: "Plays",
        value: "30,889",
        note: "counted once the game has loaded",
        spark: [1, null, 3],
      });
      assert.match(tile, /<span class="stats-tile-note">counted once the game has loaded<\/span>/);
      assert.match(tile, /<canvas[^>]*aria-hidden="true"/);
      assert.match(draw(kit.MetricTiles, {}, "tiles"), /class="stats-tiles game-analytics-tiles"/);
    });
  });

  it("a section is a titled block with a hint, a place for controls and a footnote", () => {
    const section = draw(
      kit.ReportSection,
      { id: "sources", title: "Sources", hint: "New visitors in this period", controls: "CONTROLS", footnote: "NOTE" },
      "BODY",
    );
    const heading = /<h2 id="([^"]+)" class="game-analytics-section-title">Sources<\/h2>/.exec(section);
    assert.ok(heading, section);
    assert.ok(section.includes(`aria-labelledby="${heading[1]}"`), "the section is named by its heading");
    assert.match(section, /data-game-analytics-section="sources"/);
    assert.match(section, /<p class="game-analytics-section-hint">New visitors in this period<\/p>/);
    assert.match(section, /<div class="game-analytics-section-controls">CONTROLS<\/div>/);
    assert.match(section, /<p class="game-analytics-section-footnote">NOTE<\/p>/);
    const bare = draw(kit.ReportSection, { id: "plain", title: "Plain" }, "BODY");
    assert.equal(words(bare), "Plain BODY");
    assert.doesNotMatch(bare, /section-hint|section-controls|section-footnote/);
  });

  it("a segment switch is one choice of a few: the chosen one checked and the only tab stop", () => {
    const markup = draw(kit.SegmentSwitch, {
      id: "breakdown",
      label: "Group sources by",
      options: [
        { value: "channel", label: "Channel" },
        { value: "referrer", label: "Referrer" },
        { value: "country", label: "Country" },
      ],
      value: "referrer",
      onChange: () => undefined,
    });
    assert.match(markup, /role="radiogroup"[^>]*aria-label="Group sources by"/);
    assert.match(markup, /data-game-analytics-switch="breakdown"/);
    const options = tags(markup, /<button[^>]*role="radio"[^>]*>/);
    assert.equal(options.length, 3);
    assert.deepEqual(
      options.map((option) => [
        /data-game-analytics-option="([^"]+)"/.exec(option)?.[1],
        /aria-checked="([^"]+)"/.exec(option)?.[1],
        /tabindex="([^"]+)"/.exec(option)?.[1],
      ]),
      [
        ["channel", "false", "-1"],
        ["referrer", "true", "0"],
        ["country", "false", "-1"],
      ],
    );
  });

  it("a legend names each line and series beside a swatch that is more than a colour", () => {
    const markup = draw(kit.Legend, {
      items: [
        { id: "now", label: "Oct 19 – Nov 17", tone: LineTone.Main },
        { id: "before", label: "30 days before", tone: LineTone.Before },
        { id: "genex", label: "Genex", slot: SeriesSlot.First },
        { id: "left", label: "Did not return", outline: true },
      ],
    });
    assert.equal(tags(markup, /<li[^>]*>/).length, 4);
    assert.match(markup, /<span class="game-analytics-swatch" data-line="main" aria-hidden="true">/);
    assert.match(markup, /data-line="before"/);
    assert.match(markup, /data-series="1"/);
    assert.match(markup, /data-outline="true"/);
    assert.equal(words(markup), "Oct 19 – Nov 17 30 days before Genex Did not return");
  });

  it("an empty note says a block has nothing to show yet", () => {
    assert.equal(
      draw(kit.EmptyNote, {}, "No purchases in this period."),
      '<p class="game-analytics-empty" data-game-analytics-empty="true">No purchases in this period.</p>',
    );
  });

  describe("a line chart", () => {
    const props = {
      id: "daily",
      label: "Players per day",
      labels: ["Oct 19", "Oct 20", "Oct 21"],
      format: (value: number) => formatNumber(value),
      series: [
        { id: "now", label: "This period", tone: LineTone.Main, values: [410, null, 0] },
        { id: "before", label: "30 days before", tone: LineTone.Before, values: [300, 310, null] },
      ],
      marks: [{ index: 1, kind: AnnotationKind.Campaign, label: "Campaign launch_trailer" }],
    };

    it("draws on a canvas screen readers skip, inside a plot the keyboard can reach", () => {
      const markup = draw(kit.LineChart, props);
      assert.match(markup, /<figure[^>]*data-game-analytics-chart="daily"/);
      assert.match(markup, /<canvas[^>]*aria-hidden="true"/);
      assert.match(markup, /<div[^>]*role="img"[^>]*aria-label="Players per day"[^>]*tabindex="0"/);
    });

    it("has a table that says the same: a row a place, a column a series, a gap an empty cell", () => {
      const markup = draw(kit.LineChart, props);
      assert.match(markup, /<table class="sr-only"><caption>Players per day<\/caption>/);
      assert.match(
        markup,
        /<thead><tr><th scope="col">Day<\/th><th scope="col">This period<\/th><th scope="col">30 days before<\/th><th scope="col">Marks<\/th><\/tr><\/thead>/,
      );
      assert.equal(tableRow(markup, "Oct 19"), '<tr><th scope="row">Oct 19</th><td>410</td><td>300</td><td></td></tr>');
      assert.equal(
        tableRow(markup, "Oct 20"),
        '<tr><th scope="row">Oct 20</th><td></td><td>310</td><td>Campaign launch_trailer</td></tr>',
        "a missing value is an empty cell, never 0",
      );
      assert.equal(
        tableRow(markup, "Oct 21"),
        '<tr><th scope="row">Oct 21</th><td>0</td><td></td><td></td></tr>',
        "and a real zero is written",
      );
    });

    it("carries a legend for two lines or more, and none for one", () => {
      const two = draw(kit.LineChart, props);
      assert.match(two, /data-line="main"/);
      assert.match(two, /data-line="before"/);
      const one = draw(kit.LineChart, { ...props, series: props.series.slice(0, 1), marks: [] });
      assert.doesNotMatch(one, /game-analytics-legend/);
      assert.doesNotMatch(one, /Marks/, "no marks, no column for them");
      assert.doesNotMatch(draw(kit.LineChart, { ...props, legend: false }), /game-analytics-legend/);
    });
  });

  describe("a bar chart", () => {
    const stacked = {
      id: "by-channel",
      label: "New players per day, by where they came from",
      labels: ["Nov 4", "Nov 5"],
      format: (value: number) => formatNumber(value),
      series: [
        { id: "genex", label: "Genex", slot: SeriesSlot.First, values: [1100, 0] },
        { id: "campaigns", label: "Campaigns", slot: SeriesSlot.Second, values: [50, 25] },
      ],
    };

    it("says each day's parts and their sum in its table, and names the series in a legend", () => {
      const markup = draw(kit.BarChart, stacked);
      assert.match(markup, /<canvas[^>]*aria-hidden="true"/);
      assert.match(markup, /<th scope="col">Genex<\/th><th scope="col">Campaigns<\/th><th scope="col">Total<\/th>/);
      assert.equal(
        tableRow(markup, "Nov 4"),
        '<tr><th scope="row">Nov 4</th><td>1,100</td><td>50</td><td>1,150</td></tr>',
      );
      assert.equal(tableRow(markup, "Nov 5"), '<tr><th scope="row">Nov 5</th><td>0</td><td>25</td><td>25</td></tr>');
      assert.match(markup, /data-series="1"/);
      assert.match(markup, /data-series="2"/);
    });

    it("names what hangs under the baseline in its legend and its table, apart from the total", () => {
      const markup = draw(kit.BarChart, {
        ...stacked,
        below: { id: "left", label: "Did not return this week", values: [0, 310] },
      });
      assert.match(markup, /data-outline="true"/);
      assert.match(
        markup,
        /<th scope="col">Campaigns<\/th><th scope="col">Total<\/th><th scope="col">Did not return this week<\/th>/,
      );
      assert.equal(
        tableRow(markup, "Nov 5"),
        `<tr><th scope="row">Nov 5</th><td>0</td><td>25</td><td>25</td><td>${MINUS}310</td></tr>`,
      );
      assert.equal(
        tableRow(markup, "Nov 4"),
        '<tr><th scope="row">Nov 4</th><td>1,100</td><td>50</td><td>1,150</td><td>0</td></tr>',
      );
    });

    it("has no total and no legend for a single series", () => {
      const markup = draw(kit.BarChart, { ...stacked, series: stacked.series.slice(0, 1) });
      assert.doesNotMatch(markup, /Total/);
      assert.doesNotMatch(markup, /game-analytics-legend/);
      assert.equal(tableRow(markup, "Nov 4"), '<tr><th scope="row">Nov 4</th><td>1,100</td></tr>');
    });
  });

  it("a histogram writes every bucket's value over its bar, flags the tallest and dashes a missing one", () => {
    const markup = draw(kit.Histogram, {
      id: "lengths",
      label: "Share of plays by length",
      format: (value: number) => formatPercent(value),
      buckets: [
        { id: "under_10s", label: "< 10 s", value: 0.098 },
        { id: "under_10m", label: "3–10 min", value: 0.263, note: "most plays" },
        { id: "over_30m", label: "30 min +", value: null },
      ],
    });
    assert.match(markup, /<ol[^>]*aria-label="Share of plays by length"/);
    assert.equal(words(markup), "9.8% < 10 s most plays 26.3% 3–10 min — 30 min +");
    const buckets = tags(markup, /<li[^>]*>/);
    assert.equal(buckets.length, 3);
    assert.deepEqual(
      buckets.map((bucket) => bucket.includes('data-peak="true"')),
      [false, true, false],
    );
    assert.match(markup, /--game-analytics-share:1"/);
    assert.match(markup, /--game-analytics-share:0"/, "a missing bucket's bar is flat");
  });

  it("a heatmap is a table: a number in every cell, tinted by how busy it is, and a missing one bare", () => {
    const markup = draw(kit.Heatmap, {
      id: "hours",
      label: "Plays by weekday and hour",
      corner: "Day",
      columns: ["00:00", "01:00", "02:00"],
      rows: [
        { id: "mon", label: "Mon", cells: [0, 50, 100] },
        { id: "tue", label: "Tue", cells: [null, 25, 100] },
      ],
      format: (value: number) => formatNumber(value),
      scale: { low: "Fewer plays", high: "More" },
    });
    assert.match(
      markup,
      /<table[^>]*data-game-analytics-heatmap="hours"[^>]*><caption class="sr-only">Plays by weekday and hour<\/caption>/,
    );
    assert.equal(tags(markup, /<th scope="col"[^>]*>/).length, 4);
    assert.equal(tags(markup, /<th scope="row"[^>]*>/).length, 2);
    const cells = markup.match(/<td[^>]*>[^<]*<\/td>/g) ?? [];
    assert.equal(cells.length, 6);
    assert.equal(cells[0], `<td class="game-analytics-heat" style="--game-analytics-heat:${HEAT_MIN}">0</td>`);
    assert.equal(cells[2], `<td class="game-analytics-heat" style="--game-analytics-heat:${HEAT_MAX}">100</td>`);
    assert.equal(cells[3], '<td class="game-analytics-heat" data-empty="true"></td>');
    assert.match(markup, /Fewer plays/);
  });

  it("a cohort table writes each rate, leaves the days that have not passed empty, and flags a campaign in words", () => {
    const markup = draw(kit.CohortTable, {
      id: "cohorts",
      label: "Retention by first-play day",
      firstColumn: "First play",
      sizeColumn: "New players",
      columns: ["Day 1", "Day 2", "Day 3"],
      cohorts: [
        { id: "all", label: "Nov 2 – Nov 15", size: 5318, rates: [0.345, 0.268, 0.221], summary: true },
        { id: "2026-11-05", label: "Thu, Nov 5", size: 732, rates: [0.285, null], flag: "Campaign launch_trailer" },
      ],
    });
    assert.match(
      markup,
      /<table[^>]*data-game-analytics-cohorts="cohorts"[^>]*><caption class="sr-only">Retention by first-play day<\/caption>/,
    );
    assert.match(markup, /<tr[^>]*data-summary="true"/);
    assert.match(
      markup,
      /<span class="game-analytics-flag" role="img" aria-label="Campaign launch_trailer" title="Campaign launch_trailer"><\/span>/,
    );
    const row = /<tr data-game-analytics-cohort="2026-11-05">.*?<\/tr>/.exec(markup)?.[0] ?? "";
    const cells = row.match(/<td[^>]*>[^<]*<\/td>/g) ?? [];
    assert.equal(cells.length, 4, "the size, then a cell for every column");
    assert.match(cells[0] ?? "", />732<\/td>/);
    assert.match(cells[1] ?? "", /style="--game-analytics-heat:[\d.]+">28\.5%<\/td>/);
    assert.equal(cells[2], '<td class="game-analytics-heat" data-empty="true"></td>');
    assert.equal(
      cells[3],
      '<td class="game-analytics-heat" data-empty="true"></td>',
      "a row shorter than the table is padded",
    );
  });

  it("funnel steps count each step, say what share goes on and how many are lost between two", () => {
    const steps = [
      { id: "visited", label: "Opened the game page", count: 19_380 },
      {
        id: "pressed_play",
        label: "Pressed Play",
        count: 8560,
        onward: "91.6% see it load",
        lost: "720 leave while it loads",
      },
      { id: "returned", label: "level_complete", qualifier: "level = 1", count: 2270 },
    ];
    const markup = draw(kit.FunnelSteps, { id: "visit", label: "From the game page to coming back", steps });
    assert.match(markup, /<ol[^>]*aria-label="From the game page to coming back"/);
    assert.equal(
      words(markup),
      "Opened the game page 19,380 44.2% go on 10,820 leave Pressed Play 8,560 91.6% see it load 720 leave while it loads level_complete level = 1 2,270 11.7% of the first step",
    );
    assert.deepEqual(
      (markup.match(/--game-analytics-share:([\d.]+)/g) ?? []).map((share) => Number(share.split(":")[1]).toFixed(3)),
      ["1.000", "0.442", "0.117"],
    );
    const quiet = draw(kit.FunnelSteps, {
      id: "f",
      label: "Funnel",
      steps: [
        { id: "a", label: "A", count: 0, lost: null },
        { id: "b", label: "B", count: 0 },
      ],
    });
    assert.equal(words(quiet), "A 0 B 0", "an empty funnel claims no share");
  });

  it("a bar list gives each row its value, its share and a bar against the longest", () => {
    const markup = draw(kit.BarList, {
      id: "channels",
      label: "Where new players came from",
      items: [
        { id: "genex", label: "Genex", value: 3790 },
        { id: "campaigns", label: "Campaigns", value: 2480 },
        { id: "search", label: "Search", value: 0 },
      ],
    });
    assert.match(markup, /<ul[^>]*aria-label="Where new players came from"/);
    assert.equal(words(markup), "Genex 3,790 60% Campaigns 2,480 40% Search 0 0%");
    assert.match(markup, /--game-analytics-share:1"/);
    assert.match(markup, /--game-analytics-share:0\.654/);
    const funnel = draw(kit.BarList, {
      id: "steps",
      label: "New visitors, step by step",
      total: 19_380,
      shareDigits: 1,
      items: [
        { id: "visited", label: "Opened the game page", value: 19_380 },
        { id: "loaded", label: "Game loaded", value: 7840 },
      ],
    });
    assert.equal(words(funnel), "Opened the game page 19,380 100.0% Game loaded 7,840 40.5%");
    const nothing = draw(kit.BarList, { id: "n", label: "Nothing", items: [{ id: "a", label: "A", value: 0 }] });
    assert.equal(words(nothing), "A 0 —", "nothing to divide by is a dash");
  });

  describe("a data table", () => {
    interface Source {
      key: string;
      name: string;
      shown: number | null;
      rate: number | null;
      seconds: number | null;
      nex: number | null;
      share: number | null;
      parts: Source[];
    }
    const source = (key: string, name: string, over: Partial<Source> = {}): Source => ({
      key,
      name,
      shown: 157_900,
      rate: 0.405,
      seconds: 340,
      nex: 2.17,
      share: 0.5,
      parts: [],
      ...over,
    });
    const long = "a_very_long_campaign_name_that_cannot_fit_in_its_column_however_wide_the_window_is";
    const rows = [
      source("genex", "Genex", { parts: [source("feed", "Feed"), source("featured", "Featured")] }),
      source("direct", long, { shown: null, rate: null, seconds: null, nex: null, share: null }),
    ];
    const table = (over: object = {}): string =>
      draw(kit.DataTable, {
        id: "sources",
        label: "New visitors and players by source",
        rowId: (row: Source) => row.key,
        rows,
        columns: [
          { id: "name", label: "Source", kind: kit.ColumnKind.Text, value: (row: Source) => row.name, mask: true },
          { id: "shown", label: "Shown", kind: kit.ColumnKind.Number, value: (row: Source) => row.shown, quiet: true },
          { id: "rate", label: "Visit to play", kind: kit.ColumnKind.Rate, value: (row: Source) => row.rate },
          { id: "time", label: "Play length", kind: kit.ColumnKind.Duration, value: (row: Source) => row.seconds },
          { id: "nex", label: "Nex per player", kind: kit.ColumnKind.Nex, value: (row: Source) => row.nex },
          { id: "share", label: "", kind: kit.ColumnKind.Bar, value: (row: Source) => row.share },
        ],
        ...over,
      });
    /** The cells of the row `id`, each as its opening tag and its words. */
    const cellsOf = (markup: string, id: string): [string, string][] => {
      const row = new RegExp(`<div role="row"[^>]*data-game-analytics-row="${id}".*?(?=<div role="row"|$)`).exec(
        markup,
      );
      return (row?.[0].match(/<span role="cell"[^>]*>.*?(?=<span role="cell"|$)/g) ?? []).map((cell) => [
        /^<span[^>]*>/.exec(cell)?.[0] ?? "",
        words(cell),
      ]);
    };

    it("is a table with a caption for assistive technology and a heading for every column", () => {
      const markup = table();
      assert.match(markup, /<div role="table"[^>]*aria-label="New visitors and players by source"/);
      assert.match(markup, /data-game-analytics-table="sources"/);
      const headings = tags(markup, /<span role="columnheader"[^>]*>/);
      assert.equal(headings.length, 6);
      assert.deepEqual(
        headings.map((heading) => /data-align="([^"]+)"/.exec(heading)?.[1]),
        ["start", "end", "end", "end", "end", "start"],
        "text reads from the start, numbers line up at the end",
      );
    });

    it("writes each column in its kind, numbers at the end of their column", () => {
      const cells = cellsOf(table(), "genex");
      assert.deepEqual(
        cells.map(([, text]) => text),
        ["Genex", "157,900", "40.5%", "5m 40s", "2.17", ""],
      );
      assert.deepEqual(
        cells.map(([tag]) => [/data-kind="([^"]+)"/.exec(tag)?.[1], /data-align="([^"]+)"/.exec(tag)?.[1]]),
        [
          ["text", "start"],
          ["number", "end"],
          ["rate", "end"],
          ["duration", "end"],
          ["nex", "end"],
          ["bar", "start"],
        ],
      );
      assert.match(cells[1]?.[0] ?? "", /data-quiet="true"/);
    });

    it("writes a dash for a number it does not know, never zero", () => {
      const cells = cellsOf(table(), "direct");
      assert.deepEqual(
        cells.map(([, text]) => text),
        [long, "—", "—", "—", "—", ""],
      );
    });

    it("cuts long text short with the whole of it a hover away, and masks a name the creator chose", () => {
      const markup = table();
      assert.ok(
        markup.includes(
          `<span class="game-analytics-cell-text" title="${long}" data-analytics-mask="true">${long}</span>`,
        ),
      );
    });

    it("opens a row with rows inside it, one level deep, from a button that says whether it is open", () => {
      const closed = table({ parts: (row: Source) => row.parts });
      assert.match(closed, /<button[^>]*aria-expanded="false"[^>]*aria-label="Show what is inside Genex"/);
      assert.match(closed, /<button[^>]*aria-expanded[^>]*data-game-analytics-expand="genex"/, "found by its row");
      assert.doesNotMatch(closed, /Featured/);
      assert.equal(tags(closed, /<button[^>]*aria-expanded/).length, 1, "a row with nothing inside has no button");
      const open = table({ parts: (row: Source) => row.parts, expanded: ["genex"] });
      assert.match(open, /<button[^>]*aria-expanded="true"[^>]*aria-label="Hide what is inside Genex"/);
      assert.equal(tags(open, /<div role="row"[^>]*data-part="true"[^>]*>/).length, 2);
      assert.deepEqual(cellsOf(open, "featured")[0]?.[1], "Featured");
    });

    it("lines a row with nothing inside up with the rows that open, and leaves a table where none opens as it is", () => {
      const space = /<span class="game-analytics-expander-space" aria-hidden="true"><\/span>/;
      const opening = table({ parts: (row: Source) => row.parts, total: source("all", "All sources") });
      assert.match(cellsOf(opening, "direct")[0]?.[0] ?? "", /data-kind="text"/);
      assert.match(
        /data-game-analytics-row="direct".*?(?=<div role="row")/.exec(opening)?.[0] ?? "",
        space,
        "a row with nothing inside starts where the names beside a button do",
      );
      assert.doesNotMatch(
        /data-game-analytics-row="genex".*?(?=<div role="row")/.exec(opening)?.[0] ?? "",
        space,
        "a row with a button needs no room for one",
      );
      assert.doesNotMatch(/<div role="row"[^>]*data-total="true".*$/.exec(opening)?.[0] ?? "", space);
      assert.doesNotMatch(table(), space, "no row opens, so no row makes room");
    });

    it("ends with a total row that leaves what does not add up empty", () => {
      const markup = table({ total: source("all", "All sources", { rate: null, nex: null, share: null }) });
      const total = /<div role="row"[^>]*data-total="true".*$/.exec(markup)?.[0] ?? "";
      assert.ok(total, "the total row is the last");
      assert.equal(words(total), "All sources 157,900 5m 40s");
    });

    it("lets a row be picked, from a button that says which one is", () => {
      const markup = table({ onSelect: () => undefined, selectedId: "direct" });
      const picks = tags(markup, /<button[^>]*class="game-analytics-cell-pick"[^>]*>/);
      assert.deepEqual(
        picks.map((pick) => /aria-pressed="([^"]+)"/.exec(pick)?.[1]),
        ["false", "true"],
      );
      assert.deepEqual(
        picks.map((pick) => /data-game-analytics-pick="([^"]+)"/.exec(pick)?.[1]),
        ["genex", "direct"],
        "each found by its row",
      );
      assert.match(markup, /data-game-analytics-row="direct"[^>]*data-selected="true"/);
    });

    it("lines up numbers a report wrote itself at the end, and lets a column draw its own cell", () => {
      const markup = draw(kit.DataTable, {
        id: "places",
        label: "Installed players compared with browser players",
        rowId: (row: { id: string }) => row.id,
        rows: [{ id: "day7", name: "Still playing on day 7", installed: "26.1%" }],
        columns: [
          { id: "name", label: "New players", kind: kit.ColumnKind.Text, value: (row: { name: string }) => row.name },
          {
            id: "installed",
            label: "Installed",
            kind: kit.ColumnKind.Text,
            numeric: true,
            value: (row: { installed: string }) => row.installed,
          },
          { id: "copy", label: "", kind: kit.ColumnKind.Text, value: () => null, cell: () => "COPY BUTTON" },
        ],
      });
      assert.deepEqual(
        tags(markup, /<span role="columnheader"[^>]*>/).map((heading) => /data-align="([^"]+)"/.exec(heading)?.[1]),
        ["start", "end", "start"],
      );
      const cells = cellsOf(markup, "day7");
      assert.match(cells[1]?.[0] ?? "", /data-align="end"/);
      assert.deepEqual(
        cells.map(([, text]) => text),
        ["Still playing on day 7", "26.1%", "COPY BUTTON"],
      );
    });

    it("flags a number with a word kept apart from it, so it is not read as one word", () => {
      const markup = table({
        columns: [
          { id: "name", label: "Source", kind: kit.ColumnKind.Text, value: (row: Source) => row.name },
          {
            id: "time",
            label: "Play length",
            kind: kit.ColumnKind.Duration,
            value: (row: Source) => row.seconds,
            flag: (row: Source) => (row.key === "genex" ? "slow" : null),
          },
        ],
      });
      const [, flagged] = cellsOf(markup, "genex");
      assert.match(flagged?.[0] ?? "", /data-kind="duration"/);
      assert.ok(markup.includes('5m 40s <span class="game-analytics-cell-flag">slow</span>'));
      assert.doesNotMatch(markup, /data-game-analytics-row="direct".*game-analytics-cell-flag/s);
    });

    it("says so when it has no rows", () => {
      const markup = table({ rows: [], empty: "No sources in this period." });
      assert.match(markup, /<p class="game-analytics-empty"[^>]*>No sources in this period\.<\/p>/);
      assert.doesNotMatch(markup, /role="table"/);
    });
  });

  it("small numbers in a row and a list of terms keep their words and dash what is missing", () => {
    const stats = draw(kit.MiniStats, {
      items: [
        { id: "d1", label: "Day 1", value: "34.5%" },
        { id: "d30", label: "Day 30", value: null },
      ],
    });
    assert.equal(words(stats), "Day 1 34.5% Day 30 —");
    assert.match(stats, /<dl class="game-analytics-ministats">/);
    const terms = draw(kit.TermList, {
      items: [{ id: "play_start", term: "play_start", detail: "A player pressed Play" }],
      mono: true,
    });
    assert.match(terms, /<dl class="game-analytics-terms" data-mono="true">/);
    assert.equal(words(terms), "play_start A player pressed Play");
  });

  it("keeps a thing's colour the same on every chart", () => {
    assert.equal(kit.CHANNEL_SLOT.genex, SeriesSlot.First);
    assert.equal(kit.CHANNEL_SLOT.campaigns, SeriesSlot.Second, "a campaign is the orange of its marks");
    assert.equal(kit.CHANNEL_SLOT.other, SeriesSlot.Rest);
    assert.equal(new Set(Object.values(kit.CHANNEL_SLOT)).size, 6, "no two channels share a colour");
    assert.equal(new Set(Object.values(kit.OS_SLOT)).size, 4);
  });
});
