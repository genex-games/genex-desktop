/**
 * The Loop's time limit as the composer writes and reads it: minutes shown as "2 h 30 m", and
 * whatever the user types ("2h 30m", "90m", "1:45", "1.5") read back into minutes.
 */
import { HOUR_MS, MINUTE_MS } from "../../shared/duration.ts";

/** An hour, in the minutes every limit here is counted in. */
export const MINUTES_PER_HOUR = HOUR_MS / MINUTE_MS;
/** The Loop's shortest time limit, in minutes. */
export const MIN_LOOP_MINUTES = 15;
/** The Loop's longest time limit, in minutes: a day. */
export const MAX_LOOP_MINUTES = 24 * MINUTES_PER_HOUR;
/** The same limits in hours, as the composer stores the Loop's length. */
export const MIN_LOOP_HOURS = MIN_LOOP_MINUTES / MINUTES_PER_HOUR;
export const MAX_LOOP_HOURS = MAX_LOOP_MINUTES / MINUTES_PER_HOUR;
/** A typed limit rounds to this many minutes. */
const ROUND_TO_MINUTES = 5;

const CLOCK = /^(\d+):(\d{1,2})$/;
const HOURS = /(\d+(?:\.\d+)?)\s*h/;
const MINUTES = /(\d+)\s*m/;
const BARE_HOURS = /^\d+(\.\d+)?$/;

/** 150 → "2 h 30 m", 120 → "2 h", 45 → "45 m". */
export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / MINUTES_PER_HOUR);
  const m = Math.round(minutes % MINUTES_PER_HOUR);
  if (h && m) return `${h} h ${m} m`;
  return h ? `${h} h` : `${m} m`;
}

/** A count with its unit, singular for one: "1 hour", "30 minutes". */
function counted(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

/** The limit spelled out for the Mode caption: 30 → "30 minutes", 105 → "1 hour 45 minutes". */
export function limitWords(minutes: number): string {
  const h = Math.floor(minutes / MINUTES_PER_HOUR);
  const m = Math.round(minutes % MINUTES_PER_HOUR);
  if (h && m) return `${counted(h, "hour")} ${counted(m, "minute")}`;
  return h ? counted(h, "hour") : counted(m, "minute");
}

/** The Mode button's compact limit: 150 → "2h30", 120 → "2h", 30 → "30m". */
export function shortDuration(minutes: number): string {
  const h = Math.floor(minutes / MINUTES_PER_HOUR);
  const m = Math.round(minutes % MINUTES_PER_HOUR);
  if (h && m) return `${h}h${String(m).padStart(2, "0")}`;
  return h ? `${h}h` : `${m}m`;
}

/** "2h 30m", "2 h" or "90m" → minutes, or null when neither unit is there. */
function unitMinutes(text: string): number | null {
  const hours = HOURS.exec(text);
  const mins = MINUTES.exec(text);
  if (!hours && !mins) return null;
  return (hours ? parseFloat(hours[1] ?? "0") * MINUTES_PER_HOUR : 0) + (mins ? Number(mins[1]) : 0);
}

/** A typed limit in minutes, before it is kept in range: a clock, units, or bare hours. */
function typedMinutes(text: string): number | null {
  const clock = CLOCK.exec(text);
  if (clock) return Number(clock[1]) * MINUTES_PER_HOUR + Number(clock[2]);
  const units = unitMinutes(text);
  if (units !== null) return units;
  return BARE_HOURS.test(text) ? parseFloat(text) * MINUTES_PER_HOUR : null;
}

/** "2h 30m", "2 h", "90m", "1:45" or "1.5" (hours) → minutes within the Loop range, or null. */
export function parseDuration(text: string): number | null {
  const minutes = typedMinutes(text.trim().toLowerCase());
  if (minutes === null || !(minutes > 0)) return null;
  const rounded = Math.round(minutes / ROUND_TO_MINUTES) * ROUND_TO_MINUTES;
  return Math.min(MAX_LOOP_MINUTES, Math.max(MIN_LOOP_MINUTES, rounded));
}
