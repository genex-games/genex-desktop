/**
 * How game analytics writes its numbers: counts, rates as percentages, changes in points, lengths
 * of time, Nex, days and "how long ago". Pure, and in the app's language: digits and dates come
 * from `Intl` with `intlLocale()`, units and words from `t()`. A value that is missing (null, or not
 * a finite number) reads as a dash, never as zero. Days are UTC, as genex.games counts them; an
 * instant is written on the clock it is handed (the viewer's own).
 */
import { DAY_MS, HOUR_MS, MINUTE_MS, SECOND_MS } from "../../../../shared/duration.ts";
import { intlLocale, t } from "../../../../shared/i18n.ts";
import { periodDays, type StatsPeriod } from "../../../../shared/play-stats.ts";

/** What a missing value reads as. */
export const DASH = "—";
/** The minus of a negative number or a drop: the real sign, not a hyphen. */
const MINUS = "−";
const PLUS = "+";

const MINUTE_S = MINUTE_MS / SECOND_MS;
const HOUR_S = HOUR_MS / SECOND_MS;
/** A length this long, in hours, is written in hours alone. */
const HOURS_ONLY_FROM = 100;
/** Seconds and hours under this keep one decimal. */
const DECIMAL_BELOW = 10;
/** Nex amounts under this keep up to two decimals. */
const NEX_WHOLE_FROM = 100;
/** The decimals Nex per player is written with, on every tab. */
const NEX_PER_PLAYER_DIGITS = 2;
/** The most decimals a percentage on a chart's axis keeps, for a step finer than a whole percent. */
const AXIS_PERCENT_DIGITS = 2;
/** A time this fresh, or ahead of the clock, is "just now". */
const JUST_NOW_MS = 5 * SECOND_MS;
/** A Monday (UTC), to name the days of a week from. */
const A_MONDAY_MS = Date.UTC(2024, 0, 1);
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

const numberFormats = new Map<string, Intl.NumberFormat>();
const dateFormats = new Map<string, Intl.DateTimeFormat>();
const agoFormats = new Map<string, Intl.RelativeTimeFormat>();

/** The number format for `options` in the app's language, made once per language. */
function numbers(key: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const locale = intlLocale();
  const id = `${locale ?? ""}|${key}`;
  let format = numberFormats.get(id);
  if (!format) {
    format = new Intl.NumberFormat(locale, options);
    numberFormats.set(id, format);
  }
  return format;
}

/** The date format for `options` in the app's language, in UTC, made once per language. */
function dates(key: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const locale = intlLocale();
  const id = `${locale ?? ""}|${key}`;
  let format = dateFormats.get(id);
  if (!format) {
    format = new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" });
    dateFormats.set(id, format);
  }
  return format;
}

