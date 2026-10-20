/**
 * One game on the dashboard, as genex.games draws it: the 16:9 cover (pressing it plays) with its
 * five-second clip running over it while hovered, or by itself in the Games feed's first row
 * (`CoverClip.tsx`), its players now and its plays over the cover's corner, the title, who made it,
 * and Remix when its source is public. The game's owner and Genex admins also get its ⋯ menu
 * (`card-menu/`). A card still on its way is the same shape with nothing in it.
 */
import type { CSSProperties, JSX, MouseEvent } from "react";
import { memo, useEffect, useId, useRef, useState } from "react";
import { playCardMenu } from "../../shared/play-manage.ts";
import type { PlayGame } from "../../shared/play.ts";
import { usePeople, usePlay, useShallow } from "../state/hooks.ts";
import { studio } from "../state/studio.ts";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/icons.tsx";
import { PLAY_WORDS } from "../words.ts";
import { CardMenu } from "./card-menu/CardMenu.tsx";
import { claimHoverClip, releaseHoverClip } from "./clip-playback.ts";
import { CoverClip } from "./CoverClip.tsx";
import { CardBadge, cardBadge } from "./native-model.ts";
import { CardNativeBadge } from "./NativeBadge.tsx";
import { createShownCovers, formatCount } from "./play-model.ts";

const WORDS = PLAY_WORDS;

/** Where a cover's picture stands. */
const CoverState = { Loading: "loading", Shown: "shown", Failed: "failed" } as const;
type CoverState = (typeof CoverState)[keyof typeof CoverState];

/** The covers this window has shown: Play opened again draws them at once rather than fading them in. */
const SHOWN_COVERS = createShownCovers();

/** Whether `src` was shown before in this window. */
const shownBefore = (src: string | null): boolean => src !== null && SHOWN_COVERS.has(src);

/**
 * The cover: the picture fades in once loaded, or shows at once when this window has shown it
 * before; a missing or broken one leaves the plain tile. It loads as soon as its card is made, not
 * when it nears the screen, so a page's covers are there before they are scrolled to.
 */
function Cover({ src, onShown }: { src: string | null; onShown: () => void }): JSX.Element | null {
  const [state, setState] = useState<CoverState>(() => (shownBefore(src) ? CoverState.Shown : CoverState.Loading));
  if (!src || state === CoverState.Failed) return null;
  return (
    <img
      className="play-card-image"
      src={src}
      alt=""
      draggable={false}
      decoding="async"
      data-shown={state === CoverState.Shown || undefined}
      onLoad={() => {
        SHOWN_COVERS.add(src);
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
    // The observer's first call measures once the title is laid out, never forcing a layout mid-commit.
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

/** The card menu the signed-in account gets on `game`: its owner's items, an admin's, or none. */
function useCardMenu(game: PlayGame) {
  const accountId = usePeople((s) => s.me?.id ?? null);
  const isAdmin = usePeople((s) => s.me?.isAdmin === true);
  // A search's card carries no curation to read its menu from, so it gets none.
  if (!game.curation || !accountId) return null;
  return playCardMenu(game, { accountId, isAdmin });
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
  const [coverShown, setCoverShown] = useState(() => shownBefore(game.coverUrl));
  const clip = game.clipUrl;
  // The pointer or focus on the cover asks for its clip; the store decides when it loads.
  const hover = clip ? () => claimHoverClip(clipKey) : undefined;
  const leave = clip ? () => releaseHoverClip(clipKey) : undefined;
  // One remix at a time: this card's says so, and every Remix waits for it.
  const making = usePlay((s) => s.making?.slug ?? null);
  const remixing = making === game.slug;
  const menu = useCardMenu(game);
  // Only this game's install and download: a card redraws when they change, not when another's do.
  const native = usePlay(
    useShallow((s) => ({
      host: s.installs.host,
      installed: s.installs.installed.find((one) => one.slug === game.slug) ?? null,
      progress: s.installs.progress.find((one) => one.slug === game.slug) ?? null,
    })),
  );
  const installed = native.installed;
  const badge = cardBadge(game, {
    host: native.host,
    installed: installed ? [installed] : [],
    progress: native.progress ? [native.progress] : [],
  });
  // An installed game's card gets the ⋯ for anyone: Show in Finder and Remove from this Mac.
  const hasMenu = menu !== null || installed !== null;
  const [menuOpen, setMenuOpen] = useState(false);
  // A right-click anywhere on a card with a menu opens it, as the ⋯ does; one inside a dialog the
  // menu opened (a portal, so its events still reach the card through React) is the dialog's own.
  const contextMenu = hasMenu
    ? (event: MouseEvent<HTMLElement>) => {
        if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return;
        event.preventDefault();
        setMenuOpen(true);
      }
    : undefined;
  return (
    <article
      className="play-card"
      data-play-game={game.slug}
      data-menu-open={menuOpen || undefined}
      onContextMenu={contextMenu}
    >
      {/* The pointer anywhere on the cover, its ⋯ included, keeps the clip playing. */}
      <div className="play-card-frame" onPointerEnter={hover} onPointerLeave={leave}>
        <button
          type="button"
          className="play-card-cover"
          aria-label={WORDS.play(game.title)}
          ref={cover}
          onClick={() => onPlay(game)}
          onFocus={hover}
          onBlur={leave}
        >
          <Cover src={game.coverUrl} onShown={() => setCoverShown(true)} />
          {clip && (
            <CoverClip
              clipKey={clipKey}
              url={clip}
              ready={coverShown}
              autoplay={autoplay}
              index={index}
              anchor={cover}
            />
          )}
          <span className="play-card-shade" aria-hidden="true" />
          {badge?.kind !== CardBadge.Downloading && <Stats game={game} />}
          {badge && <CardNativeBadge badge={badge} />}
        </button>
        {hasMenu && (
          <CardMenu game={game} menu={menu} installed={installed} open={menuOpen} onOpenChange={setMenuOpen} />
        )}
      </div>
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
