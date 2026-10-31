/**
 * Launch, errors and updates (plan §1.1): what a launch costs, what breaks the window, and whether
 * an update is taken.
 *
 * An error is told by its kind, its built-in type and a fingerprint of where it was thrown (the top
 * stack frames, file names and positions only), never by its message, which can quote anything.
 * Long tasks are summed every few minutes, by screen. What a boot screen or the session before
 * this one would add comes from main with the first bootstrap (`Bootstrap.launch`), and main's own
 * errors and a hung window as `UiEvent.AppDiagnostic`: typed facts only, each re-checked here.
 */
import { MainDiagnostic, RendererGone, SessionExit } from "../../../shared/app-session.ts";
import {
  type ReadyUpdate,
  RestartAnswer,
  type UpdateAction,
  type UpdateCheckResult,
  UpdateCheckStatus,
  UpdateFailure,
} from "../../../shared/app-update.ts";
import { BootFailure, type BootFailureCode, SandboxProblemCode, StartPassage } from "../../../shared/boot.ts";
import { DAY_MS, HOUR_MS, MINUTE_MS } from "../../../shared/duration.ts";
import { EngineStatusCode } from "../../../shared/engine-descriptor.ts";
import { isStudioErrorCode, type StudioErrorCode } from "../../../shared/error-codes.ts";
import { UiEvent } from "../../../shared/ui-events.ts";
import { type SessionState, SessionStatus } from "../../state/session.ts";
import type { Studio } from "../../state/studio.ts";
import { ToastTone, type ToastsState } from "../../state/toasts.ts";
import { guarded, track } from "../client.ts";
import type { AreaObservers } from "../observers.ts";
import { type CountBucket, countBucket, elapsedMs, oneOf } from "../properties.ts";
import { currentScreen } from "../screens.ts";

/** How often the long tasks seen are summed and sent, while there were any. */
export const STALL_SUMMARY_MS = 5 * MINUTE_MS;
/** How many stack frames make an error's fingerprint. */
const FINGERPRINT_FRAMES = 5;
/** How many times one error (by fingerprint) is sent in a launch: a loop that throws is one problem. */
const ERROR_REPEATS_MAX = 3;
/** The longest hang a window reports: anything longer is not a measure. */
const HANG_MAX_MS = DAY_MS;

export const LaunchEvent = {
  AppReadyMeasured: "app_ready_measured",
  WorkspaceLoadRetried: "workspace_load_retried",
  AppErrorCaught: "app_error_caught",
  ErrorScreenAction: "error_screen_action",
  UiStallSummarized: "ui_stall_summarized",
  DiagnosticsCopied: "diagnostics_copied",
  UpdateReady: "update_ready",
  UpdateRestartPressed: "update_restart_pressed",
  UpdateCheckFinished: "update_check_finished",
  ErrorToastShown: "error_toast_shown",
  PreviousSessionEnded: "previous_session_ended",
  UpdateBackgroundFailed: "update_background_failed",
  AgentsStartFailed: "agents_start_failed",
  WindowUnresponsive: "window_unresponsive",
} as const;

/** Where an error was caught. */
export const ErrorKind = {
  /** Thrown while rendering: the error screen took the window. */
  Render: "render",
  Uncaught: "uncaught",
  /** A promise rejected with nothing to catch it. */
  Rejection: "rejection",
} as const;
export type ErrorKind = (typeof ErrorKind)[keyof typeof ErrorKind];

/** The process an error was caught in: the window's, or main's own (`UiEvent.AppDiagnostic`). */
export const ErrorProcess = { Renderer: "renderer", Main: "main" } as const;
export type ErrorProcess = (typeof ErrorProcess)[keyof typeof ErrorProcess];

/** What the error screen offers. */
export const ErrorScreenAction = { Reload: "reload", Copy: "copy" } as const;
export type ErrorScreenAction = (typeof ErrorScreenAction)[keyof typeof ErrorScreenAction];

