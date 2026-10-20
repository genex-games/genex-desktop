/**
 * Where startup stands, for the window. Normally the core starts and the gate stays Ready; a
 * Windows launch opens its window first and shows the step the core is on (`starting`). When
 * the process sandbox cannot start, main holds the gate on the setup screen with the problem and
 * the step that re-runs core startup; Retry runs that step once (presses while it runs share it)
 * and the gate opens, or shows the problem the new attempt found. Any other failure is the
 * caller's: it rejects and leaves the setup state as it was. A studio that would not start holds
 * the gate on that failure (`fail`), whose Try again shows the next failure's words instead. Once
 * the studio is open, a harness that would not start leaves the gate Ready with the failure's
 * words (`agentsFailed`): the studio stays, and its Try again works the same way.
 *
 * On Windows the missing piece is a one-time install behind an administrator prompt, which Set up
 * runs (`installSandbox`); once installed it retries, and a dismissed prompt changes nothing.
 */
import {
  BootPhase,
  type BootState,
  type SandboxProblem,
  SandboxProblemCode,
  SandboxSetupOutcome,
  type SandboxSetupResult,
  StartStep,
} from "../shared/boot.ts";
import { errorMessage } from "../shared/errors.ts";
import { SandboxUnavailableError } from "../substrate/sandbox-unavailable.ts";

/** What installing the sandbox answered: `cancelled` when the administrator prompt was dismissed. */
export interface SandboxInstall {
  cancelled: boolean;
}

export interface BootGateOptions {
  /** Set up what `problem` needs (an administrator prompt per step); throws when a step fails. */
  installSandbox?: (problem: SandboxProblem) => Promise<SandboxInstall>;
  /** Told why a Set up failed (the install, or the startup after it), for the log. */
  setUpFailed?: (error: unknown) => void;
}

/** The boot state main answers `studio:boot` with, and the Retry behind `studio:boot.retry`. */
export interface BootGate {
  state(): BootState;
  /** The window opened before the core: it shows `step` until the gate is ready or held. */
  starting(step: StartStep): void;
  /** The starting core moved on to `step`; nothing once the gate is past starting. */
  progress(step: StartStep): void;
  /** The core started: the studio itself, with nothing left to retry. */
  ready(): void;
  /** Show the setup screen for `problem`; `attempt` re-runs startup and throws while the sandbox is still unavailable. */
  hold(problem: SandboxProblem, attempt: () => Promise<void>): void;
  /** Show that the studio would not start, with `error`; Try again runs `attempt`, and a failure there shows its own words. */
  fail(error: string, attempt: () => Promise<void>): void;
  /**
   * The studio is open but its agents would not start: it stays, saying so with `error`; Try again
   * runs `attempt`, and a failure there shows its own words.
   */
  agentsFailed(error: string, attempt: () => Promise<void>): void;
  /** A start still running at its limit shows as failed, as {@link fail}; nothing once the gate is past starting. */
  overdue(error: string, attempt: () => Promise<void>): boolean;
  /** Run the held attempt; the state after it. */
  retry(): Promise<BootState>;
  /** Install the sandbox, then retry; throws when there is nothing to set up or the install fails. */
  setUp(): Promise<SandboxSetupResult>;
}

const MESSAGE = {
  nothingToSetUp: "There is nothing to set up: the protected workspace is not waiting on an install.",
} as const;

/** The step a starting core is on once it passes each of its boot marks (`StudioCore.init`). */
const STEP_AFTER_MARK: Readonly<Record<string, StartStep>> = {
  "core:games": StartStep.Workspace,
  "core:sandbox": StartStep.Studio,
};

/** The step a starting core moved on to at boot mark `mark`, or null when that mark starts none. */
export function startStepAfter(mark: string): StartStep | null {
  return STEP_AFTER_MARK[mark] ?? null;
}

/** What a Set up runs instead of the install once one has gone through this launch. */
const ALREADY_INSTALLED = async (): Promise<SandboxInstall> => ({ cancelled: false });

