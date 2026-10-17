/**
 * Play's people in a fixture profile: the API's answers for the account, profiles (and their
 * friends), friends, requests, people search and nicknames, made here in the shapes the API serves,
 * so the profile plate, the profile page, the Friends page and the nickname field can be checked
 * with no socket and no Genex account. A launch is signed out unless it asks for a fixture account
 * (`STUDIO_FIXTURE_GENEX_ACCOUNT=1`, or `new`, `quiet` or `fresh` for a new account with no games and
 * nobody yet, with games nobody played this week, or with one game two days old, `nickname` for the
 * full account before it chose its nickname, `ended` for a sign-in genex.games no longer takes, or
 * `terms` for the full account with Genex's updated terms still to accept);
 * then every call carries that account's token. A new account and the nickname account have not
 * chosen their nicknames, so the welcome asks. State lives for the launch: adding a friend,
 * renaming the account, choosing an avatar or a nickname shows at once and is gone at the next launch.
 */
import { isAvatarVariant } from "../../shared/avatar-recipe.ts";
import {
  HANDLE_SUGGESTIONS_MAX,
  HandleState,
  handleBaseFromName,
  handleKept,
  handleProblem,
  isHandle,
  normalizeHandleInput,
  shownAsTaken,
} from "../../shared/handle.ts";
import { PLAY_ORIGIN } from "../../shared/play.ts";
import { FixtureName } from "./fixture-kit.ts";
import type { GalleryAnswer } from "../play/gallery.ts";
import { HandleError, PeopleRoute } from "../play/people.ts";
import {
  AvatarStyle,
  FriendStatus,
  isAvatarStyle,
  isPresenceVisibility,
  PresenceVisibility,
} from "../../shared/play-people.ts";

/** The fixture accounts a launch may sign in as: `STUDIO_FIXTURE_GENEX_ACCOUNT`'s values. */
export const FixtureAccount = {
  /** A creator with friends, games and a busy week. */
  Full: "1",
  /** A new account: no games and no friends yet. */
  New: "new",
  /** Games, but nobody played them this week. */
  Quiet: "quiet",
  /** One game, published two days ago. */
  Fresh: "fresh",
  /** The full account before it chose its nickname: the welcome asks once, the handle prefilled. */
  Nickname: "nickname",
  /** Signed in earlier, but genex.games no longer takes the token: every call of the account is a 401. */
  Ended: "ended",
  /** The full account with Genex's updated terms still to accept: the sidebar offers Review. */
  Terms: "terms",
} as const;
export type FixtureAccount = (typeof FixtureAccount)[keyof typeof FixtureAccount];

/** The token the full fixture account's calls carry; nothing outside a fixture launch accepts it. */
export const FIXTURE_ACCOUNT_TOKEN = "fixture-genex-account";

/** The token a fixture account's calls carry. */
export const fixtureAccountToken = (account: FixtureAccount): string =>
  account === FixtureAccount.Full ? FIXTURE_ACCOUNT_TOKEN : `${FIXTURE_ACCOUNT_TOKEN}:${account}`;

/** The fixture account a token signs in as, or null for any other token. */
export function fixtureAccountOf(token: string | undefined): FixtureAccount | null {
  return Object.values(FixtureAccount).find((account) => fixtureAccountToken(account) === token) ?? null;
}

/** Whether a value names a fixture account. */
export const isFixtureAccount = (value: unknown): value is FixtureAccount =>
  typeof value === "string" && (Object.values(FixtureAccount) as string[]).includes(value);

/**
 * The fixture account a launch signs in as: the one `STUDIO_FIXTURE_GENEX_ACCOUNT` names, else the
 * genex-terms fixture's own, else none.
 */
export function launchFixtureAccount(named: unknown, fixture: string | null | undefined): FixtureAccount | null {
  if (isFixtureAccount(named)) return named;
  return fixture === FixtureName.GenexTerms ? FixtureAccount.Terms : null;
}

/** A fixture person as the API serves one. */
interface FixturePerson {
  id: string;
  name: string;
  /** Their name run together in Latin letters, as genex.games backfills a handle. */
  handle: string;
  image: null;
  pro: boolean;
  createdAt: string;
  avatarStyle: typeof AvatarStyle.Generated;
}

