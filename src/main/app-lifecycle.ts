/**
 * The main process's recovery rules, kept free of Electron so each is driven in Node with a fake
 * clock: what an uncaught error does (it is logged; the app stays up), when a crashed renderer is
 * reloaded (a bounded number of times), and how quitting finishes (every step is bounded, so the
 * app always exits). `main/index.ts` wires them to `process`, `webContents` and `before-quit`.
 */
import { errorMessage } from "../shared/errors.ts";
import { MINUTE_MS, SECOND_MS } from "../shared/duration.ts";

/** Where a line goes: the studio log's `write`. */
export type LogLine = (source: string, line: string) => void;

/** The part of `process` the handlers need. */
export interface ProcessEvents {
  on(event: "uncaughtException" | "unhandledRejection", listener: (reason: unknown) => void): unknown;
}

function describe(reason: unknown): string {
  return reason instanceof Error ? (reason.stack ?? `${reason.name}: ${reason.message}`) : String(reason);
}

/**
 * Log an uncaught exception or unhandled rejection instead of letting it end the process (or
 * Electron's modal error box). None is treated as fatal: a failure at startup already has its own
 * error box in `main()`, and one in a background task should not take the open window with it.
 */
export function installProcessHandlers(target: ProcessEvents, log: LogLine): void {
  const record = (kind: string) => (reason: unknown) => {
    try {
      log("main", `${kind}: ${describe(reason)}`);
    } catch {
      /* the log itself failed; nothing is left to tell */
    }
  };
  target.on("uncaughtException", record("uncaught exception"));
  target.on("unhandledRejection", record("unhandled rejection"));
}

/** What to do after `render-process-gone`: reload, leave a clean exit alone, or stop retrying. */
export const ReloadDecision = { Reload: "reload", CleanExit: "clean-exit", GiveUp: "give-up" } as const;
export type ReloadDecision = (typeof ReloadDecision)[keyof typeof ReloadDecision];

/** Electron's `render-process-gone` reason for a renderer that exited normally. */
const CLEAN_EXIT_REASON = "clean-exit";
/** How many crash reloads a renderer gets within one window, by default. */
const RELOADS_PER_WINDOW = 2;

/**
 * A renderer that crashed is reloaded, but at most `limit` times within `windowMs`, so a page that
 * crashes on load does not spin. A clean exit is not a crash and spends none of the budget.
 */
export function createReloadPolicy({
  limit = RELOADS_PER_WINDOW,
  windowMs = MINUTE_MS,
  now = Date.now,
}: {
  limit?: number;
  windowMs?: number;
  now?: () => number;
} = {}) {
  const reloads: number[] = [];
  return {
    decide(reason: string): ReloadDecision {
      if (reason === CLEAN_EXIT_REASON) return ReloadDecision.CleanExit;
      const at = now();
      const expired = (): boolean => {
        const oldest = reloads[0];
        return oldest !== undefined && at - oldest > windowMs;
      };
      while (expired()) reloads.shift();
      if (reloads.length >= limit) return ReloadDecision.GiveUp;
      reloads.push(at);
      return ReloadDecision.Reload;
    },
  };
}

/**
 * What the window does once its page died: nothing while the app quits or after a clean exit;
 * reload within the policy's budget; past it, ask the person — or, in unattended fixture and
 * smoke sessions, which show no native dialogs, leave the page dead for their checks to report.
 */
export const PageRecovery = { Ignore: "ignore", Reload: "reload", Ask: "ask", Leave: "leave" } as const;
export type PageRecovery = (typeof PageRecovery)[keyof typeof PageRecovery];

/** The recovery for a dead page, from the reload policy's decision and whether anyone can answer. */
export function pageRecovery(
  decision: ReloadDecision,
  { quitting, unattended }: { quitting: boolean; unattended: boolean },
): PageRecovery {
  if (quitting || decision === ReloadDecision.CleanExit) return PageRecovery.Ignore;
  if (decision === ReloadDecision.Reload) return PageRecovery.Reload;
  return unattended ? PageRecovery.Leave : PageRecovery.Ask;
}

/** Timers, injectable so a test decides when a deadline passes. */
export interface ShutdownTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}
const realTimers: ShutdownTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const TIMED_OUT = Symbol("timed out");