/** Showing a failure whose Try again shows the next one's words: the studio's, or its agents'. */
function showsFailure(state: BootState): boolean {
  return state.phase === BootPhase.Failed || state.failure !== undefined;
}

/** Held on the problem Set up fixes: a sandbox that has not been provisioned yet. */
function waitsOnInstall(state: BootState): state is BootState & { sandbox: SandboxProblem } {
  return state.phase === BootPhase.SandboxSetup && state.sandbox?.code === SandboxProblemCode.NotProvisioned;
}

/** A gate for this launch's `platform`, starting Ready. */
export function createBootGate(platform: string, options: BootGateOptions = {}): BootGate {
  const ready: BootState = { platform, phase: BootPhase.Ready, sandbox: null };
  let state: BootState = ready;
  let attempt: (() => Promise<void>) | null = null;
  // Bumped by every hold: an attempt that ends on a hold of its own (a harness that would not
  // start after the sandbox did) keeps it, rather than opening the studio over it.
  let holds = 0;
  let running: Promise<BootState> | null = null;
  let installing: Promise<SandboxSetupResult> | null = null;
  // The install went through but the startup after it failed: the sandbox is there, so the next
  // Set up only starts again, without another administrator prompt.
  let installed = false;

  const settle = async (run: () => Promise<void>): Promise<BootState> => {
    const held = holds;
    try {
      await run();
      if (holds === held) {
        attempt = null;
        state = ready;
      }
    } catch (error) {
      if (error instanceof SandboxUnavailableError) {
        state = { platform, phase: BootPhase.SandboxSetup, sandbox: error.problem };
      } else if (showsFailure(state)) {
        state = { ...state, failure: errorMessage(error) };
      } else {
        throw error;
      }
    }
    return state;
  };

  const retry = (): Promise<BootState> => {
    if (!attempt) return Promise.resolve(state);
    running ??= settle(attempt).finally(() => {
      running = null;
    });
    return running;
  };

  const install = async (run: () => Promise<SandboxInstall>): Promise<SandboxSetupResult> => {
    const { cancelled } = await (installed ? ALREADY_INSTALLED : run)();
    if (cancelled) return { outcome: SandboxSetupOutcome.Cancelled, state };
    installed = true;
    const after = await retry();
    // Still waiting on its install after one: the next Set up installs again.
    installed = !waitsOnInstall(after);
    return { outcome: SandboxSetupOutcome.Installed, state: after };
  };

  // Set once Set up first runs: a window that loads again does not run it by itself again.
  let tried = false;
  return {
    state: () => (tried ? { ...state, setupTried: true } : state),
    starting(step) {
      state = { platform, phase: BootPhase.Starting, sandbox: null, step };
    },
    progress(step) {
      if (state.phase === BootPhase.Starting) state = { ...state, step };
    },
    ready() {
      attempt = null;
      state = ready;
    },
    hold(problem, next) {
      holds++;
      state = { platform, phase: BootPhase.SandboxSetup, sandbox: problem };
      attempt = next;
    },
    fail(error, next) {
      holds++;
      state = { platform, phase: BootPhase.Failed, sandbox: null, failure: error };
      attempt = next;
    },
    agentsFailed(error, next) {
      holds++;
      state = { ...ready, failure: error };
      attempt = next;
    },
    overdue(error, next) {
      if (state.phase !== BootPhase.Starting) return false;
      this.fail(error, next);
      return true;
    },
    retry,
    setUp() {
      if (installing) return installing;
      const run = options.installSandbox;
      if (!run || !waitsOnInstall(state)) return Promise.reject(new Error(MESSAGE.nothingToSetUp));
      tried = true;
      const problem = state.sandbox;
      installing = install(() => run(problem))
        .catch((error: unknown) => {
          options.setUpFailed?.(error);
          throw error;
        })
        .finally(() => {
          installing = null;
        });
      return installing;
    },
  };
}
