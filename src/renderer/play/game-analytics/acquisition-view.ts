/**
 * What the Acquisition tab draws, derived from its answer without React: the four tiles with how
 * each moved, the stacked bars of new players per day with the day campaigns took the lead, the
 * funnel with the share that goes on and how many leave between steps, and the two tables with
 * their total rows. A row is named here by its vocabulary (a channel, a place inside Genex, a
 * device, a country) or kept as the text it is (a referrer's host, a campaign's tag). A number that
 * cannot be known stays null all the way to the kit, which writes it as a dash.
 */
import {
  type AcquisitionReport,
  type AnalyticsWindow,
  AnnotationKind,
  Attribution,
  CampaignField,
  type CampaignRow,
  DeviceClass,
  type FunnelCount,
  FunnelStep,
  type GameReport,
  GenexSurface,
  SourceBreakdown,
  SourceChannel,
  type SourceNumbers,
  type SourceRow,
} from "../../../shared/game-analytics.ts";
import { ACQUISITION_WORDS as WORDS, type ReachedStep } from "./acquisition-words.ts";
import {
  type BarSeries,
  CHANNEL_SLOT,
  type ChartMark,
  DeltaKind,
  type FunnelStepItem,
  formatNumber,
  formatPercent,
  type LegendItem,
  type MetricDelta,
  periodLabels,
  ratio,
  type SegmentOption,
  share,
} from "./kit/index.ts";
import type { ReportAnswer } from "./report-props.ts";
import { countryName } from "./report-words.ts";

/** The decimals of the share of people who go on from one funnel step to the next. */
const ONWARD_DIGITS = 1;
/** The id of a table's last row, the report's own totals. */
const TOTAL_ROW = "total";
/** The channels in the order bars are stacked, the first at the foot. */
const CHANNEL_ORDER: readonly SourceChannel[] = Object.values(SourceChannel);

/** The four tiles. */
export const AcquisitionTile = {
  NewPlayers: "newPlayers",
  NewVisitors: "newVisitors",
  VisitToPlay: "visitToPlay",
  ClickThrough: "clickThrough",
} as const;
export type AcquisitionTile = (typeof AcquisitionTile)[keyof typeof AcquisitionTile];

/** One headline number: what it is, how it reads, how it moved and what it counts. */
export interface AcquisitionTileView {
  id: AcquisitionTile;
  label: string;
  /** Null when the number cannot be known: nobody to divide by. */
  value: string | null;
  delta: MetricDelta;
  note: string;
}

/** New players per day, stacked by the channel that first brought them. */
export interface AcquisitionChart {
  /** The channels that brought somebody, the first at the foot of each bar. */
  series: BarSeries[];
  legend: LegendItem[];
  /** Each day of the period as the axis writes it. */
  labels: string[];
  /** The first day of each run of days when campaigns brought more than any other channel. */
  marks: ChartMark[];
}

/** A row of either table, and the rows inside it. */
export interface AcquisitionRow {
  /** Names the row in its table; a row inside another is named after both. */
  id: string;
  name: string;
  /** A quiet second line under the name. */
  detail: string | null;
  /** Times Genex showed the game; null where nothing is shown, and in the campaigns table. */
  shown: number | null;
  newVisitors: number;
  newPlayers: number;
  /** New players over new visitors; null with no visitor, or with more new players than new visitors. */
  visitToPlay: number | null;
  day1: number | null;
  day7: number | null;
  nexPerPlayer: number | null;
  parts: AcquisitionRow[];
}

/**
 * A table's rows and its last row: the report's own totals, when it has some for what the table
 * counts. The rows are the largest ones and need not add up to it, so it is never their sum.
 */
export interface AcquisitionTable {
  rows: AcquisitionRow[];
  total: AcquisitionRow | null;
  /** The ids of the rows that start open. */
  expanded: string[];
}

