/**
 * What first launch's CLI screens share, OpenCode's, Grok Build's and Cursor's: the CLI as the
 * screen drives it (install, recheck, its own sign-in in a terminal on the screen, as Settings
 * runs it), a status plate, and the sign-in's terminal card.
 */
import { lazy, Suspense, useState, type JSX } from "react";
import { EngineStatusCode } from "../../shared/engine-descriptor.ts";
import type { TerminalSession } from "../../shared/terminal.ts";
import { cliInstallAction, cliRecheckAction } from "../analytics/welcome-providers.ts";
import {
  reportProviderPress,
  reportSignInHelper,
  reportSignInStarted,
  reportTerminalSignInCancelled,
} from "../analytics/welcome-report.ts";
import { ProviderAction, ProviderSurface, SignInHelper } from "../analytics/welcome-vocabulary.ts";
import { useCliInstall } from "../cli-install.ts";
import { CLI_SIGN_IN, type CliProvider } from "../panels/cli-sign-in.ts";
import { openCodeRowState } from "../panels/opencode-row.ts";
import { useSignInTerminal } from "../panels/use-sign-in-terminal.ts";
import type { EngineDescriptor } from "../types.ts";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/icons.tsx";
import { LoaderGrid } from "../ui/LoadingState.tsx";
import { Pending } from "../ui/Pending.tsx";
import { problemWords } from "../words.ts";
import { Check } from "./parts.tsx";

const TerminalView = lazy(() => import("../panels/TerminalView.tsx"));
/** An engine list without the CLI yet reads as not installed until the engines arrive. */
const NOT_INSTALLED = { status: { code: EngineStatusCode.NotInstalled } };

/** One CLI as first launch drives it: its state, its trouble, and what each button does. */
export function useCli(provider: CliProvider, engines: EngineDescriptor[], onEnginesRefresh: () => void) {
  const engine = engines.find((candidate) => candidate.id === provider);
  const install = useCliInstall(provider);
  const { terminal: terminalKind, signIn: startSignIn } = CLI_SIGN_IN[provider];
  // The sign-in runs in the screen's terminal; when it exits, the host asks the CLI again.
  const terminal = useSignInTerminal(terminalKind);
  const [checking, setChecking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [terminalError, setTerminalError] = useState<string | null>(null);
  const row = openCodeRowState(engine ?? NOT_INSTALLED, {
    installing: install.installing,
    signingIn: Boolean(terminal),
  });
  const run = (action: () => Promise<unknown>) => {
    setProblem(null);
    void action().catch((err) => setProblem(problemWords(err)));
  };
  const recheck = async (): Promise<void> => {
    setChecking(true);
    try {
      await window.studio.recheckEngines(provider);
      onEnginesRefresh();
    } finally {
      setChecking(false);
    }
  };
  const press = (action: ProviderAction) => reportProviderPress(provider, action, ProviderSurface.Onboarding);
  return {
    row,
    checking,
    terminal,
    problem: problem ?? terminalError ?? install.problem,
    setTerminalError,
    install: () => {
      press(cliInstallAction(row));
      run(install.install);
    },
    recheck: () => {
      press(cliRecheckAction(row));
      run(recheck);
    },
    signIn: () => {
      press(ProviderAction.SignIn);
      run(async () => {
        setTerminalError(null);
        const started = await startSignIn();
        reportSignInStarted(provider, started.started);
        if (!started.started) await recheck();
      });
    },
    cancelSignIn: () => {
      if (!terminal) return;
      reportTerminalSignInCancelled(provider);
      run(() => window.studio.terminalStop(terminal.id));
    },
    openSignInPage: terminal?.signInPage
      ? () => {
          reportSignInHelper(provider, SignInHelper.PageReopened, { surface: ProviderSurface.Onboarding });
          run(() => window.studio.terminalOpenLink(terminal.id));
        }
      : null,
  };
}
export type Cli = ReturnType<typeof useCli>;

/** A status plate: progress while something runs, a check once ready. */
export function Status({ busy, children }: { busy?: boolean; children: string }): JSX.Element {
  return (
    <div role="status" className="onboarding-status" data-on={busy ? undefined : true}>
      {busy ? <LoaderGrid /> : <Check />}
      {children}
    </div>
  );
}

/** The words around a sign-in's terminal: its title, Cancel, Open sign-in page, and the line under it. */
export interface SignInCardWords {
  terminal: string;
  cancel: string;
  openSignInPage: string;
  note: string;
}

/** The CLI's own sign-in, in a terminal card on the screen: finish it, open its page, or cancel. */
export function SignInCard({
  cli,
  session,
  words,
}: {
  cli: Cli;
  session: TerminalSession;
  words: SignInCardWords;
}): JSX.Element {
  return (
    <>
      <div className="onboarding-terminal" data-keeps-escape data-sign-in-terminal>
        <div className="onboarding-terminal-bar">
          <span className="onboarding-terminal-title">{words.terminal}</span>
          <Button variant="ghost" onClick={cli.cancelSignIn}>
            {words.cancel}
          </Button>
        </div>
        <div className="onboarding-terminal-body">
          <Suspense fallback={<Pending label={words.terminal} className="px-3 py-2" working />}>
            <TerminalView session={session} visible onError={cli.setTerminalError} />
          </Suspense>
        </div>
      </div>
      {cli.openSignInPage && (
        <Button variant="accent-tint" size="lg" className="onboarding-connect-action" onClick={cli.openSignInPage}>
          {words.openSignInPage}
          <Icon name="arrow-up-right" size={14} />
        </Button>
      )}
      <p className="onboarding-note">{words.note}</p>
    </>
  );
}
