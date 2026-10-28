/**
 * The window's first screen when the process sandbox cannot start: "Set up the protected
 * workspace". It says why agents need it, names what is missing with the exact commands that
 * install it (or, where AppArmor blocks the isolation, the command that allows it), and offers Retry, which re-runs core startup in main (`state/boot.ts`). On Windows,
 * where the missing piece is a one-time install, the window runs it by itself instead: "Setting up
 * Genex" over the installer's animation while Windows asks for approval, then the studio.
 * The same card says which step a Windows start is on ("Starting Genex"), and that the studio
 * would not start ("Genex couldn't start") with Try again, a report and Quit.
 * Each of them offers a new version downloaded meanwhile (`BootUpdate`): it may fix what stopped the start.
 * It also shows Genex moving its files to the folder chosen in Settings → Storage, and a data
 * folder that is not there.
 * `BootRoot` chooses between these, the studio itself, and nothing while main has not answered yet.
 */
import { type JSX, type ReactNode, useState } from "react";
import { type ReadyUpdate, UpdateAction } from "../shared/app-update.ts";
import { type InstallCommand, type SandboxProblem, StartStep, toolPackage, WindowsSetupNeed } from "../shared/boot.ts";
import type { DataMoveProgress } from "../shared/data-folder.ts";
import { App } from "./App.tsx";
import { useAppLoaderDismissal } from "./app-loader.ts";
import { type Boot, BootView, bootView, canSetUp, SetupReport } from "./state/boot.ts";
import { useBoot } from "./state/hooks.ts";
import { Button } from "./ui/Button.tsx";
import { UPDATE_WORDS, SANDBOX_SETUP_WORDS as WORDS } from "./words.ts";

/** The studio, the setup screen, or nothing until main says which. */
export function BootRoot({ boot }: { boot: Boot }): JSX.Element | null {
  const view = useBoot(boot.store, bootView);
  const problem = useBoot(boot.store, (s) => s.problem);
  const retrying = useBoot(boot.store, (s) => s.retrying);
  const error = useBoot(boot.store, (s) => s.error);
  const installable = useBoot(boot.store, canSetUp);
  const settingUp = useBoot(boot.store, (s) => s.settingUp);
  const report = useBoot(boot.store, (s) => s.report);
  const step = useBoot(boot.store, (s) => s.step);
  const move = useBoot(boot.store, (s) => s.move);
  const dataFolder = useBoot(boot.store, (s) => s.dataFolder);
  const update = useBoot(boot.store, (s) => s.update);
  const onUpdate = (): void => void boot.restartToUpdate();
  // The studio dismisses the startup loader once its own first screen is drawn; the others are drawn now.
  useAppLoaderDismissal(view !== BootView.Studio && view !== BootView.Loading);
  if (view === BootView.Studio) return <App />;
  // Try again starts the studio again: the card says so until it opens, or fails again.
  if (view === BootView.Starting || (view === BootView.Failed && retrying))
    return <StartingCard step={step ?? StartStep.Studio} update={update} onUpdate={onUpdate} />;
  const dataCard = dataFolderCard({ view, move, dataFolder, error, retrying, boot });
  if (dataCard) return dataCard;
  if (view === BootView.Failed) {
    return (
      <StartFailed
        error={error}
        report={report}
        onRetry={() => void boot.retry()}
        onReport={() => void boot.report()}
        onQuit={() => void boot.quit()}
        update={update}
        onUpdate={onUpdate}
      />
    );
  }
  if (view === BootView.Loading || !problem) return null;
  if (installable) {
    return (
      <WindowsSetup
        problem={problem}
        settingUp={settingUp}
        error={error}
        report={report}
        onSetUp={() => void boot.setUp()}
        onReport={() => void boot.report()}
        update={update}
        onUpdate={onUpdate}
      />
    );
  }
  return (
    <SandboxSetup
      problem={problem}
      retrying={retrying}
      error={error}
      onRetry={() => void boot.retry()}
      update={update}
      onUpdate={onUpdate}
    />
  );
}

/** What the Windows card says: working through Set up, waiting for an OK it did not get, or failed. */
const WindowsStep = {
  SettingUp: "setting-up",
  NeedsOk: "needs-ok",
  Failed: "failed",
} as const;
type WindowsStep = (typeof WindowsStep)[keyof typeof WindowsStep];

