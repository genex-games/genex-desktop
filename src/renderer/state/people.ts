/**
 * Play's people in the renderer: the Genex account the app is signed in as, the Friends page as
 * last read, the profiles opened, what a people search found, the account's own stats (read only
 * when shown) and Top creators. Main reads them all from genex.games; a press on a person changes
 * how every list shows them at once (Accept moves the row into Friends), then the Friends page is
 * read again behind it. The account is the app's: main says where it stands (signed out, signing
 * in, signed in, or a sign-in genex.games ended), and the account last read is remembered on this
 * Mac, so an offline start still shows it. Only main saying it is signed out forgets it.
 */
import { createStore, type StoreApi } from "zustand/vanilla";
import { isAvatarVariant } from "../../shared/avatar-recipe.ts";
import { GenexAccountStatus, type GenexAccountView } from "../../shared/genex-account.ts";
import { type HandleSave, HandleSaveOutcome, isHandle } from "../../shared/handle.ts";
import type { PlayGame } from "../../shared/play.ts";
import type { PlayCredits } from "../../shared/play-credits.ts";
import {
  type AvatarStyle,
  FriendAction,
  FriendStatus,
  type PlayCreator,
  type PlayFoundPerson,
  type PlayFriend,
  type PlayFriendsPage,
  type PlayMe,
  type PlayPeopleResult,
  type PlayPerson,
  type PlayProfile,
  type PresenceVisibility,
  isAccountId,
  isAvatarStyle,
  peopleQuery,
} from "../../shared/play-people.ts";
import type { PlayStats, StatsPeriod } from "../../shared/play-stats.ts";
import type { StudioApi } from "../../shared/studio-api.ts";
import { browserStorage, type KeyValueStorage, readJson, removeKey, STORAGE_KEYS, writeJson } from "../storage.ts";

/** Where a read stands. */
export const LoadStatus = { Idle: "idle", Loading: "loading", Ready: "ready", Failed: "failed" } as const;
export type LoadStatus = (typeof LoadStatus)[keyof typeof LoadStatus];

/** A profile opened: its read, and the profile once it came. */
export interface ProfileEntry {
  status: LoadStatus;
  profile: PlayProfile | null;
}

/** The people search: what was typed, and what it found. */
export interface PeopleSearch {
  query: string;
  status: LoadStatus;
  result: PlayPeopleResult | null;
}

/** The account's stats for one period: its read, and the stats once they came. */
export interface StatsEntry {
  status: LoadStatus;
  stats: PlayStats | null;
  /** genex.games answered that it has no stats to give yet: the page shows what it can without them. */
  unavailable: boolean;
}

/** Play's Top creators: the read, and the row once it came (null while genex.games does not rank them). */
export interface CreatorsEntry {
  status: LoadStatus;
  list: PlayCreator[] | null;
}

/** The account's credits as the app last read them: kept while genex.games can't be reached. */
export type AccountCredits = Pick<PlayCredits, "balance" | "unlimited">;

/** What Play knows of people. */
export interface PeopleState {
  /**
   * The account the app is signed in as: as last read, or as remembered on this Mac while
   * genex.games can't be reached. Null signed out, signing in, or after a sign-in ended.
   */
  me: PlayMe | null;
  /** The account has been read once: a plate that is not there is signed out, not unknown. */
  meKnown: boolean;
  /** Where the account stands, as main last said; null before it was asked. */
  account: GenexAccountStatus | null;
  /** While a sign-in waits in the browser: the code the browser shows. */
  signInCode: string | null;
  /** Signed in with Genex's updated terms still to accept: the sidebar and the chat offer Review. */
  genexTermsPending: boolean;
  /** The account whose sign-in genex.games ended: the plate shows it dimmed, to sign in again. */
  ended: PlayMe | null;
  /** The balance as last read, or null before it was. */
  credits: AccountCredits | null;
  /** The coin the account may spend as last read, for the plate in Play; null before a read or with coin off. */
  coins: number | null;
  friends: PlayFriendsPage | null;
  friendsStatus: LoadStatus;
  profiles: Record<string, ProfileEntry>;
  /** People a press is changing, by id: their buttons wait. */
  busy: Record<string, true>;
  /** A regenerated avatar is being saved: what depends on it being kept (the welcome's Continue) waits. */
  avatarSaving: boolean;
  search: PeopleSearch;
  /** The account's stats by period, read only when a page shows them. */
  stats: Partial<Record<StatsPeriod, StatsEntry>>;
  creators: CreatorsEntry;
}

