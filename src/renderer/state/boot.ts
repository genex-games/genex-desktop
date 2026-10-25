/**
 * Where startup stands, as the window sees it. Before the studio's stores bootstrap, the renderer
 * asks main (`bootState`): the platform (the window chrome is laid out by it) and whether the
 * protected workspace is ready. While it is not, the window shows the sandbox setup screen, whose
 * Retry re-runs core startup in main (and on Windows, Set up installs it first); once it is,
 * `onReady` starts the studio, exactly once. On Windows the first start runs Set up by itself, so
 * a person sees only "Setting up Genex" and Windows' own prompt.
 *
 * A Windows window opens before the core: it says which step the start is on, asking again until
 * the start ends, and main opens the studio in a window of its own. A studio whose harness would
 * not start stays on its failure, with Try again, a report and Quit. A launch that moves Genex's
 * data shows how far the move is, asking again until main starts Genex anew; one whose data
 * folder is not there names it, with Try again and Quit.
 *
 * Until the studio is up, the window also asks main whether a new version of the app downloaded
 * meanwhile (`watchUpdate`), so a start that fails or waits on Set up offers the relaunch into a
 * release that may fix it; the studio's own sidebar offers it after.
 */
import { createStore, type StoreApi } from "zustand/vanilla";
import {
  BootPhase,
  type BootState,
  type SandboxProblem,
  SandboxProblemCode,
  SandboxSetupOutcome,
  type SandboxSetupResult,
  type StartStep,
  StudioPlatform,
} from "../../shared/boot.ts";
import type { DataMoveProgress } from "../../shared/data-folder.ts";
import { type ReadyUpdate, UpdateAction } from "../../shared/app-update.ts";
import { SECOND_MS } from "../../shared/duration.ts";
import { errorMessage } from "../../shared/errors.ts";
import { t } from "../../shared/i18n.ts";
import type { StudioApi } from "../../shared/studio-api.ts";

const MESSAGE = {
  /** The raw error under Details when an install went through and Windows still has no sandbox. */
  stillNotSetUp: t("The install finished, but Windows still reports the protected workspace as not set up."),
} as const;

/** How long a starting window waits before it asks main again which step the start is on. */
const START_POLL_MS = SECOND_MS / 2;
/** How long the window waits before it asks main again whether an update downloaded. */
const UPDATE_POLL_MS = 10 * SECOND_MS;

/** What the window shows for the boot state. */
export const BootView = {
  Loading: "loading",
  SandboxSetup: "sandbox-setup",
  Studio: "studio",
  Starting: "starting",
  Failed: "failed",
  Moving: "moving",
  DataMissing: "data-missing",
} as const;
export type BootView = (typeof BootView)[keyof typeof BootView];

/** Where a failed Set up's report stands. */
export const SetupReport = {
  Idle: "idle",
  Sending: "sending",
  Sent: "sent",
  Failed: "failed",
} as const;
export type SetupReport = (typeof SetupReport)[keyof typeof SetupReport];

export interface BootStoreState {
  /** Main's platform, in `process.platform` spelling; null until main answers. */
  platform: string | null;
  phase: BootPhase | null;
  problem: SandboxProblem | null;
  /** What a starting core is doing, while the phase is Starting. */
  step: StartStep | null;
  /** A Retry is running. */
  retrying: boolean;
  /** Set up (Windows) is waiting on the install and its administrator prompt. */
  settingUp: boolean;
  /** The last Set up ended with the administrator prompt dismissed. */
  setupCancelled: boolean;
  /** Why the last Retry or Set up failed (other than the sandbox still being unavailable), or why the studio would not start. */
  error: string | null;
  /** The report of the last failed Set up. */
  report: SetupReport;
  /** How far a move of Genex's data is, while the phase is Moving. */
  move: DataMoveProgress | null;
  /** The data folder that is not there, while the phase is DataMissing. */
  dataFolder: string | null;
  /** A new version of the app main downloaded (or, on Linux, found) while the studio is not up. */
  update: ReadyUpdate | null;
}

export const initialBoot = (): BootStoreState => ({
  platform: null,
  phase: null,
  problem: null,
  step: null,
  retrying: false,
  settingUp: false,
  setupCancelled: false,
  error: null,
  report: SetupReport.Idle,
  move: null,
  dataFolder: null,
  update: null,
});

