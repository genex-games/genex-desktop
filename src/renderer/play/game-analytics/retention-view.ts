/**
 * What the Retention report draws, derived from its answer without React: the five headline tiles
 * with how each moved, where the three switches stand, the curve's lines with the days it names,
 * the cohort table with its summary row and what its dots mean, the groups compared with their
 * total, and each week's players stacked. The component only lays these out. A rate that cannot be
 * known stays null all the way to the kit, which writes it as a dash or leaves its cell empty.
 *
 * It reads no clock and no time zone: every day is a UTC day the answer gives, written by the kit.
 */
import {
  type AnalyticsWindow,
  type Cohort,
  CohortSize,
  type GameReportOptions,
  type LifecycleWeek,
  RETENTION_DAYS,
  type RetentionCurve,
  RetentionMode,
  type RetentionPoint,
  type RetentionReport,
  SegmentBy,
  type SegmentRow,
} from "../../../shared/game-analytics.ts";
import { formatList } from "../../../shared/i18n.ts";
import { dayBefore } from "../../../shared/play-stats.ts";
import {
  type BarSeries,
  type CohortRow,
  ColumnKind,
  type DataColumn,
  DeltaKind,
  formatDay,
  formatDayRange,
  formatNumber,
  formatPercent,
  formatWeekday,
  type LegendItem,
  type LineSeries,
  LineTone,
  type MetricDelta,
  ratio,
  type SegmentOption,
  SeriesSlot,
} from "./kit/index.ts";
import { countryName } from "./report-words.ts";
import { RETENTION_WORDS as WORDS } from "./retention-words.ts";

/** The days the curve names under its plot, and the ones whose rate it writes on the line. */
const CURVE_TICK_DAYS = [1, 7, 14, 21, 30] as const;
/** The headline days but day 3, which sits too close to day 1 for both to be written. */
const CURVE_CALLOUT_DAYS = [1, 7, 14, 30] as const;
/** The headline days a group of new players is compared on. */
const SEGMENT_DAYS = { day1: 1, day7: 7, day30: 30 } as const;
/**
 * The group comparison's tracks: the numbers as wide as their headings ("New players", "Day 30"),
 * so a group's name ("Installed on their computer") keeps the rest of a half-page block.
 */
const SEGMENT_TRACKS = { group: "minmax(140px, 1fr)", newPlayers: "88px", day: "56px" } as const;
/** The last day of a week, counted from its Monday. */
const WEEK_LAST_DAY = 6;
const WEEK_DAYS = 7;
/** The ids of the rows that sum a table. */
const ALL = "all";

/** The switch that says what counts as coming back. */
export const MODE_OPTIONS: readonly SegmentOption<RetentionMode>[] = [
  { value: RetentionMode.OnDay, label: WORDS.modes[RetentionMode.OnDay] },
  { value: RetentionMode.DayOrLater, label: WORDS.modes[RetentionMode.DayOrLater] },
];
/** The switch that groups first plays by day or by week. */
export const COHORT_OPTIONS: readonly SegmentOption<CohortSize>[] = [
  { value: CohortSize.Day, label: WORDS.cohortSizes[CohortSize.Day] },
  { value: CohortSize.Week, label: WORDS.cohortSizes[CohortSize.Week] },
];
/** The switch that picks what groups of new players are compared by. */
export const SEGMENT_OPTIONS: readonly SegmentOption<SegmentBy>[] = [
  SegmentBy.Place,
  SegmentBy.Channel,
  SegmentBy.Device,
  SegmentBy.Country,
  SegmentBy.Version,
].map((value) => ({ value, label: WORDS.segmentBy[value] }));

/** Where the three switches stand. */
export interface RetentionChosen {
  mode: RetentionMode;
  cohort: CohortSize;
  segmentBy: SegmentBy;
}

/** One headline day as a tile shows it. */
export interface RetentionTile {
  id: string;
  label: string;
  /** The rate as it reads; null when the day has not passed. */
  value: string | null;
  /** The change in points against the period before; none for a day that has not passed. */
  delta?: MetricDelta;
  /** Similar games' rate on the same day; none while there are too few to compare with. */
  note?: string;
}

/** The curve by day since the first play. */
export interface RetentionCurveView {
  /** Each place's name: "Day 1", "Day 2", … */
  labels: string[];
  series: LineSeries[];
  /** The lines' swatches, for the section's head. */
  legend: LegendItem[];
  /** The places named under the plot, and the ones whose rate is written on the line. */
  ticks: number[];
  callouts: number[];
}

