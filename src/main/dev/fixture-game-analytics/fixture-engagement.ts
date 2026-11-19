/**
 * A fixture game's Engagement report as genex.games answers it: how much and how well people play.
 * Made from the game's sample (`sample.ts`) so it agrees with every other report of the game: plays
 * and the median play are the sample's; the lengths, the hours and the devices each sum to its
 * plays (the hours weekday by weekday, as its days do); a week's and a month's players are counted
 * the way the sample counts a period's; the slow device is the one its insight names. The rich
 * game's own details are the numbers the page was designed with, a steady game moves them by
 * `noise`, and the young game has nothing before it was published, no levels and nobody on a tablet.
 */
import { DAY_MS } from "../../../shared/duration.ts";
import {
  type Compared,
  DeviceClass,
  type EngagementReport,
  type GameReportOptions,
  type Insight,
  InsightKind,
  type LevelRow,
  PlayLength,
  QUICK_EXIT_SECONDS,
  type RunNumbers,
} from "../../../shared/game-analytics.ts";
import { type GameSample, noise, SampleKind, spread } from "./sample.ts";

const WEEK_DAYS = 7;
const DAY_HOURS = 24;
const MONTH_DAYS = 30;

/** The design's median play, in seconds. Every game's plays are the design's, stretched to its own median. */
const DESIGN_MEDIAN_SECONDS = 340;
/**
 * The share of the design's plays that end within a length, in seconds: its histogram's bounds, its
 * median and its 90th percentile, from the shortest play to the longest.
 */
const DESIGN_LENGTHS: readonly (readonly [seconds: number, share: number])[] = [
  [1, 0],
  [QUICK_EXIT_SECONDS, 0.098],
  [60, 0.244],
  [180, 0.423],
  [DESIGN_MEDIAN_SECONDS, 0.5],
  [600, 0.686],
  [1800, 0.897],
  [1860, 0.9],
  [14_400, 1],
];
/** Where each length but the last ends, in seconds, in `PlayLength` order. */
const LENGTH_BOUNDS = [QUICK_EXIT_SECONDS, 60, 180, 600, 1800] as const;
const DESIGN_P90_SECONDS = 1860;
/** The design's 4,462 hours over its 30,889 plays: how much longer the average play is than the median one. */
const MEAN_OVER_MEDIAN = (4462 * 3600) / (30_889 * DESIGN_MEDIAN_SECONDS);
/** genex.games tells a 90th percentile, of a play's length or of its load, from this many plays up. */
const P90_MIN_PLAYS = 100;

/** Different players of a week and of a month for each player-day in it, as the sample counts a period's. */
const WEEK_DISTINCT = 0.62;
const MONTH_DISTINCT = 9300 / 22_382;

/** The design's week, Monday first: how busy each hour of a day is against the busiest (UTC). */
const DESIGN_HOUR_CURVE = [
  0.42, 0.36, 0.3, 0.25, 0.22, 0.2, 0.2, 0.22, 0.26, 0.3, 0.34, 0.4, 0.46, 0.52, 0.6, 0.68, 0.76, 0.84, 0.92, 0.98, 1,
  0.94, 0.78, 0.58,
] as const;
/** How far a quiet hour strays from the curve. */
const HOUR_WOBBLE = 0.12;
/** In their own time players start an hour later than the design's UTC evening, and bunch up more. */
const PLAYERS_EVENING_SHIFT = 1;
const PLAYERS_EVENING_SHARPNESS = 1.5;

/** The design's levels: the share of those who started the first that finished each, and what passing takes. */
const DESIGN_LEVELS = [
  { level: "1", finished: 0.91, tries: 1, seconds: 48 },
  { level: "2", finished: 0.74, tries: 1, seconds: 74 },
  { level: "3", finished: 0.61, tries: 1, seconds: 92 },
  { level: "4", finished: 0.38, tries: 4, seconds: 221 },
  { level: "5", finished: 0.31, tries: 2, seconds: 125 },
  { level: "6", finished: 0.24, tries: 2, seconds: 140 },
  { level: "7", finished: 0.19, tries: 3, seconds: 168 },
  { level: "8", finished: 0.12, tries: 3, seconds: 190 },
] as const;
/** The share of the design's players who start the first level. */
const LEVEL_STARTERS = 7410 / 9300;

