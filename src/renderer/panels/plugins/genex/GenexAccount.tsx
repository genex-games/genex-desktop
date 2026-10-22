/**
 * The Genex account in the page's Connect band: one state at a time (the offer with Connect, finish
 * in the browser, terms, connected with its credits) and only the action that state needs, beside
 * the routed tools' lines (`ConnectBand`). It replaces the plugin's own frame on the Genex page, so
 * it speaks in the app's type, colours and buttons.
 */
import type { JSX, ReactNode } from "react";
import { GenexAction } from "../../../../shared/genex.ts";
import { intlLocale } from "../../../../shared/i18n.ts";
import { creditsPlansUrl } from "../../../../shared/play-credits.ts";
import { CreditsShard } from "../../../play/CreditsShard.tsx";
import { usePlayWeb } from "../../../state/hooks.ts";
import { Button } from "../../../ui/Button.tsx";
import { Icon } from "../../../ui/icons.tsx";
import { Pending } from "../../../ui/Pending.tsx";
import { GENEX_WORDS } from "../../../words.ts";
import { ConnectBand } from "./ConnectArt.tsx";
import { ConnectArtState, connectArtState } from "./connect-art.ts";
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
const NUMBER = new Intl.NumberFormat(intlLocale());

/** A state's title, its line and its actions, stacked in the band's side. */
function Prompt({ title, children, actions }: { title: ReactNode; children?: ReactNode; actions?: ReactNode }) {
  return (
    <>
      <h2 className="genex-connect-title">{title}</h2>
      {children}
      {actions && <div className="genex-connect-actions">{actions}</div>}
    </>
  );
}