/** The cohort table. */
export interface RetentionCohorts {
  /** How the first plays the table shows are grouped. */
  size: CohortSize;
  title: string;
  hint: string;
  caption: string;
  /** The headings of the days (or weeks) after the first play. */
  columns: string[];
  /** The row that sums the cohorts, then the cohorts, oldest first. */
  rows: CohortRow[];
  /** The campaigns the flagged cohorts name, in the order they come. */
  campaigns: string[];
  /** What the dots mean; null when no cohort is flagged. */
  note: string | null;
}

/** A group of new players as its table row shows it. */
export interface RetentionSegment {
  id: string;
  label: string;
  newPlayers: number;
  day1: number | null;
  day7: number | null;
  day30: number | null;
}

/** The groups compared. */
export interface RetentionSegments {
  /** What the groups shown are split by. */
  by: SegmentBy;
  caption: string;
  rows: RetentionSegment[];
  /** Everyone: the groups' new players summed, on the headline's own rates. Null with no groups. */
  total: RetentionSegment | null;
}

/** Each week's players, stacked. */
export interface RetentionWeeks {
  /** Each week's Monday, written. */
  labels: string[];
  /** New, stayed and back, the first at the foot. */
  series: BarSeries[];
  /** Those who played the week before and not this one, drawn under the line. */
  below: { id: string; label: string; values: number[] };
  /** The latest week's players, all told. */
  hint: string;
}

/** Everything the report draws. */
export interface RetentionView {
  chosen: RetentionChosen;
  tiles: RetentionTile[];
  /** Null while nobody of this game's can have come back. */
  curve: RetentionCurveView | null;
  /** Null when the period has no new players. */
  cohorts: RetentionCohorts | null;
  segments: RetentionSegments;
  /** Null before the game's first whole week. */
  weeks: RetentionWeeks | null;
}

const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);
const anyKnown = (values: readonly (number | null)[]): boolean => values.some((value) => value !== null);
/** The headline's rate on `day`; null when it has not passed or the answer has no such day. */
const rateOn = (headline: readonly RetentionPoint[], day: number): number | null =>
  headline.find((point) => point.day === day)?.rate ?? null;

/** A tile for each headline day, in the days' own order; a day the answer lacks is a dash. */
function tilesOf(headline: readonly RetentionPoint[]): RetentionTile[] {
  return RETENTION_DAYS.map((day) => {
    const point = headline.find((one) => one.day === day);
    const rate = point?.rate ?? null;
    const similar = point?.similar ?? null;
    const tile: RetentionTile = {
      id: `day${day}`,
      label: WORDS.day(day),
      value: rate === null ? null : formatPercent(rate),
    };
    if (rate !== null) tile.delta = { kind: DeltaKind.Points, now: rate, before: point?.before ?? null };
    if (similar !== null) tile.note = WORDS.similar(formatPercent(similar));
    return tile;
  });
}

/** The places of `days` on a curve of `length` days. */
const placesOf = (days: readonly number[], length: number): number[] =>
  days.filter((day) => day <= length).map((day) => day - 1);

/**
 * The curve's lines: this period's always, the period before's when it knows a day, similar games'
 * when there are enough to compare with. Null while neither of the game's own lines knows a day.
 */
function curveOf(curve: RetentionCurve, window: AnalyticsWindow): RetentionCurveView | null {
  if (!anyKnown(curve.rates) && !anyKnown(curve.before)) return null;
  const length = curve.rates.length;
  const period = formatDayRange(dayBefore(window.endsOn, window.days - 1), window.endsOn);
  const series: LineSeries[] = [{ id: "now", label: period, tone: LineTone.Main, values: curve.rates }];
  if (anyKnown(curve.before)) {
    series.push({ id: "before", label: WORDS.daysBefore(window.days), tone: LineTone.Before, values: curve.before });
  }
  if (curve.similar && anyKnown(curve.similar)) {
    series.push({ id: "similar", label: WORDS.similarGames, tone: LineTone.Similar, values: curve.similar });
  }
  return {
    labels: Array.from({ length }, (_, index) => WORDS.day(index + 1)),
    series,
    legend: series.map(({ id, label, tone }) => ({ id, label, tone })),
    ticks: placesOf(CURVE_TICK_DAYS, length),
    callouts: placesOf(CURVE_CALLOUT_DAYS, length),
  };
}

