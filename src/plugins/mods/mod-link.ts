/**
 * Which installed game a Genex project is a mod of. The link lives in the plugin's own storage,
 * where agents can't write, as the game's id alone: every folder Genex writes to is worked out
 * again from that id at each call (the store's listing, then the table of known games), never read
 * from a file in the project. The project's `genex-mod.json` only marks it as a mod and tells the
 * agent about the game; nothing reads a destination from it.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { atomicWriteText } from "../../substrate/fsx.ts";
import { findGames, type GamesEnv, GameStore, type InstalledGame, STORE_NAME } from "./find-games.ts";
import { BUILT_WITH_NAME, type BuiltWith, fingerprint } from "./fingerprint.ts";
import { KNOWN_GAMES, ONLINE_STEAM_APPS, placeFolder } from "./known-games.ts";

/** The file that marks a project as a mod, at its root: the plugin's `detect` rule finds it. */
export const MOD_FILE = "genex-mod.json";

/** Why Genex makes no mod for a game. Wire values: the agent reads them. */
export const ModRefusal = { AntiCheat: "anti-cheat", Online: "online" } as const;
export type ModRefusal = (typeof ModRefusal)[keyof typeof ModRefusal];

/** An installed game as a mod sees it: its folders on this computer, what it was made with, and why it can't be modded. */
export interface ModTarget extends InstalledGame {
  builtWith: BuiltWith | null;
  antiCheat: string[];
  /** The folder the game loads mods from, when Genex knows it. */
  mods: string | null;
  /** The folder the game keeps saves in, when Genex knows it. */
  saves: string | null;
  /** The community's route, when Genex knows the game. */
  route: string | null;
  refusal: ModRefusal | null;
}

/** A project's link, as the plugin keeps it. */
interface LinkRecord {
  version: 1;
  game: string;
  name: string;
  linkedAt: string;
}

/** The plugin's storage folders a project's link and installs live in. */
const LINKS_FOLDER = "links";

/** A project's key in the plugin's storage: a hash, so any project name makes a plain file name. */
export function projectKey(project: string): string {
  return createHash("sha256").update(project).digest("hex").slice(0, 24);
}

/** Where a project's link is kept. */
const linkFile = (storage: string, project: string) => path.join(storage, LINKS_FOLDER, `${projectKey(project)}.json`);

/** The game `project` is a mod of, by its id and the name it had when linked; null when it is none (or its record doesn't read). */
export async function readLink(storage: string, project: string): Promise<{ id: string; name: string } | null> {
  try {
    const record: Partial<LinkRecord> = JSON.parse(await readFile(linkFile(storage, project), "utf8"));
    if (record.version !== 1 || typeof record.game !== "string") return null;
    return { id: record.game, name: typeof record.name === "string" ? record.name : record.game };
  } catch {
    return null;
  }
}

/** The id of the game `project` is a mod of, or null. */
export async function linkedGameId(storage: string, project: string): Promise<string | null> {
  return (await readLink(storage, project))?.id ?? null;
}

/** Keeps `project`'s link to `game` in the plugin's storage. */
export async function writeLink(storage: string, project: string, game: InstalledGame): Promise<void> {
  const file = linkFile(storage, project);
  await mkdir(path.dirname(file), { recursive: true });
  const record: LinkRecord = { version: 1, game: game.id, name: game.name, linkedAt: new Date().toISOString() };
  await atomicWriteText(file, `${JSON.stringify(record, null, 2)}\n`);
}

/** Why a game gets no mod (anti-cheat in its folder, or an online game's id); null when it may get one. */
function refusalOf(game: InstalledGame, antiCheat: string[]): ModRefusal | null {
  if (antiCheat.length) return ModRefusal.AntiCheat;
  if (game.store === GameStore.Steam && game.storeId && ONLINE_STEAM_APPS.has(game.storeId)) return ModRefusal.Online;
  return null;
}

/** An installed game with its folders, engine and standing, as a mod sees it. */
export async function modTarget(env: GamesEnv, game: InstalledGame): Promise<ModTarget> {
  const print = await fingerprint(game.folder);
  const known = KNOWN_GAMES[game.id];
  const roots = { platform: env.platform, home: env.home, appData: env.appData, game: game.folder };
  return {
    ...game,
    builtWith: print.builtWith,
    antiCheat: print.antiCheat,
    mods: placeFolder(known?.mods, roots),
    saves: placeFolder(known?.saves, roots),
    route: known?.route ?? null,
    refusal: refusalOf(game, print.antiCheat),
  };
}

/** The installed game with this id, as a mod sees it; null when no store lists it on this computer now. */
export async function findTarget(env: GamesEnv, id: string): Promise<ModTarget | null> {
  const game = (await findGames(env)).find((g) => g.id === id);
  return game ? modTarget(env, game) : null;
}

/** The game `project` is a mod of, as installed now; null when it is none or the game is gone. */
export async function linkedTarget(env: GamesEnv, storage: string, project: string): Promise<ModTarget | null> {
  const id = await linkedGameId(storage, project);
  return id ? findTarget(env, id) : null;
}

/** The marker `genex-mod.json` says: the game, its folders and its route, for the agent and the person. */
export function modFileText(target: ModTarget): string {
  const marker = {
    about: `This folder is a mod Genex makes for ${target.name}. Genex copies it into the game with Install and takes it out again with Remove mod.`,
    game: target.name,
    id: target.id,
    store: STORE_NAME[target.store],
    ...(target.builtWith ? { builtWith: BUILT_WITH_NAME[target.builtWith] } : {}),
    folders: {
      game: target.folder,
      ...(target.mods ? { mods: target.mods } : {}),
      ...(target.saves ? { saves: target.saves } : {}),
    },
    ...(target.route ? { route: target.route } : {}),
  };
  return `${JSON.stringify(marker, null, 2)}\n`;
}