/** Nothing read yet. */
export const initialPeople = (): PeopleState => ({
  me: null,
  meKnown: false,
  account: null,
  signInCode: null,
  genexTermsPending: false,
  ended: null,
  credits: null,
  coins: null,
  friends: null,
  friendsStatus: LoadStatus.Idle,
  profiles: {},
  busy: {},
  avatarSaving: false,
  search: { query: "", status: LoadStatus.Idle, result: null },
  stats: {},
  creators: { status: LoadStatus.Idle, list: null },
});

/** Whether two reads of the account show the same thing: every field equal. */
function sameAccount(a: PlayMe | null, b: PlayMe | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const keys = Object.keys(a) as Array<keyof PlayMe>;
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

/** A game changed from a card's menu: every profile showing it shows `next`, or drops it (null). */
export function profileGameChanged(state: PeopleState, gameId: string, next: PlayGame | null): PeopleState {
  let changed = false;
  const profiles: PeopleState["profiles"] = {};
  for (const [id, entry] of Object.entries(state.profiles)) {
    const games = entry.profile?.games;
    const at = games?.findIndex((game) => game.id === gameId) ?? -1;
    if (!entry.profile || !games || at === -1) {
      profiles[id] = entry;
      continue;
    }
    changed = true;
    const kept = next ? games.with(at, next) : games.filter((game) => game.id !== gameId);
    profiles[id] = { ...entry, profile: { ...entry.profile, games: kept } };
  }
  return changed ? { ...state, profiles } : state;
}

/** The account was read: a different account (or none) forgets the last one's friends. */
export function meRead(state: PeopleState, me: PlayMe | null): PeopleState {
  const switched = state.me?.id !== me?.id;
  // The same account read again changes nothing: nothing re-renders, nothing is written again.
  if (!switched && state.meKnown && sameAccount(state.me, me)) return state;
  // Where the account stands is main's to say: a read of who it is keeps it.
  const kept = { account: state.account, signInCode: state.signInCode, ended: state.ended };
  return switched
    ? { ...initialPeople(), ...kept, me, meKnown: true }
    : { ...state, me, meKnown: true, profiles: withOwnProfile(state.profiles, me) };
}

/**
 * Main said where the account stands (`view`, or null when main did not answer) after genex.games
 * answered `me` (undefined when it could not be reached). Signed in, the account read shows, or
 * the one already shown stays while offline. A sign-in that ended keeps whose it was for the plate
 * and nothing else; signed out and signing in, there is no account.
 */
export function accountRead(
  state: PeopleState,
  view: GenexAccountView | null,
  me: PlayMe | null | undefined,
): PeopleState {
  if (!view) return state.meKnown ? state : { ...state, meKnown: true };
  const stands = { account: view.status, signInCode: view.code ?? null, genexTermsPending: view.termsPending === true };
  if (view.status === GenexAccountStatus.SignedIn) {
    const known = me ? meRead(state, me) : { ...state, meKnown: true };
    return { ...known, ...stands, ended: null };
  }
  const ended = view.status === GenexAccountStatus.Ended ? (state.me ?? state.ended) : null;
  return { ...meRead(state, null), ...stands, ended, credits: null, coins: null };
}

/**
 * An account remembered on this Mac, as it was kept, or null for anything that isn't one. One kept
 * before nicknames has none, and does not know whether it chose one.
 */
function rememberedAccount(value: unknown): PlayMe | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const picture = (url: unknown): url is string | null =>
    url === null || (typeof url === "string" && url.startsWith("https://"));
  const valid =
    isAccountId(v.id) &&
    typeof v.name === "string" &&
    v.name.trim() !== "" &&
    picture(v.imageUrl) &&
    picture(v.photoUrl) &&
    isAvatarVariant(v.avatarVariant) &&
    typeof v.pro === "boolean" &&
    (v.joinedAt === null || typeof v.joinedAt === "string") &&
    (v.avatarStyle === null || isAvatarStyle(v.avatarStyle)) &&
    typeof v.avatarVariantKept === "boolean";
  if (!valid) return null;
  const handle = isHandle(v.handle) ? v.handle : null;
  const handleChosen = typeof v.handleChosen === "boolean" ? v.handleChosen : null;
  return { ...(value as PlayMe), handle, handleChosen };
}

