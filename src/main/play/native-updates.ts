/**
 * Newer builds of installed games: each installed game's page is read from the catalog, and a build
 * for this computer newer than the installed one is told once per version (a notice: "New version ·
 * 120 MB. It updates when you play."). What was told is kept beside the installs, so a restart does
 * not ring again. Nothing is downloaded here: the game updates when it is next played. A game whose
 * page answers under another link (its owner changed it) moves to that link first.
 */
import path from "node:path";
import { isPlaySlug, type PlayGameDetail } from "../../shared/play.ts";
import { buildFor, type InstalledGame, type NativeHost } from "../../shared/play-native.ts";
import { atomicWriteJson, readJsonIfExists } from "../../substrate/fsx.ts";

/** Where the versions already told are kept, in the installed-games folder. */
const TOLD = "updates.json";

/** A newer build of an installed game. */
export interface NativeUpdate {
  slug: string;
  title: string;
  version: string;
  /** The download it takes. */
  sizeBytes: number;
}

/** What the check works with. */
export interface NativeUpdateDeps {
  /** The installed-games folder. */
  root: string;
  host: NativeHost;
  installed(): Promise<InstalledGame[]>;
  /** A game's page from the catalog. */
  game(slug: string): Promise<PlayGameDetail>;
  /** Tell one update. */
  tell(update: NativeUpdate): unknown;
  /** Move an installed game to its new link (`NativeInstaller.follow`); true once it moved. */
  follow?(from: string, to: string): Promise<boolean>;
}

/** What following games to new links works with. */
export type LinkFollowDeps = Pick<NativeUpdateDeps, "installed" | "game"> & {
  follow(from: string, to: string): Promise<boolean>;
};

/** The link an installed game is at after following its page there: the page's when it moved, else its own. */
async function followed(
  deps: Pick<NativeUpdateDeps, "follow">,
  game: InstalledGame,
  page: PlayGameDetail | null,
): Promise<string> {
  const moved = page && isPlaySlug(page.slug) && page.slug !== game.slug;
  if (!moved || !deps.follow) return game.slug;
  return (await deps.follow(game.slug, page.slug).catch(() => false)) ? page.slug : game.slug;
}

/**
 * Move every installed game whose page answers under another link to that link: what an owner's
 * Change link sets off at once, so their own copy keeps playing. Answers the links moved to.
 */
export async function followMovedLinks(deps: LinkFollowDeps): Promise<string[]> {
  const moved: string[] = [];
  for (const game of await deps.installed()) {
    const page = await deps.game(game.slug).catch(() => null);
    const slug = await followed(deps, game, page);
    if (slug !== game.slug) moved.push(slug);
  }
  return moved;
}

/** The versions told so far, by slug; anything unreadable reads as none. */
async function told(root: string): Promise<Record<string, string>> {
  const value = await readJsonIfExists<unknown>(path.join(root, TOLD)).catch(() => null);
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

/**
 * Read each installed game's page and tell each newer build for this computer not told before. A
 * game the catalog cannot be read for is passed over until the next check.
 */
export async function checkNativeUpdates(deps: NativeUpdateDeps): Promise<NativeUpdate[]> {
  const already = await told(deps.root);
  const updates: NativeUpdate[] = [];
  for (const game of await deps.installed()) {
    const page = await deps.game(game.slug).catch(() => null);
    const slug = await followed(deps, game, page);
    const build = page ? buildFor(page.native?.builds ?? [], deps.host) : null;
    if (!build || build.version === game.version) continue;
    if ((already[slug] ?? already[game.slug]) === build.version) continue;
    const update = {
      slug,
      title: page?.title ?? game.title,
      version: build.version,
      sizeBytes: build.sizeBytes,
    };
    await deps.tell(update);
    already[slug] = build.version;
    updates.push(update);
  }
  if (updates.length > 0) await atomicWriteJson(path.join(deps.root, TOLD), already);
  return updates;
}
