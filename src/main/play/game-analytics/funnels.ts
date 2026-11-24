/**
 * A funnel the creator saved over a game's events, as genex.games answers it after a save and in
 * the Events report's list, and the readers of the names a game writes that the Events report
 * shares with it. Read with the helpers in `kit.ts`.
 *
 * A funnel is read whole or not at all: a step left out would make it another funnel, so one step
 * that does not read, more steps than a funnel may have, or a step reached by more players than the
 * one before, refuses it.
 */
import {
  EVENT_LIMITS,
  EVENT_NAME,
  type EventFunnel,
  type EventFunnelStep,
  FUNNEL_DAYS_MAX,
  FUNNEL_STEPS_MAX,
} from "../../../shared/game-analytics.ts";
import { FUNNEL_NAME_MAX, PROPERTY_NAME_MAX } from "../../../shared/game-analytics-asks.ts";
import { isCursor, isRecord } from "../gallery.ts";
import { count, line, type Read, shortSeries, whole } from "./kit.ts";

/**
 * An event's name as genex.games takes one, cleaned: lower case letters, digits and underscores, a
 * letter first, no longer than a name may be. Main asks for an event by this same rule, so every
 * name that reads here can be asked for.
 */
export const eventName: Read<string> = (value) => {
  const name = line(value, EVENT_LIMITS.nameLength);
  return name !== undefined && EVENT_NAME.test(name) ? name : undefined;
};

/** The name of an event's property, cleaned: a short line of plain words. */
export const propertyName: Read<string> = (value) => line(value, PROPERTY_NAME_MAX);

/** A property's value as text, cleaned: no longer than genex.games keeps one. */
export const propertyValue: Read<string> = (value) => line(value, EVENT_LIMITS.textLength);

/** The property a step asks for and the value it must have: both, or neither. */
function stepFilter(value: Record<string, unknown>): Pick<EventFunnelStep, "property" | "value"> | undefined {
  if (value.property === null && value.value === null) return { property: null, value: null };
  const property = propertyName(value.property);
  const text = propertyValue(value.value);
  return property !== undefined && text !== undefined ? { property, value: text } : undefined;
}

/** A step: its event, what narrows it, and the players who reached it. */
const funnelStep: Read<EventFunnel["steps"][number]> = (value) => {
  if (!isRecord(value)) return undefined;
  const filter = stepFilter(value);
  const read = whole({ event: eventName(value.event), players: count(value.players) });
  return read && filter ? { event: read.event, ...filter, players: read.players } : undefined;
};

/** The days every step must happen within: a whole number from one to the longest a funnel may run. */
const windowDays: Read<number> = (value) => {
  const days = count(value);
  return days !== undefined && days >= 1 && days <= FUNNEL_DAYS_MAX ? days : undefined;
};

/** The day players typically reach the last step: null while nobody has, never after the window closed. */
function typicalDay(value: unknown, withinDays: number): number | null | undefined {
  if (value === null) return null;
  const day = count(value);
  return day !== undefined && day <= withinDays ? day : undefined;
}

/**
 * The steps in order, each reached by no more players than the one before: a funnel counts the
 * players who did every step so far, so one that grows cannot be.
 */
function narrowing(steps: EventFunnel["steps"] | undefined): EventFunnel["steps"] | undefined {
  if (!steps || steps.length === 0) return undefined;
  const grows = steps.some((step, index) => index > 0 && step.players > (steps[index - 1]?.players ?? 0));
  return grows ? undefined : steps;
}

/** One saved funnel, or null when `value` is not one. */
export function toEventFunnel(value: unknown): EventFunnel | null {
  if (!isRecord(value) || !isCursor(value.id)) return null;
  const withinDays = windowDays(value.withinDays);
  const funnel = whole({
    id: value.id,
    name: line(value.name, FUNNEL_NAME_MAX),
    withinDays,
    steps: narrowing(shortSeries(value.steps, FUNNEL_STEPS_MAX, funnelStep)),
    typicalDay: withinDays === undefined ? undefined : typicalDay(value.typicalDay, withinDays),
  });
  return funnel ?? null;
}
