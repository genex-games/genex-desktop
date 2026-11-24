/**
 * What the Events tab draws, derived from its answer without React: whether events are arriving,
 * the list of events with the search applied, the detail of the one picked (its tiles, per-day
 * line, split and what arrived in each property), and the saved funnels with what each step
 * loses. The components only lay these out. A number that cannot be known stays null all the way
 * to the kit, which writes it as a dash, and the clock is the caller's.
 */
import {
  type EventDetail,
  type EventFunnel,
  type EventRow,
  FUNNELS_MAX,
  type GameReport,
  type GameReportOptions,
  type PropertyFacts,
  PropertyKind,
} from "../../../shared/game-analytics.ts";
import { formatList } from "../../../shared/i18n.ts";
import { MINUTE_MS } from "../../../shared/duration.ts";
import {
  type BarListItem,
  DeltaKind,
  type FunnelStepItem,
  formatAgo,
  formatDay,
  formatNumber,
  formatPercent,
  formatSigned,
  type LineSeries,
  LineTone,
  type MetricDelta,
  type SegmentOption,
  periodLabels,
  ratio,
} from "./kit/index.ts";
import { EVENTS_WORDS as WORDS } from "./events-words.ts";
import { type ReportAnswer, savedPastLimit } from "./report-props.ts";

/** An event whose last one came this long ago or less is still arriving. */
const ARRIVING_MS = 15 * MINUTE_MS;
/** The decimals of "events per player" and of its change. */
const PER_PLAYER_DIGITS = 1;
/** The most values a text property lists in its row before it says how many more there are. */
const TOP_SHOWN = 5;
/** A share under this reads with a decimal, so a rare value is not "0%". */
const FINE_SHARE = 0.1;

/** Whether events are coming in. */
export const Arrival = { Arriving: "arriving", Quiet: "quiet", None: "none" } as const;
export type Arrival = (typeof Arrival)[keyof typeof Arrival];

/** The strip above the list: whether events arrive, when the last came, and how many of the game's own there are. */
export interface EventsStrip {
  arrival: Arrival;
  /** The status in words. */
  status: string;
  /** "Last one 12 sec. ago"; null when none ever came. */
  last: string | null;
  /** "217,400 events in this period, under 8 names"; null for a game that sends none of its own. */
  counted: string | null;
}

/** A row of the list: the numbers are the period's. */
export interface EventListRow {
  name: string;
  count: number;
  players: number;
  /** Events per player; null with no players. */
  perPlayer: number | null;
}

/** The list of events, with the search applied. */
export interface EventsList {
  /** The game's own events, then the ones Genex counts. */
  custom: EventListRow[];
  automatic: EventListRow[];
  /** The game sends none of its own: the list says how to start. */
  noOwn: boolean;
  /** The SDK the published game loads can send events; when it cannot, the note says to update it. */
  sdkReady: boolean;
  /** The search is on and left nothing. */
  noMatch: boolean;
}

/** One of the four numbers above an event's line. */
export interface EventTile {
  id: string;
  label: string;
  value: string | null;
  delta?: MetricDelta;
  note?: string;
}

/** The value of one property the event is split by. */
export interface EventSplit {
  /** The property the bars are split by: the one asked for, or the one the answer chose. */
  property: string;
  options: SegmentOption<string>[];
  items: BarListItem[];
  /** What a bar's share is of: every event of the period. */
  total: number;
  label: string;
}

/** A property of the event and what arrived in it. */
export interface PropertyRow {
  name: string;
  kind: string;
  arrived: string;
}

/** An event in full. */
export interface EventDetailView {
  name: string;
  automatic: boolean;
  /** What the event is for, for the ones the app knows. */
  note: string | null;
  /** "First seen Oct 2."; null when it is not known. */
  firstSeen: string | null;
  tiles: EventTile[];
  series: LineSeries[];
  labels: string[];
  /** Null when the event has no property to split by. */
  split: EventSplit | null;
  properties: PropertyRow[];
}

/** One saved funnel. */
export interface FunnelView {
  id: string;
  name: string;
  /** "Players who did every step in order within 7 days." */
  within: string;
  /** How many reached the end and when, or that nobody started; null for a funnel of one step. */
  outcome: string | null;
  steps: FunnelStepItem[];
}

/** The saved funnels, and whether another may be made. */
export interface FunnelsView {
  funnels: FunnelView[];
  /** The game keeps `FUNNELS_MAX` already. */
  full: boolean;
  /** The names a step can be: the game's own events, then the ones Genex counts. */
  events: string[];
}

/** Everything the Events tab draws. */
export interface EventsView {
  strip: EventsStrip;
  list: EventsList;
  /** The event whose row is marked: the one asked for, or the one the answer details. */
  selected: string | null;
  detail: EventDetailView | null;
  funnels: FunnelsView;
}

