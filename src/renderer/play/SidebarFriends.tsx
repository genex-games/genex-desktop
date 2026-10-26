/**
 * The friends at the sidebar's foot, on the account plate, in Play and in Create, as genex.games
 * lists them in its rail: the word Friends with the requests waiting after it (it opens the Friends
 * page, its ↗ last), a chevron that folds them to that one line and back (remembered on this Mac),
 * then each friend, their game on one green line while they play. A row opens the friend's
 * profile; a friend who is playing offers Join on hover. A friend who is not in a game is just a
 * name: there is no online or offline. A Pro friend's row lights up with their nameplate under the
 * pointer, the first one their account draws (a plate rolled on their Mac stays theirs). Signed out there is no block; with nobody yet, the word alone.
 */
import type { JSX } from "react";
import { useId, useMemo, useState } from "react";
import { plateRecipe } from "../../shared/plate-recipe.ts";
import { Nameplate } from "../nameplate/Nameplate.tsx";
import type { PlayFriend } from "../../shared/play-people.ts";
import { usePeople, usePlay } from "../state/hooks.ts";
import { sidebarFriends, waitingRequests } from "../state/people.ts";
import { PlayPage } from "../state/play.ts";
import { studio } from "../state/studio.ts";
import { readText, removeKey, STORAGE_KEYS, writeText } from "../storage.ts";
import { Icon } from "../ui/icons.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip.tsx";
import { useOnline } from "../ui/use-online.ts";
import { PLAY_WORDS } from "../words.ts";
import { joinFriend, PersonName, RingedAvatar } from "./FriendCard.tsx";

const WORDS = PLAY_WORDS.people;
/** A friend's face in the sidebar: the size of a game's picture beside it. */
const ROW_AVATAR = 28;

/** One friend: their face and name, and the game they are in. */
function FriendRow({
  friend,
  online,
  onOpen,
}: {
  friend: PlayFriend;
  online: boolean;
  onOpen: (id: string) => void;
}): JSX.Element {
  const { playing } = friend;
  const plate = useMemo(
    () => (friend.pro ? plateRecipe(friend.id, 0, friend.avatarVariant) : null),
    [friend.id, friend.pro, friend.avatarVariant],
  );
  const row = (
    <>
      <button
        type="button"
        className="sidebar-game-select sidebar-friend-open"
        title={playing ? `${friend.name} · ${playing.title}` : friend.name}
        aria-label={WORDS.openProfile(friend.name)}
        onClick={() => onOpen(friend.id)}
      >
        <RingedAvatar person={friend} size={ROW_AVATAR} live={playing !== null} />
        <span className="sidebar-friend-who">
          <PersonName person={friend} className="sidebar-friend-name" />
          {playing && (
            <span className="sidebar-friend-playing">
              <Icon name="gamepad" size={12} />
              <span className="truncate">{playing.title}</span>
            </span>
          )}
        </span>
      </button>
      {playing && online && (
        <button
          type="button"
          className="sidebar-friend-join"
          aria-label={WORDS.joinLabel(friend.name, playing.title)}
          onClick={() => joinFriend(friend)}
        >
          {WORDS.join}
        </button>
      )}
    </>
  );
  return (
    <div className="sidebar-game sidebar-friend" data-sidebar-friend={friend.id} data-avatar-host>
      {plate ? (
        <Nameplate recipe={plate} className="nameplate-friend" sparkles={false} hover>
          {row}
        </Nameplate>
      ) : (
        row
      )}
    </div>
  );
}

/** Whether the friends were last left folded on this Mac. */
const readFolded = (): boolean => readText(STORAGE_KEYS.sidebarFriendsFolded) === "1";

/** Remembers the friends folded, or forgets it once they are open again. */
function rememberFolded(folded: boolean): void {
  if (folded) writeText(STORAGE_KEYS.sidebarFriendsFolded, "1");
  else removeKey(STORAGE_KEYS.sidebarFriendsFolded);
}

/** The chevron that folds the friends to their heading and opens them again. */
function FoldButton({
  folded,
  controls,
  onToggle,
}: {
  folded: boolean;
  controls: string;
  onToggle: () => void;
}): JSX.Element {
  const label = folded ? WORDS.showFriends : WORDS.hideFriends;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="sidebar-friends-fold"
          data-sidebar-friends-fold=""
          aria-label={label}
          aria-expanded={!folded}
          aria-controls={controls}
          onClick={onToggle}
        >
          <Icon name="chevron-down" size={16} />
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** Friends on the account plate; nothing while signed out. `onPlayMode` brings Play up for the page it opens. */
export function SidebarFriends({ onPlayMode }: { onPlayMode: (play: boolean) => void }): JSX.Element | null {
  const online = useOnline();
  const me = usePeople((s) => s.me);
  const page = usePeople((s) => s.friends);
  const waiting = usePeople(waitingRequests);
  const friends = useMemo(() => sidebarFriends({ me, friends: page }, online), [me, page, online]);
  const friendsShown = usePlay((s) => s.view.page === PlayPage.Friends);
  // Scrolled, the rows fade out under the heading, as the games do under the chrome above them.
  const [scrolled, setScrolled] = useState(false);
  const [folded, setFolded] = useState(readFolded);
  const listId = useId();
  if (!friends) return null;
  const toggleFolded = (): void => {
    rememberFolded(!folded);
    setFolded(!folded);
  };
  const openFriends = (): void => {
    onPlayMode(true);
    studio().play.showFriends();
  };
  const openProfile = (id: string): void => {
    onPlayMode(true);
    studio().play.showProfile(id);
  };
  return (
    <section className="sidebar-friends" aria-label={WORDS.friends} data-sidebar-friends>
      <div className="sidebar-friends-head">
        <button
          type="button"
          className="sidebar-friends-heading"
          data-play-friends=""
          aria-label={WORDS.friendsLabel(waiting)}
          aria-current={friendsShown ? "page" : undefined}
          onClick={openFriends}
        >
          <span>{WORDS.friends}</span>
          {waiting > 0 && (
            <span className="sidebar-badge" aria-hidden="true">
              {waiting}
            </span>
          )}
          <Icon name="arrow-up-right" size={13} className="sidebar-friends-arrow" />
        </button>
        {friends.length > 0 && <FoldButton folded={folded} controls={listId} onToggle={toggleFolded} />}
      </div>
      {friends.length > 0 && (
        <div className="sidebar-friends-body" id={listId} data-folded={folded} inert={folded}>
          <div className="sidebar-friends-list" data-scrolled={scrolled}>
            <div
              className="sidebar-scroll sidebar-friends-scroll"
              onScroll={(event) => setScrolled(event.currentTarget.scrollTop > 0)}
            >
              <div className="sidebar-games">
                {friends.map((friend) => (
                  <FriendRow key={friend.id} friend={friend} online={online} onOpen={openProfile} />
                ))}
              </div>
            </div>
            <span className="sidebar-fade" aria-hidden="true" />
          </div>
        </div>
      )}
    </section>
  );
}
