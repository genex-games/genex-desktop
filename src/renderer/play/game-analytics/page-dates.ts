/**
 * The days of a period as the header of a game's analytics page writes them: today as genex.games
 * counts days, and the first and last day of a period. genex.games counts days in UTC, so every day
 * here is a UTC day whatever this computer's time zone. A day's words, and every "ago", come from
 * the reports' own formatters (`kit/format.ts`), so the header and the reports write them one way.
 */
import { dayBefore, type StatsPeriod } from "../../../shared/play-stats.ts";
import { formatDay } from "./kit/format.ts";

/** Today as genex.games counts days: the UTC date at `now`. */
export const utcDay = (now: number): string => new Date(now).toISOString().slice(0, 10);

/** The first and last day, as written ("Oct 19"), of the period of `days` that ends on `endsOn`. */
export function periodSpan(endsOn: string, days: StatsPeriod): { from: string; to: string } {
  return { from: formatDay(dayBefore(endsOn, days - 1)), to: formatDay(endsOn) };
}
