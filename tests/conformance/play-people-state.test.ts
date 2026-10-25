/**
 * Play's people in the renderer: which page Play shows (a shelf, Friends, a profile and Back), and
 * what every list shows of a person after a press, a search typed over an older one, a refused
 * visibility change and a different account signing in. Driven through the pure transitions and
 * the store over a scripted API, with no DOM.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AvatarStyle,
  FriendAction,
  FriendStatus,
  type PlayFriendsPage,
  type PlayMe,
  type PlayPeopleResult,
  type PlayPerson,
  type PlayProfile,
  PresenceVisibility,
} from "../../src/shared/play-people.ts";
import { PlayShelf } from "../../src/shared/play.ts";
import type { StudioApi } from "../../src/shared/studio-api.ts";
import { GenexAccountStatus } from "../../src/shared/genex-account.ts";
import { type HandleSave, HandleSaveOutcome, HandleState } from "../../src/shared/handle.ts";
import type { PlayCredits } from "../../src/shared/play-credits.ts";
import { type KeyValueStorage, STORAGE_KEYS } from "../../src/renderer/storage.ts";
import {
  createPeopleStore,
  initialPeople,
  meRead,
  pageAfter,
  primaryAction,
  relationshipChanged,
  sidebarFriends,
  waitingRequests,
  withoutPresence,
} from "../../src/renderer/state/people.ts";
import {
  backFromProfile,
  friendsShown,
  initialPlay,
  PlayPage,
  profileShown,
  shelfChosen,
} from "../../src/renderer/state/play.ts";

const person = (id: string, name = id): PlayPerson => ({
  id,
  name,
  handle: null,
  imageUrl: null,
  avatarVariant: 0,
  pro: false,
});
const me = (id = "me"): PlayMe => ({
  ...person(id, "Rab Neba"),
  joinedAt: null,
  avatarStyle: AvatarStyle.Generated,
  photoUrl: null,
  avatarVariantKept: true,
  handleChosen: null,
});
/** A profile with nothing on it but its person. */
const profileOf = (who: PlayPerson, status: FriendStatus): PlayProfile => ({
  person: who,
  joinedAt: null,
  games: [],
  status,
  friends: null,
  players: null,
});

function page(overrides: Partial<PlayFriendsPage> = {}): PlayFriendsPage {
  return {
    friends: [{ ...person("ann"), playing: { slug: "stick-steel", title: "Stick & Steel" }, games: 2 }],
    incoming: [{ ...person("juno"), requestedAt: "2026-10-12T09:00:00.000Z" }],
    outgoing: [{ ...person("ola"), requestedAt: "2026-10-12T09:00:00.000Z" }],
    visibility: PresenceVisibility.Game,
    inviteLink: "https://genex.games/?ref=abc",
    inviteBonus: 100,
    ...overrides,
  };
}

const ids = (rows: Array<{ id: string }>): string[] => rows.map((row) => row.id);
/** A friend request from `id`. */
const request = (id: string) => ({ ...person(id), requestedAt: "2026-10-12T09:00:00.000Z" });

