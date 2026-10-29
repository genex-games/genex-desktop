/**
 * A person as the Friends page shows them: their big avatar (which opens their profile) with the
 * name under it, a line on what they are up to, and what can be done. One component in five states:
 * a friend (⋯ removes them), a friend playing now (a green ring and dot, their game, Join), a request
 * waiting (Accept, ✕), a request sent (Cancel), and someone a search found (their friend button).
 * Offline, what a card can do waits for the connection.
 */
import type { JSX, ReactNode } from "react";
import {
  FriendAction,
  type PlayFoundPerson,
  type PlayFriend,
  type PlayFriendRequest,
  type PlayPerson,
} from "../../shared/play-people.ts";
import { usePeople } from "../state/hooks.ts";
import { studio } from "../state/studio.ts";
import { Icon } from "../ui/icons.tsx";
import { PLAY_WORDS } from "../words.ts";
import { actOn, FriendButton, FriendMoreMenu } from "./FriendButton.tsx";
import { PersonAvatar } from "./PersonAvatar.tsx";

const WORDS = PLAY_WORDS.people;
/** The avatar's size on a card. */
const CARD_AVATAR = 72;

/** Which state a card shows. Its `data-friend-card` value. */
export const FriendCardKind = {
  Friend: "friend",
  Playing: "playing",
  Request: "request",
  Sent: "sent",
  Found: "found",
} as const;
export type FriendCardKind = (typeof FriendCardKind)[keyof typeof FriendCardKind];

/** A card's person, what its kind needs of them, and whether its presses wait for the connection. */
export type FriendCardProps = (
  | { kind: typeof FriendCardKind.Friend | typeof FriendCardKind.Playing; person: PlayFriend }
  | { kind: typeof FriendCardKind.Request | typeof FriendCardKind.Sent; person: PlayFriendRequest }
  | { kind: typeof FriendCardKind.Found; person: PlayFoundPerson }
) & { offline?: boolean };

/** Join a friend: their game opens in the viewer, as a card would open it. */
export function joinFriend(friend: PlayFriend): void {
  if (friend.playing)
    void studio().play.open({ slug: friend.playing.slug, title: friend.playing.title, coverUrl: null });
}

/** The line under a friend's name: how many games they made, when genex.games says. */
const gamesLine = (games: number | null): string => (games === null ? "" : WORDS.games(games));

/** The line under the name, by state. */
function subLine(props: FriendCardProps): string {
  switch (props.kind) {
    case FriendCardKind.Playing:
      return props.person.playing?.title ?? "";
    case FriendCardKind.Request:
      return WORDS.wantsToBeFriends;
    case FriendCardKind.Sent:
      return WORDS.sent;
    default:
      return gamesLine(props.person.games);
  }
}

/**
 * What can be done from the card, by state; a friend's only action is behind ⋯, so it has none here.
 * A press waits for the one before it on this person, and every press waits offline.
 */
function Actions(props: FriendCardProps): JSX.Element | null {
  const { person } = props;
  const pressing = usePeople((s) => Boolean(s.busy[person.id]));
  const waits = props.offline === true || pressing;
  if (props.kind === FriendCardKind.Playing)
    return (
      <button
        type="button"
        className="people-button"
        data-tone="tint"
        aria-label={WORDS.joinLabel(person.name, props.person.playing?.title ?? "")}
        onClick={() => joinFriend(props.person)}
      >
        <Icon name="play" size={12} className="people-play-glyph" />
        {WORDS.join}
      </button>
    );
  if (props.kind === FriendCardKind.Request)
    return (
      <>
        <button
          type="button"
          className="people-button"
          data-tone="accept"
          disabled={waits}
          onClick={() => void actOn(FriendAction.Accept, person)}
        >
          {WORDS.accept}
        </button>
        <button
          type="button"
          className="people-button people-button-icon"
          aria-label={WORDS.decline(person.name)}
          disabled={waits}
          onClick={() => void actOn(FriendAction.Withdraw, person)}
        >
          <Icon name="close" />
        </button>
      </>
    );
  if (props.kind === FriendCardKind.Sent)
    return (
      <button
        type="button"
        className="people-button"
        data-tone="quiet"
        aria-label={WORDS.cancelRequest(person.name)}
        disabled={waits}
        onClick={() => void actOn(FriendAction.Withdraw, person)}
      >
        {WORDS.cancel}
      </button>
    );
  if (props.kind === FriendCardKind.Found) return <FriendButton person={props.person} status={props.person.status} />;
  return null;
}

/** A person's name with their Pro tag. */
export function PersonName({ person, className }: { person: PlayPerson; className: string }): JSX.Element {
  return (
    <span className={className}>
      <span className="people-name-text">{person.name}</span>
      {person.pro && <span className="people-pro">{WORDS.proTag}</span>}
    </span>
  );
}

/** A person's avatar with the ring their state wears: green while playing, blue for Pro. */
export function RingedAvatar({
  person,
  size,
  live,
  gear = false,
  children,
}: {
  person: PlayPerson;
  size: number;
  live: boolean;
  gear?: boolean;
  children?: ReactNode;
}): JSX.Element {
  return (
    <span
      className="people-avatar"
      data-live={live || undefined}
      data-pro={(!live && person.pro) || undefined}
      data-gear={gear || undefined}
    >
      <PersonAvatar person={person} size={size} gear={gear} />
      {live && <span className="people-live-dot" aria-hidden="true" />}
      {children}
    </span>
  );
}

/** One person's card. */
export function FriendCard(props: FriendCardProps): JSX.Element {
  const { person, kind } = props;
  const live = kind === FriendCardKind.Playing;
  return (
    <article className="friend-card" data-friend-card={kind} data-person={person.id} data-avatar-host>
      {kind === FriendCardKind.Friend && (
        <FriendMoreMenu person={person} className="friend-card-more" disabled={props.offline} />
      )}
      <button
        type="button"
        className="friend-card-open"
        aria-label={WORDS.openProfile(person.name)}
        onClick={() => studio().play.showProfile(person.id)}
      >
        <RingedAvatar person={person} size={CARD_AVATAR} live={live} />
      </button>
      <PersonName person={person} className="friend-card-name" />
      <span className="friend-card-sub" data-live={live || undefined}>
        {subLine(props)}
      </span>
      {kind !== FriendCardKind.Friend && (
        <div className="friend-card-actions">
          <Actions {...props} />
        </div>
      )}
    </article>
  );
}
