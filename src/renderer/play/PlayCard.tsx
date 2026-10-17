/**
 * One game on the dashboard, as genex.games draws it: the 16:9 cover (pressing it plays) with its
 * five-second clip running over it while hovered, or by itself in the Games feed's first row
 * (`CoverClip.tsx`), its players now and its plays over the cover's corner, the title, who made it,
 * and Remix when its source is public. A card still on its way is the same shape with nothing in it.
 */
import type { CSSProperties, JSX } from "react";
import { memo, useEffect, useId, useRef, useState } from "react";
import type { PlayGame } from "../../shared/play.ts";
import { usePlay } from "../state/hooks.ts";
import { studio } from "../state/studio.ts";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/icons.tsx";
import { PLAY_WORDS } from "../words.ts";
import { claimHoverClip, releaseHoverClip } from "./clip-playback.ts";
import { CoverClip } from "./CoverClip.tsx";
import { formatCount } from "./play-model.ts";

const WORDS = PLAY_WORDS;

/** Where a cover's picture stands. */
const CoverState = { Loading: "loading", Shown: "shown", Failed: "failed" } as const;
type CoverState = (typeof CoverState)[keyof typeof CoverState];

/** The cover: the picture fades in once decoded; a missing or broken one leaves the plain tile. */
function Cover({ src, onShown }: { src: string | null; onShown: () => void }): JSX.Element | null {
  const [state, setState] = useState<CoverState>(CoverState.Loading);
  if (!src || state === CoverState.Failed) return null;
  return (
    <img
      className="play-card-image"
      src={src}
      alt=""
      draggable={false}
      loading="lazy"
      decoding="async"
      data-shown={state === CoverState.Shown || undefined}
      onLoad={() => {
        setState(CoverState.Shown);
        onShown();
      }}
      onError={() => setState(CoverState.Failed)}
    />
  );
}

/** Players now (multiplayer games with someone in them) and plays so far. */
function Stats({ game }: { game: PlayGame }): JSX.Element {
  const online = game.online ?? 0;
  return (
    <span className="play-card-stats">
      {online > 0 && (
        <span className="play-card-online" aria-label={WORDS.online(online)}>
          <span className="play-card-dot" aria-hidden="true" />
          {formatCount(online)}
        </span>
      )}
      <span aria-label={WORDS.plays(formatCount(game.plays))}>
        <Icon name="play" size={12} className="play-card-play" />
        {formatCount(game.plays)}
      </span>
    </span>
  );
}

/** A space a title scrolled past its card's edge leaves before it turns back, in pixels. */
const MARQUEE_TAIL = 20;

/**
 * A title that does not fit scrolls back and forth (a profile's cards); one that fits stays put.
 * The overflow is measured again whenever the card changes size.
 */
function MarqueeTitle({ title }: { title: string }): JSX.Element {
  const box = useRef<HTMLHeadingElement>(null);
  const [overflow, setOverflow] = useState(0);
  useEffect(() => {
    const element = box.current;
    const text = element?.firstElementChild;
    if (!element || !(text instanceof HTMLElement)) return;
    const measure = () => setOverflow(Math.max(0, text.scrollWidth - element.clientWidth));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const running = overflow > 2;
  return (
    <h3
      ref={box}
      className="play-card-title"
      title={title}
      data-marquee={running || undefined}
      style={running ? ({ "--marquee": `${-(overflow + MARQUEE_TAIL)}px` } as CSSProperties) : undefined}
    >
      <span className="play-card-title-text">{title}</span>
    </h3>
  );
}

/** Who made the game; their name opens their profile when the gallery named their account. */
function Author({ author }: { author: PlayGame["author"] }): JSX.Element {
  const { id } = author;
  if (!id) return <p className="play-card-author">{WORDS.by(author.name)}</p>;
  return (
    <p className="play-card-author">
      <button type="button" className="play-card-author-link" onClick={() => studio().play.showProfile(id)}>
        {WORDS.by(author.name)}
      </button>
    </p>
  );
}

/** One game on the dashboard; pressing its cover plays it. */
export const PlayCard = memo(function PlayCard({
  game,
  onPlay,
  onRemix,
  showAuthor = true,
  marquee = false,
  autoplay = false,
  index = 0,
}: {
  game: PlayGame;
  onPlay: (game: PlayGame) => void;
  onRemix: (game: PlayGame) => void;
  /** Whether the card says who made it. */
  showAuthor?: boolean;
  /** A title too long for the card scrolls back and forth instead of being cut off (a profile's cards). */
  marquee?: boolean;
  /** A card of the Games feed's first row: its clip plays by itself. */
  autoplay?: boolean;
  /** The card's place in its grid: when its clip may start. */
  index?: number;
}): JSX.Element {
  const clipKey = useId();
  const cover = useRef<HTMLButtonElement>(null);
  const [coverShown, setCoverShown] = useState(false);
  const clip = game.clipUrl;
  // The pointer or focus on the cover asks for its clip; the store decides when it loads.
  const hover = clip ? () => claimHoverClip(clipKey) : undefined;
  const leave = clip ? () => releaseHoverClip(clipKey) : undefined;
  // One remix at a time: this card's says so, and every Remix waits for it.
  const making = usePlay((s) => s.making?.slug ?? null);
  const remixing = making === game.slug;
  return (
    <article className="play-card" data-play-game={game.slug}>
      <button
        type="button"
        className="play-card-cover"
        aria-label={WORDS.play(game.title)}
        ref={cover}
        onClick={() => onPlay(game)}
        onPointerEnter={hover}
        onPointerLeave={leave}
        onFocus={hover}
        onBlur={leave}
      >
        <Cover src={game.coverUrl} onShown={() => setCoverShown(true)} />
        {clip && (
          <CoverClip clipKey={clipKey} url={clip} ready={coverShown} autoplay={autoplay} index={index} anchor={cover} />
        )}
        <span className="play-card-shade" aria-hidden="true" />
        <Stats game={game} />
      </button>
      <div className="play-card-meta">
        <div className="min-w-0 flex-1">
          {marquee ? (
            <MarqueeTitle title={game.title} />
          ) : (
            <h3 className="play-card-title" title={game.title}>
              {game.title}
            </h3>
          )}
          {showAuthor && game.author.name && <Author author={game.author} />}
        </div>
        {game.remixable && (
          <Button
            variant="secondary"
            className="play-card-remix"
            aria-label={WORDS.remixLabel(game.title)}
            disabled={making !== null}
            onClick={() => onRemix(game)}
          >
            <Icon name="remix" size={14} />
            {remixing ? WORDS.remixing : WORDS.remix}
          </Button>
        )}
      </div>
    </article>
  );
});

/** A card still on its way: the cover's tile and the title's and author's lines, shimmering. */
export function PlayCardPlaceholder(): JSX.Element {
  return (
    <div className="play-card play-card-placeholder" aria-hidden="true">
      <span className="play-card-cover" />
      <span className="play-card-meta">
        <span className="play-bar play-bar-title" />
        <span className="play-bar play-bar-author" />
      </span>
    </div>
  );
}
