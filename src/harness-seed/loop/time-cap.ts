/**
 * A Loop's hours are a soft cap, one rule for every kind of Loop: a reviewer's yes before the cap
 * ends it; `HEADS_UP_MS` before the cap the lead hears that little is left; at the cap it hears that
 * the time is up and no new worker starts; `GRACE_MS` after the cap Genex closes the Loop with what is
 * and isn't done. ∞ runs until the reviewer's yes, `UNTIL_DONE_CAP_MS` at most, with the same
 * wrap-up. A claim is never refused for time; a finish that claims nothing before the cap is (only
 * the person ends a timed Loop early). Plain numbers and pure functions, with no run of their own:
 * director/cap-lines.ts says the lines. A module no earlier harness had.
 */
import { timedWorkRemaining } from "./director/budgets.ts";
import { durationCommission } from "./director/commission.ts";
import { WrapCause } from "./director/wake-schedule.ts";
import type { FinishTally } from "./finish-check.ts";
import { HOUR_MS, MINUTE_MS } from "./time.ts";
import type { Run } from "../types/harness.d.ts";

/** The lead hears this long before its cap that little is left. */
export const HEADS_UP_MS = 15 * MINUTE_MS;
/** After its cap, a Loop's lead has this long to put the build together before Genex closes it. */
export const GRACE_MS = 15 * MINUTE_MS;
/** An ∞ Loop runs until a reviewer's yes, this long at most. */
export const UNTIL_DONE_CAP_MS = 24 * HOUR_MS;
/** A close this close to the working deadline counts as the time running out (a turn ends a margin early). */
const OUT_OF_TIME_MS = MINUTE_MS;

/**
 * A Loop's clock under the cap. `started` is when it would have started had it never paused (its
 * worked time is `now - started`); `softDeadline` is the cap; `finalDeadline` the end of the grace;
 * `headsUpAt` when the lead hears that little is left, or null (a short Loop, or one resumed past it).
 */
export interface CapClock {
  started: number;
  headsUpAt: number | null;
  softDeadline: number;
  finalDeadline: number;
}

/** Where a Loop stands against its cap. */
export const CapPhase = {
  Working: "working",
  HeadsUp: "heads_up",
  TimesUp: "times_up",
  Over: "over",
} as const;
export type CapPhase = (typeof CapPhase)[keyof typeof CapPhase];

/** How long the run had worked when its journal was last saved; none for a new run. */
function workedOf(saved: unknown): number {
  const worked = (saved as { workedMs?: unknown } | null | undefined)?.workedMs;
  return typeof worked === "number" && Number.isFinite(worked) && worked >= 0 ? worked : 0;
}

/**
 * The Loop's clock: the cap is its hours in working time (a Resume goes on with the time it had
 * left, never the wall clock), the grace comes after it, and the heads-up `HEADS_UP_MS` before it —
 * none for a Loop of `HEADS_UP_MS` or less. A Resume past the cap gets the grace only.
 */
export function capClock({ saved, now, totalMs }: { saved: unknown; now: number; totalMs: number }): CapClock {
  const worked = workedOf(saved);
  const started = now - worked;
  const cap = started + totalMs;
  if (worked > 0 && now >= cap) return { started, headsUpAt: null, softDeadline: now, finalDeadline: now + GRACE_MS };
  const headsUpAt = totalMs > HEADS_UP_MS ? cap - HEADS_UP_MS : null;
  return { started, headsUpAt, softDeadline: cap, finalDeadline: cap + GRACE_MS };
}

/** Where the Loop stands at `now` against its clock. */
export function capPhase(now: number, clock: CapClock): CapPhase {
  if (now >= clock.finalDeadline) return CapPhase.Over;
  if (now >= clock.softDeadline) return CapPhase.TimesUp;
  if (clock.headsUpAt !== null && now >= clock.headsUpAt) return CapPhase.HeadsUp;
  return CapPhase.Working;
}

/** A timed Loop's hours, as its result card says them (`stillToFixOf`); null for an ∞ or goal Loop. */
export function loopHoursOf(run: Pick<Run, "reference" | "budgets">): number | null {
  const total = run.budgets?.wallClockMs;
  const timed = durationCommission(run) && typeof total === "number" && Number.isFinite(total) && total > 0;
  return timed ? total / HOUR_MS : null;
}

/** A Loop's hours: an ∞ Loop's are `UNTIL_DONE_CAP_MS`, a timed one's its own. */
export function capHoursMs(run: Pick<Run, "budgets">, totalMs: number): number {
  return run.budgets?.untilSatisfied === true ? UNTIL_DONE_CAP_MS : totalMs;
}

/**
 * Whether a finish waits for the cap: one that claims nothing, in a timed Loop, before the cap, that
 * the person did not ask for. A claim is never refused for time: its reviewer decides.
 */
export function finishWaitsForCap(
  run: Pick<Run, "reference" | "budgets">,
  finishing: { softDeadline: number; now: number; userEnds: boolean; claims: boolean },
): boolean {
  if (finishing.claims) return false;
  return timedWorkRemaining(run, finishing.softDeadline, finishing.now, finishing.userEnds);
}

/** What a close reads of its run to tell whether its time ran out with no claim read. */
export interface ClosingRun {
  ctx: { cancelled?: boolean };
  softDeadline: number;
  state: { limit?: unknown; finishTally?: Partial<FinishTally> | null };
}

/** Whether no claim of the run reached a reviewer since it last opened: none was asked, none is under review, no no stands. */
export function noClaimRead(tally: Partial<FinishTally> | null | undefined): boolean {
  return !tally?.asked && !tally?.checking && !tally?.reasons?.length && !tally?.notDone?.length;
}

/**
 * A timed Loop's working time left at `now`, for its finish check: with more than the finish
 * contract's `FINISH_TIME_LEFT_MS` left, no row of the reviewer's no's stops it. Null for an ∞ Loop
 * (its no's stop it as they always have) and for one with no working deadline.
 */
export function timeLeftOf(run: Pick<Run, "reference" | "budgets">, softDeadline: number, now: number): number | null {
  if (!durationCommission(run) || !Number.isFinite(softDeadline)) return null;
  return Math.max(0, softDeadline - now);
}

/**
 * Whether a Loop closing at `at` closes as "not checked by a reviewer": its time ran out (`at` is at
 * its working deadline, less a minute), nothing else ended it (a Stop, a limit, a held turn, an idle
 * lead, the person's finish, a failed turn), and no claim reached a reviewer since it last opened.
 */
export function ranOutUnchecked(
  run: ClosingRun,
  close: { at: number; held: boolean; wrapCause: WrapCause | null },
): boolean {
  const { ctx, softDeadline, state } = run;
  if (ctx.cancelled || state.limit || close.held || !noClaimRead(state.finishTally)) return false;
  const { wrapCause } = close;
  if (wrapCause === WrapCause.Idle || wrapCause === WrapCause.Finish || wrapCause === WrapCause.Failed) return false;
  return close.at >= softDeadline - OUT_OF_TIME_MS;
}