/** Everything the Acquisition draws. */
export interface AcquisitionView {
  tiles: AcquisitionTileView[];
  /** Null when no channel brought a new player. */
  chart: AcquisitionChart | null;
  /** Null when nobody opened the game page. */
  funnel: FunnelStepItem[] | null;
  /** The breakdown and attribution the table below was made for: the answer's, not the switches'. */
  breakdown: SourceBreakdown;
  attribution: Attribution;
  /** Null when no source brought a new visitor. */
  sources: AcquisitionTable | null;
  campaignBy: CampaignField;
  /** Null when no campaign brought a new visitor under this tag. */
  campaigns: AcquisitionTable | null;
}

const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);
const written = (rate: number | null): string | null => (rate === null ? null : formatPercent(rate));

// ── Tiles ──────────────────────────────────────────────────────────────────────────────────

/** The share of the period's new visitors who got into the game: the funnel's Loaded step over its first. */
function loadedShare(funnel: readonly FunnelCount[]): number | null {
  const people = (step: FunnelStep): number | undefined => funnel.find((one) => one.step === step)?.people;
  return share(people(FunnelStep.Loaded), people(FunnelStep.Visited));
}

/** The four tiles; Genex click-through is absent while Genex does not count the times it showed the game. */
export function acquisitionTiles({
  newPlayers,
  newVisitors,
  shown,
  shownVisitors,
  funnel,
}: AcquisitionReport): AcquisitionTileView[] {
  // New players and new visitors are two groups (first play, first visit), so the share comes from
  // the funnel of new visitors; it has no period before to compare with.
  const toPlay = { now: loadedShare(funnel), before: null };
  const tiles: AcquisitionTileView[] = [
    {
      id: AcquisitionTile.NewPlayers,
      label: WORDS.tiles.newPlayers,
      value: formatNumber(newPlayers.now),
      delta: { kind: DeltaKind.Percent, now: newPlayers.now, before: newPlayers.before },
      note: WORDS.tiles.newPlayersNote,
    },
    {
      id: AcquisitionTile.NewVisitors,
      label: WORDS.tiles.newVisitors,
      value: formatNumber(newVisitors.now),
      delta: { kind: DeltaKind.Percent, now: newVisitors.now, before: newVisitors.before },
      note: WORDS.tiles.newVisitorsNote,
    },
    {
      id: AcquisitionTile.VisitToPlay,
      label: WORDS.tiles.visitToPlay,
      value: written(toPlay.now),
      delta: { kind: DeltaKind.Points, ...toPlay },
      note: WORDS.tiles.visitToPlayNote,
    },
  ];
  if (shown) {
    const clicked = { now: ratio(shownVisitors?.now, shown.now), before: ratio(shownVisitors?.before, shown.before) };
    tiles.push({
      id: AcquisitionTile.ClickThrough,
      label: WORDS.tiles.clickThrough,
      value: written(clicked.now),
      delta: { kind: DeltaKind.Points, ...clicked },
      note: WORDS.tiles.clickThroughNote(shown.now, formatNumber(shown.now)),
    });
  }
  return tiles;
}

// ── New players per day ────────────────────────────────────────────────────────────────────

/**
 * The days on which campaigns started to bring more new players than every other channel, each the
 * first of a run. The answer marks no campaign, so this is the one place its start shows; the
 * first day of the period is no start (the run began before it).
 */
export function campaignLeadStarts(daily: AcquisitionReport["daily"]): number[] {
  const campaigns = daily.find((row) => row.channel === SourceChannel.Campaigns)?.newPlayers ?? [];
  const others = daily.filter((row) => row.channel !== SourceChannel.Campaigns);
  const leads = campaigns.map(
    (people, day) => people > 0 && others.every((row) => (row.newPlayers[day] ?? 0) < people),
  );
  return leads.flatMap((lead, day) => (lead && day > 0 && !leads[day - 1] ? [day] : []));
}