/** The design's most players at once against its busiest day's players. */
const DESIGN_PEAK = 212 / 1510;
/** The design's players by the days of a week they play on: one day first. */
const DESIGN_DAYS_A_WEEK = [58, 19, 10, 5, 3, 2, 3] as const;
/** A game three days old: nearly everyone has played on one day. */
const YOUNG_DAYS_A_WEEK = [85, 13, 2, 0, 0, 0, 0] as const;

/** How a kind of device runs the game. */
interface DeviceTraits {
  device: DeviceClass;
  /** Its share of the plays. */
  share: number;
  loadSeconds: number;
  loaded: number;
  smooth: number;
  fps: number;
  clean: number;
}

/** The design's devices: phones load about twice as slowly as computers, and lose more plays to it. */
const DESIGN_DEVICES: readonly DeviceTraits[] = [
  { device: DeviceClass.Computer, share: 0.58, loadSeconds: 2.9, loaded: 0.951, smooth: 0.975, fps: 60, clean: 0.993 },
  { device: DeviceClass.Phone, share: 0.37, loadSeconds: 6.1, loaded: 0.86, smooth: 0.868, fps: 47, clean: 0.982 },
  { device: DeviceClass.Tablet, share: 0.05, loadSeconds: 4.4, loaded: 0.92, smooth: 0.93, fps: 55, clean: 0.989 },
];
const DESIGN_COMPUTER_LOAD_SECONDS = 2.9;
/** The young game's few plays: nobody on a tablet yet. */
const YOUNG_DEVICE_SHARES = [0.6, 0.4, 0] as const;
/** The median load of all plays sits a little under its devices' medians weighed by plays, as the design's 3.8 s does. */
const OVERALL_LOAD = 0.914;
/** The 90th percentile load against the median one: the design's 11.2 s over 3.8 s. */
const P90_LOAD_OVER_MEDIAN = 2.95;

/** How the period before ran against this one: load time as a ratio, the shares in points. */
interface Drift {
  load: number;
  loaded: number;
  smooth: number;
  clean: number;
}
/** The design's change: 0.7 s slower since its version, 1.1 points fewer loaded, a little smoother and cleaner. */
const DESIGN_DRIFT: Drift = { load: 3.1 / 3.8, loaded: 0.011, smooth: -0.005, clean: -0.002 };
const NO_DRIFT: Drift = { load: 1, loaded: 0, smooth: 0, clean: 0 };

/** Where a report's own details start in a game's noise, clear of the sample's. */
const NOISE = { tail: 500, peak: 501, hourShift: 502, drift: 510, days: 520, devices: 530, levels: 540 } as const;

/** What a kind of game is like to play, beyond what its sample holds. */
interface Traits {
  /** How much longer the long plays ran over the period before, against the median. */
  tailBefore: number;
  /** The most playing at once, as a share of the busiest day's players. */
  peak: number;
  daysAWeek: readonly number[];
  /** Hours after the design's that the game's evening comes, in UTC: where its players live. */
  hourShift: number;
  devices: readonly DeviceTraits[];
  drift: Drift;
  /** Whether genex.games can place its plays in the players' own time, and whether it sends level events. */
  playersHours: boolean;
  levels: boolean;
}

const NOTHING_RAN: RunNumbers = {
  started: 0,
  loadSeconds: null,
  loadSecondsP90: null,
  loaded: null,
  smooth: null,
  fps: null,
  clean: null,
};

const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);
const rounded = (value: number, digits: number): number => Math.round(value * 10 ** digits) / 10 ** digits;
const share = (value: number): number => Math.min(1, Math.max(0, value));
/** `part` for each of `whole`, or null with nothing to divide by. */
const per = (part: number, whole: number, digits: number): number | null =>
  whole > 0 ? rounded(part / whole, digits) : null;

