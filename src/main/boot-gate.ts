/**
 * Where startup stands, for the window. Normally the core starts and the gate stays Ready. When
 * the process sandbox cannot start, main holds the gate on the setup screen with the problem and
 * the step that re-runs core startup; Retry runs that step once (presses while it runs share it)
 * and the gate opens, or shows the problem the new attempt found. Any other failure is the
 * caller's: it rejects and leaves the setup state as it was.
 *
 * On Windows the missing piece is a one-time install behind an administrator prompt, which Set up
 * runs (`installSandbox`); once installed it retries, and a dismissed prompt changes nothing. On
 * Linux under Ubuntu's user-namespace restriction Set up installs Genex's AppArmor profile (one
 * password prompt); AppArmor attaches a profile only when a program starts, so an install there
 * restarts the app instead of retrying in this process.
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
  /** The install takes effect only in a new process (Linux: AppArmor attaches a profile at exec). */
  restart?: boolean;
}

export interface BootGateOptions {
  /** Install what the held problem is missing (one administrator prompt); throws when the install fails. */
  installSandbox?: () => Promise<SandboxInstall>;
  /** Start the app again, for an install that asks for it; main relaunches and quits. */
  restart?: () => void;
}

/** The boot state main answers `studio:boot` with, and the Retry behind `studio:boot.retry`. */
export interface BootGate {
  state(): BootState;
  /** Show the setup screen for `problem`; `attempt` re-runs startup and throws while the sandbox is still unavailable. */
  hold(problem: SandboxProblem, attempt: () => Promise<void>): void;
  /** Run the held attempt; the state after it. */
  retry(): Promise<BootState>;
  /** Install the sandbox, then retry (or restart the app); throws when there is nothing to set up or the install fails. */
  setUp(): Promise<SandboxSetupResult>;
}

const MESSAGE = {
  nothingToSetUp: "There is nothing to set up: the protected workspace is not waiting on an install.",
} as const;

/**
 * Held on a problem Set up fixes: a Windows sandbox that has not been provisioned yet, or Ubuntu's
 * restriction with a profile that can name this copy of Genex.
 */
function waitsOnInstall(state: BootState): boolean {
  if (state.phase !== BootPhase.SandboxSetup || !state.sandbox) return false;
  const { code, apparmor } = state.sandbox;
  const installsProfile = code === SandboxProblemCode.UsernsRestricted && apparmor !== undefined;
  return code === SandboxProblemCode.NotProvisioned || installsProfile;
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
    const { cancelled, restart } = await run();
    if (cancelled) return { outcome: SandboxSetupOutcome.Cancelled, state };
    if (restart && options.restart) {
      options.restart();
      return { outcome: SandboxSetupOutcome.Restarting, state };
    }
    return { outcome: SandboxSetupOutcome.Installed, state: await retry() };
  };

  return {
    state: () => state,
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
