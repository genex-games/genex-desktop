/**
 * Links that open a game in Genex (`genex://game/<slug>`), as the website's "Open in Genex" sends
 * them: macOS hands one to the running app (`open-url`); Windows and Linux start Genex with it as
 * an argument (the second start's `second-instance`, or the first start's own). Only a game's own
 * address is taken and anything else is ignored. The newest link waits here until the studio page
 * takes it (`studio:play.take-game-link`), so a link that starts Genex is not lost before the page
 * loads. Links are taken from the first moment (macOS sends one that starts Genex early); the
 * window and the page are told once main listens. Electron-free: both are deps.
 */
import { isPlaySlug } from "../../shared/play.ts";

/** The URL scheme Genex registers with the system. */
export const GAME_LINK_SCHEME = "genex";
/** The link's host: what it opens. */
const GAME_HOST = "game";
/** The longest link read: a game's address is far shorter. */
const MAX_LINK_CHARS = 256;

/** The game a link opens, or null for any link that is not exactly `genex://game/<slug>`. */
export function gameLinkSlug(link: unknown): string | null {
  if (typeof link !== "string" || link.length > MAX_LINK_CHARS || !URL.canParse(link)) return null;
  const url = new URL(link);
  const extras = url.username || url.password || url.port || url.search || url.hash;
  if (url.protocol !== `${GAME_LINK_SCHEME}:` || url.host !== GAME_HOST || extras) return null;
  const slug = url.pathname.replace(/^\//, "").replace(/\/$/, "");
  return isPlaySlug(slug) ? slug : null;
}

/** The link among the arguments Genex was started with, or null: one argument that is a whole link. */
export const gameLinkIn = (argv: readonly string[]): string | null =>
  argv.find((arg) => arg.toLowerCase().startsWith(`${GAME_LINK_SCHEME}://`)) ?? null;

/** What a link does as it arrives. */
export interface GameLinksDeps {
  /** Bring the studio window forward, opening it again if it was closed. */
  show(): void;
  /** Tell a loaded studio page that a link waits (`play.game-link`). */
  announce(): void;
}

/** The newest game link, waiting for the studio page. */
export interface GameLinks {
  /** A link arrived: true when it names a game, which then waits for the page. */
  arrive(link: unknown): boolean;
  /** From now on, each link that arrives shows the window and tells the page. */
  listen(deps: GameLinksDeps): void;
  /** The game waiting, once; null when none does. */
  take(): string | null;
}

/** The game links of this launch. */
export function gameLinks(): GameLinks {
  let waiting: string | null = null;
  let listener: GameLinksDeps | null = null;
  return {
    arrive(link) {
      const slug = gameLinkSlug(link);
      if (!slug) return false;
      waiting = slug;
      listener?.show();
      listener?.announce();
      return true;
    },
    listen(deps) {
      listener = deps;
    },
    take() {
      const slug = waiting;
      waiting = null;
      return slug;
    },
  };
}