/** A promise the test settles. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type PeopleApi = Parameters<typeof createPeopleStore>[0];

/** The people calls, each answering what the test says, every call kept. */
function fakeApi(handlers: Partial<PeopleApi> = {}) {
  const calls: Array<[string, unknown]> = [];
  const record = <K extends keyof PeopleApi>(name: K, fallback: StudioApi[K]): StudioApi[K] =>
    ((...args: unknown[]) => {
      calls.push([name, args[0]]);
      return ((handlers[name] ?? fallback) as (...a: unknown[]) => unknown)(...args);
    }) as StudioApi[K];
  const api: PeopleApi = {
    playMe: record("playMe", async () => me()),
    playRename: record("playRename", async () => me()),
    playAvatar: record("playAvatar", async () => me()),
    playProfile: record("playProfile", async () => profileOf(person("x"), FriendStatus.None)),
    playFriends: record("playFriends", async () => page()),
    playFriend: record("playFriend", async () => FriendStatus.Friends),
    playPeople: record("playPeople", async () => ({ people: [], unavailable: false })),
    playVisibility: record("playVisibility", async (v: PresenceVisibility) => v),
    playAvatarStyle: record("playAvatarStyle", async () => me()),
    playAvatarVariant: record("playAvatarVariant", async (variant: number) => ({ ...me(), avatarVariant: variant })),
    playStats: record("playStats", async () => null),
    playCreators: record("playCreators", async () => null),
    playCredits: record("playCredits", async () => credits(1700)),
    storeCoins: record("storeCoins", async () => 1240),
    playSetHandle: record(
      "playSetHandle",
      async (handle: string): Promise<HandleSave> => ({
        outcome: HandleSaveOutcome.Saved,
        me: { ...me(), handle, handleChosen: true },
      }),
    ),
    genexAccount: record("genexAccount", async () => ({ status: GenexAccountStatus.SignedIn })),
    genexSignIn: record("genexSignIn", async () => ({ status: GenexAccountStatus.SigningIn, code: "ABCD-1234" })),
    genexCancelSignIn: record("genexCancelSignIn", async () => ({ status: GenexAccountStatus.SignedOut })),
    genexSignOut: record("genexSignOut", async () => ({ status: GenexAccountStatus.SignedOut })),
  };
  return { api, calls };
}

/** The account's credits as genex.games answers them: a balance and nothing else. */
const credits = (balance: number | null): PlayCredits => ({
  balance,
  unlimited: false,
  plan: null,
  inviteBonus: null,
  prices: {},
  recent: [],
});

/** A storage of this Mac's own, in memory. */
function memoryStorage(entries: Record<string, string> = {}): KeyValueStorage & { values: Map<string, string> } {
  const values = new Map(Object.entries(entries));
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  };
}
/** A storage that remembers `who` as the account last signed in on this Mac. */
const remembering = (who: PlayMe) => memoryStorage({ [STORAGE_KEYS.genexMe]: JSON.stringify(who) });
const offline = async (): Promise<never> => {
  throw new Error("fetch failed");
};

describe("Play's pages", () => {
  it("opens Friends and profiles from the sidebar, and Back goes where the profile was opened from", () => {
    let state = initialPlay();
    assert.equal(state.view.page, PlayPage.Shelf);
    state = friendsShown(state);
    state = profileShown(state, "ann");
    assert.deepEqual(state.view, { page: PlayPage.Profile, userId: "ann", from: PlayPage.Friends });
    // A profile opened from a profile goes back to where the first one came from.
    state = profileShown(state, "juno");
    assert.deepEqual(state.view, { page: PlayPage.Profile, userId: "juno", from: PlayPage.Friends });
    assert.equal(backFromProfile(state).view.page, PlayPage.Friends);
    const fromShelf = profileShown(initialPlay(), "ann");
    assert.equal(backFromProfile(fromShelf).view.page, PlayPage.Shelf);
  });

  it("goes back to a shelf's dashboard whenever a shelf is chosen, the same one too", () => {
    const onFriends = friendsShown(initialPlay());
    const games = shelfChosen(onFriends, PlayShelf.Games);
    assert.equal(games.view.page, PlayPage.Shelf);
    assert.equal(games.shelf, PlayShelf.Games);
    assert.equal(shelfChosen(games, PlayShelf.Games), games, "nothing changes on the shelf already shown");
  });
});

