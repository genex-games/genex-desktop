/**
 * What the Overview draws, derived from its answer without React: the tiles with how each number
 * moved, the per-day chart of the number picked, the sentences an insight is told in, the channels
 * that brought someone, the retention curve with its three headline days, and the funnel. The
 * component only lays these out. A number that cannot be known stays null all the way to the kit,
 * which writes it as a dash.
 */
import {
  type AnalyticsGame,
  type ChannelCount,
  type FunnelCount,
  FunnelStep,
  type GameReport,
  type Insight,
  InsightKind,
  OverviewMetric,
  type OverviewSeries,
  type RetentionCurve,
} from "../../../shared/game-analytics.ts";
import { dayBefore, periodDays } from "../../../shared/play-stats.ts";
import {
  type BarListItem,
  type ChartMark,
  DeltaKind,
  DURATION_DIGITS,
  formatAxisPercent,
  formatDayRange,
  formatDuration,
  formatNexAmount,
  formatNumber,
  formatPercent,
  formatSeconds,
  formatSignedDuration,
  type LegendItem,
  type LineSeries,
  LineTone,
  type MetricDelta,
  type MiniStat,
  marksOf,
  periodLabels,
  ratio,
} from "./kit/index.ts";
import { OVERVIEW_WORDS as WORDS } from "./overview-words.ts";
import { PAGE_WORDS } from "./page-words.ts";
import type { ReportAnswer } from "./report-props.ts";
import { levelName } from "./report-words.ts";
import { AnalyticsTab } from "./tabs.ts";

/** The tiles in the order they are shown. */
const TILE_ORDER: readonly OverviewMetric[] = [
  OverviewMetric.Players,
  OverviewMetric.NewPlayers,
  OverviewMetric.Plays,
  OverviewMetric.MedianPlaySeconds,
  OverviewMetric.Day1,
  OverviewMetric.Day7,
  OverviewMetric.Installs,
  OverviewMetric.NexSpent,
];
/** The days after the first play the retention block names, and the ones its curve labels. */
const HEADLINE_DAYS = [1, 7, 30] as const;
const CURVE_TICK_DAYS = [1, 7, 14, 21, 30] as const;
/** The decimals of a share in an insight: a level's reach and who leaves loading are round, retention is not. */
const ROUND_SHARE_DIGITS = 0;
const RETENTION_DIGITS = 1;
/** The decimals of "2.1× slower" and of a median number of tries that is not whole. */
const TIMES_DIGITS = 1;

/** What an Overview number is counted in: how it is written and how its change is told. */
const Unit = { Count: "count", Nex: "nex", Seconds: "seconds", Rate: "rate" } as const;
type Unit = (typeof Unit)[keyof typeof Unit];

const METRIC_UNIT = {
  [OverviewMetric.Players]: Unit.Count,
  [OverviewMetric.NewPlayers]: Unit.Count,
  [OverviewMetric.Plays]: Unit.Count,
  [OverviewMetric.MedianPlaySeconds]: Unit.Seconds,
  [OverviewMetric.Day1]: Unit.Rate,
  [OverviewMetric.Day7]: Unit.Rate,
  [OverviewMetric.Installs]: Unit.Count,
  [OverviewMetric.NexSpent]: Unit.Nex,
} as const satisfies Record<OverviewMetric, Unit>;

/** A value of each unit as a tile and the chart's readout write it. */
const WRITE = {
  [Unit.Count]: (value) => formatNumber(value),
  [Unit.Nex]: (value) => formatNexAmount(value),
  [Unit.Seconds]: (value) => formatDuration(value),
  [Unit.Rate]: (value) => formatPercent(value),
} as const satisfies Record<Unit, (value: number) => string>;

/** A step of the chart's axis in each unit: as the readout writes it, but a rate in whole percents. */
const AXIS = { ...WRITE, [Unit.Rate]: formatAxisPercent } as const satisfies Record<Unit, (value: number) => string>;

/** One headline number: what it is, how it reads, how it moved and a value per day. */
export interface OverviewTile {
  metric: OverviewMetric;
  label: string;
  /** Null when the number cannot be known yet. */
  value: string | null;
  delta: MetricDelta;
  spark: readonly (number | null)[];
  /** Whether it is the number the chart shows. */
  pressed: boolean;
}

