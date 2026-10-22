/**
 * A profile in Play, centred and at most 1080px wide: the person's live avatar, their name with
 * PRO, and beside it a pencil and Share on the account's own (the pencil opens Settings → Genex
 * account, Share its link) or the friend button on anyone else's; under it their @handle, their
 * games and players as chips, then when they joined. Then their friends as a row (people the viewer knows first), the account's own last 7
 * days (only it ever sees them), and their games as the dashboard's cards. Offline it shows what
 * was read last, and reads again once the Mac is back online.
 */
import type { JSX } from "react";
import { useEffect } from "react";
import { intlLocale } from "../../shared/i18n.ts";
import {
  FriendStatus,
  type PlayMe,
  type PlayProfile as Profile,
  type PlayProfileFriend,
} from "../../shared/play-people.ts";
import { AvatarMotion } from "../avatars/GeneratedAvatar.tsx";
import { openSettings, SettingsSection } from "../settings-navigation.ts";
import { usePeople } from "../state/hooks.ts";
import { LoadStatus } from "../state/people.ts";
import { studio } from "../state/studio.ts";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/icons.tsx";
import { useBackOnline, useOnline } from "../ui/use-online.ts";
import { PLAY_WORDS } from "../words.ts";
import { AddTone, FriendButton } from "./FriendButton.tsx";
import { PeopleCarousel, PersonTile } from "./PeopleCarousel.tsx";
import { PersonAvatar } from "./PersonAvatar.tsx";
import { PlayPageFrame } from "./PlayPageFrame.tsx";
import { ShareProfile } from "./ShareProfile.tsx";
import { OfflineNotice } from "./PlayOffline.tsx";
import { Grid, useCardRemix } from "./PlayRoom.tsx";
import { formatCount } from "./play-model.ts";
import { joinedWhen } from "./ProfilePlate.tsx";
import { StatsStrip } from "./StatsStrip.tsx";

const WORDS = PLAY_WORDS.people;
/** The header's avatar, with room for its gear. */
const HEADER_AVATAR = 123;
/** A friend's avatar on the profile's row, with room for gear. */
const FRIEND_TILE_AVATAR = 66;
/** "Mar 2026": when two people became friends, as a tile says it. */
const SINCE_FORMAT = new Intl.DateTimeFormat(intlLocale(), { month: "short", year: "numeric" });

/** A number on a chip, then its noun. */
function Chip({ value, noun, hook }: { value: number; noun: string; hook: string }): JSX.Element {
  return (
    <span className="profile-chip" data-profile-chip={hook}>
      <b>{formatCount(value)}</b>
      {noun}
    </span>
  );
}

/** Under the name: games and players (plays while genex.games does not count players), then when they joined. */
function ProfileFacts({ profile }: { profile: Profile }): JSX.Element {
  const joined = joinedWhen(profile.joinedAt);
  const games = profile.games.length;
  const plays = profile.games.reduce((sum, game) => sum + game.plays, 0);
  return (
    <div className="profile-facts">
      {games > 0 && <Chip value={games} noun={WORDS.chipGames(games)} hook="games" />}
      {games > 0 && profile.players !== null && (
        <Chip value={profile.players} noun={WORDS.chipPlayers(profile.players)} hook="players" />
      )}
      {games > 0 && profile.players === null && <Chip value={plays} noun={WORDS.chipPlays(plays)} hook="plays" />}
      {joined && <span className="profile-joined">{WORDS.joined(joined)}</span>}
    </div>
  );
}

/** The profile's head: the avatar, the name with what can be done beside it, and the facts. */
function ProfileHead({ profile, me }: { profile: Profile; me: PlayMe | null }): JSX.Element {
  const own = me?.id === profile.person.id;
  const person = own && me ? me : profile.person;
  return (
    <header className="profile-head" data-profile={person.id} data-own={own || undefined}>
      <PersonAvatar person={person} size={HEADER_AVATAR} gear motion={AvatarMotion.Live} />
      <div className="profile-name-row">
        <h1 className="profile-name">
          {person.name}
          {person.pro && <span className="profile-pro">{WORDS.proTag}</span>}
        </h1>
        {own && (
          <button
            type="button"
            className="profile-chip profile-edit"
            aria-label={WORDS.editProfile}
            title={WORDS.editProfile}
            data-profile-edit
            onClick={() => openSettings(SettingsSection.Account)}
          >
            <Icon name="rename" size={15} />
          </button>
        )}
        {own && me && <ShareProfile me={me} profile={profile} />}
        {!own && me && profile.status !== FriendStatus.Self && (
          <FriendButton person={profile.person} status={profile.status} tone={AddTone.Primary} />
        )}
      </div>
      {person.handle && (
        <span className="profile-handle" data-profile-handle>
          @{person.handle}
        </span>
      )}
      <ProfileFacts profile={profile} />
    </header>
  );
}

