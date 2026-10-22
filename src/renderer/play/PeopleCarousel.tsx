/**
 * A row of people that scrolls sideways (a profile's friends, Play's Top creators): a title with its
 * count or period beside it, arrows on the right, and small cards, each an avatar with its gear, the
 * name and one line, that open the person's profile.
 */
import type { JSX, ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { PlayPerson } from "../../shared/play-people.ts";
import { studio } from "../state/studio.ts";
import { Icon } from "../ui/icons.tsx";
import { prefersReducedMotion } from "../ui/media-queries.ts";
import { PLAY_WORDS } from "../words.ts";
import { PersonName, RingedAvatar } from "./FriendCard.tsx";

const WORDS = PLAY_WORDS.people;
/** An arrow scrolls this share of the row's width. */
const PAGE_SHARE = 0.85;
/** Scrolled within this many pixels of an end counts as at it. */
const END_SLOP = 2;

/** Which ways the row can still scroll. */
interface Ends {
  back: boolean;
  forward: boolean;
}

/** Where the rail stands, read again as it scrolls or resizes. */
function useEnds(rail: { current: HTMLDivElement | null }): [Ends, () => void] {
  const [ends, setEnds] = useState<Ends>({ back: false, forward: false });
  const measure = useCallback(() => {
    const element = rail.current;
    if (!element) return;
    const back = element.scrollLeft > END_SLOP;
    const forward = element.scrollLeft + element.clientWidth < element.scrollWidth - END_SLOP;
    setEnds((before) => (before.back === back && before.forward === forward ? before : { back, forward }));
  }, [rail]);
  useEffect(() => {
    const element = rail.current;
    if (!element) return;
    // The observer's first call measures once the row is laid out, never forcing a layout mid-commit.
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [rail, measure]);
  return [ends, measure];
}

/** A titled row of tiles with its arrows. */
export function PeopleCarousel({
  title,
  note,
  quiet = false,
  label,
  arrows,
  hook,
  children,
}: {
  title: string;
  /** What sits beside the title: a count, or the period the row covers; none when the title says it. */
  note?: string;
  /** The title set small and mono like a note: a row that labels itself rather than heads the page. */
  quiet?: boolean;
  /** The row's accessible name. */
  label: string;
  /** The arrows' names: what each scrolls to. */
  arrows: { previous: string; next: string };
  /** The section's `data-*` hook. */
  hook: Record<`data-${string}`, string>;
  children: ReactNode;
}): JSX.Element {
  const rail = useRef<HTMLDivElement>(null);
  const [ends, measure] = useEnds(rail);
  const page = (direction: 1 | -1) => {
    const element = rail.current;
    if (!element) return;
    const behavior = prefersReducedMotion() ? "auto" : "smooth";
    element.scrollBy({ left: direction * element.clientWidth * PAGE_SHARE, behavior });
  };
  return (
    <section className="people-carousel" aria-label={label} {...hook}>
      <div className="people-carousel-head">
        <h2 className="people-carousel-title" data-quiet={quiet || undefined}>
          {title}
        </h2>
        {note && <span className="people-carousel-note">{note}</span>}
        {(ends.back || ends.forward) && (
          <span className="people-carousel-arrows">
            <button
              type="button"
              className="people-arrow"
              aria-label={arrows.previous}
              disabled={!ends.back}
              onClick={() => page(-1)}
            >
              <Icon name="chevron-left" />
            </button>
            <button
              type="button"
              className="people-arrow"
              aria-label={arrows.next}
              disabled={!ends.forward}
              onClick={() => page(1)}
            >
              <Icon name="chevron-right" />
            </button>
          </span>
        )}
      </div>
      <div ref={rail} className="people-rail" data-more={ends.forward || undefined} onScroll={measure}>
        {children}
      </div>
    </section>
  );
}

/** One person on a row: their avatar (green while playing), name and a line; it opens their profile. */
export function PersonTile({
  person,
  sub,
  avatar,
  live = false,
}: {
  person: PlayPerson;
  sub: string;
  /** The avatar's side in pixels, with room for gear. */
  avatar: number;
  /** In a game right now: the line is the game, in green, after a play mark. */
  live?: boolean;
}): JSX.Element {
  return (
    <button
      type="button"
      className="person-tile"
      data-person={person.id}
      data-avatar-host
      aria-label={live ? WORDS.playingLabel(person.name, sub) : WORDS.tileLabel(person.name, sub)}
      onClick={() => studio().play.showProfile(person.id)}
    >
      <RingedAvatar person={person} size={avatar} live={live} gear />
      <PersonName person={person} className="person-tile-name" />
      <span className="person-tile-sub" data-live={live || undefined}>
        {live && <Icon name="play" size={10} className="people-play-glyph" />}
        <span className="person-tile-sub-text">{sub}</span>
      </span>
    </button>
  );
}