/** A balance remembered on this Mac, as it was kept, or null for anything that isn't one. */
function rememberedCredits(value: unknown): AccountCredits | null {
  if (!value || typeof value !== "object") return null;
  const { balance, unlimited } = value as Record<string, unknown>;
  const count = balance === null || (typeof balance === "number" && Number.isSafeInteger(balance) && balance >= 0);
  return count && typeof unlimited === "boolean" ? { balance: balance as number | null, unlimited } : null;
}

/** Signed out, or signing in afresh: there is no account on this Mac to remember. */
const noAccount = (state: PeopleState): boolean =>
  state.account === GenexAccountStatus.SignedOut || state.account === GenexAccountStatus.SigningIn;

/**
 * Keep the account where the next start finds it while offline: the one shown, or whose sign-in
 * ended, and its balance as last read.
 */
function rememberAccount(state: PeopleState, storage: KeyValueStorage | null): void {
  const who = state.me ?? state.ended;
  if (who) writeJson(STORAGE_KEYS.genexMe, who, storage);
  if (state.me && state.credits) writeJson(STORAGE_KEYS.genexCredits, state.credits, storage);
  if (who || !noAccount(state)) return;
  removeKey(STORAGE_KEYS.genexMe, storage);
  removeKey(STORAGE_KEYS.genexCredits, storage);
}

/** The account's own profile entry, kept in step with a rename or a new picture. */
function withOwnProfile(profiles: PeopleState["profiles"], me: PlayMe | null): PeopleState["profiles"] {
  const own = me ? profiles[me.id] : undefined;
  if (!me || !own?.profile) return profiles;
  const { id, name, handle, imageUrl, avatarVariant, pro } = me;
  const person = { id, name, handle, imageUrl, avatarVariant, pro };
  return { ...profiles, [me.id]: { ...own, profile: { ...own.profile, person } } };
}

/** The friends list once `friend` is (or is no longer) one. */
function friendsAfter(friends: PlayFriend[], friend: PlayFriend, status: FriendStatus): PlayFriend[] {
  if (status !== FriendStatus.Friends) return friends.filter((row) => row.id !== friend.id);
  return friends.some((row) => row.id === friend.id) ? friends : [...friends, friend];
}

/** The Friends page as one person's relationship changed: Accept moves them in, the rest move them out. */
export function pageAfter(page: PlayFriendsPage, person: PlayPerson, status: FriendStatus): PlayFriendsPage {
  const others = <T extends { id: string }>(rows: T[]): T[] => rows.filter((row) => row.id !== person.id);
  const friend: PlayFriend = {
    id: person.id,
    name: person.name,
    handle: person.handle,
    imageUrl: person.imageUrl,
    avatarVariant: person.avatarVariant,
    pro: person.pro,
    playing: null,
    games: null,
  };
  const sent = { ...friend, requestedAt: new Date().toISOString() };
  return {
    ...page,
    friends: friendsAfter(page.friends, friend, status),
    incoming: others(page.incoming),
    outgoing: status === FriendStatus.Outgoing ? [...others(page.outgoing), sent] : others(page.outgoing),
  };
}

/** Every list's view of `person` once their relationship is `status`. */
export function relationshipChanged(state: PeopleState, person: PlayPerson, status: FriendStatus): PeopleState {
  const entry = state.profiles[person.id];
  const profiles =
    entry?.profile && entry.profile.status !== status
      ? { ...state.profiles, [person.id]: { ...entry, profile: { ...entry.profile, status } } }
      : state.profiles;
  const result = state.search.result;
  const people = result?.people.map(
    (found): PlayFoundPerson => (found.id === person.id ? { ...found, status } : found),
  );
  const search = result && people ? { ...state.search, result: { ...result, people } } : state.search;
  const friends = state.friends ? pageAfter(state.friends, person, status) : null;
  return { ...state, profiles, search, friends };
}