/** A cohort's last day: its own for a day's cohort, its week's Sunday for a week's, never past the period. */
function cohortEnd(cohort: Cohort, size: CohortSize, endsOn: string): string {
  if (size === CohortSize.Day) return cohort.startsOn;
  const weekday = (new Date(`${cohort.startsOn}T00:00:00.000Z`).getUTCDay() + WEEK_LAST_DAY) % WEEK_DAYS;
  const sunday = dayBefore(cohort.startsOn, weekday - WEEK_LAST_DAY);
  return sunday < endsOn ? sunday : endsOn;
}

/** How many columns the table needs: up to the last day (or week) any cohort knows, and one at least. */
function widthOf(cohorts: readonly Cohort[]): number {
  const widest = Math.max(0, ...cohorts.map((cohort) => cohort.rates.findLastIndex((rate) => rate !== null) + 1));
  return Math.max(1, widest);
}

/** The cohorts' mean on one column, each weighted by its size, over the ones that know it; null when none does. */
function weightedMean(cohorts: readonly Cohort[], column: number): number | null {
  const known = cohorts.filter((cohort) => (cohort.rates[column] ?? null) !== null);
  const returned = sum(known.map((cohort) => cohort.size * (cohort.rates[column] ?? 0)));
  return ratio(returned, sum(known.map((cohort) => cohort.size)));
}

/** What the dots on flagged cohorts mean: one campaign by name, or the names of several. */
function flagNote(campaigns: readonly string[], size: CohortSize): string | null {
  const [only] = campaigns;
  if (only === undefined) return null;
  const notes = WORDS.flagNotes[size];
  return campaigns.length === 1 ? notes.one(only) : notes.several(formatList([...campaigns]));
}

/**
 * The cohort table: a first row that sums the cohorts, then each cohort oldest first, every row as
 * wide as the last day anybody knows. Null when there is no cohort to show.
 */
function cohortsOf(data: RetentionReport, window: AnalyticsWindow): RetentionCohorts | null {
  const size = data.cohort;
  const cohorts = data.cohorts.toSorted((a, b) => a.startsOn.localeCompare(b.startsOn));
  const first = cohorts[0];
  const last = cohorts.at(-1);
  if (!first || !last) return null;
  const columns = Array.from({ length: widthOf(cohorts) }, (_, index) => index);
  const rows: CohortRow[] = cohorts.map((cohort) => ({
    id: cohort.startsOn,
    label:
      size === CohortSize.Day
        ? formatWeekday(cohort.startsOn)
        : formatDayRange(cohort.startsOn, cohortEnd(cohort, size, window.endsOn)),
    size: cohort.size,
    rates: columns.map((column) => cohort.rates[column] ?? null),
    flag: cohort.campaign === null ? null : WORDS.flag(cohort.campaign),
  }));
  const summary: CohortRow = {
    id: ALL,
    label: formatDayRange(first.startsOn, cohortEnd(last, size, window.endsOn)),
    size: sum(cohorts.map((cohort) => cohort.size)),
    rates: columns.map((column) => weightedMean(cohorts, column)),
    summary: true,
  };
  const campaigns = [...new Set(cohorts.flatMap((cohort) => cohort.campaign ?? []))];
  return {
    size,
    title: WORDS.cohortTitles[size],
    hint: WORDS.cohortHints[size][data.mode],
    caption: WORDS.cohortCaptions[size],
    columns: columns.map((column) => (size === CohortSize.Week ? WORDS.week(column + 1) : WORDS.day(column + 1))),
    rows: [summary, ...rows],
    campaigns,
    note: flagNote(campaigns, size),
  };
}

/** `key`'s name among `names`, or the key itself when it has none. */
const named = (names: Readonly<Record<string, string>>, key: string): string =>
  Object.hasOwn(names, key) ? (names[key] ?? key) : key;

/** How each split names a group's key: by its vocabulary's words, a country by its name, a version as written. */
const GROUP_NAME = {
  [SegmentBy.Place]: (key) => named(WORDS.places, key),
  [SegmentBy.Channel]: (key) => named(WORDS.channels, key),
  [SegmentBy.Device]: (key) => named(WORDS.devices, key),
  [SegmentBy.Country]: countryName,
  [SegmentBy.Version]: (key) => key,
} as const satisfies Record<SegmentBy, (key: string) => string>;

