/**
 * Play's people against the genex.games API: the signed-in account's own profile (its name,
 * nickname and picture, which it may change), anyone's public profile, friends and friend
 * requests, people search and who sees the game the account is in. Every call but a public profile
 * rides the Genex account's token. Electron-free, like the gallery: the request, the token and the
 * avatar upload come in as deps. Nobody's email leaves this module: `/api/me` names it, nothing
 * here returns it.
 */
import { isAvatarVariant } from "../../shared/avatar-recipe.ts";
import { MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";
import {
  HANDLE_SUGGESTIONS_MAX,
  type HandleCheck,
  type HandleSave,
  HandleSaveOutcome,
  HandleState,
  isHandle,
  isHandleProblem,
  isHandleState,
  localHandleCheck,
  normalizeHandleInput,
} from "../../shared/handle.ts";
import {
  AvatarStyle,
  FriendAction,
  FriendStatus,
  isAccountId,
  isAvatarStyle,
  isFriendStatus,
  isPresenceVisibility,
  PLAY_AVATAR_MAX_BYTES,
  type PlayFoundPerson,
  type PlayFriend,
  type PlayFriendRequest,
  type PlayFriendsPage,
  type PlayMe,
  type PlayPeopleResult,
  type PlayPerson,
  type PlayProfile,
  type PlayProfileFriend,
  PresenceVisibility,
  peopleQuery,
  playName,
  profileFriendsOrder,
} from "../../shared/play-people.ts";
import { isPlaySlug, type PlayGame } from "../../shared/play.ts";
import {
  type GalleryDeps,
  GalleryError,
  imageUrl,
  type GalleryRequest,
  isRecord,
  PlayRoute,
  readRoute,
  SignInNeeded,
  text,
  toPlayGame,
} from "./gallery.ts";
import { onWebsite } from "./origins.ts";

/** How long the signed-in account's own profile is trusted before it is read again. */
const ME_TTL_MS = 30 * SECOND_MS;
/** How long a public profile is kept, so going back to one draws at once. */
const PROFILE_TTL_MS = MINUTE_MS;
/** How long an avatar upload may take. */
const UPLOAD_TIMEOUT_MS = 30 * SECOND_MS;
/** How much of a name or a game title a row keeps. */
const NAME_MAX = 120;
const TITLE_MAX = 200;
/** The most rows one list keeps: the API's own ceilings, with room. */
const LIST_MAX = 500;
/** HTTP statuses the people calls read apart. */
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;
const HTTP_TOO_MANY_REQUESTS = 429;
const BAD_GATEWAY = 502;
/** What a WebP file starts with: `RIFF`, four length bytes, `WEBP`. */
const RIFF = [0x52, 0x49, 0x46, 0x46];
const WEBP = [0x57, 0x45, 0x42, 0x50];

/** The routes the people calls use. */
export const PeopleRoute = {
  Me: "/api/me",
  MyAccount: "/api/users/me",
  HandleCheck: "/api/users/handle-check",
  AvatarUpload: "/api/users/me/avatar/upload-url",
  AvatarCommit: "/api/users/me/avatar/commit",
  Friends: "/api/friends",
  Requests: "/api/friends/requests",
  Visibility: "/api/friends/me",
  Search: "/api/friends/search",
  user: (id: string) => `/api/users/${encodeURIComponent(id)}`,
  userFriends: (id: string) => `/api/users/${encodeURIComponent(id)}/friends`,
  request: (id: string) => `/api/friends/requests/${encodeURIComponent(id)}`,
  accept: (id: string) => `/api/friends/requests/${encodeURIComponent(id)}/accept`,
  friend: (id: string) => `/api/friends/${encodeURIComponent(id)}`,
  status: (id: string) => `/api/friends/status/${encodeURIComponent(id)}`,
} as const;

/** Why genex.games refused a handle, as its error names it. Wire values: never rename one. */
export const HandleError = {
  /** Taken or kept by genex.games; its answer offers handles to try. */
  Taken: "handle_taken",
  /** A shape problem, which its answer names. */
  Invalid: "handle_invalid",
  /** Changed too often lately (a 429). */
  ChangesExhausted: "handle_changes_exhausted",
} as const;
export type HandleError = (typeof HandleError)[keyof typeof HandleError];

const MESSAGE = {
  BadAccount: "Not a Genex account",
  BadStyle: "Not an avatar style",
  BadVariant: "Not an avatar variant",
  BadName: "A name is 2 to 20 characters",
  BadAvatar: "An avatar is a WebP picture of at most 512 KB",
  BadUpload: "Genex did not hand back a place to upload the picture",
  UploadFailed: (status: number) => `The picture did not upload (HTTP ${status})`,
} as const;

/** What the people calls need beyond the gallery's: a way to put the avatar where the API says. */
export interface PeopleDeps extends GalleryDeps {
  /** PUT `bytes` to a presigned `url` with `contentType`; the answer's HTTP status. */
  upload(url: string, bytes: Uint8Array, contentType: string): Promise<number>;
  /** genex.games answered 401 to `token`, on any of the account's calls: its sign-in has ended. */
  refused?(token: string): void;
  /** The website Play links to (`origins.ts`): an invite link elsewhere is never handed on. */
  web: string;
}

/** `request`, telling `refused` which token genex.games refused (401) on any call that carried one. */
export function refusingRequest(
  request: GalleryRequest,
  refused: ((token: string) => void) | undefined,
): GalleryRequest {
  if (!refused) return request;
  return async (route, init) => {
    const answer = await request(route, init);
    if (answer.status === HTTP_UNAUTHORIZED && init.token) refused(init.token);
    return answer;
  };
}

/**
 * A person as Play shows one, from any of the API's person shapes; null when it lacks an id or a
 * name. Their picture shows only when they chose a photo as their avatar: everyone else (and
 * everyone, while genex.games does not say which they chose) gets their generated avatar.
 */
export function toPerson(value: unknown, local = false): PlayPerson | null {
  if (!isRecord(value) || !isAccountId(value.id)) return null;
  const name = text(value.name, NAME_MAX).trim();
  if (!name) return null;
  const photo = value.avatarStyle === AvatarStyle.Photo ? imageUrl(value.image, local) : null;
  const avatarVariant = isAvatarVariant(value.avatarVariant) ? value.avatarVariant : 0;
  const handle = isHandle(value.handle) ? value.handle : null;
  return { id: value.id, name, handle, imageUrl: photo, avatarVariant, pro: value.pro === true };
}

/** A count the API sent, or null when it sent none. */
export const countOf = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;

/** An ISO date the API sent, or null. */
const isoDate = (value: unknown): string | null =>
  typeof value === "string" && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : null;

/** The game a friend is in, when the API names a public one. */
function playingGame(value: unknown): PlayFriend["playing"] {
  if (!isRecord(value) || !isPlaySlug(value.slug)) return null;
  const title = text(value.title, TITLE_MAX).trim();
  return title ? { slug: value.slug, title } : null;
}

/** Each valid row of a list, once, mapped by `row`. */
function rows<T extends { id: string }>(list: unknown, row: (value: unknown) => T | null): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const value of Array.isArray(list) ? list.slice(0, LIST_MAX) : []) {
    const item = row(value);
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

/** The friends list as the API sorts it. */
export function toFriends(body: unknown, local = false): PlayFriend[] {
  const list = isRecord(body) ? body.friends : null;
  return rows(list, (value) => {
    const person = toPerson(value, local);
    if (!person || !isRecord(value)) return null;
    return { ...person, playing: playingGame(value.playing), games: countOf(value.games) };
  });
}

/** A profile's friends, the viewer's own friends first; null when the answer is not a list of them. */
export function toProfileFriends(body: unknown, local = false): PlayProfileFriend[] | null {
  const list = isRecord(body) ? body.friends : null;
  if (!Array.isArray(list)) return null;
  const friends = rows(list, (value): PlayProfileFriend | null => {
    const person = toPerson(value, local);
    if (!person || !isRecord(value)) return null;
    return {
      ...person,
      playing: playingGame(value.playing),
      games: countOf(value.games),
      since: isoDate(value.since),
      mutual: value.mutual === true,
    };
  });
  return profileFriendsOrder(friends);
}

/** One direction of the unanswered requests. */
function toRequests(list: unknown, local: boolean): PlayFriendRequest[] {
  return rows(list, (value) => {
    const person = toPerson(value, local);
    const requestedAt = isRecord(value) ? isoDate(value.requestedAt) : null;
    return person && requestedAt ? { ...person, requestedAt } : null;
  });
}

/** The people a search found, each with the viewer's relationship. */
export function toFoundPeople(body: unknown, local = false): PlayFoundPerson[] {
  const list = isRecord(body) ? body.people : null;
  return rows(list, (value) => {
    const person = toPerson(value, local);
    if (!person || !isRecord(value)) return null;
    const status = isFriendStatus(value.status) ? value.status : FriendStatus.None;
    return { ...person, status, games: countOf(value.games) };
  });
}

/** Whether bytes are a WebP file small enough for genex.games to take as an avatar. */
export function isAvatarWebp(bytes: Uint8Array): boolean {
  if (bytes.length < 12 || bytes.length > PLAY_AVATAR_MAX_BYTES) return false;
  return RIFF.every((byte, at) => bytes[at] === byte) && WEBP.every((byte, at) => bytes[at + 8] === byte);
}

/** The credits an invite earns, as the referral answer says. */
const inviteBonusOf = (body: unknown): number | null => (isRecord(body) ? countOf(body.inviterBonus) : null);

/** The invite link the referral answer carries, when it is a page of the website Play links to (`web`). */
function inviteLinkOf(body: unknown, web: string): string | null {
  const link = isRecord(body) ? body.link : null;
  return typeof link === "string" && onWebsite(link, web) ? new URL(link).href : null;
}

/** Handles genex.games offers in place of `asked`: well formed, each once, at most a few. */
function suggestionsOf(value: unknown, asked: string): string[] {
  const offered = Array.isArray(value) ? value.filter(isHandle).filter((handle) => handle !== asked) : [];
  return [...new Set(offered)].slice(0, HANDLE_SUGGESTIONS_MAX);
}

/** genex.games' answer to a handle check of `asked`; a state it does not name is a failed read, never Free. */
function toHandleCheck(body: unknown, asked: string, route: string): HandleCheck {
  const state = isRecord(body) ? body.state : null;
  if (!isHandleState(state)) throw new GalleryError(route, BAD_GATEWAY);
  return { handle: asked, state, suggestions: isRecord(body) ? suggestionsOf(body.suggestions, asked) : [] };
}

/** A refused handle save as the field shows it, or null for an answer that is no refusal of the handle. */
function handleRefusal(handle: string, answer: { status: number; body: unknown }): HandleSave | null {
  if (!isRecord(answer.body)) return null;
  const { error, problem, suggestions } = answer.body;
  // Only genex.games' own word for it: any other 429 is a rate limit, which is no verdict on the handle.
  if (answer.status === HTTP_TOO_MANY_REQUESTS) {
    return error === HandleError.ChangesExhausted ? { outcome: HandleSaveOutcome.TooManyChanges } : null;
  }
  if (answer.status !== HTTP_BAD_REQUEST) return null;
  const refused = (state: HandleState, offered: string[] = []): HandleSave => ({
    outcome: HandleSaveOutcome.Refused,
    check: { handle, state, suggestions: offered },
  });
  if (error === HandleError.Taken) return refused(HandleState.Taken, suggestionsOf(suggestions, handle));
  return error === HandleError.Invalid && isHandleProblem(problem) ? refused(problem) : null;
}

/** A write's answer: SignInNeeded for a refused token, GalleryError for any other non-2xx. */
function checked(route: string, answer: { status: number; body: unknown }): unknown {
  if (answer.status === HTTP_UNAUTHORIZED) throw new SignInNeeded();
  if (answer.status < 200 || answer.status >= 300) throw new GalleryError(route, answer.status);
  return answer.body;
}

/** The account `/api/me` names, as Play shows it, with the Pro flag its public profile carries. */
function toMe(user: Record<string, unknown>, person: PlayPerson, pro: boolean, local: boolean): PlayMe {
  return {
    ...person,
    pro,
    joinedAt: isoDate(user.createdAt),
    avatarStyle: isAvatarStyle(user.avatarStyle) ? user.avatarStyle : null,
    photoUrl: imageUrl(user.photo, local),
    avatarVariantKept: isAvatarVariant(user.avatarVariant),
    // Absent is not false: a genex.games without handles opens no welcome for one.
    handleChosen: typeof user.handleChosen === "boolean" ? user.handleChosen : null,
  };
}

/** The signed-in account's own reads and writes: who it is, its name and its picture. */
function accountCalls(deps: PeopleDeps) {
  const { request, token, now } = deps;
  const local = deps.localImages === true;
  let me: { token: string; at: number; value: PlayMe } | null = null;

  /** The token, or SignInNeeded. */
  const auth = async (): Promise<string> => {
    const value = await token();
    if (!value) throw new SignInNeeded();
    return value;
  };

  /** The account Play is signed in as, read once a while per token; null while signed out. */
  const whoAmI = async (): Promise<PlayMe | null> => {
    const current = await token();
    if (!current) return null;
    if (me?.token === current && now() - me.at < ME_TTL_MS) return me.value;
    const answer = await request(PeopleRoute.Me, { method: "GET", token: current });
    // `request` told `refused` already: the account reads as ended, not as signed out.
    if (answer.status === HTTP_UNAUTHORIZED) return null;
    const body = checked(PeopleRoute.Me, answer);
    const user = isRecord(body) ? body.user : null;
    const person = toPerson(user, local);
    if (!person || !isRecord(user)) throw new GalleryError(PeopleRoute.Me, answer.status);
    // `/api/me` has no Pro flag; the public profile has, and no email.
    const profile = await readRoute(request, PeopleRoute.user(person.id)).catch(() => null);
    const pro = isRecord(profile) && isRecord(profile.user) && profile.user.pro === true;
    const value = toMe(user, person, pro, local);
    me = { token: current, at: now(), value };
    return value;
  };

  /** Read the account afresh on the next ask: a write changed it. */
  const forget = (): void => {
    me = null;
  };

  /** Rename the account, as genex.games trims and bounds a name. */
  const rename = async (name: string): Promise<PlayMe | null> => {
    const clean = playName(name);
    if (!clean) throw new Error(MESSAGE.BadName);
    const answer = await request(PeopleRoute.MyAccount, {
      method: "PATCH",
      token: await auth(),
      body: { name: clean },
    });
    checked(PeopleRoute.MyAccount, answer);
    me = null;
    return whoAmI();
  };

  /** Show the generated avatar or the uploaded photo, everywhere at once. */
  const setAvatarStyle = async (style: AvatarStyle): Promise<PlayMe | null> => {
    if (!isAvatarStyle(style)) throw new Error(MESSAGE.BadStyle);
    const answer = await request(PeopleRoute.MyAccount, {
      method: "PATCH",
      token: await auth(),
      body: { avatarStyle: style },
    });
    checked(PeopleRoute.MyAccount, answer);
    me = null;
    return whoAmI();
  };

  /** Show another generated avatar (`variant`), in the app and on genex.games at once. */
  const setAvatarVariant = async (variant: number): Promise<PlayMe | null> => {
    if (!isAvatarVariant(variant)) throw new Error(MESSAGE.BadVariant);
    const answer = await request(PeopleRoute.MyAccount, {
      method: "PATCH",
      token: await auth(),
      body: { avatarVariant: variant },
    });
    checked(PeopleRoute.MyAccount, answer);
    me = null;
    return whoAmI();
  };

  /**
   * Make a WebP picture the account's photo: ask where to put it, put it there, commit it, then (where
   * genex.games keeps the choice) show the photo rather than the generated avatar.
   */
  const setAvatar = async (bytes: Uint8Array): Promise<PlayMe | null> => {
    if (!isAvatarWebp(bytes)) throw new Error(MESSAGE.BadAvatar);
    const key = await auth();
    const slot = checked(
      PeopleRoute.AvatarUpload,
      await request(PeopleRoute.AvatarUpload, { method: "POST", token: key, body: { bytes: bytes.length } }),
    );
    const uploadUrl = isRecord(slot) ? slot.uploadUrl : null;
    const objectKey = isRecord(slot) ? slot.key : null;
    if (typeof uploadUrl !== "string" || !uploadUrl.startsWith("https://") || typeof objectKey !== "string")
      throw new Error(MESSAGE.BadUpload);
    const status = await deps.upload(uploadUrl, bytes, "image/webp");
    if (status < 200 || status >= 300) throw new Error(MESSAGE.UploadFailed(status));
    checked(
      PeopleRoute.AvatarCommit,
      await request(PeopleRoute.AvatarCommit, { method: "POST", token: key, body: { key: objectKey } }),
    );
    me = null;
    const after = await whoAmI();
    // An upload is a choice of the photo; genex.games keeps that choice apart from the picture itself.
    if (after?.avatarStyle === AvatarStyle.Generated) return setAvatarStyle(AvatarStyle.Photo);
    return after;
  };

  return { auth, whoAmI, forget, rename, setAvatar, setAvatarStyle, setAvatarVariant };
}

/** The account's nickname: what a typed one is, and making one the account's. */
function handleCalls(deps: PeopleDeps, account: Pick<ReturnType<typeof accountCalls>, "auth" | "whoAmI" | "forget">) {
  const { request } = deps;
  const { auth, whoAmI } = account;

  /**
   * What a typed handle is: its shape problem or that it is the account's own, at once; any other
   * well-formed handle is genex.games' to judge (free, taken or reserved, with handles to try).
   */
  const checkHandle = async (raw: string): Promise<HandleCheck> => {
    const own = (await whoAmI().catch(() => null))?.handle ?? null;
    const known = localHandleCheck(String(raw), own);
    if (known) return known;
    const handle = normalizeHandleInput(String(raw));
    const route = `${PeopleRoute.HandleCheck}?${new URLSearchParams({ handle })}`;
    const answer = await request(route, { method: "GET", token: await auth() });
    return toHandleCheck(checked(route, answer), handle, route);
  };

  /**
   * Make a handle the account's (its own one again confirms it, which is how the welcome's Continue
   * closes it for good). A refusal says why, as the field shows it; nothing is sent for a handle of
   * the wrong shape.
   */
  const setHandle = async (raw: string): Promise<HandleSave> => {
    const problem = localHandleCheck(String(raw), null);
    if (problem) return { outcome: HandleSaveOutcome.Refused, check: problem };
    const handle = normalizeHandleInput(String(raw));
    const answer = await request(PeopleRoute.MyAccount, { method: "PATCH", token: await auth(), body: { handle } });
    const refusal = handleRefusal(handle, answer);
    if (refusal) return refusal;
    checked(PeopleRoute.MyAccount, answer);
    account.forget();
    return { outcome: HandleSaveOutcome.Saved, me: await whoAmI() };
  };

  return { checkHandle, setHandle };
}

/** The account's friends: the Friends page, a press on a person, people search and visibility. */
function friendCalls(deps: PeopleDeps, auth: () => Promise<string>) {
  const { request } = deps;
  const local = deps.localImages === true;

  /** Everything the Friends page reads: friends, requests both ways, visibility and the invite link. */
  const friends = async (): Promise<PlayFriendsPage> => {
    const key = await auth();
    const read = (route: string) =>
      request(route, { method: "GET", token: key }).then((answer) => checked(route, answer));
    const [list, requests, visibility, referral] = await Promise.all([
      read(PeopleRoute.Friends),
      read(PeopleRoute.Requests),
      read(PeopleRoute.Visibility),
      read(PlayRoute.Referral).catch(() => null),
    ]);
    const seen = isRecord(visibility) ? visibility.presenceVisibility : null;
    return {
      friends: toFriends(list, local),
      incoming: toRequests(isRecord(requests) ? requests.incoming : null, local),
      outgoing: toRequests(isRecord(requests) ? requests.outgoing : null, local),
      visibility: isPresenceVisibility(seen) ? seen : PresenceVisibility.Game,
      inviteLink: inviteLinkOf(referral, deps.web),
      inviteBonus: inviteBonusOf(referral),
    };
  };

  /** Add, accept, withdraw (decline or cancel) or remove: the relationship after it, as the API says. */
  const act = async (action: FriendAction, userId: string): Promise<FriendStatus> => {
    if (!isAccountId(userId)) throw new Error(MESSAGE.BadAccount);
    const key = await auth();
    if (action === FriendAction.Add) {
      const body = checked(
        PeopleRoute.Requests,
        await request(PeopleRoute.Requests, { method: "POST", token: key, body: { userId } }),
      );
      return isRecord(body) && body.status === FriendStatus.Friends ? FriendStatus.Friends : FriendStatus.Outgoing;
    }
    if (action === FriendAction.Accept) {
      checked(PeopleRoute.accept(userId), await request(PeopleRoute.accept(userId), { method: "POST", token: key }));
      return FriendStatus.Friends;
    }
    const route = action === FriendAction.Remove ? PeopleRoute.friend(userId) : PeopleRoute.request(userId);
    checked(route, await request(route, { method: "DELETE", token: key }));
    return FriendStatus.None;
  };

  /** People whose name matches, with the viewer's relationship; `unavailable` while the API has no search. */
  const search = async (query: string): Promise<PlayPeopleResult> => {
    const q = peopleQuery(query);
    if (!q) return { people: [], unavailable: false };
    const route = `${PeopleRoute.Search}?${new URLSearchParams({ q })}`;
    const answer = await request(route, { method: "GET", token: await auth() });
    if (answer.status === HTTP_NOT_FOUND) return { people: [], unavailable: true };
    return { people: toFoundPeople(checked(route, answer), local), unavailable: false };
  };

  /** Whether friends see the game the account is in. */
  const setVisibility = async (visibility: PresenceVisibility): Promise<PresenceVisibility> => {
    const answer = await request(PeopleRoute.Visibility, {
      method: "PATCH",
      token: await auth(),
      body: { presenceVisibility: visibility },
    });
    const body = checked(PeopleRoute.Visibility, answer);
    const seen = isRecord(body) ? body.presenceVisibility : null;
    return isPresenceVisibility(seen) ? seen : visibility;
  };

  return { friends, act, search, setVisibility };
}

/** Play's people over `deps`. */
export function playPeople(given: PeopleDeps) {
  const deps = { ...given, request: refusingRequest(given.request, given.refused) };
  const { request, token, now } = deps;
  const local = deps.localImages === true;
  const account = accountCalls(deps);
  const profiles = new Map<string, { at: number; profile: Omit<PlayProfile, "status"> }>();
  /** Whose reads `profiles` keeps: an answer may differ for the viewer, so a new sign-in starts empty. */
  let viewer: string | undefined;

  /** The viewer's relationship with `id`: Self, the API's status, or None while signed out. */
  const statusOf = async (id: string): Promise<FriendStatus> => {
    const current = await token();
    if (!current) return FriendStatus.None;
    const me = await account.whoAmI().catch(() => null);
    if (me?.id === id) return FriendStatus.Self;
    const body = await readRoute(request, PeopleRoute.status(id), current).catch(() => null);
    return isRecord(body) && isFriendStatus(body.status) ? body.status : FriendStatus.None;
  };

  /** Anyone's public profile and games, kept a minute, with the viewer's relationship read fresh. */
  const profile = async (id: string): Promise<PlayProfile> => {
    if (!isAccountId(id)) throw new Error(MESSAGE.BadAccount);
    const current = await token();
    if (current !== viewer) {
      profiles.clear();
      viewer = current;
    }
    const kept = profiles.get(id);
    const fresh = kept && now() - kept.at < PROFILE_TTL_MS ? kept.profile : null;
    const read = fresh ?? (await readProfile(id));
    // A sign-in that changed during the read keeps nothing of it.
    if (!fresh && viewer === current) profiles.set(id, { at: now(), profile: read });
    return { ...read, status: await statusOf(id) };
  };

  /** A profile's friends: the public list, else (on the account's own profile, before genex.games lists them) its own. */
  const profileFriends = async (id: string): Promise<PlayProfileFriend[] | null> => {
    const current = await token();
    const route = PeopleRoute.userFriends(id);
    const answer = await request(route, { method: "GET", ...(current ? { token: current } : {}) }).catch(() => null);
    if (answer && answer.status >= 200 && answer.status < 300) return toProfileFriends(answer.body, local);
    const me = current ? await account.whoAmI().catch(() => null) : null;
    if (!current || me?.id !== id) return null;
    const own = await readRoute(request, PeopleRoute.Friends, current).catch(() => null);
    if (!own) return null;
    return profileFriendsOrder(toFriends(own, local).map((friend) => ({ ...friend, since: null, mutual: false })));
  };

  const readProfile = async (id: string): Promise<Omit<PlayProfile, "status">> => {
    // Public; the token rides along so an answer may differ for the viewer (a fixture account's own games).
    const current = await token();
    const [body, friends] = await Promise.all([readRoute(request, PeopleRoute.user(id), current), profileFriends(id)]);
    const user = isRecord(body) ? body.user : null;
    const person = toPerson(user, local);
    if (!person || !isRecord(user) || !isRecord(body)) throw new GalleryError(PeopleRoute.user(id), HTTP_NOT_FOUND);
    const games = (Array.isArray(body.games) ? body.games : [])
      .map((game) => toPlayGame(game, local))
      .filter((game): game is PlayGame => game !== null);
    return { person, joinedAt: isoDate(user.createdAt), games, friends, players: countOf(body.players) };
  };

  return {
    me: account.whoAmI,
    rename: account.rename,
    setAvatar: account.setAvatar,
    setAvatarStyle: account.setAvatarStyle,
    setAvatarVariant: account.setAvatarVariant,
    ...handleCalls(deps, account),
    profile,
    ...friendCalls(deps, account.auth),
  };
}

/** Play's people as `playPeople` makes them. */
export type PlayPeople = ReturnType<typeof playPeople>;

/** The avatar upload over the network: the bytes PUT to the presigned address, a bounded wait. */
export function networkUpload(fetchImpl: typeof fetch, timeoutMs = UPLOAD_TIMEOUT_MS): PeopleDeps["upload"] {
  return async (url, bytes, contentType) => {
    const res = await fetchImpl(url, {
      method: "PUT",
      headers: { "Content-Type": contentType },
      body: new Uint8Array(bytes),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.status;
  };
}

/** A fixture launch's avatar upload: nothing leaves the machine, and it always lands. */
export const fixtureUpload: PeopleDeps["upload"] = async () => 200;
