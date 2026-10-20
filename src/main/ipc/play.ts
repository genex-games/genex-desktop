/** Play: genex.games' catalog for the dashboard, the full-screen viewer a game opens in, and people. */
import { isAvatarVariant } from "../../shared/avatar-recipe.ts";
import { isPlayShelf, isPlaySlug, PlayShelf, type PlayPoint, readPlayPoint } from "../../shared/play.ts";
import { isAccountId, isAvatarStyle, isFriendAction, isPresenceVisibility } from "../../shared/play-people.ts";
import { isStatsPeriod } from "../../shared/play-stats.ts";
import { isPlayCoverType, isPlayGameChange, isPlayGameId } from "../../shared/play-manage.ts";
import type { CreatorStats } from "../play/creator-stats.ts";
import type { GenexCredits } from "../play/credits.ts";
import type { PlayGallery, PlayWorld } from "../play/gallery.ts";
import type { PlayManage } from "../play/manage.ts";
import { onWebsite } from "../play/origins.ts";
import type { PlayPeople } from "../play/people.ts";
import type { PlayViewer } from "../play/viewer.ts";
import type { IpcHandle } from "./registrar.ts";

const MESSAGE = {
  badSlug: "not a game address",
  noWindow: "the window is not open",
  badAccount: "not a Genex account",
  badAction: "not a friend action",
  badVisibility: "not a visibility",
  badPicture: "not a picture",
  badStyle: "not an avatar style",
  badVariant: "not an avatar variant",
  badPeriod: "not a stats period",
  badShare: "not a page of the website Play links to",
  badGame: "not a published game",
  badChange: "not a change the card menu makes",
  badCoverType: "not a cover picture type",
} as const;

/** What Play's channels answer from. */
export interface PlayIpcDeps {
  gallery: PlayGallery;
  /** Copy a game's public source into a new game; answers its library name. */
  remix(world: PlayWorld): Promise<string>;
  /** The viewer in the studio window; null while there is none. */
  viewer(): PlayViewer | null;
  people: PlayPeople;
  creators: CreatorStats;
  credits: GenexCredits;
  /** A published game's card menu: the owner's items, and the mobile flag and tags an admin sets. */
  manage: PlayManage;
  /** The website Play links to: only its pages (an invite, a profile) go to the share menu. */
  web: string;
  /** Pop the Mac's share menu for `url` in the studio window, by `at` when it is known. */
  share(url: string, at: PlayPoint | undefined): void;
}

/** Register Play's channels: the catalog's reads, Remix and the viewer. */
export function registerPlayIpc(handle: IpcHandle, deps: PlayIpcDeps): void {
  const { gallery, remix, viewer, people, creators, credits, web, share } = deps;
  registerPeopleIpc(handle, people);
  registerManageIpc(handle, deps.manage);
  // Share… hands the Mac's share menu a page of Play's website and nothing else.
  handle("studio:play.share", async (payload) => {
    const url = String(payload?.url ?? "");
    if (!onWebsite(url, web)) throw new Error(MESSAGE.badShare);
    share(url, readPlayPoint(payload?.at));
  });
  handle("studio:play.stats", (payload) => {
    if (!isStatsPeriod(payload?.days)) throw new Error(MESSAGE.badPeriod);
    return creators.stats(payload.days);
  });
  handle("studio:play.creators", () => creators.topCreators());
  handle("studio:play.credits", () => credits.credits());
  handle("studio:play.feed", (payload) => gallery.feed({ category: payload?.category, cursor: payload?.cursor }));
  // Play's dashboard asks first: the viewer's bar gets ready for the game it may open.
  handle("studio:play.shelves", () => {
    viewer()?.warm();
    return gallery.shelves();
  });
  handle("studio:play.catalog", () => gallery.mentionItems());
  handle("studio:play.search", (payload) =>
    gallery.search(String(payload?.query ?? ""), isPlayShelf(payload?.shelf) ? payload.shelf : PlayShelf.Games),
  );
  // A card's Remix: main reads the game's own page for its source, never an address from the renderer.
  // While one is made, the viewer's Remix waits.
  handle("studio:play.remix", async (payload) => {
    if (!isPlaySlug(payload?.slug)) throw new Error(MESSAGE.badSlug);
    viewer()?.remixing(true);
    try {
      return await remix(await gallery.world(payload.slug));
    } finally {
      viewer()?.remixing(false);
    }
  });
  handle("studio:play.online", (payload) => gallery.online(Array.isArray(payload?.slugs) ? payload.slugs : []));
  // The renderer names a game by its slug; main builds every address from it.
  handle("studio:play.open", async (payload) => {
    if (!isPlaySlug(payload?.slug)) throw new Error(MESSAGE.badSlug);
    const shown = viewer();
    if (!shown) throw new Error(MESSAGE.noWindow);
    shown.open(payload.slug, payload.title);
  });
  handle("studio:play.close", async () => viewer()?.close());
  // The bar names a control (and where it is, for a menu); the viewer acts only on one it knows.
  handle("studio:play.control", async (payload) => viewer()?.control(payload?.control, readPlayPoint(payload?.at)));
  handle("studio:play.bar", async (payload) => viewer()?.hold(payload));
  // The purchase sheet's answer: the viewer reads it, and pays or cancels only the purchase it holds.
  handle("studio:play.purchase", async (payload) => viewer()?.answerPurchase(payload));
  registerCommentsIpc(handle, viewer);
}

