/**
 * The one button a person gets, from where they stand with the account: Add friend, Request sent
 * (pressing it takes the request back), Accept request, or Friends, whose menu removes them. Busy
 * while Genex answers; a refusal is said in a toast and the button stays as it was.
 */
import type { JSX } from "react";
import { FriendAction, FriendStatus, type PlayPerson } from "../../shared/play-people.ts";
import { usePeople } from "../state/hooks.ts";
import { useOnline } from "../ui/use-online.ts";
import { studio } from "../state/studio.ts";
import { ToastTone } from "../state/toasts.ts";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../ui/dropdown-menu.tsx";
import { Icon } from "../ui/icons.tsx";
import { PLAY_WORDS } from "../words.ts";

const WORDS = PLAY_WORDS.people;

/** How Add friend is dressed: the light tint on a card, the blue fill beside a profile's name. */
export const AddTone = { Tint: "tint", Primary: "primary" } as const;
export type AddTone = (typeof AddTone)[keyof typeof AddTone];

/** Run an action on a person; a refusal is told, and what the lists show stays. */
export async function actOn(action: FriendAction, person: PlayPerson): Promise<void> {
  try {
    await studio().people.act(action, person);
  } catch {
    studio().notify(WORDS.actionFailed, ToastTone.Error);
  }
}

/** A person's relationship button; nothing for the account itself or someone out of reach. */
export function FriendButton({
  person,
  status,
  tone = AddTone.Tint,
}: {
  person: PlayPerson;
  status: FriendStatus;
  tone?: AddTone;
}): JSX.Element | null {
  const pressing = usePeople((s) => Boolean(s.busy[person.id]));
  // A press waits for the one before it, and for the connection.
  const online = useOnline();
  const busy = pressing || !online;
  if (status === FriendStatus.None)
    return (
      <button
        type="button"
        className="people-button"
        data-tone={tone}
        data-friend-button={status}
        aria-busy={pressing}
        disabled={busy}
        onClick={() => void actOn(FriendAction.Add, person)}
      >
        <Icon name="user-plus" size={15} />
        {WORDS.add}
      </button>
    );
  if (status === FriendStatus.Outgoing)
    return (
      <button
        type="button"
        className="people-button"
        data-tone="quiet"
        data-friend-button={status}
        aria-busy={pressing}
        disabled={busy}
        aria-label={WORDS.cancelRequest(person.name)}
        title={WORDS.cancelRequest(person.name)}
        onClick={() => void actOn(FriendAction.Withdraw, person)}
      >
        <Icon name="clock" size={15} />
        {WORDS.sent}
      </button>
    );
  if (status === FriendStatus.Incoming)
    return (
      <button
        type="button"
        className="people-button"
        data-tone="accept"
        data-friend-button={status}
        aria-busy={pressing}
        disabled={busy}
        onClick={() => void actOn(FriendAction.Accept, person)}
      >
        <Icon name="check" size={15} />
        {WORDS.acceptRequest}
      </button>
    );
  if (status === FriendStatus.Friends) return <FriendsMenu person={person} busy={busy} pressing={pressing} />;
  return null;
}

/**
 * A friend's ⋯: its menu removes them. Hidden on a card until the card is hovered or focused;
 * `disabled` while removing waits for the connection.
 */
export function FriendMoreMenu({
  person,
  className = "",
  disabled = false,
}: {
  person: PlayPerson;
  className?: string;
  disabled?: boolean;
}): JSX.Element {
  const busy = usePeople((s) => Boolean(s.busy[person.id]));
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={`people-more ${className}`}
          aria-label={WORDS.more(person.name)}
          aria-busy={busy}
          disabled={busy || disabled}
        >
          <Icon name="more" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={6}>
        <DropdownMenuItem className="text-red" onSelect={() => void actOn(FriendAction.Remove, person)}>
          {WORDS.remove}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Friends: pressing it opens the one thing to do about a friend, removing them; `pressing` while a press on them waits. */
function FriendsMenu({
  person,
  busy,
  pressing,
}: {
  person: PlayPerson;
  busy: boolean;
  pressing: boolean;
}): JSX.Element {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="people-button"
          data-tone="quiet"
          data-friend-button={FriendStatus.Friends}
          aria-busy={pressing}
          disabled={busy}
          aria-label={WORDS.more(person.name)}
        >
          <Icon name="check" size={15} />
          {WORDS.isFriend}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={6}>
        <DropdownMenuItem className="text-red" onSelect={() => void actOn(FriendAction.Remove, person)}>
          {WORDS.remove}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
