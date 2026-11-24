/**
 * What the Engagement report draws, derived from its answer without React: the eight headline
 * tiles with how each moved, the plays by length and the players by days a week as shares, the
 * week by hour (`engagement-clock.ts`), how far players get (`engagement-levels.ts`), and how the
 * game runs, against the period before and by device. The component only lays these out. A number
 * that cannot be known stays null all the way to the kit, which writes it as a dash.
 */
import {
  type DeviceClass,
  type EngagementReport,
  PlayLength,
  QUICK_EXIT_SECONDS,
  type RunNumbers,
} from "../../../shared/game-analytics.ts";
import { type ClockChoice, type HoursView, hoursView } from "./engagement-clock.ts";
import { type LevelsView, levelsView } from "./engagement-levels.ts";
import { ENGAGEMENT_WORDS as WORDS } from "./engagement-words.ts";
import {
  DeltaKind,
  formatDayTime,
  formatDuration,
  formatHours,
  formatNumber,
  formatPercent,
  formatPoints,
  formatSeconds,
  formatSigned,
  DURATION_DIGITS,
  formatSignedDuration,
  type HistogramBucket,
  type MetricDelta,
  POINT_DIGITS,
  ratio,
  roundsToZero,
} from "./kit/index.ts";

export { DeltaKind };
export * from "./engagement-clock.ts";
export * from "./engagement-levels.ts";

/** Days of a week from which a player is a regular: the number the share under the days is of. */
const REGULAR_DAYS = 4;
/** The days a month's players are counted over. */
const MONTH_DAYS = 30;
/** A play that held this many frames a second or more was smooth. */
const SMOOTH_FPS = 30;
/** A device is slow when it loads this many times slower than the other devices, weighed by their plays. */
const SLOW_LOAD_TIMES = 1.5;
/** A device loads too few plays when its share falls this far (as a fraction) under the other devices'. */
const LOW_LOADED_GAP = 0.05;
const SHARE_DIGITS = 0;

/** One number of a tile row: what it is, how it reads, how it moved, and what it counts. */
export interface EngagementTile {
  id: string;
  label: string;
  /** Null when the number cannot be known yet. */
  value: string | null;
  delta: MetricDelta;
  /** One quiet line; absent when there is nothing true to say. */
  note?: string;
}

/** A tile; the note is left off when there is none. */
function tile(
  id: string,
  label: string,
  value: string | null,
  delta: MetricDelta,
  note: string | null = null,
): EngagementTile {
  return note === null ? { id, label, value, delta } : { id, label, value, delta, note };
}

/** `value` written by `write`, or null when it is not known. */
const written = (value: number | null, write: (value: number) => string): string | null =>
  value === null ? null : write(value);

/** The sum of `values`. */
const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);

/** The decimals of a rate a change in points is written at: a point is a hundredth of a rate. */
const RATE_POINT_DIGITS = POINT_DIGITS + 2;

/** Whether a change in rates shows as no change at the decimals of a point it is written at. */
const showsNoChange = (change: number): boolean => roundsToZero(change, RATE_POINT_DIGITS);

/** A change in quick exits in points, with the word for its direction: fewer is the good way. */
function quickExitChange(change: number): string {
  const points = formatPoints(change);
  if (showsNoChange(change)) return points;
  return change < 0 ? WORDS.fewer(points) : WORDS.more(points);
}

/** The tiles about how much people play. */
function volumeTiles(data: EngagementReport): EngagementTile[] {
  const { plays, playsPerPlayerDay, medianPlaySeconds, playSeconds, playSecondsPerPlayerDay, p90PlaySeconds } = data;
  return [
    tile(
      "plays",
      WORDS.tiles.plays,
      formatNumber(plays.now),
      { kind: DeltaKind.Percent, now: plays.now, before: plays.before },
      WORDS.notes.plays,
    ),
    tile(
      "plays-per-player-day",
      WORDS.tiles.playsPerPlayerDay,
      written(playsPerPlayerDay.now, (value) => formatNumber(value, 2)),
      { ...playsPerPlayerDay, kind: DeltaKind.Amount, format: (change) => formatSigned(change, 2), digits: 2 },
      WORDS.notes.onDaysTheyPlay,
    ),
    tile(
      "median-play",
      WORDS.tiles.medianPlay,
      written(medianPlaySeconds.now, formatDuration),
      { ...medianPlaySeconds, kind: DeltaKind.Amount, format: formatSignedDuration, digits: DURATION_DIGITS },
      written(p90PlaySeconds, (seconds) => WORDS.notes.nineInTen(formatDuration(seconds))),
    ),
    tile(
      "play-time",
      WORDS.tiles.playTime,
      formatHours(playSeconds.now),
      { kind: DeltaKind.Percent, now: playSeconds.now, before: playSeconds.before },
      WORDS.notes.playTime,
    ),
    tile(
      "play-time-per-player-day",
      WORDS.tiles.playTimePerPlayerDay,
      written(playSecondsPerPlayerDay.now, formatDuration),
      { ...playSecondsPerPlayerDay, kind: DeltaKind.Amount, format: formatSignedDuration, digits: DURATION_DIGITS },
      WORDS.notes.onDaysTheyPlay,
    ),
  ];
}

