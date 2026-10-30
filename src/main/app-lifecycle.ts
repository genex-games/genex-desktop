/**
 * The main process's recovery rules, kept free of Electron so each is driven in Node with a fake
 * clock: what an uncaught error does (it is logged; the app stays up), when a crashed renderer is
 * reloaded (a bounded number of times), and how quitting finishes (every step is bounded, so the
 * app always exits). `main/index.ts` wires them to `process`, `webContents` and `before-quit`.
 */
import { errorMessage } from "../shared/errors.ts";
import { MainDiagnostic, RendererGone } from "../shared/app-session.ts";
import { MINUTE_MS, SECOND_MS } from "../shared/duration.ts";
import type { MainFault } from "./app-diagnostics.ts";
import { quitsWhenLastWindowCloses } from "./dev/launch-flags.ts";

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
 * `fault` hears each one's kind after the log (`app-diagnostics.ts`); it failing changes nothing.
 */
export function installProcessHandlers(
  target: ProcessEvents,
  log: LogLine,
  fault: (kind: MainFault, reason: unknown) => void = () => undefined,
): void {
  const record = (kind: MainFault, words: string) => (reason: unknown) => {
    try {
      log("main", `${words}: ${describe(reason)}`);
    } catch {
      /* the log itself failed; nothing is left to tell */
    }
    try {
      fault(kind, reason);
    } catch {
      /* nothing may hear it yet (main is still starting); the log has it */
    }
  };
  target.on("uncaughtException", record(MainDiagnostic.Uncaught, "uncaught exception"));
  target.on("unhandledRejection", record(MainDiagnostic.Rejection, "unhandled rejection"));
}

/** The signals that end the app, which a Node listener in main takes from Chromium's own quit. */
const QUIT_SIGNALS = ["SIGTERM", "SIGINT"] as const;

/** The part of `process` the quit signals are heard on. */
export interface SignalEvents {
  on(event: (typeof QUIT_SIGNALS)[number], listener: () => void): unknown;
}

/**
 * Quit on SIGTERM and SIGINT: the first asks for the app's own quit (`before-quit` and its bounded
 * steps), a second exits at once. Chromium quits on them by itself, but any Node listener takes a
 * signal from it, and the process sandbox's runtime adds one for each, for its own clean-up
 * (`@anthropic-ai/sandbox-runtime`, `sandbox-manager.js`): a SIGTERM then cleaned the sandbox up
 * and left the app running.
 */
export function installQuitSignals(target: SignalEvents, app: { quit(): void; exit(): void }): void {
  let asked = false;
  const heard = (): void => {
    if (asked) return app.exit();
    asked = true;
    app.quit();
  };
  for (const signal of QUIT_SIGNALS) target.on(signal, heard);
}

/** What to do after `render-process-gone`: reload, leave a clean exit alone, or stop retrying. */
export const ReloadDecision = { Reload: "reload", CleanExit: "clean-exit", GiveUp: "give-up" } as const;
export type ReloadDecision = (typeof ReloadDecision)[keyof typeof ReloadDecision];

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
      if (reason === RendererGone.CleanExit) return ReloadDecision.CleanExit;
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

/** What the window's close button does: close it, hide it, or ask the quit question first. */
export const WindowClose = { Close: "close", Hide: "hide", AskToQuit: "ask-to-quit" } as const;
export type WindowClose = (typeof WindowClose)[keyof typeof WindowClose];

/**
 * A run outlives its window's close button: the preview dies with the window, so the window must
 * not close under a run. On a Mac it hides, and the Dock icon brings it back (`activate`). Where
 * closing the last window quits, a hidden window leaves no Dock, tray or taskbar button to find
 * it by, and the run would go on spending unseen; there the close asks the quit question, and
 * "Keep running" leaves the window where it was. Once the person agreed to end the run, it closes.
 */
export function windowClose(state: {
  platform: NodeJS.Platform;
  runActive: boolean;
  quitConfirmed: boolean;
  testLaunch: boolean;
}): WindowClose {
  if (!state.runActive || state.quitConfirmed) return WindowClose.Close;
  return quitsWhenLastWindowCloses(state) ? WindowClose.AskToQuit : WindowClose.Hide;
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
  /** Play's native games being played in their own windows: each ends with the app. */
  games?: { stopAll(): Promise<void> } | null;
}

/**
 * What quitting stops, in order, each step bounded by `runShutdown`. The harness goes first, on
 * its own bound (its stop kills the process tree after 5 s), so connectors and previews that are
 * slow to close cannot use up its time; the core's stop then closes the rest. The harness runs
 * detached in its own process group, which the app's exit would not end, so the last step kills
 * whatever is left of it outright.
 */
export function shutdownSteps({
  keepAwake,
  codexLogin,
  claudeLogin,
  terminals,
  core,
  games,
}: QuitParts): ShutdownStep[] {
  return [
    // A game asked to quit gets its grace period, then is killed with everything it started.
    { name: "end native games", timeoutMs: 5 * SECOND_MS, run: () => games?.stopAll() },
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

/** What a developer launch's stop does, in this order (`main/dev/runtime.ts`). */
export interface DevStopParts {
  /** Saves the profiles or trace still recording, if their surfaces answer. */
  diagnostics(): Promise<unknown>;
  /** The quit steps (`runShutdown`); throws when one did not finish. */
  shutdown(): Promise<void>;
  /** Writes the launch's records and closes its channel; `failure` says why the stop was unclean, or null. */
  close(failure: string | null): Promise<void>;
  exit(): void;
}

/**
 * A developer launch's stop, which every quit hands its work to while the channel is open (a
 * SIGTERM's included). It always ends in `exit`: a quit step that did not finish, a diagnostic
 * whose page never answers (the debugger's stop of a page that never yields), or a close that
 * hangs or throws is passed over, never left to keep the app running with nothing to stop it.
 */
export async function stopThenExit(
  parts: DevStopParts,
  { diagnosticsMs, closeMs, timers = realTimers }: { diagnosticsMs: number; closeMs: number; timers?: ShutdownTimers },
): Promise<void> {
  let failure: string | null = null;
  try {
    await settleWithin(
      Promise.resolve().then(() => parts.diagnostics()),
      diagnosticsMs,
      undefined,
      timers,
    );
    await parts.shutdown();
  } catch (error) {
    failure = errorMessage(error);
  }
  try {
    await settleWithin(
      Promise.resolve().then(() => parts.close(failure)),
      closeMs,
      undefined,
      timers,
    );
  } finally {
    parts.exit();
  }
}
