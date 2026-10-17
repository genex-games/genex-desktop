/**
 * First launch → OpenRouter. Connect opens OpenRouter in the browser; once the person approves
 * Genex there, main gets a key, checks and keeps it, and this screen moves on by itself. Pasting a
 * key is the other way in, checked the same way. The key never comes back to the renderer, and
 * the field forgets it the moment it is sent.
 */
import { useEffect, useRef, useState, type FormEvent, type JSX } from "react";
import { EngineStatusCode } from "../../shared/engine-descriptor.ts";
import { OpenRouterSignInOutcome } from "../../shared/openrouter-login.ts";
import { EngineId } from "../../shared/providers.ts";
import type { EngineDescriptor } from "../types.ts";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/icons.tsx";
import { LoaderGrid } from "../ui/LoadingState.tsx";
import { METERED_PROVIDER_WORDS, problemWords } from "../words.ts";
import { MeteredMark } from "./art.ts";
import { Check, Hug, MeteredMarkArt, StartBuilding, TopBar, useHeadingFocus } from "./parts.tsx";
import { RouterStep, routerMark, routerStep, WAYS_WORDS } from "./ways.ts";

const WORDS = WAYS_WORDS.openRouter;

/** OpenRouter's connection as first launch drives it: its step, its trouble, and what each button does. */
export function useOpenRouter(engines: EngineDescriptor[], onEnginesRefresh: () => void) {
  const status = engines.find((engine) => engine.id === EngineId.OpenRouter)?.status.code;
  const [signingIn, setSigningIn] = useState(false);
  const [pasting, setPasting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // A newer Connect replaces a waiting one, whose answer (cancelled) must not undo the new one's state.
  const attempt = useRef(0);
  const step = routerStep(status, { signingIn, pasting, saving });

  const connect = async (): Promise<void> => {
    const mine = ++attempt.current;
    setProblem(null);
    setPasting(false);
    setSigningIn(true);
    try {
      const result = await window.studio.openRouterSignIn();
      if (mine !== attempt.current) return;
      if (result.outcome === OpenRouterSignInOutcome.Failed) setProblem(result.error);
      onEnginesRefresh();
    } catch (err) {
      if (mine === attempt.current) setProblem(problemWords(err));
    } finally {
      if (mine === attempt.current) setSigningIn(false);
    }
  };
  const save = async (key: string): Promise<void> => {
    setProblem(null);
    setSaving(true);
    try {
      const answer = await window.studio.openRouterKeySave(key);
      if (answer.code === EngineStatusCode.Ready) setPasting(false);
      else setProblem(answer.code === EngineStatusCode.NeedsLogin ? WORDS.refused : answer.detail);
      onEnginesRefresh();
    } catch (err) {
      setProblem(problemWords(err));
    } finally {
      setSaving(false);
    }
  };
  const ignore = () => {};
  return {
    status,
    step,
    problem,
    connect: () => void connect(),
    save: (key: string) => void save(key),
    reopen: () => void window.studio.openRouterSignInReopen().catch(ignore),
    cancel: () => void window.studio.openRouterSignInCancel().catch(ignore),
    paste: (on: boolean) => {
      setProblem(null);
      setPasting(on);
    },
  };
}
export type OpenRouter = ReturnType<typeof useOpenRouter>;

/** The key box: paste, then Connect (or Return). It says when OpenRouter is checking it. */
function KeyForm({ router }: { router: OpenRouter }): JSX.Element {
  const [key, setKey] = useState("");
  const field = useRef<HTMLInputElement>(null);
  const checking = router.step === RouterStep.Checking;
  // The box opens on the person's own Paste a key instead, so the focus follows that press.
  useEffect(() => {
    field.current?.focus();
  }, []);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const pasted = key.trim();
    if (!pasted || checking) return;
    // The field forgets the key the moment it is sent.
    setKey("");
    router.save(pasted);
  };
  return (
    <form className="onboarding-code onboarding-key" onSubmit={submit}>
      <input
        ref={field}
        type="password"
        aria-label={WORDS.keyLabel}
        placeholder={WORDS.keyPlaceholder}
        value={key}
        spellCheck={false}
        autoComplete="off"
        disabled={checking}
        aria-invalid={Boolean(router.problem)}
        onChange={(event) => setKey(event.target.value)}
      />
      <Button type="submit" variant="default" disabled={checking || !key.trim()}>
        {checking ? WORDS.checking : WORDS.save}
      </Button>
    </form>
  );
}

