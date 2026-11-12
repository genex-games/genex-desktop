/**
 * First launch → Genex. Use Genex on the connect screen opens this screen: the promo card's film
 * and its three rows, then Sign in in browser. The app's Genex account signs in there
 * (`core/genex-account.ts`), which turns the Genex plugin on, so the card that follows the welcome
 * finds an account already connected and never shows. Once signed in, new games start on Genex's
 * Sonnet; the first message asks for Pro or credits when the account has neither.
 */
import { useEffect, useRef, useState, type JSX } from "react";
import { EngineStatusCode } from "../../shared/engine-descriptor.ts";
import type { GenexAccountStatus } from "../../shared/genex-account.ts";
import { GENEX_DEFAULT_MODEL } from "../../shared/genex-build.ts";
import { EngineId } from "../../shared/providers.ts";
import {
  reportProviderPress,
  reportSignInHelper,
  reportSignInSettled,
  reportSignInStarted,
} from "../analytics/welcome-report.ts";
import { ProviderAction, ProviderSurface, SignInHelper, SignInOutcome } from "../analytics/welcome-vocabulary.ts";
import { useCliInstall } from "../cli-install.ts";
import { offersGenex } from "../genex-build.ts";
import { modelKey } from "../model-key.ts";
import { PromoFeatures, PromoFilm } from "../panels/GenexPromo.tsx";
import { usePeople } from "../state/hooks.ts";
import { studio } from "../state/studio.ts";
import { safeStorage } from "../storage.ts";
import { rememberWelcomeModel } from "../stored-model.ts";
import type { EngineDescriptor } from "../types.ts";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/icons.tsx";
import { LoaderGrid } from "../ui/LoadingState.tsx";
import { Check, Hug, StartBuilding, TopBar, useHeadingFocus } from "./parts.tsx";
import { buildsWithGenex, GENEX_SCREEN_WORDS, genexChoiceView, genexSignInEnd, GenexStep, genexStep } from "./state.ts";

const WORDS = GENEX_SCREEN_WORDS;

/**
 * The Genex account's sign-in as this screen drives it: the press, the page again, the cancel, and
 * what went wrong. The account itself is read by the sidebar behind the welcome
 * (`usePeopleSync`), every few seconds while the browser has the sign-in.
 */
function useGenexSignIn(account: GenexAccountStatus | null) {
  // The sign-in this screen started, until it settles: whether main answered its press yet.
  const [open, setOpen] = useState<{ answered: boolean } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // A cancel or a newer press leaves an older press's answer nothing to change.
  const presses = useRef(0);
  useEffect(() => {
    if (!open) return;
    const end = genexSignInEnd(account, open.answered);
    if (!end) return;
    setOpen(null);
    reportSignInSettled(EngineId.Genex, end);
    if (end === SignInOutcome.Failed) setProblem(WORDS.unfinished);
  }, [account, open]);

  const signIn = (): void => {
    const mine = ++presses.current;
    reportProviderPress(EngineId.Genex, ProviderAction.SignIn, ProviderSurface.Onboarding);
    reportSignInStarted(EngineId.Genex, true);
    setProblem(null);
    setOpen({ answered: false });
    const answered = (): void => {
      if (mine === presses.current) setOpen((waiting) => waiting && { answered: true });
    };
    const refused = (): void => {
      if (mine !== presses.current) return;
      setOpen(null);
      reportSignInSettled(EngineId.Genex, SignInOutcome.Failed);
      setProblem(WORDS.failed);
    };
    void studio().people.signIn().then(answered, refused);
  };
  const reopen = (): void => {
    reportSignInHelper(EngineId.Genex, SignInHelper.PageReopened, { surface: ProviderSurface.Onboarding });
    void studio()
      .people.signIn()
      .catch(() => setProblem(WORDS.failed));
  };
  const cancel = (): void => {
    presses.current++;
    if (open) reportSignInSettled(EngineId.Genex, SignInOutcome.Cancelled);
    setOpen(null);
    setProblem(null);
    void studio()
      .people.cancelSignIn()
      .catch(() => setProblem(WORDS.cancelFailed));
  };
  return { problem, signIn, reopen, cancel };
}

