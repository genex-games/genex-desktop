/**
 * A game chat's review records read back from its log: the newest Fix with agent press
 * (`genex_review_fix`) and what became of it (`genex_review` with `sent` after a fix, `not_built`,
 * `fix_stopped` or `fixed_web`), and whether the agent's work on it has ended. Main reads it once a
 * run ends to publish by itself; the chat's review card reads it for "Fixing", "Your agent stopped"
 * and the rest. Typed fields only: never the words of a message.
 */
import { CustomEvent, customPayload } from "./custom-events.ts";
import { type EventEnvelope, EventKind } from "./event-log.ts";
import {
  GenexFixKind,
  GenexGameReview,
  type GenexReviewApp,
  GenexReviewChange,
  type GenexReviewFixPayload,
  type GenexReviewPayload,
  type GenexReviewRecord,
  worstApps,
} from "./genex-review.ts";
import { ExecutionStatus } from "./run-state.ts";

/** The changes that end a fix press: Studio sent the app again, or said why it did not. */
const FIX_OUTCOMES: ReadonlySet<string> = new Set([
  GenexReviewChange.Sent,
  GenexReviewChange.NotBuilt,
  GenexReviewChange.FixStopped,
  GenexReviewChange.FixedWeb,
]);

const FIX_KINDS: ReadonlySet<unknown> = new Set(Object.values(GenexFixKind));

/**
 * The changes that tell which build of an app Genex has after a fix went again: the first of them for
 * each app is the build the fix's own send took (a request is about the build already there).
 */
const BUILD_TOLD: ReadonlySet<string> = new Set([
  GenexReviewChange.Sent,
  GenexReviewChange.Live,
  GenexReviewChange.NotApproved,
  GenexReviewChange.WithPerson,
]);

/** One build of an app, as a review record names it. */
export interface GenexBuildMark {
  version: string;
  sha256?: string;
  sentAt?: string;
}

/** The newest fix press of a game and what became of it. */
export interface GenexFixState {
  fixId: string;
  kind: GenexFixKind;
  count: number;
  /** Studio publishes (or asks a person) by itself once the agent is done; false once the person said not to. */
  autoPublish: boolean;
  at: string;
  /** Where the press's record sits in the log. */
  index: number;
  /** What ended it, once something did. */
  outcome?: GenexReviewChange;
  /** When it ended. */
  outcomeAt?: string;
  /**
   * After the fix went again (`outcome` sent), the first build of each app (`platform/arch`) the host
   * told of since: the build that send took.
   */
  sentBuilds?: Record<string, GenexBuildMark>;
}

/** A fix record as read: every field it must have, or null. */
function fixOf(payload: Partial<GenexReviewFixPayload> | null): Omit<GenexFixState, "index"> | null {
  if (!payload || typeof payload.fixId !== "string" || !FIX_KINDS.has(payload.kind)) return null;
  return {
    fixId: payload.fixId,
    kind: payload.kind as GenexFixKind,
    count: typeof payload.count === "number" ? payload.count : 0,
    autoPublish: payload.autoPublish === true,
    at: typeof payload.at === "string" ? payload.at : "",
  };
}

/** Whether a review record is about `project` (a record with none is the chat's own game). */
const about = (payload: { project?: unknown } | null, project: string | undefined): boolean =>
  project === undefined || payload?.project === undefined || payload.project === project;

/**
 * The newest fix press in `events` for `project`, with its auto step as the person last left it and
 * its outcome; null before any press.
 */
export function newestFix(events: readonly EventEnvelope[], project?: string): GenexFixState | null {
  const found: { fix: GenexFixState | null } = { fix: null };
  for (const [index, event] of events.entries()) {
    const pressed = customPayload(event.data, CustomEvent.GenexReviewFix);
    if (pressed && about(pressed, project)) {
      const read = fixOf(pressed);
      if (read) found.fix = pressedAgain(found.fix, read, index);
      continue;
    }
    const review = customPayload(event.data, CustomEvent.GenexReview);
    const fix = found.fix;
    if (fix && review && about(review, project)) noteReview(fix, review);
  }
  return found.fix;
}

/** A review record after `fix`: its outcome, or, once it went again, the first build told of each app. */
function noteReview(fix: GenexFixState, review: Partial<GenexReviewPayload>): void {
  if (!fix.outcome) {
    if (!isOutcome(review)) return;
    fix.outcome = review.change;
    if (typeof review.at === "string") fix.outcomeAt = review.at;
    return;
  }
  if (fix.outcome !== GenexReviewChange.Sent || review.recheck === true) return;
  const mark = buildTold(review);
  // A record of the build the fix replaced, told before the new one landed, names no build of the fix's.
  if (!mark || !sentAfter(mark.build.sentAt, fix.at)) return;
  const builds = fix.sentBuilds ?? {};
  if (!builds[mark.key]) builds[mark.key] = mark.build;
  fix.sentBuilds = builds;
}

/** The build a record tells Genex has of an app, by its key; null for a record that names none. */
function buildTold(review: Partial<GenexReviewPayload>): { key: string; build: GenexBuildMark } | null {
  const app = review.app;
  if (!app || typeof review.change !== "string" || !BUILD_TOLD.has(review.change)) return null;
  if (typeof app.platform !== "string" || typeof app.arch !== "string" || typeof app.version !== "string") return null;
  const sentAt = typeof app.sentAt === "string" ? app.sentAt : undefined;
  const sha256 = typeof app.sha256 === "string" ? app.sha256 : undefined;
  return {
    key: pairKey(app),
    build: { version: app.version, ...(sha256 ? { sha256 } : {}), ...(sentAt ? { sentAt } : {}) },
  };
}

