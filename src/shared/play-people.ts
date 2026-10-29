/**
 * Play's people: the Genex account the app is signed in as, other people's public profiles, and
 * friends, read from genex.games by main (the API answers only its own origins). These are the
 * shapes and names both sides share. Nobody's email crosses here, and a friend's game shows only
 * when that friend lets friends see it (the API applies that rule itself).
 */
import type { PlayGame } from "./play.ts";

/** A person as every Play surface shows one. */
export interface PlayPerson {
  id: string;
  name: string;
  /**
   * Their nickname, which is also their profile's address (`genex.games/@<handle>`); null while
   * genex.games has not given them one (or does not know handles yet): links then use their id.
   */
  handle: string | null;
  /**
   * The photo they chose as their avatar, on a host the app loads images from; null draws their
   * generated avatar (`avatar-recipe.ts`), which every account has.
   */
  imageUrl: string | null;
  /** Which generated avatar is theirs: 0 is the one their id gives, another a regenerated one. */
  avatarVariant: number;
  /** They hold Genex Pro. */
  pro: boolean;
}

/** What a person's avatar is: the one generated from their id, or a photo they uploaded. Wire values. */
export const AvatarStyle = { Generated: "generated", Photo: "photo" } as const;
export type AvatarStyle = (typeof AvatarStyle)[keyof typeof AvatarStyle];

/** Whether a value is one of the two avatar styles. */
export const isAvatarStyle = (value: unknown): value is AvatarStyle =>
  value === AvatarStyle.Generated || value === AvatarStyle.Photo;

/** The account Play is signed in as. */
export interface PlayMe extends PlayPerson {
  /** When the account was made (ISO), or null when the API did not say. */
  joinedAt: string | null;
  /** The avatar the account chose, or null while genex.games does not store the choice yet. */
  avatarStyle: AvatarStyle | null;
  /** The photo the account uploaded, kept while the generated avatar shows; null when there is none. */
  photoUrl: string | null;
  /** Whether genex.games keeps a regenerated avatar; until it does, Regenerate waits. */
  avatarVariantKept: boolean;
  /**
   * Whether the account confirmed its nickname (in the welcome, here or on genex.games); false opens
   * the welcome with the nickname field once. Null while genex.games does not know handles yet: the
   * welcome is then the avatar alone, as before.
   */
  handleChosen: boolean | null;
  /**
   * genex.games names the account one of its admins: Play's cards then offer mobile support and
   * tags. Absent reads as not. The server checks every admin call again, so this only decides what shows.
   */
  isAdmin?: boolean;
}

/** The viewer's relationship with someone. Wire values, as the API names them: never rename one. */
export const FriendStatus = {
  None: "none",
  /** The viewer asked; they have not answered. */
  Outgoing: "outgoing",
  /** They asked the viewer. */
  Incoming: "incoming",
  Friends: "friends",
  /** The viewer's own profile. */
  Self: "self",
  /** No action offered: the account is gone, or a block stands either way. */
  Unavailable: "unavailable",
} as const;
export type FriendStatus = (typeof FriendStatus)[keyof typeof FriendStatus];

/** Whether a value is one of the statuses. */
export const isFriendStatus = (value: unknown): value is FriendStatus =>
  typeof value === "string" && (Object.values(FriendStatus) as string[]).includes(value);

/** The game a friend is in, when they let friends see it. */
export interface PlayingGame {
  slug: string;
  title: string;
}

/** A friend: a person, and the game they are in right now when they share it. */
export interface PlayFriend extends PlayPerson {
  playing: PlayingGame | null;
  /** How many games they have published, or null while genex.games does not say. */
  games: number | null;
}

/** An unanswered friend request, either way. */
export interface PlayFriendRequest extends PlayPerson {
  /** When it was sent (ISO). */
  requestedAt: string;
}

/** Who sees the game the account is in: friends, or nobody. Wire values: never rename one. */
export const PresenceVisibility = { Game: "game", Hidden: "hidden" } as const;
export type PresenceVisibility = (typeof PresenceVisibility)[keyof typeof PresenceVisibility];

/** Whether a value is one of the two visibilities. */
export const isPresenceVisibility = (value: unknown): value is PresenceVisibility =>
  value === PresenceVisibility.Game || value === PresenceVisibility.Hidden;

/** Everything the Friends page reads at once. */
export interface PlayFriendsPage {
  /** Whoever is playing something first, then by name: the API's order. */
  friends: PlayFriend[];
  incoming: PlayFriendRequest[];
  outgoing: PlayFriendRequest[];
  visibility: PresenceVisibility;
  /**
   * The account's invite link as genex.games hands it out (`/@<handle>/invite?ref=<code>`, the code
   * its proof): the Genex download page, with a card from the account. Null when it could not be
   * read, or is not on the website Play links to.
   */
  inviteLink: string | null;
  /** The credits the account earns when someone it invited makes their first thing, or null when unread. */
  inviteBonus: number | null;
}

