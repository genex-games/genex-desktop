/**
 * Top creators at the top of Play's Games: the same row as a profile's friends, each creator with
 * their games and the hours people played them over the last 30 days ("this month"), ranked by
 * `creatorScore`. Read once; while the read is on its way the row holds its place with tiles of
 * the same size, so nothing under it moves; while genex.games does not rank creators the row is
 * not there.
 */
import type { JSX } from "react";
import { useEffect } from "react";
import { LoadStatus } from "../state/people.ts";
import { usePeople } from "../state/hooks.ts";
import { studio } from "../state/studio.ts";
import { PLAY_WORDS } from "../words.ts";
import { PeopleCarousel, PersonTile } from "./PeopleCarousel.tsx";
import { formatCount } from "./play-model.ts";

const WORDS = PLAY_WORDS.creators;
/** A creator's avatar, with room for gear; a placeholder's face matches it in `people.css`. */
const TILE_AVATAR = 68;
/** Tiles drawn while the row loads: more than a wide window shows, so the row reads as full. */
const PLACEHOLDER_TILES = 10;
/** Holds a text line's height around a placeholder bar. */
const NBSP = " ";

/** Play's Top creators row; placeholders while it loads, nothing while there is nobody to show. */
export function TopCreators(): JSX.Element | null {
  const creators = usePeople((s) => s.creators.list);
  const status = usePeople((s) => s.creators.status);
  useEffect(() => {
    void studio().people.loadCreators();
  }, []);
  const waiting = status === LoadStatus.Idle || status === LoadStatus.Loading;
  if (!creators && waiting) return <CreatorsPlaceholder />;
  if (!creators || creators.length === 0) return null;
  return (
    <PeopleCarousel
      title={WORDS.title}
      note={WORDS.period}
      quiet
      label={WORDS.title}
      hook={{ "data-top-creators": "" }}
    >
      {creators.map((creator) => (
        <PersonTile
          key={creator.id}
          person={creator}
          avatar={TILE_AVATAR}
          sub={WORDS.line(creator.games, formatCount(Math.round(creator.hours)))}
        />
      ))}
    </PeopleCarousel>
  );
}

/** The row while genex.games answers: its heading, and tiles the size of a creator's. */
function CreatorsPlaceholder(): JSX.Element {
  return (
    <PeopleCarousel
      title={WORDS.title}
      note={WORDS.period}
      quiet
      label={WORDS.title}
      hook={{ "data-top-creators": "loading" }}
    >
      {Array.from({ length: PLACEHOLDER_TILES }, (_, tile) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: placeholders are identical and only counted
        <span key={tile} className="person-tile person-tile-placeholder" aria-hidden="true">
          <span className="people-placeholder-avatar" />
          <span className="person-tile-name">
            <span className="play-bar" />
            {NBSP}
          </span>
          <span className="person-tile-sub">
            <span className="play-bar" />
            {NBSP}
          </span>
        </span>
      ))}
    </PeopleCarousel>
  );
}
