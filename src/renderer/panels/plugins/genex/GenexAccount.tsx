/**
 * The Genex account card: one state at a time (connect, finish in the browser, terms, connected
 * with its credits) and only the action that state needs. It replaces the plugin's own frame on
 * the Genex page, so it speaks in the app's type, colours and buttons.
 */
import type { JSX, ReactNode } from "react";
import { GenexAction } from "../../../../shared/genex.ts";
import { CreditsShard } from "../../../play/CreditsShard.tsx";
import { Button } from "../../../ui/Button.tsx";
import { Icon } from "../../../ui/icons.tsx";
import { Pending } from "../../../ui/Pending.tsx";
import { GENEX_WORDS } from "../../../words.ts";
import {
  CreditsKind,
  type CreditsView,
  GenexAccountKind,
  type GenexAccountView,
  genexAccountView,
} from "./genex-view.ts";
import type { GenexLive } from "./use-genex-status.ts";

const WORDS = GENEX_WORDS.account;

/** Credits read with the reader's own digit grouping. */
const NUMBER = new Intl.NumberFormat();

/** The card's frame: its state for smoke checks and polite announcements of each change. */
function Card({ kind, children }: { kind: GenexAccountKind; children: ReactNode }): JSX.Element {
  return (
    <section className="genex-account" data-genex-account={kind} aria-live="polite" aria-label="Genex account">
      {children}
    </section>
  );
}

/** A state's words on the left and its actions on the right, wrapping under them when narrow. */
function Prompt({ title, children, actions }: { title: ReactNode; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="genex-account-row">
      <div className="genex-account-copy">
        <h2>{title}</h2>
        {children}
      </div>
      {actions && <div className="genex-account-actions">{actions}</div>}
    </div>
  );
}

/** The one filled action of a state. */
function Primary({ live, children, onClick }: { live: GenexLive; children: ReactNode; onClick: () => void }) {
  return (
    <Button variant="default" size="default" disabled={live.running !== null} onClick={onClick}>
      {children}
    </Button>
  );
}

function Stat({ label, value, warn = false }: { label: string; value: string; warn?: boolean }): JSX.Element {
  return (
    <div className="genex-stat" data-warn={warn || undefined}>
      <dt>{label}</dt>
      <dd>
        <CreditsShard size={20} />
        {value}
      </dd>
    </div>
  );
}

function creditsValue(credits: CreditsView): string | null {
  if (credits.kind === CreditsKind.Unlimited) return WORDS.unlimited;
  return credits.kind === CreditsKind.Count ? NUMBER.format(credits.count) : null;
}

const outOfCredits = (credits: CreditsView): boolean => credits.kind === CreditsKind.Count && credits.count <= 0;

function Connected({
  view,
  live,
}: {
  view: Extract<GenexAccountView, { kind: typeof GenexAccountKind.Connected }>;
  live: GenexLive;
}): JSX.Element {
  const credits = creditsValue(view.credits);
  const empty = outOfCredits(view.credits);
  const note = empty ? WORDS.outOfCredits : WORDS.shared;
  return (
    <>
      <Prompt
        title={
          <>
            <span className="genex-dot" aria-hidden="true" />
            {WORDS.connected}
          </>
        }
        actions={
          <Button
            variant="ghost"
            disabled={live.running !== null}
            onClick={() => void live.act(GenexAction.Disconnect)}
          >
            {WORDS.disconnect}
          </Button>
        }
      >
        {view.identity && <p>{view.identity}</p>}
      </Prompt>
      {credits && (
        <dl className="genex-stats">
          <Stat label={WORDS.credits} value={credits} warn={empty} />
        </dl>
      )}
      {credits && view.credits.kind !== CreditsKind.Unlimited && (
        <p className="genex-note" data-quiet={!empty || undefined}>
          {note}
        </p>
      )}
      {view.paused.length > 0 && <p className="genex-note">{WORDS.paused(view.paused.join(", "))}</p>}
    </>
  );
}

/** Each state's body; Connected has its own component. */
function StateBody({ view, live }: { view: GenexAccountView; live: GenexLive }): JSX.Element {
  const connect = () => void live.act(GenexAction.Connect);
  switch (view.kind) {
    case GenexAccountKind.Loading:
      return <Pending label={WORDS.loading} className="genex-checking" spinner />;
    case GenexAccountKind.SignedOut:
      return (
        <Prompt
          title={view.retry ? WORDS.retryTitle : WORDS.signedOutTitle}
          actions={
            <Primary live={live} onClick={connect}>
              {view.retry ? WORDS.retry : WORDS.connect}
            </Primary>
          }
        >
          <p>{view.retry ? WORDS.retryText : WORDS.signedOutText}</p>
        </Prompt>
      );
    case GenexAccountKind.SigningIn:
      return (
        <Prompt
          title={WORDS.signingInTitle}
          actions={
            <>
              <Button disabled={live.running !== null} onClick={connect}>
                {WORDS.reopen}
              </Button>
              <Button
                variant="ghost"
                disabled={live.running !== null}
                onClick={() => void live.act(GenexAction.CancelConnect)}
              >
                {WORDS.cancel}
              </Button>
            </>
          }
        >
          <p>
            {WORDS.signingInText} <code className="genex-code">{view.code}</code>
          </p>
        </Prompt>
      );
    case GenexAccountKind.Terms:
      return (
        <Prompt
          title={WORDS.termsTitle}
          actions={
            <Primary live={live} onClick={() => void live.act(GenexAction.Terms)}>
              {WORDS.terms}
              <Icon name="arrow-up-right" size={14} />
            </Primary>
          }
        >
          <p>{WORDS.termsText}</p>
        </Prompt>
      );
    case GenexAccountKind.Checking:
      return <Pending label={WORDS.checking} className="genex-checking" spinner />;
    case GenexAccountKind.Attention:
      return (
        <Prompt
          title={WORDS.attentionTitle}
          actions={<Button onClick={() => void live.refresh()}>{WORDS.tryAgain}</Button>}
        >
          <p>{view.error}</p>
        </Prompt>
      );
    default:
      return <Connected view={view} live={live} />;
  }
}

/**
 * The account card for the plugin's live status. `problem` is a failure the Plugins page met on
 * the way here (its account button), shown in the card like the card's own.
 */
export function GenexAccount({ live, problem = "" }: { live: GenexLive; problem?: string }): JSX.Element {
  const view = genexAccountView(live.status);
  // Before the first status, a failed read is the card's own state rather than a line beneath it.
  const unreadable = live.status === null && live.error;
  const shown: GenexAccountView = unreadable ? { kind: GenexAccountKind.Attention, error: live.error } : view;
  const why = unreadable ? problem : live.error || problem;
  return (
    <Card kind={shown.kind}>
      <StateBody view={shown} live={live} />
      {why && (
        <p role="alert" className="genex-error">
          {why}
        </p>
      )}
    </Card>
  );
}