/** The card's title and line for each step. */
const WINDOWS_CARD = {
  [WindowsStep.SettingUp]: WORDS.windows.settingUp,
  [WindowsStep.NeedsOk]: WORDS.windows.needsOk,
  [WindowsStep.Failed]: WORDS.windows.failed,
} satisfies Record<WindowsStep, { title: string; line: string }>;

/** The installer's animation (forge's Squirrel `loadingGif`), so setup looks like the installer's next moment. */
const INSTALLING_ANIMATION = { backgroundImage: "url(media/installing.gif)" } as const;

/**
 * The installer's ripple animation filling the window, and a card at its bottom left with `title`
 * and what follows it: the Windows setup, start and start-failure screens.
 */
function AnimationCard({
  selector,
  titleId,
  title,
  children,
}: {
  selector: Record<`data-${string}`, string>;
  titleId: string;
  title: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div
      {...selector}
      style={INSTALLING_ANIMATION}
      className="relative h-full overflow-hidden bg-canvas bg-cover bg-center [image-rendering:pixelated]"
    >
      {/* The window has no title bar of its own: the top strip moves it, as the headers do. */}
      <div className="titlebar-drag absolute inset-x-0 top-0 h-12" />
      <section
        aria-labelledby={titleId}
        aria-live="polite"
        className="absolute right-6 bottom-8 left-6 flex max-w-[360px] flex-col gap-2 rounded-[14px] bg-surface px-5 py-[18px] shadow-raised [image-rendering:auto]"
      >
        <h1 id={titleId} className="text-lg font-medium text-ink">
          {title}
        </h1>
        {children}
      </section>
    </div>
  );
}

/** What is going on right now, after a softly pulsing dot. */
function WorkingLine({ text }: { text: string }): JSX.Element {
  return (
    <p className="flex items-center gap-2 font-mono text-sm text-ink-3">
      <span className="size-[7px] rounded-full bg-accent-primary animate-[records-pulse_1.4s_ease-in-out_infinite] motion-reduce:animate-none" />
      {text}
    </p>
  );
}

/** A new version downloaded before the studio opened, and the press that installs it. */
interface UpdateOffer {
  update: ReadyUpdate | null;
  onUpdate: () => void;
}

/**
 * The new version, when one waits: a line saying it may fix this, and the sidebar's own Relaunch
 * to update (or, on Linux, its Download).
 */
function BootUpdate({ update, onUpdate }: UpdateOffer): JSX.Element | null {
  if (!update) return null;
  const label = update.action === UpdateAction.Download ? UPDATE_WORDS.download(update.version) : UPDATE_WORDS.restart;
  return (
    <div data-boot-update={update.action} className="flex flex-wrap items-center gap-2 pt-2">
      <p className="text-ink-2">{WORDS.update.ready(update.version)}</p>
      <Button variant="default" onClick={onUpdate}>
        {label}
      </Button>
    </div>
  );
}

/** A Windows start before its studio opens: "Starting Genex" and the step it is on. */
export function StartingCard({ step, update, onUpdate }: { step: StartStep } & UpdateOffer): JSX.Element {
  return (
    <AnimationCard selector={{ "data-boot-starting": step }} titleId="boot-starting-title" title={WORDS.starting.title}>
      <p className="text-ink-2">{WORDS.starting.line}</p>
      <WorkingLine text={WORDS.starting.step[step]} />
      <BootUpdate update={update} onUpdate={onUpdate} />
    </AnimationCard>
  );
}

/** The screens of a launch that moves Genex's files or cannot find them, or null for any other. */
function dataFolderCard({
  view,
  move,
  dataFolder,
  error,
  retrying,
  boot,
}: {
  view: BootView;
  move: DataMoveProgress | null;
  dataFolder: string | null;
  error: string | null;
  retrying: boolean;
  boot: Boot;
}): JSX.Element | null {
  const onRetry = () => void boot.retry();
  const onQuit = () => void boot.quit();
  if (view === BootView.Moving && move && error !== null)
    return <MoveStoppedCard to={move.to} error={error} retrying={retrying} onRetry={onRetry} onQuit={onQuit} />;
  if (view === BootView.Moving && move) return <MovingCard move={move} />;
  if (view === BootView.DataMissing && dataFolder !== null)
    return <DataMissingCard dir={dataFolder} error={error} retrying={retrying} onRetry={onRetry} onQuit={onQuit} />;
  return null;
}

