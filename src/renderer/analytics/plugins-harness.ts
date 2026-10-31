/**
 * The Harness room (Activity) as usage analytics reads it: how people got there, whether its feed
 * loads, and what they undo of Harness's changes to itself. Changes are the agent's words about the
 * person's work: only counts, ages and outcomes leave.
 */
import { DAY_MS, HOUR_MS } from "../../shared/duration.ts";
import { type CountBucket, countBucket, elapsedMs } from "./properties.ts";

/** How the person reached the Harness room. */
export const HarnessOpenedVia = {
  Sidebar: "sidebar",
  Shortcut: "shortcut",
  /** A game chat's "what Harness learned" line. */
  LearningLine: "learning_line",
  ChatLink: "chat_link",
  /** Nothing said how: a way in that does not note itself. */
  Other: "other",
} as const;
export type HarnessOpenedVia = (typeof HarnessOpenedVia)[keyof typeof HarnessOpenedVia];

let pendingVia: HarnessOpenedVia | null = null;

/** Say how the Harness room is about to open; the room reads it once when it comes up. */
export function noteHarnessOpening(via: HarnessOpenedVia): void {
  pendingVia = via;
}

/** How the room that just came up was reached, once: the note, else Other. */
export function takeHarnessOpening(): HarnessOpenedVia {
  const via = pendingVia ?? HarnessOpenedVia.Other;
  pendingVia = null;
  return via;
}

/** How old something is, in steps that say enough. */
export const AgeBucket = {
  UnderHour: "<1h",
  Day: "1-24h",
  Week: "1-7d",
  Older: "7d+",
} as const;
export type AgeBucket = (typeof AgeBucket)[keyof typeof AgeBucket];

const AGE_LIMITS: ReadonlyArray<[number, AgeBucket]> = [
  [HOUR_MS, AgeBucket.UnderHour],
  [DAY_MS, AgeBucket.Day],
  [7 * DAY_MS, AgeBucket.Week],
];

/** The bucket an age falls in; an unreadable time counts as new. */
export function ageBucket(at: string | undefined, now: number): AgeBucket {
  const then = at ? Date.parse(at) : Number.NaN;
  const age = Number.isFinite(then) ? elapsedMs(then, now) : 0;
  return AGE_LIMITS.find(([limit]) => age < limit)?.[1] ?? AgeBucket.Older;
}

/** How an Activity action ended. Why it failed is English only (a code is still to come), so it is not sent. */
export const ReviewOutcome = { Ok: "ok", Failed: "failed" } as const;
export type ReviewOutcome = (typeof ReviewOutcome)[keyof typeof ReviewOutcome];

/** `harness_opened`'s properties. */
export type HarnessOpenedProperties = { via: HarnessOpenedVia };

/** `activity_loaded`'s properties. */
export type ActivityLoadedProperties = {
  outcome: ReviewOutcome;
  load_ms: number;
  /** Which load of this visit it was: 1 is the first. */
  attempt: number;
  runs_bucket: CountBucket;
  learned: number;
};

/** What a load of the feed found, when it found anything. */
export interface ActivityTally {
  runs: number;
  learned: number;
}

/** A load of Activity as `activity_loaded`; a failed one counts nothing. */
export function activityLoadedProperties(load: {
  tally: ActivityTally | null;
  startedAt: number;
  now: number;
  attempt: number;
}): ActivityLoadedProperties {
  const { tally } = load;
  return {
    outcome: tally ? ReviewOutcome.Ok : ReviewOutcome.Failed,
    load_ms: elapsedMs(load.startedAt, load.now),
    attempt: load.attempt,
    runs_bucket: countBucket(tally?.runs ?? 0),
    learned: tally?.learned ?? 0,
  };
}

/** `change_undone`'s properties. */
export type ChangeUndoneProperties = { age_bucket: AgeBucket; outcome: ReviewOutcome };

/** Undo on a learned change, as `change_undone`. */
export const changeUndoneProperties = (at: string | undefined, ok: boolean, now: number): ChangeUndoneProperties => ({
  age_bucket: ageBucket(at, now),
  outcome: ok ? ReviewOutcome.Ok : ReviewOutcome.Failed,
});
