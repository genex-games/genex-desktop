/**
 * The Publish banner's cover controls, drawn over the cover itself: arrows and dots to flip
 * through the recent frames, the Picture / Clip switch with the clip playing in the banner,
 * Another cover (or clip) with a field for what it should show, whose Ask agent closes the dialog
 * into the chat, and a quiet pill while one is being taken or made. Publish stays pressable through
 * all of them.
 */
import type { FormEvent, JSX } from "react";
import { useEffect, useRef, useState } from "react";
import { SECOND_MS } from "../../../../shared/duration.ts";
import { ProjectAssetScope } from "../../../../shared/game-assets.ts";
import { LoaderGrid } from "../../../ui/LoadingState.tsx";
import { prefersReducedMotion } from "../../../ui/media-queries.ts";
import { Icon } from "../../../ui/icons.tsx";
import { useAsyncEffect } from "../../../use-async-effect.ts";
import { GENEX_WORDS } from "../../../words.ts";
import { CoverKind, coverMinutesLeft } from "./cover-asks.ts";
import { type PublishCover, useElapsed } from "./use-publish-cover.ts";

const WORDS = GENEX_WORDS.publish;

/** The arrows at the banner's sides and the dots at its top, while there are frames to flip between. */
function CoverFlip({ cover, dots }: { cover: PublishCover; dots: boolean }): JSX.Element | null {
  const { shas, index } = cover.choices;
  if (shas.length < 2) return null;
  const at = index < 0 ? 0 : index;
  return (
    <>
      {dots && (
        <div className="genex-publish-pips" role="img" aria-label={WORDS.coverOf(at + 1, shas.length)}>
          {shas.map((sha, i) => (
            <span key={sha} data-on={i === at || undefined} />
          ))}
        </div>
      )}
      <button
        type="button"
        className="genex-publish-arrow"
        data-side="start"
        aria-label={WORDS.coverPrevious}
        onClick={() => cover.flip(-1)}
      >
        <Icon name="chevron-left" size={14} />
      </button>
      <button
        type="button"
        className="genex-publish-arrow"
        data-side="end"
        aria-label={WORDS.coverNext}
        onClick={() => cover.flip(1)}
      >
        <Icon name="chevron-right" size={14} />
      </button>
    </>
  );
}

/** The switch at the banner's top between the cover and its clip. */
function CoverShowSwitch({ show, onShow }: { show: CoverKind; onShow: (show: CoverKind) => void }): JSX.Element {
  const option = (kind: CoverKind, label: string, icon?: JSX.Element) => (
    <button
      type="button"
      className="genex-publish-show-option"
      aria-pressed={show === kind}
      onClick={() => onShow(kind)}
    >
      {icon}
      {label}
    </button>
  );
  return (
    <div className="genex-publish-show" role="group" aria-label={WORDS.coverShow}>
      {option(CoverKind.Picture, WORDS.coverPicture)}
      {option(CoverKind.Clip, WORDS.coverClip, <Icon name="play" size={10} />)}
    </div>
  );
}

/** The kept clip as a playable source, read by the game's name; revoked when it changes or the banner goes. */
function useClipSource(project: string, key: string | null): string | null {
  const [src, setSrc] = useState<string | null>(null);
  useAsyncEffect(
    (alive) => {
      let made: string | null = null;
      if (!key) {
        setSrc(null);
        return undefined;
      }
      void window.studio
        .readProjectAsset({ project, scope: ProjectAssetScope.GenexCoverClip })
        .catch(() => null)
        .then((read) => {
          if (!read || !alive()) return;
          const bytes = Uint8Array.from(atob(read.data), (c) => c.charCodeAt(0));
          made = URL.createObjectURL(new Blob([bytes], { type: read.mimeType }));
          setSrc(made);
        });
      return () => {
        if (made) URL.revokeObjectURL(made);
      };
    },
    [project, key],
  );
  return src;
}

/** The clip playing over the cover, looping and silent, with how far through it is; still under Reduce motion. */
function CoverClipPlayer({ project, clipKey }: { project: string; clipKey: string | null }): JSX.Element | null {
  const src = useClipSource(project, clipKey);
  const video = useRef<HTMLVideoElement>(null);
  const [through, setThrough] = useState(0);
  const still = prefersReducedMotion();
  useEffect(() => {
    const film = video.current;
    if (!film || !src || still) return;
    film.play().catch(() => {});
  }, [src, still]);
  if (!src) return null;
  return (
    <>
      <video
        ref={video}
        className="genex-publish-clip"
        src={src}
        muted
        loop
        playsInline
        aria-hidden
        onTimeUpdate={(e) => {
          const { currentTime, duration } = e.currentTarget;
          if (duration > 0) setThrough(currentTime / duration);
        }}
      />
      <span className="genex-publish-clip-track" aria-hidden>
        <span style={{ width: `${Math.round(through * 100)}%` }} />
      </span>
    </>
  );
}