/** Genex moving its files before it starts again: where to, and how far. */
export function MovingCard({ move }: { move: DataMoveProgress }): JSX.Element {
  const words = WORDS.moving;
  return (
    <AnimationCard selector={{ "data-boot-moving": "" }} titleId="boot-moving-title" title={words.title}>
      <p className="text-ink-2">{words.line(move.to)}</p>
      <WorkingLine text={move.total > 0 ? words.progress(move.done, move.total) : words.counting} />
    </AnimationCard>
  );
}

/** A move that stopped part-way with some files already moved: why, Try again (carries the move on) and Quit. */
export function MoveStoppedCard({
  to,
  error,
  retrying,
  onRetry,
  onQuit,
}: {
  to: string;
  error: string;
  retrying: boolean;
  onRetry: () => void;
  onQuit: () => void;
}): JSX.Element {
  const words = WORDS.moveStopped;
  return (
    <AnimationCard selector={{ "data-boot-move-stopped": "" }} titleId="boot-move-stopped-title" title={words.title}>
      <p className="text-ink-2">{words.line(to)}</p>
      <div className="flex flex-wrap items-center gap-2 pt-2">
        <Button variant="default" data-boot-try-again disabled={retrying} onClick={onRetry}>
          {retrying ? WORDS.dataMissing.checking : words.tryAgain}
        </Button>
        <Button variant="ghost" data-boot-quit onClick={onQuit}>
          {words.quit}
        </Button>
      </div>
      <p className="text-sm text-orange">{error}</p>
    </AnimationCard>
  );
}

/** The folder Genex keeps its files in is not there: which one, Try again and Quit. */
export function DataMissingCard({
  dir,
  error,
  retrying,
  onRetry,
  onQuit,
}: {
  dir: string;
  error: string | null;
  retrying: boolean;
  onRetry: () => void;
  onQuit: () => void;
}): JSX.Element {
  const words = WORDS.dataMissing;
  return (
    <AnimationCard selector={{ "data-boot-data-missing": "" }} titleId="boot-data-missing-title" title={words.title}>
      <p className="text-ink-2">{words.line(dir)}</p>
      <div className="flex flex-wrap items-center gap-2 pt-2">
        <Button variant="default" data-boot-try-again disabled={retrying} onClick={onRetry}>
          {retrying ? words.checking : words.tryAgain}
        </Button>
        <Button variant="ghost" data-boot-quit onClick={onQuit}>
          {words.quit}
        </Button>
      </div>
      {error !== null && <p className="text-sm text-orange">{error}</p>}
    </AnimationCard>
  );
}

/** A studio whose harness would not start: Try again, a report, Quit, and the raw error under Details. */
export function StartFailed({
  error,
  report,
  onRetry,
  onReport,
  onQuit,
  update,
  onUpdate,
}: {
  error: string | null;
  report: SetupReport;
  onRetry: () => void;
  onReport: () => void;
  onQuit: () => void;
} & UpdateOffer): JSX.Element {
  const words = WORDS.startFailed;
  return (
    <AnimationCard selector={{ "data-boot-failed": "" }} titleId="boot-failed-title" title={words.title}>
      <p className="text-orange">{words.line}</p>
      <BootUpdate update={update} onUpdate={onUpdate} />
      <div className="flex flex-wrap items-center gap-2 pt-2">
        <Button variant="default" data-boot-try-again onClick={onRetry}>
          {words.tryAgain}
        </Button>
        {error !== null && <ReportAction report={report} onReport={onReport} />}
        <Button variant="ghost" data-boot-quit onClick={onQuit}>
          {words.quit}
        </Button>
      </div>
      {report === SetupReport.Failed && <p className="text-sm text-orange">{WORDS.windows.failed.reportFailed}</p>}
      {error !== null && <ErrorDetails error={error} />}
    </AnimationCard>
  );
}

/** What the card says at `step`: an update of an earlier install has words of its own until it fails. */
function windowsCardWords(step: WindowsStep, reinstall: boolean): { title: string; line: string } {
  return reinstall && step !== WindowsStep.Failed ? WORDS.windows.reinstall : WINDOWS_CARD[step];
}

