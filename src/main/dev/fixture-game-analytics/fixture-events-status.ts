/**
 * A fixture game's events as they arrive, as genex.games answers them for the SDK page: the newest
 * events from the published game or from Studio's preview, what was dropped over the last day and
 * the limits. Made from the game's sample (`sample.ts`); `sample.game` is the answer's `game`.
 *
 * The published game's events are a stream on a grid of time: each slot of the grid holds one
 * event, the same one on every read, so a read a few seconds later has newer events over the ones
 * before it. The rich game sends its own events and two that are dropped; a steady game's build
 * cannot send its own, and a young game has none yet, so both show only what Genex counts. A game
 * nobody played today has nothing arriving. The preview holds one short test that has ended.
 */
import { HOUR_MS, MINUTE_MS, SECOND_MS } from "../../../shared/duration.ts";
import {
  AutoEvent,
  DropReason,
  type DroppedEvents,
  EVENT_LIMITS,
  EventOrigin,
  type EventsStatus,
  GenexSurface,
  KnownEvent,
  type RecentEvent,
} from "../../../shared/game-analytics.ts";
import { type GameSample, noise, SampleKind } from "./sample.ts";

type Property = RecentEvent["properties"][number];

/** A number from 0 to 1 for a detail of one event: steady for the game, the event and the detail's place. */
type Pick = (place: number) => number;

/** A kind of event the fixture sends: its name and the properties one of them carries. */
interface Kind {
  name: string;
  properties(pick: Pick, sample: GameSample): Property[];
}

/** How often the published game of each kind sends an event, and how many of the newest an answer holds. */
const STREAM = {
  [SampleKind.Rich]: { everyMs: 4 * SECOND_MS, events: 30 },
  [SampleKind.Steady]: { everyMs: 25 * SECOND_MS, events: 12 },
  [SampleKind.Young]: { everyMs: 9 * MINUTE_MS, events: 4 },
} as const satisfies Record<SampleKind, { everyMs: number; events: number }>;
/** The grid's slots repeat their events after this many, which keeps the noise's index small. */
const SLOT_CYCLE = 100_000;
/** Where this answer's own details start in the sample's noise: the stream's, then the preview's. */
const NOISE_AT = 500;
const PREVIEW_NOISE_AT = NOISE_AT + SLOT_CYCLE;
/** The preview's test ended this long before the top of the hour, its events this far apart. */
const PREVIEW_ENDED_BEFORE_MS = 7 * MINUTE_MS;
const PREVIEW_GAP_MS = 9 * SECOND_MS;
/** The names the rich game has used, as its Events report lists them. */
const RICH_NAMES = 8;
/** The time of day a game nobody plays any more got its last event. */
const LAST_EVENT_TIME = "T21:17:40.000Z";
const LEVELS = 8;
/** Who an event came from, as genex.games labels a player without naming one. */
const PLAYERS = ["US · computer", "BR · phone", "DE · computer", "US · phone", "GB · computer", "IN · phone"] as const;
const POWERUPS = ["dash", "shield", "magnet"] as const;
const MENUS = ["pause_menu", "main_menu"] as const;

const property = (name: string, value: string | number): Property => ({ name, value: String(value) });
/** A whole number from `from` to `to`, by a pick. */
const between = (pick: number, from: number, to: number): number => from + Math.floor(pick * (to - from + 1));
/** One of `values`, by a pick. */
const oneOf = (pick: number, values: readonly string[]): string => values[Math.floor(pick * values.length)] ?? "";
const level = (pick: number): Property => property("level", between(pick, 1, LEVELS));

/** The rich game's own events. */
const OWN = {
  levelComplete: {
    name: KnownEvent.LevelComplete,
    properties: (pick) => [
      level(pick(1)),
      property("time_s", between(pick(2), 40, 120)),
      property("deaths", between(pick(3), 0, 4)),
    ],
  },
  lanternLit: { name: "lantern_lit", properties: (pick) => [level(pick(1))] },
  powerupUsed: {
    name: "powerup_used",
    properties: (pick) => [property("kind", oneOf(pick(2), POWERUPS)), level(pick(1))],
  },
  levelFail: {
    name: KnownEvent.LevelFail,
    properties: (pick) => [level(pick(1)), property("deaths", between(pick(3), 1, 5))],
  },
  shopOpen: { name: "shop_open", properties: (pick) => [property("from", oneOf(pick(2), MENUS))] },
  levelStart: { name: KnownEvent.LevelStart, properties: (pick) => [level(pick(1))] },
} as const satisfies Record<string, Kind>;

/** The events Genex counts in every game. A play's source is the game's campaign or a place inside Genex. */
const AUTOMATIC = {
  playStart: {
    name: AutoEvent.PlayStart,
    properties: (pick, sample) => [
      property(
        "source",
        oneOf(pick(1), [sample.campaign?.name ?? GenexSurface.Feed, GenexSurface.Feed, GenexSurface.Featured]),
      ),
    ],
  },
  gameReady: { name: AutoEvent.GameReady, properties: (pick) => [property("load_ms", between(pick(1), 1800, 4400))] },
  playEnd: {
    name: AutoEvent.PlayEnd,
    properties: (pick) => [property("seconds", between(pick(1), 20, 900)), property("fps", between(pick(2), 28, 60))],
  },
  purchase: { name: AutoEvent.Purchase, properties: () => [property("item", "extra_life_pack"), property("nex", 40)] },
} as const satisfies Record<string, Kind>;