/** Where Relaunch to update was pressed. */
export const UpdateSurface = { Sidebar: "sidebar", About: "about" } as const;
export type UpdateSurface = (typeof UpdateSurface)[keyof typeof UpdateSurface];

/** What Relaunch came to: main's answer (`RestartAnswer`), or failed when the call itself did. */
export const RestartOutcome = { ...RestartAnswer, Failed: "failed" } as const;
export type RestartOutcome = (typeof RestartOutcome)[keyof typeof RestartOutcome];

/** A Check for Updates whose call itself failed, beside the statuses main answers. */
export const CHECK_CALL_FAILED = "ipc_failed";

/** The error types a report may name: JavaScript's own. Anything else is "other". */
export const ERROR_TYPES: ReadonlySet<string> = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "EvalError",
  "URIError",
  "AggregateError",
  "AbortError",
]);
const OTHER_TYPE = "other";

export type LaunchEventProperties = {
  [LaunchEvent.AppReadyMeasured]: AppReadyProperties;
  [LaunchEvent.WorkspaceLoadRetried]: WorkspaceRetriedProperties;
  [LaunchEvent.AppErrorCaught]: AppErrorProperties;
  [LaunchEvent.ErrorScreenAction]: { action: ErrorScreenAction };
  [LaunchEvent.UiStallSummarized]: StallSummaryProperties;
  [LaunchEvent.DiagnosticsCopied]: { ok: boolean };
  [LaunchEvent.UpdateReady]: { action: UpdateAction; at_bootstrap: boolean };
  [LaunchEvent.UpdateRestartPressed]: {
    surface: UpdateSurface;
    /** Null when main answered something that is not a `RestartAnswer`. */
    outcome: RestartOutcome | null;
    waited_ms: number | null;
  };
  [LaunchEvent.UpdateCheckFinished]: UpdateCheckProperties;
  [LaunchEvent.ErrorToastShown]: ErrorToastProperties;
  [LaunchEvent.PreviousSessionEnded]: PreviousSessionProperties;
  [LaunchEvent.UpdateBackgroundFailed]: { stage: UpdateFailure | null };
  [LaunchEvent.AgentsStartFailed]: { code: BootFailureCode | null };
  [LaunchEvent.WindowUnresponsive]: { duration_ms: number | null };
};

/** How long the session before this one ran, in steps that say enough. */
export const UptimeBucket = {
  UnderMinute: "0-1m",
  Minutes: "1-10m",
  Hour: "10-60m",
  Hours: "1-4h",
  Long: "4h+",
} as const;
export type UptimeBucket = (typeof UptimeBucket)[keyof typeof UptimeBucket];

const UPTIME_LIMITS: ReadonlyArray<[number, UptimeBucket]> = [
  [MINUTE_MS, UptimeBucket.UnderMinute],
  [10 * MINUTE_MS, UptimeBucket.Minutes],
  [HOUR_MS, UptimeBucket.Hour],
  [4 * HOUR_MS, UptimeBucket.Hours],
];

/** The bucket an uptime falls in, or null when it is not a duration. */
export function uptimeBucket(ms: unknown): UptimeBucket | null {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return null;
  return UPTIME_LIMITS.find(([limit]) => ms < limit)?.[1] ?? UptimeBucket.Long;
}

/** Fields of something main handed over, read as unknown. */
const isRecord = (value: unknown): value is { readonly [field: string]: unknown } =>
  typeof value === "object" && value !== null;

/** A count main handed over: a whole number from 0, else 0. */
const countOf = (value: unknown): number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;

/** `previous_session_ended`'s properties. */
export type PreviousSessionProperties = {
  exit: SessionExit;
  renderer_crashes: CountBucket;
  last_crash_reason: RendererGone | null;
  hangs: CountBucket;
  main_errors: CountBucket;
  update_failures: CountBucket;
  uptime_bucket: UptimeBucket | null;
};

