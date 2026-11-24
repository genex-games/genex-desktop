/**
 * A fixture game's Retention report as genex.games answers it: whether new players come back. Made
 * from the game's sample (`sample.ts`), the way `fixture-overview.ts` makes its own, so its numbers
 * agree with every other report of the game: the curve and the headline days are the sample's
 * retention, a cohort is a day's (or a week's) new players with the sample's own Day 1 and Day 7,
 * the groups share out the period's new players (by channel they are the sample's channels), and a
 * week's new players are the sample's days summed. What only this report shows (the days between,
 * the weeks after, how a group stands against everyone) moves a little with the game's seed.
 *
 * A return counted "that day or later" is never lower than one counted "on that day", and a day
 * that has not passed is null in both.
 */
import {
  type Cohort,
  CohortSize,
  DeviceClass,
  type GameReportOptions,
  type LifecycleWeek,
  PlayPlace,
  RETENTION_DAYS,
  RETENTION_SPAN,
  type RetentionCurve,
  RetentionMode,
  type RetentionPoint,
  type RetentionReport,
  SegmentBy,
  type SegmentRow,
  SourceChannel,
} from "../../../shared/game-analytics.ts";
import { dayBefore, type StatsPeriod } from "../../../shared/play-stats.ts";
import { type GameSample, noise, type SampleChannel, spread } from "./sample.ts";

const WEEK_DAYS = 7;
/** The headline days a group of new players is compared on. */
const SEGMENT_DAYS = [1, 7, 30] as const;
/** Day 7: the second day the sample knows each cohort's own retention on. */
const COHORT_WEEK_DAY = 7;
/** How many more come back on a day or any later one than on that very day. */
const LATER = { lift: 1.45, floor: 0.03 } as const;
/** How a number of this report's own moves by chance: within three percent either way. */
const CHANCE = { low: 0.97, span: 0.06 } as const;
/**
 * A week counts anyone who played on any of its days, so it keeps more players than one day does:
 * the day in the middle of the week, times this much, more for later weeks.
 */
const WEEK_GAIN = { base: 1.9, step: 0.2, steps: 6, middle: 3 } as const;
/** How fast retention goes on falling past the last day the curve knows. */
const TAIL_DECAY = 0.6;
/** How many whole weeks of players each period shows, when the sample knows that many. */
const WEEKS_SHOWN = { 7: 4, 30: 6, 90: 13 } as const satisfies Record<StatsPeriod, number>;
/** Different players of a week for each player-day in it, as the sample counts a week. */
const WEEK_DISTINCT = 0.62;
/** Of a week's returning players, the share who also played the week before; never more than this share of that week. */
const STAYED = { share: 0.82, chance: 0.08, most: 0.75 } as const;

/** How a group's retention stands against everyone's on days 1, 7 and 30. */
type Lift = readonly [day1: number, day7: number, day30: number];

/** A group of new players before its rates are worked out. */
interface Group {
  key: string;
  newPlayers: number;
  lift: Lift;
  /** Whole days the group has existed, when it began inside the period: a later day is not known. */
  ripeDays?: number;
}

/** Where the design's new players play, and how each place keeps them (its rates over everyone's). */
const PLACES = [
  { key: PlayPlace.Browser, share: 5720, lift: [0.314 / 0.345, 0.122 / 0.145, 0.041 / 0.053] },
  { key: PlayPlace.GenexApp, share: 1180, lift: [0.379 / 0.345, 0.166 / 0.145, 0.064 / 0.053] },
  { key: PlayPlace.Installed, share: 940, lift: [0.491 / 0.345, 0.261 / 0.145, 0.112 / 0.053] },
] as const satisfies readonly Shared[];

const DEVICES = [
  { key: DeviceClass.Computer, share: 0.52, lift: [1.1, 1.16, 1.2] },
  { key: DeviceClass.Phone, share: 0.39, lift: [0.88, 0.82, 0.78] },
  { key: DeviceClass.Tablet, share: 0.09, lift: [0.98, 0.97, 0.95] },
] as const satisfies readonly Shared[];