/** `value` when it is a finite number, else null. */
function known(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** A number without its sign, with exactly `digits` decimals. */
const fixed = (value: number, digits: number): string =>
  numbers(`fixed${digits}`, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(Math.abs(value));

/** The decimals a change in points is written at unless told otherwise. */
export const POINT_DIGITS = 1;
/** The decimals of seconds below which `formatSignedDuration` writes a change with no sign. */
export const DURATION_DIGITS = 1;

/** Whether `value` shows as zero at `digits` decimals: what every signed formatter here writes with no sign. */
export const roundsToZero = (value: number, digits: number): boolean => Number(Math.abs(value).toFixed(digits)) === 0;

/** The sign a change wears: plus, the real minus, or none when it shows as zero. */
function signOf(value: number, digits: number): string {
  if (roundsToZero(value, digits)) return "";
  return value > 0 ? PLUS : MINUS;
}

/**
 * `part / whole`, for a rate or an average: null when either is missing or not finite, or when
 * there is nothing to divide by. Never NaN or Infinity.
 */
export function ratio(part: number | null | undefined, whole: number | null | undefined): number | null {
  const top = known(part);
  const bottom = known(whole);
  if (top === null || bottom === null || bottom === 0) return null;
  return top / bottom;
}

/**
 * `part`'s share of a `whole` it should belong to, as `ratio`: null too when `part` is larger, since
 * then the two were not counted as one group and no share of it can be told.
 */
export function share(part: number | null | undefined, whole: number | null | undefined): number | null {
  const value = ratio(part, whole);
  return value !== null && value > 1 ? null : value;
}

/** `now − before`, for a change in points or in a unit: null when either side is missing. */
export function difference(now: number | null | undefined, before: number | null | undefined): number | null {
  const current = known(now);
  const earlier = known(before);
  if (current === null || earlier === null) return null;
  return current - earlier;
}

/** A count or a decimal, grouped, with exactly `digits` decimals (none by default): "9,300", "1.38". */
export function formatNumber(value: number | null | undefined, digits = 0): string {
  const number = known(value);
  if (number === null) return DASH;
  const negative = number < 0 && !roundsToZero(number, digits);
  return `${negative ? MINUS : ""}${fixed(number, digits)}`;
}

/** A change in a number with its sign, `digits` decimals: "+124", "−0.14", and "0" for none. */
export function formatSigned(value: number | null | undefined, digits = 0): string {
  const number = known(value);
  if (number === null) return DASH;
  return `${signOf(number, digits)}${fixed(number, digits)}`;
}

/** A large count shortened for an axis or a small cell, the language's own way: "1.2K", "1,2 Mio.". */
export function formatCompact(value: number | null | undefined): string {
  const number = known(value);
  if (number === null) return DASH;
  const text = numbers("compact", { notation: "compact", maximumFractionDigits: 1 }).format(Math.abs(number));
  return `${number < 0 ? MINUS : ""}${text}`;
}

/** A rate (a fraction, 0 to 1) as a percentage with `digits` decimals (one by default): "34.5%". */
export function formatPercent(rate: number | null | undefined, digits = 1): string {
  const number = known(rate);
  if (number === null) return DASH;
  const percent = numbers(`percent${digits}`, {
    style: "percent",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(Math.abs(number));
  const negative = number < 0 && !roundsToZero(number * 100, digits);
  return `${negative ? MINUS : ""}${percent}`;
}

/**
 * A rate as a chart's axis writes its steps: whole percentages, and decimals only for a step that
 * has them ("40%", "0%", "2.5%"). The readout and the tables keep `formatPercent`.
 */
export function formatAxisPercent(rate: number | null | undefined): string {
  const number = known(rate);
  if (number === null) return DASH;
  const percent = numbers("axisPercent", { style: "percent", maximumFractionDigits: AXIS_PERCENT_DIGITS }).format(
    Math.abs(number),
  );
  const negative = number < 0 && !roundsToZero(number * 100, AXIS_PERCENT_DIGITS);
  return `${negative ? MINUS : ""}${percent}`;
}

/**
 * The difference between two rates in percentage points, signed, `digits` decimals (one by
 * default): 0.021 reads "+2.1 pts". Pass `difference(now, before)`.
 */
export function formatPoints(change: number | null | undefined, digits = POINT_DIGITS): string {
  const number = known(change);
  if (number === null) return DASH;
  const points = number * 100;
  return t("{points} pts", { points: `${signOf(points, digits)}${fixed(points, digits)}` });
}

/** Seconds with `digits` decimals (one by default), for a load or download time: "3.8 s". */
export function formatSeconds(seconds: number | null | undefined, digits = 1): string {
  const number = known(seconds);
  if (number === null || number < 0) return DASH;
  return t("{seconds} s", { seconds: fixed(number, digits) });
}

/** A total in hours, whole from ten up: "4,462 h", "0.5 h". Takes seconds. */
export function formatHours(seconds: number | null | undefined): string {
  const number = known(seconds);
  if (number === null || number < 0) return DASH;
  const hours = number / HOUR_S;
  const tenths = Math.round(hours * 10) / 10;
  const decimal = tenths < DECIMAL_BELOW && !Number.isInteger(tenths);
  return t("{hours} h", { hours: fixed(decimal ? tenths : Math.round(hours), decimal ? 1 : 0) });
}

/** Under a minute: "52 s", and one decimal under ten seconds when there is one, "3.8 s". */
function shortSeconds(seconds: number): string {
  const tenths = Math.round(seconds * 10) / 10;
  const decimal = tenths < DECIMAL_BELOW && !Number.isInteger(tenths);
  return t("{seconds} s", { seconds: fixed(decimal ? tenths : Math.round(seconds), decimal ? 1 : 0) });
}

/**
 * A length of time in seconds, the short way: "3.8 s", "52 s", "5m 40s", "31m", "1h 2m", and hours
 * alone from a hundred of them ("4,462 h"). A negative or missing length is a dash.
 */
export function formatDuration(seconds: number | null | undefined): string {
  const number = known(seconds);
  if (number === null || number < 0) return DASH;
  if (number >= HOURS_ONLY_FROM * HOUR_S) return formatHours(number);
  const whole = Math.round(number);
  if (whole < MINUTE_S) return shortSeconds(number);
  if (whole < HOUR_S) {
    const minutes = Math.floor(whole / MINUTE_S);
    const rest = whole % MINUTE_S;
    return rest > 0 ? t("{minutes}m {seconds}s", { minutes, seconds: rest }) : t("{minutes}m", { minutes });
  }
  const allMinutes = Math.round(number / MINUTE_S);
  const hours = Math.floor(allMinutes / MINUTE_S);
  const minutes = allMinutes % MINUTE_S;
  return minutes > 0 ? t("{hours}h {minutes}m", { hours, minutes }) : t("{hours}h", { hours });
}

/** A change in a length of time, signed: "+22 s", "−1m 5s", and "0 s" for none. */
export function formatSignedDuration(seconds: number | null | undefined): string {
  const number = known(seconds);
  if (number === null) return DASH;
  const length = formatDuration(Math.abs(number));
  return `${signOf(number, DURATION_DIGITS)}${length}`;
}

/** An amount of Nex as a bare number: whole from a hundred up, up to two decimals under it. */
export function formatNexAmount(amount: number | null | undefined): string {
  const number = known(amount);
  if (number === null) return DASH;
  const whole = Math.abs(number) >= NEX_WHOLE_FROM;
  const text = numbers(whole ? "nexWhole" : "nexSmall", { maximumFractionDigits: whole ? 0 : 2 }).format(
    Math.abs(number),
  );
  return `${number < 0 && !roundsToZero(number, whole ? 0 : 2) ? MINUS : ""}${text}`;
}

/**
 * Nex spent per player, the same on every tab: always `NEX_PER_PLAYER_DIGITS` decimals, so a column
 * of them lines up ("4.60", "0.90", "1,240.00").
 */
export function formatNexPerPlayer(amount: number | null | undefined): string {
  return formatNumber(amount, NEX_PER_PLAYER_DIGITS);
}

/** An amount of Nex with its unit: "1.9 Nex". */
export function formatNex(amount: number | null | undefined): string {
  if (known(amount) === null) return DASH;
  return t("{amount} Nex", { amount: formatNexAmount(amount) });
}

/** The start of a `YYYY-MM-DD` day in UTC, or null when the text is no such day. */
function dayStart(iso: string | null | undefined): number | null {
  if (!iso || !ISO_DAY.test(iso)) return null;
  return known(Date.parse(`${iso}T00:00:00.000Z`));
}

/** A UTC day (`YYYY-MM-DD`) as an axis and a table show it: "Oct 19". */
export function formatDay(iso: string | null | undefined): string {
  const start = dayStart(iso);
  if (start === null) return DASH;
  return dates("day", { month: "short", day: "numeric" }).format(start);
}

/** A range of UTC days, first to last: "Oct 19 – Nov 17". */
export function formatDayRange(from: string | null | undefined, to: string | null | undefined): string {
  const start = dayStart(from);
  const end = dayStart(to);
  if (start === null || end === null) return DASH;
  return dates("day", { month: "short", day: "numeric" }).formatRange(start, end);
}

/** A UTC day with its weekday, for a cohort's row: "Mon, Nov 2". */
export function formatWeekday(iso: string | null | undefined): string {
  const start = dayStart(iso);
  if (start === null) return DASH;
  return dates("weekday", { weekday: "short", month: "short", day: "numeric" }).format(start);
}

/**
 * An instant (ISO) as a clock `offsetMinutes` east of UTC reads it, its day and hour: "Sat, Nov 7,
 * 15:00". The page hands in the viewer's own offset, as the weekday heatmap is turned by it.
 */
export function formatDayTime(iso: string | null | undefined, offsetMinutes: number): string {
  const at = iso ? known(Date.parse(iso)) : null;
  if (at === null) return DASH;
  const offset = Number.isFinite(offsetMinutes) ? offsetMinutes : 0;
  return dates("dayTime", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(at + offset * MINUTE_MS);
}

/** An hour of the day (0 to 23) on the 24-hour clock: "20:00". */
export function formatHour(hour: number): string {
  return dates("hour", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(hour * HOUR_MS);
}

/** The short name of a day of the week, Monday first (0 to 6): "Mon". */
export function weekdayName(day: number): string {
  return dates("weekdayName", { weekday: "short" }).format(A_MONDAY_MS + day * DAY_MS);
}

/** Each day of a report's period as its chart writes it, oldest first: pass the answer's `window`. */
export function periodLabels(window: { days: StatsPeriod; endsOn: string }): string[] {
  return periodDays(window).map(formatDay);
}

/**
 * How long before `now` (milliseconds, the caller's clock) an ISO time was, the language's short
 * way: "12 sec. ago", "4 min. ago", "3 hr. ago", "2 days ago"; "just now" under five seconds.
 */
export function formatAgo(iso: string | null | undefined, now: number): string {
  const at = iso ? known(Date.parse(iso)) : null;
  if (at === null) return DASH;
  const elapsed = now - at;
  if (elapsed < JUST_NOW_MS) return t("just now");
  const locale = intlLocale();
  let format = agoFormats.get(locale ?? "");
  if (!format) {
    format = new Intl.RelativeTimeFormat(locale, { style: "short", numeric: "always" });
    agoFormats.set(locale ?? "", format);
  }
  if (elapsed < MINUTE_MS) return format.format(-Math.floor(elapsed / SECOND_MS), "second");
  if (elapsed < HOUR_MS) return format.format(-Math.floor(elapsed / MINUTE_MS), "minute");
  if (elapsed < DAY_MS) return format.format(-Math.floor(elapsed / HOUR_MS), "hour");
  return format.format(-Math.floor(elapsed / DAY_MS), "day");
}