/** Main answered: its platform, its phase, the step a start is on, the setup problem and why a start failed, if any. */
export function bootAnswered(state: BootStoreState, boot: BootState): BootStoreState {
  return {
    ...state,
    platform: boot.platform,
    phase: boot.phase,
    problem: boot.sandbox,
    step: boot.step ?? null,
    retrying: false,
    settingUp: false,
    setupCancelled: false,
    error: showsError(boot) ? (boot.failure ?? null) : null,
    move: boot.move ?? null,
    dataFolder: boot.dataFolder ?? null,
  };
}

/** A phase whose screen shows why the last try failed: a failed start, a missing data folder, a stopped move. */
function showsError(boot: BootState): boolean {
  return boot.phase === BootPhase.Failed || boot.phase === BootPhase.DataMissing || boot.phase === BootPhase.Moving;
}

export function retryStarted(state: BootStoreState): BootStoreState {
  return { ...state, retrying: true, setupCancelled: false, error: null };
}

export function retryFailed(state: BootStoreState, error: string): BootStoreState {
  return { ...state, retrying: false, error };
}

export function setupStarted(state: BootStoreState): BootStoreState {
  return { ...state, settingUp: true, setupCancelled: false, error: null, report: SetupReport.Idle };
}

/**
 * Set up answered: installed (main has retried, so this is its state) or the prompt dismissed. An
 * install after which Windows still reports no sandbox is a failure, with Windows' own words, so
 * the screen offers a report rather than asking for the same approval again.
 */
export function setupAnswered(state: BootStoreState, result: SandboxSetupResult): BootStoreState {
  const after = bootAnswered(state, result.state);
  if (result.outcome === SandboxSetupOutcome.Cancelled) return { ...after, setupCancelled: true };
  if (!canSetUp(after)) return after;
  return { ...after, error: after.problem?.details.join("\n") || MESSAGE.stillNotSetUp };
}

export function setupFailed(state: BootStoreState, error: string): BootStoreState {
  return { ...state, settingUp: false, error };
}

export function reportChanged(state: BootStoreState, report: SetupReport): BootStoreState {
  return { ...state, report };
}

/** Whether the setup screen offers Set up: a Windows sandbox that has not been installed yet. */
export function canSetUp(state: Pick<BootStoreState, "platform" | "problem">): boolean {
  return state.platform === StudioPlatform.Windows && state.problem?.code === SandboxProblemCode.NotProvisioned;
}

/** The screen the state calls for. */
export function bootView(state: BootStoreState): BootView {
  if (state.phase === BootPhase.Ready) return BootView.Studio;
  if (state.phase === BootPhase.SandboxSetup) return BootView.SandboxSetup;
  if (state.phase === BootPhase.Starting) return BootView.Starting;
  if (state.phase === BootPhase.Failed) return BootView.Failed;
  if (state.phase === BootPhase.Moving) return BootView.Moving;
  if (state.phase === BootPhase.DataMissing) return BootView.DataMissing;
  return BootView.Loading;
}

export type BootStore = StoreApi<BootStoreState>;

/** The boot store and what the window does with it: load, Retry and (Windows) Set up. */
export interface Boot {
  store: BootStore;
  /** Ask main where startup stands; starts the studio when it is ready. */
  load(): Promise<void>;
  /**
   * Load, then run Set up straight away where it is offered (a Windows sandbox not installed yet)
   * and has not run this launch.
   */
  start(): Promise<void>;
  /** Re-run core startup from the setup screen; presses while one runs share it. */
  retry(): Promise<void>;
  /** Install the Windows sandbox, then start; presses while one runs share it. */
  setUp(): Promise<void>;
  /** Send the team the last Set up's error (or the start's failure) with this build's log; presses while one sends share it. */
  report(): Promise<void>;
  /** Quit the app, from the screen of a studio that would not start. */
  quit(): Promise<void>;
  /** Ask main for a downloaded update until one waits for a relaunch or the studio is up. */
  watchUpdate(): Promise<void>;
  /** Relaunch into the downloaded update, or open a Linux release's download page. */
  restartToUpdate(): Promise<void>;
}

export interface BootOptions {
  onReady(): void;
  /** Wait between questions while the core starts; a timer unless a test holds the clock. */
  wait?: (ms: number) => Promise<void>;
}

/** A start or a move main is working through, which the window follows by asking again; a stopped move is not. */
function isUnderWay(boot: BootState): boolean {
  if (boot.phase === BootPhase.Moving) return boot.failure === undefined;
  return boot.phase === BootPhase.Starting;
}

/** The window's own clock: run `run` after `ms`. */
const later = (run: () => void, ms: number): unknown => globalThis.setTimeout(run, ms);