/**
 * Building with Genex as first launch drives it, offered where genex.games offers it. Use Genex
 * (`pick`) chooses it and sets up the Claude Code Genex runs when it is missing; its screen signs
 * in. Signed in, Genex's Sonnet is the model new games start on, and Genex counts as connected.
 */
export function useGenex(engines: EngineDescriptor[]) {
  const engine = engines.find((candidate) => candidate.id === EngineId.Genex);
  const account = usePeople((s) => s.account);
  const install = useCliInstall(EngineId.ClaudeCode);
  const signIn = useGenexSignIn(account);
  const [picked, setPicked] = useState(false);
  const choice = { picked, step: genexStep({ account, installing: install.installing }) };
  const on = buildsWithGenex(choice);
  useEffect(() => {
    if (on) rememberWelcomeModel(safeStorage(), modelKey(EngineId.Genex, GENEX_DEFAULT_MODEL));
  }, [on]);
  const pick = (): void => {
    reportProviderPress(EngineId.Genex, ProviderAction.Connect, ProviderSurface.Onboarding);
    setPicked(true);
    const missing = engine?.status.code === EngineStatusCode.NotInstalled;
    if (missing && !install.installing) void install.install();
  };
  return {
    offered: offersGenex(engine),
    on,
    step: choice.step,
    view: genexChoiceView(choice),
    problem: picked ? (signIn.problem ?? install.problem) : null,
    pick,
    signIn: signIn.signIn,
    reopen: signIn.reopen,
    cancel: signIn.cancel,
  };
}
export type Genex = ReturnType<typeof useGenex>;

/** What the screen itself reads of Genex: its step, its trouble, and the sign-in's presses. */
type GenexSignIn = Pick<Genex, "step" | "problem" | "signIn" | "reopen" | "cancel">;

/** The step's control: Sign in in browser, the wait with its cancel, the setup, or Genex ready. */
function GenexControl({ genex }: { genex: GenexSignIn }): JSX.Element {
  const { step } = genex;
  if (step === GenexStep.On)
    return (
      <div role="status" className="onboarding-status" data-on>
        <Check />
        {WORDS.on}
      </div>
    );
  if (step === GenexStep.Setup)
    return (
      <div role="status" className="onboarding-status">
        <LoaderGrid />
        {WORDS.setup}
      </div>
    );
  if (step === GenexStep.Browser)
    return (
      <div role="status" className="onboarding-status">
        <LoaderGrid />
        {WORDS.browser}
        <button
          type="button"
          className="onboarding-status-cancel"
          aria-label={WORDS.cancel}
          data-genex-cancel
          onClick={genex.cancel}
        >
          <Icon name="close" size={14} />
        </button>
      </div>
    );
  return (
    <Button
      variant="accent-tint"
      size="lg"
      className="onboarding-connect-action"
      data-genex-sign-in
      onClick={genex.signIn}
    >
      {WORDS.signIn}
      <Icon name="arrow-up-right" size={14} />
    </Button>
  );
}

/** Genex's screen: the card's film and rows, the step's control, its trouble, and Start building. */
export function GenexScreen({
  genex,
  anyOn,
  onBack,
  onSkip,
  onStart,
}: {
  genex: GenexSignIn;
  anyOn: boolean;
  onBack: () => void;
  onSkip: () => void;
  onStart: () => void;
}): JSX.Element {
  const heading = useHeadingFocus();
  return (
    <section
      className="onboarding-screen onboarding-provider onboarding-genex onboarding-enter"
      data-genex-screen={genex.step}
    >
      <TopBar onBack={onBack} onSkip={anyOn ? undefined : onSkip} />
      <h1 ref={heading} tabIndex={-1} className="onboarding-title">
        {WORDS.title}
      </h1>
      <p className="onboarding-lede onboarding-lede-narrow">{WORDS.lede}</p>
      <PromoFilm />
      <PromoFeatures />
      <div className="onboarding-choice">
        <Hug swap={genex.step}>
          <GenexControl genex={genex} />
        </Hug>
        {genex.step === GenexStep.Browser && (
          <button type="button" className="onboarding-link" data-state="idle" data-genex-reopen onClick={genex.reopen}>
            {WORDS.openAgain}
          </button>
        )}
      </div>
      <p role="alert" className="onboarding-problem">
        {genex.problem ?? ""}
      </p>
      <StartBuilding anyOn={anyOn} onStart={onStart} />
    </section>
  );
}
