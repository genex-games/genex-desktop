/**
 * Settings → Model Providers: the rows of the CLIs that sign in in their own terminal, OpenCode,
 * Grok Build and Cursor. One row, each CLI's words and sign-in: install, sign in (the terminal opens inside
 * the row, so Settings stays open), the Account menu once connected, and the picker's models.
 * Loaded when Settings shows it (`MeteredProviders.tsx`): it is not on the first screen.
 */
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { EngineStatusCode } from "../../shared/engine-descriptor.ts";
import { t } from "../../shared/i18n.ts";
import { EngineId } from "../../shared/providers.ts";
import type { TerminalSession } from "../../shared/terminal.ts";
import { cliInstallAction, cliRecheckAction } from "../analytics/welcome-providers.ts";
import {
  reportAccountChanged,
  reportProviderPress,
  reportSignInHelper,
  reportSignInStarted,
  reportTerminalSignInCancelled,
  settled,
  useRowViewed,
} from "../analytics/welcome-report.ts";
import { AccountAction, ProviderAction, ProviderSurface, SignInHelper } from "../analytics/welcome-vocabulary.ts";
import { useCliInstall } from "../cli-install.ts";
import type { EngineDescriptor } from "../types.ts";
import { Button } from "../ui/Button.tsx";
import { DropdownMenuItem } from "../ui/dropdown-menu.tsx";
import { prefersReducedMotion } from "../ui/media-queries.ts";
import { Pending } from "../ui/Pending.tsx";
import { METERED_PROVIDER_WORDS } from "../words.ts";
import {
  AccountMenu,
  ItemWords,
  type MeteredProviderProps,
  ProviderCard,
  useRecheck,
  useRun,
} from "./MeteredProviders.tsx";
import { CLI_SIGN_IN, type CliProvider } from "./cli-sign-in.ts";
import { OpenCodeRowState, openCodeRowState } from "./opencode-row.ts";
import { type ProviderWords, RowTone, type RowView } from "./provider-row.tsx";
import { useSignInTerminal } from "./use-sign-in-terminal.ts";

const WORDS = METERED_PROVIDER_WORDS;
const TerminalView = lazy(() => import("./TerminalView.tsx"));

/** What a CLI's row can do: install, recheck, sign in or stop signing in, sign out (Cursor), update. */
type CliRowActions = {
  install: () => void;
  recheck: () => void;
  signIn: () => void;
  cancelSignIn: () => void;
  /** Open the sign-in page the CLI printed, when it printed one. */
  openSignInPage: (() => void) | null;
  /** Have the CLI forget its sign-in, for a CLI Genex signs out (Cursor); null for one it does not. */
  signOut: (() => void) | null;
  update: () => void;
};

/** What a row whose CLI signs in in its own terminal says: OpenCode's words, or Grok Build's. */
interface CliRowWords {
  card: ProviderWords;
  install: string;
  installLine: string;
  installingLine: string;
  signIn: string;
  signInLine: string;
  signingIn: string;
  openSignInPage: string;
  cancelSignIn: string;
  update: string;
  connectedLine: string;
  unreachable: string;
  /** The Account menu's item that signs in again: OpenCode adds a provider, Grok switches accounts. */
  again: { title: string; line: string };
  /** OpenCode's own free models running with no provider signed in; Grok Build has none. */
  freeOnly?: { status: string; line: string };
  /** Why an installed CLI too old to run needs its update; a row without one says it could not check. */
  outdatedLine?: string;
  /** The Account menu's item that signs the CLI out (Cursor). */
  signOut?: { title: string; line: string };
}

/** Grok Build's row, in the person's language (the renderer loads it before this module). */
const GROK_WORDS = {
  name: "Grok Build",
  guide: "https://docs.x.ai/build/overview",
  install: t("Install Grok Build"),
  installLine: t("Install it to build games with your Grok account."),
  installingLine: t("Installing Grok Build. This can take a minute."),
  signIn: t("Sign in"),
  signInLine: t("Sign in with your Grok account. Grok Build keeps the sign-in."),
  signingIn: t("Finish signing in to Grok in your browser."),
  cancelSignIn: t("Cancel"),
  openSignInPage: t("Open sign-in page"),
  signInAgain: t("Sign in again…"),
  signInAgainLine: t("Switch to another Grok account"),
  update: t("Update Grok Build"),
  connectedLine: t("Runs on your Grok account"),
  unreachable: t("Grok Build didn't answer. Check the installation, then try again."),
  outdatedLine: t("xAI no longer accepts this version. Update it to keep building."),
} as const;

/** Cursor's row, in the person's language (the renderer loads it before this module). */
const CURSOR_WORDS = {
  name: "Cursor",
  guide: "https://cursor.com/docs/cli/overview",
  install: t("Install Cursor"),
  installLine: t("Install Cursor's CLI to build with your Cursor plan."),
  installingLine: t("Installing Cursor. This can take a minute."),
  signIn: t("Sign in"),
  signInLine: t("Sign in with your Cursor account to build with your plan."),
  signingIn: t("Finish signing in to Cursor in your browser. Cursor keeps the sign-in."),
  cancelSignIn: t("Cancel"),
  openSignInPage: t("Open sign-in page"),
  signInAgain: t("Sign in again…"),
  signInAgainLine: t("Switch to another Cursor account"),
  signOut: t("Sign out"),
  signOutLine: t("Cursor's CLI forgets this computer's sign-in"),
  update: t("Update Cursor"),
  connectedLine: t("Uses your Cursor plan"),
  unreachable: t("Cursor didn't answer. Check the installation, then try again."),
} as const;

