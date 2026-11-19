/**
 * The Overview report as genex.games answers it: the headline numbers per day, the marks on their
 * chart, what is worth a look, and a first look at where players come from, whether they come back
 * and how far new visitors get.
 *
 * This is the parser the other six are written after. Its shape: one small reader per part, each
 * answering `undefined` for what it cannot read; the fixed parts collected in `whole`, so one bad
 * number refuses the report; the lists read with `rows`, which leaves a bad row out and keeps the
 * rest; every word through `line`; every `null` the contract allows kept as null.
 */
import {
  type AnalyticsWindow,
  type Annotation,
  AnnotationKind,
  type ChannelCount,
  DeviceClass,
  type FunnelCount,
  FunnelStep,
  type Insight,
  InsightKind,
  OverviewMetric,
  type OverviewReport,
  type OverviewSeries,
  RETENTION_SPAN,
  type RetentionCurve,
  SourceChannel,
} from "../../../shared/game-analytics.ts";
import { dayBefore } from "../../../shared/play-stats.ts";
import { isRecord } from "../gallery.ts";
import {
  amount,
  count,
  isoDay,
  line,
  oneOf,
  orNull,
  type Read,
  rate,
  rateOrNull,
  rows,
  series,
  shortSeries,
  whole,
} from "./kit.ts";

/** The most marks a chart keeps and the most insights a page shows. */
const ANNOTATIONS_MAX = 60;
const INSIGHTS_MAX = 12;
/** The longest a campaign's name, a version or a level's name may read. */
const LABEL_MAX = 200;
const CHANNELS_MAX = Object.keys(SourceChannel).length;
const FUNNEL_STEPS_MAX = Object.keys(FunnelStep).length;

const isAnnotationKind = oneOf(AnnotationKind);
const isChannel = oneOf(SourceChannel);
const isDevice = oneOf(DeviceClass);
const isFunnelStep = oneOf(FunnelStep);

/** What each Overview number counts in: people and Nex are whole, a play's length is seconds, retention a rate. */
const METRIC_VALUE = {
  [OverviewMetric.Players]: count,
  [OverviewMetric.NewPlayers]: count,
  [OverviewMetric.Plays]: count,
  [OverviewMetric.MedianPlaySeconds]: amount,
  [OverviewMetric.Day1]: rate,
  [OverviewMetric.Day7]: rate,
  [OverviewMetric.Installs]: count,
  [OverviewMetric.NexSpent]: count,
} as const satisfies Record<OverviewMetric, Read<number>>;

/**
 * One Overview number over the period and the one before, a value for each day of both. Any of them
 * may be null (the day has not passed, nobody to divide by). The whole series is null where the
 * game has no such number (installs with no app build).
 */
function overviewSeries(value: unknown, days: number, read: Read<number>): OverviewSeries | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  const known = orNull(read);
  return whole({
    now: known(value.now),
    before: known(value.before),
    daily: series(value.daily, days, known),
    dailyBefore: series(value.dailyBefore, days, known),
  });
}

/** Every Overview number's series, or undefined when one of them is missing or broken. */
function allSeries(value: unknown, days: number): OverviewReport["series"] | undefined {
  if (!isRecord(value)) return undefined;
  const one = (metric: OverviewMetric) => overviewSeries(value[metric], days, METRIC_VALUE[metric]);
  return whole({
    [OverviewMetric.Players]: one(OverviewMetric.Players),
    [OverviewMetric.NewPlayers]: one(OverviewMetric.NewPlayers),
    [OverviewMetric.Plays]: one(OverviewMetric.Plays),
    [OverviewMetric.MedianPlaySeconds]: one(OverviewMetric.MedianPlaySeconds),
    [OverviewMetric.Day1]: one(OverviewMetric.Day1),
    [OverviewMetric.Day7]: one(OverviewMetric.Day7),
    [OverviewMetric.Installs]: one(OverviewMetric.Installs),
    [OverviewMetric.NexSpent]: one(OverviewMetric.NexSpent),
  });
}