describe("what every list shows of a person after a press", () => {
  it("moves an accepted request into Friends, and a withdrawn one out of the requests", () => {
    const accepted = pageAfter(page(), person("juno"), FriendStatus.Friends);
    assert.deepEqual(ids(accepted.friends), ["ann", "juno"]);
    assert.deepEqual(ids(accepted.incoming), []);
    const withdrawn = pageAfter(page(), person("ola"), FriendStatus.None);
    assert.deepEqual(ids(withdrawn.outgoing), []);
    const removed = pageAfter(page(), person("ann"), FriendStatus.None);
    assert.deepEqual(ids(removed.friends), []);
    const asked = pageAfter(page(), person("milo"), FriendStatus.Outgoing);
    assert.deepEqual(ids(asked.outgoing), ["ola", "milo"]);
  });

  it("changes the profile and the search results showing them as well", () => {
    const result: PlayPeopleResult = {
      people: [{ ...person("milo"), status: FriendStatus.None, games: null }],
      unavailable: false,
    };
    const state = {
      ...initialPeople(),
      friends: page(),
      profiles: {
        milo: {
          status: "ready" as const,
          profile: profileOf(person("milo"), FriendStatus.None),
        },
      },
      search: { query: "mi", status: "ready" as const, result },
    };
    const after = relationshipChanged(state, person("milo"), FriendStatus.Outgoing);
    assert.equal(after.profiles.milo?.profile?.status, FriendStatus.Outgoing);
    assert.equal(after.search.result?.people[0]?.status, FriendStatus.Outgoing);
    assert.deepEqual(ids(after.friends?.outgoing ?? []), ["ola", "milo"]);
  });

  it("offers the one action that fits where someone stands", () => {
    assert.equal(primaryAction(FriendStatus.None), FriendAction.Add);
    assert.equal(primaryAction(FriendStatus.Incoming), FriendAction.Accept);
    assert.equal(primaryAction(FriendStatus.Outgoing), FriendAction.Withdraw);
    assert.equal(primaryAction(FriendStatus.Self), null);
    assert.equal(primaryAction(FriendStatus.Unavailable), null);
  });
});

describe("the people store", () => {
  it("forgets the last account's friends and profiles when another signs in, or nobody", () => {
    const signedIn = { ...meRead(initialPeople(), me("a")), friends: page() };
    assert.equal(waitingRequests(signedIn), 1);
    const other = meRead(signedIn, me("b"));
    assert.equal(other.friends, null);
    const out = meRead(signedIn, null);
    assert.equal(out.me, null);
    assert.equal(out.meKnown, true);
    assert.equal(waitingRequests(out), 0);
  });

  it("reads the Friends page only while signed in", async () => {
    const { api, calls } = fakeApi({
      playMe: async () => null,
      genexAccount: async () => ({ status: GenexAccountStatus.SignedOut }),
    });
    const store = createPeopleStore(api);
    await store.loadMe();
    await store.loadFriends();
    assert.deepEqual(
      calls.map(([name]) => name),
      ["playMe", "genexAccount"],
    );
  });

  it("moves a person at once on a press, then reads the Friends page again behind it", async () => {
    const reread = deferred<PlayFriendsPage>();
    const answers = [Promise.resolve(page()), reread.promise];
    const { api, calls } = fakeApi({ playFriends: (() => answers.shift()) as StudioApi["playFriends"] });
    const store = createPeopleStore(api);
    await store.loadMe();
    await store.loadFriends();
    await store.act(FriendAction.Accept, person("juno"));
    assert.deepEqual(ids(store.getState().friends?.friends ?? []), ["ann", "juno"], "at once, before Genex re-reads");
    reread.resolve(page({ friends: [], incoming: [] }));
    await reread.promise;
    await Promise.resolve();
    assert.deepEqual(ids(store.getState().friends?.friends ?? []), [], "then as Genex reads it");
    assert.deepEqual(calls.find(([name]) => name === "playFriend")?.[1], { action: "accept", userId: "juno" });
    assert.equal(calls.filter(([name]) => name === "playFriends").length, 2, "read again behind the press");
    assert.deepEqual(store.getState().busy, {}, "nobody waits once Genex answered");
  });

  it("keeps every list as it was when Genex refuses a press", async () => {
    const { api } = fakeApi({
      playFriend: async () => {
        throw new Error("403");
      },
    });
    const store = createPeopleStore(api);
    await store.loadMe();
    await store.loadFriends();
    await assert.rejects(store.act(FriendAction.Accept, person("juno")));
    assert.deepEqual(ids(store.getState().friends?.incoming ?? []), ["juno"]);
    assert.deepEqual(store.getState().busy, {});
  });

  it("lets an older search's late answer land nowhere", async () => {
    const slow = deferred<PlayPeopleResult>();
    const answers = [
      slow.promise,
      Promise.resolve({ people: [{ ...person("mira"), status: FriendStatus.None, games: 3 }], unavailable: false }),
    ];
    const { api } = fakeApi({ playPeople: (() => answers.shift()) as StudioApi["playPeople"] });
    const store = createPeopleStore(api);
    const first = store.search("mi");
    await store.search("mira");
    slow.resolve({ people: [{ ...person("milo"), status: FriendStatus.None, games: null }], unavailable: false });
    await first;
    assert.deepEqual(ids(store.getState().search.result?.people ?? []), ["mira"]);
    assert.equal(store.getState().search.query, "mira");
  });

  it("sends no search for a query too short to send", async () => {
    const { api, calls } = fakeApi();
    const store = createPeopleStore(api);
    await store.search(" m ");
    assert.equal(calls.length, 0);
    assert.equal(store.getState().search.result, null);
  });

  it("puts the visibility back when Genex refuses the change", async () => {
    const { api } = fakeApi({
      playVisibility: async () => {
        throw new Error("offline");
      },
    });
    const store = createPeopleStore(api);
    await store.loadMe();
    await store.loadFriends();
    await assert.rejects(store.setVisibility(PresenceVisibility.Hidden));
    assert.equal(store.getState().friends?.visibility, PresenceVisibility.Game);
  });

  it("keeps the account's own profile in step with a rename", async () => {
    const renamed = { ...me(), name: "Rab" };
    const { api } = fakeApi({
      playProfile: async () => profileOf(person("me", "Rab Neba"), FriendStatus.Self),
      playRename: async () => renamed,
    });
    const store = createPeopleStore(api);
    await store.loadMe();
    await store.loadProfile("me");
    await store.rename("Rab");
    assert.equal(store.getState().me?.name, "Rab");
    assert.equal(store.getState().profiles.me?.profile?.person.name, "Rab");
  });
});