/** The per-day chart of the number picked. */
export interface OverviewChart {
  metric: OverviewMetric;
  title: string;
  /** This period's line, then the dashed one of the period before. */
  series: LineSeries[];
  legend: LegendItem[];
  /** Each day of the period as the axis writes it. */
  labels: string[];
  marks: ChartMark[];
  /** A value as the readout and the chart's table write it, and a step of its axis. */
  format: (value: number) => string;
  axisFormat: (value: number) => string;
  /** No day of either period has a value: there is nothing to draw yet. */
  empty: boolean;
}

/** Something worth a look, in two sentences, with the tab it opens. */
export interface OverviewInsight {
  /** Names the row among the others: its kind and its place in the answer. */
  id: string;
  kind: InsightKind;
  tab: AnalyticsTab;
  /** What it is filed under: its tab's name, or Performance. */
  area: string;
  headline: string;
  detail: string;
  /** The sentences carry words the creator wrote (a campaign, a level): kept out of usage recordings. */
  masked: boolean;
}

/** The retention block: three headline days over the curve. */
export interface OverviewRetention {
  stats: MiniStat[];
  /** The game's curve, then similar games' when there are enough to compare with. */
  series: LineSeries[];
  legend: LegendItem[];
  /** "Day 1" … for each place of the curve. */
  labels: string[];
  /** The places named under the plot. */
  ticks: number[];
  /** A rate as the readout and the curve's table write it, and a step of its axis. */
  format: (rate: number) => string;
  axisFormat: (rate: number) => string;
  /** The game has no rate yet: there is no curve to draw. */
  empty: boolean;
}

/** The funnel as a list: its steps, and what each step's share is of. */
export interface OverviewFunnel {
  items: BarListItem[];
  /** Everyone who opened the page; zero when that step did not come, so no share is claimed. */
  total: number;
}

/** Everything the Overview draws. */
export interface OverviewView {
  tiles: OverviewTile[];
  /** Null when no number has a series. */
  chart: OverviewChart | null;
  insights: OverviewInsight[];
  channels: BarListItem[];
  retention: OverviewRetention;
  /** Null when nobody came. */
  funnel: OverviewFunnel | null;
  /** The answer holds nothing to draw at all. */
  empty: boolean;
}

/** How a number of `unit` moved: counts and Nex in percent, a rate in points, a length as a signed length. */
function deltaOf(unit: Unit, { now, before }: OverviewSeries): MetricDelta {
  if (unit === Unit.Rate) return { kind: DeltaKind.Points, now, before };
  if (unit === Unit.Seconds)
    return { kind: DeltaKind.Amount, now, before, format: formatSignedDuration, digits: DURATION_DIGITS };
  return { kind: DeltaKind.Percent, now, before };
}

/** The numbers the answer has a series for, in the tiles' order: Installs is absent with no app build. */
function shownMetrics(series: ReportAnswer<typeof GameReport.Overview>["data"]["series"]): OverviewMetric[] {
  return TILE_ORDER.filter((metric) => series[metric] !== null);
}

/** A number's tile. */
function tileOf(metric: OverviewMetric, series: OverviewSeries, pressed: boolean): OverviewTile {
  const unit = METRIC_UNIT[metric];
  return {
    metric,
    label: WORDS.metrics[metric],
    value: series.now === null ? null : WRITE[unit](series.now),
    delta: deltaOf(unit, series),
    spark: series.daily,
    pressed,
  };
}

/** The chart of `metric` over the answer's period, against the period before, with the answer's marks. */
function chartOf(
  metric: OverviewMetric,
  series: OverviewSeries,
  { window, data }: ReportAnswer<typeof GameReport.Overview>,
): OverviewChart {
  const firstDay = dayBefore(window.endsOn, window.days - 1);
  const lines: LineSeries[] = [
    { id: "now", label: formatDayRange(firstDay, window.endsOn), tone: LineTone.Main, values: series.daily },
    { id: "before", label: WORDS.daysBefore(window.days), tone: LineTone.Before, values: series.dailyBefore },
  ];
  return {
    metric,
    title: WORDS.charts[metric],
    series: lines,
    legend: lines.map(({ id, label, tone }) => ({ id, label, tone })),
    labels: periodLabels(window),
    marks: marksOf(data.annotations, periodDays(window)),
    format: WRITE[METRIC_UNIT[metric]],
    axisFormat: AXIS[METRIC_UNIT[metric]],
    empty: [...series.daily, ...series.dailyBefore].every((value) => value === null),
  };
}