/** How the previous session ended (`LaunchFacts.previous`), re-checked; null when it says no known end. */
export function previousSessionProperties(previous: unknown): PreviousSessionProperties | null {
  if (!isRecord(previous)) return null;
  const exit = oneOf(SessionExit, previous.exit);
  if (!exit) return null;
  return {
    exit,
    renderer_crashes: countBucket(countOf(previous.rendererCrashes)),
    last_crash_reason: oneOf(RendererGone, previous.lastCrash),
    hangs: countBucket(countOf(previous.hangs)),
    main_errors: countBucket(countOf(previous.mainErrors)),
    update_failures: countBucket(countOf(previous.updateFailures)),
    uptime_bucket: uptimeBucket(previous.uptimeMs),
  };
}

/** A held start's code, re-checked: the boot's own, or the sandbox's. */
export const bootFailureCode = (value: unknown): BootFailureCode | null =>
  oneOf(BootFailure, value) ?? oneOf(SandboxProblemCode, value);

/** `app_ready_measured`'s start facts. */
export type StartProperties = {
  start_passed: StartPassage[];
  start_failure: BootFailureCode | null;
  start_retries: CountBucket;
};

/** How this launch started (`LaunchFacts.start`), re-checked; null when there is nothing to read. */
export function startProperties(start: unknown): StartProperties | null {
  if (!isRecord(start)) return null;
  const steps: readonly unknown[] = Array.isArray(start.passed) ? start.passed : [];
  const passed = steps.map((step) => oneOf(StartPassage, step)).filter((step) => step !== null);
  return {
    start_passed: [...new Set(passed)],
    start_failure: bootFailureCode(start.failure),
    start_retries: countBucket(countOf(start.retries)),
  };
}

/** `update_background_failed`: the stage an update the app looked for on its own failed at. */
export const updateFailedProperties = (payload: unknown): { stage: UpdateFailure | null } => ({
  stage: isRecord(payload) ? oneOf(UpdateFailure, payload.stage) : null,
});

/** `agents_start_failed`: why an open studio's agents would not start, as its code. */
export const agentsStartFailedProperties = (payload: unknown): { code: BootFailureCode | null } => ({
  code: isRecord(payload) ? bootFailureCode(payload.failureCode) : null,
});

/** Main's own error kinds, as the window's error kinds name them. */
const MAIN_ERROR_KIND = {
  [MainDiagnostic.Uncaught]: ErrorKind.Uncaught,
  [MainDiagnostic.Rejection]: ErrorKind.Rejection,
} as const;

/** One of main's own errors as `app_error_caught`: its kind and built-in type; null for anything else. */
export function mainErrorProperties(payload: unknown): AppErrorProperties | null {
  if (!isRecord(payload)) return null;
  const kind = oneOf(MainDiagnostic, payload.kind);
  if (kind === null || kind === MainDiagnostic.Unresponsive) return null;
  return {
    process: ErrorProcess.Main,
    kind: MAIN_ERROR_KIND[kind],
    error_type: errorType({ name: payload.errorType }),
    fatal: false,
    fingerprint: null,
  };
}

/** A window that answered again as `window_unresponsive`; null for any other diagnostic. */
export function unresponsiveProperties(payload: unknown): { duration_ms: number | null } | null {
  if (!isRecord(payload) || payload.kind !== MainDiagnostic.Unresponsive) return null;
  const ms = payload.durationMs;
  const measured = typeof ms === "number" && Number.isFinite(ms) && ms >= 0 && ms <= HANG_MAX_MS;
  return { duration_ms: measured ? Math.round(ms) : null };
}

/** `error_toast_shown`'s properties: the failure's code (null when it had none) and the screen it showed on. */
export type ErrorToastProperties = { code: StudioErrorCode | null; screen: string };

