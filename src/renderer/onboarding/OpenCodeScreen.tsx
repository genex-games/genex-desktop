/**
 * First launch → OpenCode. Set up installs OpenCode in place; once it runs, its free models count
 * as connected, so Start building appears with nothing else to decide. When they are all the
 * person can build with, the screen lists them to pick one, OpenCode's own default first. Signing
 * in to a provider is optional and runs OpenCode's own sign-in in a terminal inside the screen, as
 * Settings does.
 */
import { lazy, Suspense, useId, useState, type JSX } from "react";
import { EngineStatusCode } from "../../shared/engine-descriptor.ts";
import { EngineId } from "../../shared/providers.ts";
import { TerminalKind, type TerminalSession } from "../../shared/terminal.ts";
import { useCliInstall } from "../cli-install.ts";
import { OpenCodeRowState, openCodeRowState } from "../panels/opencode-row.ts";
import { useSignInTerminal } from "../panels/use-sign-in-terminal.ts";
import type { EngineDescriptor } from "../types.ts";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/icons.tsx";
import { LoaderGrid } from "../ui/LoadingState.tsx";
import { Pending } from "../ui/Pending.tsx";
import { defaultModelKey } from "../model-choices.ts";
import { safeStorage } from "../storage.ts";
import { rememberWelcomeModel } from "../stored-model.ts";
import { problemWords } from "../words.ts";
import { MeteredMark } from "./art.ts";
import { Check, Hug, MeteredMarkArt, StartBuilding, TopBar, useHeadingFocus } from "./parts.tsx";
import {
  type FreeModelOption,
  freeModelOptions,
  openCodeMark,
  pickedFreeModel,
  picksFreeModel,
  WAYS_WORDS,
} from "./ways.ts";

const WORDS = WAYS_WORDS.openCode;
const TerminalView = lazy(() => import("../panels/TerminalView.tsx"));
/** An engine list without OpenCode yet reads as not installed until the engines arrive. */
const NOT_INSTALLED = { status: { code: EngineStatusCode.NotInstalled } };

/** OpenCode as first launch drives it: its state, its trouble, and what each button does. */
export function useOpenCode(engines: EngineDescriptor[], onEnginesRefresh: () => void) {
  const engine = engines.find((candidate) => candidate.id === EngineId.OpenCode);
  const install = useCliInstall(EngineId.OpenCode);
  // The sign-in runs in this screen's terminal; when it exits, the host rechecks OpenCode's models.
  const terminal = useSignInTerminal(TerminalKind.OpenCodeLogin);
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
      await window.studio.recheckEngines(EngineId.OpenCode);
      onEnginesRefresh();
    } finally {
      setChecking(false);
    }
  };
  return {
    row,
    checking,
    terminal,
    problem: problem ?? terminalError ?? install.problem,
    setTerminalError,
    install: () => run(install.install),
    recheck: () => run(recheck),
    signIn: () =>
      run(async () => {
        setTerminalError(null);
        const started = await window.studio.openCodeSignIn();
        if (!started.started) await recheck();
      }),
    cancelSignIn: () => {
      if (terminal) run(() => window.studio.terminalStop(terminal.id));
    },
    openSignInPage: terminal?.signInPage ? () => run(() => window.studio.terminalOpenLink(terminal.id)) : null,
  };
}
export type OpenCode = ReturnType<typeof useOpenCode>;

/** The free models to pick from, the one picked, and the pick. */
export interface FreeModels {
  options: readonly FreeModelOption[];
  picked: string;
  onPick: (key: string) => void;
}

/**
 * The free model first launch builds with, offered while OpenCode's free models are all the person
 * can build with (`othersOn`: nothing else is ready). OpenCode's default is picked until they pick
 * another; `remember` hands the pick to the first game's chat as the welcome ends.
 */
