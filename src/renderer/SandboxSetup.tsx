/**
 * The window's first screen when the process sandbox cannot start: "Set up the protected
 * workspace". It says why agents need it, names what is missing with the exact commands that
 * install it (or, where AppArmor blocks the isolation, the command that allows it), and offers
 * Retry, which re-runs core startup in main (`state/boot.ts`). On Windows, where the missing piece
 * is a one-time install, Set up runs it (one administrator prompt) and then starts. On Linux under Ubuntu's user-namespace restriction, Set up installs Genex's
 * AppArmor profile (one password prompt) and the app restarts; the same install is folded away
 * as a terminal command. `BootRoot` chooses between this, the studio itself, and nothing while
 * main has not answered yet.
 */
import { type JSX, useState } from "react";
import { type AppArmorFix, type InstallCommand, type SandboxProblem, toolPackage } from "../shared/boot.ts";
import { App } from "./App.tsx";
import { useAppLoaderDismissal } from "./app-loader.ts";
import { type Boot, BootView, bootView, canSetUp } from "./state/boot.ts";
import { useBoot } from "./state/hooks.ts";
import { Button } from "./ui/Button.tsx";
import { SANDBOX_SETUP_WORDS as WORDS } from "./words.ts";

/** The studio, the setup screen, or nothing until main says which. */
export function BootRoot({ boot }: { boot: Boot }): JSX.Element | null {
  const view = useBoot(boot.store, bootView);
  const problem = useBoot(boot.store, (s) => s.problem);
  const retrying = useBoot(boot.store, (s) => s.retrying);
  const error = useBoot(boot.store, (s) => s.error);
  const installable = useBoot(boot.store, canSetUp);
  const settingUp = useBoot(boot.store, (s) => s.settingUp);
  const setupCancelled = useBoot(boot.store, (s) => s.setupCancelled);
  const restarting = useBoot(boot.store, (s) => s.restarting);
  // The studio dismisses the startup loader once its own first screen is drawn; the setup screen is drawn now.
  useAppLoaderDismissal(view === BootView.SandboxSetup);
  if (view === BootView.Studio) return <App />;
  if (view === BootView.Loading || !problem) return null;
  const setUp = installable
    ? { settingUp, restarting, cancelled: setupCancelled, onSetUp: () => void boot.setUp() }
    : null;
  return (
    <SandboxSetup problem={problem} retrying={retrying} error={error} onRetry={() => void boot.retry()} setUp={setUp} />
  );
}

/** Set up's state on the screen, where the platform offers it (Windows, and Linux for the restriction). */
interface SetUpControl {
  settingUp: boolean;
  /** Linux: installed, and main is restarting the app. */
  restarting: boolean;
  /** The last Set up ended with the administrator prompt dismissed. */
  cancelled: boolean;
  onSetUp: () => void;
}

/** What Set up asks for: Windows' administrator approval, or the AppArmor profile it adds on Linux. */
function setUpHint(problem: SandboxProblem): string {
  return problem.apparmor ? WORDS.profileSetUpHint(problem.apparmor.profile) : WORDS.setUpHint;
}

/** What Set up's button says: ready, waiting on the prompt, or restarting. */
function setUpLabel(setUp: SetUpControl): string {
  if (setUp.restarting) return WORDS.restarting;
  return setUp.settingUp ? WORDS.settingUp : WORDS.setUp;
}

/** Set up and its hint, or the note that the last one was cancelled. */
function SetUpButton({ setUp, hint, busy }: { setUp: SetUpControl; hint: string; busy: boolean }): JSX.Element {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-ink-3">{setUp.cancelled ? WORDS.setupCancelled : hint}</p>
      <div>
        <Button
          variant="default"
          data-sandbox-set-up
          aria-busy={setUp.settingUp || setUp.restarting}
          disabled={busy}
          onClick={setUp.onSetUp}
        >
          {setUpLabel(setUp)}
        </Button>
      </div>
    </div>
  );
}

/** Copy `text`, then say Copied. */
function CopyButton({ text, label }: { text: string; label: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  const copy = (): void => {
    navigator.clipboard.writeText(text).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  };
  return (
    <Button aria-label={label} onClick={copy}>
      {copied ? WORDS.copied : WORDS.copy}
    </Button>
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
  return (
    <div {...selector} className="flex items-center gap-3 rounded-[var(--radius-control)] bg-field py-1.5 ps-3 pe-1.5">
      <div className="min-w-0 flex-1">
        <div className="text-micro text-ink-3">{system}</div>
        <code className="block select-text break-all font-mono text-sm text-ink">{command}</code>
      </div>
      <CopyButton text={command} label={WORDS.copyCommand(system)} />
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

/** A terminal command in a scrolling block, with its Copy button. */
function CommandBlock({ command, label }: { command: string; label: string }): JSX.Element {
  return (
    <div className="flex items-start gap-3 rounded-[var(--radius-control)] bg-field py-1.5 ps-3 pe-1.5">
      <code className="block max-h-40 min-w-0 flex-1 overflow-auto font-mono text-micro whitespace-pre-wrap break-all text-ink select-text">
        {command}
      </code>
      <CopyButton text={command} label={label} />
    </div>
  );
}

/** Linux: Set up's profile install as a terminal command, and its removal, folded away below the actions. */
function ProfileByHand({ fix }: { fix: AppArmorFix }): JSX.Element {
  return (
    <details data-apparmor-command className="settings-disclosure text-sm text-ink-3">
      <summary>{WORDS.byHand}</summary>
      <div className="mt-2 flex flex-col gap-2">
        <p>{WORDS.byHandHint}</p>
        <CommandBlock command={fix.command} label={WORDS.copyProfileCommand} />
        <p>{WORDS.removeHint}</p>
        <CommandBlock command={fix.remove} label={WORDS.copyRemoveCommand} />
      </div>
    </details>
  );
}

export function SandboxSetup({
  problem,
  retrying,
  error,
  onRetry,
  setUp = null,
}: {
  problem: SandboxProblem;
  retrying: boolean;
  error: string | null;
  onRetry: () => void;
  /** Offered where the sandbox installs from here (Windows, and Linux for the restriction); null elsewhere. */
  setUp?: SetUpControl | null;
}): JSX.Element {
  const busy = retrying || Boolean(setUp?.settingUp || setUp?.restarting);
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
        {problem.apparmorBlock && <p className="text-ink-2">{WORDS.apparmorBlocked[problem.apparmorBlock]}</p>}
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
        {setUp && <SetUpButton setUp={setUp} hint={setUpHint(problem)} busy={busy} />}
        {error && (
          <p role="alert" className="text-sm break-words text-orange">
            {WORDS.stillFailing} {error}
          </p>
        )}
        <div>
          <Button
            variant={setUp ? "secondary" : "default"}
            data-sandbox-retry
            aria-busy={retrying}
            disabled={busy}
            onClick={onRetry}
          >
            {retrying ? WORDS.retrying : WORDS.retry}
          </Button>
        </div>
        {problem.apparmor && <ProfileByHand fix={problem.apparmor} />}
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