/** What pressing a row of the list asks for: that event, split by its first property again. */
export const eventAsked = (name: string): GameReportOptions => ({ event: name, splitBy: undefined });

/** What picking a property in the split switch asks for. */
export const splitAsked = (property: string): GameReportOptions => ({ splitBy: property });

/** The search as it matches names: lower case, spaces as underscores, as an event is named. */
export const searchTerm = (query: string): string => query.trim().toLowerCase().replace(/\s+/g, "_");

const perPlayerOf = (count: number | null, players: number | null): number | null => ratio(count, players);

/** A row of the list. */
const rowOf = ({ name, count, players }: EventRow): EventListRow => ({
  name,
  count,
  players,
  perPlayer: perPlayerOf(count, players),
});

/** The rows whose name holds `term`. */
const matching = (rows: readonly EventRow[], term: string): EventListRow[] =>
  rows.filter((row) => row.name.includes(term)).map(rowOf);

/** Whether events are coming in, from when the last one came. */
export function arrivalOf(lastAt: string | null, now: number): Arrival {
  if (lastAt === null) return Arrival.None;
  const at = Date.parse(lastAt);
  return Number.isFinite(at) && now - at <= ARRIVING_MS ? Arrival.Arriving : Arrival.Quiet;
}

const STATUS_WORDS = {
  [Arrival.Arriving]: WORDS.status.arriving,
  [Arrival.Quiet]: WORDS.status.quiet,
  [Arrival.None]: WORDS.status.none,
} as const satisfies Record<Arrival, string>;

/** The strip: the status, when the last event came, and how many the game's own events are. */
export function stripOf(data: ReportAnswer<typeof GameReport.Events>["data"], now: number): EventsStrip {
  const arrival = arrivalOf(data.lastAt, now);
  const own = data.custom.length > 0;
  return {
    arrival,
    status: STATUS_WORDS[arrival],
    last: data.lastAt === null ? null : WORDS.status.last(formatAgo(data.lastAt, now)),
    counted: own
      ? WORDS.status.counted(data.total, formatNumber(data.total), data.custom.length, formatNumber(data.custom.length))
      : null,
  };
}

/** The list of events with the search applied. */
export function listOf(
  { data, game }: Pick<ReportAnswer<typeof GameReport.Events>, "data" | "game">,
  query: string,
): EventsList {
  const term = searchTerm(query);
  const custom = matching(data.custom, term);
  const automatic = matching(data.automatic, term);
  return {
    custom,
    automatic,
    noOwn: data.custom.length === 0,
    sdkReady: game.eventsReady,
    noMatch: term !== "" && custom.length + automatic.length === 0,
  };
}

/** A property's number as it reads: whole when it is, else with the decimals it needs (up to two). */
export function propertyNumber(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  if (Number.isInteger(rounded)) return formatNumber(rounded);
  const tenths = Math.round(rounded * 10) / 10 === rounded;
  return formatNumber(rounded, tenths ? 1 : 2);
}

/** A share of a property's values: a rare one keeps a decimal. */
const shareOf = (share: number): string => formatPercent(share, share < FINE_SHARE ? 1 : 0);

/** One sentence of what arrived in a property, by its kind. */
export function factsOf(facts: PropertyFacts): string {
  if (facts.kind === PropertyKind.Number) {
    const { min, max, median, p90 } = facts;
    return WORDS.properties.number(
      propertyNumber(min),
      propertyNumber(max),
      propertyNumber(median),
      propertyNumber(p90),
    );
  }
  if (facts.kind === PropertyKind.Flag) return WORDS.properties.flag(shareOf(facts.yes));
  const top = facts.top.map(({ value, share }) => WORDS.properties.valueShare(value, shareOf(share)));
  const values = formatList(top.slice(0, TOP_SHOWN));
  const more = top.length - TOP_SHOWN;
  return more > 0 ? WORDS.properties.textMore(values, more, formatNumber(more)) : values;
}

/** The properties as the table lists them. */
const propertiesOf = (properties: EventDetail["properties"]): PropertyRow[] =>
  properties.map(({ name, facts }) => ({
    name,
    kind: WORDS.properties.kinds[facts.kind],
    arrived: factsOf(facts),
  }));

const formatPercentOrNull = (rate: number | null): string | null => (rate === null ? null : formatPercent(rate));

/**
 * The four numbers above the line. An event's direction is neither good nor bad news (a win and a
 * death are both events), so how the first three moved is written in ink.
 */
