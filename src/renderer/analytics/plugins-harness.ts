/**
 * The Harness room (Activity) as usage analytics reads it: how people got there, whether its feed
 * loads, what they decide about Harness's suggestions and learned changes, and whether Look for
 * improvements finds anything. Suggestions and changes are the agent's words about the person's
 * work: only counts, ages and outcomes leave.
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
export type HarnessOpenedProperties = { via: HarnessOpenedVia; staged_count: CountBucket };

/** `activity_loaded`'s properties. */
export type ActivityLoadedProperties = {
  outcome: ReviewOutcome;
  load_ms: number;
  /** Which load of this visit it was: 1 is the first. */
  attempt: number;
  runs_bucket: CountBucket;
  staged: number;
  learned: number;
};

/** What a load of the feed found, when it found anything. */
export interface ActivityTally {
  runs: number;
  staged: number;
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
    staged: tally?.staged ?? 0,
    learned: tally?.learned ?? 0,
  };
}

/** What the person did with the suggestions. */
export const SuggestionDecision = { Apply: "apply", Discard: "discard" } as const;
export type SuggestionDecision = (typeof SuggestionDecision)[keyof typeof SuggestionDecision];

/** `suggestions_decided`'s properties. */
export type SuggestionsDecidedProperties = {
  decision: SuggestionDecision;
  count: number;
  /** Suggestions the person unticked and left waiting. */
  excluded: number;
  /** The person opened a suggestion's details before deciding. */
  opened_details: boolean;
  outcome: ReviewOutcome;
  oldest_age_bucket: AgeBucket;
};

/** Apply or Discard on the suggestions, as `suggestions_decided`. */
export function suggestionsDecidedProperties(decided: {
  decision: SuggestionDecision;
  chosen: readonly { at?: string }[];
  waiting: number;
  openedDetails: boolean;
  ok: boolean;
  now: number;
}): SuggestionsDecidedProperties {
  const oldest = decided.chosen.reduce<string | undefined>((first, { at }) => {
    if (!at) return first;
    return !first || at < first ? at : first;
  }, undefined);
  return {
    decision: decided.decision,
    count: decided.chosen.length,
    excluded: Math.max(0, decided.waiting - decided.chosen.length),
    opened_details: decided.openedDetails,
    outcome: decided.ok ? ReviewOutcome.Ok : ReviewOutcome.Failed,
    oldest_age_bucket: ageBucket(oldest, decided.now),
  };
}

/** `change_undone`'s properties. */
export type ChangeUndoneProperties = { age_bucket: AgeBucket; outcome: ReviewOutcome };

/** Undo on a learned change, as `change_undone`. */
export const changeUndoneProperties = (at: string | undefined, ok: boolean, now: number): ChangeUndoneProperties => ({
  age_bucket: ageBucket(at, now),
  outcome: ok ? ReviewOutcome.Ok : ReviewOutcome.Failed,
});

/** What Look for improvements came to. */
export const ImprovementResult = {
  /** New suggestions wait for review. */
  Found: "found",
  /** Improvements were applied without review. */
  Added: "added",
  None: "none",
  Failed: "failed",
} as const;
export type ImprovementResult = (typeof ImprovementResult)[keyof typeof ImprovementResult];

/** `improvement_check_finished`'s properties. */
export type ImprovementCheckProperties = {
  result: ImprovementResult;
  found: number;
  applied: number;
  duration_ms: number;
};

/** A finished look, by the counts before and after it (null after: it failed), as `improvement_check_finished`. */
export function improvementCheckProperties(check: {
  before: { staged: number; learned: number };
  after: { staged: number; learned: number } | null;
  startedAt: number;
  now: number;
}): ImprovementCheckProperties {
  const { before, after } = check;
  const found = after ? Math.max(0, after.staged - before.staged) : 0;
  const applied = after ? Math.max(0, after.learned - before.learned) : 0;
  return {
    result: improvementResult(after !== null, found, applied),
    found,
    applied,
    duration_ms: elapsedMs(check.startedAt, check.now),
  };
}

function improvementResult(finished: boolean, found: number, applied: number): ImprovementResult {
  if (!finished) return ImprovementResult.Failed;
  if (found > 0) return ImprovementResult.Found;
  return applied > 0 ? ImprovementResult.Added : ImprovementResult.None;
}