/** The id the fixture catalog gives an author: their name in lowercase words. */
export const fixtureAuthorId = (name: string): string =>
  `fx-${name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")}`;

const person = (name: string, pro = false, createdAt = "2026-08-12T10:00:00.000Z"): FixturePerson => ({
  id: fixtureAuthorId(name),
  name,
  handle: handleBaseFromName(name),
  image: null,
  pro,
  createdAt,
  avatarStyle: AvatarStyle.Generated,
});

/** Everyone the fixture knows, the account first. */
const ME = person("Rab Neba", true, "2026-05-18T10:53:42.000Z");
const PEOPLE = [
  person("Simeon M", true, "2026-07-18T10:53:42.000Z"),
  person("Mira Kovač"),
  person("Tomás Reyes"),
  person("Kenji Mori", true),
  person("Juno Park"),
  person("Lena Ahl"),
  person("Ola Nowak"),
  person("Milo Santos", true),
  person("Dmitri Minsky"),
  person("Gab"),
  person("Threejs Community"),
  person("Pia Sorensen"),
  person("Omar Haddad"),
  person("Yuki Tanaka", true),
];
const byName = (name: string): FixturePerson => PEOPLE.find((p) => p.name === name) ?? person(name);
const idOf = (name: string): string => byName(name).id;