const OPEN_CODE_ROW: CliRowWords = {
  ...WORDS.openCode,
  card: { name: WORDS.openCode.name, plans: "", guide: WORDS.openCode.guide },
  again: { title: WORDS.openCode.addProvider, line: WORDS.openCode.addProviderLine },
  freeOnly: { status: WORDS.openCode.freeOnly, line: WORDS.openCode.freeOnlyLine },
};

const GROK_ROW: CliRowWords = {
  ...GROK_WORDS,
  card: { name: GROK_WORDS.name, plans: "", guide: GROK_WORDS.guide },
  again: { title: GROK_WORDS.signInAgain, line: GROK_WORDS.signInAgainLine },
};

const CURSOR_ROW: CliRowWords = {
  ...CURSOR_WORDS,
  card: { name: CURSOR_WORDS.name, plans: "", guide: CURSOR_WORDS.guide },
  again: { title: CURSOR_WORDS.signInAgain, line: CURSOR_WORDS.signInAgainLine },
  signOut: { title: CURSOR_WORDS.signOut, line: CURSOR_WORDS.signOutLine },
};

/** The row by its state: installing, missing, signing in, free models only, connected, outdated or unreachable. */
function cliRowView(state: OpenCodeRowState, act: CliRowActions, words: CliRowWords): RowView {
  switch (state) {
    case OpenCodeRowState.Installing:
      return { tone: RowTone.Busy, status: WORDS.installing, line: words.installingLine, actions: null };
    case OpenCodeRowState.NotInstalled:
      return {
        tone: RowTone.Off,
        status: WORDS.notInstalled,
        line: words.installLine,
        actions: (
          <>
            <Button variant="default" onClick={act.install}>
              {words.install}
            </Button>
            <Button onClick={act.recheck}>{WORDS.checkAgain}</Button>
          </>
        ),
      };
    case OpenCodeRowState.SigningIn:
      return signingInView(act, words);
    case OpenCodeRowState.SignedOut:
      return {
        tone: RowTone.Off,
        status: WORDS.notConnected,
        line: words.signInLine,
        actions: (
          <Button variant="default" onClick={act.signIn}>
            {words.signIn}
          </Button>
        ),
      };
    case OpenCodeRowState.FreeOnly:
      return words.freeOnly ? freeOnlyView(act, words, words.freeOnly) : connectedView(act, words);
    case OpenCodeRowState.Connected:
      return connectedView(act, words);
    case OpenCodeRowState.Outdated:
      if (words.outdatedLine) return outdatedView(act, words, words.outdatedLine);
      return unreachableView(act, words);
    default:
      return unreachableView(act, words);
  }
}

/**
 * The CLI is installed but too old to run: its installer puts the current one in place, as the
 * subscriptions' rows update theirs (its own update would first need it to run).
 */
function outdatedView(act: CliRowActions, words: CliRowWords, line: string): RowView {
  return {
    tone: RowTone.Warning,
    status: t("Update needed"),
    line,
    actions: (
      <>
        <Button variant="default" onClick={act.install}>
          {words.update}
        </Button>
        <Button onClick={act.recheck}>{WORDS.checkAgain}</Button>
      </>
    ),
  };
}

/** The CLI did not answer: check again. */
function unreachableView(act: CliRowActions, words: CliRowWords): RowView {
  return {
    tone: RowTone.Danger,
    status: WORDS.couldNotCheck,
    line: words.unreachable,
    actions: <Button onClick={act.recheck}>{WORDS.tryAgain}</Button>,
  };
}

/** The CLI's own sign-in runs in the row's terminal, below: finish it there, or stop it. */
function signingInView(act: CliRowActions, words: CliRowWords): RowView {
  return {
    tone: RowTone.Busy,
    status: WORDS.signingIn,
    line: words.signingIn,
    actions: (
      <>
        {act.openSignInPage && (
          <Button variant="default" onClick={act.openSignInPage}>
            {words.openSignInPage}
          </Button>
        )}
        <Button onClick={act.cancelSignIn}>{words.cancelSignIn}</Button>
      </>
    ),
  };
}

/** The sign-in's terminal inside the row, so Settings stays open while the CLI asks its questions. */
function SignInTerminal({ session, onError }: { session: TerminalSession; onError: (error: string) => void }) {
  const box = useRef<HTMLDivElement>(null);
  // The row may sit below the fold: bring the sign-in's questions into view once it starts.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per sign-in session
  useEffect(() => {
    box.current?.scrollIntoView({ block: "nearest", behavior: prefersReducedMotion() ? "auto" : "smooth" });
  }, [session.id]);
  return (
    <div
      ref={box}
      data-keeps-escape
      data-sign-in-terminal
      className="h-[26rem] min-h-0 overflow-hidden rounded-lg border border-line bg-base pt-2"
    >
      <Suspense fallback={<Pending label={WORDS.signingIn} className="px-3 py-2" working />}>
        <TerminalView session={session} visible onError={onError} />
      </Suspense>
    </div>
  );
}