function windowsStep(settingUp: boolean, error: string | null): WindowsStep {
  if (settingUp) return WindowsStep.SettingUp;
  return error === null ? WindowsStep.NeedsOk : WindowsStep.Failed;
}

/**
 * Windows' first start: the installer's ripple animation fills the window and a card at the bottom
 * left says what is happening. Set up starts by itself (`Boot.start`), so the card first waits on
 * Windows' approval prompt; a declined prompt asks again with Set up, and a failure offers Try
 * again, a report to the team and the raw error under Details. A sandbox an earlier Genex set up
 * for another release waits for its one Update button instead.
 */
export function WindowsSetup({
  problem,
  settingUp,
  error,
  report,
  onSetUp,
  onReport,
  update,
  onUpdate,
}: {
  problem: SandboxProblem;
  settingUp: boolean;
  error: string | null;
  report: SetupReport;
  onSetUp: () => void;
  onReport: () => void;
} & UpdateOffer): JSX.Element {
  const step = windowsStep(settingUp, error);
  const reinstall = problem.windowsNeeds?.includes(WindowsSetupNeed.Reinstall) === true;
  const words = windowsCardWords(step, reinstall);
  return (
    <AnimationCard
      selector={{ "data-sandbox-setup": problem.code, "data-windows-setup": step }}
      titleId="windows-setup-title"
      title={words.title}
    >
      <p className={step === WindowsStep.Failed ? "text-orange" : "text-ink-2"}>{words.line}</p>
      {problem.windowsNeeds?.includes(WindowsSetupNeed.LogonService) && <LogonServiceLine step={step} />}
      <BootUpdate update={update} onUpdate={onUpdate} />
      {step === WindowsStep.SettingUp && (
        <WorkingLine text={reinstall ? WORDS.windows.reinstall.updating : WORDS.windows.settingUp.step} />
      )}
      {step === WindowsStep.NeedsOk && (
        <div className="pt-2">
          <Button variant="default" data-sandbox-set-up onClick={onSetUp}>
            {reinstall ? WORDS.windows.reinstall.update : WORDS.windows.needsOk.setUp}
          </Button>
        </div>
      )}
      {step === WindowsStep.Failed && error !== null && (
        <SetupFailed error={error} report={report} onSetUp={onSetUp} onReport={onReport} />
      )}
    </AnimationCard>
  );
}

/**
 * Windows' Secondary Logon service is disabled: Set up turns it back on, and after a Set up that
 * could not, the line says how to do it by hand.
 */
function LogonServiceLine({ step }: { step: WindowsStep }): JSX.Element {
  const words = WORDS.windows.logonService;
  return (
    <p data-windows-need={WindowsSetupNeed.LogonService} className="text-ink-2">
      {step === WindowsStep.Failed ? words.fix : words.line}
    </p>
  );
}

/** Send a report; while it sends, a line says so, and once sent a bare ✓ takes its place. */
function ReportAction({ report, onReport }: { report: SetupReport; onReport: () => void }): JSX.Element {
  const words = WORDS.windows.failed;
  if (report === SetupReport.Sent) {
    return (
      <span data-setup-report={report} role="img" aria-label={words.sent} className="px-2 text-ink">
        ✓
      </span>
    );
  }
  if (report === SetupReport.Sending) {
    return (
      <span data-setup-report={report} className="px-2 text-sm text-ink-3">
        {words.sending}
      </span>
    );
  }
  return (
    <Button variant="secondary" data-setup-report={report} onClick={onReport}>
      {words.report}
    </Button>
  );
}

/** A failed Set up's actions: Try again, the report (sent, it is a bare ✓), and the raw error. */
function SetupFailed({
  error,
  report,
  onSetUp,
  onReport,
}: {
  error: string;
  report: SetupReport;
  onSetUp: () => void;
  onReport: () => void;
}): JSX.Element {
  const words = WORDS.windows.failed;
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 pt-2">
        <Button variant="default" data-sandbox-set-up onClick={onSetUp}>
          {words.tryAgain}
        </Button>
        <ReportAction report={report} onReport={onReport} />
      </div>
      {report === SetupReport.Failed && <p className="text-sm text-orange">{words.reportFailed}</p>}
      <ErrorDetails error={error} />
    </>
  );
}