/** The share of the design's plays that end within `seconds`: between two known points, even steps of a ratio. */
function shareWithin(seconds: number): number {
  let from = 0;
  let below = 0;
  for (const [to, within] of DESIGN_LENGTHS) {
    if (seconds <= to) {
      return from > 0 ? below + ((within - below) * Math.log(seconds / from)) / Math.log(to / from) : 0;
    }
    from = to;
    below = within;
  }
  return 1;
}

/** The design's seconds for a game whose median play is `median`. */
const stretched = (seconds: number, median: number): number => (seconds * DESIGN_MEDIAN_SECONDS) / median;

/** Plays by length, shortest first: the design's shape stretched to the game's median, summing to `plays`. */
function lengthsOf(plays: number, median: number | null): EngagementReport["lengths"] {
  const within = [...LENGTH_BOUNDS.map((bound) => shareWithin(median ? stretched(bound, median) : bound)), 1];
  const shares = within.map((reached, index) => reached - (within[index - 1] ?? 0));
  const counts = spread(plays, shares);
  return Object.values(PlayLength).map((length, index) => ({ length, plays: counts[index] ?? 0 }));
}

/** The seconds everyone played: `tail` stretches the long plays against the median. */
const secondsPlayed = (plays: number, median: number | null, tail: number): number =>
  Math.round(plays * (median ?? 0) * MEAN_OVER_MEDIAN * tail);

/** A UTC day's place in the week, Monday first. */
const weekdayOf = (day: string): number => (new Date(`${day}T00:00:00.000Z`).getUTCDay() + 6) % WEEK_DAYS;

/** The period's plays by weekday, Monday first, from the sample's days. */
function playsByWeekday(sample: GameSample): number[] {
  const totals = Array.from({ length: WEEK_DAYS }, () => 0);
  sample.dates.forEach((day, index) => {
    const at = weekdayOf(day);
    totals[at] = (totals[at] ?? 0) + (sample.plays.daily[index] ?? 0);
  });
  return totals;
}

/** A week of hours from Monday 00:00: each weekday's plays shared over its hours by `busy`. */
function hoursOf(byWeekday: readonly number[], busy: (day: number, hour: number) => number): number[] {
  return byWeekday.flatMap((plays, day) =>
    spread(
      plays,
      Array.from({ length: DAY_HOURS }, (_, hour) => busy(day, hour)),
    ),
  );
}

/** How busy the design's hour is, `shift` hours later. */
const curveAt = (hour: number, shift: number): number =>
  DESIGN_HOUR_CURVE[(((hour - shift) % DAY_HOURS) + DAY_HOURS) % DAY_HOURS] ?? 0;

/** The design's week in UTC. An hour wobbles more the quieter it is, so the evening's busiest hour stays the busiest. */
const utcHours =
  (shift: number) =>
  (day: number, hour: number): number => {
    const busy = curveAt(hour, shift);
    return busy * (1 + Math.sin(day * 2.3 + hour * 1.9) * HOUR_WOBBLE * (1 - busy));
  };

/** The same week by each player's own clock: a sharper evening, wherever they live. */
const playersHours = (_day: number, hour: number): number =>
  curveAt(hour, PLAYERS_EVENING_SHIFT) ** PLAYERS_EVENING_SHARPNESS;

/** The most people in the game at once on a day with `players`. */
const atOnce = (players: number, ofDay: number): number => (players > 0 ? Math.max(1, Math.round(players * ofDay)) : 0);

/** The most at once now and before, and the hour it happened: the busiest hour of the busiest day. */
function peakOf(
  sample: GameSample,
  hours: readonly number[],
  ofDay: number,
): Pick<EngagementReport, "peak" | "peakAt"> {
  const { daily, dailyBefore } = sample.players;
  const busiest = Math.max(0, ...daily);
  const before = atOnce(Math.max(0, ...dailyBefore), ofDay);
  const day = sample.dates[daily.indexOf(busiest)];
  if (busiest === 0 || day === undefined) return { peak: { now: 0, before }, peakAt: null };
  const from = weekdayOf(day) * DAY_HOURS;
  const row = hours.slice(from, from + DAY_HOURS);
  const hour = row.indexOf(Math.max(...row));
  return {
    peak: { now: Math.min(busiest, Math.max(sample.game.playingNow, atOnce(busiest, ofDay))), before },
    peakAt: `${day}T${String(hour).padStart(2, "0")}:00:00.000Z`,
  };
}