const COUNTRIES = [
  { key: "US", share: 0.28, lift: [1.04, 1.08, 1.1] },
  { key: "BR", share: 0.14, lift: [0.92, 0.86, 0.8] },
  { key: "DE", share: 0.11, lift: [1.08, 1.14, 1.2] },
  { key: "GB", share: 0.1, lift: [1.02, 1.04, 1.05] },
  { key: "JP", share: 0.09, lift: [1.12, 1.22, 1.3] },
  { key: "FR", share: 0.08, lift: [0.98, 0.97, 0.96] },
  { key: "IN", share: 0.07, lift: [0.84, 0.74, 0.66] },
  { key: "PL", share: 0.05, lift: [1.06, 1.1, 1.12] },
  { key: "MX", share: 0.04, lift: [0.9, 0.84, 0.8] },
  { key: "KR", share: 0.04, lift: [1.1, 1.18, 1.24] },
] as const satisfies readonly Shared[];

/** How the players each channel brings stay, against everyone. */
const CHANNEL_LIFT = {
  [SourceChannel.Genex]: [1.06, 1.1, 1.12],
  [SourceChannel.Campaigns]: [0.8, 0.68, 0.6],
  [SourceChannel.Social]: [0.93, 0.9, 0.88],
  [SourceChannel.Direct]: [1.14, 1.2, 1.25],
  [SourceChannel.Search]: [1.2, 1.3, 1.4],
  [SourceChannel.Other]: [0.85, 0.8, 0.75],
} as const satisfies Record<SourceChannel, Lift>;

/** How players who first met the newest version stay, and those who met the one before. */
const VERSION_LIFT = { newest: [1.05, 1.08, 1.1], earlier: [0.98, 0.97, 0.99] } as const satisfies Record<string, Lift>;

/** A group that takes a share of the new players. */
interface Shared {
  key: string;
  share: number;
  lift: Lift;
}

const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);
const round3 = (value: number): number => Math.round(Math.min(1, Math.max(0, value)) * 1000) / 1000;
/** `part / whole`, or null when either is not known or there is nobody to divide by. */
const ratio = (part: number | null | undefined, whole: number | null | undefined): number | null =>
  typeof part === "number" && typeof whole === "number" && whole > 0 ? part / whole : null;
/** A day's place in its week, Monday first. */
const weekdayOf = (day: string): number => (new Date(`${day}T00:00:00.000Z`).getUTCDay() + 6) % WEEK_DAYS;
/** A little chance for `index` under `seed`. */
const chance = (seed: number, index: number): number => CHANCE.low + noise(seed, index) * CHANCE.span;

/**
 * Rates counted "that day or later": each at least the day's own, and never rising from one day to
 * the next, since whoever plays on a later day also counts for every day before it.
 */
function orLater(rates: readonly (number | null)[]): (number | null)[] {
  let later = 0;
  return rates
    .toReversed()
    .map((rate) => {
      if (rate === null) return null;
      later = Math.max(later, round3(rate * LATER.lift + LATER.floor));
      return later;
    })
    .reverse();
}

/** Rates as `mode` counts a return; a null stays null. */
const inMode = (rates: readonly (number | null)[], mode: RetentionMode): (number | null)[] =>
  mode === RetentionMode.DayOrLater ? orLater(rates) : [...rates];

/** The sample's curve, as `mode` counts a return. */
function curveIn(sample: GameSample, mode: RetentionMode): RetentionCurve {
  const { rates, before, similar } = sample.retention;
  return { rates: inMode(rates, mode), before: inMode(before, mode), similar: similar && inMode(similar, mode) };
}

/** The curve's own numbers on the headline days. */
const headlineOf = (curve: RetentionCurve): RetentionPoint[] =>
  RETENTION_DAYS.map((day) => ({
    day,
    rate: curve.rates[day - 1] ?? null,
    before: curve.before[day - 1] ?? null,
    similar: curve.similar?.[day - 1] ?? null,
  }));

/**
 * How the players who first played on day `at` of the period stay on `day`, against everyone: the
 * sample's own Day 1 and Day 7 for them, eased between the two and held after.
 */
function cohortLift(sample: GameSample, at: number, day: number): number {
  const first = ratio(sample.day1.daily[at], sample.retention.rates[0]) ?? 1;
  const week = ratio(sample.day7.daily[at], sample.retention.rates[COHORT_WEEK_DAY - 1]) ?? first;
  if (day >= COHORT_WEEK_DAY) return week;
  return first + ((week - first) * (day - 1)) / (COHORT_WEEK_DAY - 1);
}

