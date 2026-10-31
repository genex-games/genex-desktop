/**
 * Play, as usage analytics follows it from the play store: a feed that could not be read, a game's
 * viewer opening and settling, a remix from press to its end, and native games installing and
 * being played. Play shows other people's games, so what leaves is counts, durations and Play's
 * own typed outcomes, never a slug, a title or a person. The pairing below (a slug to when it
 * started) stays in memory.
 */
import { MINUTE_MS } from "../../shared/duration.ts";
import { PlayCategory, type PlayRemixRefusal, type PlayShelf, PlayViewerPhase, RemixStep } from "../../shared/play.ts";
import {
  type InstallFailure,
  InstallPhase,
  type InstallProgress,
  type LaunchFailure,
  type NativeInstalls,
  type NativePlatform,
  type NativeSession,
  NativeSessionPhase,
} from "../../shared/play-native.ts";
import { type FeedState, FeedStatus, type ViewerShown } from "../play/play-model.ts";
import { RemixView, type RemixUnderway } from "../state/play.ts";
import { type CharsBucket, type CountBucket, charsBucket, countBucket, elapsedMs } from "./properties.ts";

/** How long something was played, in steps that say enough. */
export const PlayTimeBucket = {
  UnderMinute: "<1m",
  Minutes: "1-10m",
  Quarter: "10-60m",
  Hours: "1h+",
} as const;
export type PlayTimeBucket = (typeof PlayTimeBucket)[keyof typeof PlayTimeBucket];

const PLAY_TIME_LIMITS: ReadonlyArray<[number, PlayTimeBucket]> = [
  [MINUTE_MS, PlayTimeBucket.UnderMinute],
  [10 * MINUTE_MS, PlayTimeBucket.Minutes],
  [60 * MINUTE_MS, PlayTimeBucket.Quarter],
];

/** The bucket a play time falls in. */
export function playTimeBucket(ms: number): PlayTimeBucket {
  return PLAY_TIME_LIMITS.find(([limit]) => ms < limit)?.[1] ?? PlayTimeBucket.Hours;
}

/** `play_searched`'s properties: how long the words were and how many games came back, never the words. */
export type PlaySearchedProperties = {
  shelf: PlayShelf;
  query_chars_bucket: CharsBucket;
  results_bucket: CountBucket;
  failed: boolean;
};

/** A Play search's answer (null games: it failed) as `play_searched`. */
export const playSearchedProperties = (
  shelf: PlayShelf,
  query: string,
  games: number | null,
): PlaySearchedProperties => ({
  shelf,
  query_chars_bucket: charsBucket(query.trim().length),
  results_bucket: countBucket(games ?? 0),
  failed: games === null,
});

/** `play_feed_failed`'s properties: which tab, whether it was a further page, and whether the computer was online. */
export type FeedFailedProperties = { category: PlayCategory; more: boolean; online: boolean };

const isFailed = (feed: FeedState | undefined): boolean => feed?.status === FeedStatus.Failed;

/** The tabs whose read failed between two states: a first page shown failed, or a further page that failed. */
export function feedFailures(
  before: Partial<Record<PlayCategory, FeedState>>,
  after: Partial<Record<PlayCategory, FeedState>>,
  online: boolean,
): FeedFailedProperties[] {
  const failures: FeedFailedProperties[] = [];
  for (const category of Object.values(PlayCategory)) {
    const feed = after[category];
    const was = before[category];
    if (isFailed(feed) && !isFailed(was)) failures.push({ category, more: false, online });
    if (feed?.moreFailed && !was?.moreFailed) failures.push({ category, more: true, online });
  }
  return failures;
}

/** How a viewer's loading ended. */
export const ViewerOutcome = {
  Playing: "playing",
  Failed: "failed",
  /** Back pressed (or the viewer went) before the game showed. */
  ClosedWhileLoading: "closed_while_loading",
} as const;
export type ViewerOutcome = (typeof ViewerOutcome)[keyof typeof ViewerOutcome];

/** `play_viewer_settled`'s properties. */
export type ViewerSettledProperties = { outcome: ViewerOutcome; load_ms: number; retries: number; online: boolean };

/** The viewer being followed: its game (in memory only), when this attempt began, how many came before, and whether it settled. */
export interface ViewerWatch {
  slug: string;
  at: number;
  retries: number;
  settled: boolean;
}

/** What one viewer change means: the watch after it, a game newly opened, and a load that settled. */
export interface ViewerStep {
  watch: ViewerWatch | null;
  opened: boolean;
  settled: ViewerSettledProperties | null;
}

const SETTLED_PHASES: ReadonlySet<PlayViewerPhase> = new Set([PlayViewerPhase.Playing, PlayViewerPhase.Failed]);

