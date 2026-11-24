/**
 * A fixture game's Events report as genex.games answers it: what the game reports about itself.
 * Made from the game's sample (`sample.ts`), the way `fixture-overview.ts` makes its own, so its
 * numbers agree with every other report of the game: what Genex counts by itself is the sample's
 * plays, players, purchases and installs, and the game's own events move with its plays.
 *
 * Only the rich game sends events of its own (the design's eight, with the properties the page was
 * drawn with) and keeps a funnel over them; a steady game loads an SDK from before games could, and
 * the young one has not added any. Every event has been sent since before the made-up history
 * begins, so a period and the one before it are counted the same way.
 */
import { MINUTE_MS, SECOND_MS } from "../../../shared/duration.ts";
import {
  AutoEvent,
  type Compared,
  DeviceClass,
  type EventDetail,
  type EventFunnel,
  type EventRow,
  type EventsReport,
  type GameReportOptions,
  KnownEvent,
  PlayPlace,
  type PropertyFacts,
  PropertyKind,
} from "../../../shared/game-analytics.ts";
import { dayBefore } from "../../../shared/play-stats.ts";
import { type GameSample, noise, SampleKind, spread } from "./sample.ts";

/** The design's month, which the game's own events are counted against: its plays and its players. */
const DESIGN = { plays: 30_889, players: 9300 } as const;
/** How long after the sample's numbers were computed the last event came: twelve seconds before the launch's clock. */
const LAST_EVENT_AFTER_COMPUTED_MS = 4 * MINUTE_MS - 12 * SECOND_MS;
/** When the last event of a day that is over came. */
const LAST_EVENT_TIME = "21:14:09.000Z";
/** The saved funnel's id, the same over every period, so a removal finds it. */
const FIRST_PURCHASE_ID = "fx-funnel-first-purchase";
/** How the players behind a split value thin out against the players of the most common one. */
const SPLIT_PLAYERS_CURVE = 0.85;
/** The share of installs that were opened, and the share of players who share the game. */
const OPENED_SHARE = 0.87;
const SHARED_BY = 0.11;
/** Where each kind of detail takes its noise from, so no two move together. */
const NOISE = { trend: 60, wobble: 80, place: 100, device: 110, load: 120, seconds: 130, nex: 140, via: 150 } as const;

/** The events the made-up game sends beside the ones every game may (`KnownEvent`). */
const OwnEvent = {
  LanternLit: "lantern_lit",
  PowerupUsed: "powerup_used",
  ShopOpen: "shop_open",
  SkinEquipped: "skin_equipped",
} as const;

/** A property's values with how often each arrives, in the order a game would list them. */
type Weighted = readonly (readonly [value: string, weight: number])[];
type NumberFacts = Omit<Extract<PropertyFacts, { kind: typeof PropertyKind.Number }>, "kind">;

/** A property of a made-up event: what arrives in it, and the values the event is split into under it. */
type MadeProperty =
  | { name: string; kind: typeof PropertyKind.Number; values: Weighted; facts: NumberFacts }
  | { name: string; kind: typeof PropertyKind.Text; values: Weighted }
  | { name: string; kind: typeof PropertyKind.Flag; yes: number };

/** One event over the period: what the list, the detail and the funnel are made from. */
interface MadeEvent {
  name: string;
  automatic: boolean;
  firstSeenOn: string | null;
  count: Compared;
  players: Compared;
  daily: number[];
  properties: readonly MadeProperty[];
}

/** One of the game's own events as the design has it. */
interface OwnSpec {
  name: string;
  /** How often it came over the design's month, and from how many players. */
  count: number;
  players: number;
  /** Days after the game was published that it was first sent. */
  seenAfter: number;
  /** How the month before compares, for the count and the players, where the design says. */
  trend?: readonly [count: number, players: number];
  properties: readonly MadeProperty[];
}

const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);
const round1 = (value: number): number => Math.round(value * 10) / 10;
const round3 = (value: number): number => Math.round(value * 1000) / 1000;

const facts = (min: number, max: number, median: number, p90: number): NumberFacts => ({ min, max, median, p90 });
const number = (name: string, values: Weighted, arrived: NumberFacts): MadeProperty => ({
  name,
  kind: PropertyKind.Number,
  values,
  facts: arrived,
});
const text = (name: string, values: Weighted): MadeProperty => ({ name, kind: PropertyKind.Text, values });
const flag = (name: string, yes: number): MadeProperty => ({ name, kind: PropertyKind.Flag, yes });