/** The two sentences an insight is told in. */
interface Sentences {
  headline: string;
  detail: string;
}
type InsightOf<Kind extends InsightKind> = Extract<Insight, { kind: Kind }>;

/** A level that loses players: null when as many reach it as the one before. */
function levelSentences(insight: InsightOf<typeof InsightKind.LevelDropOff>): Sentences | null {
  if (insight.reached >= insight.reachedBefore) return null;
  const before = formatPercent(insight.reachedBefore, ROUND_SHARE_DIGITS);
  const reached = formatPercent(insight.reached, ROUND_SHARE_DIGITS);
  const { tries } = insight;
  const detail =
    tries === null
      ? WORDS.level.detail(before, reached)
      : WORDS.level.detailWithTries(
          before,
          reached,
          tries,
          formatNumber(tries, Number.isInteger(tries) ? 0 : TIMES_DIGITS),
        );
  return { headline: WORDS.level.headline(levelName(insight.level)), detail };
}

/** A campaign whose players stay less, or more, than everyone: null when they stay the same. */
function campaignSentences(insight: InsightOf<typeof InsightKind.CampaignRetention>): Sentences | null {
  if (insight.day7 === insight.day7All) return null;
  const headline = insight.day7 < insight.day7All ? WORDS.campaign.fewerStay : WORDS.campaign.moreStay;
  return {
    headline: headline(insight.campaign, insight.newPlayers, formatNumber(insight.newPlayers)),
    detail: WORDS.campaign.detail(
      formatPercent(insight.day7, RETENTION_DIGITS),
      formatPercent(insight.day7All, RETENTION_DIGITS),
    ),
  };
}

/** A device that loads the game slower than the rest: null when it does not, or there is no rest to compare with. */
function deviceSentences(insight: InsightOf<typeof InsightKind.DeviceLoad>): Sentences | null {
  const times = ratio(insight.loadSeconds, insight.loadSecondsOthers);
  if (times === null || times <= 1) return null;
  const words = WORDS.device[insight.device];
  return {
    headline: words.headline(formatNumber(times, TIMES_DIGITS)),
    detail: words.detail(
      formatSeconds(insight.loadSeconds),
      formatSeconds(insight.loadSecondsOthers),
      formatPercent(insight.leftLoading, ROUND_SHARE_DIGITS),
    ),
  };
}

/** Installed players who stay longer: null when they do not, or the game has no app build (and so no Installs tab). */
function installedSentences(
  insight: InsightOf<typeof InsightKind.InstalledRetention>,
  game: Pick<AnalyticsGame, "hasAppBuild">,
): Sentences | null {
  if (!game.hasAppBuild || insight.day7Installed <= insight.day7Browser) return null;
  return {
    headline: WORDS.installed.headline,
    detail: WORDS.installed.detail(
      formatPercent(insight.day7Installed, RETENTION_DIGITS),
      formatPercent(insight.day7Browser, RETENTION_DIGITS),
    ),
  };
}

/** An insight's sentences, written from its typed fields; null when its numbers do not say what its kind says. */
function sentencesOf(insight: Insight, game: Pick<AnalyticsGame, "hasAppBuild">): Sentences | null {
  switch (insight.kind) {
    case InsightKind.LevelDropOff:
      return levelSentences(insight);
    case InsightKind.CampaignRetention:
      return campaignSentences(insight);
    case InsightKind.DeviceLoad:
      return deviceSentences(insight);
    case InsightKind.InstalledRetention:
      return installedSentences(insight, game);
  }
}

/** The tab each kind of insight opens. */
const INSIGHT_TAB = {
  [InsightKind.LevelDropOff]: AnalyticsTab.Engagement,
  [InsightKind.CampaignRetention]: AnalyticsTab.Acquisition,
  [InsightKind.DeviceLoad]: AnalyticsTab.Engagement,
  [InsightKind.InstalledRetention]: AnalyticsTab.Installs,
} as const satisfies Record<InsightKind, AnalyticsTab>;