/** The viewed game's comments: always the game on screen, never one the renderer names. */
function registerCommentsIpc(handle: IpcHandle, viewer: PlayIpcDeps["viewer"]): void {
  const shown = (): PlayViewer => {
    const open = viewer();
    if (!open) throw new Error(MESSAGE.noWindow);
    return open;
  };
  handle("studio:play.comments", (payload) => shown().comments(payload?.cursor));
  handle("studio:play.comment", (payload) => shown().comment(payload?.body));
  handle("studio:play.uncomment", (payload) => shown().uncomment(payload?.commentId));
}

/** A game's card menu: every id, change and picture type is checked here, a picture's bytes again in `manage`. */
function registerManageIpc(handle: IpcHandle, manage: PlayManage): void {
  handle("studio:play.manage", (payload) => {
    if (!isPlayGameId(payload?.gameId)) throw new Error(MESSAGE.badGame);
    if (!isPlayGameChange(payload.change)) throw new Error(MESSAGE.badChange);
    return manage.change(payload.gameId, payload.change);
  });
  handle("studio:play.cover", (payload) => {
    if (!isPlayGameId(payload?.gameId)) throw new Error(MESSAGE.badGame);
    if (!(payload.image instanceof Uint8Array)) throw new Error(MESSAGE.badPicture);
    if (!isPlayCoverType(payload.contentType)) throw new Error(MESSAGE.badCoverType);
    return manage.cover(payload.gameId, payload.image, payload.contentType);
  });
}

/** Play's people: the account, profiles and friends. Every id and choice is checked here, names and pictures in `people`. */
function registerPeopleIpc(handle: IpcHandle, people: PlayPeople): void {
  handle("studio:play.me", () => people.me());
  handle("studio:play.rename", (payload) => people.rename(String(payload?.name ?? "")));
  handle("studio:play.avatar", (payload) => {
    if (!(payload?.webp instanceof Uint8Array)) throw new Error(MESSAGE.badPicture);
    return people.setAvatar(payload.webp);
  });
  handle("studio:play.avatarStyle", (payload) => {
    if (!isAvatarStyle(payload?.style)) throw new Error(MESSAGE.badStyle);
    return people.setAvatarStyle(payload.style);
  });
  handle("studio:play.avatarVariant", (payload) => {
    if (!isAvatarVariant(payload?.variant)) throw new Error(MESSAGE.badVariant);
    return people.setAvatarVariant(payload.variant);
  });
  handle("studio:play.profile", (payload) => {
    if (!isAccountId(payload?.userId)) throw new Error(MESSAGE.badAccount);
    return people.profile(payload.userId);
  });
  handle("studio:play.friends", () => people.friends());
  handle("studio:play.friend", (payload) => {
    if (!isFriendAction(payload?.action)) throw new Error(MESSAGE.badAction);
    if (!isAccountId(payload?.userId)) throw new Error(MESSAGE.badAccount);
    return people.act(payload.action, payload.userId);
  });
  handle("studio:play.people", (payload) => people.search(String(payload?.query ?? "")));
  handle("studio:play.visibility", (payload) => {
    if (!isPresenceVisibility(payload?.visibility)) throw new Error(MESSAGE.badVisibility);
    return people.setVisibility(payload.visibility);
  });
  // A typed nickname's shape is judged again in `people`: nothing malformed reaches genex.games.
  handle("studio:play.handle-check", (payload) => people.checkHandle(String(payload?.handle ?? "")));
  handle("studio:play.handle", (payload) => people.setHandle(String(payload?.handle ?? "")));
}
