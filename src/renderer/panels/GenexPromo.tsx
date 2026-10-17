/**
 * The Genex promo: a card floating in a bottom corner after the welcome, with a short film of
 * Genex making assets, three lines on what it does and one button that connects it. Over home it
 * sits bottom-left, clear of home's composer, and moves nothing beneath it; over a game it sits
 * bottom-right, over the stage, away from the chat's composer. It never covers the welcome or
 * Plugins, settles for good once dismissed or connected, and hands a running game's rectangle back
 * to the DOM while it is up (`stage/native-bounds.ts`).
 */
import type { JSX } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { SECOND_MS } from "../../shared/duration.ts";
import { GENEX_PLUGIN_ID } from "../../shared/genex.ts";
import type { PluginInfo } from "../../shared/plugins.ts";
import { UiEvent } from "../../shared/ui-events.ts";
import {
  finishGenexPromo,
  type PromoAccount,
  type PromoAttempt,
  PromoPhase,
  genexPromoSettled,
  genexPromoVisible,
  promoPhase,
  storedGenexPromo,
} from "../genex-promo.ts";
import { runPluginAction } from "../plugin-actions.ts";
import { playToolsUrl } from "../../shared/play.ts";
import { usePlayWeb, usePlugins, useThreads } from "../state/hooks.ts";
import { Room, roomOf } from "../state/threads.ts";
import { Button } from "../ui/Button.tsx";
import { Icon, type IconName } from "../ui/icons.tsx";
import { LoaderGrid } from "../ui/LoadingState.tsx";
import { prefersReducedMotion } from "../ui/media-queries.ts";
import { GENEX_WORDS } from "../words.ts";

const WORDS = GENEX_WORDS.promo;

/** The film and its still, copied beside the renderer by the build. */
const PROMO_VIDEO = "media/genex-promo.mp4";
const PROMO_POSTER = "media/genex-promo-poster.jpg";
/** The longest the card waits for its film's first frame before it rises without it. */
const FILM_WAIT_MS = 1.5 * SECOND_MS;
/** How long Learn more says the link was copied, when the browser could not be opened. */
const COPIED_NOTE_MS = 2 * SECOND_MS;
/** The card waits this long after it may show, so the welcome's fade finishes first. */
const APPEAR_DELAY_MS = 1.2 * SECOND_MS;
/** How long the card's exit plays before it unmounts. */
const LEAVE_MS = 180;
/** How often the account is re-read while a sign-in the card started is under way. */
const SIGN_IN_POLL_MS = 2 * SECOND_MS;

const IDLE_ATTEMPT: PromoAttempt = { started: false, error: "", sawSignIn: false };

const FEATURES: ReadonlyArray<[IconName, { title: string; text: string }]> = [
  ["box", WORDS.models],
  ["sound", WORDS.media],
  ["globe", WORDS.publish],
];

/** The Genex account as the connection snapshot reports it, re-read on changes and, while signing in, on a timer. */
function useGenexAccount(project: string | null, watching: boolean, polling: boolean) {
  const [account, setAccount] = useState<PromoAccount>();
  const read = useCallback(async () => {
    try {
      const snapshot = await window.studio.connections(undefined, project);
      setAccount(snapshot.sources.find((s) => s.kind === "plugin" && s.id === GENEX_PLUGIN_ID)?.account);
    } catch {
      // A snapshot that cannot be read keeps the last answer; the next change reads again.
    }
  }, [project]);
  useEffect(() => {
    if (!watching) return;
    void read();
    const unsubscribe = window.studio.onEvent((event) => {
      if (event.type === UiEvent.ConnectionsChanged || event.type === UiEvent.PluginsChanged) void read();
    });
    window.addEventListener("focus", read);
    return () => {
      unsubscribe();
      window.removeEventListener("focus", read);
    };
  }, [watching, read]);
  useEffect(() => {
    if (!watching || !polling) return;
    const timer = window.setInterval(() => void read(), SIGN_IN_POLL_MS);
    return () => window.clearInterval(timer);
  }, [watching, polling, read]);
  return { account, read };
}

/** True once `on` has held for `delay`; false again the moment it stops. */
function useSettledFlag(on: boolean, delay: number): boolean {
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (!on) {
      setSettled(false);
      return;
    }
    const timer = window.setTimeout(() => setSettled(true), delay);
    return () => window.clearTimeout(timer);
  }, [on, delay]);
  return settled;
}

