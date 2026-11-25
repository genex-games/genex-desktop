/**
 * Links that open a game in Genex, as the website sends them: macOS hands one to the running app
 * (`open-url`); Windows and Linux start Genex with it as an argument (the second start's
 * `second-instance`, or the first start's own). Two addresses are taken and anything else is ignored:
 * `genex://game/<slug>` ("Open in Genex") opens the game's page in Play, and `genex://create/<slug>`
 * ("Open in Genex Studio", from a game's review on genex.games or its email) opens the creator's own
 * game with that link, with Publish open, or its page in Play when no game here has it. A third,
 * `genex://editor/<folder>`, comes from the Genex button in a game engine's editor (the Unreal
 * helper): `<folder>` is the project's folder on this computer in base64url, and it opens the chat
 * of the game that folder is in, or nothing when no game here holds it. The newest
 * link waits here until the studio page takes it (`studio:play.take-game-link`), so a link that
 * starts Genex is not lost before the page loads. Links are taken from the first moment (macOS sends
 * one that starts Genex early); the window and the page are told once main listens. Electron-free:
 * both are deps.
 */
import { type GameLinkOpen, isPlaySlug } from "../../shared/play.ts";

/** The URL scheme Genex registers with the system. */
export const GAME_LINK_SCHEME = "genex";
/** What a link opens, by its host: a game's page in Play, the creator's own game in Create, or the chat of the game an editor has open. */
export const GameLinkKind = { Game: "game", Create: "create", Editor: "editor" } as const;
export type GameLinkKind = (typeof GameLinkKind)[keyof typeof GameLinkKind];
/** The hosts whose path is a game's link on Genex; an editor link's is a folder and is read apart. */
const LINK_HOSTS: ReadonlySet<string> = new Set([GameLinkKind.Game, GameLinkKind.Create]);
const EDITOR_LINK_START = `${GAME_LINK_SCHEME}://${GameLinkKind.Editor}/`;
/** The longest link read: a game's address is far shorter. */
const MAX_LINK_CHARS = 256;
/** The longest editor link read: a project folder's path in base64url. */
const MAX_EDITOR_LINK_CHARS = 2048;
/** A project folder as an editor link carries it: unpadded base64url, nothing else. */
const FOLDER_CODE = /^[A-Za-z0-9_-]+$/;
/** A folder's whole path: from `/` on a Mac or Linux, from a drive on Windows. */
const ABSOLUTE_FOLDER = /^(?:\/|[A-Za-z]:[\\/])/;

/** What a link opens: its kind and the game's link on Genex, or for an editor link the project's `folder` (its `slug` is empty). */
export interface GameLinkTarget {
  kind: GameLinkKind;
  slug: string;
  folder?: string;
}

/** The folder an editor link's code names, or null unless it decodes to one whole path of plain text. */
function editorFolder(code: string): string | null {
  if (!FOLDER_CODE.test(code)) return null;
  const bytes = Buffer.from(code, "base64url");
  const folder = bytes.toString("utf8");
  // A code that is not this folder's own encoding (stray bits, bytes that are not text) names nothing.
  const sameCode = Buffer.from(folder, "utf8").toString("base64url") === code;
  const plain = !/\p{Cc}/u.test(folder);
  return sameCode && plain && ABSOLUTE_FOLDER.test(folder) ? folder : null;
}

/** What a `genex://editor/<folder>` link opens, or null for anything that is not exactly one. */
function editorLinkTarget(link: string): GameLinkTarget | null {
  if (link.length > MAX_EDITOR_LINK_CHARS || !URL.canParse(link)) return null;
  const url = new URL(link);
  const extras = url.username || url.password || url.port || url.search || url.hash;
  if (url.protocol !== `${GAME_LINK_SCHEME}:` || url.host !== GameLinkKind.Editor || extras) return null;
  const folder = editorFolder(url.pathname.replace(/^\//, ""));
  return folder ? { kind: GameLinkKind.Editor, slug: "", folder } : null;
}

/** What a link opens, or null for any link that is not exactly `genex://game/<slug>` or `genex://create/<slug>`. */
export function gameLinkTarget(link: unknown): GameLinkTarget | null {
  if (typeof link !== "string") return null;
  if (link.startsWith(EDITOR_LINK_START)) return editorLinkTarget(link);
  if (link.length > MAX_LINK_CHARS || !URL.canParse(link)) return null;
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
 * game whose publish record has that link), else, as a game link does, the game's page in Play. An
 * editor link opens the chat of the game its folder is in (`gameOfFolder`), and nothing otherwise.
 */
export async function linkOpening(
  target: GameLinkTarget | null,
  localGame: (slug: string) => Promise<string | null>,
  gameOfFolder: (folder: string) => Promise<string | null> = async () => null,
): Promise<GameLinkOpen | null> {
  if (!target) return null;
  if (target.kind === GameLinkKind.Editor) {
    const game = target.folder ? await gameOfFolder(target.folder).catch(() => null) : null;
    return game ? { slug: "", project: game, chat: true } : null;
  }
  if (target.kind !== GameLinkKind.Create) return { slug: target.slug };
  const project = await localGame(target.slug).catch(() => null);
  return project ? { slug: target.slug, project } : { slug: target.slug };
}
