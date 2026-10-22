/**
 * Play's Genex card at the foot of the sidebar, for someone who has not signed in to Genex yet: a
 * short film of a game going live on Play, three things a Genex account gives, Learn, and Sign in,
 * which opens genex.games in the browser, the same path as the plate under it and a game's guest
 * card (`use-genex-sign-in.ts`). It shows once: the first sign-in or a close retires it for good.
 */
import type { JSX } from "react";
import { useEffect, useRef, useState } from "react";
import { SECOND_MS } from "../../shared/duration.ts";
import { playToolsUrl } from "../../shared/play.ts";
import { GenexAccountStatus } from "../../shared/genex-account.ts";
import { usePeople, usePlay, usePlayWeb } from "../state/hooks.ts";
import { studio } from "../state/studio.ts";
import { Button } from "../ui/Button.tsx";
import { Icon, type IconName } from "../ui/icons.tsx";
import { prefersReducedMotion } from "../ui/media-queries.ts";
import { PLAY_WORDS } from "../words.ts";
import { dismissPlayPromo, playPromoDismissed, playPromoVisible } from "./play-model.ts";
import { useGenexSignIn } from "./use-genex-sign-in.ts";

const WORDS = PLAY_WORDS.promo;
/** The film and its still, copied beside the renderer by the build (`design/play-publish-video/`). */
const FILM = "media/play-publish.mp4";
const FILM_POSTER = "media/play-publish-poster.jpg";
/** How long Learn says the link was copied, when the browser could not be opened. */
const COPIED_NOTE_MS = 2 * SECOND_MS;

const FEATURES: ReadonlyArray<[IconName, string]> = [
  ["globe", WORDS.publish],
  ["users", WORDS.multiplayer],
  ["box", WORDS.tools],
];

/** The film, still under Reduce Motion, and paused while the window is hidden or a game is being played over it. */
function Film(): JSX.Element {
  const still = useRef(prefersReducedMotion()).current;
  const video = useRef<HTMLVideoElement>(null);
  const playing = usePlay((s) => s.viewer !== null);
  useEffect(() => {
    const film = video.current;
    if (!film) return;
    const sync = () => {
      if (playing || document.visibilityState !== "visible") film.pause();
      else void film.play().catch(() => {});
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, [playing]);
  return (
    <div className="genex-promo-media play-promo-media" aria-hidden="true">
      {still ? (
        <img src={FILM_POSTER} alt="" />
      ) : (
        <video
          ref={video}
          src={FILM}
          poster={FILM_POSTER}
          preload="auto"
          muted
          loop
          playsInline
          disablePictureInPicture
        />
      )}
    </div>
  );
}

/** Opens what the Genex plugin is in the browser; copies the address where the browser may not open. */
function Learn(): JSX.Element {
  const [copied, setCopied] = useState(false);
  const learnUrl = playToolsUrl(usePlayWeb());
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), COPIED_NOTE_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const open = async (): Promise<void> => {
    try {
      await studio().api.openUrl(learnUrl);
    } catch {
      await navigator.clipboard.writeText(learnUrl).then(
        () => setCopied(true),
        () => undefined,
      );
    }
  };
  return (
    <button type="button" className="genex-promo-link" aria-label={WORDS.learnLabel} onClick={() => void open()}>
      {copied ? WORDS.linkCopied : WORDS.learn}
      {copied && <Icon name="check" size={14} />}
    </button>
  );
}

/** Learn and Sign in, which opens genex.games in the browser. */
function Footer(): JSX.Element {
  const { busy, signIn } = useGenexSignIn();
  const waiting = usePeople((s) => s.account === GenexAccountStatus.SigningIn);
  return (
    <div className="genex-promo-footer">
      <Learn />
      <Button
        variant="default"
        busy={busy || waiting}
        aria-label={WORDS.signInLabel}
        data-genex-sign-in
        onClick={signIn}
      >
        {WORDS.signIn}
      </Button>
    </div>
  );
}

/**
 * The Genex card at the sidebar's foot in Play, shown once: to someone who has not signed in yet,
 * until they sign in or close it. The account plate stays under it.
 */
export function PlayPromo(): JSX.Element | null {
  const [closed, setClosed] = useState(false);
  const account = usePeople((s) => s.account);
  // Read each time: the first sign-in retires the card in storage while it is mounted (`use-people-sync.ts`).
  const dismissed = closed || playPromoDismissed();
  if (!playPromoVisible({ dismissed, account })) return null;
  const dismiss = (): void => {
    dismissPlayPromo();
    setClosed(true);
  };
  return (
    <aside
      className="play-promo"
      aria-label={WORDS.label}
      data-play-promo
      onKeyDown={(event) => {
        if (event.key === "Escape") dismiss();
      }}
    >
      <Film />
      <button type="button" className="genex-promo-close" aria-label={WORDS.dismiss} onClick={dismiss}>
        <Icon name="close" size={14} strokeWidth={2} />
      </button>
      <div className="genex-promo-body">
        <p className="genex-promo-eyebrow">{WORDS.eyebrow}</p>
        <h2 className="genex-promo-title">{WORDS.title}</h2>
        <ul className="play-promo-features">
          {FEATURES.map(([icon, title]) => (
            <li key={title}>
              <Icon name={icon} size={18} className="play-promo-feature-icon" />
              <span>{title}</span>
            </li>
          ))}
        </ul>
      </div>
      <Footer />
    </aside>
  );
}
