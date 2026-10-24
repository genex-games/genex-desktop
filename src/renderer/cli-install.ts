/**
 * An in-app CLI install as every Install button shows it (first launch, Settings, the chat's
 * sign-in card): whether it runs, why the last one failed, and the press that starts or joins it.
 * Main owns the job; this reads it once and then follows its events.
 */
import { useCallback, useEffect, useState } from "react";
import { CliInstallOperation, CliInstallPhase, CliInstallProblem, type CliInstallJob } from "../shared/cli-install.ts";
import { SECOND_MS } from "../shared/duration.ts";
import { t } from "../shared/i18n.ts";
import { providerInfo } from "../shared/providers.ts";
import { UiEvent } from "../shared/ui-events.ts";
import { useEngines } from "./state/hooks.ts";
import { problemWords } from "./words.ts";

/** Longest an install that finished here may read as running while the engines are read again. */
const ENGINES_REREAD_WAIT_MS = 30 * SECOND_MS;

/** What each failed install says, by why it failed. */
const PROBLEM: Record<CliInstallProblem, (name: string) => string> = {
  [CliInstallProblem.Download]: (name) =>
    t("Couldn't download {name}. Check your internet connection and try again.", { name }),
  [CliInstallProblem.Installer]: (name) => t("{name} didn't install. Try again.", { name }),
  [CliInstallProblem.TimedOut]: (name) => t("Installing {name} took too long. Try again.", { name }),
  [CliInstallProblem.NotFound]: (name) => t("{name} installed, but Genex can't find it. Try again.", { name }),
};

/** What a failed install says, or null when the job did not fail. */
export function cliInstallProblemWords(job: CliInstallJob | null): string | null {
  if (job?.phase !== CliInstallPhase.Failed || !job.problem) return null;
  if (job.operation === CliInstallOperation.Update)
    return t(
      "Could not update this installation. Open the installation guide or use its package manager, then check again.",
    );
  return PROBLEM[job.problem](providerInfo(job.provider)?.label ?? job.provider);
}

/** The later of two reports: Install's answer arriving after the install's own news never undoes it. */
export function newerReport(current: CliInstallJob | null, next: CliInstallJob): CliInstallJob {
  const alreadyFinished =
    current !== null && current.startedAt === next.startedAt && current.phase !== CliInstallPhase.Installing;
  return alreadyFinished ? current : next;
}

/**
 * The install that finished while this surface watched and still waits for the engines to be read
 * again (its `startedAt`), or null: main reports the install done before the engines list says the
 * CLI is there, and in between the row would offer Install again.
 */
export function finishingInstall(news: { job: CliInstallJob } | { enginesRead: true }): string | null {
  if (!("job" in news)) return null;
  return news.job.phase === CliInstallPhase.Installed ? news.job.startedAt : null;
}

/** Whether the row shows `job` as running: it runs, or it just finished and the engines are not read yet. */
export function installRunning(job: CliInstallJob | null, waiting: string | null): boolean {
  if (job?.phase === CliInstallPhase.Installing) return true;
  return job?.phase === CliInstallPhase.Installed && waiting === job.startedAt;
}

/** `provider`'s in-app install: the latest job, whether it runs, what went wrong, and Install. */
export function useCliInstall(provider: string) {
  const [job, setJob] = useState<CliInstallJob | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const [waiting, setWaiting] = useState<string | null>(null);
  const engines = useEngines((state) => state.list);
  // A new engines list is the read that shows the finished install's CLI.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs for each new list, which it never reads
  useEffect(() => {
    setWaiting(finishingInstall({ enginesRead: true }));
  }, [engines]);
  // A read that never comes must not leave the row installing.
  useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout(() => setWaiting(null), ENGINES_REREAD_WAIT_MS);
    return () => clearTimeout(timer);
  }, [waiting]);
  useEffect(() => {
    let alive = true;
    setJob(null);
    void window.studio
      .cliInstallStatus()
      .then((jobs) => {
        const latest = jobs.find((candidate) => candidate.provider === provider);
        if (alive && latest) setJob((current) => newerReport(current, latest));
      })
      .catch(() => {});
    const unsubscribe = window.studio.onEvent((event) => {
      if (event.type !== UiEvent.CliInstall || event.payload.provider !== provider) return;
      const job = event.payload;
      setJob(job);
      setWaiting(finishingInstall({ job }));
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [provider]);
  const install = useCallback(async (): Promise<void> => {
    setRefused(null);
    try {
      const started = await window.studio.cliInstall(provider);
      setJob((current) => newerReport(current, started));
    } catch (err) {
      setRefused(problemWords(err));
    }
  }, [provider]);
  const update = useCallback(async (): Promise<void> => {
    setRefused(null);
    try {
      const started = await window.studio.cliUpdate(provider);
      setJob((current) => newerReport(current, started));
    } catch (err) {
      setRefused(problemWords(err));
    }
  }, [provider]);
  const installing = installRunning(job, waiting);
  return { job, installing, problem: refused ?? cliInstallProblemWords(job), install, update };
}