/** A press on `id` started or ended. */
export function busyChanged(state: PeopleState, id: string, busy: boolean): PeopleState {
  if (Boolean(state.busy[id]) === busy) return state;
  const next = { ...state.busy };
  if (busy) next[id] = true;
  else delete next[id];
  return { ...state, busy: next };
}

/**
 * The Friends page as it shows offline: nobody's status is known, so nobody is playing (no green
 * ring, live dot or Join); everything else is the page as last read, which stays for when the Mac
 * is back online.
 */
export function withoutPresence(page: PlayFriendsPage): PlayFriendsPage {
  if (!page.friends.some((friend) => friend.playing)) return page;
  return { ...page, friends: page.friends.map((friend) => (friend.playing ? { ...friend, playing: null } : friend)) };
}

/** How many friend requests wait for the account's answer. */
export const waitingRequests = (state: PeopleState): number => state.friends?.incoming.length ?? 0;

/**
 * The friends the sidebar lists under the games, in the API's order (playing first): null signed
 * out (no Friends block), none until the Friends page is read, and nobody playing offline.
 */
export function sidebarFriends(state: Pick<PeopleState, "me" | "friends">, online: boolean): PlayFriend[] | null {
  if (!state.me) return null;
  if (!state.friends) return [];
  return (online ? state.friends : withoutPresence(state.friends)).friends;
}

/** The store and what it reads and writes. */
export interface PeopleStore extends StoreApi<PeopleState> {
  /** Read who the app is signed in as, and where the account stands. */
  loadMe(): Promise<void>;
  /** Sign in to Genex in the browser (again, after a sign-in ended). */
  signIn(): Promise<void>;
  /** Stop a sign-in waiting in the browser. */
  cancelSignIn(): Promise<void>;
  /** Sign out of Genex, the app and the Genex plugin together (the person confirmed in Studio first). */
  signOut(): Promise<void>;
  /** Read the account's balance; a failed read keeps the last one. */
  loadCredits(): Promise<void>;
  /** Read the coin the account may spend; a failed read keeps the last one. */
  loadCoins(): Promise<void>;
  /** Read the Friends page (signed in only). */
  loadFriends(): Promise<void>;
  /** Read someone's profile; `force` reads again one already read. */
  loadProfile(userId: string, options?: { force?: boolean }): Promise<void>;
  /** A game changed from a card's menu: the profiles showing it show the change. */
  gameChanged(gameId: string, next: PlayGame | null): void;
  /** Add, accept, withdraw or remove; throws when Genex refused it, and every list keeps what it showed. */
  act(action: FriendAction, person: PlayPerson): Promise<void>;
  /** Search people by name; an older search's answer that arrives late lands nowhere. */
  search(query: string): Promise<void>;
  rename(name: string): Promise<void>;
  setAvatar(webp: Uint8Array): Promise<void>;
  /** Show the generated avatar or the uploaded photo, everywhere; throws when Genex refused. */
  setAvatarStyle(style: AvatarStyle): Promise<void>;
  /**
   * Show another generated avatar, everywhere: at once on screen, then as genex.games keeps it;
   * throws (and puts the old one back) when Genex refused.
   */
  setAvatarVariant(variant: number): Promise<void>;
  /**
   * Make a nickname the account's, everywhere it shows; a refusal (taken, its shape, too many
   * changes) changes nothing and says why. Throws when genex.games could not be asked.
   */
  setHandle(handle: string): Promise<HandleSave>;
  /** Read the account's stats for a period (signed in only); `force` reads again one already read. */
  loadStats(days: StatsPeriod, options?: { force?: boolean }): Promise<void>;
  /** Read Top creators, once. */
  loadCreators(): Promise<void>;
  /** Show or hide the game the account is in; throws (and puts the old choice back) when Genex refused. */
  setVisibility(visibility: PresenceVisibility): Promise<void>;
}