/** What the rich game's preview test sent, newest first, and a game's with no events of its own. */
const RICH_PREVIEW: readonly Kind[] = [
  OWN.levelComplete,
  OWN.lanternLit,
  OWN.levelStart,
  AUTOMATIC.gameReady,
  AUTOMATIC.playStart,
];
const PLAIN_PREVIEW: readonly Kind[] = [AUTOMATIC.playEnd, AUTOMATIC.gameReady, AUTOMATIC.playStart];

/** The kinds of event the published game sends: Genex's, a purchase only where somebody pays, and the rich game's own. */
function streamKinds(sample: GameSample): Kind[] {
  const counted: Kind[] = [AUTOMATIC.playStart, AUTOMATIC.gameReady, AUTOMATIC.playEnd];
  if (sample.purchases.now > 0) counted.push(AUTOMATIC.purchase);
  return sample.kind === SampleKind.Rich ? [...Object.values(OWN), ...counted] : counted;
}

/** One event of `kind` at `at`, its details drawn at `index` of the sample's noise. */
function eventOf(sample: GameSample, kind: Kind, at: number, index: number): RecentEvent {
  const pick: Pick = (place) => noise(sample.seed + place + 1, index);
  return {
    at: new Date(at).toISOString(),
    name: kind.name,
    player: oneOf(pick(4), PLAYERS),
    properties: kind.properties(pick, sample),
  };
}

/** The published game's newest events at `now`: one for each slot of the grid that has ended, newest first. */
function streamOf(sample: GameSample, now: number): RecentEvent[] {
  const { everyMs, events } = STREAM[sample.kind];
  const kinds = streamKinds(sample);
  const current = Math.floor(now / everyMs);
  return Array.from({ length: events }, (_, back) => current - 1 - back).flatMap((slot) => {
    const index = NOISE_AT + (slot % SLOT_CYCLE);
    const kind = kinds[Math.floor(noise(sample.seed, index) * kinds.length)];
    const within = Math.floor(noise(sample.seed + 6, index) * everyMs);
    return kind ? [eventOf(sample, kind, slot * everyMs + within, index)] : [];
  });
}

/** The preview's last test: a few events that ended before the top of the hour, newest first; none for a young game. */
function previewOf(sample: GameSample, now: number): RecentEvent[] {
  if (sample.kind === SampleKind.Young) return [];
  const ended = Math.floor(now / HOUR_MS) * HOUR_MS - PREVIEW_ENDED_BEFORE_MS;
  const kinds = sample.kind === SampleKind.Rich ? RICH_PREVIEW : PLAIN_PREVIEW;
  return kinds.map((kind, back) => eventOf(sample, kind, ended - back * PREVIEW_GAP_MS, PREVIEW_NOISE_AT + back));
}

/** What genex.games dropped from the rich game over the last day: a name that is not one, and a value that is a list. */
function droppedOf(now: number): DroppedEvents[] {
  const tenMinutes = 10 * MINUTE_MS;
  return [
    {
      name: "Level Complete",
      reason: DropReason.BadName,
      property: null,
      count: 41,
      lastAt: new Date(Math.floor(now / tenMinutes) * tenMinutes - 3 * tenMinutes).toISOString(),
    },
    {
      name: OWN.powerupUsed.name,
      reason: DropReason.BadValue,
      property: "meta",
      count: 7,
      lastAt: new Date(Math.floor(now / HOUR_MS) * HOUR_MS - 2 * HOUR_MS).toISOString(),
    },
  ];
}

/** When a game nobody played today got its last event: the evening of its last day with a play, if the period has one. */
function lastEventOf(sample: GameSample): string | null {
  const last = sample.plays.daily.findLastIndex((plays) => plays > 0);
  const day = sample.dates[last];
  return day === undefined ? null : `${day}${LAST_EVENT_TIME}`;
}

/**
 * The events status of `sample`'s game from `origin` at `now`, the launch's clock. Without it the
 * events are dated by the moment the sample's numbers were computed, a few minutes behind.
 */
export function fixtureEventsStatus(
  sample: GameSample,
  origin: EventOrigin,
  now: number = Date.parse(sample.window.computedAt),
): EventsStatus {
  const published = origin === EventOrigin.Published;
  const live = (sample.plays.daily.at(-1) ?? 0) > 0;
  const stream = published && live ? streamOf(sample, now) : [];
  const recent = published ? stream : previewOf(sample, now);
  const sendsOwn = sample.kind === SampleKind.Rich;
  return {
    game: sample.game,
    origin,
    lastAt: recent[0]?.at ?? (published ? lastEventOf(sample) : null),
    names: sendsOwn ? RICH_NAMES : 0,
    recent,
    dropped: sendsOwn && stream.length > 0 ? droppedOf(now) : [],
    limits: EVENT_LIMITS,
  };
}