/** The stacked bars of new players per day; null when nobody new came in the period. */
export function acquisitionChart(daily: AcquisitionReport["daily"], window: AnalyticsWindow): AcquisitionChart | null {
  const series: BarSeries[] = daily
    .filter((row) => sum(row.newPlayers) > 0)
    .toSorted((a, b) => CHANNEL_ORDER.indexOf(a.channel) - CHANNEL_ORDER.indexOf(b.channel))
    .map((row) => ({
      id: row.channel,
      label: WORDS.channels[row.channel],
      slot: CHANNEL_SLOT[row.channel],
      values: row.newPlayers,
    }));
  if (series.length === 0) return null;
  return {
    series,
    legend: series.map(({ id, label, slot }) => ({ id, label, slot })),
    labels: periodLabels(window),
    marks: campaignLeadStarts(daily).map((index) => ({
      index,
      kind: AnnotationKind.Campaign,
      label: WORDS.daily.campaignsLead,
    })),
  };
}

// ── The funnel ─────────────────────────────────────────────────────────────────────────────

/** Whether `step` is one people reach from the step before it: every step but the first. */
const isReached = (step: FunnelStep): step is ReachedStep => step !== FunnelStep.Visited;

/** The line under a step that says what share of its people reach the next one; null when none can be told. */
function onwardLine(people: number, next: FunnelCount | undefined): string | null {
  if (!next || !isReached(next.step) || people === 0 || next.people > people) return null;
  return WORDS.funnel.onward[next.step](formatPercent(next.people / people, ONWARD_DIGITS));
}

/** The line under a step that says how many do not reach the next one; null when all of them do. */
function lostLine(people: number, next: FunnelCount | undefined): string | null {
  if (!next || !isReached(next.step) || next.people >= people) return null;
  const lost = people - next.people;
  return WORDS.funnel.lost[next.step](lost, formatNumber(lost));
}

/** The line under the last step: its people as a share of everyone who opened the page. */
function lastLine(funnel: readonly FunnelCount[]): string | null {
  const [first] = funnel;
  const last = funnel[funnel.length - 1];
  if (!first || !last || first === last || first.step !== FunnelStep.Visited || first.people === 0) return null;
  return WORDS.funnel.ofNewVisitors(formatPercent(last.people / first.people, ONWARD_DIGITS));
}

/**
 * The funnel's steps as they came, each with the share that goes on to the next and how many leave
 * before it; null when nobody opened the page. A step the answer does not hold (a place with no
 * Play button has no pressed-play step) is not drawn, and the line under the one before it names
 * the step that follows.
 */
export function acquisitionFunnel(funnel: readonly FunnelCount[]): FunnelStepItem[] | null {
  const [first] = funnel;
  if (!first || first.people === 0) return null;
  return funnel.map((step, index) => {
    const next = funnel[index + 1];
    const last = next === undefined;
    return {
      id: step.step,
      label: WORDS.funnel.steps[step.step],
      count: step.people,
      onward: last ? lastLine(funnel) : onwardLine(step.people, next),
      lost: last ? null : lostLine(step.people, next),
    };
  });
}

// ── Tables ─────────────────────────────────────────────────────────────────────────────────

/** What a row of numbers is, once its names are decided. */
function rowOf(
  id: string,
  name: string,
  detail: string | null,
  shown: number | null,
  numbers: SourceNumbers,
): AcquisitionRow {
  return {
    id,
    name,
    detail,
    shown,
    newVisitors: numbers.newVisitors,
    newPlayers: numbers.newPlayers,
    visitToPlay: share(numbers.newPlayers, numbers.newVisitors),
    day1: numbers.day1,
    day7: numbers.day7,
    nexPerPlayer: numbers.nexPerPlayer,
    parts: [],
  };
}

/**
 * The sources table's last row: the report's own counts of new visitors and players, its share as
 * the tile writes it, and no Day 1, Day 7 or Nex per player, which the answer has for its rows alone.
 */
function sourcesTotal(data: AcquisitionReport): AcquisitionRow {
  const counts = { newVisitors: data.newVisitors.now, newPlayers: data.newPlayers.now };
  const total = rowOf(TOTAL_ROW, WORDS.sources.total, null, data.shown?.now ?? null, {
    ...counts,
    day1: null,
    day7: null,
    nexPerPlayer: null,
  });
  return { ...total, visitToPlay: loadedShare(data.funnel) };
}

export { countryName };

/** The member of a vocabulary that `key` is, or undefined. */
const member = <Vocabulary extends string>(vocabulary: Readonly<Record<string, Vocabulary>>, key: string) =>
  Object.values(vocabulary).find((value) => value === key);