/** Different players over some days, as the sample counts them: never fewer than the new ones. */
const distinct = (playerDays: number, fresh: number, ofPlayerDays: number): number =>
  Math.max(fresh, Math.round(playerDays * ofPlayerDays));

/** Everyone who played in the last seven days: the week's report's players. */
function weekPlayers({ window, players, newPlayers }: GameSample): number {
  if (window.days === WEEK_DAYS) return players.now;
  return distinct(sum(players.daily.slice(-WEEK_DAYS)), sum(newPlayers.daily.slice(-WEEK_DAYS)), WEEK_DISTINCT);
}

/**
 * Everyone who played in the last 30 days, and in the 30 before: the month's report's players. A
 * week's sample holds no month, so there it is told from the two weeks it does hold.
 */
function monthlyPlayersOf({ window, players, newPlayers }: GameSample): Compared {
  if (window.days === MONTH_DAYS) return { now: players.now, before: players.before };
  if (window.days > MONTH_DAYS) {
    const month = (from: number, to?: number): number =>
      distinct(sum(players.daily.slice(from, to)), sum(newPlayers.daily.slice(from, to)), MONTH_DISTINCT);
    return { now: month(-MONTH_DAYS), before: month(-2 * MONTH_DAYS, -MONTH_DAYS) };
  }
  const told = (days: readonly number[]): number =>
    days.length > 0 ? Math.round((sum(days) / days.length) * MONTH_DAYS * MONTH_DISTINCT) : 0;
  return {
    now: Math.max(players.now, told([...players.dailyBefore, ...players.daily])),
    before: Math.max(players.before, told(players.dailyBefore)),
  };
}

/** A week's players by the days they played on; a game younger than a week has had fewer days to play on. */
function daysAWeekOf(sample: GameSample, weights: readonly number[]): number[] {
  const published = sample.game.publishedOn ? Date.parse(sample.game.publishedOn) : Number.NEGATIVE_INFINITY;
  const reach = Math.floor((Date.parse(sample.window.endsOn) - published) / DAY_MS) + 1;
  return spread(
    weekPlayers(sample),
    weights.map((weight, index) => (index < reach ? weight : 0)),
  );
}

/** The design's levels for the period's players: each started by nearly everyone who finished the one before. */
function levelsOf(sample: GameSample): LevelRow[] {
  const first = Math.round(sample.players.now * LEVEL_STARTERS);
  if (first === 0) return [];
  const rows: LevelRow[] = [];
  for (const [index, design] of DESIGN_LEVELS.entries()) {
    const finished = Math.round(first * design.finished);
    const reached = rows.at(-1)?.finished ?? first;
    const went = 0.97 + noise(sample.seed, NOISE.levels + index) * 0.03;
    const started = index === 0 ? first : Math.max(finished, Math.round(reached * went));
    const passed = finished > 0;
    rows.push({
      level: design.level,
      started,
      finished,
      tries: passed ? design.tries : null,
      seconds: passed ? design.seconds : null,
    });
  }
  return rows;
}

/** The slow device the sample's insights name, when one does. */
const isSlowDevice = (insight: Insight): insight is Extract<Insight, { kind: typeof InsightKind.DeviceLoad }> =>
  insight.kind === InsightKind.DeviceLoad;

