/**
 * Newer builds of installed games: each installed game's page is read from the catalog, and a build
 * for this computer newer than the installed one is told once per version (a notice: "New version ·
 * 120 MB. It updates when you play."). What was told is kept beside the installs, so a restart does
 * not ring again. Nothing is downloaded here: the game updates when it is next played.
 */
import path from "node:path";
import type { PlayGameDetail } from "../../shared/play.ts";
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
    const build = page ? buildFor(page.native?.builds ?? [], deps.host) : null;
    if (!build || build.version === game.version) continue;
    if (already[game.slug] === build.version) continue;
    const update = {
      slug: game.slug,
      title: page?.title ?? game.title,
      version: build.version,
      sizeBytes: build.sizeBytes,
    };
    await deps.tell(update);
    already[game.slug] = build.version;
    updates.push(update);
  }
  if (updates.length > 0) await atomicWriteJson(path.join(deps.root, TOLD), already);
  return updates;
}
