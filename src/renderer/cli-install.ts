/**
 * An in-app CLI install as every Install button shows it (first launch, Settings, the chat's
 * sign-in card): whether it runs, why the last one failed, and the press that starts or joins it.
 * Main owns the job; this reads it once and then follows its events.
 */
import { useCallback, useEffect, useState } from "react";
import {
  CliInstallOperation,
  CliInstallPhase,
  CliInstallProblem,
  type CliInstallJob,
  installsInApp,
} from "../shared/cli-install.ts";
import { t } from "../shared/i18n.ts";
import { EngineId, providerInfo } from "../shared/providers.ts";
import { UiEvent } from "../shared/ui-events.ts";
import { reportCliInstallRefused } from "./analytics/welcome-report.ts";
import { hostPlatform } from "./platform.ts";
import { problemWords } from "./words.ts";

/** What each failed install says, by why it failed. */
const PROBLEM: Record<CliInstallProblem, (name: string) => string> = {
  [CliInstallProblem.Download]: (name) =>
    t("Couldn't download {name}. Check your internet connection and try again.", { name }),
  [CliInstallProblem.Installer]: (name) => t("{name} didn't install. Try again.", { name }),
  [CliInstallProblem.TimedOut]: (name) => t("Installing {name} took too long. Try again.", { name }),
  [CliInstallProblem.NotFound]: (name) => t("{name} installed, but Genex can't find it. Try again.", { name }),
  [CliInstallProblem.Unsupported]: (name) =>
    t("Genex can't install {name} on this computer. Install it with its guide, then check again.", { name }),
  [CliInstallProblem.AppManaged]: (name) =>
    t("This {name} is part of a desktop app, so only that app can update it. Update the app, then check again.", {
      name,
    }),
};

/** The desktop app that ships each CLI inside itself, by its own name. */
const SHIPPING_APP: Readonly<Record<string, string>> = {
  [EngineId.Codex]: "ChatGPT",
  [EngineId.ClaudeCode]: "Claude",
};

/** What an update of an app's own copy says: which app to update. */
function appManagedWords(provider: string): string {
  const name = providerInfo(provider)?.label ?? provider;
  if (!Object.hasOwn(SHIPPING_APP, provider)) return PROBLEM[CliInstallProblem.AppManaged](name);
  return t("This {name} comes with the {app} app. Update the {app} app, then check again.", {
    name,
    app: SHIPPING_APP[provider],
  });
}

/** What a failed install says, or null when the job did not fail. */
export function cliInstallProblemWords(job: CliInstallJob | null): string | null {
  if (job?.phase !== CliInstallPhase.Failed || !job.problem) return null;
  if (job.problem === CliInstallProblem.AppManaged) return appManagedWords(job.provider);
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
 * `provider`'s in-app install: the latest job, whether it runs, what went wrong, and Install.
 * `inApp` is false where its vendor publishes no installer Genex can run (`installsInApp`): the row
 * offers the install guide instead of an Install that can only fail.
 */
export function useCliInstall(provider: string) {
  const [job, setJob] = useState<CliInstallJob | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
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
      if (event.type === UiEvent.CliInstall && event.payload.provider === provider) setJob(event.payload);
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
      reportCliInstallRefused(provider, CliInstallOperation.Install, err);
      setRefused(problemWords(err));
    }
  }, [provider]);
  const update = useCallback(async (): Promise<void> => {
    setRefused(null);
    try {
      const started = await window.studio.cliUpdate(provider);
      setJob((current) => newerReport(current, started));
    } catch (err) {
      reportCliInstallRefused(provider, CliInstallOperation.Update, err);
      setRefused(problemWords(err));
    }
  }, [provider]);
  const installing = job?.phase === CliInstallPhase.Installing;
  const inApp = installsInApp(provider, hostPlatform());
  return { job, installing, inApp, problem: refused ?? cliInstallProblemWords(job), install, update };
}