/** The error toasts added since `before`, as `error_toast_shown`. */
export function errorToastsShown(
  before: Pick<ToastsState, "lastId">,
  after: ToastsState,
  screen: string,
): ErrorToastProperties[] {
  return after.items
    .filter((toast) => toast.id > before.lastId && toast.tone === ToastTone.Error)
    .map((toast) => ({ code: isStudioErrorCode(toast.code) ? toast.code : null, screen }));
}

/** `workspace_load_retried`'s properties: which Retry of this launch, whether it loaded, and how long it took. */
export type WorkspaceRetriedProperties = { attempt: number; succeeded: boolean; elapsed_ms: number };

/** `update_check_finished`'s properties. */
export type UpdateCheckProperties = { status: UpdateCheckStatus | typeof CHECK_CALL_FAILED; duration_ms: number };

/** `app_error_caught`'s properties. */
export type AppErrorProperties = {
  process: ErrorProcess;
  kind: ErrorKind;
  error_type: string;
  fatal: boolean;
  /** 8 hex digits from the top stack frames; null when there is no stack to read. */
  fingerprint: string | null;
};

/** A thrown value's type: a built-in error's name, else "other". */
export function errorType(error: unknown): string {
  const name = error instanceof Error || isNamed(error) ? error.name : null;
  return name && ERROR_TYPES.has(name) ? name : OTHER_TYPE;
}

const isNamed = (value: unknown): value is { name: string } =>
  typeof value === "object" && value !== null && "name" in value && typeof value.name === "string";