/**
 * The share of day `at`'s new players who played again `day` days later: the sample's on Day 1 and
 * Day 7, and null for a day that has not come or that the curve does not know yet.
 */
function dayCell(sample: GameSample, at: number, day: number): number | null {
  const everyone = sample.retention.rates[day - 1] ?? null;
  if (everyone === null || at + day > sample.dates.length - 1) return null;
  if (day === 1) return sample.day1.daily[at] ?? null;
  if (day === COHORT_WEEK_DAY) return sample.day7.daily[at] ?? null;
  return round3(everyone * cohortLift(sample, at, day) * chance(sample.seed + 40 + day, at));
}

/**
 * The campaign that brought most of the new players of `days` (places in the period): the sample's
 * campaign, on days it was running and its channel brought more than any other.
 */
function campaignOf(sample: GameSample, days: readonly number[]): string | null {
  const { campaign, channels } = sample;
  const paid = channels.find((one) => one.channel === SourceChannel.Campaigns);
  if (!campaign || !paid) return null;
  const brought = (channel: SampleChannel): number => sum(days.map((at) => channel.daily[at] ?? 0));
  const running = days.some((at) => (sample.dates[at] ?? "") >= campaign.startsOn);
  const most = brought(paid) > 0 && channels.every((one) => one === paid || brought(one) < brought(paid));
  return running && most ? campaign.name : null;
}

/** A cohort for each day of the period somebody first played, as wide as the period allows. */
function dailyCohorts(sample: GameSample, mode: RetentionMode): Cohort[] {
  const width = Math.min(RETENTION_SPAN, sample.dates.length - 1);
  return sample.dates.flatMap((startsOn, at) => {
    const size = sample.newPlayers.daily[at] ?? 0;
    if (size === 0) return [];
    const rates = Array.from({ length: width }, (_, index) => dayCell(sample, at, index + 1));
    return [{ startsOn, size, rates: inMode(rates, mode), campaign: campaignOf(sample, [at]) }];
  });
}

/** The period's days cut into weeks, Monday first: each week the places of its days in the period. */
function weeksOf(dates: readonly string[]): number[][] {
  const weeks: number[][] = [];
  for (const [at, day] of dates.entries()) {
    if (at === 0 || weekdayOf(day) === 0) weeks.push([]);
    weeks.at(-1)?.push(at);
  }
  return weeks;
}

/** The curve on `day`: its own number, or past the last day it knows, that one falling off slowly. */
function curveAt(rates: readonly (number | null)[], day: number): number | null {
  const own = rates[day - 1] ?? null;
  if (own !== null) return own;
  const last = rates.findLastIndex((rate) => rate !== null);
  const tail = rates[last] ?? null;
  return tail === null ? null : tail * ((last + 1) / day) ** TAIL_DECAY;
}

/** How a week's new players stay against everyone: its days' own, weighted by how many each brought. */
function weekLift(sample: GameSample, days: readonly number[]): number {
  const sizes = days.map((at) => sample.newPlayers.daily[at] ?? 0);
  const weighted = sum(days.map((at, index) => (sizes[index] ?? 0) * cohortLift(sample, at, 1)));
  return ratio(weighted, sum(sizes)) ?? 1;
}

/** The share of a week's new players who played again `ahead` weeks later; null while the curve knows nothing. */
function weekCell(sample: GameSample, days: readonly number[], ahead: number): number | null {
  const middle = curveAt(sample.retention.rates, WEEK_DAYS * ahead - WEEK_GAIN.middle);
  if (middle === null) return null;
  const gain = WEEK_GAIN.base + WEEK_GAIN.step * Math.min(ahead, WEEK_GAIN.steps);
  return round3(middle * gain * weekLift(sample, days) * chance(sample.seed + 50 + ahead, days[0] ?? 0));
}

/**
 * A cohort for each week of the period, cut to the period's days: the first begins on the period's
 * first day, the rest on a Monday. A week after is known once all seven of its days have passed.
 */
