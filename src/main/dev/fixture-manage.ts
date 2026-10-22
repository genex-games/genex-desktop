/**
 * A published game's card menu in a fixture profile: genex.games' answers to turning remixing off or
 * on, Unpublish, Delete, a new cover, the mobile flag and tags, made here in the API's shapes, so the
 * menu and its dialogs can be checked with no socket. The game's own author (the fixture account) and
 * the `admin` fixture account may change a game; the mobile flag answers the admin alone. One of the
 * account's games ("claude-of-duty") lives in its own repository, so turning its remixing on is
 * refused as genex.games refuses it. State lives for the launch: a change shows on the next read and
 * is gone at the next launch.
 */
import type { GalleryAnswer } from "../play/gallery.ts";
import { ManageError, ManageRoute } from "../play/manage.ts";
import {
  isPlayCoverType,
  isPlayMobileSupport,
  isTaggedCategories,
  PLAY_COVER_MAX_BYTES,
  type PlayMobileSupport,
} from "../../shared/play-manage.ts";
import { FIXTURE_ME_ID, FixtureAccount, takenAccount } from "./fixture-people.ts";

/** A fixture gallery item, as the card menu's routes read and change it. */
export interface FixtureListing {
  id: string;
  slug: string;
  thumbnailUrl: string | null;
  private: boolean;
  author: { id: string };
}

/** The fixture game whose source is its owner's own repository: genex.games cannot open it to remixes. */
const OWN_REPO_SLUG = "claude-of-duty";
/** Where a fixture cover "upload" goes: nowhere, since the fixture's upload never opens a socket. */
const FIXTURE_UPLOAD_URL = "https://fixture.invalid/cover";

const ok = (body: unknown): GalleryAnswer => ({ status: 200, body });
const BAD_REQUEST: GalleryAnswer = { status: 400, body: { error: "bad_request" } };
const SIGNED_OUT: GalleryAnswer = { status: 401, body: null };
const FORBIDDEN: GalleryAnswer = { status: 403, body: { error: "forbidden" } };
const NOT_FOUND: GalleryAnswer = { status: 404, body: null };
/** What genex.games answers when remixing cannot be turned on: the source is the owner's own repository. */
const OWN_REPO: GalleryAnswer = {
  status: 409,
  body: { error: ManageError.ExternalRepo, message: "This game's source is its owner's own repository." },
};

/** What the launch changed about one game. */
interface ListingEdit {
  mobileSupport?: PlayMobileSupport | null;
  categories?: string[];
  private?: boolean;
  thumbnailUrl?: string;
}

/** The launch's changes to the catalog: each game's edits, and what was taken down. */
interface LaunchState {
  listings: readonly FixtureListing[];
  newCover: (id: string) => string;
  edits: Map<string, ListingEdit>;
  removed: Set<string>;
}

/** What one of a game's routes does to the launch, given the call's body. */
type Run = (state: LaunchState, listing: FixtureListing, body: Record<string, unknown>) => GalleryAnswer;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const edit = (state: LaunchState, id: string, change: ListingEdit): void => {
  state.edits.set(id, { ...state.edits.get(id), ...change });
};

const setMobile: Run = (state, listing, { mobileSupport }) => {
  if (mobileSupport !== null && !isPlayMobileSupport(mobileSupport)) return BAD_REQUEST;
  edit(state, listing.id, { mobileSupport });
  return ok({ project: { id: listing.id, mobileSupport } });
};

const setCategories: Run = (state, listing, { categories }) => {
  if (!isTaggedCategories(categories)) return BAD_REQUEST;
  edit(state, listing.id, { categories: [...categories] });
  return ok({ project: { id: listing.id, categories } });
};

const setVisibility: Run = (state, listing, body) => {
  if (typeof body.private !== "boolean") return BAD_REQUEST;
  if (listing.slug === OWN_REPO_SLUG && !body.private) return OWN_REPO;
  edit(state, listing.id, { private: body.private });
  return ok({ project: { id: listing.id, private: body.private } });
};