/** Follow the viewer from one state to the next. */
export function viewerStep(
  watch: ViewerWatch | null,
  next: ViewerShown | null,
  now: number,
  online: boolean,
): ViewerStep {
  if (!next) {
    const left = watch && !watch.settled ? ViewerOutcome.ClosedWhileLoading : null;
    return { watch: null, opened: false, settled: left && watch ? settledOf(watch, left, now, online) : null };
  }
  if (watch?.slug !== next.slug)
    return { watch: { slug: next.slug, at: now, retries: 0, settled: false }, opened: true, settled: null };
  if (next.phase === PlayViewerPhase.Loading && watch.settled)
    return { watch: { ...watch, at: now, retries: watch.retries + 1, settled: false }, opened: false, settled: null };
  if (watch.settled || !SETTLED_PHASES.has(next.phase)) return { watch, opened: false, settled: null };
  const outcome = next.phase === PlayViewerPhase.Playing ? ViewerOutcome.Playing : ViewerOutcome.Failed;
  return { watch: { ...watch, settled: true }, opened: false, settled: settledOf(watch, outcome, now, online) };
}

const settledOf = (watch: ViewerWatch, outcome: ViewerOutcome, now: number, online: boolean) => ({
  outcome,
  load_ms: elapsedMs(watch.at, now),
  retries: watch.retries,
  online,
});

/** How a remix ended. */
export const RemixOutcome = {
  /** The new game opened in Create. */
  Opened: "opened",
  Failed: "failed",
  /** It went away without opening or failing. */
  Stopped: "stopped",
} as const;
export type RemixOutcome = (typeof RemixOutcome)[keyof typeof RemixOutcome];

/** `play_remix_finished`'s properties. */
export type RemixFinishedProperties = {
  outcome: RemixOutcome;
  refusal: PlayRemixRefusal | null;
  last_step: RemixStep;
  total_ms: number;
  /** The person went elsewhere while it was made. */
  set_aside: boolean;
  slowest_step: RemixStep | null;
};

/** A remix being followed: when it and its step began, how long each step took, and what happened to it. */
export interface RemixWatch {
  at: number;
  step: RemixStep;
  stepAt: number;
  steps: Partial<Record<RemixStep, number>>;
  setAside: boolean;
  opened: boolean;
  failed: boolean;
  refusal: PlayRemixRefusal | null;
}

/** The part of Play's state a remix is read from. */
export interface RemixState {
  making: RemixUnderway | null;
  remixFailed: boolean;
  remixRefusal: PlayRemixRefusal | null;
}

/** Follow a remix from one state to the next: the watch after it, and the remix that finished. */
export function remixStep(
  watch: RemixWatch | null,
  state: RemixState,
  now: number,
): { watch: RemixWatch | null; finished: RemixFinishedProperties | null } {
  const { making } = state;
  if (!making) return { watch: null, finished: watch ? remixFinished(watch, now) : null };
  const current = watch ?? remixBegun(making.step, now);
  const moved = current.step === making.step ? current : stepMoved(current, making.step, now);
  return {
    watch: {
      ...moved,
      setAside: moved.setAside || making.view === RemixView.Aside,
      opened: moved.opened || making.view === RemixView.Opening,
      failed: moved.failed || state.remixFailed,
      refusal: state.remixRefusal ?? moved.refusal,
    },
    finished: null,
  };
}

const remixBegun = (step: RemixStep, now: number): RemixWatch => ({
  at: now,
  step,
  stepAt: now,
  steps: {},
  setAside: false,
  opened: false,
  failed: false,
  refusal: null,
});

/** The step the remix left, with its time added, and the one it is on now. */
function stepMoved(watch: RemixWatch, step: RemixStep, now: number): RemixWatch {
  const spent = (watch.steps[watch.step] ?? 0) + elapsedMs(watch.stepAt, now);
  return { ...watch, steps: { ...watch.steps, [watch.step]: spent }, step, stepAt: now };
}

function remixFinished(watch: RemixWatch, now: number): RemixFinishedProperties {
  const ended = stepMoved(watch, watch.step, now);
  return {
    outcome: remixOutcome(watch),
    refusal: watch.refusal,
    last_step: watch.step,
    total_ms: elapsedMs(watch.at, now),
    set_aside: watch.setAside,
    slowest_step: slowestStep(ended.steps),
  };
}

function remixOutcome(watch: RemixWatch): RemixOutcome {
  if (watch.opened) return RemixOutcome.Opened;
  return watch.failed ? RemixOutcome.Failed : RemixOutcome.Stopped;
}

function slowestStep(steps: Partial<Record<RemixStep, number>>): RemixStep | null {
  let slowest: { step: RemixStep; ms: number } | null = null;
  for (const step of Object.values(RemixStep)) {
    const ms = steps[step];
    if (ms !== undefined && (!slowest || ms > slowest.ms)) slowest = { step, ms };
  }
  return slowest?.step ?? null;
}