function weeklyCohorts(sample: GameSample, mode: RetentionMode): Cohort[] {
  const weeks = weeksOf(sample.dates);
  return weeks.flatMap((days, index) => {
    const size = sum(days.map((at) => sample.newPlayers.daily[at] ?? 0));
    const startsOn = sample.dates[days[0] ?? -1];
    if (size === 0 || startsOn === undefined) return [];
    const rates = Array.from({ length: weeks.length - 1 }, (_, after) => {
      const over = weeks[index + 1 + after]?.length === WEEK_DAYS;
      return over ? weekCell(sample, days, after + 1) : null;
    });
    return [{ startsOn, size, rates: inMode(rates, mode), campaign: campaignOf(sample, days) }];
  });
}

/** Groups that share out the period's new players; `seed` moves the shares and the lifts a little, when given. */
function sharedGroups(sample: GameSample, shared: readonly Shared[], seed?: number): Group[] {
  const moved = (value: number, index: number): number =>
    seed === undefined ? value : value * chance(seed, index) ** 3;
  const parts = spread(
    sample.newPlayers.now,
    shared.map((one, index) => moved(one.share, index)),
  );
  return shared.map(({ key, lift }, index) => {
    const [day1, day7, day30] = lift;
    return {
      key,
      newPlayers: parts[index] ?? 0,
      lift: [moved(day1, index + 20), moved(day7, index + 40), moved(day30, index + 60)],
    };
  });
}

/** Where new players play: the design's shares, and nobody installed where there is no app build. */
const placeGroups = (sample: GameSample): Group[] =>
  sharedGroups(
    sample,
    PLACES.filter((place) => sample.game.hasAppBuild || place.key !== PlayPlace.Installed),
  );

/** The sample's channels, each with its own new players. */
const channelGroups = (sample: GameSample): Group[] =>
  sample.channels.map(({ channel, newPlayers }) => ({ key: channel, newPlayers, lift: CHANNEL_LIFT[channel] }));

/** The countries new players come from, most first. */
const countryGroups = (sample: GameSample): Group[] =>
  sharedGroups(sample, COUNTRIES, sample.seed + 80).toSorted((a, b) => b.newPlayers - a.newPlayers);

/** The version before `version`, as the fixture numbers them: the minor one lower, or none for the first. */
function versionBefore(version: string): string | null {
  const [major, minor] = version.split(".").map(Number);
  return major !== undefined && minor !== undefined && minor > 0 ? `${major}.${minor - 1}.0` : null;
}

/**
 * New players by the version they first played, newest first: the sample's release splits the
 * period's days, and a release inside the period is only as old as the days since it.
 */
function versionGroups(sample: GameSample): Group[] {
  const { version, on } = sample.release;
  const daily = sample.newPlayers.daily;
  const earlier = versionBefore(version);
  const released = sample.dates.indexOf(on);
  const since = earlier === null || released < 0 ? 0 : released;
  const newest: Group = { key: version, newPlayers: sum(daily.slice(since)), lift: VERSION_LIFT.newest };
  if (released >= 0) newest.ripeDays = daily.length - 1 - released;
  return earlier === null
    ? [newest]
    : [newest, { key: earlier, newPlayers: sum(daily.slice(0, since)), lift: VERSION_LIFT.earlier }];
}

/** The groups each split makes of the period's new players. */
const GROUPS = {
  [SegmentBy.Place]: placeGroups,
  [SegmentBy.Channel]: channelGroups,
  [SegmentBy.Device]: (sample) => sharedGroups(sample, DEVICES, sample.seed + 70),
  [SegmentBy.Country]: countryGroups,
  [SegmentBy.Version]: versionGroups,
} as const satisfies Record<SegmentBy, (sample: GameSample) => Group[]>;

/**
 * Each group that has someone in it, with its rates on days 1, 7 and 30: everyone's, moved by the
 * group's lift. A day everyone's curve does not know, or the group is too new for, is null.
 */
function segmentRows(sample: GameSample, groups: readonly Group[], mode: RetentionMode): SegmentRow[] {
  return groups
    .filter((group) => group.newPlayers > 0)
    .map((group) => {
      const rates = SEGMENT_DAYS.map((day, index) => {
        const everyone = sample.retention.rates[day - 1] ?? null;
        const ripe = group.ripeDays === undefined || day <= group.ripeDays;
        return everyone === null || !ripe ? null : round3(everyone * (group.lift[index] ?? 1));
      });
      const [day1 = null, day7 = null, day30 = null] = inMode(rates, mode);
      return { key: group.key, newPlayers: group.newPlayers, day1, day7, day30 };
    });
}