/** What a row inside another is called: a place inside Genex by its name, a site as the text it is. */
function partName(breakdown: SourceBreakdown, parent: SourceRow, key: string): string {
  const inGenex = breakdown === SourceBreakdown.Channel && parent.key === SourceChannel.Genex;
  const surface = inGenex ? member(GenexSurface, key) : undefined;
  return surface ? WORDS.surfaces[surface] : key;
}

/** What a top row of the sources table is called under `breakdown`. */
export function sourceName(breakdown: SourceBreakdown, key: string): string {
  if (breakdown === SourceBreakdown.Country) return countryName(key);
  if (breakdown === SourceBreakdown.Referrer) return key === SourceChannel.Direct ? WORDS.noReferrer : key;
  if (breakdown === SourceBreakdown.Device) {
    const device = member(DeviceClass, key);
    return device ? WORDS.devices[device] : key;
  }
  const channel = member(SourceChannel, key);
  return channel ? WORDS.channels[channel] : key;
}

/** A row of the sources table with the rows inside it. */
function sourceRowOf(breakdown: SourceBreakdown, row: SourceRow): AcquisitionRow {
  const id = `${breakdown}:${row.key}`;
  const parts = row.parts.map((part) =>
    rowOf(`${id}/${part.key}`, partName(breakdown, row, part.key), null, part.shown, part),
  );
  return { ...rowOf(id, sourceName(breakdown, row.key), null, row.shown, row), parts };
}

/** The sources table: a row for each source with what is inside it, and every new player in the last. */
export function acquisitionSources(data: AcquisitionReport): AcquisitionTable | null {
  if (data.sources.length === 0) return null;
  const { breakdown } = data;
  return {
    rows: data.sources.map((row) => sourceRowOf(breakdown, row)),
    total: sourcesTotal(data),
    expanded: breakdown === SourceBreakdown.Channel ? [`${breakdown}:${SourceChannel.Genex}`] : [],
  };
}

/** The source and medium a campaign came with, as one line: whichever it has when it has only one. */
function campaignVia({ source, medium }: CampaignRow): string | null {
  return source !== null && medium !== null ? WORDS.campaigns.via(source, medium) : (source ?? medium);
}

/**
 * The campaigns table: a row for each value of the tag. It has no last row: the answer lists the
 * largest campaigns and has no total of them all.
 */
export function acquisitionCampaigns(data: AcquisitionReport): AcquisitionTable | null {
  const { campaigns } = data;
  if (campaigns.length === 0) return null;
  return {
    rows: campaigns.map((row) => rowOf(row.name, row.name, campaignVia(row), null, row)),
    total: null,
    expanded: [],
  };
}

/** Everything the Acquisition draws for `answer`. */
export function acquisitionView(answer: ReportAnswer<typeof GameReport.Acquisition>): AcquisitionView {
  const { data, window } = answer;
  return {
    tiles: acquisitionTiles(data),
    chart: acquisitionChart(data.daily, window),
    funnel: acquisitionFunnel(data.funnel),
    breakdown: data.breakdown,
    attribution: data.attribution,
    sources: acquisitionSources(data),
    campaignBy: data.campaignBy,
    campaigns: acquisitionCampaigns(data),
  };
}

// ── The switches ───────────────────────────────────────────────────────────────────────────

/** What the sources table can be split by, and whose source is credited. */
export const BREAKDOWN_OPTIONS: readonly SegmentOption<SourceBreakdown>[] = Object.values(SourceBreakdown).map(
  (value) => ({ value, label: WORDS.sources.breakdowns[value] }),
);
export const ATTRIBUTION_OPTIONS: readonly SegmentOption<Attribution>[] = Object.values(Attribution).map((value) => ({
  value,
  label: WORDS.sources.attributions[value],
}));

/** The tag of each campaigns switch option is the utm_ tag's own name, which no language translates. */
export const CAMPAIGN_OPTIONS: readonly SegmentOption<CampaignField>[] = Object.values(CampaignField).map((value) => ({
  value,
  label: `utm_${value}`,
}));
