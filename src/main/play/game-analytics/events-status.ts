/**
 * A game's events as they arrive, for the SDK page: the newest ones, what genex.games dropped over
 * the last day and the limits events are held to. Read with the helpers in `kit.ts`; the game is
 * read by `toAnalyticsGame` (`game.ts`).
 *
 * Everything here but the counts and the times is a game's own words (an event's name, a
 * property's name and value, the name of an event that was dropped because it was not a name), so
 * each is one clean line or its row is left out. The limits are numbers the page writes its rules
 * from: one genex.games did not send, or sent as anything but a positive whole number, is the app's own.
 */
import {
  DROPPED_ROWS_MAX,
  DropReason,
  type DroppedEvents,
  EVENT_LIMITS,
  type EventLimits,
  type EventOrigin,
  type EventsStatus,
  RECENT_EVENTS_MAX,
  type RecentEvent,
} from "../../../shared/game-analytics.ts";
import { isRecord } from "../gallery.ts";
import { toAnalyticsGame } from "./game.ts";
import { count, isoTime, line, oneOf, orNull, type Read, rows, whole } from "./kit.ts";

/**
 * The longest an event's or a property's name and a property's value may read. A dropped event's
 * name is shown as the game sent it, which may be longer than the limit that dropped it.
 */
const WORDS_MAX = 200;
/** The longest a player's label may read ("US · computer"), and the most properties a row keeps. */
const PLAYER_MAX = 60;
const PROPERTIES_MAX = 20;

const isDropReason = oneOf(DropReason);

/** One line of a game's own words. */
const words: Read<string> = (value) => line(value, WORDS_MAX);

type Property = RecentEvent["properties"][number];

/** One property of an event as text: its name and its value. */
const property: Read<Property> = (value) =>
  isRecord(value) ? whole({ name: words(value.name), value: words(value.value) }) : undefined;

/** An event that just arrived; a property that does not read is left out of it. */
const recentEvent: Read<RecentEvent> = (value) => {
  if (!isRecord(value)) return undefined;
  return whole({
    at: isoTime(value.at),
    name: words(value.name),
    player: line(value.player, PLAYER_MAX),
    properties: rows(value.properties, PROPERTIES_MAX, property, (one) => one.name),
  });
};

/** Events dropped for one reason under one name; a reason the app has no sentence for is left out, and so is a row that counts nothing. */
const droppedEvents: Read<DroppedEvents> = (value) => {
  if (!isRecord(value) || !isDropReason(value.reason)) return undefined;
  const dropped = count(value.count);
  return whole({
    name: words(value.name),
    reason: value.reason,
    property: orNull(words)(value.property),
    count: dropped === 0 ? undefined : dropped,
    lastAt: isoTime(value.lastAt),
  });
};

/** What tells one dropped row from another. */
const droppedKey = (row: DroppedEvents): string => JSON.stringify([row.name, row.reason, row.property]);

/** One limit: genex.games' when it is a positive whole number, else the app's own. */
const limit = (value: unknown, fallback: number): number => {
  const sent = count(value);
  return sent === undefined || sent === 0 ? fallback : sent;
};

/** The limits events are held to, each one genex.games' or, failing that, the app's own. */
function eventLimits(value: unknown): EventLimits {
  const sent = isRecord(value) ? value : {};
  return {
    nameLength: limit(sent.nameLength, EVENT_LIMITS.nameLength),
    names: limit(sent.names, EVENT_LIMITS.names),
    properties: limit(sent.properties, EVENT_LIMITS.properties),
    textLength: limit(sent.textLength, EVENT_LIMITS.textLength),
    batchSeconds: limit(sent.batchSeconds, EVENT_LIMITS.batchSeconds),
    keptDays: limit(sent.keptDays, EVENT_LIMITS.keptDays),
  };
}

/**
 * The events of the game `slug` from `origin`, or null when `body` is not that answer (another game
 * or origin echoed, a part missing). `local` (fixture launches only) lets a drawn cover through.
 */
export function toEventsStatus(body: unknown, slug: string, origin: EventOrigin, local = false): EventsStatus | null {
  if (!isRecord(body) || body.origin !== origin) return null;
  const status = whole({
    game: toAnalyticsGame(body.game, slug, local) ?? undefined,
    origin,
    lastAt: orNull(isoTime)(body.lastAt),
    names: count(body.names),
    recent: rows(body.recent, RECENT_EVENTS_MAX, recentEvent),
    dropped: rows(body.dropped, DROPPED_ROWS_MAX, droppedEvents, droppedKey),
    limits: eventLimits(body.limits),
  });
  return status ?? null;
}