/** The level an event happened on: how often on each, from the first. */
const level = (counts: readonly number[], median: number, p90: number): MadeProperty =>
  number(
    "level",
    counts.map((count, index) => [String(index + 1), count] as const),
    facts(1, counts.length, median, p90),
  );

/** The design's own events, with what arrives in each property. */
const OWN_EVENTS: readonly OwnSpec[] = [
  {
    name: OwnEvent.LanternLit,
    count: 96_540,
    players: 6870,
    seenAfter: 0,
    properties: [
      level([21_300, 17_900, 15_200, 12_400, 10_100, 8300, 6700, 4640], 3, 7),
      text("color", [
        ["amber", 52],
        ["blue", 31],
        ["green", 17],
      ]),
    ],
  },
  {
    name: KnownEvent.LevelStart,
    count: 41_260,
    players: 7410,
    seenAfter: 0,
    properties: [
      level([9980, 8210, 6890, 5120, 4010, 3090, 2390, 1570], 3, 6),
      text("difficulty", [
        ["normal", 68],
        ["hard", 32],
      ]),
      flag("retry", 0.31),
    ],
  },
  {
    name: KnownEvent.LevelComplete,
    count: 27_930,
    players: 6740,
    seenAfter: 0,
    // The design's +74% and +69%.
    trend: [0.9655, 0.9823],
    properties: [
      level([7330, 5960, 4880, 3010, 2450, 1890, 1480, 930], 3, 6),
      number(
        "time_s",
        [
          ["0–29", 9],
          ["30–59", 27],
          ["60–119", 36],
          ["120–239", 21],
          ["240+", 7],
        ],
        facts(9, 1840, 74, 212),
      ),
      number(
        "deaths",
        [
          ["0", 22],
          ["1", 19],
          ["2", 17],
          ["3", 12],
          ["4", 8],
          ["5–9", 15],
          ["10+", 7],
        ],
        facts(0, 31, 2, 7),
      ),
      number(
        "lantern_count",
        [
          ["0–4", 12],
          ["5–9", 28],
          ["10–14", 33],
          ["15–19", 19],
          ["20–24", 8],
        ],
        facts(0, 24, 11, 19),
      ),
      text("difficulty", [
        ["normal", 71],
        ["hard", 29],
      ]),
    ],
  },
  {
    name: OwnEvent.PowerupUsed,
    count: 22_310,
    players: 3940,
    seenAfter: 12,
    properties: [
      text("powerup", [
        ["dash", 38],
        ["shield", 27],
        ["flare", 21],
        ["magnet", 14],
      ]),
      level([2210, 2680, 3120, 4460, 3390, 2850, 2180, 1420], 4, 7),
    ],
  },
  {
    name: KnownEvent.LevelFail,
    count: 18_470,
    players: 4880,
    seenAfter: 0,
    properties: [
      // The fourth level is where players get stuck, as the Overview's insight says.
      level([1420, 1980, 2610, 5230, 2890, 2010, 1490, 840], 4, 7),
      text("reason", [
        ["fell", 44],
        ["dark", 31],
        ["caught", 19],
        ["timeout", 6],
      ]),
      number(
        "time_s",
        [
          ["0–29", 41],
          ["30–59", 26],
          ["60–119", 20],
          ["120–239", 10],
          ["240+", 3],
        ],
        facts(2, 611, 38, 141),
      ),
    ],
  },
  {
    name: OwnEvent.ShopOpen,
    count: 6820,
    players: 2460,
    seenAfter: 6,
    properties: [
      text("from", [
        ["menu", 58],
        ["level_end", 33],
        ["death", 9],
      ]),
      number(
        "lanterns",
        [
          ["0–49", 31],
          ["50–199", 34],
          ["200–499", 22],
          ["500+", 13],
        ],
        facts(0, 4310, 120, 640),
      ),
    ],
  },
  {
    name: OwnEvent.SkinEquipped,
    count: 2140,
    players: 1120,
    seenAfter: 19,
    properties: [
      text("skin", [
        ["ember", 34],
        ["frost", 22],
        ["moss", 18],
        ["void", 14],
        ["classic", 12],
      ]),
      flag("paid", 0.41),
    ],
  },
  {
    name: KnownEvent.TutorialComplete,
    count: 1930,
    players: 1930,
    seenAfter: 0,
    properties: [
      number(
        "time_s",
        [
          ["0–59", 18],
          ["60–119", 47],
          ["120–239", 28],
          ["240+", 7],
        ],
        facts(21, 902, 96, 214),
      ),
      flag("hints_skipped", 0.27),
    ],
  },
];