/**
 * The groups as rows, and a total for everyone: the period's new players as the cohorts count them,
 * on the headline's own rates. The groups listed are the largest and need not add up to it.
 */
function segmentsOf(data: RetentionReport): RetentionSegments {
  const name = GROUP_NAME[data.segmentBy];
  const rows = data.segments.map(
    ({ key, newPlayers, day1, day7, day30 }: SegmentRow): RetentionSegment => ({
      id: key,
      label: name(key),
      newPlayers,
      day1,
      day7,
      day30,
    }),
  );
  const total: RetentionSegment = {
    id: ALL,
    label: WORDS.allNewPlayers,
    newPlayers: sum(data.cohorts.map((cohort) => cohort.size)),
    day1: rateOn(data.headline, SEGMENT_DAYS.day1),
    day7: rateOn(data.headline, SEGMENT_DAYS.day7),
    day30: rateOn(data.headline, SEGMENT_DAYS.day30),
  };
  return {
    by: data.segmentBy,
    caption: WORDS.segmentCaptions[data.segmentBy],
    rows,
    total: rows.length > 0 ? total : null,
  };
}

/**
 * The comparison table's columns. A version is the creator's own words, so its column is kept out
 * of usage recordings; the other splits name their groups in the app's words.
 */
export function segmentColumns(by: SegmentBy): DataColumn<RetentionSegment>[] {
  return [
    {
      id: "group",
      label: WORDS.group,
      kind: ColumnKind.Text,
      value: (row) => row.label,
      mask: by === SegmentBy.Version,
      width: SEGMENT_TRACKS.group,
    },
    {
      id: "newPlayers",
      label: WORDS.newPlayers,
      kind: ColumnKind.Number,
      value: (row) => row.newPlayers,
      quiet: true,
      width: SEGMENT_TRACKS.newPlayers,
    },
    {
      id: "day1",
      label: WORDS.day(SEGMENT_DAYS.day1),
      kind: ColumnKind.Rate,
      value: (row) => row.day1,
      width: SEGMENT_TRACKS.day,
    },
    {
      id: "day7",
      label: WORDS.day(SEGMENT_DAYS.day7),
      kind: ColumnKind.Rate,
      value: (row) => row.day7,
      width: SEGMENT_TRACKS.day,
    },
    {
      id: "day30",
      label: WORDS.day(SEGMENT_DAYS.day30),
      kind: ColumnKind.Rate,
      value: (row) => row.day30,
      width: SEGMENT_TRACKS.day,
    },
  ];
}

/** Each week's players stacked, oldest first, with the latest week's total in words. Null with no week. */
function weeksOf(weeks: readonly LifecycleWeek[]): RetentionWeeks | null {
  const sorted = weeks.toSorted((a, b) => a.startsOn.localeCompare(b.startsOn));
  const latest = sorted.at(-1);
  if (!latest) return null;
  const players = latest.fresh + latest.stayed + latest.back;
  return {
    labels: sorted.map((week) => formatDay(week.startsOn)),
    series: [
      { id: "fresh", label: WORDS.lifecycle.fresh, slot: SeriesSlot.First, values: sorted.map((week) => week.fresh) },
      {
        id: "stayed",
        label: WORDS.lifecycle.stayed,
        slot: SeriesSlot.Third,
        values: sorted.map((week) => week.stayed),
      },
      { id: "back", label: WORDS.lifecycle.back, slot: SeriesSlot.Fifth, values: sorted.map((week) => week.back) },
    ],
    below: { id: "left", label: WORDS.lifecycle.left, values: sorted.map((week) => week.left) },
    hint: WORDS.weekOf(formatDay(latest.startsOn), players, formatNumber(players)),
  };
}

/**
 * What the report draws for an answer. The switches follow `options` (what was asked a moment ago)
 * and fall back to what the answer says genex.games picked; every number, and the words that say
 * what the numbers are, follow the answer.
 */
export function retentionView(
  answer: { data: RetentionReport; window: AnalyticsWindow },
  options: GameReportOptions,
): RetentionView {
  const { data, window } = answer;
  return {
    chosen: {
      mode: options.mode ?? data.mode,
      cohort: options.cohort ?? data.cohort,
      segmentBy: options.segmentBy ?? data.segmentBy,
    },
    tiles: tilesOf(data.headline),
    curve: curveOf(data.curve, window),
    cohorts: cohortsOf(data, window),
    segments: segmentsOf(data),
    weeks: weeksOf(data.weeks),
  };
}
