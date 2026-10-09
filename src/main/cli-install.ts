/**
 * In-app installs of Claude Code and Codex: one job per CLI, started from any Install button and
 * shown by all of them, so a second press joins the running install rather than starting another.
 * When the installer finishes, the CLI is looked for afresh; an installer that exits cleanly but
 * leaves no working CLI is a failure. The installer's own words go to the log, never the screen.
 */
import { CliInstallOperation, CliInstallPhase, CliInstallProblem, type CliInstallJob } from "../shared/cli-install.ts";
import type { CodingProvider } from "../shared/coding-cli.ts";
import { EngineId } from "../shared/providers.ts";
import { UiEvent } from "../shared/ui-events.ts";
import type { InstallOutcome } from "../substrate/cli-installer.ts";

/** What an install needs from the app. */
export interface CliInstallsDeps {
  /** Fetch and run the CLI's official installer. */
  install(provider: CodingProvider): Promise<InstallOutcome>;
  update?(provider: CodingProvider): Promise<InstallOutcome>;
  busy?(): boolean;
  /** Discover the CLI afresh (and re-read its sign-in): whether it now works. */
  found(provider: CodingProvider): Promise<boolean>;
  pushUiEvent(event: UiEvent): void;
  log(line: string): void;
  now?: () => Date;
}

/** Why an install request is refused, and what the log keeps of a failed one. */
const MESSAGE = {
  unknownProvider: (provider: unknown) => `unknown coding CLI: ${String(provider)}`,
  failed: (provider: CodingProvider, problem: CliInstallProblem, detail: string) =>
    `cli install ${provider} failed (${problem}): ${detail}`,
  notFound: "the installer finished but the CLI was not found or does not work",
} as const;

/** The CLIs an Install button can install. */
const INSTALLABLE: readonly CodingProvider[] = [EngineId.ClaudeCode, EngineId.Codex, EngineId.OpenCode];

const isInstallable = (value: unknown): value is CodingProvider =>
  typeof value === "string" && (INSTALLABLE as readonly string[]).includes(value);

/** The install jobs: start one, join one, and read the latest of each. */
export function createCliInstalls(deps: CliInstallsDeps) {
  const now = deps.now ?? (() => new Date());
  const jobs = new Map<CodingProvider, CliInstallJob>();
  const running = new Map<CodingProvider, Promise<CliInstallJob>>();

  const publish = (job: CliInstallJob): CliInstallJob => {
    jobs.set(job.provider, job);
    deps.pushUiEvent({ type: UiEvent.CliInstall, payload: job });
    return job;
  };

  /** Run the installer, then look for the CLI: the problem, or none when it works. */
  const attempt = async (
    provider: CodingProvider,
    operation?: CliInstallOperation,
  ): Promise<CliInstallProblem | undefined> => {
    let outcome: InstallOutcome;
    try {
      if (operation === CliInstallOperation.Update) {
        if (deps.busy?.()) throw new Error("Wait for active work to finish before updating.");
        if (!deps.update) throw new Error("CLI updates are unavailable");
        outcome = await deps.update(provider);
      } else outcome = await deps.install(provider);
    } catch (err) {
      outcome = { ok: false, problem: CliInstallProblem.Installer, detail: String(err) };
    }
    if (!outcome.ok) {
      deps.log(MESSAGE.failed(provider, outcome.problem, outcome.detail));
      return outcome.problem;
    }
    if (await deps.found(provider).catch(() => false)) return undefined;
    deps.log(MESSAGE.failed(provider, CliInstallProblem.NotFound, MESSAGE.notFound));
    return CliInstallProblem.NotFound;
  };

  const run = async (started: CliInstallJob): Promise<CliInstallJob> => {
    const problem = await attempt(started.provider, started.operation);
    const finishedAt = now().toISOString();
    if (problem) return publish({ ...started, phase: CliInstallPhase.Failed, problem, finishedAt });
    const done = publish({ ...started, phase: CliInstallPhase.Installed, finishedAt });
    deps.pushUiEvent({ type: UiEvent.EnginesChanged, payload: { engine: started.provider } });
    return done;
  };

  return {
    /** Start `provider`'s install, or return the one already running. Anything else is refused. */
    start(provider: unknown, operation: CliInstallOperation = CliInstallOperation.Install): CliInstallJob {
      if (!isInstallable(provider)) throw new Error(MESSAGE.unknownProvider(provider));
      const current = jobs.get(provider);
      if (current?.phase === CliInstallPhase.Installing) return current;
      if (operation === CliInstallOperation.Update && deps.busy?.())
        throw new Error("Wait for active work to finish before updating.");
      const job = publish({ provider, operation, phase: CliInstallPhase.Installing, startedAt: now().toISOString() });
      running.set(
        provider,
        run(job).finally(() => running.delete(provider)),
      );
      return job;
    },
    /** The latest install of each CLI, running or finished. */
    status(): CliInstallJob[] {
      return [...jobs.values()];
    },
    /** The running install of `provider` as it ends, or its last job when none runs. */
    async settled(provider: CodingProvider): Promise<CliInstallJob | undefined> {
      return (await running.get(provider)) ?? jobs.get(provider);
    },
  };
}

/** The install jobs `createCliInstalls` keeps. */
export type CliInstalls = ReturnType<typeof createCliInstalls>;
