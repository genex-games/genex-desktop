/** Play: genex.games' catalog for the dashboard, the full-screen viewer a game opens in, and people. */
import { isAvatarVariant } from "../../shared/avatar-recipe.ts";
import { t } from "../../shared/i18n.ts";
import { isPlayShelf, isPlaySlug, PlayShelf, type PlayPoint, readPlayPoint } from "../../shared/play.ts";
import { isAccountId, isAvatarStyle, isFriendAction, isPresenceVisibility } from "../../shared/play-people.ts";
import { isStatsPeriod } from "../../shared/play-stats.ts";
import { isPlayCoverType, isPlayGameChange, isPlayGameId } from "../../shared/play-manage.ts";
import type { CreatorStats } from "../play/creator-stats.ts";
import type { GameLinks } from "../play/game-links.ts";
import type { GenexCredits } from "../play/credits.ts";
import type { PlayGallery, PlayWorld } from "../play/gallery.ts";
import type { PlayManage } from "../play/manage.ts";
import type { NativeInstaller } from "../play/native-installs.ts";
import { isSessionAction, NO_INSTALLS, type NativeHost, SessionAction } from "../../shared/play-native.ts";
import type { NativeSessions } from "../play/native-launch.ts";
import { onWebsite } from "../play/origins.ts";
import type { PlayPeople } from "../play/people.ts";
import { RemixRefusedError } from "../play/remix.ts";
import type { PlayViewer } from "../play/viewer.ts";
import type { IpcHandle } from "./registrar.ts";

/**
 * Why a Play request from the renderer is refused. `noInstalls` and `notInstalled` are words the
 * person reads; the rest answer only a malformed call from our own renderer, or a closed window.
 */
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
  noInstalls: () => t("native games are not available on this computer"),
  badSessionAction: "not something a running game is asked",
  notInstalled: () => t("that game is not installed"),
} as const;

/** What Play's channels answer from. */
export interface PlayIpcDeps {
  gallery: PlayGallery;
  /** Copy a game's public source into a new game; answers its library name. */
  remix(world: PlayWorld): Promise<string>;
  /** Whether each named game's source holds a game, so its card offers Remix (`remix-ready.ts`). */
  remixReady(slugs: readonly unknown[]): Promise<Record<string, boolean>>;
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
  /** Native games' installs on this computer; null where Genex runs no native game. */
  installs(): NativeInstaller | null;
  /** This computer as Play names it, even where Genex runs no native game; null where it has no name. */
  here(): NativeHost | null;
  /** Native games being played; null where Genex runs no native game. */
  sessions(): NativeSessions | null;
  /** Show a file in Finder (`shell.showItemInFolder`). */
  reveal(file: string): void;
  /** The game a `genex://` link asked to open, waiting for the page. */
  gameLinks: Pick<GameLinks, "take">;
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
    } catch (error) {
      // A refusal is told by its code: the renderer says each in its own words.
      if (error instanceof RemixRefusedError) return { refused: error.code };
      throw error;
    } finally {
      viewer()?.remixing(false);
    }
  });
  handle("studio:play.online", (payload) => gallery.online(Array.isArray(payload?.slugs) ? payload.slugs : []));
  // Main finds each game's source from the catalog itself; the renderer names games only by slug.
  handle("studio:play.remix-ready", (payload) => deps.remixReady(Array.isArray(payload?.slugs) ? payload.slugs : []));
  // The renderer names a game by its slug; main builds every address from it.
  handle("studio:play.open", async (payload) => {
    if (!isPlaySlug(payload?.slug)) throw new Error(MESSAGE.badSlug);
    // One copy of a game at a time: its native app being played comes forward instead.
    const live = deps.sessions();
    if (live?.playing(payload.slug)) return live.show(payload.slug);
    const shown = viewer();
    if (!shown) throw new Error(MESSAGE.noWindow);
    shown.open(payload.slug, payload.title);
  });
  handle("studio:play.close", async () => viewer()?.close());
  handle("studio:play.take-game-link", async () => deps.gameLinks.take());
  handle("studio:play.game", (payload) => {
    if (!isPlaySlug(payload?.slug)) throw new Error(MESSAGE.badSlug);
    return gallery.game(payload.slug);
  });
  // The bar names a control (and where it is, for a menu); the viewer acts only on one it knows.
  handle("studio:play.control", async (payload) => viewer()?.control(payload?.control, readPlayPoint(payload?.at)));
  handle("studio:play.bar", async (payload) => viewer()?.hold(payload));
  // The purchase sheet's answer: the viewer reads it, and pays or cancels only the purchase it holds.
  handle("studio:play.purchase", async (payload) => viewer()?.answerPurchase(payload));
  registerCommentsIpc(handle, viewer);
  registerInstallsIpc(handle, deps);
  registerSessionsIpc(handle, deps.sessions);
  registerGameIpc(handle, deps);
}

/** A native game played in its own window: named by its slug, shown or quit by a named action. */
function registerSessionsIpc(handle: IpcHandle, sessions: PlayIpcDeps["sessions"]): void {
  const launcher = (): NativeSessions => {
    const found = sessions();
    if (!found) throw new Error(MESSAGE.noInstalls());
    return found;
  };
  handle("studio:play.launch", (payload) => {
    if (!isPlaySlug(payload?.slug)) throw new Error(MESSAGE.badSlug);
    return launcher().launch(payload.slug);
  });
  handle("studio:play.session", (payload) => {
    if (!isPlaySlug(payload?.slug)) throw new Error(MESSAGE.badSlug);
    if (!isSessionAction(payload.action)) throw new Error(MESSAGE.badSessionAction);
    const live = launcher();
    return payload.action === SessionAction.Show ? live.show(payload.slug) : live.quit(payload.slug);
  });
  handle("studio:play.sessions", async () => sessions()?.sessions() ?? []);
}

/** An installed game's app in Finder, and a like from a game's page: each named by its slug, resolved in main. */
function registerGameIpc(handle: IpcHandle, deps: PlayIpcDeps): void {
  handle("studio:play.reveal-install", async (payload) => {
    if (!isPlaySlug(payload?.slug)) throw new Error(MESSAGE.badSlug);
    const app = await deps.installs()?.appOf(payload.slug);
    if (!app) throw new Error(MESSAGE.notInstalled());
    deps.reveal(app);
  });
  handle("studio:play.like", async (payload) => {
    if (!isPlaySlug(payload?.slug)) throw new Error(MESSAGE.badSlug);
    const { id } = await deps.gallery.world(payload.slug);
    return deps.gallery.setLiked(id, payload.liked === true);
  });
}

/** A native game's install: the renderer names a game by its slug; main reads its build from the catalog. */
function registerInstallsIpc(handle: IpcHandle, { installs, here }: Pick<PlayIpcDeps, "installs" | "here">): void {
  const installer = (): NativeInstaller => {
    const found = installs();
    if (!found) throw new Error(MESSAGE.noInstalls());
    return found;
  };
  const slugOf = (payload: { slug?: unknown } | undefined): string => {
    if (!isPlaySlug(payload?.slug)) throw new Error(MESSAGE.badSlug);
    return payload.slug;
  };
  handle("studio:play.install", (payload) => installer().install(slugOf(payload)));
  handle("studio:play.install-cancel", (payload) => installer().cancel(slugOf(payload)));
  // Where nothing installs, the computer is still named, so a game's page can say why not.
  handle("studio:play.installs", async () => (await installs()?.state()) ?? { ...NO_INSTALLS, host: here() });
  handle("studio:play.uninstall", (payload) => installer().uninstall(slugOf(payload)));
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