/** `base` with each weight moved a little by the game's own noise, so no two games split alike. */
const varied = (seed: number, index: number, base: Weighted): Weighted =>
  base.map(([value, weight], at) => [value, weight * (0.8 + noise(seed, index + at) * 0.4)] as const);

/** One of the game's own events over the sample's period: as often as its plays say. */
function ownEvent(sample: GameSample, spec: OwnSpec, index: number): MadeEvent {
  const { plays, players, seed } = sample;
  const trend = (at: number): number => 0.93 + noise(seed, NOISE.trend + at) * 0.1;
  const [countTrend, playersTrend] = spec.trend ?? [trend(index), trend(index + OWN_EVENTS.length)];
  const now = Math.round((plays.now * spec.count) / DESIGN.plays);
  const before = Math.round(((plays.before * spec.count) / DESIGN.plays) * countTrend);
  const reach = spec.players / DESIGN.players;
  const published = sample.game.publishedOn;
  return {
    name: spec.name,
    automatic: false,
    firstSeenOn: published === null ? null : dayBefore(published, -spec.seenAfter),
    count: { now, before },
    players: {
      now: Math.min(now, Math.round(players.now * reach)),
      before: Math.min(before, Math.round(players.before * reach * playersTrend)),
    },
    daily: spread(
      now,
      plays.daily.map((count, day) => count * (0.96 + noise(seed + NOISE.wobble + index, day) * 0.08)),
    ),
    properties: spec.properties,
  };
}

/** The game's own events: the design's for the rich game, none for the others. */
const ownEvents = (sample: GameSample): MadeEvent[] =>
  sample.kind === SampleKind.Rich ? OWN_EVENTS.map((spec, index) => ownEvent(sample, spec, index)) : [];

/** One of the events Genex counts, since the day the game was published. */
const counted = (
  sample: GameSample,
  name: AutoEvent,
  numbers: Pick<MadeEvent, "count" | "players" | "daily">,
  properties: readonly MadeProperty[] = [],
): MadeEvent => ({ name, automatic: true, firstSeenOn: sample.game.publishedOn, ...numbers, properties });

/** Where and on what a play starts; only a game with an app build is played installed. */
function startProperties(sample: GameSample): MadeProperty[] {
  const places: Weighted = [
    [PlayPlace.Browser, 78],
    [PlayPlace.GenexApp, 13],
    ...(sample.game.hasAppBuild ? ([[PlayPlace.Installed, 9]] as const) : []),
  ];
  const devices: Weighted = [
    [DeviceClass.Computer, 64],
    [DeviceClass.Phone, 31],
    [DeviceClass.Tablet, 5],
  ];
  return [
    text("place", varied(sample.seed, NOISE.place, places)),
    text("device", varied(sample.seed, NOISE.device, devices)),
  ];
}

/** How long a game takes to get ready, in seconds. */
function loadProperty({ seed }: GameSample): MadeProperty {
  const buckets: Weighted = [
    ["0–1", 14],
    ["1–3", 41],
    ["3–6", 30],
    ["6+", 15],
  ];
  const arrived = facts(
    0.4,
    round1(30 + noise(seed, NOISE.load + 4) * 30),
    round1(2.4 + noise(seed, NOISE.load + 5) * 1.2),
    round1(6 + noise(seed, NOISE.load + 6) * 3),
  );
  return number("load_s", varied(seed, NOISE.load, buckets), arrived);
}

/** How long a play lasts, in seconds: its median is the sample's. */
function secondsProperty(sample: GameSample): MadeProperty {
  const median = sample.medianPlaySeconds.now ?? 0;
  const buckets: Weighted = [
    ["0–9", 9],
    ["10–59", 17],
    ["60–179", 22],
    ["180–599", 31],
    ["600–1799", 16],
    ["1800+", 5],
  ];
  const arrived = facts(Math.min(median, 3), Math.round(median * 21), median, Math.round(median * 4.1));
  return number("seconds", varied(sample.seed, NOISE.seconds, buckets), arrived);
}