/** Unpublish or delete: the game leaves the feed, its profile and search for the launch. */
const takeDown: Run = (state, listing) => {
  state.removed.add(listing.id);
  return ok({ project: { id: listing.id, published: false } });
};

const coverSlot: Run = (_state, listing, { bytes, contentType }) => {
  const sized = typeof bytes === "number" && Number.isInteger(bytes) && bytes >= 1 && bytes <= PLAY_COVER_MAX_BYTES;
  if (!sized || !isPlayCoverType(contentType)) return BAD_REQUEST;
  return ok({ uploadUrl: FIXTURE_UPLOAD_URL, key: `covers/${listing.id}/fixture` });
};

const commitCover: Run = (state, listing, { key }) => {
  if (typeof key !== "string" || !key) return BAD_REQUEST;
  const coverUrl = state.newCover(listing.id);
  edit(state, listing.id, { thumbnailUrl: coverUrl });
  return ok({ applied: true, coverUrl, coverSource: "upload" });
};

/** Each of a game's routes: its method, whether only an admin may call it, and what it does. */
const ACTIONS: ReadonlyArray<{ route: (id: string) => string; method: string; admin: boolean; run: Run }> = [
  { route: ManageRoute.mobile, method: "PATCH", admin: true, run: setMobile },
  { route: ManageRoute.categories, method: "PATCH", admin: false, run: setCategories },
  { route: ManageRoute.visibility, method: "PATCH", admin: false, run: setVisibility },
  { route: ManageRoute.unpublish, method: "POST", admin: false, run: takeDown },
  { route: ManageRoute.project, method: "DELETE", admin: false, run: takeDown },
  { route: ManageRoute.coverUpload, method: "POST", admin: false, run: coverSlot },
  { route: ManageRoute.coverCommit, method: "POST", admin: false, run: commitCover },
];

/** The game and the action a call names, or null when it names none of them. */
function target(state: LaunchState, pathname: string, method: string) {
  for (const listing of state.listings)
    for (const action of ACTIONS)
      if (action.method === method && action.route(listing.id) === pathname) return { listing, action };
  return null;
}

/**
 * The answer to a card-menu route, or null when the route is none of them. Signed out (or ended)
 * every one is a 401; the mobile flag is a 403 for any account but the admin, the other routes for
 * any but the game's own and the admin.
 */
function answerFor(
  state: LaunchState,
  route: string,
  init: { method?: string; body?: unknown; token?: string },
): GalleryAnswer | null {
  const [pathname = ""] = route.split("?");
  const found = target(state, pathname, init.method ?? "GET");
  if (!found) return null;
  const account = takenAccount(init.token);
  if (!account) return SIGNED_OUT;
  if (state.removed.has(found.listing.id)) return NOT_FOUND;
  const admin = account === FixtureAccount.Admin;
  const own = found.listing.author.id === FIXTURE_ME_ID;
  const allowed = admin || (own && !found.action.admin);
  if (!allowed) return FORBIDDEN;
  return found.action.run(state, found.listing, isObject(init.body) ? init.body : {});
}

/**
 * The card menu's routes over a fixture catalog's `listings` (as the catalog draws them before any
 * change), `newCover` drawing the picture a cover "upload" leaves for a game: `answer` for a call,
 * `shown` for the games still published, each as the launch shows it.
 */
export function createFixtureManage(listings: readonly FixtureListing[], newCover: (id: string) => string) {
  const state: LaunchState = { listings, newCover, edits: new Map(), removed: new Set() };
  return {
    answer: (route: string, init: { method?: string; body?: unknown; token?: string }) => answerFor(state, route, init),
    shown: <T extends FixtureListing>(items: readonly T[]): T[] =>
      items.filter((item) => !state.removed.has(item.id)).map((item) => ({ ...item, ...state.edits.get(item.id) })),
  };
}
