/**
 * First launch → OpenCode. Set up installs OpenCode in place; once it runs, its free models count
 * as connected, so Start building appears with nothing else to decide. When they are all the
 * person can build with, the screen lists them to pick one, OpenCode's own default first. Signing
 * in to a provider is optional and runs OpenCode's own sign-in in a terminal inside the screen, as
 * Settings does.
 */
import { useId, useState, type JSX } from "react";
import { EngineId } from "../../shared/providers.ts";
import { reportFreeModelPicked, useRowViewed } from "../analytics/welcome-report.ts";
import { ProviderSurface } from "../analytics/welcome-vocabulary.ts";
import { OpenCodeRowState } from "../panels/opencode-row.ts";
import type { EngineDescriptor } from "../types.ts";
import { Button } from "../ui/Button.tsx";
import { defaultModelKey } from "../model-choices.ts";
import { safeStorage } from "../storage.ts";
import { rememberWelcomeModel } from "../stored-model.ts";
import { MeteredMark } from "./art.ts";
import { type Cli, SignInCard, Status, useCli } from "./cli-way.tsx";
import { Hug, MeteredMarkArt, StartBuilding, TopBar, useHeadingFocus } from "./parts.tsx";
import {
  cliMark,
  type FreeModelOption,
  freeModelOptions,
  pickedFreeModel,
  picksFreeModel,
  WAYS_WORDS,
} from "./ways.ts";

const WORDS = WAYS_WORDS.openCode;
/** The words around OpenCode's sign-in terminal. */
const SIGN_IN_WORDS = {
  terminal: WORDS.terminal,
  cancel: WORDS.cancelSignIn,
  openSignInPage: WORDS.openSignInPage,
  note: WORDS.signingInNote,
} as const;

/** OpenCode as first launch drives it: its state, its trouble, and what each button does. */
export const useOpenCode = (engines: EngineDescriptor[], onEnginesRefresh: () => void): Cli =>
  useCli(EngineId.OpenCode, engines, onEnginesRefresh);
export type OpenCode = Cli;

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
  const pick = (next: string): void => {
    reportFreeModelPicked(next === defaultModelKey(EngineId.OpenCode), options.length);
    setKey(next);
  };
  const free: FreeModels | null = picksFreeModel(code.row, othersOn)
    ? { options, picked: pickedFreeModel(options, key), onPick: pick }
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
  useRowViewed(EngineId.OpenCode, code.row, ProviderSurface.Onboarding, null);
  return (
    <section className="onboarding-screen onboarding-provider onboarding-enter" data-picking={picking || undefined}>
      <TopBar onBack={onBack} onSkip={anyOn ? undefined : onSkip} />
      <h1 ref={heading} tabIndex={-1} className="onboarding-title">
        {session ? WORDS.signInTitle : WORDS.title}
      </h1>
      <p className="onboarding-lede onboarding-lede-narrow">{session ? WORDS.signInLede : WORDS.lede}</p>
      {session ? (
        <SignInCard cli={code} session={session} words={SIGN_IN_WORDS} />
      ) : (
        <>
          <MeteredMarkArt id={MeteredMark.OpenCode} state={cliMark(code.row, code.checking)} />
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