describe("regenerating the account's avatar", () => {
  it("shows the new avatar at once, then as Genex keeps it", async () => {
    const kept = deferred<PlayMe | null>();
    const { api, calls } = fakeApi({ playAvatarVariant: () => kept.promise });
    const store = createPeopleStore(api);
    await store.loadMe();
    const pressed = store.setAvatarVariant(42);
    assert.equal(store.getState().me?.avatarVariant, 42, "at once, before Genex answers");
    kept.resolve({ ...me(), avatarVariant: 42 });
    await pressed;
    assert.equal(store.getState().me?.avatarVariant, 42);
    assert.deepEqual(calls.at(-1), ["playAvatarVariant", 42]);
  });

  it("shows what Genex kept when it refuses, and says so", async () => {
    const { api, calls } = fakeApi({ playAvatarVariant: async () => Promise.reject(new Error("refused")) });
    const store = createPeopleStore(api);
    await store.loadMe();
    await assert.rejects(store.setAvatarVariant(42), /refused/);
    assert.equal(store.getState().me?.avatarVariant, 0);
    assert.deepEqual(calls.at(-1)?.[0], "playMe", "read again, not guessed");
  });

  it("saves fast presses one after another, so the last press is what shows and what is kept", async () => {
    const first = deferred<PlayMe | null>();
    const second = deferred<PlayMe | null>();
    const answers = [first.promise, second.promise];
    const { api, calls } = fakeApi({ playAvatarVariant: () => answers.shift() ?? Promise.reject(new Error("extra")) });
    const store = createPeopleStore(api);
    await store.loadMe();
    const one = store.setAvatarVariant(1);
    const two = store.setAvatarVariant(2);
    assert.equal(store.getState().me?.avatarVariant, 2, "the newest press shows at once");
    await Promise.resolve();
    const saves = () => calls.filter(([name]) => name === "playAvatarVariant").map(([, variant]) => variant);
    assert.deepEqual(saves(), [1], "the second waits for the first");
    first.resolve({ ...me(), avatarVariant: 1 });
    await one;
    assert.equal(store.getState().me?.avatarVariant, 2, "an older answer never puts its face back");
    assert.deepEqual(saves(), [1, 2]);
    second.resolve({ ...me(), avatarVariant: 2 });
    await two;
    assert.equal(store.getState().me?.avatarVariant, 2);
  });

  it("says a regenerated avatar is being saved until every press's save ends, kept or refused", async () => {
    const first = deferred<PlayMe | null>();
    const second = deferred<PlayMe | null>();
    const answers = [first.promise, second.promise];
    const { api } = fakeApi({ playAvatarVariant: () => answers.shift() ?? Promise.reject(new Error("extra")) });
    const store = createPeopleStore(api);
    await store.loadMe();
    assert.equal(store.getState().avatarSaving, false, "nothing pressed");
    const one = store.setAvatarVariant(1);
    const two = store.setAvatarVariant(2);
    assert.equal(store.getState().avatarSaving, true, "at the press");
    first.resolve({ ...me(), avatarVariant: 1 });
    await one;
    assert.equal(store.getState().avatarSaving, true, "the second press still saves");
    second.reject(new Error("refused"));
    await assert.rejects(two, /refused/);
    assert.equal(store.getState().avatarSaving, false, "every save ended");
  });

  it("does not report an older press's refusal once a newer press is kept", async () => {
    const first = deferred<PlayMe | null>();
    const second = deferred<PlayMe | null>();
    const answers = [first.promise, second.promise];
    const { api } = fakeApi({ playAvatarVariant: () => answers.shift() ?? Promise.reject(new Error("extra")) });
    const store = createPeopleStore(api);
    await store.loadMe();
    const one = store.setAvatarVariant(1);
    const two = store.setAvatarVariant(2);
    first.reject(new Error("refused"));
    await one;
    second.resolve({ ...me(), avatarVariant: 2 });
    await two;
    assert.equal(store.getState().me?.avatarVariant, 2);
  });
});