/** A frame's place: a file's name with its line and column, everything before the last slash dropped. */
const PLACE = /(?:[a-z][\w+.-]*:\/\/)?(?:[^\s()]*[\\/])?([^\s()\\/?#]+?)(?:[?#][^\s():]*)?:(\d+):(\d+)/gi;

/** The top stack frames, with only file names and positions kept: no folder, no address, no message. */
export function stackFrames(stack: string | undefined): string[] {
  if (!stack) return [];
  return stack
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("at ") || /@.*:\d+:\d+$/.test(line))
    .slice(0, FINGERPRINT_FRAMES)
    .map((line) => line.replace(PLACE, "$1:$2:$3"));
}

/** FNV-1a over the frames, as 8 hex digits. */
export function fingerprint(frames: readonly string[]): string | null {
  if (frames.length === 0) return null;
  let hash = 0x811c9dc5;
  for (const char of frames.join("\n")) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

const stackOf = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "stack" in error && typeof error.stack === "string"
    ? error.stack
    : undefined;

/** A caught error as `app_error_caught`: its kind, type and fingerprint, never its words. */
export function appErrorProperties(error: unknown, kind: ErrorKind): AppErrorProperties {
  return {
    process: ErrorProcess.Renderer,
    kind,
    error_type: errorType(error),
    fatal: kind === ErrorKind.Render,
    fingerprint: fingerprint(stackFrames(stackOf(error))),
  };
}

/** How many times each error was sent in this window. */
const errorsSent = new Map<string, number>();

/** Send an error, each (by process, kind and fingerprint or type) at most a few times a launch. */
function sendError(properties: AppErrorProperties): void {
  const key = `${properties.process}:${properties.kind}:${properties.fingerprint ?? properties.error_type}`;
  const sent = errorsSent.get(key) ?? 0;
  if (sent >= ERROR_REPEATS_MAX) return;
  errorsSent.set(key, sent + 1);
  track(LaunchEvent.AppErrorCaught, properties);
}

/** Send a caught error, each fingerprint at most a few times a launch. */
export function reportError(error: unknown, kind: ErrorKind): void {
  sendError(appErrorProperties(error, kind));
}

/** One of main's diagnostics (`UiEvent.AppDiagnostic`): its own error, or a window that answered again. */
function reportMainDiagnostic(payload: unknown): void {
  const error = mainErrorProperties(payload);
  if (error) sendError(error);
  const hang = unresponsiveProperties(payload);
  if (hang) track(LaunchEvent.WindowUnresponsive, hang);
}

/** `ui_stall_summarized`'s properties. */
export type StallSummaryProperties = { screen: string; long_tasks: number; total_ms: number; max_ms: number };

/** The long tasks seen since the last summary. */
export interface StallTally {
  count: number;
  total: number;
  max: number;
}

/** Nothing seen yet. */
export const NO_STALLS: StallTally = { count: 0, total: 0, max: 0 };

/** One more long task. */
export const stallAdded = (tally: StallTally, duration: number): StallTally => ({
  count: tally.count + 1,
  total: tally.total + duration,
  max: Math.max(tally.max, duration),
});

/** The summary to send, or null when nothing was slow. */
export function stallSummary(tally: StallTally, screen: string): StallSummaryProperties | null {
  if (tally.count === 0) return null;
  return { screen, long_tasks: tally.count, total_ms: Math.round(tally.total), max_ms: Math.round(tally.max) };
}

/** Sum the window's long tasks and send them every `STALL_SUMMARY_MS`; nothing where the page cannot see them. */
function watchStalls(): () => void {
  const supported =
    typeof PerformanceObserver !== "undefined" && PerformanceObserver.supportedEntryTypes?.includes("longtask");
  if (!supported) return () => undefined;
  let tally = NO_STALLS;
  const observer = new PerformanceObserver(
    guarded((list: PerformanceObserverEntryList) => {
      for (const entry of list.getEntries()) tally = stallAdded(tally, entry.duration);
    }),
  );
  observer.observe({ type: "longtask", buffered: true });
  const timer = setInterval(
    guarded(() => {
      const summary = stallSummary(tally, currentScreen());
      tally = NO_STALLS;
      if (summary) track(LaunchEvent.UiStallSummarized, summary);
    }),
    STALL_SUMMARY_MS,
  );
  return () => {
    observer.disconnect();
    clearInterval(timer);
  };
}

/** Errors nothing caught, and rejections nothing handled. An error event with no error object says nothing to group by. */
function watchErrors(): () => void {
  if (typeof window === "undefined") return () => undefined;
  const uncaught = guarded((event: ErrorEvent): void => {
    if (typeof event.error === "object" && event.error !== null) reportError(event.error, ErrorKind.Uncaught);
  });
  const rejected = guarded((event: PromiseRejectionEvent): void => reportError(event.reason, ErrorKind.Rejection));
  window.addEventListener("error", uncaught);
  window.addEventListener("unhandledrejection", rejected);
  return () => {
    window.removeEventListener("error", uncaught);
    window.removeEventListener("unhandledrejection", rejected);
  };
}

/** What this launch learned about itself, for the first screen's measure, the update's wait and the session before. */
const launch: {
  bootstrapMs: number | null;
  firstScreen: boolean;
  updateReadyAt: number | null;
  previousSent: boolean;
} = {
  bootstrapMs: null,
  firstScreen: false,
  updateReadyAt: null,
  previousSent: false,
};

/** `app_ready_measured`'s properties; the start's facts only in the window the launch opened first. */
export type AppReadyProperties = Partial<StartProperties> & {
  /** From the window's start to its first real screen. */
  window_to_first_screen_ms: number;
  /** From the stores' start to the bootstrap's answer; null when it had not answered. */
  bootstrap_ms: number | null;
  bootstrap_failed: boolean;
  first_launch: boolean;
  games_bucket: CountBucket;
  engines_ready_count: number;
};

/** The first screen's measure, from what the stores hold then, with how the launch started when it says. */
export function appReadyProperties(
  state: {
    status: SessionStatus;
    welcoming: boolean;
    firstLaunch: boolean;
    games: number;
    enginesReady: number;
  },
  sinceWindowStart: number,
  bootstrapMs: number | null,
  start: unknown = null,
): AppReadyProperties {
  return {
    window_to_first_screen_ms: Math.max(0, Math.round(sinceWindowStart)),
    bootstrap_ms: bootstrapMs,
    bootstrap_failed: state.status === SessionStatus.Failed,
    first_launch: state.firstLaunch || state.welcoming,
    games_bucket: countBucket(state.games),
    engines_ready_count: state.enginesReady,
    ...startProperties(start),
  };
}

/**
 * The window's first real screen is drawn (`shell/use-shell.ts`, when `firstScreenReady` first
 * holds): sent once a launch. `sinceWindowStart` is the page's own clock.
 */
export function reportFirstScreen(
  app: Pick<Studio, "session" | "library" | "engines">,
  sinceWindowStart: number = performance.now(),
): void {
  if (launch.firstScreen) return;
  launch.firstScreen = true;
  const session = app.session.getState();
  const ready = app.engines.getState().list.filter((engine) => engine.status.code === EngineStatusCode.Ready);
  const state = {
    status: session.status,
    welcoming: session.welcoming,
    firstLaunch: session.firstLaunch,
    games: app.library.getState().games.length,
    enginesReady: ready.length,
  };
  const start = session.launch?.start ?? null;
  track(LaunchEvent.AppReadyMeasured, appReadyProperties(state, sinceWindowStart, launch.bootstrapMs, start));
}

/** Send how the session before this one ended, once, when the first bootstrap brings it. */
function followPreviousSession(app: Studio): () => void {
  const send = (state: Pick<SessionState, "launch">): void => {
    if (launch.previousSent) return;
    const properties = previousSessionProperties(state.launch?.previous);
    if (!properties) return;
    launch.previousSent = true;
    track(LaunchEvent.PreviousSessionEnded, properties);
  };
  send(app.session.getState());
  return app.session.subscribe(guarded(send));
}

/** The bootstrap as it moves: its first answer, and a Retry from its failure until it answers. */
export interface BootstrapWatch {
  status: SessionStatus;
  startedAt: number;
  answered: boolean;
  attempts: number;
  retryingSince: number | null;
}

/** What one move of the session's status means. */
export interface BootstrapStep {
  watch: BootstrapWatch;
  /** The bootstrap answered for the first time, this long after the watch began. */
  answeredMs: number | null;
  retried: WorkspaceRetriedProperties | null;
}

/** One move of the session's status: the watch after it, the first answer's time, and a retry that ended. */
export function bootstrapStep(watch: BootstrapWatch, status: SessionStatus, now: number): BootstrapStep {
  const settled = status !== SessionStatus.Loading;
  const answeredMs = settled && !watch.answered ? elapsedMs(watch.startedAt, now) : null;
  const next = { ...watch, status, answered: watch.answered || settled };
  if (watch.status === SessionStatus.Failed && status === SessionStatus.Loading)
    return { watch: { ...next, attempts: watch.attempts + 1, retryingSince: now }, answeredMs, retried: null };
  if (watch.retryingSince === null || !settled) return { watch: next, answeredMs, retried: null };
  const retried = {
    attempt: watch.attempts,
    succeeded: status === SessionStatus.Ready,
    elapsed_ms: elapsedMs(watch.retryingSince, now),
  };
  return { watch: { ...next, retryingSince: null }, answeredMs, retried };
}

/** Follow the session: when the bootstrap first answered, and each Retry after a failure. */
function followBootstrap(app: Studio, clock: () => number): () => void {
  let watch: BootstrapWatch = {
    status: app.session.getState().status,
    startedAt: clock(),
    answered: false,
    attempts: 0,
    retryingSince: null,
  };
  const step = (status: SessionStatus): void => {
    if (status === watch.status) return;
    const moved = bootstrapStep(watch, status, clock());
    watch = moved.watch;
    if (moved.answeredMs !== null) launch.bootstrapMs = moved.answeredMs;
    if (moved.retried) track(LaunchEvent.WorkspaceLoadRetried, moved.retried);
  };
  step(app.session.getState().status);
  return app.session.subscribe(guarded((state) => step(state.status)));
}

const updateKey = (update: ReadyUpdate): string => `${update.action}\n${update.version ?? ""}`;

/**
 * Follow the waiting update. Main announces one (`update.ready`), or the bootstrap finds one that
 * arrived before this window: the store moves first either way, so it is read a moment later, once
 * the announcement (if any) has been heard.
 */
function followUpdate(
  app: Studio,
  announced: ReadonlySet<string>,
  clock: () => number,
  later: (run: () => void) => void,
): () => void {
  let last: string | null = null;
  return app.update.subscribe(
    guarded((state) => {
      const { ready } = state;
      const key = ready ? updateKey(ready) : null;
      if (key === last) return;
      last = key;
      if (!ready || !key) return;
      later(
        guarded(() => {
          if (announced.has(key)) return;
          launch.updateReadyAt = clock();
          track(LaunchEvent.UpdateReady, { action: ready.action, at_bootstrap: true });
        }),
      );
    }),
  );
}

/** Relaunch to update, pressed: run it, send what it came to, and hand back whether it relaunches. */
export async function trackedRestart(
  surface: UpdateSurface,
  run: () => Promise<RestartAnswer>,
  clock: () => number = Date.now,
): Promise<boolean> {
  const waited = launch.updateReadyAt === null ? null : elapsedMs(launch.updateReadyAt, clock());
  try {
    const outcome = oneOf(RestartAnswer, await run());
    track(LaunchEvent.UpdateRestartPressed, { surface, outcome, waited_ms: waited });
    return outcome === RestartAnswer.Relaunching;
  } catch (error) {
    track(LaunchEvent.UpdateRestartPressed, { surface, outcome: RestartOutcome.Failed, waited_ms: waited });
    throw error;
  }
}

/** A Check for Updates' answer (null: the call failed) as `update_check_finished`. */
export const updateCheckProperties = (
  result: Pick<UpdateCheckResult, "status"> | null,
  ms: number,
): UpdateCheckProperties => ({
  status: result?.status ?? CHECK_CALL_FAILED,
  duration_ms: Math.max(0, Math.round(ms)),
});

/** Each error toast, with its failure's code and the screen it showed on. */
function watchErrorToasts(app: Studio): () => void {
  return app.toasts.subscribe(
    guarded((state: ToastsState, before: ToastsState) => {
      for (const shown of errorToastsShown(before, state, currentScreen())) track(LaunchEvent.ErrorToastShown, shown);
    }),
  );
}

/**
 * What this area hears: main's update announcements and failures, its diagnostics and agents that
 * would not start, the session (with how the one before it ended), the window's errors, its long
 * tasks and error toasts.
 */
export function createLaunchObservers(
  clock: () => number = Date.now,
  later: (run: () => void) => void = (run) => void setTimeout(run, 0),
): AreaObservers {
  const announced = new Set<string>();
  return {
    ui: (event) => {
      switch (event.type) {
        case UiEvent.UpdateReady:
          announced.add(updateKey(event.payload));
          launch.updateReadyAt = clock();
          track(LaunchEvent.UpdateReady, { action: event.payload.action, at_bootstrap: false });
          return;
        case UiEvent.UpdateFailed:
          track(LaunchEvent.UpdateBackgroundFailed, updateFailedProperties(event.payload));
          return;
        case UiEvent.HarnessStartFailed:
          track(LaunchEvent.AgentsStartFailed, agentsStartFailedProperties(event.payload));
          return;
        case UiEvent.AppDiagnostic:
          reportMainDiagnostic(event.payload);
      }
    },
    start: (app) => {
      const stops = [
        followBootstrap(app, clock),
        followPreviousSession(app),
        followUpdate(app, announced, clock, later),
        watchErrors(),
        watchStalls(),
        watchErrorToasts(app),
      ];
      return () => {
        for (const stop of stops) stop();
      };
    },
  };
}