/** A play from its start to its end: a start and a ready game for each play, an end for each one that is over. */
function playEvents(sample: GameSample): MadeEvent[] {
  const { plays, players } = sample;
  const everyone = { now: players.now, before: players.before };
  const started = { count: { now: plays.now, before: plays.before }, players: everyone, daily: plays.daily };
  const today = plays.daily.length - 1;
  const open = Math.min(sample.game.playingNow, plays.daily[today] ?? 0);
  const ended = {
    count: { now: plays.now - open, before: plays.before },
    players: everyone,
    daily: plays.daily.map((count, day) => (day === today ? count - open : count)),
  };
  return [
    counted(sample, AutoEvent.PlayStart, started, startProperties(sample)),
    counted(sample, AutoEvent.GameReady, started, [loadProperty(sample)]),
    counted(sample, AutoEvent.PlayEnd, ended, [secondsProperty(sample)]),
  ];
}

/** What a purchase costs, in Nex: about what the sample's Nex comes to for each one. */
function nexProperty({ seed, nex, purchases }: GameSample): MadeProperty {
  const median = purchases.now > 0 ? Math.round(nex.now / purchases.now) : 0;
  const buckets: Weighted = [
    ["1–49", 46],
    ["50–99", 33],
    ["100–249", 16],
    ["250+", 5],
  ];
  const arrived = facts(Math.round(median * 0.35), Math.round(median * 5.2), median, Math.round(median * 2.6));
  return number("nex", varied(seed, NOISE.nex, buckets), arrived);
}

/** Purchases (the sample's, from who paid) and shares (a few of everyone). */
function moneyAndShares(sample: GameSample): MadeEvent[] {
  const { purchases, payers, nex, players, seed } = sample;
  const rate = SHARED_BY + noise(seed, NOISE.via + 8) * 0.06;
  const each = 0.62 + noise(seed, NOISE.via + 9) * 0.1;
  const shares = { now: Math.round(players.now * rate), before: Math.round(players.before * rate) };
  const via: Weighted = [
    ["link", 61],
    ["discord", 24],
    ["x", 15],
  ];
  return [
    counted(
      sample,
      AutoEvent.Purchase,
      { count: purchases, players: payers, daily: spread(purchases.now, nex.daily) },
      [nexProperty(sample)],
    ),
    counted(
      sample,
      AutoEvent.Share,
      {
        count: shares,
        players: { now: Math.round(shares.now * each), before: Math.round(shares.before * each) },
        daily: spread(shares.now, players.daily),
      },
      [text("via", varied(seed, NOISE.via, via))],
    ),
  ];
}

/** Installs (the sample's) and first launches (most of them); none for a game with no app build. */
function installEvents(sample: GameSample): MadeEvent[] {
  const { installs } = sample;
  if (!installs) return [];
  const installed = { now: installs.now, before: installs.before };
  const opened = { now: Math.round(installs.now * OPENED_SHARE), before: Math.round(installs.before * OPENED_SHARE) };
  return [
    counted(sample, AutoEvent.Install, { count: installed, players: installed, daily: installs.daily }),
    counted(sample, AutoEvent.FirstOpen, {
      count: opened,
      players: opened,
      daily: spread(opened.now, installs.daily),
    }),
  ];
}

/** The events of a list as it is shown: the ones that came in the period, most counted first. */
const listed = (events: readonly MadeEvent[]): MadeEvent[] =>
  events.filter((event) => event.count.now > 0).sort((a, b) => b.count.now - a.count.now);

const rowOf = ({ name, count, players, firstSeenOn }: MadeEvent): EventRow => ({
  name,
  count: count.now,
  players: players.now,
  firstSeenOn,
});

/** What arrived in a property: a number's range, a text's values by share, how often a flag was true. */
function factsOf(property: MadeProperty): PropertyFacts {
  if (property.kind === PropertyKind.Number) return { kind: PropertyKind.Number, ...property.facts };
  if (property.kind === PropertyKind.Flag) return { kind: PropertyKind.Flag, yes: property.yes };
  const whole = sum(property.values.map(([, weight]) => weight));
  const top = property.values
    .map(([value, weight]) => ({ value, share: round3(weight / whole) }))
    .sort((a, b) => b.share - a.share);
  return { kind: PropertyKind.Text, top };
}

