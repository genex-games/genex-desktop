/**
 * The Events report as genex.games answers it: what the game reports about itself. The game's own
 * events and the ones Genex counts, one event in full (its numbers per day, its values under one
 * property, what arrived in each property), and the creator's funnels.
 *
 * Read the way `report-overview.ts` reads its own: the fixed parts in `whole`, so one bad number
 * refuses the report; the lists with `rows`, which leaves a bad row out; every word a game or a
 * creator wrote through `line`; every `null` the contract allows kept as null. A game's own event
 * cannot wear a name Genex counts itself, and the events Genex counts are a closed vocabulary, so
 * the two lists never share a name.
 */
import {
  type AnalyticsWindow,
  AutoEvent,
  EVENT_LIMITS,
  type EventDetail,
  type EventRow,
  type EventsReport,
  FUNNELS_MAX,
  type PropertyFacts,
  PropertyKind,
} from "../../../shared/game-analytics.ts";
import { isRecord } from "../gallery.ts";
import { eventName, propertyName, propertyValue, toEventFunnel } from "./funnels.ts";
import { compared, count, isoDay, isoTime, oneOf, orNull, type Read, rate, rows, series, whole } from "./kit.ts";

/** The most values of one property an event is split into, and the most common values a text property lists. */
const SPLIT_VALUES_MAX = 24;
const TOP_VALUES_MAX = 10;
const AUTO_EVENTS_MAX = Object.keys(AutoEvent).length;

const isAutoEvent = oneOf(AutoEvent);
const isPropertyKind = oneOf(PropertyKind);

/** A property's number: any finite one, since a game may send a negative. */
const finite: Read<number> = (value) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

/** A row of an events list: its name, how often it came, from how many players, and when it first did. */
const eventRow: Read<EventRow> = (value) => {
  if (!isRecord(value)) return undefined;
  return whole({
    name: eventName(value.name),
    count: count(value.count),
    players: count(value.players),
    firstSeenOn: orNull(isoDay)(value.firstSeenOn),
  });
};

/** One of the game's own events; a row wearing a name Genex counts itself is left out. */
const ownRow: Read<EventRow> = (value) => {
  const row = eventRow(value);
  return row && !isAutoEvent(row.name) ? row : undefined;
};

/** One of the events Genex counts; a name the app does not know is left out. */
const autoRow: Read<EventRow> = (value) => {
  const row = eventRow(value);
  return row && isAutoEvent(row.name) ? row : undefined;
};

/** One of a text property's most common values, with the share of events that carried it. */
const topValue: Read<{ value: string; share: number }> = (value) => {
  if (!isRecord(value)) return undefined;
  return whole({ value: propertyValue(value.value), share: rate(value.share) });
};

/** What each kind of property says arrived in it. */
const FACTS = {
  [PropertyKind.Number]: (value) => {
    const read = whole({
      min: finite(value.min),
      max: finite(value.max),
      median: finite(value.median),
      p90: finite(value.p90),
    });
    if (!read) return undefined;
    const inOrder = read.min <= read.median && read.median <= read.p90 && read.p90 <= read.max;
    return inOrder ? { kind: PropertyKind.Number, ...read } : undefined;
  },
  [PropertyKind.Text]: (value) => {
    const top = rows(value.top, TOP_VALUES_MAX, topValue, (row) => row.value);
    return top ? { kind: PropertyKind.Text, top } : undefined;
  },
  [PropertyKind.Flag]: (value) => {
    const yes = rate(value.yes);
    return yes === undefined ? undefined : { kind: PropertyKind.Flag, yes };
  },
} as const satisfies Record<PropertyKind, (value: Record<string, unknown>) => PropertyFacts | undefined>;

/** What arrived in a property; one of a kind the app has no sentence for is left out. */
const propertyFacts: Read<PropertyFacts> = (value) =>
  isRecord(value) && isPropertyKind(value.kind) ? FACTS[value.kind](value) : undefined;

/** A property of the event: its name and what arrived in it. */
const property: Read<EventDetail["properties"][number]> = (value) => {
  if (!isRecord(value)) return undefined;
  return whole({ name: propertyName(value.name), facts: propertyFacts(value.facts) });
};

/** One value of the property the event is split by. */
const splitRow: Read<EventDetail["split"][number]> = (value) => {
  if (!isRecord(value)) return undefined;
  return whole({ value: propertyValue(value.value), count: count(value.count), players: count(value.players) });
};

/** The property an event is split by and its values, most first; an event split by nothing has none. */
function splitOf(value: Record<string, unknown>): Pick<EventDetail, "splitBy" | "split"> | undefined {
  const splitBy = orNull(propertyName)(value.splitBy);
  const split = rows(value.split, SPLIT_VALUES_MAX, splitRow, (row) => row.value);
  if (splitBy === undefined || split === undefined) return undefined;
  return { splitBy, split: splitBy === null ? [] : split };
}

/**
 * One event in full, with a count for each day of the period. More players who sent it than played
 * at all cannot be: such a detail does not read.
 */
function eventDetail(value: unknown, days: number): EventDetail | undefined {
  if (!isRecord(value) || typeof value.automatic !== "boolean") return undefined;
  const split = splitOf(value);
  const read = whole({
    name: eventName(value.name),
    automatic: value.automatic,
    firstSeenOn: orNull(isoDay)(value.firstSeenOn),
    count: compared(value.count),
    players: compared(value.players),
    everyone: count(value.everyone),
    daily: series(value.daily, days, count),
    properties: rows(value.properties, EVENT_LIMITS.properties, property, (row) => row.name),
  });
  const possible = read !== undefined && read.players.now <= read.everyone;
  return possible && split ? { ...read, ...split } : undefined;
}

/** A saved funnel in the report's list; one that does not read is left out. */
const funnel: Read<EventsReport["funnels"][number]> = (value) => toEventFunnel(value) ?? undefined;

/** The Events report for `window`, or null when `data` is not one. */
export function toEventsReport(data: unknown, window: AnalyticsWindow): EventsReport | null {
  if (!isRecord(data)) return null;
  const report = whole({
    lastAt: orNull(isoTime)(data.lastAt),
    total: count(data.total),
    custom: rows(data.custom, EVENT_LIMITS.names, ownRow, (row) => row.name),
    automatic: rows(data.automatic, AUTO_EVENTS_MAX, autoRow, (row) => row.name),
    detail: data.detail === null ? null : eventDetail(data.detail, window.days),
    funnels: rows(data.funnels, FUNNELS_MAX, funnel, (row) => row.id),
  });
  return report ?? null;
}
