/**
 * First launch → Grok Build or Cursor, as their Settings rows run them: Install puts the CLI in
 * place, Sign in runs its own sign-in in a terminal on the screen (with Open sign-in page), and once
 * it is signed in it counts as connected, so Start building appears. Cursor says Beta beside its name.
 */
import type { JSX } from "react";
import { EngineId, isBeta } from "../../shared/providers.ts";
import { OpenCodeRowState } from "../panels/opencode-row.ts";
import { BetaTag } from "../ui/beta-tag.tsx";
import { Button } from "../ui/Button.tsx";
import { MeteredMark } from "./art.ts";
import { type Cli, SignInCard, Status } from "./cli-way.tsx";
import { Hug, MeteredMarkArt, StartBuilding, TopBar, useHeadingFocus } from "./parts.tsx";
import { cliMark, type CliWay, type CliWayWords, WAYS_WORDS } from "./ways.ts";

const SHARED = WAYS_WORDS.cli;
/** Each CLI's mark on its screen. */
const MARK: Record<CliWay, MeteredMark> = { [EngineId.Grok]: MeteredMark.Grok, [EngineId.Cursor]: MeteredMark.Cursor };

/** The screen's main button. */
function Action({ onClick, children }: { onClick: () => void; children: string }): JSX.Element {
  return (
    <Button variant="accent-tint" size="lg" className="onboarding-connect-action" onClick={onClick}>
      {children}
    </Button>
  );
}

/** The state's main control: Install, its progress, ready, Update, Try again, or Sign in. */
function CliControl({ cli, words }: { cli: Cli; words: CliWayWords }): JSX.Element {
  if (cli.checking) return <Status busy>{SHARED.checking}</Status>;
  switch (cli.row) {
    case OpenCodeRowState.Installing:
      return <Status busy>{words.installing}</Status>;
    case OpenCodeRowState.NotInstalled:
      return <Action onClick={cli.install}>{words.install}</Action>;
    case OpenCodeRowState.FreeOnly:
    case OpenCodeRowState.Connected:
      return <Status>{words.ready}</Status>;
    case OpenCodeRowState.Outdated:
      // Its installer puts the current one in place, as Settings updates it.
      if (words.outdatedNote) return <Action onClick={cli.install}>{words.update}</Action>;
      return <Action onClick={cli.recheck}>{SHARED.tryAgain}</Action>;
    case OpenCodeRowState.Unreachable:
      return <Action onClick={cli.recheck}>{SHARED.tryAgain}</Action>;
    default:
      return <Action onClick={cli.signIn}>{words.signIn}</Action>;
  }
}

/** The quiet action and the line under the control, for the state. */
function CliAside({ cli, words }: { cli: Cli; words: CliWayWords }): JSX.Element | null {
  if (cli.checking) return null;
  switch (cli.row) {
    case OpenCodeRowState.NotInstalled:
      return (
        <>
          <button type="button" className="onboarding-link" data-state="idle" onClick={cli.recheck}>
            {SHARED.checkAgain}
          </button>
          <p className="onboarding-note">{words.installNote}</p>
        </>
      );
    case OpenCodeRowState.Installing:
      return <p className="onboarding-note">{words.installNote}</p>;
    case OpenCodeRowState.FreeOnly:
    case OpenCodeRowState.Connected:
      return <p className="onboarding-note">{words.readyNote}</p>;
    case OpenCodeRowState.SignedOut:
      return <p className="onboarding-note">{words.signInNote}</p>;
    case OpenCodeRowState.Outdated:
      return <p className="onboarding-note">{words.outdatedNote ?? words.unreachable}</p>;
    case OpenCodeRowState.Unreachable:
      return <p className="onboarding-note">{words.unreachable}</p>;
    default:
      return null;
  }
}

/** Grok Build's or Cursor's screen: its mark and state (or the sign-in's terminal), its trouble, and Start building. */
export function CliScreen({
  provider,
  cli,
  anyOn,
  onBack,
  onSkip,
  onStart,
}: {
  provider: CliWay;
  cli: Cli;
  anyOn: boolean;
  onBack: () => void;
  onSkip: () => void;
  onStart: () => void;
}): JSX.Element {
  const words = WAYS_WORDS[provider];
  const heading = useHeadingFocus();
  const session = cli.row === OpenCodeRowState.SigningIn ? cli.terminal : undefined;
  return (
    <section className="onboarding-screen onboarding-provider onboarding-enter" data-cli-screen={provider}>
      <TopBar onBack={onBack} onSkip={anyOn ? undefined : onSkip} />
      <h1 ref={heading} tabIndex={-1} className="onboarding-title">
        {words.title}
        {isBeta(provider) && <BetaTag />}
      </h1>
      <p className="onboarding-lede onboarding-lede-narrow">{session ? words.signingInNote : words.lede}</p>
      {session ? (
        <SignInCard
          cli={cli}
          session={session}
          words={{
            terminal: words.terminal,
            cancel: SHARED.cancelSignIn,
            openSignInPage: SHARED.openSignInPage,
            note: words.signInNote,
          }}
        />
      ) : (
        <>
          <MeteredMarkArt id={MARK[provider]} state={cliMark(cli.row, cli.checking)} />
          <div className="onboarding-choice">
            <Hug swap={`${cli.checking}:${cli.row}`}>
              <CliControl cli={cli} words={words} />
            </Hug>
            <CliAside cli={cli} words={words} />
          </div>
        </>
      )}
      <p role="alert" className="onboarding-problem">
        {cli.problem ?? ""}
      </p>
      <StartBuilding anyOn={anyOn} onStart={onStart} />
    </section>
  );
}