type PeopleApi = Pick<
  StudioApi,
  | "playMe"
  | "playRename"
  | "playAvatar"
  | "playProfile"
  | "playFriends"
  | "playFriend"
  | "playPeople"
  | "playVisibility"
  | "playAvatarStyle"
  | "playAvatarVariant"
  | "playStats"
  | "playCreators"
  | "playCredits"
  | "storeCoins"
  | "playSetHandle"
  | "genexAccount"
  | "genexSignIn"
  | "genexCancelSignIn"
  | "genexSignOut"
>;

/** Replace the store's state with what a change makes of it. */
type PeopleSet = (change: (state: PeopleState) => PeopleState) => void;

/**
 * Regenerate's writes: each new variant shows at once and is saved after the one before it, so the
 * last press is the variant genex.games keeps. Only the newest press's answer lands: an older one
 * arriving behind it never puts its face back, and an older refusal is not reported, as a newer
 * press is what counts. When the newest is refused, the account is read again and shows what
 * genex.games kept. `avatarSaving` holds while any press's save runs.
 */
function avatarVariantWrites(
  store: StoreApi<PeopleState>,
  set: PeopleSet,
  api: Pick<PeopleApi, "playAvatarVariant" | "playMe">,
  answered: (me: PlayMe | null) => Promise<void>,
): (variant: number) => Promise<void> {
  let newest = 0;
  let saving = 0;
  let saved: Promise<unknown> = Promise.resolve();
  const setSaving = (change: number): void => {
    saving += change;
    set((state) => ({ ...state, avatarSaving: saving > 0 }));
  };
  return async (variant: number): Promise<void> => {
    const press = ++newest;
    const shown = store.getState().me;
    if (shown) set((state) => meRead(state, { ...shown, avatarVariant: variant }));
    setSaving(1);
    const write = saved.then(() => api.playAvatarVariant(variant));
    saved = write.catch(() => undefined);
    try {
      const me = await write;
      if (press === newest) await answered(me);
    } catch (error) {
      if (press !== newest) return;
      await answered(await api.playMe().catch(() => shown));
      throw error;
    } finally {
      setSaving(-1);
    }
  };
}

/** The account's stats and Top creators: read when a page shows them. */
function numberReads(store: StoreApi<PeopleState>, set: PeopleSet, api: Pick<PeopleApi, "playStats" | "playCreators">) {
  const loadStats = async (days: StatsPeriod, options: { force?: boolean } = {}): Promise<void> => {
    const known = store.getState().stats[days];
    if (!store.getState().me) return;
    if (known?.status === LoadStatus.Loading || (known?.status === LoadStatus.Ready && !options.force)) return;
    const keep = known ?? { stats: null, unavailable: false };
    const entry = (status: LoadStatus, change: Partial<StatsEntry> = {}): StatsEntry => ({
      ...keep,
      status,
      ...change,
    });
    set((state) => ({ ...state, stats: { ...state.stats, [days]: entry(LoadStatus.Loading) } }));
    try {
      const stats = await api.playStats(days);
      const read = entry(LoadStatus.Ready, { stats, unavailable: stats === null });
      set((state) => ({ ...state, stats: { ...state.stats, [days]: read } }));
    } catch {
      set((state) => ({ ...state, stats: { ...state.stats, [days]: entry(LoadStatus.Failed) } }));
    }
  };

  const loadCreators = async (): Promise<void> => {
    const known = store.getState().creators;
    if (known.status === LoadStatus.Loading || known.status === LoadStatus.Ready) return;
    set((state) => ({ ...state, creators: { ...state.creators, status: LoadStatus.Loading } }));
    try {
      const list = await api.playCreators();
      set((state) => ({ ...state, creators: { status: LoadStatus.Ready, list } }));
    } catch {
      set((state) => ({ ...state, creators: { ...state.creators, status: LoadStatus.Failed } }));
    }
  };

  return { loadStats, loadCreators };
}

