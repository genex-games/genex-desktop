/**
 * How long until an engine's limit resets, read from the words the engine said it in. The CLIs
 * name the reset only in text: Claude Code says "resets 9:50pm" or "resets in 3 hours"; Codex says
 * "try again in 4 days 20 hours 9 minutes", "try again at 3:45 PM" or "try again at Sep 12th, 2025
 * 3:45 PM", and the OpenAI API behind it "Please try again in 1.5s". The engine hands the wait on
 * as `EngineError.retryAfterMs`, which the run keeps on its close and the host resumes after.
 */
import { DAY_MS, HOUR_MS, MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";

/** One amount of a wait ("20 hours", "1.5s", "6m"): the number and its unit. */
const WAIT_PART = /(\d+(?:\.\d+)?)\s*(days?|hours?|hrs?|minutes?|mins?|seconds?|secs?|[dhms])(?![a-z])/gi;
/** A wait Codex names as a duration: "try again in 1 hour 30 minutes", "try again in 1m12s". */
const TRY_AGAIN_IN = new RegExp(
  String.raw`try again in\s+((?:\d+(?:\.\d+)?\s*(?:days?|hours?|hrs?|minutes?|mins?|seconds?|secs?|[dhms])(?![a-z])[\s,]*(?:and\s+)?)+)`,
  "i",
);
/** Codex's wait when under a minute is left. */
const TRY_AGAIN_SOON = /try again in less than a minute/i;
/** A reset Codex names as a time, on a date when it is not today: "try again at Sep 12th, 2025 3:45 PM". */
const TRY_AGAIN_AT =
  /try again at\s+(?:([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:(\d{4}),?\s+)?)?(\d{1,2}):(\d{2})\s*(am|pm)?/i;
/** Claude Code's wait as a duration: "resets in 3 hours". */
const RESETS_IN = /resets? in (\d+)\s*(min|minute|hour|h|m)/i;
/** Claude Code's reset as a clock time: "resets 9:50pm", "resets at 5pm", "resets 21:50". */
const RESETS_AT = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i;

/** Months as the CLIs abbreviate them, in calendar order. */
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Milliseconds per unit, by the unit's first letter. */
const UNIT_MS: Record<string, number> = { d: DAY_MS, h: HOUR_MS, m: MINUTE_MS, s: SECOND_MS };

/**
 * Milliseconds until the reset a limit message names, read against the machine's clock; null when
 * the text names none. A clock time already behind `now` is tomorrow's; a dated reset already past
 * is a minute away.
 */
export function limitResetMs(text: string, now = Date.now()): number | null {
  return claudeResetMs(text, now) ?? codexResetMs(text, now);
}

/** Claude Code's "resets in 3 hours" / "resets 9:50pm", or null. */
function claudeResetMs(text: string, now: number): number | null {
  const relative = RESETS_IN.exec(text);
  if (relative) {
    const n = Number(relative[1]);
    return /^h/i.test(relative[2] ?? "") ? n * HOUR_MS : n * MINUTE_MS;
  }
  const clock = RESETS_AT.exec(text);
  if (!clock) return null;
  return clockResetMs(Number(clock[1]), Number(clock[2] ?? "0"), clock[3], now);
}

/** Codex's "try again in …" / "try again at …", or null. */
function codexResetMs(text: string, now: number): number | null {
  if (TRY_AGAIN_SOON.test(text)) return MINUTE_MS;
  const relative = TRY_AGAIN_IN.exec(text);
  if (relative) return durationMs(relative[1] ?? "");
  const at = TRY_AGAIN_AT.exec(text);
  if (!at) return null;
  const [, month, day, year, hours, minutes, meridiem] = at;
  if (!month) return clockResetMs(Number(hours), Number(minutes), meridiem, now);
  const monthIndex = MONTHS.indexOf(month.toLowerCase());
  const hour = twentyFourHour(Number(hours), meridiem?.toLowerCase());
  if (monthIndex < 0 || hour > 23) return null;
  const yearNumber = year ? Number(year) : new Date(now).getFullYear();
  const reset = new Date(yearNumber, monthIndex, Number(day), hour, Number(minutes), 0, 0).getTime();
  return Math.max(MINUTE_MS, reset - now);
}

/** The sum of a wait's parts: "4 days 20 hours 9 minutes", "1m12s". */
function durationMs(words: string): number {
  let total = 0;
  for (const part of words.matchAll(WAIT_PART)) {
    total += Number(part[1]) * (UNIT_MS[(part[2] ?? "").charAt(0).toLowerCase()] ?? 0);
  }
  return total;
}

/** Milliseconds until the next time the clock reads `hours:minutes`; null for an hour no dial has. */
function clockResetMs(hours: number, minutes: number, meridiem: string | undefined, now: number): number | null {
  const lower = meridiem?.toLowerCase();
  const hour = twentyFourHour(hours, lower);
  if (hour > 23) return null;
  const at = new Date(now);
  at.setHours(hour, minutes, 0, 0);
  const ms = at.getTime() - now;
  // A clock time already behind `now` (by more than a minute of slack) is tomorrow's.
  const untilReset = ms < -MINUTE_MS ? ms + DAY_MS : ms;
  return Math.max(MINUTE_MS, untilReset);
}

/** A clock hour on a 24-hour dial: "9pm" is 21, "12am" is 0, an hour with no meridiem is as written. */
function twentyFourHour(hours: number, meridiem: string | undefined): number {
  if (meridiem === "pm" && hours < 12) return hours + 12;
  if (meridiem === "am" && hours === 12) return 0;
  return hours;
}