/** A wait on the window's own clock. */
function timer(ms: number): Promise<void> {
  return new Promise((done) => later(done, ms));
}

/** One run at a time of `run`: calls while it runs share it. */
function shared(run: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | null = null;
  return () => {
    running ??= run().finally(() => {
      running = null;
    });
    return running;
  };
}

export function createBoot(
  api: Pick<
    StudioApi,
    | "bootState"
    | "retrySandboxSetup"
    | "setUpSandbox"
    | "reportSandboxSetup"
    | "quitFromBoot"
    | "readyUpdate"
    | "restartToUpdate"
    | "openUpdateDownload"
  >,
  options: BootOptions,
): Boot {
  const wait = options.wait ?? timer;
  const store = createStore<BootStoreState>()(() => initialBoot());
  let started = false;
  const startOnce = (boot: BootState): void => {
    // The studio's stores start before the view changes, so the studio mounts over started stores.
    if (boot.phase === BootPhase.Ready && !started) {
      started = true;
      options.onReady();
    }
  };
  const answered = (boot: BootState): void => {
    startOnce(boot);
    store.setState((state) => bootAnswered(state, boot), true);
  };
  // A main that cannot say (an older build, a closing window) must not strand the window: the
  // studio starts, and its own bootstrap reports what is wrong.
  const read = (): Promise<BootState> =>
    api
      .bootState()
      .catch((): BootState => ({ platform: store.getState().platform ?? "", phase: BootPhase.Ready, sandbox: null }));
  const ask = async (): Promise<BootState> => {
    const boot = await read();
    answered(boot);
    return boot;
  };
  // Ask again while the core starts. A start that ends ready opens the studio in a window of its
  // own, which replaces this one, so this window keeps saying it is starting and starts nothing.
  const followStart = async (first: BootState): Promise<BootState | null> => {
    let boot = first;
    while (isUnderWay(boot)) {
      await wait(START_POLL_MS);
      boot = await read();
      if (boot.phase === BootPhase.Ready) return null;
      answered(boot);
    }
    return boot;
  };
  const load = async (): Promise<void> => {
    await ask();
  };
  const runRetry = async (): Promise<void> => {
    store.setState(retryStarted, true);
    try {
      answered(await api.retrySandboxSetup());
    } catch (error) {
      store.setState((state) => retryFailed(state, errorMessage(error)), true);
    }
  };
  const runSetUp = async (): Promise<void> => {
    store.setState(setupStarted, true);
    try {
      const result = await api.setUpSandbox();
      startOnce(result.state);
      store.setState((state) => setupAnswered(state, result), true);
    } catch (error) {
      store.setState((state) => setupFailed(state, errorMessage(error)), true);
    }
  };
  const runReport = async (): Promise<void> => {
    const { error } = store.getState();
    if (error === null) return;
    store.setState((state) => reportChanged(state, SetupReport.Sending), true);
    const sent = await api.reportSandboxSetup(error).then(
      () => SetupReport.Sent,
      () => SetupReport.Failed,
    );
    // A Set up pressed while it was sending starts a new error with a report of its own.
    if (store.getState().error !== error) return;
    store.setState((state) => reportChanged(state, sent), true);
  };
  const setUp = shared(runSetUp);
  const start = async (): Promise<void> => {
    const boot = await followStart(await ask());
    if (boot && canSetUp(store.getState()) && !boot.setupTried) await setUp();
  };
  const quit = (): Promise<void> => api.quitFromBoot();
  const studioUp = (): boolean => bootView(store.getState()) === BootView.Studio;
  // A main that cannot say keeps what the screen shows; the next question may answer.
  const readUpdate = (): Promise<ReadyUpdate | null> => api.readyUpdate().catch(() => store.getState().update);
  const watchUpdate = async (): Promise<void> => {
    while (!studioUp()) {
      const update = await readUpdate();
      store.setState((state) => ({ ...state, update }), true);
      if (update?.action === UpdateAction.Restart) return;
      await wait(UPDATE_POLL_MS);
    }
  };
  const restartToUpdate = async (): Promise<void> => {
    const { update } = store.getState();
    if (update?.action === UpdateAction.Download) await api.openUpdateDownload();
    else await api.restartToUpdate();
  };
  return {
    store,
    load,
    start,
    retry: shared(runRetry),
    setUp,
    report: shared(runReport),
    quit,
    watchUpdate: shared(watchUpdate),
    restartToUpdate,
  };
}
