import { sameSnapshot } from "../../state/snapshot-equality.ts";
/**
 * A game that builds itself can fail to build, and until now that reached the game's console
 * and nobody else: the stage went black with no sentence on it. This watches for that and says it.
 */
import type { JSX } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { BuildDiagnostic, BuildProblem } from "../../../shared/build-problem.ts";
import { t } from "../../../shared/i18n.ts";
import { Button } from "../../ui/Button.tsx";
import { ConfirmSheet } from "../../ui/Confirm.tsx";
import { SETUP_SCRIPTS_WORDS, TOAST_WORDS, TOOLCHAIN_WORDS } from "../../words.ts";
import { type Notify, notifyProblem, ToastTone } from "../../state/toasts.ts";
import {
  detailLines,
  diagnosticKey,
  diagnosticPlace,
  shownDiagnostics,
  TroubleAction,
  troubleAction,
  troubleWords,
} from "./build-trouble.ts";

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

/** The first diagnostics the C++ lane parsed, each once (`shownDiagnostics`): where, what, and which tool said it. */
function Diagnostics({ diagnostics }: { diagnostics: readonly BuildDiagnostic[] }): JSX.Element | null {
  const shown = shownDiagnostics(diagnostics);
  if (shown.length === 0) return null;
  return (
    <ul className="m-0 flex list-none flex-col gap-0.5 p-0 text-xs leading-relaxed text-ink-2">
      {shown.map((diagnostic) => {
        const place = diagnosticPlace(diagnostic);
        return (
          <li key={diagnosticKey(diagnostic)} className="min-w-0 break-words">
            {place ? <span className="font-mono text-micro text-ink">{place}</span> : null}
            {place ? " " : null}
            {diagnostic.message}
            <span className="text-ink-3"> · {diagnostic.tool}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** The sheet button's words for the tools problems that are not a missing tool. */
const SHEET_LABELS: Partial<Record<TroubleAction, string>> = {
  [TroubleAction.SetUpTools]: TOOLCHAIN_WORDS.setUpAgain,
  [TroubleAction.FinishSetUp]: TOOLCHAIN_WORDS.setUp,
};

/** The strip's way on: install the packages, open the Toolchain sheet (to install or set up), or build again. */
function TroubleButtons({
  action,
  installing,
  onInstall,
  onInstallTools,
  onReload,
}: {
  action: TroubleAction;
  installing: boolean;
  onInstall: () => void;
  onInstallTools: () => void;
  onReload: () => void;
}): JSX.Element {
  if (action === TroubleAction.InstallPackages)
    return (
      <Button
        aria-label={t("Install packages")}
        title={t("Download the packages this game needs")}
        disabled={installing}
        onClick={onInstall}
      >
        {installing ? t("Installing…") : t("Install packages")}
      </Button>
    );
  const again = (
    <Button variant="ghost" aria-label={t("Try the build again")} title={t("Build the game again")} onClick={onReload}>
      {t("Try again")}
    </Button>
  );
  if (action === TroubleAction.TryAgain) return again;
  // Each opens the Toolchain sheet: to install the tools, to set up again what an older Genex set
  // up, or to finish setting up tools that are installed.
  const label = SHEET_LABELS[action] ?? "Install tools";
  return (
    <>
      <Button data-build-install-tools="" title="Set up the C++ tools this game builds with" onClick={onInstallTools}>
        {label}
      </Button>
      {again}
    </>
  );
}

/**
 * Under a failed build's words: the compiler's diagnostics, then the command and what it printed
 * behind "Details", where a command belongs. The native run card shows a failed Mac build's with it.
 */
export function TroubleDetails({
  problem,
  installLines,
}: {
  problem: BuildProblem;
  installLines: string[] | null;
}): JSX.Element {
  const details = detailLines(problem, installLines);
  return (
    <>
      {problem.diagnostics ? <Diagnostics diagnostics={problem.diagnostics} /> : null}
      {details.length > 0 ? (
        <details className="text-xs text-ink-3">
          <summary className="cursor-pointer select-none text-ink-3 hover:text-ink-2">{t("Details")}</summary>
          <pre className="m-0 mt-1 overflow-x-auto whitespace-pre-wrap break-words font-mono text-micro leading-relaxed text-ink-2">
            {details.join("\n")}
          </pre>
        </details>
      ) : null}
    </>
  );
}

/** Whether the strip offers a remix's skipped setup scripts: its packages are there, their scripts are not. */
const offersScripts = (problem: BuildProblem): boolean => !problem.needsInstall && problem.skippedScripts !== null;

/** What the strip says about the build: a remix's setup scripts skipped, else the lane's words (`troubleWords`). */
function stripWords(problem: BuildProblem): string {
  return offersScripts(problem) ? SCRIPTS.trouble : troubleWords(problem);
}

/**
 * What the stage says when a game that builds itself did not build. The words are the stage's,
 * not the toolchain's: the payload carries the command and the first three lines it printed,
 * and those stay behind "Details" where a command belongs. A build that never ran for want of
 * C++ tools offers the Toolchain sheet.
 */
export function BuildTrouble({
  problem,
  installing,
  installLines,
  onInstall,
  onInstallTools,
  onRunScripts,
  onReload,
}: {
  problem: BuildProblem;
  installing: boolean;
  installLines: string[] | null;
  onInstall: () => void;
  onInstallTools: () => void;
  /** Run the setup scripts a remix's install skipped, once the person trusts the game. */
  onRunScripts: () => void;
  onReload: () => void;
}): JSX.Element {
  const [asking, setAsking] = useState(false);
  const skipped = problem.skippedScripts;
  return (
    <div data-build-problem className="flex shrink-0 flex-col gap-1.5 border-b border-line bg-surface px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-body-sm font-medium text-ink">{t("The game didn’t build")}</span>
        <span className="min-w-32 flex-1 text-xs leading-relaxed text-ink-3">{stripWords(problem)}</span>
        {/* One group at the row's end: on a narrow stage the buttons move under the words together. */}
        <span className="ms-auto flex shrink-0 items-center gap-2">
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
          <TroubleButtons
            action={troubleAction(problem)}
            installing={installing}
            onInstall={onInstall}
            onInstallTools={onInstallTools}
            onReload={onReload}
          />
        </span>
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
      <TroubleDetails problem={problem} installLines={installLines} />
    </div>
  );
}