/** No provider signed in: OpenCode's free models run, and Sign in comes first. */
function freeOnlyView(act: CliRowActions, words: CliRowWords, free: { status: string; line: string }): RowView {
  return {
    tone: RowTone.Warning,
    status: free.status,
    line: free.line,
    actions: (
      <>
        <Button variant="default" onClick={act.signIn}>
          {words.signIn}
        </Button>
        <AccountMenu name={words.card.name} onCheck={act.recheck}>
          <DropdownMenuItem onSelect={act.update}>{words.update}</DropdownMenuItem>
        </AccountMenu>
      </>
    ),
  };
}

/**
 * Signed in: OpenCode is billed by each provider and can add one; Grok Build and Cursor can switch
 * accounts, and Cursor can sign out.
 */
function connectedView(act: CliRowActions, words: CliRowWords): RowView {
  return {
    tone: RowTone.Connected,
    status: WORDS.connected,
    line: words.connectedLine,
    actions: (
      <AccountMenu name={words.card.name} onCheck={act.recheck}>
        <>
          <DropdownMenuItem onSelect={act.signIn}>
            <ItemWords title={words.again.title} line={words.again.line} />
          </DropdownMenuItem>
          {words.signOut && act.signOut && (
            <DropdownMenuItem onSelect={act.signOut}>
              <ItemWords title={words.signOut.title} line={words.signOut.line} />
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={act.update}>{words.update}</DropdownMenuItem>
        </>
      </AccountMenu>
    ),
  };
}

/** Each CLI's words. */
const CLI_WORDS: Record<CliProvider, CliRowWords> = {
  [EngineId.OpenCode]: OPEN_CODE_ROW,
  [EngineId.Grok]: GROK_ROW,
  [EngineId.Cursor]: CURSOR_ROW,
};

/** The row of one CLI that signs in in its own terminal. */
export default function CliSignInRow({
  engine,
  onEnginesRefresh,
  provider,
}: { engine: EngineDescriptor; provider: CliProvider } & Pick<MeteredProviderProps, "onEnginesRefresh">) {
  const { terminal: terminalKind, signIn: startSignIn, signOut: forgetSignIn } = CLI_SIGN_IN[provider];
  const words = CLI_WORDS[provider];
  const install = useCliInstall(provider);
  const { run, error } = useRun();
  const { checking, recheck } = useRecheck(provider, onEnginesRefresh);
  // The sign-in runs in this row's terminal; when it exits, the host asks the CLI again.
  const terminal = useSignInTerminal(terminalKind);
  const [terminalError, setTerminalError] = useState<string | null>(null);
  const ready = engine.status.code === EngineStatusCode.Ready;
  const state = openCodeRowState(engine, { installing: install.installing, signingIn: Boolean(terminal) });
  useRowViewed(provider, state, ProviderSurface.Settings, engine.account?.cli.state);
  const press = (action: ProviderAction) => reportProviderPress(provider, action, ProviderSurface.Settings);
  const signIn = (): void => {
    press(ProviderAction.SignIn);
    void run(async () => {
      setTerminalError(null);
      const started = await startSignIn();
      reportSignInStarted(provider, started.started);
      if (!started.started) await recheck();
    });
  };
  const cancelSignIn = (): void => {
    if (!terminal) return;
    reportTerminalSignInCancelled(provider);
    void run(() => window.studio.terminalStop(terminal.id));
  };
  const openSignInPage = (session: TerminalSession) => (): void => {
    reportSignInHelper(provider, SignInHelper.PageReopened, { surface: ProviderSurface.Settings });
    void run(() => window.studio.terminalOpenLink(session.id));
  };
  const signedOut = (ok: boolean) => reportAccountChanged(provider, AccountAction.SignedOut, ok);
  const view = cliRowView(
    state,
    {
      install: () => {
        press(cliInstallAction(state));
        void install.install();
      },
      recheck: () => {
        press(cliRecheckAction(state));
        void run(recheck);
      },
      signIn,
      cancelSignIn,
      openSignInPage: terminal?.signInPage ? openSignInPage(terminal) : null,
      signOut: forgetSignIn
        ? () =>
            void run(async () => {
              await settled(forgetSignIn, signedOut);
              await onEnginesRefresh();
            })
        : null,
      update: () => {
        press(ProviderAction.Update);
        void install.update();
      },
    },
    words,
  );
  return (
    <ProviderCard
      words={words.card}
      engine={engine}
      view={view}
      checking={checking}
      connected={ready && !install.installing}
      problem={error ?? terminalError ?? install.problem}
    >
      {terminal && <SignInTerminal session={terminal} onError={setTerminalError} />}
    </ProviderCard>
  );
}
