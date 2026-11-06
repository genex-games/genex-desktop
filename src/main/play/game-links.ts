/**
 * Links that open a game in Genex, as the website sends them: macOS hands one to the running app
 * (`open-url`); Windows and Linux start Genex with it as an argument (the second start's
 * `second-instance`, or the first start's own). Two addresses are taken and anything else is ignored:
 * `genex://game/<slug>` ("Open in Genex") opens the game's page in Play, and `genex://create/<slug>`
 * ("Open in Genex Studio", from a game's review on genex.games or its email) opens the creator's own
 * game with that link, with Publish open, or its page in Play when no game here has it. The newest
 * link waits here until the studio page takes it (`studio:play.take-game-link`), so a link that
 * starts Genex is not lost before the page loads. Links are taken from the first moment (macOS sends
 * one that starts Genex early); the window and the page are told once main listens. Electron-free:
 * both are deps.
 */
import { type GameLinkOpen, isPlaySlug } from "../../shared/play.ts";

/** The URL scheme Genex registers with the system. */
export const GAME_LINK_SCHEME = "genex";
/** What a link opens, by its host: a game's page in Play, or the creator's own game in Create. */
export const GameLinkKind = { Game: "game", Create: "create" } as const;
export type GameLinkKind = (typeof GameLinkKind)[keyof typeof GameLinkKind];
const LINK_HOSTS: ReadonlySet<string> = new Set(Object.values(GameLinkKind));
/** The longest link read: a game's address is far shorter. */
const MAX_LINK_CHARS = 256;

/** What a link opens: its kind and the game's link on Genex. */
export interface GameLinkTarget {
  kind: GameLinkKind;
  slug: string;
}

/** What a link opens, or null for any link that is not exactly `genex://game/<slug>` or `genex://create/<slug>`. */
export function gameLinkTarget(link: unknown): GameLinkTarget | null {
  if (typeof link !== "string" || link.length > MAX_LINK_CHARS || !URL.canParse(link)) return null;
  const url = new URL(link);
  const extras = url.username || url.password || url.port || url.search || url.hash;
  if (url.protocol !== `${GAME_LINK_SCHEME}:` || !LINK_HOSTS.has(url.host) || extras) return null;
  const slug = url.pathname.replace(/^\//, "").replace(/\/$/, "");
  return isPlaySlug(slug) ? { kind: url.host as GameLinkKind, slug } : null;
}

/** The game a `genex://game/<slug>` link opens, or null for any other link. */
export function gameLinkSlug(link: unknown): string | null {
  const target = gameLinkTarget(link);
  return target?.kind === GameLinkKind.Game ? target.slug : null;
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
  /** What the waiting link opens, once; null when none waits. */
  take(): GameLinkTarget | null;
}

/** The game links of this launch. */
export function gameLinks(): GameLinks {
  let waiting: GameLinkTarget | null = null;
  let listener: GameLinksDeps | null = null;
  return {
    arrive(link) {
      const target = gameLinkTarget(link);
      if (!target) return false;
      waiting = target;
      listener?.show();
      listener?.announce();
      return true;
    },
    listen(deps) {
      listener = deps;
    },
    take() {
      const target = waiting;
      waiting = null;
      return target;
    },
  };
}

/**
 * What the studio page opens for the waiting link: a create link's own game here (`localGame`, the
 * game whose publish record has that link), else, as a game link does, the game's page in Play.
 */
export async function linkOpening(
  target: GameLinkTarget | null,
  localGame: (slug: string) => Promise<string | null>,
): Promise<GameLinkOpen | null> {
  if (!target) return null;
  if (target.kind !== GameLinkKind.Create) return { slug: target.slug };
  const project = await localGame(target.slug).catch(() => null);
  return project ? { slug: target.slug, project } : { slug: target.slug };
}