/** The step's main control: Connect, waiting on the browser, the key box, or connected. */
function RouterControl({ router }: { router: OpenRouter }): JSX.Element {
  const { step } = router;
  if (step === RouterStep.On)
    return (
      <div role="status" className="onboarding-status" data-on>
        <Check />
        {WAYS_WORDS.openRouter.on}
      </div>
    );
  if (step === RouterStep.Browser)
    return (
      <div role="status" className="onboarding-status">
        <LoaderGrid />
        {WORDS.browser}
        <button type="button" className="onboarding-status-cancel" aria-label={WORDS.cancel} onClick={router.cancel}>
          <Icon name="close" size={14} />
        </button>
      </div>
    );
  if (step === RouterStep.Key || step === RouterStep.Checking) return <KeyForm router={router} />;
  return (
    <Button variant="accent-tint" size="lg" className="onboarding-connect-action" onClick={router.connect}>
      {WORDS.connect}
      <Icon name="arrow-up-right" size={14} />
    </Button>
  );
}

/** The quiet links and the line under the control, for the step. */
function RouterAside({ router }: { router: OpenRouter }): JSX.Element | null {
  switch (router.step) {
    case RouterStep.Offer:
      return (
        <>
          <button type="button" className="onboarding-link" data-state="idle" onClick={() => router.paste(true)}>
            {WORDS.pasteInstead}
          </button>
          <p className="onboarding-note">{WORDS.connectNote}</p>
        </>
      );
    case RouterStep.Browser:
      return (
        <>
          <button type="button" className="onboarding-link" data-state="idle" onClick={router.reopen}>
            {WORDS.openAgain}
          </button>
          <p className="onboarding-note">{WORDS.browserNote}</p>
        </>
      );
    case RouterStep.Key:
    case RouterStep.Checking:
      return (
        <>
          <div className="onboarding-links">
            <button
              type="button"
              className="onboarding-link"
              data-state="idle"
              onClick={() => void window.studio.openUrl(METERED_PROVIDER_WORDS.openRouter.keysUrl).catch(() => {})}
            >
              {WORDS.getKey}
              <Icon name="arrow-up-right" size={14} />
            </button>
            <button type="button" className="onboarding-link" data-state="idle" onClick={() => router.paste(false)}>
              {WORDS.browserInstead}
            </button>
          </div>
          <p className="onboarding-note">{WORDS.keyNote}</p>
        </>
      );
    default:
      return <p className="onboarding-note">{WORDS.connectedNote}</p>;
  }
}

/** OpenRouter's screen: its mark, the step's control and links, its trouble, and Start building. */
export function OpenRouterScreen({
  router,
  anyOn,
  onBack,
  onSkip,
  onStart,
}: {
  router: OpenRouter;
  anyOn: boolean;
  onBack: () => void;
  onSkip: () => void;
  onStart: () => void;
}): JSX.Element {
  const heading = useHeadingFocus();
  const pastingKey = router.step === RouterStep.Key || router.step === RouterStep.Checking;
  return (
    <section className="onboarding-screen onboarding-provider onboarding-enter">
      <TopBar onBack={onBack} onSkip={anyOn ? undefined : onSkip} />
      <h1 ref={heading} tabIndex={-1} className="onboarding-title">
        {WORDS.title}
      </h1>
      <p className="onboarding-lede onboarding-lede-narrow">{WORDS.lede}</p>
      <MeteredMarkArt id={MeteredMark.OpenRouter} state={routerMark(router.step)} />
      <div className="onboarding-choice">
        <Hug swap={pastingKey ? RouterStep.Key : router.step}>
          <RouterControl router={router} />
        </Hug>
        <RouterAside router={router} />
      </div>
      <p role="alert" className="onboarding-problem">
        {router.problem ?? ""}
      </p>
      <StartBuilding anyOn={anyOn} onStart={onStart} />
    </section>
  );
}