export function useFreeModel(code: OpenCode, engines: EngineDescriptor[], othersOn: boolean) {
  const [key, setKey] = useState(() => defaultModelKey(EngineId.OpenCode));
  const models = engines.find((engine) => engine.id === EngineId.OpenCode)?.models ?? [];
  const options = freeModelOptions(models);
  const free: FreeModels | null = picksFreeModel(code.row, othersOn)
    ? { options, picked: pickedFreeModel(options, key), onPick: setKey }
    : null;
  return {
    free,
    remember: () => {
      if (free) rememberWelcomeModel(safeStorage(), free.picked);
    },
  };
}

/** OpenCode's free models as one group of radios: the arrows move the pick, as in any radio group. */
function FreeModelList({ free }: { free: FreeModels }): JSX.Element {
  const group = useId();
  return (
    <div className="onboarding-free">
      <p aria-hidden="true" className="onboarding-ways-lead">
        {WORDS.buildWith}
      </p>
      <fieldset className="onboarding-free-list">
        <legend className="sr-only">{WORDS.freeModels}</legend>
        {free.options.map((option) => (
          <label key={option.key} className="onboarding-free-option" data-free-model={option.key}>
            <input
              type="radio"
              name={group}
              value={option.key}
              checked={option.key === free.picked}
              onChange={() => free.onPick(option.key)}
              className="onboarding-free-input"
            />
            <span aria-hidden="true" className="onboarding-free-dot" />
            <span className="min-w-0 truncate">{option.name}</span>
            {option.detail && <span className="onboarding-free-detail">{option.detail}</span>}
          </label>
        ))}
      </fieldset>
    </div>
  );
}

/** A status plate: progress while something runs, a check once ready. */
function Status({ busy, children }: { busy?: boolean; children: string }): JSX.Element {
  return (
    <div role="status" className="onboarding-status" data-on={busy ? undefined : true}>
      {busy ? <LoaderGrid /> : <Check />}
      {children}
    </div>
  );
}

/** The state's main control: Set up, its progress, ready on free models, connected, or Sign in. */
function OpenCodeControl({ code }: { code: OpenCode }): JSX.Element {
  if (code.checking) return <Status busy>{WORDS.checking}</Status>;
  switch (code.row) {
    case OpenCodeRowState.Installing:
      return <Status busy>{WORDS.installing}</Status>;
    case OpenCodeRowState.NotInstalled:
      return (
        <Button variant="accent-tint" size="lg" className="onboarding-connect-action" onClick={code.install}>
          {WORDS.setUp}
        </Button>
      );
    case OpenCodeRowState.FreeOnly:
      return <Status>{WORDS.readyStatus}</Status>;
    case OpenCodeRowState.Connected:
      return <Status>{WORDS.on}</Status>;
    case OpenCodeRowState.Unreachable:
      return (
        <Button variant="accent-tint" size="lg" className="onboarding-connect-action" onClick={code.recheck}>
          {WORDS.tryAgain}
        </Button>
      );
    default:
      return (
        <Button variant="accent-tint" size="lg" className="onboarding-connect-action" onClick={code.signIn}>
          {WORDS.signIn}
        </Button>
      );
  }
}

/** Ready on free models: pick one when they are all there is, else the line and Sign in. */
function FreeOnlyAside({ code, free }: { code: OpenCode; free: FreeModels | null }): JSX.Element {
  if (!free)
    return (
      <>
        <p className="onboarding-note">{WORDS.readyNote}</p>
        <Button variant="accent-tint" size="lg" className="onboarding-connect-action" onClick={code.signIn}>
          {WORDS.signIn}
        </Button>
      </>
    );
  return (
    <>
      <FreeModelList free={free} />
      <p className="onboarding-note">{WORDS.readyNote}</p>
      <button type="button" className="onboarding-link" data-state="idle" onClick={code.signIn}>
        {WORDS.signIn}
      </button>
    </>
  );
}