function tilesOf({ count, players, everyone }: EventDetail): EventTile[] {
  const perNow = perPlayerOf(count.now, players.now);
  const perBefore = perPlayerOf(count.before, players.before);
  return [
    {
      id: "count",
      label: WORDS.detail.count,
      value: formatNumber(count.now),
      delta: { kind: DeltaKind.Percent, now: count.now, before: count.before, neutral: true },
    },
    {
      id: "players",
      label: WORDS.detail.players,
      value: formatNumber(players.now),
      delta: { kind: DeltaKind.Percent, now: players.now, before: players.before, neutral: true },
    },
    {
      id: "per-player",
      label: WORDS.detail.perPlayer,
      value: perNow === null ? null : formatNumber(perNow, PER_PLAYER_DIGITS),
      delta: {
        kind: DeltaKind.Amount,
        now: perNow,
        before: perBefore,
        format: (change) => formatSigned(change, PER_PLAYER_DIGITS),
        digits: PER_PLAYER_DIGITS,
        neutral: true,
      },
    },
    {
      id: "share",
      label: WORDS.detail.share,
      value: formatPercentOrNull(ratio(players.now, everyone)),
      note: WORDS.detail.shareNote(everyone, formatNumber(everyone)),
    },
  ];
}

/** The values of the split as bars, most first, each with the players behind it. */
function splitOf(detail: EventDetail, asked: string | undefined): EventSplit | null {
  const first = detail.properties[0];
  if (!first) return null;
  const named = asked !== undefined && detail.properties.some((property) => property.name === asked);
  const property = named ? asked : (detail.splitBy ?? first.name);
  const items = detail.split.map(({ value, count, players }) => ({
    id: value,
    label: value,
    value: count,
    detail: WORDS.split.players(players, formatNumber(players)),
  }));
  return {
    property,
    options: detail.properties.map(({ name }) => ({ value: name, label: name, mask: true })),
    items,
    total: Math.max(detail.count.now, ...items.map((item) => item.value)),
    label: WORDS.split.label(property),
  };
}

/** The event in full. */
export function detailOf(
  { data, window }: ReportAnswer<typeof GameReport.Events>,
  asked: string | undefined,
): EventDetailView | null {
  const detail = data.detail;
  if (!detail) return null;
  return {
    name: detail.name,
    automatic: detail.automatic,
    note: WORDS.detail.note(detail.name),
    firstSeen: detail.firstSeenOn === null ? null : WORDS.detail.firstSeen(formatDay(detail.firstSeenOn)),
    tiles: tilesOf(detail),
    series: [{ id: "count", label: WORDS.detail.count, tone: LineTone.Main, values: detail.daily }],
    labels: periodLabels(window),
    split: splitOf(detail, asked),
    properties: propertiesOf(detail.properties),
  };
}

/** What came of a funnel: nobody started it, or the share of the first step's players who reached the end, and the day they typically did. */
function outcomeOf({ steps, typicalDay }: EventFunnel): string | null {
  const first = steps[0]?.players ?? 0;
  if (first === 0) return WORDS.funnels.nobody;
  const reach = steps.length > 1 ? ratio(steps[steps.length - 1]?.players, first) : null;
  if (reach === null) return null;
  const share = formatPercent(reach);
  if (typicalDay === null) return WORDS.funnels.reach(share);
  return typicalDay === 0
    ? WORDS.funnels.reachSameDay(share)
    : WORDS.funnels.reachTypically(share, formatNumber(typicalDay));
}

/** A saved funnel: its steps with who reached each, and how many made it to the end. */
export function funnelOf(funnel: EventFunnel): FunnelView {
  return {
    id: funnel.id,
    name: funnel.name,
    within: WORDS.funnels.within(funnel.withinDays, formatNumber(funnel.withinDays)),
    outcome: outcomeOf(funnel),
    steps: funnel.steps.map((step, index) => ({
      id: `${index}-${step.event}`,
      label: step.event,
      qualifier: step.property === null ? undefined : `${step.property} = ${step.value}`,
      count: step.players,
    })),
  };
}

/** The funnels, and the names a step can be. */
export function funnelsOf(data: ReportAnswer<typeof GameReport.Events>["data"]): FunnelsView {
  return {
    funnels: data.funnels.map(funnelOf),
    full: data.funnels.length >= FUNNELS_MAX,
    events: [...data.custom, ...data.automatic].map((row) => row.name),
  };
}

/** What the funnel form says when genex.games refused a save: to remove one first when the game keeps no more. */
export const funnelRefusal = (error: unknown): string =>
  savedPastLimit(error) ? WORDS.funnels.limit(FUNNELS_MAX, formatNumber(FUNNELS_MAX)) : WORDS.form.refused;

/**
 * Everything the Events tab draws. `query` is what the search box holds; `asked` and `splitBy` are
 * the options the report is asked with now (they follow a press before the answer lands).
 */
export function eventsView(
  answer: ReportAnswer<typeof GameReport.Events>,
  options: { event?: string; splitBy?: string },
  query: string,
  now: number,
): EventsView {
  const { data } = answer;
  return {
    strip: stripOf(data, now),
    list: listOf(answer, query),
    selected: options.event ?? data.detail?.name ?? null,
    detail: detailOf(answer, options.splitBy),
    funnels: funnelsOf(data),
  };
}