describe("the account across sign-in, offline and a sign-in that ended", () => {
  it("shows the account remembered on this Mac at once, and keeps it while genex.games can't be reached", async () => {
    const storage = remembering(me("u1"));
    const { api } = fakeApi({ playMe: offline });
    const store = createPeopleStore(api, storage);
    assert.equal(store.getState().me?.id, "u1", "before anything is read");
    await store.loadMe();
    assert.equal(store.getState().me?.id, "u1", "offline is not signed out");
    assert.equal(store.getState().account, GenexAccountStatus.SignedIn);
    assert.equal(store.getState().meKnown, true);
  });

  it("remembers the account it read, and forgets it once signed out", async () => {
    const storage = memoryStorage();
    let status: GenexAccountStatus = GenexAccountStatus.SignedIn;
    const { api } = fakeApi({ genexAccount: async () => ({ status }) });
    const store = createPeopleStore(api, storage);
    await store.loadMe();
    assert.equal(JSON.parse(storage.values.get(STORAGE_KEYS.genexMe) ?? "null")?.id, "me");
    status = GenexAccountStatus.SignedOut;
    await store.loadMe();
    assert.equal(store.getState().me, null);
    assert.equal(storage.values.has(STORAGE_KEYS.genexMe), false);
  });

  it("keeps who it was for a sign-in genex.games ended, and nothing else of the account", async () => {
    const storage = memoryStorage();
    let ended = false;
    const { api } = fakeApi({
      playMe: async () => (ended ? null : me("u1")),
      genexAccount: async () => ({ status: ended ? GenexAccountStatus.Ended : GenexAccountStatus.SignedIn }),
    });
    const store = createPeopleStore(api, storage);
    await store.loadMe();
    await store.loadFriends();
    ended = true;
    await store.loadMe();
    const state = store.getState();
    assert.equal(state.account, GenexAccountStatus.Ended);
    assert.equal(state.me, null, "nothing reads as signed in");
    assert.equal(state.friends, null);
    assert.equal(state.ended?.id, "u1", "the plate still knows whose sign-in it was");
    assert.ok(storage.values.has(STORAGE_KEYS.genexMe), "and so does the next start");
  });

  it("starts with the remembered account dimmed when the sign-in ended while the app was closed", async () => {
    const { api } = fakeApi({
      playMe: async () => null,
      genexAccount: async () => ({ status: GenexAccountStatus.Ended }),
    });
    const store = createPeopleStore(api, remembering(me("u1")));
    await store.loadMe();
    assert.equal(store.getState().ended?.id, "u1");
    assert.equal(store.getState().me, null);
  });

  it("ignores a remembered account that isn't one", () => {
    for (const kept of ["{", "null", JSON.stringify({ id: "../x", name: "A" }), JSON.stringify({ ...me(), name: 7 })]) {
      const store = createPeopleStore(fakeApi().api, memoryStorage({ [STORAGE_KEYS.genexMe]: kept }));
      assert.equal(store.getState().me, null, kept);
    }
  });

  it("signs in in the browser, waits, then reads the account it signed in as", async () => {
    let status: GenexAccountStatus = GenexAccountStatus.SignedOut;
    const { api, calls } = fakeApi({ genexAccount: async () => ({ status }), playMe: async () => null });
    const store = createPeopleStore(api, memoryStorage());
    await store.loadMe();
    await store.signIn();
    assert.equal(store.getState().account, GenexAccountStatus.SigningIn);
    assert.equal(store.getState().signInCode, "ABCD-1234");
    status = GenexAccountStatus.SignedIn;
    api.playMe = async () => me("u2");
    await store.loadMe();
    assert.equal(store.getState().me?.id, "u2");
    assert.equal(store.getState().signInCode, null);
    assert.ok(calls.some(([name]) => name === "genexSignIn"));
  });

  it("reads the account again when the sign-in finishes between its two reads", async () => {
    // A development stand's sign-in finishes inside main's read of where the account stands: the
    // read of who it is, just before, still found no token.
    let token: string | null = null;
    const { api, calls } = fakeApi({
      playMe: async () => (token ? me("u3") : null),
      genexAccount: async () => {
        token = "minted";
        return { status: GenexAccountStatus.SignedIn };
      },
    });
    const store = createPeopleStore(api, memoryStorage());
    await store.loadMe();
    assert.equal(store.getState().account, GenexAccountStatus.SignedIn);
    assert.equal(store.getState().me?.id, "u3", "the plate fills in without another event");
    assert.deepEqual(
      calls.map(([name]) => name),
      ["playMe", "genexAccount", "playMe"],
    );
  });

  it("reads who it is once when the account is signed in from the start", async () => {
    const { api, calls } = fakeApi();
    const store = createPeopleStore(api, memoryStorage());
    await store.loadMe();
    assert.deepEqual(
      calls.map(([name]) => name),
      ["playMe", "genexAccount"],
    );
  });

  it("cancels a sign-in and signs out through main, signed out after", async () => {
    const { api, calls } = fakeApi();
    const store = createPeopleStore(api, memoryStorage());
    await store.loadMe();
    await store.signOut();
    assert.equal(store.getState().me, null);
    assert.equal(store.getState().account, GenexAccountStatus.SignedOut);
    await store.signIn();
    await store.cancelSignIn();
    assert.equal(store.getState().account, GenexAccountStatus.SignedOut);
    assert.deepEqual(
      calls.map(([name]) => name).filter((name) => name.startsWith("genex") && name !== "genexAccount"),
      ["genexSignOut", "genexSignIn", "genexCancelSignIn"],
    );
  });

  it("keeps the last known balance while genex.games can't be reached, and forgets it on sign-out", async () => {
    let reachable = true;
    const { api } = fakeApi({ playCredits: async () => (reachable ? credits(1700) : offline()) });
    const store = createPeopleStore(api, memoryStorage());
    await store.loadMe();
    await store.loadCredits();
    assert.equal(store.getState().credits?.balance, 1700);
    reachable = false;
    await store.loadCredits();
    assert.equal(store.getState().credits?.balance, 1700);
    await store.signOut();
    assert.equal(store.getState().credits, null);
  });
});

