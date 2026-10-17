import { sameSnapshot } from "../../state/snapshot-equality.ts";
/**
 * A game that builds itself can fail to build, and until now that reached the game's console
 * and nobody else: the stage went black with no sentence on it. This watches for that and says it.
 */
import type { JSX } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { BuildProblem } from "../../../shared/build-problem.ts";
import { Button } from "../../ui/Button.tsx";
import { ConfirmSheet } from "../../ui/Confirm.tsx";
import { SETUP_SCRIPTS_WORDS, TOAST_WORDS } from "../../words.ts";
import { type Notify, notifyProblem, ToastTone } from "../../state/toasts.ts";

/** How often the stage asks whether the game's own build is broken. */
const BUILD_TICK_MS = 2_500;

const SCRIPTS = SETUP_SCRIPTS_WORDS;

/** The game's build problem, polled while a game is open, and installing its packages when that is the fix. */
export function useBuildProblem(
  project: string | null,
  loadLive: (target: string, load: () => Promise<unknown>) => Promise<unknown>,
  onNotice: Notify,
) {
  const [buildProblem, setBuildProblem] = useState<BuildProblem | null>(null);
  const buildProblemRef = useRef(false);
  buildProblemRef.current = buildProblem !== null;
  const [installing, setInstalling] = useState(false);
  /** What an install that failed printed — shown where the build's own lines are shown. */
  const [installLines, setInstallLines] = useState<string[] | null>(null);
  useEffect(() => {
    setBuildProblem(null);
    // What another game's install printed is not this game's trouble, and the strip labels these
    // lines with whichever package manager the game on screen uses.
    setInstallLines(null);
    if (!project) return;
    let cancelled = false;
    const refresh = () => {
      if (document.hidden) return;
      void window.studio
        .buildProblem(project)
        .then((problem) => {
          if (cancelled) return;
          setBuildProblem((current) => (sameSnapshot(current, problem) ? current : problem));
          // Once the game builds, the install that failed is history: it must not come back above
          // the next build that breaks. (A build still failing keeps it — it is why it fails.)
          if (!problem) setInstallLines(null);
        })
        .catch(() => {});
    };
    document.addEventListener("visibilitychange", refresh);
    const timer = setInterval(refresh, BUILD_TICK_MS);
    refresh();
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", refresh);
      clearInterval(timer);
    };
  }, [project]);

  /** Install the packages; `scripts`: the person trusts the game's setup scripts, which run too. */
  const install = useCallback(
    (scripts: boolean) => {
      if (!project || installing) return;
      setInstalling(true);
      setInstallLines(null);
      void window.studio
        .installPackages(project, { scripts })
        .then((result) => {
          if (!result.ok) {
            setInstallLines(result.lines);
            onNotice(TOAST_WORDS.packagesFailed, ToastTone.Error);
            return;
          }
          setInstallLines(null);
          onNotice(TOAST_WORDS.packagesInstalled, ToastTone.Ok);
          void loadLive(project, () => window.studio.reloadPreview()).catch(() => {});
        })
        .catch(notifyProblem(onNotice))
        .finally(() => setInstalling(false));
    },
    [project, installing, onNotice, loadLive],
  );
  const installPackages = useCallback(() => install(false), [install]);
  const runSetupScripts = useCallback(() => install(true), [install]);
  return { buildProblem, buildProblemRef, installing, installLines, installPackages, runSetupScripts };
}

/** Whether the strip offers a remix's skipped setup scripts: its packages are there, their scripts are not. */
const offersScripts = (problem: BuildProblem): boolean => !problem.needsInstall && problem.skippedScripts !== null;

/** What the strip says about the build: packages missing, setup scripts skipped, the last working build on show, or an error to fix. */
function troubleWords(problem: BuildProblem): string {
  if (problem.needsInstall) return "Its packages aren’t installed yet.";
  if (offersScripts(problem)) return SCRIPTS.trouble;
  return problem.showingLastBuild
    ? "Showing the last working build. The newest changes aren’t included."
    : "Fix the build error, then try again.";
}

/**
 * What the stage says when a game that builds itself did not build. The words are the stage's,
 * not the toolchain's: the payload carries the command and the first three lines it printed,
 * and those stay behind "Details" where a command belongs.
 */
export function BuildTrouble({
  problem,
  installing,
  installLines,
  onInstall,
  onRunScripts,
  onReload,
}: {
  problem: BuildProblem;
  installing: boolean;
  installLines: string[] | null;
  onInstall: () => void;
  /** Run the setup scripts a remix's install skipped, once the person trusts the game. */
  onRunScripts: () => void;
  onReload: () => void;
}): JSX.Element {
  const [asking, setAsking] = useState(false);
  const skipped = problem.skippedScripts;
  return (
    <div data-build-problem className="flex shrink-0 flex-col gap-1.5 border-b border-line bg-surface px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-body-sm font-medium text-ink">The game didn’t build</span>
        <span className="min-w-32 flex-1 text-xs leading-relaxed text-ink-3">{troubleWords(problem)}</span>
        {problem.needsInstall && problem.install ? (
          <Button
            aria-label="Install packages"
            title="Download the packages this game needs"
            disabled={installing}
            onClick={onInstall}
          >
            {installing ? "Installing…" : "Install packages"}
          </Button>
        ) : (
          <>
            {offersScripts(problem) && (
              <Button
                data-build-scripts
                aria-label={SCRIPTS.button}
                title={SCRIPTS.buttonTitle}
                disabled={installing}
                onClick={() => setAsking(true)}
              >
                {installing ? SCRIPTS.running : SCRIPTS.button}
              </Button>
            )}
            <Button variant="ghost" aria-label="Try the build again" title="Build the game again" onClick={onReload}>
              Try again
            </Button>
          </>
        )}
      </div>
      {asking && skipped && (
        <ConfirmSheet
          testId="setup-scripts"
          title={SCRIPTS.title}
          body={SCRIPTS.body(skipped.own, skipped.packages)}
          onDismiss={() => setAsking(false)}
          choices={[
            { label: SCRIPTS.notNow, detail: SCRIPTS.notNowDetail, onChoose: () => setAsking(false) },
            {
              label: SCRIPTS.run,
              detail: SCRIPTS.runDetail,
              onChoose: () => {
                setAsking(false);
                onRunScripts();
              },
            },
          ]}
        />
      )}
      <details className="text-xs text-ink-3">
        <summary className="cursor-pointer select-none text-ink-3 hover:text-ink-2">Details</summary>
        <pre className="m-0 mt-1 overflow-x-auto whitespace-pre-wrap break-words font-mono text-micro leading-relaxed text-ink-2">
          {[
            ...(installLines ? [`${problem.install ?? "install"} failed`, ...installLines, ""] : []),
            `${problem.command} (exit ${problem.code ?? "stopped"})`,
            ...problem.lines,
          ].join("\n")}
        </pre>
      </details>
    </div>
  );
}