/** A mark on the per-day chart, on a day of the period; one of a kind the app does not draw is left out. */
function annotationIn(window: AnalyticsWindow): Read<Annotation> {
  const firstDay = dayBefore(window.endsOn, window.days - 1);
  return (value) => {
    if (!isRecord(value) || !isAnnotationKind(value.kind)) return undefined;
    const on = isoDay(value.on);
    const label = line(value.label, LABEL_MAX);
    const inPeriod = on !== undefined && on >= firstDay && on <= window.endsOn;
    return inPeriod && label ? { on, kind: value.kind, label } : undefined;
  };
}

/** The numbers each kind of insight carries. */
const INSIGHT = {
  [InsightKind.LevelDropOff]: (value) => {
    const level = line(value.level, LABEL_MAX);
    const read = whole({
      reachedBefore: rate(value.reachedBefore),
      reached: rate(value.reached),
      tries: orNull(amount)(value.tries),
    });
    return level && read ? { kind: InsightKind.LevelDropOff, level, ...read } : undefined;
  },
  [InsightKind.CampaignRetention]: (value) => {
    const campaign = line(value.campaign, LABEL_MAX);
    const read = whole({ newPlayers: count(value.newPlayers), day7: rate(value.day7), day7All: rate(value.day7All) });
    return campaign && read ? { kind: InsightKind.CampaignRetention, campaign, ...read } : undefined;
  },
  [InsightKind.DeviceLoad]: (value) => {
    const read = whole({
      loadSeconds: amount(value.loadSeconds),
      loadSecondsOthers: amount(value.loadSecondsOthers),
      leftLoading: rate(value.leftLoading),
    });
    return isDevice(value.device) && read ? { kind: InsightKind.DeviceLoad, device: value.device, ...read } : undefined;
  },
  [InsightKind.InstalledRetention]: (value) => {
    const read = whole({ day7Installed: rate(value.day7Installed), day7Browser: rate(value.day7Browser) });
    return read ? { kind: InsightKind.InstalledRetention, ...read } : undefined;
  },
} as const satisfies Record<InsightKind, (value: Record<string, unknown>) => Insight | undefined>;

const isInsightKind = oneOf(InsightKind);

/** Something worth a look; one of a kind the app has no sentence for is left out. */
const insight: Read<Insight> = (value) =>
  isRecord(value) && isInsightKind(value.kind) ? INSIGHT[value.kind](value) : undefined;

/** New players a channel brought; a channel the app does not know is left out. */
const channelCount: Read<ChannelCount> = (value) => {
  if (!isRecord(value) || !isChannel(value.channel)) return undefined;
  const people = count(value.people);
  return people === undefined ? undefined : { channel: value.channel, people };
};

/** How many new visitors reached a step; a step the app does not know is left out. */
const funnelCount: Read<FunnelCount> = (value) => {
  if (!isRecord(value) || !isFunnelStep(value.step)) return undefined;
  const people = count(value.people);
  return people === undefined ? undefined : { step: value.step, people };
};

/**
 * New players who play again by days since their first play: up to `RETENTION_SPAN` days, the
 * period before and similar games' median held to the same length.
 */
function retentionCurve(value: unknown): RetentionCurve | undefined {
  if (!isRecord(value)) return undefined;
  const rates = shortSeries(value.rates, RETENTION_SPAN, rateOrNull);
  if (!rates) return undefined;
  const before = series(value.before, rates.length, rateOrNull);
  const similar = value.similar === null ? null : series(value.similar, rates.length, rateOrNull);
  return before && similar !== undefined ? { rates, before, similar } : undefined;
}

/** The Overview report for `window`, or null when `data` is not one. */
export function toOverviewReport(data: unknown, window: AnalyticsWindow): OverviewReport | null {
  if (!isRecord(data)) return null;
  const report = whole({
    series: allSeries(data.series, window.days),
    annotations: rows(data.annotations, ANNOTATIONS_MAX, annotationIn(window)),
    insights: rows(data.insights, INSIGHTS_MAX, insight),
    channels: rows(data.channels, CHANNELS_MAX, channelCount, (row) => row.channel),
    retention: retentionCurve(data.retention),
    funnel: rows(data.funnel, FUNNEL_STEPS_MAX, funnelCount, (row) => row.step),
  });
  return report ?? null;
}
