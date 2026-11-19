/**
 * The Engagement report as genex.games answers it: how much people play (plays, their length, the
 * hours and the days of a week), how far they get through the game's levels, and how the game runs
 * for them, by device. Read with the helpers in `kit.ts`, the way `report-overview.ts` reads its
 * own: the fixed parts in `whole`, so one bad number refuses the report; the lists row by row; a
 * level's name and a version through `line`; every `null` the contract allows kept as null.
 */
import {
  type AnalyticsWindow,
  DeviceClass,
  type EngagementReport,
  EVENT_LIMITS,
  type LevelRow,
  PlayLength,
  type RunNumbers,
  WEEK_HOURS,
} from "../../../shared/game-analytics.ts";
import { isRecord } from "../gallery.ts";
import {
  amount,
  compared,
  count,
  isoTime,
  line,
  measure,
  oneOf,
  orNull,
  type Read,
  rate,
  rateOrNull,
  rows,
  series,
  whole,
} from "./kit.ts";

/** The days of a week: the length of the days-a-week series. */
const WEEK_DAYS = 7;
const LENGTHS_MAX = Object.keys(PlayLength).length;
const DEVICES_MAX = Object.keys(DeviceClass).length;
/** The most levels the page draws side by side. */
const LEVELS_MAX = 50;
/** A level's name is a value of the game's own `level` property, and as long as one may be. */
const LEVEL_NAME_MAX = EVENT_LIMITS.textLength;
/** The longest a version may read, as the game's own is held to (`game.ts`). */
const VERSION_MAX = 40;

const isPlayLength = oneOf(PlayLength);
const isDevice = oneOf(DeviceClass);
const amountOrNull = orNull(amount);

/** Plays of one length; a length the app does not know is left out. */
const lengthCount: Read<EngagementReport["lengths"][number]> = (value) => {
  if (!isRecord(value) || !isPlayLength(value.length)) return undefined;
  const plays = count(value.plays);
  return plays === undefined ? undefined : { length: value.length, plays };
};

/** One level: who started and who finished it, and the median tries and seconds to pass, when known. */
const levelRow: Read<LevelRow> = (value) => {
  if (!isRecord(value)) return undefined;
  const level = line(value.level, LEVEL_NAME_MAX);
  const read = whole({
    started: count(value.started),
    finished: count(value.finished),
    tries: amountOrNull(value.tries),
    seconds: amountOrNull(value.seconds),
  });
  return level && read ? { level, ...read } : undefined;
};

/** How the game runs for a group of plays; with nothing started every measure is null. */
function runNumbers(value: unknown): RunNumbers | undefined {
  if (!isRecord(value)) return undefined;
  return whole({
    started: count(value.started),
    loadSeconds: amountOrNull(value.loadSeconds),
    loadSecondsP90: amountOrNull(value.loadSecondsP90),
    loaded: rateOrNull(value.loaded),
    smooth: rateOrNull(value.smooth),
    fps: amountOrNull(value.fps),
    clean: rateOrNull(value.clean),
  });
}

/** How the game runs on one kind of device; a device the app does not know is left out. */
const deviceRun: Read<EngagementReport["devices"][number]> = (value) => {
  if (!isRecord(value) || !isDevice(value.device)) return undefined;
  const run = runNumbers(value.run);
  return run ? { device: value.device, run } : undefined;
};

/**
 * The version a load-time change dates from. It only names the change, so text that is not a
 * version a page can show (empty, or too long) reads as no version; anything but text or null is
 * not this report.
 */
const versionOrNull: Read<string | null> = (value) => {
  if (value === null) return null;
  return typeof value === "string" ? (line(value, VERSION_MAX) ?? null) : undefined;
};

/** Plays by hour of the week in each player's own time; null when genex.games cannot place them. */
const localHours: Read<number[] | null> = (value) => (value === null ? null : series(value, WEEK_HOURS, count));

/** The game's levels in order; null for a game that sends no level events. */
const levels: Read<LevelRow[] | null> = (value) =>
  value === null ? null : rows(value, LEVELS_MAX, levelRow, (row) => row.level);

/** The Engagement report, or null when `data` is not one. It has no per-day series, so the period is not read. */
export function toEngagementReport(data: unknown, _window: AnalyticsWindow): EngagementReport | null {
  if (!isRecord(data)) return null;
  const report = whole({
    plays: compared(data.plays),
    playsPerPlayerDay: measure(data.playsPerPlayerDay),
    medianPlaySeconds: measure(data.medianPlaySeconds),
    p90PlaySeconds: amountOrNull(data.p90PlaySeconds),
    playSeconds: compared(data.playSeconds, amount),
    playSecondsPerPlayerDay: measure(data.playSecondsPerPlayerDay),
    quickExits: measure(data.quickExits, rate),
    peak: compared(data.peak),
    peakAt: orNull(isoTime)(data.peakAt),
    dailyPlayers: measure(data.dailyPlayers),
    monthlyPlayers: compared(data.monthlyPlayers),
    lengths: rows(data.lengths, LENGTHS_MAX, lengthCount, (row) => row.length),
    daysAWeek: series(data.daysAWeek, WEEK_DAYS, count),
    hours: series(data.hours, WEEK_HOURS, count),
    hoursLocal: localHours(data.hoursLocal),
    levels: levels(data.levels),
    run: runNumbers(data.run),
    runBefore: runNumbers(data.runBefore),
    runSince: versionOrNull(data.runSince),
    devices: rows(data.devices, DEVICES_MAX, deviceRun, (row) => row.device),
  });
  return report ?? null;
}