/** An event's count shared out over one property's values, most first, with the players behind each. */
function splitOf(event: MadeEvent, property: MadeProperty): EventDetail["split"] {
  const values: Weighted =
    property.kind === PropertyKind.Flag
      ? [
          ["true", property.yes],
          ["false", 1 - property.yes],
        ]
      : property.values;
  const counts = spread(
    event.count.now,
    values.map(([, weight]) => weight),
  );
  const most = Math.max(1, ...counts);
  const playersOf = (count: number): number =>
    Math.min(count, Math.round(event.players.now * (count / most) ** SPLIT_PLAYERS_CURVE));
  return values
    .map(([value], index) => ({ value, count: counts[index] ?? 0 }))
    .filter((row) => row.count > 0)
    .sort((a, b) => b.count - a.count)
    .map((row) => ({ ...row, players: playersOf(row.count) }));
}

/** One event in full, split by the property asked for, or by its first when that is not one of its own. */
function detailOf(sample: GameSample, event: MadeEvent, splitBy: string | undefined): EventDetail {
  const property = event.properties.find((one) => one.name === splitBy) ?? event.properties[0];
  return {
    name: event.name,
    automatic: event.automatic,
    firstSeenOn: event.firstSeenOn,
    count: event.count,
    players: event.players,
    everyone: sample.players.now,
    daily: event.daily,
    splitBy: property?.name ?? null,
    split: property ? splitOf(event, property) : [],
    properties: event.properties.map((one) => ({ name: one.name, facts: factsOf(one) })),
  };
}

/** The design's funnel, from a first level to a first purchase: each step's players are its event's, never more than the step before. */
function firstPurchase(sample: GameSample, own: readonly MadeEvent[]): EventFunnel {
  const playersOf = (name: string): number => own.find((event) => event.name === name)?.players.now ?? 0;
  const steps = [
    { event: KnownEvent.LevelStart, property: null, value: null, players: playersOf(KnownEvent.LevelStart) },
    { event: KnownEvent.LevelComplete, property: "level", value: "1", players: playersOf(KnownEvent.LevelComplete) },
    { event: OwnEvent.ShopOpen, property: null, value: null, players: playersOf(OwnEvent.ShopOpen) },
    { event: AutoEvent.Purchase, property: null, value: null, players: sample.payers.now },
  ];
  let reached = Number.POSITIVE_INFINITY;
  const narrowing = steps.map((step) => {
    reached = Math.min(reached, step.players);
    return { ...step, players: reached };
  });
  return {
    id: FIRST_PURCHASE_ID,
    name: "First purchase",
    withinDays: 7,
    steps: narrowing,
    typicalDay: reached > 0 ? 2 : null,
  };
}

/** When the game's last own event came: a moment ago while people play, the last busy day's evening once they stopped. */
function lastAtOf(sample: GameSample, custom: readonly MadeEvent[]): string | null {
  const busy = sample.plays.daily.findLastIndex((plays) => plays > 0);
  const day = sample.dates[busy];
  if (custom.length === 0 || day === undefined) return null;
  if (busy < sample.dates.length - 1) return `${day}T${LAST_EVENT_TIME}`;
  return new Date(Date.parse(sample.window.computedAt) + LAST_EVENT_AFTER_COMPUTED_MS).toISOString();
}

/**
 * The Events report's data for `sample`. It takes `event` (the one to detail: any listed one, else
 * the first of the game's own) and `splitBy` (one of that event's properties, else its first); the
 * launch's saved funnels are added to its `funnels` by `index.ts`.
 */
export function fixtureEvents(sample: GameSample, options: GameReportOptions): EventsReport {
  const own = ownEvents(sample);
  const custom = listed(own);
  const automatic = listed([...playEvents(sample), ...moneyAndShares(sample), ...installEvents(sample)]);
  const event = [...custom, ...automatic].find((one) => one.name === options.event) ?? custom[0];
  return {
    lastAt: lastAtOf(sample, custom),
    total: sum(custom.map((one) => one.count.now)),
    custom: custom.map(rowOf),
    automatic: automatic.map(rowOf),
    detail: event ? detailOf(sample, event, options.splitBy) : null,
    funnels: own.length > 0 ? [firstPurchase(sample, own)] : [],
  };
}