/** The account's sign-in and sign-out through main, and its balance: each answer says where it stands. */
function accountCalls(
  store: StoreApi<PeopleState>,
  set: PeopleSet,
  api: Pick<PeopleApi, "playCredits" | "storeCoins" | "genexSignIn" | "genexCancelSignIn" | "genexSignOut">,
) {
  const stands = async (call: () => Promise<GenexAccountView>): Promise<void> => {
    const view = await call();
    set((state) => accountRead(state, view, undefined));
  };
  const loadCredits = async (): Promise<void> => {
    const asked = store.getState().me?.id;
    if (!asked) return;
    try {
      const { balance, unlimited } = await api.playCredits();
      // A balance read for another account lands nowhere.
      set((state) => (state.me?.id === asked ? { ...state, credits: { balance, unlimited } } : state));
    } catch {
      // Offline or Genex down: the last balance stays.
    }
  };
  const loadCoins = async (): Promise<void> => {
    const asked = store.getState().me?.id;
    if (!asked) return;
    try {
      const coins = await api.storeCoins();
      // A balance read for another account, or after a sign-out, lands nowhere.
      set((state) => (state.me?.id === asked ? { ...state, coins } : state));
    } catch {
      // The read never reached main: the last balance stays.
    }
  };
  return {
    signIn: () => stands(api.genexSignIn),
    cancelSignIn: () => stands(api.genexCancelSignIn),
    signOut: () => stands(api.genexSignOut),
    loadCredits,
    loadCoins,
  };
}

/**
 * The Friends page and the people search: reads where only the newest answer, for the account that
 * asked, lands; a press on a person, and whether friends see the game the account is in.
 */
function friendCalls(
  store: StoreApi<PeopleState>,
  set: PeopleSet,
  api: Pick<PeopleApi, "playFriends" | "playFriend" | "playPeople" | "playVisibility">,
) {
  let searches = 0;
  /** Counts Friends reads: only the newest read's answer lands. */
  let friendsReads = 0;

  const loadFriends = async (): Promise<void> => {
    const asked = store.getState().me?.id;
    if (!asked) return;
    const read = ++friendsReads;
    // An answer for an older read, or for another account, lands nowhere.
    const landing = (state: PeopleState): boolean => read === friendsReads && state.me?.id === asked;
    set((state) => (state.friends ? state : { ...state, friendsStatus: LoadStatus.Loading }));
    try {
      const friends = await api.playFriends();
      set((state) => (landing(state) ? { ...state, friends, friendsStatus: LoadStatus.Ready } : state));
    } catch {
      const failed = (state: PeopleState) => (state.friends ? LoadStatus.Ready : LoadStatus.Failed);
      set((state) => (landing(state) ? { ...state, friendsStatus: failed(state) } : state));
    }
  };

  const act = async (action: FriendAction, person: PlayPerson): Promise<void> => {
    set((state) => busyChanged(state, person.id, true));
    try {
      const status = await api.playFriend({ action, userId: person.id });
      set((state) => relationshipChanged(state, person, status));
    } finally {
      set((state) => busyChanged(state, person.id, false));
    }
    void loadFriends();
  };

  const search = async (query: string): Promise<void> => {
    searches += 1;
    const mine = searches;
    const q = peopleQuery(query);
    if (!q) {
      set((state) => ({ ...state, search: { query, status: LoadStatus.Idle, result: null } }));
      return;
    }
    set((state) => ({ ...state, search: { ...state.search, query, status: LoadStatus.Loading } }));
    try {
      const result = await api.playPeople(q);
      if (mine === searches) set((state) => ({ ...state, search: { query, status: LoadStatus.Ready, result } }));
    } catch {
      if (mine === searches) set((state) => ({ ...state, search: { query, status: LoadStatus.Failed, result: null } }));
    }
  };

  const setVisibility = async (visibility: PresenceVisibility): Promise<void> => {
    const before = store.getState().friends?.visibility;
    const show = (value: PresenceVisibility | undefined) =>
      set((state) => (state.friends && value ? { ...state, friends: { ...state.friends, visibility: value } } : state));
    show(visibility);
    try {
      show(await api.playVisibility(visibility));
    } catch (error) {
      show(before);
      throw error;
    }
  };

  return { loadFriends, act, search, setVisibility };
}