/** The kinds whose sentences carry the creator's own words: a level's name, a campaign's. */
const CREATORS_WORDS: ReadonlySet<InsightKind> = new Set([InsightKind.LevelDropOff, InsightKind.CampaignRetention]);

/** What an insight is filed under: how the game runs is Performance, the others their tab's name. */
const areaOf = (kind: InsightKind): string =>
  kind === InsightKind.DeviceLoad ? WORDS.performance : PAGE_WORDS.tabs[INSIGHT_TAB[kind]];

/**
 * The answer's insights as rows, in the order sent. One whose numbers do not say what its kind
 * says (a level as many reach, a device that loads no slower) is left out rather than told wrong.
 */
export function overviewInsights(
  insights: readonly Insight[],
  game: Pick<AnalyticsGame, "hasAppBuild">,
): OverviewInsight[] {
  return insights.flatMap((insight, index) => {
    const sentences = sentencesOf(insight, game);
    if (!sentences) return [];
    const { kind } = insight;
    return [
      {
        id: `${kind}-${index}`,
        kind,
        tab: INSIGHT_TAB[kind],
        area: areaOf(kind),
        ...sentences,
        masked: CREATORS_WORDS.has(kind),
      },
    ];
  });
}

/** The channels that brought new players, in the order sent (most first); one that brought nobody is left out. */
export function overviewChannels(channels: readonly ChannelCount[]): BarListItem[] {
  return channels
    .filter((row) => row.people > 0)
    .map((row) => ({ id: row.channel, label: WORDS.channels[row.channel], value: row.people }));
}

/** The retention block for a curve: Day 1, Day 7 and Day 30 off it, and the curve against similar games. */
export function overviewRetention(curve: RetentionCurve): OverviewRetention {
  const series: LineSeries[] = [{ id: "game", label: WORDS.thisGame, tone: LineTone.Main, values: curve.rates }];
  if (curve.similar) {
    series.push({ id: "similar", label: WORDS.similarGames, tone: LineTone.Similar, values: curve.similar });
  }
  return {
    stats: HEADLINE_DAYS.map((day) => {
      const rate = curve.rates[day - 1] ?? null;
      return { id: `day${day}`, label: WORDS.day(day), value: rate === null ? null : formatPercent(rate) };
    }),
    series,
    legend: series.map(({ id, label, tone }) => ({ id, label, tone })),
    labels: curve.rates.map((_, index) => WORDS.day(index + 1)),
    ticks: CURVE_TICK_DAYS.map((day) => day - 1).filter((index) => index < curve.rates.length),
    format: WRITE[Unit.Rate],
    axisFormat: AXIS[Unit.Rate],
    empty: curve.rates.every((rate) => rate === null),
  };
}

/** The funnel's steps as they came, or null when nobody came. */
export function overviewFunnel(funnel: readonly FunnelCount[]): OverviewFunnel | null {
  const [first] = funnel;
  if (!first || first.people === 0) return null;
  return {
    items: funnel.map((row) => ({ id: row.step, label: WORDS.steps[row.step], value: row.people })),
    total: first.step === FunnelStep.Visited ? first.people : 0,
  };
}

/**
 * What the Overview draws for `answer` with `chosen` as the number its chart shows; when the answer
 * has no series for that number (Installs with no app build), the chart shows the first tile's.
 */
export function overviewView(answer: ReportAnswer<typeof GameReport.Overview>, chosen: OverviewMetric): OverviewView {
  const { series } = answer.data;
  const metrics = shownMetrics(series);
  const shown = metrics.includes(chosen) ? chosen : metrics[0];
  const tiles = metrics.flatMap((metric) => {
    const one = series[metric];
    return one ? [tileOf(metric, one, metric === shown)] : [];
  });
  const picked = shown === undefined ? null : series[shown];
  const chart = shown !== undefined && picked ? chartOf(shown, picked, answer) : null;
  const insights = overviewInsights(answer.data.insights, answer.game);
  const channels = overviewChannels(answer.data.channels);
  const retention = overviewRetention(answer.data.retention);
  const funnel = overviewFunnel(answer.data.funnel);
  const blocks = tiles.length + insights.length + channels.length;
  return { tiles, chart, insights, channels, retention, funnel, empty: blocks === 0 && retention.empty && !funnel };
}