/** The game's devices: the design's, with the slow one and the others' load time as the sample's insight says. */
function devicesOf(sample: GameSample): DeviceTraits[] {
  const slow = sample.insights.find(isSlowDevice);
  const others = slow ? slow.loadSecondsOthers / DESIGN_COMPUTER_LOAD_SECONDS : 1;
  return DESIGN_DEVICES.map((design, index) => {
    const named = slow?.device === design.device ? slow : undefined;
    const moved = sample.kind === SampleKind.Rich ? 1 : 0.8 + noise(sample.seed, NOISE.devices + index) * 0.4;
    return {
      ...design,
      share: sample.kind === SampleKind.Young ? (YOUNG_DEVICE_SHARES[index] ?? 0) : design.share * moved,
      loadSeconds: named ? named.loadSeconds : rounded(design.loadSeconds * others, 1),
      loaded: named ? 1 - named.leftLoading : design.loaded,
    };
  });
}

/** What the game is like to play: the design itself for the rich game, moved by the slug for a steady one. */
function traitsOf(sample: GameSample): Traits {
  const { kind, seed } = sample;
  const devices = devicesOf(sample);
  if (kind === SampleKind.Rich) {
    return {
      tailBefore: 1.05,
      peak: DESIGN_PEAK,
      daysAWeek: DESIGN_DAYS_A_WEEK,
      hourShift: 0,
      devices,
      drift: DESIGN_DRIFT,
      playersHours: true,
      levels: true,
    };
  }
  const young = kind === SampleKind.Young;
  /** A number near zero, `width` wide, steady for the slug. */
  const around = (index: number, width: number): number => (noise(seed, index) - 0.5) * width;
  return {
    tailBefore: 1 + around(NOISE.tail, 0.1),
    peak: DESIGN_PEAK * (1 + around(NOISE.peak, 0.4)),
    daysAWeek: young
      ? YOUNG_DAYS_A_WEEK
      : DESIGN_DAYS_A_WEEK.map((weight, index) => weight * (1 + around(NOISE.days + index, 0.3))),
    hourShift: Math.floor(noise(seed, NOISE.hourShift) * DAY_HOURS),
    devices,
    drift: young
      ? NO_DRIFT
      : {
          load: 1 + around(NOISE.drift, 0.1),
          loaded: around(NOISE.drift + 1, 0.012),
          smooth: around(NOISE.drift + 2, 0.008),
          clean: around(NOISE.drift + 3, 0.004),
        },
    playersHours: !young,
    levels: false,
  };
}

/** The devices as they ran over the period before. */
const before = (devices: readonly DeviceTraits[], drift: Drift): DeviceTraits[] =>
  devices.map((device) => ({
    ...device,
    loadSeconds: rounded(device.loadSeconds * drift.load, 2),
    loaded: share(device.loaded + drift.loaded),
    smooth: share(device.smooth + drift.smooth),
    clean: share(device.clean + drift.clean),
  }));

/** A device's plays and how they ran. */
interface DeviceRun {
  device: DeviceClass;
  plays: number;
  run: RunNumbers;
}

/** `plays` shared over the devices, each with the plays that were started for them to load. */
function runsOf(plays: number, devices: readonly DeviceTraits[]): DeviceRun[] {
  const shared = spread(
    plays,
    devices.map((device) => device.share),
  );
  return devices.map((device, index) => {
    const loaded = shared[index] ?? 0;
    if (loaded === 0) return { device: device.device, plays: 0, run: NOTHING_RAN };
    const started = Math.max(loaded, Math.round(loaded / device.loaded));
    const run: RunNumbers = {
      started,
      loadSeconds: device.loadSeconds,
      loadSecondsP90: started >= P90_MIN_PLAYS ? rounded(device.loadSeconds * P90_LOAD_OVER_MEDIAN, 1) : null,
      // Not rounded: the plays that loaded are exactly the device's plays.
      loaded: loaded / started,
      smooth: device.smooth,
      fps: device.fps,
      clean: device.clean,
    };
    return { device: device.device, plays: loaded, run };
  });
}

