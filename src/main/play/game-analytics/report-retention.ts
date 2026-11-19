/**
 * The Retention report as genex.games answers it: whether new players come back. The headline days,
 * the curve by days since the first play, the cohorts by first-play day or week, the groups of new
 * players compared, and each week's players by what they did the week before.
 *
 * Read with the helpers in `kit.ts`, the way `report-overview.ts` reads its own: the options the
 * answer echoes, the headline and the curve are fixed parts, so one of them broken refuses the
 * report; a cohort, a group or a week that does not read is left out and the rest kept; a rate that
 * is null stays null.
 */
import {
  type AnalyticsWindow,
  type Cohort,
  CohortSize,
  DeviceClass,
  type LifecycleWeek,
  PlayPlace,
  RETENTION_DAYS,
  RETENTION_SPAN,
  type RetentionCurve,
  RetentionMode,
  type RetentionPoint,
  type RetentionReport,
  SegmentBy,
  type SegmentRow,
  SourceChannel,
} from "../../../shared/game-analytics.ts";
import { dayBefore, STATS_PERIODS } from "../../../shared/play-stats.ts";
import { isRecord } from "../gallery.ts";
import {
  count,
  countryCode,
  isoDay,
  line,
  oneOf,
  type Read,
  rateOrNull,
  rows,
  series,
  shortSeries,
  whole,
} from "./kit.ts";

/** The most cohorts a table keeps: one for each day of the longest period. */
const COHORTS_MAX = Math.max(...STATS_PERIODS);
/** The most groups a comparison keeps (countries and versions have no fixed end), and the most weeks. */
const SEGMENTS_MAX = 50;
const WEEKS_MAX = 26;
/** The longest a campaign's name or a version may read. */
const LABEL_MAX = 200;
/** How far before the period a week's cohort may begin: its Monday, when the period starts mid-week. */
const WEEK_LEAD_DAYS = 6;
/** The last day of a week, counted from its Monday. */
const WEEK_LAST_DAY = 6;
/** Monday, as `Date.getUTCDay` numbers the days. */
const MONDAY = 1;

const isMode = oneOf(RetentionMode);
const isCohortSize = oneOf(CohortSize);
const isSegmentBy = oneOf(SegmentBy);
const isPlace = oneOf(PlayPlace);
const isChannel = oneOf(SourceChannel);
const isDevice = oneOf(DeviceClass);

/** A group's key as each split writes it: a value of its vocabulary, a country's code, or a version's words. */
const SEGMENT_KEY = {
  [SegmentBy.Place]: (value) => (isPlace(value) ? value : undefined),
  [SegmentBy.Channel]: (value) => (isChannel(value) ? value : undefined),
  [SegmentBy.Device]: (value) => (isDevice(value) ? value : undefined),
  [SegmentBy.Country]: countryCode,
  [SegmentBy.Version]: (value) => line(value, LABEL_MAX),
} as const satisfies Record<SegmentBy, Read<string>>;

/** Retention on one day since the first play, now, before and for similar games. */
const retentionPoint: Read<RetentionPoint> = (value) => {
  if (!isRecord(value)) return undefined;
  const day = count(value.day);
  if (day === undefined || day < 1 || day > RETENTION_SPAN) return undefined;
  return whole({
    day,
    rate: rateOrNull(value.rate),
    before: rateOrNull(value.before),
    similar: rateOrNull(value.similar),
  });
};

/**
 * The point of each headline day, in the days' own order. A point for another day is left out; a
 * headline day with no point that reads refuses the report.
 */
function headlineOf(value: unknown): RetentionPoint[] | undefined {
  const points = rows(value, RETENTION_SPAN, retentionPoint, (point) => String(point.day));
  if (!points) return undefined;
  const headline = RETENTION_DAYS.flatMap((day) => points.find((point) => point.day === day) ?? []);
  return headline.length === RETENTION_DAYS.length ? headline : undefined;
}

/**
 * New players who play again by days since their first play: up to `RETENTION_SPAN` days, the
 * period before and similar games' median held to the same length. The Overview reads the same
 * curve the same way (`report-overview.ts` keeps its reader private).
 */
function retentionCurve(value: unknown): RetentionCurve | undefined {
  if (!isRecord(value)) return undefined;
  const rates = shortSeries(value.rates, RETENTION_SPAN, rateOrNull);
  if (!rates) return undefined;
  const before = series(value.before, rates.length, rateOrNull);
  const similar = value.similar === null ? null : series(value.similar, rates.length, rateOrNull);
  return before && similar !== undefined ? { rates, before, similar } : undefined;
}

/**
 * A cohort of the period: one that began on a day of it, or, for a week's cohort, on that week's
 * Monday just before it. Its campaign is a name someone wrote on a link.
 */
function cohortIn(window: AnalyticsWindow, size: CohortSize): Read<Cohort> {
  const lead = size === CohortSize.Week ? WEEK_LEAD_DAYS : 0;
  const firstDay = dayBefore(window.endsOn, window.days - 1 + lead);
  return (value) => {
    if (!isRecord(value)) return undefined;
    const startsOn = isoDay(value.startsOn);
    const inPeriod = startsOn !== undefined && startsOn >= firstDay && startsOn <= window.endsOn;
    return whole({
      startsOn: inPeriod ? startsOn : undefined,
      size: count(value.size),
      rates: shortSeries(value.rates, RETENTION_SPAN, rateOrNull),
      campaign: value.campaign === null ? null : line(value.campaign, LABEL_MAX),
    });
  };
}

/** A group of new players; one whose key is not of the split asked for is left out. */
function segmentOf(by: SegmentBy): Read<SegmentRow> {
  return (value) => {
    if (!isRecord(value)) return undefined;
    return whole({
      key: SEGMENT_KEY[by](value.key),
      newPlayers: count(value.newPlayers),
      day1: rateOrNull(value.day1),
      day7: rateOrNull(value.day7),
      day30: rateOrNull(value.day30),
    });
  };
}

/** A whole week that has passed by `endsOn`: it begins on a Monday and its Sunday is not after that day. */
function weekUpTo(endsOn: string): Read<LifecycleWeek> {
  return (value) => {
    if (!isRecord(value)) return undefined;
    const startsOn = isoDay(value.startsOn);
    if (startsOn === undefined || new Date(`${startsOn}T00:00:00.000Z`).getUTCDay() !== MONDAY) return undefined;
    if (dayBefore(startsOn, -WEEK_LAST_DAY) > endsOn) return undefined;
    return whole({
      startsOn,
      fresh: count(value.fresh),
      stayed: count(value.stayed),
      back: count(value.back),
      left: count(value.left),
    });
  };
}

/** The Retention report for `window`, or null when `data` is not one. */
export function toRetentionReport(data: unknown, window: AnalyticsWindow): RetentionReport | null {
  if (!isRecord(data)) return null;
  const { mode, cohort, segmentBy } = data;
  if (!isMode(mode) || !isCohortSize(cohort) || !isSegmentBy(segmentBy)) return null;
  const report = whole({
    mode,
    cohort,
    headline: headlineOf(data.headline),
    curve: retentionCurve(data.curve),
    cohorts: rows(data.cohorts, COHORTS_MAX, cohortIn(window, cohort), (row) => row.startsOn),
    segmentBy,
    segments: rows(data.segments, SEGMENTS_MAX, segmentOf(segmentBy), (row) => row.key),
    weeks: rows(data.weeks, WEEKS_MAX, weekUpTo(window.endsOn), (row) => row.startsOn),
  });
  return report ?? null;
}