/**
 * The tiles about how well plays go: quick exits, the crowd at its biggest (its hour on the clock
 * `offsetMinutes` east of UTC: the viewer's), and how many come back each day.
 */
function engagedTiles(data: EngagementReport, offsetMinutes: number): EngagementTile[] {
  const { quickExits, peak, peakAt, dailyPlayers, monthlyPlayers } = data;
  const daily = {
    now: ratio(dailyPlayers.now, monthlyPlayers.now),
    before: ratio(dailyPlayers.before, monthlyPlayers.before),
  };
  return [
    tile(
      "quick-exits",
      WORDS.tiles.quickExits,
      written(quickExits.now, (value) => formatPercent(value)),
      {
        ...quickExits,
        kind: DeltaKind.Amount,
        format: quickExitChange,
        digits: RATE_POINT_DIGITS,
        lowerIsBetter: true,
      },
      WORDS.notes.quickExits(formatSeconds(QUICK_EXIT_SECONDS, 0)),
    ),
    tile(
      "peak",
      WORDS.tiles.peak,
      formatNumber(peak.now),
      { ...peak, kind: DeltaKind.Amount, format: (change) => formatSigned(change), digits: 0 },
      peakAt === null ? null : WORDS.notes.peakAt(formatDayTime(peakAt, offsetMinutes)),
    ),
    tile(
      "daily-share",
      WORDS.tiles.dailyShare,
      written(daily.now, (value) => formatPercent(value)),
      { kind: DeltaKind.Points, ...daily },
      daily.now === null
        ? null
        : WORDS.notes.dailyShare(formatNumber(dailyPlayers.now), formatNumber(monthlyPlayers.now), MONTH_DAYS),
    ),
  ];
}

/** The eight headline numbers, in the order they are shown; a time is on the clock `offsetMinutes` east of UTC. */
export function headlineTiles(data: EngagementReport, offsetMinutes: number): EngagementTile[] {
  return [...volumeTiles(data), ...engagedTiles(data, offsetMinutes)];
}

/** What a chart of shares shows: bars over named buckets, and the sentence under them. */
export interface SharesView {
  buckets: HistogramBucket[];
  footnote: string;
}

/** The plays by length as shares of all plays; a length the answer did not carry is unknown, not empty. */
export function lengthsView(data: EngagementReport): SharesView | null {
  const total = data.plays.now;
  if (total <= 0 || data.lengths.length === 0) return null;
  const counts = new Map(data.lengths.map((one) => [one.length, one.plays]));
  const quick = formatSeconds(QUICK_EXIT_SECONDS, 0);
  const median = data.medianPlaySeconds.now;
  return {
    buckets: Object.values(PlayLength).map((length) => ({
      id: length,
      label: WORDS.lengths.bucket[length],
      value: ratio(counts.get(length), total),
    })),
    footnote: median === null ? WORDS.lengths.quickOnly(quick) : WORDS.lengths.median(formatDuration(median), quick),
  };
}

/** The week's players by the days they played on, as shares of everyone who played in a week. */
export function daysAWeekView(data: EngagementReport): SharesView | null {
  const total = sum(data.daysAWeek);
  if (total <= 0) return null;
  const last = data.daysAWeek.length;
  return {
    buckets: data.daysAWeek.map((people, index) => {
      const days = index + 1;
      return {
        id: String(days),
        label: days === 1 || days === last ? WORDS.days.bar(days) : formatNumber(days),
        value: people / total,
      };
    }),
    footnote: WORDS.days.regulars(
      formatPercent(sum(data.daysAWeek.slice(REGULAR_DAYS - 1)) / total, SHARE_DIGITS),
      REGULAR_DAYS,
    ),
  };
}

/** The four numbers of how the game runs, each against the period before. */
export function runTiles(data: EngagementReport): EngagementTile[] {
  const { run, runBefore, runSince } = data;
  const within = written(run.loadSecondsP90, (seconds) => formatSeconds(seconds));
  return [
    tile(
      "load-time",
      WORDS.run.tiles.loadTime,
      written(run.loadSeconds, (seconds) => formatSeconds(seconds)),
      {
        kind: DeltaKind.Amount,
        now: run.loadSeconds,
        before: runBefore.loadSeconds,
        format: formatSignedDuration,
        digits: DURATION_DIGITS,
        lowerIsBetter: true,
      },
      loadNote(within, runSince),
    ),
    rateTile("loaded", WORDS.run.tiles.loaded, run.loaded, runBefore.loaded, WORDS.run.notes.loaded),
    rateTile("smooth", WORDS.run.tiles.smooth, run.smooth, runBefore.smooth, WORDS.run.notes.smooth(SMOOTH_FPS)),
    rateTile("clean", WORDS.run.tiles.clean, run.clean, runBefore.clean, WORDS.run.notes.clean),
  ];
}