/** A drawn square picture a fixture "upload" leaves as the account's photo. */
const FIXTURE_PHOTO = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#2b3a67"/><circle cx="32" cy="26" r="12" fill="#f2c9a8"/><path d="M10 64c2-14 12-20 22-20s20 6 22 20z" fill="#e0a55a"/></svg>',
)}`;

/** The launch's own settings, changed by the fixture account's writes. */
const state = {
  name: ME.name,
  handle: ME.handle,
  /** The account confirmed its nickname during this launch. */
  handleChosen: false,
  /** How many times the handle changed during this launch. */
  handleChanges: 0,
  photo: null as string | null,
  avatarStyle: AvatarStyle.Generated as AvatarStyle,
  avatarVariant: 0,
  visibility: PresenceVisibility.Game as PresenceVisibility,
};

/** How many handle changes the fixture takes before it answers as genex.games does past its limit. */
const FIXTURE_HANDLE_CHANGES = 5;
/** Handles the fixture's genex.games holds for others: a few short names, and every fixture person's. */
const TAKEN_HANDLES: ReadonlySet<string> = new Set([
  "rab",
  "max",
  "neo",
  "alex",
  "play",
  ...PEOPLE.map((p) => p.handle),
]);
/** Words the fixture keeps for Genex itself, besides anything with "genex" in it. */
const KEPT_HANDLES: ReadonlySet<string> = new Set(["admin", "support", "official", "staff", "mod"]);
const BRAND = "genex";

/** Whether a fixture account has chosen its nickname: a new account and the nickname account not until they do. */
const handleChosen = (account: FixtureAccount): boolean =>
  state.handleChosen || (account !== FixtureAccount.New && account !== FixtureAccount.Nickname);

/** An account's friends and its requests both ways. */
interface Circle {
  friends: Set<string>;
  incoming: Set<string>;
  outgoing: Set<string>;
}

/** The fixture accounts' circles for the launch: a new account has nobody yet; the others share one. */
const CIRCLES = {
  shared: {
    friends: new Set(
      ["Simeon M", "Mira Kovač", "Tomás Reyes", "Kenji Mori", "Pia Sorensen", "Omar Haddad", "Yuki Tanaka"].map(idOf),
    ),
    incoming: new Set(["Juno Park", "Lena Ahl"].map(idOf)),
    outgoing: new Set([idOf("Ola Nowak")]),
  },
  new: { friends: new Set<string>(), incoming: new Set<string>(), outgoing: new Set<string>() },
} satisfies Record<string, Circle>;

/** The circle a fixture account has. */
const circleOf = (account: FixtureAccount): Circle => (account === FixtureAccount.New ? CIRCLES.new : CIRCLES.shared);

/** Who is in which fixture game right now. */
const PLAYING: Record<string, { slug: string; title: string }> = {
  [idOf("Tomás Reyes")]: { slug: "stick-steel", title: "Stick & Steel" },
  [idOf("Pia Sorensen")]: { slug: "sandstorm", title: "SANDSTORM" },
  [idOf("Kenji Mori")]: { slug: "lost-cathedral", title: "Lost Cathedral" },
};

/** Who else is friends with whom, besides the account (whose friends are its circle's). */
const FRIENDSHIPS: Record<string, string[]> = {
  [idOf("Simeon M")]: ["Mira Kovač", "Kenji Mori", "Gab", "Lena Ahl", "Juno Park", "Milo Santos"].map(idOf),
  [idOf("Gab")]: ["Simeon M", "Dmitri Minsky", "Threejs Community"].map(idOf),
  [idOf("Mira Kovač")]: ["Simeon M", "Juno Park"].map(idOf),
};
/** When two people became friends: a fixed date a little after the later of them joined. */
const SINCE = "2026-09-02T12:00:00.000Z";

const ok = (body: unknown): GalleryAnswer => ({ status: 200, body });
const NOT_FOUND: GalleryAnswer = { status: 404, body: null };
const slim = (p: FixturePerson) => ({
  id: p.id,
  name: p.name,
  handle: p.handle,
  image: p.image,
  pro: p.pro,
  avatarStyle: p.avatarStyle,
});
const me = (): FixturePerson => ({ ...ME, name: state.name, handle: state.handle });
/** The account as others see it: its photo only when it chose the photo. */
const meSlim = () => ({
  ...slim(me()),
  image: state.photo,
  avatarStyle: state.avatarStyle,
  avatarVariant: state.avatarVariant,
});

/** A fixture person's friends, the account among them where it is. */
function friendsOf(id: string, circle: Circle): string[] {
  const listed = FRIENDSHIPS[id] ?? [];
  const known = Object.entries(FRIENDSHIPS)
    .filter(([, ids]) => ids.includes(id))
    .map(([other]) => other);
  const ids = new Set([...listed, ...known]);
  if (circle.friends.has(id)) ids.add(ME.id);
  ids.delete(id);
  return [...ids];
}

/** The relationship the fixture account has with `id`. */
function statusOf(id: string, circle: Circle): FriendStatus {
  if (id === ME.id) return FriendStatus.Self;
  if (circle.friends.has(id)) return FriendStatus.Friends;
  if (circle.outgoing.has(id)) return FriendStatus.Outgoing;
  return circle.incoming.has(id) ? FriendStatus.Incoming : FriendStatus.None;
}

/** What the fixture's author answers need: each author's published games. */
export interface FixtureCatalog {
  /** The gallery items of an author's games, as a profile lists them. */
  games(authorId: string): unknown[];
}

/** The account's own games for a fixture account: none, one fresh game, or the catalog's "Simeon M" games. */
export function fixtureOwnGames(account: FixtureAccount, catalog: FixtureCatalog): unknown[] {
  const games = catalog.games(idOf("Simeon M"));
  if (account === FixtureAccount.New) return [];
  return account === FixtureAccount.Fresh ? games.slice(0, 1) : games;
}

/** The games one person published, the account's by its fixture account. */
const gamesOf = (id: string, account: FixtureAccount, catalog: FixtureCatalog): unknown[] =>
  id === ME.id ? fixtureOwnGames(account, catalog) : catalog.games(id);

/** The friends page's three reads. */
function friendsList(account: FixtureAccount, catalog: FixtureCatalog): GalleryAnswer {
  const friends = PEOPLE.filter((p) => circleOf(account).friends.has(p.id)).map((p) => ({
    ...slim(p),
    playing: PLAYING[p.id] ?? null,
    games: gamesOf(p.id, account, catalog).length,
  }));
  friends.sort((a, b) => Number(b.playing !== null) - Number(a.playing !== null) || a.name.localeCompare(b.name));
  return ok({ friends });
}
function requests(circle: Circle): GalleryAnswer {
  const rows = (ids: Set<string>) =>
    PEOPLE.filter((p) => ids.has(p.id)).map((p) => ({ ...slim(p), requestedAt: "2026-10-12T09:00:00.000Z" }));
  return ok({ incoming: rows(circle.incoming), outgoing: rows(circle.outgoing) });
}

/** People whose name holds the query, starts-with first, as the API answers. */
function search(query: string, account: FixtureAccount, catalog: FixtureCatalog): GalleryAnswer {
  const q = query.trim().toLowerCase();
  const found = PEOPLE.filter((p) => p.id !== ME.id && p.name.toLowerCase().includes(q));
  found.sort(
    (a, b) =>
      Number(b.name.toLowerCase().startsWith(q)) - Number(a.name.toLowerCase().startsWith(q)) ||
      a.name.localeCompare(b.name),
  );
  const people = found.slice(0, 20).map((p) => ({
    ...slim(p),
    status: statusOf(p.id, circleOf(account)),
    games: gamesOf(p.id, account, catalog).length,
  }));
  return ok({ people });
}

/** A friend write by the fixture account, as the API answers it. */
function friendWrite(method: string, pathname: string, body: unknown, circle: Circle): GalleryAnswer {
  const userId = typeof (body as { userId?: unknown })?.userId === "string" ? (body as { userId: string }).userId : "";
  if (method === "POST" && pathname === PeopleRoute.Requests) {
    if (circle.incoming.delete(userId)) circle.friends.add(userId);
    else circle.outgoing.add(userId);
    const user = PEOPLE.find((p) => p.id === userId) ?? person(userId);
    return ok({ status: circle.friends.has(userId) ? FriendStatus.Friends : FriendStatus.Outgoing, user: slim(user) });
  }
  const id = decodeURIComponent(pathname.split("/").at(pathname.endsWith("/accept") ? -2 : -1) ?? "");
  if (pathname.endsWith("/accept") && circle.incoming.delete(id)) circle.friends.add(id);
  else if (pathname.startsWith(PeopleRoute.request(""))) {
    circle.incoming.delete(id);
    circle.outgoing.delete(id);
  } else circle.friends.delete(id);
  return ok({ status: circle.friends.has(id) ? FriendStatus.Friends : FriendStatus.None, userId: id });
}

/** How many different people played a fixture person's games: about a third of their plays. */
function playersOf(games: unknown[]): number {
  const plays = games.reduce<number>((sum, game) => sum + Number((game as { playsCount?: number }).playsCount ?? 0), 0);
  return Math.round(plays * 0.36);
}

/** A profile: the person, their fixture games and how many people played them. */
function profile(id: string, account: FixtureAccount, catalog: FixtureCatalog): GalleryAnswer {
  const found = id === ME.id ? meSlim() : PEOPLE.find((p) => p.id === id);
  if (!found) return NOT_FOUND;
  const createdAt = id === ME.id ? ME.createdAt : (PEOPLE.find((p) => p.id === id)?.createdAt ?? ME.createdAt);
  const games = gamesOf(id, account, catalog);
  const user = { ...found, createdAt, githubUrl: null };
  return ok({ user, games, avatar: null, players: playersOf(games) });
}

/**
 * Someone's friends as the viewer sees them: the viewer's own friends first-class (`mutual`), and
 * a game shown only where the viewer is that friend's friend too.
 */
function profileFriends(id: string, account: FixtureAccount, catalog: FixtureCatalog): GalleryAnswer {
  if (id !== ME.id && !PEOPLE.some((p) => p.id === id)) return NOT_FOUND;
  const circle = circleOf(account);
  const ids = id === ME.id ? [...circle.friends] : friendsOf(id, circle);
  const friends = ids.map((friendId) => {
    const mutual = circle.friends.has(friendId);
    const shown = friendId === ME.id ? meSlim() : slim(byName(PEOPLE.find((p) => p.id === friendId)?.name ?? ""));
    return {
      ...shown,
      playing: mutual || id === ME.id ? (PLAYING[friendId] ?? null) : null,
      games: gamesOf(friendId, account, catalog).length,
      since: SINCE,
      mutual,
    };
  });
  return ok({ friends });
}

/** What the fixture's genex.games says of a normalized handle. */
function handleStateOf(handle: string): HandleState {
  const problem = handleProblem(handle);
  if (problem) return problem;
  if (handle === state.handle) return HandleState.Yours;
  if (KEPT_HANDLES.has(handle) || handle.includes(BRAND)) return HandleState.Reserved;
  return TAKEN_HANDLES.has(handle) ? HandleState.Taken : HandleState.Free;
}

/** Up to three handles the account may have instead of `wanted`: its name run together and dashed, then `wanted` numbered. */
function handleSuggestions(wanted: string): string[] {
  const words = state.name.split(/\s+/).map(handleBaseFromName).filter(Boolean);
  const numbered = [2, 3, 4, 5].map((n) => `${wanted}${n}`);
  const candidates = [words.join(""), words.join("-"), ...numbered];
  const offered = candidates.filter((handle) => handle !== wanted && handleKept(handleStateOf(handle)));
  return [...new Set(offered)].slice(0, HANDLE_SUGGESTIONS_MAX);
}

/** A handle check, as genex.games answers it: the state, and handles to try where there are any. */
function handleCheck(query: string): GalleryAnswer {
  const handle = normalizeHandleInput(new URLSearchParams(query).get("handle") ?? "");
  const checked = handleStateOf(handle);
  const latin = handleBaseFromName(handle);
  const latinOffer = checked === HandleState.LatinOnly && isHandle(latin) ? [latin] : [];
  const suggestions = shownAsTaken(checked) ? handleSuggestions(handle) : latinOffer;
  return ok({ handle, state: checked, suggestions });
}

/** Why a handle edit is refused, as genex.games answers it, or null when the handle may be the account's. */
function handleRefusal(raw: unknown): GalleryAnswer | null {
  const handle = typeof raw === "string" ? normalizeHandleInput(raw) : "";
  const problem = handleProblem(handle);
  if (problem) return { status: 400, body: { error: HandleError.Invalid, problem } };
  if (shownAsTaken(handleStateOf(handle)))
    return { status: 400, body: { error: HandleError.Taken, suggestions: handleSuggestions(handle) } };
  const changesLeft = state.handleChanges < FIXTURE_HANDLE_CHANGES;
  return handle === state.handle || changesLeft ? null : { status: 429, body: { error: HandleError.ChangesExhausted } };
}

/** The account's handle is `raw` now, confirmed even when it is the same one. */
function keepHandle(raw: string): void {
  const handle = normalizeHandleInput(raw);
  if (handle !== state.handle) state.handleChanges++;
  state.handle = handle;
  state.handleChosen = true;
}

/** Why an own-profile edit is refused, or null when every field it names may be written. */
function accountRefusal(body: {
  avatarStyle?: unknown;
  avatarVariant?: unknown;
  handle?: unknown;
}): GalleryAnswer | null {
  if (body.avatarStyle === AvatarStyle.Photo && !state.photo)
    return { status: 400, body: { error: "no photo uploaded" } };
  if (body.avatarVariant !== undefined && !isAvatarVariant(body.avatarVariant))
    return { status: 400, body: { error: "not an avatar variant" } };
  return body.handle === undefined ? null : handleRefusal(body.handle);
}

/** An own-profile edit, refused whole as genex.games refuses it: nothing changes when one field is wrong. */
function patchAccount(body: unknown): GalleryAnswer {
  const fields = (body ?? {}) as { name?: unknown; avatarStyle?: unknown; avatarVariant?: unknown; handle?: unknown };
  const refusal = accountRefusal(fields);
  if (refusal) return refusal;
  const { name, avatarStyle, avatarVariant, handle } = fields;
  if (typeof name === "string") state.name = name;
  if (isAvatarStyle(avatarStyle)) state.avatarStyle = avatarStyle;
  if (isAvatarVariant(avatarVariant)) state.avatarVariant = avatarVariant;
  if (typeof handle === "string") keepHandle(handle);
  return ok({ user: { ...meSlim(), handleChosen: state.handleChosen } });
}

/** The account's own writes: its name, its avatar style and variant, and a photo "upload" that stays in memory. */
function accountWrite(method: string, pathname: string, body: unknown): GalleryAnswer | null {
  if (method === "PATCH" && pathname === PeopleRoute.MyAccount) return patchAccount(body);
  if (method === "POST" && pathname === PeopleRoute.AvatarUpload)
    return ok({ uploadUrl: "https://fixture.invalid/avatar", key: `avatars/${ME.id}/fixture.webp` });
  if (method === "POST" && pathname === PeopleRoute.AvatarCommit) {
    state.photo = FIXTURE_PHOTO;
    return ok({ user: meSlim() });
  }
  return null;
}

/** The routes under /api/users and /api/friends that need the account. */
const needsAccount = (pathname: string): boolean =>
  pathname === PeopleRoute.Me ||
  pathname === PeopleRoute.HandleCheck ||
  pathname.startsWith("/api/friends") ||
  pathname.startsWith("/api/users/me");

/** A public read under /api/users: a profile or a profile's friends. */
function publicRead(pathname: string, account: FixtureAccount, catalog: FixtureCatalog): GalleryAnswer | null {
  const prefix = PeopleRoute.user("");
  const own = pathname.startsWith(PeopleRoute.MyAccount) || pathname === PeopleRoute.HandleCheck;
  if (!pathname.startsWith(prefix) || own) return null;
  const rest = pathname.slice(prefix.length);
  if (rest.endsWith("/friends"))
    return profileFriends(decodeURIComponent(rest.slice(0, -"/friends".length)), account, catalog);
  return rest.includes("/") ? NOT_FOUND : profile(decodeURIComponent(rest), account, catalog);
}

/** The fixture account a token signs in as while genex.games still takes it: an ended one is none. */
function takenAccount(token: string | undefined): FixtureAccount | null {
  const account = fixtureAccountOf(token);
  return account === FixtureAccount.Ended ? null : account;
}

/**
 * The fixture account's answer to a people route, or null when the route is not one of them (the
 * gallery's fixture answers it). Signed out, every people route but a public read is a 401.
 */
export function fixturePeopleAnswer(
  route: string,
  init: { method?: string; body?: unknown; token?: string },
  catalog: FixtureCatalog,
): GalleryAnswer | null {
  const [pathname = "", query = ""] = route.split("?");
  const method = init.method ?? "GET";
  const account = takenAccount(init.token);
  if (method === "GET") {
    const shown = publicRead(pathname, account ?? FixtureAccount.Full, catalog);
    if (shown) return shown;
  }
  if (!needsAccount(pathname)) return null;
  if (!account) return { status: 401, body: null };
  if (pathname === PeopleRoute.Me)
    return ok({
      user: {
        ...me(),
        image: state.photo,
        photo: state.photo,
        avatarStyle: state.avatarStyle,
        avatarVariant: state.avatarVariant,
        handleChosen: handleChosen(account),
      },
      isAdmin: false,
    });
  if (pathname === PeopleRoute.HandleCheck) return handleCheck(query);
  const write = accountWrite(method, pathname, init.body);
  if (write) return write;
  if (method === "GET") return peopleRead(pathname, query, account, catalog);
  if (method === "PATCH" && pathname === PeopleRoute.Visibility) {
    const visibility = (init.body as { presenceVisibility?: unknown })?.presenceVisibility;
    if (isPresenceVisibility(visibility)) state.visibility = visibility;
    return ok({ presenceVisibility: state.visibility });
  }
  return friendWrite(method, pathname, init.body, circleOf(account));
}

/** The fixture account's reads under /api/friends. */
function peopleRead(pathname: string, query: string, account: FixtureAccount, catalog: FixtureCatalog): GalleryAnswer {
  if (pathname === PeopleRoute.Friends) return friendsList(account, catalog);
  if (pathname === PeopleRoute.Requests) return requests(circleOf(account));
  if (pathname === PeopleRoute.Visibility) return ok({ presenceVisibility: state.visibility });
  if (pathname === PeopleRoute.Search) return search(new URLSearchParams(query).get("q") ?? "", account, catalog);
  if (pathname.startsWith(PeopleRoute.status("")))
    return ok({ status: statusOf(pathname.split("/").at(-1) ?? "", circleOf(account)) });
  return NOT_FOUND;
}

/** The fixture account's referral code: the inviter's proof its invite link carries. */
const FIXTURE_REFERRAL_CODE = "fixture1";

/**
 * The fixture account's invite and profile links, as `/api/referrals/me` answers them: by its
 * handle now, the invite with its code.
 */
export const fixtureReferral = () => ({
  code: FIXTURE_REFERRAL_CODE,
  link: `${PLAY_ORIGIN.web}/@${state.handle}/invite?${new URLSearchParams({ ref: FIXTURE_REFERRAL_CODE })}`,
  profileLink: `${PLAY_ORIGIN.web}/@${state.handle}`,
  inviterBonus: 100,
});

/** The fixture account's own id, for the fixture's creator numbers. */
export const FIXTURE_ME_ID = ME.id;
/** Fixture people as the API names a person, for Top creators. */
export const fixturePeople = () => PEOPLE.map(slim);