/** The quiet action and the line under the control, for the state. */
function OpenCodeAside({ code, free }: { code: OpenCode; free: FreeModels | null }): JSX.Element | null {
  if (code.checking) return null;
  switch (code.row) {
    case OpenCodeRowState.NotInstalled:
      return (
        <>
          <button type="button" className="onboarding-link" data-state="idle" onClick={code.recheck}>
            {WORDS.checkAgain}
          </button>
          <p className="onboarding-note">{WORDS.setUpNote}</p>
        </>
      );
    case OpenCodeRowState.Installing:
      return <p className="onboarding-note">{WORDS.setUpNote}</p>;
    case OpenCodeRowState.FreeOnly:
      return <FreeOnlyAside code={code} free={free} />;
    case OpenCodeRowState.Connected:
      return (
        <>
          <p className="onboarding-note">{WORDS.connectedNote}</p>
          <button type="button" className="onboarding-link" data-state="idle" onClick={code.signIn}>
            {WORDS.another}
          </button>
        </>
      );
    case OpenCodeRowState.SignedOut:
      return <p className="onboarding-note">{WORDS.signedOutNote}</p>;
    case OpenCodeRowState.Unreachable:
      return <p className="onboarding-note">{WORDS.unreachable}</p>;
    default:
      return null;
  }
}

/** OpenCode's own sign-in, in a terminal card on the screen: choose a provider, finish, or cancel. */
function SignInCard({ code, session }: { code: OpenCode; session: TerminalSession }): JSX.Element {
  return (
    <>
      <div className="onboarding-terminal" data-keeps-escape data-sign-in-terminal>
        <div className="onboarding-terminal-bar">
          <span className="onboarding-terminal-title">{WORDS.terminal}</span>
          <Button variant="ghost" onClick={code.cancelSignIn}>
            {WORDS.cancelSignIn}
          </Button>
        </div>
        <div className="onboarding-terminal-body">
          <Suspense fallback={<Pending label={WORDS.terminal} className="px-3 py-2" working />}>
            <TerminalView session={session} visible onError={code.setTerminalError} />
          </Suspense>
        </div>
      </div>
      {code.openSignInPage && (
        <Button variant="accent-tint" size="lg" className="onboarding-connect-action" onClick={code.openSignInPage}>
          {WORDS.openSignInPage}
          <Icon name="arrow-up-right" size={14} />
        </Button>
      )}
      <p className="onboarding-note">{WORDS.signingInNote}</p>
    </>
  );
}

/** OpenCode's screen: its mark and state (or the sign-in's terminal), its trouble, and Start building. */
export function OpenCodeScreen({
  code,
  free,
  anyOn,
  onBack,
  onSkip,
  onStart,
}: {
  code: OpenCode;
  /** The free models to pick from, while they are all the person can build with. */
  free: FreeModels | null;
  anyOn: boolean;
  onBack: () => void;
  onSkip: () => void;
  onStart: () => void;
}): JSX.Element {
  const heading = useHeadingFocus();
  const session = code.row === OpenCodeRowState.SigningIn ? code.terminal : undefined;
  const picking = free !== null && code.row === OpenCodeRowState.FreeOnly;
  return (
    <section className="onboarding-screen onboarding-provider onboarding-enter" data-picking={picking || undefined}>
      <TopBar onBack={onBack} onSkip={anyOn ? undefined : onSkip} />
      <h1 ref={heading} tabIndex={-1} className="onboarding-title">
        {session ? WORDS.signInTitle : WORDS.title}
      </h1>
      <p className="onboarding-lede onboarding-lede-narrow">{session ? WORDS.signInLede : WORDS.lede}</p>
      {session ? (
        <SignInCard code={code} session={session} />
      ) : (
        <>
          <MeteredMarkArt id={MeteredMark.OpenCode} state={openCodeMark(code.row, code.checking)} />
          <div className="onboarding-choice">
            <Hug swap={`${code.checking}:${code.row}`}>
              <OpenCodeControl code={code} />
            </Hug>
            <OpenCodeAside code={code} free={free} />
          </div>
        </>
      )}
      <p role="alert" className="onboarding-problem">
        {code.problem ?? ""}
      </p>
      <StartBuilding anyOn={anyOn} onStart={onStart} />
    </section>
  );
}