describe("the account's coin", () => {
  it("reads the coin Play shows, keeps the last one when a read fails, and forgets it on sign-out", async () => {
    let answer: () => Promise<number | null> = async () => 1240;
    const { api } = fakeApi({ storeCoins: () => answer() });
    const store = createPeopleStore(api, memoryStorage());
    assert.equal(store.getState().coins, null, "nothing before a read");
    await store.loadMe();
    await store.loadCoins();
    assert.equal(store.getState().coins, 1240);
    answer = async () => {
      throw new Error("offline");
    };
    await store.loadCoins();
    assert.equal(store.getState().coins, 1240, "a failed read keeps the last balance");
    answer = async () => null;
    await store.loadCoins();
    assert.equal(store.getState().coins, null, "coin off or signed out on genex.games shows none");
    answer = async () => 900;
    await store.loadCoins();
    await store.signOut();
    assert.equal(store.getState().coins, null);
  });

  it("lets a balance read for another account land nowhere", async () => {
    const slow = deferred<number | null>();
    const { api } = fakeApi({ storeCoins: () => slow.promise });
    const store = createPeopleStore(api, memoryStorage());
    await store.loadMe();
    const read = store.loadCoins();
    await store.signOut();
    slow.resolve(1240);
    await read;
    assert.equal(store.getState().coins, null);
  });
});

