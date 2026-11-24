/**
 * What the Revenue report shows, worked out from an answer without React: the four tiles with their
 * changes and notes, the bars per day, the items table with each item's share of all Nex, the curve
 * of what a new player spends with its small numbers, and the sources table with the share of each
 * channel's players who pay. Every rate here is two of the answer's counts divided, and one with
 * nothing to divide by is null, which the page draws as a dash. Nothing here reads a clock or a
 * time zone: the answer's days are UTC and its numbers are already computed.
 */
import type { GameReport, RevenueReport } from "../../../shared/game-analytics.ts";
import {
  type BarSeries,
  DeltaKind,
  formatNex,
  formatNexAmount,
  formatNumber,
  formatPercent,
  formatSigned,
  type LineSeries,
  LineTone,
  type MetricTileProps,
  type MiniStat,
  periodLabels,
  ratio,
  SeriesSlot,
} from "./kit/index.ts";
import type { ReportAnswer } from "./report-props.ts";
import { REVENUE_WORDS } from "./revenue-words.ts";

/** The tiles, as `data-game-analytics-tile` names them. */
export const RevenueTile = {
  NexSpent: "nexSpent",
  Payers: "payers",
  NexPerPayer: "nexPerPayer",
  NexPerPlayerDay: "nexPerPlayerDay",
} as const;
export type RevenueTile = (typeof RevenueTile)[keyof typeof RevenueTile];

/** The small numbers over the spending curve, as `data-game-analytics-stat` names them. */
export const SpendStat = { Day1: "day1", Day7: "day7", Day30: "day30", FirstPurchase: "firstPurchase" } as const;
export type SpendStat = (typeof SpendStat)[keyof typeof SpendStat];

/** The id of a table's total row. */
export const TOTAL_ROW = "total";
/** The days since the first play whose spending is written over the curve. */
const SPEND_DAYS = [
  [SpendStat.Day1, 1],
  [SpendStat.Day7, 7],
  [SpendStat.Day30, 30],
] as const;
/** The days named under the curve. */
const SPEND_TICKS = [0, 10, 20, 30] as const;
/** The decimals of an average number of purchases, and of a change in Nex per player a day. */
const PURCHASES_EACH_DIGITS = 1;
const PER_PLAYER_DAY_DIGITS = 2;

/** A row of the items table: an item, or all of them. */
export interface ItemRow {
  id: string;
  name: string;
  /** Null for an item with no one price, and for the total. */
  price: number | null;
  sold: number;
  buyers: number;
  nex: number;
  /** Its share of all the Nex spent; null with no Nex to share, and for the total. */
  share: number | null;
}

/** A row of the sources table: a channel, or everyone who played. */
export interface SourceRow {
  id: string;
  name: string;
  players: number;
  payers: number;
  /** The share of its players who paid, and the Nex spent for each of its players; null with no players. */
  paying: number | null;
  nex: number;
  nexEach: number | null;
}

/** Everything the Revenue report draws. */
export interface RevenueView {
  tiles: MetricTileProps[];
  /** Nothing was bought in the period: the tiles stand, and `nothing` is said in place of the rest. */
  nothingBought: boolean;
  nothing: string;
  daily: { labels: string[]; series: BarSeries[] };
  items: { rows: ItemRow[]; total: ItemRow };
  spend: {
    /** Whether any day of the curve is known; `empty` is said when none is. */
    known: boolean;
    empty: string;
    stats: MiniStat[];
    labels: string[];
    series: LineSeries[];
    ticks: number[] | undefined;
  };
  sources: { rows: SourceRow[]; total: SourceRow };
}

/** A day since the first play, as the curve and the first purchase name it. */
const dayName = (day: number): string => (day === 0 ? REVENUE_WORDS.spend.firstDay : REVENUE_WORDS.spend.day(day));

