/**
 * Where startup stands, as the window sees it. Before the studio's stores bootstrap, the renderer
 * asks main (`bootState`): the platform (the window chrome is laid out by it) and whether the
 * protected workspace is ready. While it is not, the window shows the sandbox setup screen, whose
 * Retry re-runs core startup in main (and on Windows, Set up installs it first); once it is,
 * `onReady` starts the studio, exactly once.
 */
import { createStore, type StoreApi } from "zustand/vanilla";
import {
  BootPhase,
  type BootState,
  type SandboxProblem,
  SandboxProblemCode,
  SandboxSetupOutcome,
  type SandboxSetupResult,
  StudioPlatform,
} from "../../shared/boot.ts";
import { errorMessage } from "../../shared/errors.ts";
import type { StudioApi } from "../../shared/studio-api.ts";

/** What the window shows for the boot state. */
export const BootView = {
  Loading: "loading",
  SandboxSetup: "sandbox-setup",
  Studio: "studio",
} as const;
export type BootView = (typeof BootView)[keyof typeof BootView];

export interface BootStoreState {
  /** Main's platform, in `process.platform` spelling; null until main answers. */
  platform: string | null;
  phase: BootPhase | null;
  problem: SandboxProblem | null;
  /** A Retry is running. */
  retrying: boolean;
  /** Set up (Windows) is waiting on the install and its administrator prompt. */
  settingUp: boolean;
  /** The last Set up ended with the administrator prompt dismissed. */
  setupCancelled: boolean;
  /** Why the last Retry or Set up failed, other than the sandbox still being unavailable. */
  error: string | null;
}

export const initialBoot = (): BootStoreState => ({
  platform: null,
  phase: null,
  problem: null,
  retrying: false,
  settingUp: false,
  setupCancelled: false,
  error: null,
});

/** Main answered: its platform, its phase and the setup problem, if any. */
export function bootAnswered(state: BootStoreState, boot: BootState): BootStoreState {
  return {
    ...state,
    platform: boot.platform,
    phase: boot.phase,
    problem: boot.sandbox,
    retrying: false,
    settingUp: false,
    setupCancelled: false,
    error: null,
  };
}

export function retryStarted(state: BootStoreState): BootStoreState {
  return { ...state, retrying: true, setupCancelled: false, error: null };
}

export function retryFailed(state: BootStoreState, error: string): BootStoreState {
  return { ...state, retrying: false, error };
}

export function setupStarted(state: BootStoreState): BootStoreState {
  return { ...state, settingUp: true, setupCancelled: false, error: null };
}

/** Set up answered: installed (main has retried, so this is its state) or the prompt dismissed. */
export function setupAnswered(state: BootStoreState, result: SandboxSetupResult): BootStoreState {
  const after = bootAnswered(state, result.state);
  return { ...after, setupCancelled: result.outcome === SandboxSetupOutcome.Cancelled };
}

export function setupFailed(state: BootStoreState, error: string): BootStoreState {
  return { ...state, settingUp: false, error };
}

/** Whether the setup screen offers Set up: a Windows sandbox that has not been installed yet. */
export function canSetUp(state: Pick<BootStoreState, "platform" | "problem">): boolean {
  const code = state.problem?.code;
  const installable = code === SandboxProblemCode.NotProvisioned || code === SandboxProblemCode.GitMissing;
  return state.platform === StudioPlatform.Windows && installable;
}

/** The screen the state calls for. */
export function bootView(state: BootStoreState): BootView {
  if (state.phase === BootPhase.Ready) return BootView.Studio;
  if (state.phase === BootPhase.SandboxSetup) return BootView.SandboxSetup;
  return BootView.Loading;
}

export type BootStore = StoreApi<BootStoreState>;

/** The boot store and what the window does with it: load, Retry and (Windows) Set up. */
export interface Boot {
  store: BootStore;
  /** Ask main where startup stands; starts the studio when it is ready. */
  load(): Promise<void>;
  /** Re-run core startup from the setup screen; presses while one runs share it. */
  retry(): Promise<void>;
  /** Install the Windows sandbox, then start; presses while one runs share it. */
  setUp(): Promise<void>;
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
  api: Pick<StudioApi, "bootState" | "retrySandboxSetup" | "setUpSandbox">,
  options: { onReady(): void },
): Boot {
  const store = createStore<BootStoreState>()(() => initialBoot());
  let started = false;
  let automaticallyAttempted = false;
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
  const load = async (): Promise<void> => {
    // A main that cannot say (an older build, a closing window) must not strand the window: the
    // studio starts, and its own bootstrap reports what is wrong.
    const boot = await api
      .bootState()
      .catch((): BootState => ({ platform: store.getState().platform ?? "", phase: BootPhase.Ready, sandbox: null }));
    answered(boot);
    const automatic = boot.automaticSetup && canSetUp(store.getState()) && !automaticallyAttempted;
    if (automatic) {
      automaticallyAttempted = true;
      await setUp();
    }
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
  const setUp = shared(runSetUp);
  return { store, load, retry: shared(runRetry), setUp };
}