/** The load-time tile's note: how long nine in ten take, and the version a change came with. */
function loadNote(within: string | null, since: string | null): string | null {
  if (within !== null && since !== null) return WORDS.run.notes.loadWithinSince(within, since);
  if (within !== null) return WORDS.run.notes.loadWithin(within);
  return since === null ? null : WORDS.run.notes.since(since);
}

/** A tile for a share of plays, which moves in points. */
function rateTile(id: string, label: string, now: number | null, before: number | null, note: string): EngagementTile {
  return tile(
    id,
    label,
    written(now, (value) => formatPercent(value)),
    { kind: DeltaKind.Points, now, before },
    note,
  );
}

/** How the game runs on one kind of device, and what stands out about it. */
export interface DeviceRow {
  device: DeviceClass;
  label: string;
  /** Its plays as a share of all plays; null when they cannot be told. */
  share: number | null;
  loadSeconds: number | null;
  loaded: number | null;
  fps: number | null;
  clean: number | null;
  /** It loads much slower than the other devices. */
  slow: boolean;
  /** Far fewer of its started plays finish loading than the other devices'. */
  low: boolean;
}

/** The plays a device's runs stand for: the started ones that loaded; null when that share is unknown. */
function playsOf(run: RunNumbers): number | null {
  if (run.started === 0) return 0;
  return run.loaded === null ? null : Math.round(run.started * run.loaded);
}

/** The mean of `pick` over `runs`, weighed by the plays each started; null when none of them measured it. */
function weighedMean(runs: readonly RunNumbers[], pick: (run: RunNumbers) => number | null): number | null {
  let total = 0;
  let weight = 0;
  for (const run of runs) {
    const value = pick(run);
    if (value === null || run.started === 0) continue;
    total += value * run.started;
    weight += run.started;
  }
  return weight > 0 ? total / weight : null;
}

/** Whether `run` loads much slower than `others`. */
function isSlow(run: RunNumbers, others: readonly RunNumbers[]): boolean {
  const rest = weighedMean(others, (one) => one.loadSeconds);
  return run.loadSeconds !== null && rest !== null && rest > 0 && run.loadSeconds >= rest * SLOW_LOAD_TIMES;
}

/** Whether `run` finishes loading far fewer of its started plays than `others`. */
function isLow(run: RunNumbers, others: readonly RunNumbers[]): boolean {
  const rest = weighedMean(others, (one) => one.loaded);
  return run.loaded !== null && rest !== null && run.loaded <= rest - LOW_LOADED_GAP;
}

/** The devices as table rows; none when nothing started anywhere, so there is nothing to compare. */
export function deviceRows(data: EngagementReport): DeviceRow[] {
  if (data.devices.every(({ run }) => run.started === 0)) return [];
  return data.devices.map(({ device, run }) => {
    const others = data.devices.filter((one) => one.device !== device).map((one) => one.run);
    const plays = playsOf(run);
    return {
      device,
      label: WORDS.devices.names[device],
      share: plays === null ? null : ratio(plays, data.plays.now),
      loadSeconds: run.loadSeconds,
      loaded: run.loaded,
      fps: run.fps,
      clean: run.clean,
      slow: isSlow(run, others),
      low: isLow(run, others),
    };
  });
}

/** Everything the Engagement draws. */
export interface EngagementView {
  /** Nobody played, in the period or the one before. */
  empty: boolean;
  tiles: EngagementTile[];
  lengths: SharesView | null;
  days: SharesView | null;
  hours: HoursView;
  levels: LevelsView;
  run: EngagementTile[];
  devices: DeviceRow[];
}

/** The report as the page draws it, on `clock`'s week; `offsetMinutes` is how far east of UTC the viewer is. */
export function engagementView(data: EngagementReport, clock: ClockChoice, offsetMinutes: number): EngagementView {
  return {
    empty: data.plays.now === 0 && data.plays.before === 0,
    tiles: headlineTiles(data, offsetMinutes),
    lengths: lengthsView(data),
    days: daysAWeekView(data),
    hours: hoursView(data, clock, offsetMinutes),
    levels: levelsView(data.levels),
    run: runTiles(data),
    devices: deviceRows(data),
  };
}