/** Race `work` against `ms`; resolves `TIMED_OUT` when the deadline wins. The timer is always cleared. */
async function race<T>(work: Promise<T>, ms: number, timers: ShutdownTimers): Promise<T | typeof TIMED_OUT> {
  let handle: unknown;
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    handle = timers.setTimeout(() => resolve(TIMED_OUT), ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    timers.clearTimeout(handle);
  }
}

/** `work`'s value if it resolves within `ms`, otherwise (or when it rejects) `fallback`. */
export async function settleWithin<T>(
  work: Promise<T>,
  ms: number,
  fallback: T,
  timers: ShutdownTimers = realTimers,
): Promise<T> {
  try {
    const value = await race(work, ms, timers);
    return value === TIMED_OUT ? fallback : value;
  } catch {
    return fallback;
  }
}

/** What a quit, or a relaunch into an update, must ask the person before it goes ahead. */
export const QuitQuestion = {
  None: "none",
  /** An unattended run is active: quitting ends it. */
  RunActive: "run-active",
  /** A paused build waits to resume on its own (`core/auto-resume.ts`): quitting drops the resume. */
  ResumePending: "resume-pending",
} as const;
export type QuitQuestion = (typeof QuitQuestion)[keyof typeof QuitQuestion];

/** The question a quit asks first, from main's state; once the person answered, none. */
export function quitQuestion(state: { runActive: boolean; resumeAt: number | null; confirmed: boolean }): QuitQuestion {
  if (state.confirmed) return QuitQuestion.None;
  if (state.runActive) return QuitQuestion.RunActive;
  return state.resumeAt === null ? QuitQuestion.None : QuitQuestion.ResumePending;
}

export interface ShutdownStep {
  name: string;
  timeoutMs: number;
  run(): unknown;
}

/** What quitting stops: `main/index.ts`'s services, each by the one call its step makes. */
export interface QuitParts {
  keepAwake: { release(): unknown };
  codexLogin: { dismiss(): unknown };
  claudeLogin: { cancel(): unknown };
  terminals: { dispose(): unknown };
  core: { host: { stop(): Promise<void>; kill(): void }; stop(): Promise<void> } | null;
}

/**
 * What quitting stops, in order, each step bounded by `runShutdown`. The harness goes first, on
 * its own bound (its stop kills the process tree after 5 s), so connectors and previews that are
 * slow to close cannot use up its time; the core's stop then closes the rest. The harness runs
 * detached in its own process group, which the app's exit would not end, so the last step kills
 * whatever is left of it outright.
 */
export function shutdownSteps({ keepAwake, codexLogin, claudeLogin, terminals, core }: QuitParts): ShutdownStep[] {
  return [
    { name: "stop the harness", timeoutMs: 7 * SECOND_MS, run: () => core?.host.stop() },
    { name: "release keep-awake", timeoutMs: SECOND_MS, run: () => keepAwake.release() },
    { name: "dismiss Codex sign-in", timeoutMs: 3 * SECOND_MS, run: () => codexLogin.dismiss() },
    { name: "cancel Claude sign-in", timeoutMs: 3 * SECOND_MS, run: () => claudeLogin.cancel() },
    { name: "close terminals", timeoutMs: 3 * SECOND_MS, run: () => terminals.dispose() },
    { name: "stop the studio core", timeoutMs: 10 * SECOND_MS, run: () => core?.stop() },
    { name: "kill what is left of the harness", timeoutMs: SECOND_MS, run: () => core?.host.kill() },
  ];
}

/**
 * Run the quit steps in order, each one bounded by its own timeout; a step that throws or hangs is
 * logged and left behind, and the next step runs. Always resolves, with the names of the steps
 * that did not finish cleanly, so the caller's `app.exit` is always reached.
 */
export async function runShutdown(
  steps: readonly ShutdownStep[],
  { log, timers = realTimers }: { log: LogLine; timers?: ShutdownTimers },
): Promise<string[]> {
  const failed: string[] = [];
  const note = (line: string) => {
    try {
      log("main", `quit: ${line}`);
    } catch {
      /* keep quitting */
    }
  };
  for (const step of steps) {
    let problem: string | null = null;
    try {
      const outcome = await race(
        Promise.resolve().then(() => step.run()),
        step.timeoutMs,
        timers,
      );
      if (outcome === TIMED_OUT) problem = `timed out after ${step.timeoutMs} ms`;
    } catch (err) {
      problem = `failed: ${errorMessage(err)}`;
    }
    if (problem === null) continue;
    failed.push(step.name);
    note(`${step.name} ${problem}`);
  }
  return failed;
}