/** The four headline numbers: what was spent, by how many, and what that is for each of them. */
function tilesOf(data: RevenueReport): MetricTileProps[] {
  const { nex, purchases, payers, players, nexPerPlayerDay } = data;
  const words = REVENUE_WORDS.tiles;
  const payingShare = ratio(payers.now, players.now);
  const purchasesEach = ratio(purchases.now, payers.now);
  const perPayer = { now: ratio(nex.now, payers.now), before: ratio(nex.before, payers.before) };
  return [
    {
      id: RevenueTile.NexSpent,
      label: words.nexSpent,
      value: formatNexAmount(nex.now),
      delta: { kind: DeltaKind.Percent, ...nex },
      note: words.inPurchases(purchases.now),
    },
    {
      id: RevenueTile.Payers,
      label: words.payers,
      value: formatNumber(payers.now),
      delta: { kind: DeltaKind.Percent, ...payers },
      note: payingShare === null ? undefined : words.ofEveryone(formatPercent(payingShare)),
    },
    {
      id: RevenueTile.NexPerPayer,
      label: words.nexPerPayer,
      value: perPayer.now === null ? null : formatNexAmount(perPayer.now),
      delta: { kind: DeltaKind.Percent, ...perPayer },
      note:
        purchasesEach === null ? undefined : words.purchasesEach(formatNumber(purchasesEach, PURCHASES_EACH_DIGITS)),
    },
    {
      id: RevenueTile.NexPerPlayerDay,
      label: words.nexPerPlayerDay,
      value: nexPerPlayerDay.now === null ? null : formatNexAmount(nexPerPlayerDay.now),
      delta: {
        kind: DeltaKind.Amount,
        ...nexPerPlayerDay,
        format: (change) => formatSigned(change, PER_PLAYER_DAY_DIGITS),
        digits: PER_PLAYER_DAY_DIGITS,
      },
      note: words.everyoneThatDay,
    },
  ];
}

/** The items, most Nex first, each with its share of all the Nex, and the row that sums them. */
function itemsOf(data: RevenueReport): RevenueView["items"] {
  const rows = data.items
    .map((item) => ({ ...item, share: ratio(item.nex, data.nex.now) }))
    .toSorted((a, b) => b.nex - a.nex);
  const total: ItemRow = {
    id: TOTAL_ROW,
    name: REVENUE_WORDS.items.total,
    price: null,
    sold: data.purchases.now,
    buyers: data.payers.now,
    nex: data.nex.now,
    share: null,
  };
  return { rows, total };
}

/** The curve of what a new player has spent, the days written over it and the day of the first purchase. */
function spendOf(data: RevenueReport, days: number): RevenueView["spend"] {
  const { spend, firstPurchaseDay } = data;
  const words = REVENUE_WORDS.spend;
  const by = (day: number): string | null => {
    const value = spend[day] ?? null;
    return value === null ? null : formatNex(value);
  };
  const ticks = SPEND_TICKS.filter((day) => day < spend.length);
  return {
    known: spend.some((value) => value !== null),
    empty: words.empty(days),
    stats: [
      ...SPEND_DAYS.map(([id, day]) => ({ id, label: words.byDay(day), value: by(day) })),
      {
        id: SpendStat.FirstPurchase,
        label: words.firstPurchase,
        value: firstPurchaseDay === null ? null : dayName(firstPurchaseDay),
      },
    ],
    labels: spend.map((_, day) => dayName(day)),
    series: [{ id: "spend", label: words.series, tone: LineTone.Main, values: spend }],
    ticks: ticks.length > 1 ? ticks : undefined,
  };
}

/** A sources row from its counts: the share who paid and the Nex for each player are theirs divided. */
function sourceRow(id: string, name: string, counts: { players: number; payers: number; nex: number }): SourceRow {
  const { players, payers, nex } = counts;
  return { id, name, players, payers, paying: ratio(payers, players), nex, nexEach: ratio(nex, players) };
}

/** The channels in the order sent, and everyone who played as the row that sums them. */
function sourcesOf(data: RevenueReport): RevenueView["sources"] {
  const everyone = { players: data.players.now, payers: data.payers.now, nex: data.nex.now };
  return {
    rows: data.sources.map((source) => sourceRow(source.channel, REVENUE_WORDS.channels[source.channel], source)),
    total: sourceRow(TOTAL_ROW, REVENUE_WORDS.sources.total, everyone),
  };
}

/** What the Revenue report draws for `answer`. */
export function revenueView({
  data,
  window,
}: Pick<ReportAnswer<typeof GameReport.Revenue>, "data" | "window">): RevenueView {
  return {
    tiles: tilesOf(data),
    nothingBought: data.purchases.now === 0 && data.nex.now === 0,
    nothing: REVENUE_WORDS.nothingBought(window.days),
    daily: {
      labels: periodLabels(window),
      series: [{ id: "nex", label: REVENUE_WORDS.daily.series, slot: SeriesSlot.First, values: data.daily }],
    },
    items: itemsOf(data),
    spend: spendOf(data, window.days),
    sources: sourcesOf(data),
  };
}