describe("the people store's reads in order", () => {
  it("lets an older Friends read that answers late land nowhere", async () => {
    const slow = deferred<PlayFriendsPage>();
    let reads = 0;
    const { api } = fakeApi({
      playFriends: () => {
        reads += 1;
        return reads === 1 ? slow.promise : Promise.resolve(page({ incoming: [] }));
      },
    });
    const store = createPeopleStore(api, memoryStorage());
    await store.loadMe();
    const first = store.loadFriends();
    await store.loadFriends();
    slow.resolve(page({ incoming: [request("old")] }));
    await first;
    assert.deepEqual(store.getState().friends?.incoming, [], "the newer read stays");
  });

  it("lets a read for another account land nowhere", async () => {
    const slow = deferred<PlayFriendsPage>();
    let who = "u1";
    const { api } = fakeApi({ playMe: async () => me(who), playFriends: () => slow.promise });
    const store = createPeopleStore(api, memoryStorage());
    await store.loadMe();
    const reading = store.loadFriends();
    who = "u2";
    await store.loadMe();
    slow.resolve(page({ incoming: [request("someone")] }));
    await reading;
    assert.equal(store.getState().me?.id, "u2");
    assert.equal(store.getState().friends, null, "u1's friends never show as u2's");
  });

  it("reads the account again when a write answers with no account, instead of hiding it", async () => {
    const { api, calls } = fakeApi({ playRename: async () => null });
    const store = createPeopleStore(api, memoryStorage());
    await store.loadMe();
    await store.rename("Someone");
    assert.equal(store.getState().me?.id, "me", "the plate stays until main says otherwise");
    assert.equal(calls.filter(([name]) => name === "playMe").length, 2);
  });

  it("changes nothing when a read brings the same account again", async () => {
    const storage = memoryStorage();
    const { api } = fakeApi();
    const store = createPeopleStore(api, storage);
    await store.loadMe();
    const shown = store.getState().me;
    let writes = 0;
    const setItem = storage.setItem.bind(storage);
    storage.setItem = (key, value) => {
      writes += 1;
      setItem(key, value);
    };
    await store.loadMe();
    assert.equal(store.getState().me, shown, "the same object: nothing re-renders");
    assert.equal(writes, 0, "and nothing is written again");
  });

  it("remembers the last balance on this Mac for an offline start, and forgets it on sign-out", async () => {
    const storage = memoryStorage();
    const first = createPeopleStore(fakeApi().api, storage);
    await first.loadMe();
    await first.loadCredits();
    const offlineStart = createPeopleStore(fakeApi({ playMe: offline, playCredits: offline }).api, storage);
    assert.equal(offlineStart.getState().credits?.balance, 1700, "before anything is read");
    await offlineStart.loadMe();
    await offlineStart.loadCredits();
    assert.equal(offlineStart.getState().credits?.balance, 1700);
    await offlineStart.signOut();
    assert.equal(storage.values.has(STORAGE_KEYS.genexCredits), false);
  });
});

describe("the Friends page offline", () => {
  it("shows nobody playing: no game, so no green ring, live dot or Join, and nothing else changes", () => {
    const online = page({
      friends: [
        { ...person("ann"), pro: true, playing: { slug: "stick-steel", title: "Stick & Steel" }, games: 2 },
        { ...person("bo"), playing: null, games: 0 },
      ],
    });
    const offline = withoutPresence(online);
    assert.deepEqual(
      offline.friends.map((friend) => [friend.id, friend.playing, friend.games, friend.pro]),
      [
        ["ann", null, 2, true],
        ["bo", null, 0, false],
      ],
    );
    assert.deepEqual(offline.incoming, online.incoming);
    assert.deepEqual(offline.outgoing, online.outgoing);
    assert.equal(online.friends[0]?.playing?.slug, "stick-steel", "the page as read is kept for when it is back");
    const quiet = page({ friends: [{ ...person("bo"), playing: null, games: 0 }] });
    assert.equal(withoutPresence(quiet), quiet, "nobody playing: the same page");
  });
});

