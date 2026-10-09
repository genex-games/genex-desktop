/**
 * Where startup stands, for the window. Normally the core starts and the gate stays Ready. When
 * the process sandbox cannot start, main holds the gate on the setup screen with the problem and
 * the step that re-runs core startup; Retry runs that step once (presses while it runs share it)
 * and the gate opens, or shows the problem the new attempt found. Any other failure is the
 * caller's: it rejects and leaves the setup state as it was.
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
} from "../shared/boot.ts";
import { SandboxUnavailableError } from "../substrate/sandbox-unavailable.ts";

/** What installing the sandbox answered: `cancelled` when the administrator prompt was dismissed. */
export interface SandboxInstall {
  cancelled: boolean;
}

export interface BootGateOptions {
  /** Install the Windows sandbox (one administrator prompt); throws when the install fails. */
  installSandbox?: () => Promise<SandboxInstall>;
  /** Start setup once in a normal Windows renderer, never in fixture or smoke runs. */
  automaticSetup?: boolean;
}

/** The boot state main answers `studio:boot` with, and the Retry behind `studio:boot.retry`. */
export interface BootGate {
  state(): BootState;
  /** Publish Ready before creating the replacement renderer after successful core initialization. */
  open(): void;
  /** Show the setup screen for `problem`; `attempt` re-runs startup and throws while the sandbox is still unavailable. */
  hold(problem: SandboxProblem, attempt: () => Promise<void>): void;
  /** Run the held attempt; the state after it. */
  retry(): Promise<BootState>;
  /** Install the sandbox, then retry; throws when there is nothing to set up or the install fails. */
  setUp(): Promise<SandboxSetupResult>;
}

const MESSAGE = {
  nothingToSetUp: "There is nothing to set up: the protected workspace is not waiting on an install.",
} as const;

/** Held on the problem Set up fixes: a sandbox that has not been provisioned yet. */
function waitsOnInstall(state: BootState): boolean {
  const code = state.sandbox?.code;
  const installable = code === SandboxProblemCode.NotProvisioned || code === SandboxProblemCode.GitMissing;
  return state.phase === BootPhase.SandboxSetup && installable;
}

/** A gate for this launch's `platform`, starting Ready. */
export function createBootGate(platform: string, options: BootGateOptions = {}): BootGate {
  let state: BootState = { platform, phase: BootPhase.Ready, sandbox: null };
  let attempt: (() => Promise<void>) | null = null;
  let running: Promise<BootState> | null = null;
  let installing: Promise<SandboxSetupResult> | null = null;

  const settle = async (run: () => Promise<void>): Promise<BootState> => {
    try {
      await run();
      attempt = null;
      state = { platform, phase: BootPhase.Ready, sandbox: null };
    } catch (error) {
      if (!(error instanceof SandboxUnavailableError)) throw error;
      state = { platform, phase: BootPhase.SandboxSetup, sandbox: error.problem };
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
    const { cancelled } = await run();
    if (cancelled) return { outcome: SandboxSetupOutcome.Cancelled, state };
    return { outcome: SandboxSetupOutcome.Installed, state: await retry() };
  };

  return {
    state: () => (options.automaticSetup ? { ...state, automaticSetup: true } : state),
    open() {
      attempt = null;
      state = { platform, phase: BootPhase.Ready, sandbox: null };
    },
    hold(problem, next) {
      state = { platform, phase: BootPhase.SandboxSetup, sandbox: problem };
      attempt = next;
    },
    retry,
    setUp() {
      if (installing) return installing;
      const run = options.installSandbox;
      if (!run || !waitsOnInstall(state)) return Promise.reject(new Error(MESSAGE.nothingToSetUp));
      installing = install(run).finally(() => {
        installing = null;
      });
      return installing;
    },
  };
}
