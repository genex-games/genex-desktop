/**
 * The loop's shared numbers: how long a command may take, how long a plan waits for the user,
 * how often a look is tried again. One place, so two modes that mean the same wait cannot drift
 * apart — the plan review's fifteen minutes used to be defined twice.
 *
 * What is NOT here on purpose: a mode's own policy (`FACET_POLICY` in facet-loop.ts, the
 * director's window and worker limits in director.ts). Those are the shape of one mode's work
 * and live beside the code that reads them.
 */
import { HOUR_MS, MINUTE_MS, SECOND_MS } from "./time.ts";

/**
 * How long a plan the user asked to read waits for their word before the run builds it as it
 * stands (WP7) — the classic pipeline's review window and the director's first `worker_start`.
 */
export const PLAN_REVIEW_WAIT_MS = 15 * MINUTE_MS;

/** How long a git command may take: `ref` for a ref write, `quick` for a read, `slow` for a merge or a commit. */
export const GIT_TIMEOUT_MS = Object.freeze({ ref: 30 * SECOND_MS, quick: MINUTE_MS, slow: 2 * MINUTE_MS });

/** A delegated turn is never given less than this: one asked to finish in seconds fails for the clock, not its work. */
export const MIN_DELEGATE_TIMEOUT_MS = MINUTE_MS;

/**
 * The effort a small, bounded ask runs at: a code review, a replan, the next move, a direct
 * playtester's move, a list of lessons. Always this, whatever effort the user set for a role or
 * the run: a playtest makes up to twenty of these asks, and a run at high judge effort must
 * not pay high effort for each of them.
 */
export const LIGHT_EFFORT = "low";

/**
 * The seed every evidence pass drives the game's randomness with, so two looks at a build — and
 * two builds — see the same world. Every mode uses this one number.
 */
export const PAGE_SEED = 1234;

/** A run's wall clock when its spec names none: a day (the classic run keeps its own, shorter one). */
export const DEFAULT_WALL_CLOCK_MS = 24 * HOUR_MS;

/** The longest run an interview can commission, in hours: also the ceiling of a run with no cap. */
export const MAX_RUN_HOURS = 24;
/** The shortest run an interview can commission, in hours. */
export const MIN_RUN_HOURS = 0.25;

/** A commissioned run's hours, held between `MIN_RUN_HOURS` and `MAX_RUN_HOURS`. */
export function clampRunHours(hours: number): number {
  return Math.min(MAX_RUN_HOURS, Math.max(MIN_RUN_HOURS, hours));
}

/** The most actions a play script may carry: a declared one is cut to it (kinds.ts), and so is a driven one. */
export const MAX_PLAY_SCRIPT = 24;
/** The longest a held key, a step or a wait of a play script may take. */
export const MAX_ACTION_MS = 8 * SECOND_MS;

/** The longest id a recipe may have: the library cuts a stored one to it, and a spike names its own within it. */
export const RECIPE_ID_CHARS = 64;

/** The rounds a direct engine's build turn may take in the harness's own tool loop. */
export const BUILD_TURN_MAX_ROUNDS = 30;

// ── how often a look is tried again (loop/evidence.ts) ──

/** A blind camera (an occluded window, a display asleep) recovers in minutes: the waits before each new look. */
export const OBSERVATION_RETRY_MS = Object.freeze([10 * SECOND_MS, 30 * SECOND_MS, MINUTE_MS]);
/** A page that was still coming up needs seconds, not a minute. */
export const RACE_RETRY_MS = Object.freeze([2 * SECOND_MS, 5 * SECOND_MS]);
/** The director's patient pass: how long before it looks again at a load that raced the window. */
export const LOAD_RACE_RETRY_MS = 8 * SECOND_MS;
/**
 * How long a pass waits for a window before it decides there is none. The pool has no queue —
 * `preview.acquire` throws the instant every window is leased — and a worker holds one only
 * while it looks at its own build, so asking again a few seconds later usually finds one. Four
 * asks, seven seconds in all: long enough to outlast one evidence pass, short enough that a
 * director is never quietly blocked.
 */
export const WINDOW_RETRIES_MS = Object.freeze([SECOND_MS, 2 * SECOND_MS, 4 * SECOND_MS]);
