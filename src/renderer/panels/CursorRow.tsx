/**
 * Settings → Model Providers, Cursor's row: its CLI signs in to the person's Cursor account itself,
 * in a terminal inside the row (as OpenCode's does), and Genex never sees the sign-in. The row keeps
 * the shape of every provider row: one status plate, one line, at most one visible action, an
 * Account menu once connected, and the picker's model list under it.
 */
import { type JSX, useState } from "react";
import { EngineStatusCode } from "../../shared/engine-descriptor.ts";
import { EngineId } from "../../shared/providers.ts";
import { TerminalKind } from "../../shared/terminal.ts";
import { useCliInstall } from "../cli-install.ts";
import type { EngineDescriptor } from "../types.ts";
import { Button } from "../ui/Button.tsx";
import { DropdownMenuItem } from "../ui/dropdown-menu.tsx";
import { t } from "../../shared/i18n.ts";
import { METERED_PROVIDER_WORDS } from "../words.ts";
import { CursorRowState, cursorRowState } from "./cursor-row.ts";
import {
  AccountMenu,
  ItemWords,
  ProviderCard,
  SignInTerminal,
  useRecheck,
  useRun,
  type MeteredProviderProps,
} from "./MeteredProviders.tsx";
import { type ProviderWords, RowTone, type RowView } from "./provider-row.tsx";
import { useSignInTerminal } from "./use-sign-in-terminal.ts";

/**
 * What the row says: the provider rows' shared words, and Cursor's own, kept here so they load with
 * the row (Settings loads it on demand).
 */
const WORDS = {
  ...METERED_PROVIDER_WORDS,
  cursor: {
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
    connectedLine: t("Uses your Cursor plan"),
    signOut: t("Sign out"),
    signOutLine: t("Cursor's CLI forgets this computer's sign-in"),
    update: t("Update Cursor"),
    unreachable: t("Cursor didn't answer. Check the installation, then try again."),
  },
} as const;
const CURSOR_WORDS: ProviderWords = { name: WORDS.cursor.name, plans: "", guide: WORDS.cursor.guide };

/** What Cursor's row can do: install, recheck, sign in or stop signing in, sign out, update. */
type CursorActions = {
  install: () => void;
  recheck: () => void;
  signIn: () => void;
  cancelSignIn: () => void;
  /** Open the sign-in page Cursor printed, when it printed one. */
  openSignInPage: (() => void) | null;
  signOut: () => void;
  update: () => void;
};

/** Cursor's row by its state: installing, missing, signing in, signed out, connected or unreachable. */
function cursorView(state: CursorRowState, act: CursorActions): RowView {
  switch (state) {
    case CursorRowState.Installing:
      return { tone: RowTone.Busy, status: WORDS.installing, line: WORDS.cursor.installingLine, actions: null };
    case CursorRowState.NotInstalled:
      return {
        tone: RowTone.Off,
        status: WORDS.notInstalled,
        line: WORDS.cursor.installLine,
        actions: (
          <>
            <Button variant="default" onClick={act.install}>
              {WORDS.cursor.install}
            </Button>
            <Button onClick={act.recheck}>{WORDS.checkAgain}</Button>
          </>
        ),
      };
    case CursorRowState.SigningIn:
      return cursorSigningInView(act);
    case CursorRowState.SignedOut:
      return {
        tone: RowTone.Off,
        status: WORDS.notConnected,
        line: WORDS.cursor.signInLine,
        actions: (
          <Button variant="default" onClick={act.signIn}>
            {WORDS.cursor.signIn}
          </Button>
        ),
      };
    case CursorRowState.Connected:
      return cursorConnectedView(act);
    default:
      return {
        tone: RowTone.Danger,
        status: WORDS.couldNotCheck,
        line: WORDS.cursor.unreachable,
        actions: <Button onClick={act.recheck}>{WORDS.tryAgain}</Button>,
      };
  }
}

/** Cursor's own sign-in runs in the row's terminal, below, and in the browser: finish it there, or stop it. */
function cursorSigningInView(act: CursorActions): RowView {
  return {
    tone: RowTone.Busy,
    status: WORDS.signingIn,
    line: WORDS.cursor.signingIn,
    actions: (
      <>
        {act.openSignInPage && (
          <Button variant="default" onClick={act.openSignInPage}>
            {WORDS.cursor.openSignInPage}
          </Button>
        )}
        <Button onClick={act.cancelSignIn}>{WORDS.cursor.cancelSignIn}</Button>
      </>
    ),
  };
}

/** Signed in: the plan pays, and the Account menu signs out or updates the CLI. */
function cursorConnectedView(act: CursorActions): RowView {
  return {
    tone: RowTone.Connected,
    status: WORDS.connected,
    line: WORDS.cursor.connectedLine,
    actions: (
      <AccountMenu name={WORDS.cursor.name} onCheck={act.recheck}>
        <>
          <DropdownMenuItem onSelect={act.signOut}>
            <ItemWords title={WORDS.cursor.signOut} line={WORDS.cursor.signOutLine} />
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={act.update}>{WORDS.cursor.update}</DropdownMenuItem>
        </>
      </AccountMenu>
    ),
  };
}

function CursorRow({
  engine,
  onEnginesRefresh,
}: { engine: EngineDescriptor } & Pick<MeteredProviderProps, "onEnginesRefresh">): JSX.Element {
  const install = useCliInstall(EngineId.Cursor);
  const { run, error } = useRun();
  const { checking, recheck } = useRecheck(EngineId.Cursor, onEnginesRefresh);
  // The sign-in runs in this row's terminal; when it exits, the host checks the sign-in and models.
  const terminal = useSignInTerminal(TerminalKind.CursorLogin);
  const [terminalError, setTerminalError] = useState<string | null>(null);
  const ready = engine.status.code === EngineStatusCode.Ready;
  const state = cursorRowState(engine, { installing: install.installing, signingIn: Boolean(terminal) });
  const view = cursorView(state, {
    install: () => void install.install(),
    recheck: () => void run(recheck),
    signIn: () =>
      void run(async () => {
        setTerminalError(null);
        const started = await window.studio.cursorSignIn();
        if (!started.started) await recheck();
      }),
    cancelSignIn: () => {
      if (terminal) void run(() => window.studio.terminalStop(terminal.id));
    },
    openSignInPage: terminal?.signInPage ? () => void run(() => window.studio.terminalOpenLink(terminal.id)) : null,
    signOut: () =>
      void run(async () => {
        await window.studio.cursorSignOut();
        await onEnginesRefresh();
      }),
    update: () => void install.update(),
  });
  return (
    <ProviderCard
      words={CURSOR_WORDS}
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

/** Cursor's row, under the subscriptions, when its engine is registered. */
export function CursorProviderRow({ engines, onEnginesRefresh }: MeteredProviderProps): JSX.Element | null {
  const cursor = engines.find((engine) => engine.id === EngineId.Cursor);
  return cursor ? <CursorRow engine={cursor} onEnginesRefresh={onEnginesRefresh} /> : null;
}