/** Someone's profile, read once unless forced; a failed read keeps what was shown. */
function profileReads(store: StoreApi<PeopleState>, set: PeopleSet, api: Pick<PeopleApi, "playProfile">) {
  return async (userId: string, options: { force?: boolean } = {}): Promise<void> => {
    const known = store.getState().profiles[userId];
    if (known?.status === LoadStatus.Loading || (known?.status === LoadStatus.Ready && !options.force)) return;
    const loading: ProfileEntry = { status: LoadStatus.Loading, profile: known?.profile ?? null };
    set((state) => ({ ...state, profiles: { ...state.profiles, [userId]: loading } }));
    try {
      const profile = await api.playProfile(userId);
      set((state) => ({ ...state, profiles: { ...state.profiles, [userId]: { status: LoadStatus.Ready, profile } } }));
    } catch {
      const failed: ProfileEntry = { status: LoadStatus.Failed, profile: known?.profile ?? null };
      set((state) => ({ ...state, profiles: { ...state.profiles, [userId]: failed } }));
    }
  };
}

/** The store, starting from the account (and its balance) remembered in `storage`, which it keeps up to date. */
function rememberingStore(storage: KeyValueStorage | null): StoreApi<PeopleState> {
  const remembered = rememberedAccount(readJson<unknown>(STORAGE_KEYS.genexMe, null, storage));
  const balance = remembered ? rememberedCredits(readJson<unknown>(STORAGE_KEYS.genexCredits, null, storage)) : null;
  const store = createStore<PeopleState>()(() => ({ ...initialPeople(), me: remembered, credits: balance }));
  // A rename, a new picture or a balance is remembered as it shows, as is a sign-in or a sign-out.
  store.subscribe((state, before) => {
    const changed =
      state.me !== before.me ||
      state.ended !== before.ended ||
      state.account !== before.account ||
      state.credits !== before.credits;
    if (changed) rememberAccount(state, storage);
  });
  return store;
}

/** People's store over `api`, remembering the account in `storage` for an offline start. */
export function createPeopleStore(api: PeopleApi, storage: KeyValueStorage | null = browserStorage()): PeopleStore {
  const store = rememberingStore(storage);
  const set = (change: (state: PeopleState) => PeopleState) => store.setState(change, true);

  const loadMe = async (): Promise<void> => {
    // Undefined: genex.games could not be reached, which is not the same as signed out.
    const me = await api.playMe().catch(() => undefined);
    // Asked after: a refused token reads as a sign-in that ended only once genex.games refused it.
    const view = await api.genexAccount().catch(() => null);
    // A sign-in can finish inside that second read (a development stand's does): who it is was read
    // before there was a token, so it is read again rather than left empty until some other event.
    const signedInSince = me === null && view?.status === GenexAccountStatus.SignedIn;
    const who = signedInSince ? await api.playMe().catch(() => undefined) : me;
    set((state) => accountRead(state, view, who));
  };

  /** A write answered with the account, or with none (genex.games refused it): then main says where it stands. */
  const accountAnswered = async (me: PlayMe | null): Promise<void> => {
    if (me) set((state) => meRead(state, me));
    else await loadMe();
  };

  const friends = friendCalls(store, set, api);
  return Object.assign(store, {
    loadMe,
    ...accountCalls(store, set, api),
    ...numberReads(store, set, api),
    ...friends,
    loadProfile: profileReads(store, set, api),
    gameChanged: (gameId: string, next: PlayGame | null) => set((state) => profileGameChanged(state, gameId, next)),
    rename: async (name: string) => accountAnswered(await api.playRename(name)),
    setAvatar: async (webp: Uint8Array) => accountAnswered(await api.playAvatar(webp)),
    setAvatarStyle: async (style: AvatarStyle) => accountAnswered(await api.playAvatarStyle(style)),
    setAvatarVariant: avatarVariantWrites(store, set, api, accountAnswered),
    setHandle: async (handle: string): Promise<HandleSave> => {
      const saved = await api.playSetHandle(handle);
      if (saved.outcome !== HandleSaveOutcome.Saved) return saved;
      await accountAnswered(saved.me);
      // The invite link is the handle's (`/@<handle>/invite`): read the new one rather than hand out the old.
      void friends.loadFriends();
      return saved;
    },
  });
}

/** The action a person's main button runs from where they stand with the account. */
export function primaryAction(status: FriendStatus): FriendAction | null {
  if (status === FriendStatus.None) return FriendAction.Add;
  if (status === FriendStatus.Incoming) return FriendAction.Accept;
  if (status === FriendStatus.Outgoing) return FriendAction.Withdraw;
  return null;
}