/** What a friend's tile says: their game, else how many games they made, else since when they are friends. */
function friendLine(friend: PlayProfileFriend): { sub: string; live: boolean } {
  if (friend.playing) return { sub: friend.playing.title, live: true };
  if (friend.games) return { sub: WORDS.games(friend.games), live: false };
  if (friend.since) return { sub: WORDS.since(SINCE_FORMAT.format(new Date(friend.since))), live: false };
  return { sub: "", live: false };
}

/** The profile's friends as a row. */
function ProfileFriends({ friends, name }: { friends: PlayProfileFriend[]; name: string | null }): JSX.Element {
  return (
    <PeopleCarousel
      title={WORDS.friends}
      note={String(friends.length)}
      label={name ? WORDS.friendsOf(name) : WORDS.friends}
      arrows={WORDS.friendsArrows(name)}
      hook={{ "data-profile-friends": "" }}
    >
      {friends.map((friend) => {
        const { sub, live } = friendLine(friend);
        return <PersonTile key={friend.id} person={friend} sub={sub} avatar={FRIEND_TILE_AVATAR} live={live} />;
      })}
    </PeopleCarousel>
  );
}

/** The profile's games, as the dashboard draws them. */
function ProfileGames({ profile, own }: { profile: Profile; own: boolean }) {
  const remix = useCardRemix();
  const title = own ? WORDS.myGames : PLAY_WORDS.shelves.games;
  return (
    <section
      className="profile-section"
      aria-label={own ? WORDS.myGames : WORDS.gamesBy(profile.person.name)}
      data-profile-games
    >
      <div className="profile-section-head">
        <h2 className="profile-section-title">{title}</h2>
        {profile.games.length > 0 && <span className="profile-section-count">{profile.games.length}</span>}
      </div>
      {profile.games.length > 0 ? (
        <Grid games={profile.games} placeholders={0} onRemix={remix} marquee />
      ) : (
        <p className="people-note">{own ? WORDS.noGamesOwn : WORDS.noGames}</p>
      )}
    </section>
  );
}

/** Someone's profile, or the account's own. */
export function PlayProfile({
  userId,
  sidebarHidden,
  onToggleSidebar,
  onNewGame,
}: {
  userId: string;
  sidebarHidden: boolean;
  onToggleSidebar: () => void;
  onNewGame: () => void;
}): JSX.Element {
  const entry = usePeople((s) => s.profiles[userId]);
  const me = usePeople((s) => s.me);
  const offline = !useOnline();
  useEffect(() => {
    void studio().people.loadProfile(userId, { force: true });
  }, [userId]);
  // Offline it shows what was read last; back online it reads again by itself.
  useBackOnline(() => void studio().people.loadProfile(userId, { force: true }));
  const profile = entry?.profile ?? null;
  const own = me?.id === userId;
  return (
    <PlayPageFrame
      label={profile?.person.name ?? WORDS.profile}
      sidebarHidden={sidebarHidden}
      onToggleSidebar={onToggleSidebar}
      onBack={() => studio().play.back()}
    >
      {!profile && offline && <OfflineNotice text={PLAY_WORDS.offline.profile} />}
      {!profile && !offline && entry?.status === LoadStatus.Failed && (
        <div className="people-note">
          {WORDS.profileFailed}
          <Button variant="secondary" onClick={() => void studio().people.loadProfile(userId, { force: true })}>
            {PLAY_WORDS.retry}
          </Button>
        </div>
      )}
      {!profile && !offline && entry?.status !== LoadStatus.Failed && <ProfilePlaceholder />}
      {profile && (
        <div className="profile-page" data-profile-page={own ? "own" : "other"}>
          <ProfileHead profile={profile} me={me} />
          {profile.friends && profile.friends.length > 0 && (
            <ProfileFriends friends={profile.friends} name={own ? null : profile.person.name} />
          )}
          {own && <StatsStrip games={profile.games} onNewGame={onNewGame} />}
          <ProfileGames profile={profile} own={own} />
        </div>
      )}
    </PlayPageFrame>
  );
}

/** A profile on its way: the round avatar and two lines. */
function ProfilePlaceholder(): JSX.Element {
  return (
    <div className="profile-head" aria-hidden="true">
      <span className="people-placeholder-avatar profile-placeholder-avatar" />
      <span className="play-bar play-bar-title" />
      <span className="play-bar play-bar-author" />
    </div>
  );
}