/** The key an app's build is kept by among a fix's sent builds. */
const pairKey = (app: { platform: string; arch: string }): string => `${app.platform}/${app.arch}`;

/** Whether a build sent at `sentAt` went after a press at `pressedAt`; a build with no time may have. */
const sentAfter = (sentAt: string | undefined, pressedAt: string): boolean => {
  const sent = Date.parse(sentAt ?? "");
  const pressed = Date.parse(pressedAt);
  return !Number.isFinite(sent) || !Number.isFinite(pressed) || sent > pressed;
};

/** Whether two marks name the same build: by its archive when both say, else when it was sent, else its version. */
function sameBuild(one: GenexBuildMark, other: GenexBuildMark): boolean {
  if (one.sha256 && other.sha256) return one.sha256 === other.sha256;
  if (one.sentAt && other.sentAt) return Date.parse(one.sentAt) === Date.parse(other.sentAt);
  return one.version === other.version;
}

/**
 * Whether `app` is the build `fix` sent again by itself: sent after the press, and the first build of
 * its app told since (or none told yet). A later publish of the app, by hand or weeks on, is not it:
 * Genex checks that one, not "your fixes".
 */
export function sentByFix(
  fix: GenexFixState | null,
  app: Pick<GenexReviewApp, "platform" | "arch" | "version" | "sha256" | "sentAt">,
): boolean {
  if (fix?.outcome !== GenexReviewChange.Sent || !sentAfter(app.sentAt, fix.at)) return false;
  const first = fix.sentBuilds?.[pairKey(app)];
  return !first || sameBuild(first, app);
}

/** Whether a decision at `at` came after a press at `pressedAt`: a time Genex did not give never did. */
const decidedAfter = (at: string | undefined, pressedAt: string): boolean =>
  Date.parse(at ?? "") > Date.parse(pressedAt);

/**
 * Whether Genex still says what `fix` was pressed about: the same takedown, or the same turned-down
 * apps, with nothing sent or decided since the press. How a fix ended (stopped, not built, fixed)
 * says nothing once Genex has moved on: a later publish, a decision, a takedown lifted or a new one.
 */
export function fixStillCurrent(fix: GenexFixState, record: GenexReviewRecord | null): boolean {
  if (!record) return false;
  if (fix.kind !== GenexFixKind.App) return record.takedown !== null && !decidedAfter(record.takedown.at, fix.at);
  if (record.takedown || record.state !== GenexGameReview.NotApproved) return false;
  return worstApps(record).every((app) => !decidedAfter(app.decidedAt ?? app.sentAt, fix.at));
}

/** A press read after `fix`: the same press again is "Don't publish it automatically", any other a new press. */
function pressedAgain(fix: GenexFixState | null, read: Omit<GenexFixState, "index">, index: number): GenexFixState {
  return fix && read.fixId === fix.fixId ? { ...fix, autoPublish: read.autoPublish } : { ...read, index };
}

/** Whether a review record ends a fix press. */
const isOutcome = (
  review: Partial<GenexReviewPayload>,
): review is Partial<GenexReviewPayload> & {
  change: GenexReviewChange;
} =>
  typeof review.change === "string" &&
  FIX_OUTCOMES.has(review.change) &&
  (review.change !== GenexReviewChange.Sent || review.recheck === true);

/** How the agent's work on a fix ended: done, or stopped before it finished. */
export const FixEnd = { Done: "done", Stopped: "stopped" } as const;
export type FixEnd = (typeof FixEnd)[keyof typeof FixEnd];

const STOPPED_RUN: ReadonlySet<unknown> = new Set([ExecutionStatus.Cancelled, ExecutionStatus.Failed]);

/**
 * How the agent's work on `fix` ended, once it has: every build it started after the press closed
 * (not paused), else, with no build, the first chat turn that started after the press ended. Null
 * while it still works.
 */
export function fixWorkEnded(events: readonly EventEnvelope[], fix: GenexFixState): FixEnd | null {
  const after = events.slice(fix.index + 1);
  const started = new Set<string>();
  let lastRun: string | undefined;
  const closed = new Set<string>();
  for (const event of after) {
    const start = customPayload(event.data, CustomEvent.RunStarted);
    if (typeof start?.runId === "string") started.add(start.runId);
    const close = customPayload(event.data, CustomEvent.RunFinished);
    const paused = close?.paused === true || close?.executionStatus === ExecutionStatus.Paused;
    if (typeof close?.runId === "string" && !paused) {
      closed.add(close.runId);
      lastRun = close.executionStatus;
    }
  }
  if (started.size > 0) {
    if (![...started].every((runId) => closed.has(runId))) return null;
    return STOPPED_RUN.has(lastRun) ? FixEnd.Stopped : FixEnd.Done;
  }
  return turnEnded(after);
}

/** How the first turn that started in `events` ended, or null while it runs. */
function turnEnded(events: readonly EventEnvelope[]): FixEnd | null {
  const turn = events.find((event) => event.data.type === EventKind.TurnStarted)?.turn_id;
  if (!turn) return null;
  const end = events.find((event) => event.data.type === EventKind.TurnEnded && event.turn_id === turn);
  if (!end || end.data.type !== EventKind.TurnEnded) return null;
  return end.data.status === undefined || end.data.status === "ok" ? FixEnd.Done : FixEnd.Stopped;
}
