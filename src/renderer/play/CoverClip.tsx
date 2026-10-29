/**
 * A card's cover clip and the top row's one pause, as genex.games draws them. `clip-playback.ts`
 * decides which clips hold a decoder and whether each one plays; this file owns the element and its
 * manners: muted, inline, looping, no controls, hidden from assistive tech, no source until the store
 * admits it, and a fade over the still on its first frame (a hover's no sooner than the reveal
 * floor). Let go, it pauses, drops its source and loads nothing, so the decoder is freed rather than
 * left to the garbage collector. An error fails the clip for the session; a refused play() stops
 * every clip.
 */
import type { JSX, RefObject } from "react";
import { useEffect, useRef, useState } from "react";
import { Icon } from "../ui/icons.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip.tsx";
import { PLAY_WORDS } from "../words.ts";
import {
  ClipState,
  clipHoverStartedAt,
  clipNow,
  markClipFailed,
  markClipsRefused,
  registerClip,
  revealWait,
  toggleClipsPaused,
  updateClip,
  useClipControl,
  useClipFailed,
  useClipState,
  useClipsPaused,
} from "./clip-playback.ts";

const WORDS = PLAY_WORDS.clips;

/** The names a rejected play() carries that the clip reads. */
const PlayRejection = { Aborted: "AbortError", Refused: "NotAllowedError" } as const;

const rejectionName = (error: unknown): string => (error instanceof DOMException ? error.name : "");

/** Frees the element's decoder: pause, no source, and a load of nothing. */
function release(video: HTMLVideoElement): void {
  if (!video.getAttribute("src")) return;
  video.pause();
  video.removeAttribute("src");
  video.load();
}

/** A rejected play(): a pause or a release that interrupted it is nothing; a refusal stops every clip. */
function rejected(error: unknown, url: string): void {
  const name = rejectionName(error);
  if (name === PlayRejection.Aborted) return;
  if (name === PlayRejection.Refused) markClipsRefused();
  else markClipFailed(url);
}

/** The `<video>` of one card: its source set on admission, playing or held as the store says. */
function ClipVideo({ clipKey, url }: { clipKey: string; url: string }): JSX.Element {
  const state = useClipState(clipKey);
  const wants = state !== ClipState.Off;
  const ref = useRef<HTMLVideoElement>(null);
  const [framed, setFramed] = useState(false);
  const [shown, setShown] = useState(false);

  // Leaving the page frees the decoder too.
  useEffect(() => {
    const video = ref.current;
    return () => {
      if (video) release(video);
    };
  }, []);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    if (!wants) {
      release(video);
      setFramed(false);
      setShown(false);
      return;
    }
    // React does not reflect `muted`; an autoplay policy refuses an unmuted play().
    video.muted = true;
    if (!video.getAttribute("src")) video.src = url;
    if (state === ClipState.Hold) {
      video.pause();
      return;
    }
    let stale = false;
    video.play().catch((error: unknown) => {
      if (!stale && video.getAttribute("src")) rejected(error, url);
    });
    return () => {
      stale = true;
    };
  }, [state, wants, url]);

  // The fade: on the first frame, and for a hover no sooner than the reveal floor.
  useEffect(() => {
    if (!framed || !wants) return;
    const since = state === ClipState.Hover ? clipHoverStartedAt(clipKey) : null;
    const timer = window.setTimeout(() => setShown(true), revealWait(since, clipNow()));
    return () => window.clearTimeout(timer);
  }, [framed, wants, state, clipKey]);

  return (
    <video
      ref={ref}
      className="play-card-clip"
      muted
      loop
      playsInline
      preload={wants ? "auto" : "none"}
      disablePictureInPicture
      aria-hidden="true"
      tabIndex={-1}
      data-shown={shown || undefined}
      onPlaying={() => setFramed(true)}
      onError={(event) => {
        // A release empties the source on purpose; only a real source fails the clip.
        if (event.currentTarget.getAttribute("src")) markClipFailed(url);
      }}
    />
  );
}

/**
 * The cover's clip, registered with the window's store for as long as the card shows it. A clip that
 * failed this session draws nothing, so the still stays.
 */
export function CoverClip({
  clipKey,
  url,
  ready,
  autoplay,
  index,
  anchor,
}: {
  /** The card's key in the store (its `useId`). */
  clipKey: string;
  url: string;
  /** The card's cover has decoded. */
  ready: boolean;
  /** A top-row card. */
  autoplay: boolean;
  /** The card's place in its grid. */
  index: number;
  /** The cover the one observer watches. */
  anchor: RefObject<HTMLElement | null>;
}): JSX.Element | null {
  const failed = useClipFailed(url);
  // Registered once per card: re-registering on each change would restart its view and stagger.
  const spec = useRef({ url, ready, autoplay, index });
  spec.current = { url, ready, autoplay, index };
  useEffect(() => {
    if (failed) return;
    return registerClip(clipKey, { ...spec.current, el: anchor.current });
  }, [clipKey, failed, anchor]);
  useEffect(() => {
    if (!failed) updateClip(clipKey, { url, ready, autoplay, index });
  }, [clipKey, failed, url, ready, autoplay, index]);
  if (failed) return null;
  // Keyed by its source: a new clip on the card is a new element, so the old decoder is freed.
  return <ClipVideo key={url} clipKey={clipKey} url={url} />;
}

/**
 * The top row's one pause, after the tabs: it shows while a top-row card has a clip that can play,
 * pauses every clip (hover too) and remembers it on this Mac; pressed again, they play.
 */
export function ClipsToggle(): JSX.Element | null {
  const shows = useClipControl();
  const paused = useClipsPaused();
  if (!shows) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="play-clips-toggle no-drag"
          data-play-clips={paused ? "paused" : "playing"}
          aria-label={WORDS.pause}
          aria-pressed={paused}
          onClick={toggleClipsPaused}
        >
          <Icon name={paused ? "play" : "pause"} size={14} />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{paused ? WORDS.play : WORDS.pause}</TooltipContent>
    </Tooltip>
  );
}