/** The film: muted, looping, decorative; a still under Reduce Motion. */
/** The film, or its still under Reduce Motion; `onReady` fires once there is a picture (or none will come). */
function PromoFilm({ onReady }: { onReady: () => void }): JSX.Element {
  const still = useRef(prefersReducedMotion()).current;
  return (
    <div className="genex-promo-media" aria-hidden="true">
      {still ? (
        <img src={PROMO_POSTER} alt="" onLoad={onReady} onError={onReady} />
      ) : (
        <video
          src={PROMO_VIDEO}
          poster={PROMO_POSTER}
          preload="auto"
          autoPlay
          muted
          loop
          playsInline
          disablePictureInPicture
          onLoadedData={onReady}
          onError={onReady}
        />
      )}
    </div>
  );
}

/** Whether the card may rise: its film has a first frame, or waiting for one took too long. */
function useFilmReady(): [boolean, () => void] {
  const [ready, setReady] = useState(false);
  const reveal = useCallback(() => setReady(true), []);
  useEffect(() => {
    const timer = window.setTimeout(reveal, FILM_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [reveal]);
  return [ready, reveal];
}

function Features(): JSX.Element {
  return (
    <ul className="genex-promo-features">
      {FEATURES.map(([icon, words]) => (
        <li key={words.title}>
          <Icon name={icon} size={18} className="genex-promo-feature-icon" />
          <span>
            <span className="genex-promo-feature-title">{words.title}</span>
            <span className="genex-promo-feature-text">{words.text}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The footer for each step: Learn more and connect (or retry), the browser wait with Cancel, or Done. */
function Footer({
  phase,
  busy,
  onConnect,
  onCancel,
  onClose,
}: {
  phase: PromoPhase;
  busy: boolean;
  onConnect: () => void;
  onCancel: () => void;
  onClose: () => void;
}): JSX.Element {
  if (phase === PromoPhase.Connected)
    return (
      <div className="genex-promo-footer">
        <Button variant="default" className="ml-auto" onClick={onClose}>
          {WORDS.done}
        </Button>
      </div>
    );
  if (phase === PromoPhase.Waiting)
    return (
      <div className="genex-promo-footer">
        <span className="genex-promo-status" role="status">
          <LoaderGrid />
          {WORDS.waiting}
        </span>
        <Button onClick={onCancel}>{WORDS.cancel}</Button>
      </div>
    );
  // A failure is told by the button itself: it turns into Try again, its reason in the tooltip.
  const failed = phase === PromoPhase.Failed;
  return (
    <div className="genex-promo-footer">
      <LearnMore />
      <Button variant="default" disabled={busy} title={failed ? WORDS.failed : undefined} onClick={onConnect}>
        {failed && <Icon name="reload" />}
        {failed ? WORDS.retry : WORDS.connect}
      </Button>
    </div>
  );
}

/**
 * Opens the Genex plugin's page in the browser. Where the browser may not be opened (a fixture profile), the
 * address is copied instead and the link says so for a moment.
 */
function LearnMore(): JSX.Element {
  const [copied, setCopied] = useState(false);
  const toolsUrl = playToolsUrl(usePlayWeb());
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), COPIED_NOTE_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const open = async (): Promise<void> => {
    try {
      await window.studio.openUrl(toolsUrl);
    } catch {
      await navigator.clipboard.writeText(toolsUrl).then(
        () => setCopied(true),
        () => undefined,
      );
    }
  };
  return (
    <button type="button" className="genex-promo-link" aria-label={WORDS.learnMoreLabel} onClick={() => void open()}>
      {copied ? WORDS.linkCopied : WORDS.learnMore}
      <Icon name={copied ? "check" : "arrow-up-right"} size={14} />
    </button>
  );
}

/** The card's words for its step: the offer, or connected. */
function Body({ phase }: { phase: PromoPhase }): JSX.Element {
  if (phase === PromoPhase.Connected)
    return (
      <div className="genex-promo-body">
        <h2 className="genex-promo-title">
          <span className="genex-dot" aria-hidden="true" />
          {WORDS.connectedTitle}
        </h2>
        <p className="genex-promo-text">{WORDS.connectedText}</p>
      </div>
    );
  return (
    <div className="genex-promo-body">
      <p className="genex-promo-eyebrow">{WORDS.eyebrow}</p>
      <h2 className="genex-promo-title">{WORDS.title}</h2>
      <Features />
    </div>
  );
}

/** Starting and cancelling the card's own sign-in; the attempt it leaves behind is the card's. */
function useSignIn(
  plugin: PluginInfo | undefined,
  project: string | null,
  reread: () => Promise<void>,
  setAttempt: (update: (attempt: PromoAttempt) => PromoAttempt) => void,
) {
  const [busy, setBusy] = useState(false);
  const run = async (name: string | undefined): Promise<void> => {
    if (!plugin || !name) return;
    // Connect and cancel need no confirmation; a review that ever appears is declined.
    await runPluginAction({ plugin, name, args: {}, project, review: (request) => request.resolve(false) });
  };
  const connect = async (): Promise<void> => {
    setAttempt(() => ({ started: true, error: "", sawSignIn: false }));
    setBusy(true);
    try {
      await run(plugin?.manifest.account?.connect);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      // The card only turns its button into Try again; the reason stays in the app's logs.
      console.warn("Genex sign-in did not finish:", error);
      setAttempt((a) => ({ ...a, error }));
    } finally {
      setBusy(false);
      await reread();
    }
  };
  const cancel = async (): Promise<void> => {
    setAttempt(() => IDLE_ATTEMPT);
    try {
      await run(plugin?.manifest.account?.cancel);
    } finally {
      await reread();
    }
  };
  return { busy, connect, cancel };
}

/** The promo card, or nothing while it has no reason to show. */
export function GenexPromo({
  welcoming,
  pluginsOpen,
  project,
}: {
  welcoming: boolean;
  pluginsOpen: boolean;
  project: string | null;
}): JSX.Element | null {
  const plugin = usePlugins((s) => s.list.find((p) => p.manifest.id === GENEX_PLUGIN_ID));
  const atHome = useThreads((s) => roomOf(s) === Room.Home);
  const [stored, setStored] = useState(() => storedGenexPromo());
  // The welcome queues the promo as it ends, after this card has mounted: read the queue again then.
  useEffect(() => {
    if (!welcoming) setStored(storedGenexPromo());
  }, [welcoming]);
  const [closing, setClosing] = useState(false);
  const [gone, setGone] = useState(false);
  const [attempt, setAttempt] = useState<PromoAttempt>(IDLE_ATTEMPT);
  const queued = stored !== null && !gone;
  const { account, read } = useGenexAccount(project, queued, attempt.started);
  const signIn = useSignIn(plugin, project, read, setAttempt);
  const installed = plugin ? { installed: !plugin.removed && !plugin.unlisted, enabled: plugin.enabled } : undefined;
  const offered = genexPromoVisible({ stored, plugin: installed, account, welcoming, pluginsOpen });
  const connected = attempt.started && genexPromoSettled(account);
  const settle = useCallback(() => {
    finishGenexPromo();
    setStored(storedGenexPromo());
  }, []);
  // An account that already exists (or arrives from elsewhere) retires the promo without a card.
  useEffect(() => {
    if (genexPromoSettled(account)) settle();
  }, [account, settle]);
  useEffect(() => {
    if (attempt.started && account === "authorizing" && !attempt.sawSignIn)
      setAttempt((a) => ({ ...a, sawSignIn: true }));
  }, [attempt.started, attempt.sawSignIn, account]);
  // A closing card stays mounted until its exit has played, though closing already settled the promo.
  const shown = useSettledFlag((offered || connected || closing) && !gone, APPEAR_DELAY_MS);
  const close = (): void => {
    settle();
    setClosing(true);
    window.setTimeout(() => setGone(true), prefersReducedMotion() ? 0 : LEAVE_MS);
  };
  if (!shown || welcoming || pluginsOpen) return null;
  return (
    <GenexPromoCard
      phase={promoPhase(account, attempt)}
      atHome={atHome}
      busy={signIn.busy}
      closing={closing}
      onConnect={() => void signIn.connect()}
      onCancel={() => void signIn.cancel()}
      onClose={close}
    />
  );
}

/** The card itself for one step; `GenexPromo` decides when it shows and what it does. */
export function GenexPromoCard({
  phase,
  atHome = false,
  busy,
  closing,
  onConnect,
  onCancel,
  onClose,
}: {
  phase: PromoPhase;
  /** Home is up: the card takes the bottom-left corner, clear of home's composer. */
  atHome?: boolean;
  busy: boolean;
  closing: boolean;
  onConnect: () => void;
  onCancel: () => void;
  onClose: () => void;
}): JSX.Element {
  // The card rises whole: it stays hidden until the film's first frame is there to rise with it.
  const [ready, reveal] = useFilmReady();
  return (
    <aside
      className="genex-promo"
      data-genex-promo={phase}
      data-at-home={atHome || undefined}
      data-ready={ready || undefined}
      data-leaving={closing || undefined}
      aria-label={WORDS.label}
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
    >
      <PromoFilm onReady={reveal} />
      <button type="button" className="genex-promo-close" aria-label={WORDS.dismiss} onClick={onClose}>
        <Icon name="close" size={14} strokeWidth={2} />
      </button>
      <Body phase={phase} />
      <Footer phase={phase} busy={busy} onConnect={onConnect} onCancel={onCancel} onClose={onClose} />
    </aside>
  );
}
