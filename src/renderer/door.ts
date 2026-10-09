/**
 * The run's promise: what the hours control says a timed build will do, and when it ends.
 *
 * The hours control once offered no cap, so "until the critics are satisfied" was all the user
 * was told about a run that their Claude plan could pause at 1 am. The promise is a wall clock —
 * "until about 7:10 AM" is an answer to "when can I look?", "3 h" is not. Pure functions, tested
 * without a window (tests/conformance/door.test.ts). Where a launch lands is no choice any more:
 * every launch opens home (`state/studio.ts`).
 */
import { HOUR_MS } from "../shared/duration.ts";

/** The default length of a timed build. Long enough to be worth leaving, short enough to be a promise. */
export const HOURS_DEFAULT = 3;

/** No cap still has a ceiling: the harness stops a run at 24 h whatever its critics think. */
export const HOURS_CEILING = 24;

/** The hours control's promise when it is off: one build pass in this chat, no run, no judge. */
export const HOURS_OFF_PROMISE =
  "Off — one build pass in this chat, shown as it goes. Set hours for a reviewed build that runs on its own: ∞ until its reviewers are satisfied, or a number of hours.";

/**
 * "7:10 AM" — the wall clock this many hours from now, never a duration. Written the way the Mac
 * writes times, 12- or 24-hour.
 */
export function clockAfter(hours: number, now: number): string {
  return new Date(now + hours * HOUR_MS).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** The hours control's own promise: what happens, when it ends, and what it needs from you. */
export function hoursPromise(hours: number | null, now: number): string {
  const end = clockAfter(hours ?? HOURS_CEILING, now);
  const work = "Hours — workers build while you're away, and a reviewer keeps only what improves the game.";
  return hours === null
    ? `${work} No cap: it runs until its reviewers are satisfied and stops by about ${end} whatever happens. Keep the app open.`
    : `${work} It builds until about ${end}. Keep the app open.`;
}

/** The same end time as a chip caption, where there is room for four words and no more. */
export function hoursCaption(hours: number | null, now: number): string {
  return hours === null
    ? `until satisfied · by ~${clockAfter(HOURS_CEILING, now)}`
    : `until about ${clockAfter(hours, now)}`;
}