/** The raw error, folded under Details and selectable for copying. */
function ErrorDetails({ error }: { error: string }): JSX.Element {
  return (
    <details className="settings-disclosure text-sm text-ink-3">
      <summary>{WORDS.details}</summary>
      <pre className="mt-2 max-h-24 overflow-auto font-mono text-micro whitespace-pre-wrap break-words select-text">
        {error}
      </pre>
    </details>
  );
}

/** One command, with who it is for and a Copy button; `selector` names the row for the smoke runners. */
function CommandRow({
  system,
  command,
  selector,
}: {
  system: string;
  command: string;
  selector: Record<`data-${string}`, string>;
}): JSX.Element {
  const [copied, setCopied] = useState(false);
  const copy = (): void => {
    navigator.clipboard.writeText(command).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  };
  return (
    <div {...selector} className="flex items-center gap-3 rounded-[var(--radius-control)] bg-field py-1.5 ps-3 pe-1.5">
      <div className="min-w-0 flex-1">
        <div className="text-micro text-ink-3">{system}</div>
        <code className="block select-text break-all font-mono text-sm text-ink">{command}</code>
      </div>
      <Button aria-label={WORDS.copyCommand(system)} onClick={copy}>
        {copied ? WORDS.copied : WORDS.copy}
      </Button>
    </div>
  );
}

/** One install command, for the systems its package manager serves. */
function InstallCommandRow({ install }: { install: InstallCommand }): JSX.Element {
  return (
    <CommandRow
      system={WORDS.system[install.manager]}
      command={install.command}
      selector={{ "data-install-command": install.manager }}
    />
  );
}

export function SandboxSetup({
  problem,
  retrying,
  error,
  onRetry,
  update,
  onUpdate,
}: {
  problem: SandboxProblem;
  retrying: boolean;
  error: string | null;
  onRetry: () => void;
} & UpdateOffer): JSX.Element {
  return (
    <div data-sandbox-setup={problem.code} className="relative flex h-full overflow-auto bg-canvas">
      {/* The window has no title bar of its own: the top strip moves it, as the headers do. */}
      <div className="titlebar-drag absolute inset-x-0 top-0 h-12" />
      <section
        aria-labelledby="sandbox-setup-title"
        className="m-auto flex w-full max-w-[520px] flex-col gap-4 px-6 py-16"
      >
        <h1 id="sandbox-setup-title" className="text-lg font-medium text-ink">
          {WORDS.title}
        </h1>
        <p className="text-ink-2">{WORDS.intro}</p>
        <p className="text-ink-2">{WORDS.why[problem.code]}</p>
        <BootUpdate update={update} onUpdate={onUpdate} />
        {problem.missingTools.length > 0 && (
          <ul className="flex flex-wrap gap-2 font-mono text-sm text-ink">
            {problem.missingTools.map((tool) => (
              <li key={tool} className="rounded-[var(--radius-control)] bg-field px-2 py-0.5">
                {toolPackage(tool)}
              </li>
            ))}
          </ul>
        )}
        {problem.installCommands.length > 0 && (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-ink-3">{WORDS.installThenRetry}</p>
            {problem.installCommands.map((install) => (
              <InstallCommandRow key={install.manager} install={install} />
            ))}
          </div>
        )}
        {problem.allowCommand && (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-ink-3">{WORDS.allowThenReopen}</p>
            <CommandRow
              system={WORDS.allowFor}
              command={problem.allowCommand}
              selector={{ "data-allow-command": problem.code }}
            />
          </div>
        )}
        {error && (
          <p role="alert" className="text-sm break-words text-orange">
            {WORDS.stillFailing} {error}
          </p>
        )}
        <div>
          <Button variant="default" data-sandbox-retry aria-busy={retrying} disabled={retrying} onClick={onRetry}>
            {retrying ? WORDS.retrying : WORDS.retry}
          </Button>
        </div>
        {problem.details.length > 0 && (
          <details className="settings-disclosure text-sm text-ink-3">
            <summary>{WORDS.details}</summary>
            <pre className="mt-2 font-mono text-micro whitespace-pre-wrap break-words">
              {problem.details.join("\n")}
            </pre>
          </details>
        )}
      </section>
    </div>
  );
}