/** Someone in a profile's Friends row. */
export interface PlayProfileFriend extends PlayPerson {
  /** The game they are in, shown only to their own friends and only when they share it. */
  playing: PlayingGame | null;
  /** How many games they have published, or null while genex.games does not say. */
  games: number | null;
  /** When they became friends with the profile's owner (ISO), or null. */
  since: string | null;
  /** The viewer is their friend too: these come first, with no label. */
  mutual: boolean;
}

/** A public profile, with the viewer's relationship to it. */
export interface PlayProfile {
  person: PlayPerson;
  joinedAt: string | null;
  /** Their published games, newest first, as the dashboard draws them. */
  games: PlayGame[];
  /** `Self` for the account's own, `None` while signed out. */
  status: FriendStatus;
  /** Their friends, people the viewer knows first; null while genex.games does not list them. */
  friends: PlayProfileFriend[] | null;
  /** How many different people played their games, or null while genex.games does not count them. */
  players: number | null;
}

/** Someone a people search found, with the viewer's relationship to them. */
export interface PlayFoundPerson extends PlayPerson {
  status: FriendStatus;
  /** How many games they have published, or null while genex.games does not say. */
  games: number | null;
}

/** A creator on Play's Top creators row. */
export interface PlayCreator extends PlayPerson {
  /** Games they have published. */
  games: number;
  /** Hours people played their games in the last 30 days. */
  hours: number;
}

/**
 * How Top creators are ranked: published games and hours played in their games over the last 30
 * days, each on a log scale so neither a pile of tiny games nor one viral hit runs away with it,
 * hours counted double. Nobody without a published game is ranked.
 */
export function creatorScore(games: number, hours: number): number {
  if (!(games > 0)) return Number.NEGATIVE_INFINITY;
  return Math.log1p(games) + 2 * Math.log1p(Math.max(0, hours));
}

/** Friends in a profile's row: the viewer's friends first, then everyone else, each by name. */
export function profileFriendsOrder<T extends { mutual: boolean; name: string }>(friends: readonly T[]): T[] {
  return friends.toSorted((a, b) => Number(b.mutual) - Number(a.mutual) || a.name.localeCompare(b.name));
}

/** What a people search answers. */
export interface PlayPeopleResult {
  people: PlayFoundPerson[];
  /** genex.games does not search people yet: the page says so instead of "nobody found". */
  unavailable: boolean;
}

/** What a press on a person asks for. Values are the app's own: main maps each to its route. */
export const FriendAction = {
  Add: "add",
  Accept: "accept",
  /** Declines their request, or cancels the viewer's own: either way the request goes. */
  Withdraw: "withdraw",
  Remove: "remove",
} as const;
export type FriendAction = (typeof FriendAction)[keyof typeof FriendAction];

/** Whether a value is one of the actions. */
export const isFriendAction = (value: unknown): value is FriendAction =>
  typeof value === "string" && (Object.values(FriendAction) as string[]).includes(value);

/** A friend action on someone. */
export interface FriendActionRequest {
  action: FriendAction;
  userId: string;
}

/** The name genex.games accepts: 2 to 20 characters once trimmed, not unique. */
export const PLAY_NAME_LENGTH = { min: 2, max: 20 } as const;
/** The query a people search sends: shorter matches half the product, longer is not a name. */
export const PEOPLE_QUERY_LENGTH = { min: 2, max: 40 } as const;
/** The largest avatar genex.games takes: a 512-pixel WebP. */
export const PLAY_AVATAR_MAX_BYTES = 512 * 1024;
/** The side of the square WebP the app makes an avatar into. */
export const PLAY_AVATAR_SIDE = 512;

/** An account id as genex.games hands them out: letters, digits, dashes and underscores. */
const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Whether a value is an account id the app will put in a route. */
export const isAccountId = (value: unknown): value is string => typeof value === "string" && ACCOUNT_ID.test(value);

/** A name trimmed as genex.games trims it, or null when it is not one it accepts. */
export function playName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  return name.length >= PLAY_NAME_LENGTH.min && name.length <= PLAY_NAME_LENGTH.max ? name : null;
}

/** A people query trimmed, or null when it is too short or too long to send. */
export function peopleQuery(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const query = value.trim();
  return query.length >= PEOPLE_QUERY_LENGTH.min && query.length <= PEOPLE_QUERY_LENGTH.max ? query : null;
}