describe("the sidebar's Friends", () => {
  it("shows nobody signed out, the heading alone until the page is read, then the friends in the API's order", () => {
    assert.equal(sidebarFriends(initialPeople(), true), null, "signed out: no Friends block");
    const signedIn = meRead(initialPeople(), me("a"));
    assert.deepEqual(sidebarFriends(signedIn, true), [], "signed in, nobody read yet: the heading alone");
    const read = page({
      friends: [
        { ...person("ann"), playing: { slug: "stick-steel", title: "Stick & Steel" }, games: 2 },
        { ...person("bo"), playing: null, games: 0 },
      ],
    });
    assert.deepEqual(ids(sidebarFriends({ ...signedIn, friends: read }, true) ?? []), ["ann", "bo"]);
    assert.deepEqual(sidebarFriends({ ...signedIn, friends: page({ friends: [] }) }, true), [], "requests only");
  });

  it("shows nobody playing offline, as the Friends page does", () => {
    const signedIn = { ...meRead(initialPeople(), me("a")), friends: page() };
    assert.equal(sidebarFriends(signedIn, true)?.[0]?.playing?.title, "Stick & Steel");
    assert.equal(sidebarFriends(signedIn, false)?.[0]?.playing, null);
  });
});

describe("the account's nickname", () => {
  it("reads an account remembered before nicknames as one with none, and keeps a remembered handle", () => {
    const { handle: _handle, handleChosen: _chosen, ...older } = me("u1");
    const before = createPeopleStore(fakeApi().api, memoryStorage({ [STORAGE_KEYS.genexMe]: JSON.stringify(older) }));
    assert.deepEqual(
      [before.getState().me?.id, before.getState().me?.handle, before.getState().me?.handleChosen],
      ["u1", null, null],
    );
    const kept = createPeopleStore(fakeApi().api, remembering({ ...me("u1"), handle: "rabneba", handleChosen: true }));
    assert.deepEqual([kept.getState().me?.handle, kept.getState().me?.handleChosen], ["rabneba", true]);
    const odd = createPeopleStore(fakeApi().api, remembering({ ...me("u1"), handle: "Rab Neba" }));
    assert.equal(odd.getState().me?.handle, null, "a handle that is not one is none");
  });

  it("shows a saved handle everywhere the account is, its own profile too", async () => {
    const { api, calls } = fakeApi({ playProfile: async () => profileOf(person("me", "Rab Neba"), FriendStatus.Self) });
    const store = createPeopleStore(api, memoryStorage());
    await store.loadMe();
    await store.loadProfile("me");
    const saved = await store.setHandle("rab-neba");
    assert.equal(saved.outcome, HandleSaveOutcome.Saved);
    assert.ok(calls.some(([method, handle]) => method === "playSetHandle" && handle === "rab-neba"));
    assert.equal(calls.at(-1)?.[0], "playFriends", "the invite link is the handle's: it is read again");
    assert.deepEqual([store.getState().me?.handle, store.getState().me?.handleChosen], ["rab-neba", true]);
    assert.equal(store.getState().profiles.me?.profile?.person.handle, "rab-neba");
  });

  it("changes nothing when genex.games refuses the handle, and says why", async () => {
    const refusal: HandleSave = {
      outcome: HandleSaveOutcome.Refused,
      check: { handle: "rab", state: HandleState.Taken, suggestions: ["rab2"] },
    };
    const { api } = fakeApi({ playSetHandle: async () => refusal });
    const store = createPeopleStore(api, memoryStorage());
    await store.loadMe();
    const before = store.getState();
    assert.deepEqual(await store.setHandle("rab"), refusal);
    assert.equal(store.getState(), before);
  });
});