/** How every play ran, from how each device's did. */
function overallRun(runs: readonly DeviceRun[]): RunNumbers {
  const plays = sum(runs.map((one) => one.plays));
  if (plays === 0) return NOTHING_RAN;
  const started = sum(runs.map((one) => one.run.started));
  const mean = (pick: (run: RunNumbers) => number | null): number =>
    sum(runs.map((one) => one.plays * (pick(one.run) ?? 0))) / plays;
  const loadSeconds = rounded(mean((run) => run.loadSeconds) * OVERALL_LOAD, 1);
  return {
    started,
    loadSeconds,
    loadSecondsP90: started >= P90_MIN_PLAYS ? rounded(loadSeconds * P90_LOAD_OVER_MEDIAN, 1) : null,
    loaded: plays / started,
    smooth: rounded(
      mean((run) => run.smooth),
      3,
    ),
    fps: Math.round(mean((run) => run.fps)),
    clean: rounded(
      mean((run) => run.clean),
      3,
    ),
  };
}

/** How long plays last: the 90th percentile and the quick exits that go with the sample's median. */
function lengthNumbers(sample: GameSample, lengths: EngagementReport["lengths"]) {
  const { plays, medianPlaySeconds: median } = sample;
  const told = plays.now >= P90_MIN_PLAYS && median.now !== null;
  const quickBefore =
    plays.before > 0 && median.before ? shareWithin(stretched(QUICK_EXIT_SECONDS, median.before)) : null;
  return {
    medianPlaySeconds: { now: median.now, before: median.before },
    p90PlaySeconds: told ? Math.round(((median.now ?? 0) * DESIGN_P90_SECONDS) / DESIGN_MEDIAN_SECONDS) : null,
    quickExits: {
      now: per(lengths[0]?.plays ?? 0, plays.now, 4),
      before: quickBefore === null ? null : rounded(quickBefore, 4),
    },
  };
}

/** How much everyone played, in all and for each player on the days they played. */
function playNumbers(sample: GameSample, tailBefore: number) {
  const { plays, players, medianPlaySeconds: median } = sample;
  const playerDays = { now: sum(players.daily), before: sum(players.dailyBefore) };
  const playSeconds = {
    now: secondsPlayed(plays.now, median.now, 1),
    before: secondsPlayed(plays.before, median.before, tailBefore),
  };
  return {
    plays: { now: plays.now, before: plays.before },
    playsPerPlayerDay: { now: per(plays.now, playerDays.now, 3), before: per(plays.before, playerDays.before, 3) },
    playSeconds,
    playSecondsPerPlayerDay: {
      now: per(playSeconds.now, playerDays.now, 1),
      before: per(playSeconds.before, playerDays.before, 1),
    },
    dailyPlayers: {
      now: rounded(playerDays.now / sample.window.days, 1),
      before: rounded(playerDays.before / sample.window.days, 1),
    },
  };
}

/** The Engagement report's data for `sample`; it takes no options. */
export function fixtureEngagement(sample: GameSample, _options: GameReportOptions): EngagementReport {
  const traits = traitsOf(sample);
  const { plays } = sample;
  const lengths = lengthsOf(plays.now, sample.medianPlaySeconds.now);
  const byWeekday = playsByWeekday(sample);
  const hours = hoursOf(byWeekday, utcHours(traits.hourShift));
  const runs = runsOf(plays.now, traits.devices);
  const changed = sample.kind === SampleKind.Rich && plays.now > 0 && plays.before > 0;
  return {
    ...playNumbers(sample, traits.tailBefore),
    ...lengthNumbers(sample, lengths),
    ...peakOf(sample, hours, traits.peak),
    monthlyPlayers: monthlyPlayersOf(sample),
    lengths,
    daysAWeek: daysAWeekOf(sample, traits.daysAWeek),
    hours,
    hoursLocal: traits.playersHours && plays.now > 0 ? hoursOf(byWeekday, playersHours) : null,
    levels: traits.levels ? levelsOf(sample) : null,
    run: overallRun(runs),
    runBefore: overallRun(runsOf(plays.before, before(traits.devices, traits.drift))),
    runSince: changed ? sample.release.version : null,
    devices: runs.map(({ device, run }) => ({ device, run })),
  };
}