/** Under the banner's shade: the clip while it shows, and the passing light while a cover is taken or made. */
export function CoverMedia({
  project,
  cover,
  show,
  clipKey,
}: {
  project: string;
  cover: PublishCover;
  show: CoverKind;
  clipKey: string | null;
}): JSX.Element {
  return (
    <>
      {show === CoverKind.Clip && <CoverClipPlayer project={project} clipKey={clipKey} />}
      {(cover.taking || cover.making) && <span className="genex-publish-beam" aria-hidden />}
    </>
  );
}

/** Over the shade: the Picture / Clip switch with a clip kept, and the arrows while the picture shows. */
export function CoverControls({
  cover,
  show,
  onShow,
  hasClip,
  asking,
}: {
  cover: PublishCover;
  show: CoverKind;
  onShow: (show: CoverKind) => void;
  hasClip: boolean;
  asking: boolean;
}): JSX.Element {
  const flipping = !asking && !cover.making && show === CoverKind.Picture;
  return (
    <>
      {hasClip && <CoverShowSwitch show={show} onShow={onShow} />}
      {flipping && <CoverFlip cover={cover} dots={!hasClip} />}
    </>
  );
}

/**
 * The pill while Studio takes the first cover, or while the agent makes another, with roughly how
 * long is left once this game's last one was timed (`took`); nothing more before that or past it.
 */
function CoverBusy({
  text,
  since = null,
  took,
}: {
  text: string;
  since?: string | null;
  took?: number | undefined;
}): JSX.Element {
  const elapsed = useElapsed(since);
  const minutes = elapsed === null ? null : coverMinutesLeft(took, elapsed * SECOND_MS);
  return (
    <span className="genex-publish-glass" role="status" data-genex-cover-busy>
      <LoaderGrid />
      {text}
      {minutes !== null && (
        <span className="genex-publish-glass-clock chat-status-shimmer">{WORDS.coverLeft(minutes)}</span>
      )}
    </span>
  );
}

/** Another's field: what the new one should show, Make, and a way back that keeps this one. */
function CoverAskForm({ onMake, onKeep }: { onMake: (want: string) => void; onKeep: () => void }): JSX.Element {
  const [want, setWant] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onMake(want);
  };
  return (
    <form className="genex-publish-ask" onSubmit={submit} data-genex-cover-ask>
      <input
        className="genex-publish-ask-field"
        aria-label={WORDS.coverWantLabel}
        placeholder={WORDS.coverWantPlaceholder}
        value={want}
        maxLength={200}
        // biome-ignore lint/a11y/noAutofocus: the field replaces the Another the person just pressed.
        autoFocus
        onChange={(e) => setWant(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onKeep();
          }
        }}
      />
      <button type="submit" className="genex-publish-ask-make">
        {WORDS.coverMake}
      </button>
      <button type="button" className="genex-publish-ask-keep" aria-label={WORDS.coverKeep} onClick={onKeep}>
        <Icon name="close" size={12} />
      </button>
    </form>
  );
}

/**
 * The banner's foot, beside the name: the busy pill, or Another cover (Another clip while the clip
 * shows). Asking opens the field in the foot's place (`asking`), so the name steps aside; Ask agent
 * sends it to the chat and closes the dialog there (`onAsked`), where the agent's work shows.
 */
export function CoverTool({
  cover,
  show,
  disabled,
  asking,
  onAsking,
  onAsked,
}: {
  cover: PublishCover;
  show: CoverKind;
  disabled: boolean;
  asking: boolean;
  onAsking: (asking: boolean) => void;
  onAsked: () => void;
}): JSX.Element | null {
  const ask = cover.ask;
  const making = cover.making;
  if (cover.taking) return <CoverBusy text={WORDS.coverTaking} />;
  if (making) {
    const text = making.kind === CoverKind.Clip ? WORDS.coverMakingClip : WORDS.coverMaking;
    return <CoverBusy text={text} since={making.since} took={making.took} />;
  }
  if (!ask || disabled) return null;
  if (asking)
    return (
      <CoverAskForm
        onKeep={() => onAsking(false)}
        onMake={(want) => {
          ask(show, want);
          onAsking(false);
          onAsked();
        }}
      />
    );
  const clip = show === CoverKind.Clip;
  return (
    <button
      type="button"
      className="genex-publish-glass"
      aria-label={clip ? WORDS.anotherClipLabel : WORDS.anotherCoverLabel}
      onClick={() => onAsking(true)}
      data-genex-another-cover={show}
    >
      <Icon name="reload" size={13} />
      {clip ? WORDS.anotherClip : WORDS.anotherCover}
    </button>
  );
}