/** A background-less action, as underlined text. */
function TextAction({ disabled, onClick, children }: { disabled: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className="genex-connect-link" disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
}

/**
 * The band's one filled action, the one its lines run into. `shine` sweeps a light across its
 * label, as genex.games' plan button does, for the press the page is there for.
 */
function BandAction({
  busy,
  shine = false,
  onClick,
  children,
}: {
  busy: boolean;
  shine?: boolean;
  onClick: () => void;
  children: ReactNode;
}): JSX.Element {
  return (
    <Button variant="play-fill" size="default" disabled={busy} data-connect-target="" onClick={onClick}>
      {shine ? <span className="genex-connect-shine">{children}</span> : children}
    </Button>
  );
}

/** The offer: the best tools in one click, optional, and Connect (Reconnect after a failed one). */
function ConnectOffer({
  retry = false,
  busy,
  onConnect,
}: {
  retry?: boolean;
  busy: boolean;
  onConnect: () => void;
}): JSX.Element {
  return (
    <Prompt
      title={retry ? WORDS.retryTitle : WORDS.offerTitle}
      actions={
        <BandAction busy={busy} shine={!retry} onClick={onConnect}>
          {retry ? WORDS.retry : WORDS.connect}
        </BandAction>
      }
    >
      <p className="genex-connect-text">{retry ? WORDS.retryText : WORDS.offerText}</p>
    </Prompt>
  );
}

function creditsValue(credits: CreditsView): string | null {
  if (credits.kind === CreditsKind.Unlimited) return WORDS.unlimited;
  return credits.kind === CreditsKind.Count ? NUMBER.format(credits.count) : null;
}

const outOfCredits = (credits: CreditsView): boolean => credits.kind === CreditsKind.Count && credits.count <= 0;

/** The balance, its unit and Get credits, which opens genex.games' plans (an unlimited account needs none). */
function Balance({ credits }: { credits: CreditsView }): JSX.Element | null {
  const web = usePlayWeb();
  const value = creditsValue(credits);
  if (!value) return null;
  return (
    <div className="genex-connect-credits" data-warn={outOfCredits(credits) || undefined}>
      <CreditsShard size={18} />
      <span className="genex-connect-balance">{value}</span>
      {credits.kind === CreditsKind.Count && (
        <>
          <span className="genex-connect-text">{GENEX_WORDS.creditsTab.unit(credits.count)}</span>
          <Button variant="play-tint" onClick={() => void window.studio.openUrl(creditsPlansUrl(web))}>
            {GENEX_WORDS.creditsTab.getCredits}
          </Button>
        </>
      )}
    </div>
  );
}

function Connected({
  view,
  live,
  busy,
}: {
  view: Extract<GenexAccountView, { kind: typeof GenexAccountKind.Connected }>;
  live: GenexLive;
  busy: boolean;
}): JSX.Element {
  const empty = outOfCredits(view.credits);
  return (
    <>
      <div className="genex-connect-head">
        <h2 className="genex-connect-title">
          <Icon name="check" size={16} className="genex-connect-check" />
          {WORDS.connected}
        </h2>
        <TextAction disabled={busy} onClick={() => void live.act(GenexAction.Disconnect)}>
          {WORDS.disconnect}
        </TextAction>
      </div>
      {view.identity && <p className="genex-connect-text">{view.identity}</p>}
      <Balance credits={view.credits} />
      {empty && <p className="genex-note">{WORDS.outOfCredits}</p>}
      {view.paused.length > 0 && <p className="genex-note">{WORDS.paused(view.paused.join(", "))}</p>}
    </>
  );
}

/** Each state's words and actions; Connected has its own component. `busy`: an action is under way. */
function StateBody({ view, live, busy }: { view: GenexAccountView; live: GenexLive; busy: boolean }): JSX.Element {
  const connect = () => void live.act(GenexAction.Connect);
  switch (view.kind) {
    case GenexAccountKind.Loading:
      return <Pending label={WORDS.loading} className="genex-checking" />;
    case GenexAccountKind.SignedOut:
      return <ConnectOffer retry={view.retry} busy={busy} onConnect={connect} />;
    case GenexAccountKind.SigningIn:
      return (
        <Prompt
          title={WORDS.signingInTitle}
          actions={
            <>
              <Button variant="play-tint" disabled={busy} onClick={connect}>
                {WORDS.reopen}
              </Button>
              <TextAction disabled={busy} onClick={() => void live.act(GenexAction.CancelConnect)}>
                {WORDS.cancel}
              </TextAction>
            </>
          }
        />
      );
    case GenexAccountKind.Terms:
      return (
        <Prompt
          title={WORDS.termsTitle}
          actions={
            <BandAction busy={busy} onClick={() => void live.act(GenexAction.Terms)}>
              {WORDS.terms}
              <Icon name="arrow-up-right" size={14} />
            </BandAction>
          }
        >
          <p className="genex-connect-text">{WORDS.termsText}</p>
        </Prompt>
      );
    case GenexAccountKind.Checking:
      return <Pending label={WORDS.checking} className="genex-checking" />;
    case GenexAccountKind.Attention:
      return (
        <Prompt
          title={WORDS.attentionTitle}
          actions={
            <Button variant="play-tint" disabled={busy} onClick={() => void live.refresh()}>
              {WORDS.tryAgain}
            </Button>
          }
        >
          <p className="genex-connect-text">{view.error}</p>
        </Prompt>
      );
    default:
      return <Connected view={view} live={live} busy={busy} />;
  }
}

/** Connect while the plugin is off: what it runs (turn on, then sign in when needed). */
export interface PluginOff {
  onConnect: () => void;
}

/**
 * The Connect band, for the plugin's live status: the offer while the plugin is `off`, the
 * account's state once it is on. One band either way, so turning the plugin on keeps the page
 * where it is and its changes are announced in place. `problem` is a failure the Plugins page met
 * on the way here (its account button, or Connect while off), shown in the band like the band's
 * own; `busy` is an action of the page's under way.
 */
export function GenexAccount({
  live,
  problem = "",
  busy = false,
  off,
}: {
  live: GenexLive;
  problem?: string;
  busy?: boolean;
  off?: PluginOff;
}): JSX.Element {
  const acting = busy || live.running !== null;
  if (off)
    return (
      <ConnectBand state={ConnectArtState.Waiting} label={WORDS.offLabel} hooks={{ "data-genex-connect": "off" }}>
        <ConnectOffer busy={acting} onConnect={off.onConnect} />
        {problem && (
          <p role="alert" className="genex-error">
            {problem}
          </p>
        )}
      </ConnectBand>
    );
  const view = genexAccountView(live.status);
  // Before the first status, a failed read is the band's own state rather than a line beneath it.
  const unreadable = live.status === null && live.error;
  const shown: GenexAccountView = unreadable ? { kind: GenexAccountKind.Attention, error: live.error } : view;
  const why = unreadable ? problem : live.error || problem;
  return (
    <ConnectBand state={connectArtState(shown.kind)} label={WORDS.label} hooks={{ "data-genex-account": shown.kind }}>
      <StateBody view={shown} live={live} busy={acting} />
      {why && (
        <p role="alert" className="genex-error">
          {why}
        </p>
      )}
    </ConnectBand>
  );
}
