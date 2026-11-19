/**
 * "When they play", derived without React: the week of plays by hour turned to the viewer's clock
 * (or kept on the players' own), the busiest hour named, and the heatmap's rows. The viewer's
 * offset is a parameter, so what a creator in another zone sees is testable on any computer.
 */
import { DAY_MS, HOUR_MS, MINUTE_MS } from "../../../shared/duration.ts";
import { type EngagementReport, WEEK_HOURS } from "../../../shared/game-analytics.ts";
import { intlLocale } from "../../../shared/i18n.ts";
import { formatHour, weekdayName, weekRows } from "./kit/index.ts";
import { ENGAGEMENT_WORDS as WORDS } from "./engagement-words.ts";

const DAY_HOURS = 24;
const HOUR_MINUTES = HOUR_MS / MINUTE_MS;
/** A Monday (UTC), to name the days of a week from. */
const A_MONDAY_MS = Date.UTC(2024, 0, 1);

/** Whose clock the week is drawn on. */
export const ClockChoice = { Mine: "mine", Players: "players" } as const;
export type ClockChoice = (typeof ClockChoice)[keyof typeof ClockChoice];

/**
 * The offset of the viewer's own zone from UTC at `now`, in minutes east (Istanbul is +180). One
 * offset serves the whole period, so across a change of summer time the hours before it are an
 * hour out.
 */
export function viewerOffsetMinutes(now: number): number {
  return -new Date(now).getTimezoneOffset() || 0;
}

/** `index` placed on a week of `WEEK_HOURS`, wrapping either way round. */
const onWeek = (index: number): number => ((index % WEEK_HOURS) + WEEK_HOURS) % WEEK_HOURS;

/** A number the week can hold: anything else is an hour nobody played in. */
const hourOf = (value: number | undefined): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;

/**
 * A week of plays by UTC hour (168 numbers from Monday 00:00) as it falls on a clock `offsetMinutes`
 * east of UTC: a whole-hour zone moves every hour along, a zone with minutes (+5:30) shares each
 * hour between the two it overlaps, and the week wraps. The plays are only moved, never lost. An
 * offset that is not a number reads as UTC, and a week that is short is padded with empty hours.
 */
export function shiftedHours(hours: readonly number[], offsetMinutes: number): number[] {
  const week = Array.from({ length: WEEK_HOURS }, (_, index) => hourOf(hours[index]));
  const offset = Number.isFinite(offsetMinutes) ? offsetMinutes : 0;
  const wholeHours = Math.floor(offset / HOUR_MINUTES);
  const part = (offset - wholeHours * HOUR_MINUTES) / HOUR_MINUTES;
  const at = (index: number): number => week[onWeek(index)] ?? 0;
  return week.map((_, index) => {
    const here = at(index - wholeHours);
    return part === 0 ? here : here * (1 - part) + at(index - wholeHours - 1) * part;
  });
}

/** The weekday (Monday is 0) and hour of the week's busiest hour: the first when several tie, null when nobody played. */
export function busiestHour(hours: readonly number[]): { day: number; hour: number } | null {
  let busiest = -1;
  let most = 0;
  for (const [index, plays] of hours.entries()) {
    if (plays > most) {
      busiest = index;
      most = plays;
    }
  }
  return busiest < 0 ? null : { day: Math.floor(busiest / DAY_HOURS), hour: busiest % DAY_HOURS };
}

const dayFormats = new Map<string, Intl.DateTimeFormat>();

/** The full name of a day of the week, Monday first (0 to 6): "Saturday". */
export function weekdayLongName(day: number): string {
  const locale = intlLocale();
  let format = dayFormats.get(locale ?? "");
  if (!format) {
    format = new Intl.DateTimeFormat(locale, { weekday: "long", timeZone: "UTC" });
    dayFormats.set(locale ?? "", format);
  }
  return format.format(A_MONDAY_MS + day * DAY_MS);
}

/** What "When they play" draws. */
export interface HoursView {
  /** The clock the rows are on: the players' only when the answer knows it. */
  clock: ClockChoice;
  /** Whether the players' own clock is known, so the switch has something to choose. */
  switchable: boolean;
  /** What the heatmap shows, read aloud. */
  label: string;
  /** Each hour of the day heads a column. */
  columns: string[];
  /** Monday first, 24 plays each; a fraction when a half-hour zone shared an hour. */
  rows: { id: string; label: string; cells: (number | null)[] }[];
  /** The busiest hour in words; null when nobody played. */
  busiest: string | null;
  /** Nobody played in the week: there is nothing to draw. */
  empty: boolean;
}

/** The week on `chosen`'s clock: the viewer's turned by `offsetMinutes`, or the players' own as sent. */
export function hoursView(data: EngagementReport, chosen: ClockChoice, offsetMinutes: number): HoursView {
  const local = data.hoursLocal;
  const clock = local !== null && chosen === ClockChoice.Players ? ClockChoice.Players : ClockChoice.Mine;
  const week = clock === ClockChoice.Players && local ? local : shiftedHours(data.hours, offsetMinutes);
  const busiest = busiestHour(week);
  return {
    clock,
    switchable: local !== null,
    label: clock === ClockChoice.Players ? WORDS.hours.labelPlayers : WORDS.hours.labelMine,
    columns: Array.from({ length: DAY_HOURS }, (_, hour) => formatHour(hour)),
    rows: weekRows(week).map((cells, day) => ({ id: String(day), label: weekdayName(day), cells })),
    busiest: busiest ? WORDS.hours.busiest(weekdayLongName(busiest.day), formatHour(busiest.hour)) : null,
    empty: busiest === null,
  };
}