/** Per-day counts over the period before and the period, oldest first: all the sample knows. */
interface History {
  fresh: number[];
  players: number[];
  /** The day at a place of the history. */
  dayAt: (at: number) => string;
}

/** The different players of the seven days from `start`: never fewer than its new players. */
function weekTotal(history: History, start: number): number {
  const playerDays = sum(history.players.slice(start, start + WEEK_DAYS));
  return Math.max(sum(history.fresh.slice(start, start + WEEK_DAYS)), Math.round(playerDays * WEEK_DISTINCT));
}

/**
 * The players of the week before the one that starts at `start`: counted when the history holds all
 * of it, scaled up from the days it does hold, and the week's own number when it holds none.
 */
function totalBefore(history: History, start: number): number {
  if (start >= WEEK_DAYS) return weekTotal(history, start - WEEK_DAYS);
  if (start === 0) return weekTotal(history, start);
  return Math.round((sum(history.players.slice(0, start)) * WEEK_DISTINCT * WEEK_DAYS) / start);
}

/**
 * The week from `start`, given how many played the week `before`: its new players, those who also
 * played the week before, those back from longer ago, and those of the week before who are gone.
 */
function weekFrom(history: History, start: number, before: number, wobble: number): LifecycleWeek {
  const fresh = sum(history.fresh.slice(start, start + WEEK_DAYS));
  const returning = weekTotal(history, start) - fresh;
  const stayed = Math.min(
    Math.round(returning * (STAYED.share + wobble * STAYED.chance)),
    Math.round(before * STAYED.most),
  );
  return { startsOn: history.dayAt(start), fresh, stayed, back: returning - stayed, left: before - stayed };
}

/**
 * The last whole weeks the sample knows, Monday to Sunday, oldest first, from the first week
 * anybody played. They reach back before the period: a week of the chart is not a week of it.
 */
function lifecycleWeeks(sample: GameSample): LifecycleWeek[] {
  const fresh = [...sample.newPlayers.dailyBefore, ...sample.newPlayers.daily];
  const last = fresh.length - 1;
  const history: History = {
    fresh,
    players: [...sample.players.dailyBefore, ...sample.players.daily],
    dayAt: (at) => dayBefore(sample.window.endsOn, last - at),
  };
  const mondays = fresh.flatMap((_, at) =>
    weekdayOf(history.dayAt(at)) === 0 && at + WEEK_DAYS - 1 <= last ? [at] : [],
  );
  const starts = mondays.slice(-WEEKS_SHOWN[sample.window.days]);
  const weeks: LifecycleWeek[] = [];
  let before = totalBefore(history, starts[0] ?? 0);
  for (const [index, start] of starts.entries()) {
    const week = weekFrom(history, start, before, noise(sample.seed + 60, index));
    weeks.push(week);
    before = week.fresh + week.stayed + week.back;
  }
  const first = weeks.findIndex((week) => week.fresh + week.stayed + week.back + week.left > 0);
  return first < 0 ? [] : weeks.slice(first);
}

/**
 * The Retention report's data for `sample`. It takes `mode`, `cohort` and `segmentBy`; with none
 * asked it counts a return on the day, groups first plays by day and compares where they play.
 */
export function fixtureRetention(sample: GameSample, options: GameReportOptions): RetentionReport {
  const mode = options.mode ?? RetentionMode.OnDay;
  const cohort = options.cohort ?? CohortSize.Day;
  const segmentBy = options.segmentBy ?? SegmentBy.Place;
  const curve = curveIn(sample, mode);
  return {
    mode,
    cohort,
    headline: headlineOf(curve),
    curve,
    cohorts: cohort === CohortSize.Week ? weeklyCohorts(sample, mode) : dailyCohorts(sample, mode),
    segmentBy,
    segments: segmentRows(sample, GROUPS[segmentBy](sample), mode),
    weeks: lifecycleWeeks(sample),
  };
}
