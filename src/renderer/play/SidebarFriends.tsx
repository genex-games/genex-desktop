/**
 * The friends under the games in the sidebar, in Play and in Create, as genex.games lists them in
 * its rail: the word Friends (which opens the Friends page; the requests waiting follow its ↗),
 * then each friend, their game on one green line while they play. A row opens the friend's
 * profile; a friend who is playing offers Join on hover. A friend who is not in a game is just a
 * name: there is no online or offline. A Pro friend's row lights up with their nameplate under the
 * pointer, the first one their account draws (a plate rolled on their Mac stays theirs). Signed out there is no block; with nobody yet, the word alone.
 */
import type { JSX } from "react";
import { useMemo, useState } from "react";
import { plateRecipe } from "../../shared/plate-recipe.ts";
import { Nameplate } from "../nameplate/Nameplate.tsx";
import type { PlayFriend } from "../../shared/play-people.ts";
import { usePeople, usePlay } from "../state/hooks.ts";
import { sidebarFriends, waitingRequests } from "../state/people.ts";
import { PlayPage } from "../state/play.ts";
import { studio } from "../state/studio.ts";
import { Icon } from "../ui/icons.tsx";
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

/** Friends under the games; nothing while signed out. `onPlayMode` brings Play up for the page it opens. */
export function SidebarFriends({ onPlayMode }: { onPlayMode: (play: boolean) => void }): JSX.Element | null {
  const online = useOnline();
  const me = usePeople((s) => s.me);
  const page = usePeople((s) => s.friends);
  const waiting = usePeople(waitingRequests);
  const friends = useMemo(() => sidebarFriends({ me, friends: page }, online), [me, page, online]);
  const friendsShown = usePlay((s) => s.view.page === PlayPage.Friends);
  // Scrolled, the rows fade out under the heading, as the games do under the chrome above them.
  const [scrolled, setScrolled] = useState(false);
  if (!friends) return null;
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
      <button
        type="button"
        className="sidebar-friends-heading"
        data-play-friends=""
        aria-label={WORDS.friendsLabel(waiting)}
        aria-current={friendsShown ? "page" : undefined}
        onClick={openFriends}
      >
        <span>{WORDS.friends}</span>
        <Icon name="arrow-up-right" size={13} className="sidebar-friends-arrow" />
        {waiting > 0 && (
          <span className="sidebar-badge" aria-hidden="true">
            {waiting}
          </span>
        )}
      </button>
      {friends.length > 0 && (
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
      )}
    </section>
  );
}