/** `native_install_finished`'s properties. */
export type InstallFinishedProperties = {
  phase: InstallPhase;
  failure: InstallFailure | null;
  /** From when this window first saw the install under way; null when it never saw it begin. */
  install_ms: number | null;
  /** An install of the same game failed earlier in this launch. */
  retry: boolean;
  platform: NativePlatform | null;
};

const ENDED: ReadonlySet<InstallPhase> = new Set([InstallPhase.Ready, InstallPhase.Failed, InstallPhase.Cancelled]);

/** The installs being followed, by game (in memory only): when each began, and the games whose install failed. */
export interface InstallsWatch {
  started: ReadonlyMap<string, number>;
  failed: ReadonlySet<string>;
}

/** Nothing followed yet. */
export const NO_INSTALLS_WATCH: InstallsWatch = { started: new Map(), failed: new Set() };

/** How an install that left the list ended: ready when its game is installed now, else cancelled. */
function leftPhase(progress: InstallProgress, after: NativeInstalls): InstallProgress {
  const installed = after.installed.some((game) => game.slug === progress.slug);
  return { ...progress, phase: installed ? InstallPhase.Ready : InstallPhase.Cancelled, failure: null };
}

/** The installs that ended between two reads of what is installed, and the watch after them. */
export function installsStep(
  watch: InstallsWatch,
  before: NativeInstalls,
  after: NativeInstalls,
  now: number,
): { watch: InstallsWatch; finished: InstallFinishedProperties[] } {
  const started = new Map(watch.started);
  for (const slug of begunInstalls(before, after)) if (!started.has(slug)) started.set(slug, now);
  const failed = new Set(watch.failed);
  const platform = after.host?.platform ?? null;
  const finished = endedInstalls(before, after).map((progress): InstallFinishedProperties => {
    const at = started.get(progress.slug);
    const retry = failed.has(progress.slug);
    started.delete(progress.slug);
    if (progress.phase === InstallPhase.Failed) failed.add(progress.slug);
    return {
      phase: progress.phase,
      failure: progress.phase === InstallPhase.Failed ? progress.failure : null,
      install_ms: at === undefined ? null : elapsedMs(at, now),
      retry,
      platform,
    };
  });
  return { watch: { started, failed }, finished };
}

const progressOf = (installs: NativeInstalls, slug: string): InstallProgress | undefined =>
  installs.progress.find((progress) => progress.slug === slug);

/** The games whose install began between two reads: under way now, and not before (or ended before). */
function begunInstalls(before: NativeInstalls, after: NativeInstalls): string[] {
  return after.progress
    .filter((progress) => {
      const was = progressOf(before, progress.slug);
      return !ENDED.has(progress.phase) && (!was || ENDED.has(was.phase));
    })
    .map((progress) => progress.slug);
}

/** The installs that ended between two reads: ended in the list, or gone from it while under way. */
function endedInstalls(before: NativeInstalls, after: NativeInstalls): InstallProgress[] {
  const ended = after.progress.filter((progress) => {
    const was = progressOf(before, progress.slug);
    return ENDED.has(progress.phase) && was !== undefined && !ENDED.has(was.phase);
  });
  const gone = before.progress.filter((was) => !ENDED.has(was.phase) && !progressOf(after, was.slug));
  return [...ended, ...gone.map((was) => leftPhase(was, after))];
}

/** `native_game_session_ended`'s properties. */
export type SessionEndedProperties = {
  phase: NativeSessionPhase;
  failure: LaunchFailure | null;
  play_ms_bucket: PlayTimeBucket;
};

const sessionKey = (session: Pick<NativeSession, "slug" | "startedAt">): string =>
  `${session.slug}\n${session.startedAt}`;

function sessionEnded(session: NativeSession, now: number): SessionEndedProperties {
  const started = Date.parse(session.startedAt);
  return {
    phase: session.phase,
    failure: session.failure,
    play_ms_bucket: playTimeBucket(Number.isFinite(started) ? elapsedMs(started, now) : 0),
  };
}

/** The native sessions that ended between two reads: gone from the list, or failed to start. */
export function sessionsEnded(
  before: readonly NativeSession[],
  after: readonly NativeSession[],
  now: number,
): SessionEndedProperties[] {
  const was = new Map(before.map((session) => [sessionKey(session), session]));
  const is = new Map(after.map((session) => [sessionKey(session), session]));
  const ended: SessionEndedProperties[] = [];
  for (const [key, session] of was)
    if (!is.has(key) && session.phase !== NativeSessionPhase.Failed) ended.push(sessionEnded(session, now));
  for (const [key, session] of is) {
    const failedNow = session.phase === NativeSessionPhase.Failed && was.get(key)?.phase !== NativeSessionPhase.Failed;
    if (failedNow) ended.push(sessionEnded(session, now));
  }
  return ended;
}
