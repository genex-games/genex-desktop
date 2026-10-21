/**
 * The games installed on this computer, as the stores that installed them list them: Steam's
 * manifests in each of its libraries, the Epic Games Launcher's manifests, and Minecraft's
 * launcher. Being installed by the person's own store is what tells Genex they own the game; a
 * folder no store lists is never offered. Each game's folder must still exist; every file read is
 * bounded, and nothing is written.
 */
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StudioPlatform } from "../../shared/boot.ts";
import { engineTestMac } from "../../substrate/app-install.ts";
import { MINECRAFT_ID, STEAM_TOOL_APPS } from "./known-games.ts";
import { MAX_VDF_CHARS, parseVdf, vdfBlock, vdfText } from "./vdf.ts";
import { DOCUMENTS_KEY, type RegistryRead, STEAM_KEY, systemRegistry, windowsPath } from "./windows-folders.ts";

/** The store that installed a game. Wire values: part of a game's id. */
export const GameStore = { Steam: "steam", Epic: "epic", Minecraft: "minecraft" } as const;
export type GameStore = (typeof GameStore)[keyof typeof GameStore];

/** Each store as people name it. */
export const STORE_NAME: Readonly<Record<GameStore, string>> = {
  [GameStore.Steam]: "Steam",
  [GameStore.Epic]: "Epic Games",
  [GameStore.Minecraft]: "Minecraft Launcher",
};

/** One installed game: Genex's id for it, its name, its store's own id and its folder (a real path). */
export interface InstalledGame {
  id: string;
  name: string;
  store: GameStore;
  /** The store's id: Steam's app id, Epic's app name; none for Minecraft. */
  storeId?: string;
  folder: string;
}

/** Where this computer keeps what the finder reads. */
export interface GamesEnv {
  platform: NodeJS.Platform;
  home: string;
  /** The Mac's Applications, where Minecraft's launcher is. */
  applications: string;
  /** Windows's roaming app data (`%APPDATA%`). */
  appData: string;
  /** Windows's shared app data (`%ProgramData%`), where Epic keeps its manifests. */
  programData: string;
  /** Windows's 32-bit programs (`%ProgramFiles(x86)%`), where Steam installs itself by default. */
  programFilesX86: string;
  /** Windows's registry, where Steam records the folder it was installed to and Windows the real Documents. */
  registry?: RegistryRead;
}

/** The most manifests read from one folder: a big library holds a few hundred games. */
const MAX_MANIFESTS = 2000;
/** The most libraries read from Steam's list. */
const MAX_LIBRARIES = 32;
/** The longest Epic manifest read: they are a few kilobytes of JSON. */
const MAX_EPIC_MANIFEST_BYTES = 256 * 1024;
/** Steam's manifest file names, with the app id. */
const STEAM_MANIFEST = /^appmanifest_(\d{1,12})\.acf$/;
/** Names a Steam app that is one of its runtimes rather than a game, when its id is new to Genex. */
const STEAM_TOOL_NAME = /^(Proton|Steam Linux Runtime|Steamworks)\b/;
/** Epic's category for games, beside engines and plugins. */
const EPIC_GAMES_CATEGORY = "games";

/** The platform's path functions. */
export const pathsOf = (env: GamesEnv) => (env.platform === StudioPlatform.Windows ? path.win32 : path.posix);

/** A folder's real path when it exists and is a folder; null otherwise. */
async function folderAt(dir: string): Promise<string | null> {
  const real = await realpath(dir).catch(() => null);
  if (!real) return null;
  return (await stat(real).catch(() => null))?.isDirectory() ? real : null;
}

/** A text file's contents up to `maxChars`; null when it is missing, unreadable or longer. */
async function readSmall(file: string, maxChars: number): Promise<string | null> {
  const info = await stat(file).catch(() => null);
  if (!info?.isFile() || info.size > maxChars) return null;
  return readFile(file, "utf8").catch(() => null);
}

/**
 * Steam's own folder on this computer: on Windows the one the registry records (Steam may live on
 * any drive), else its default place under Program Files.
 */
export async function steamRoot(env: GamesEnv): Promise<string> {
  const p = pathsOf(env);
  if (env.platform !== StudioPlatform.Windows) return p.join(env.home, "Library", "Application Support", "Steam");
  const recorded = windowsPath((await env.registry?.(STEAM_KEY.key, STEAM_KEY.value)) ?? null);
  return recorded ?? p.join(env.programFilesX86, "Steam");
}

/** The libraries Steam's library list names, by their folders. */
async function listedLibraries(env: GamesEnv, root: string): Promise<string[]> {
  const p = pathsOf(env);
  const listed = parseVdf((await readSmall(p.join(root, "steamapps", "libraryfolders.vdf"), MAX_VDF_CHARS)) ?? "");
  const folders = vdfBlock(listed, "libraryfolders") ?? listed ?? {};
  return Object.values(folders)
    .map((entry) => (typeof entry === "object" ? vdfText(entry, "path") : null))
    .filter((dir): dir is string => Boolean(dir) && p.isAbsolute(dir ?? ""));
}

/** Every Steam library: Steam's own folder, then each one its library list names, each once (in any case on Windows). */
async function steamLibraries(env: GamesEnv): Promise<string[]> {
  const root = await steamRoot(env);
  const all = [root, ...(await listedLibraries(env, root))];
  const key = (dir: string) =>
    env.platform === StudioPlatform.Windows ? path.win32.normalize(dir).toLowerCase() : dir;
  const seen = new Set<string>();
  return all.filter((dir) => !seen.has(key(dir)) && Boolean(seen.add(key(dir)))).slice(0, MAX_LIBRARIES);
}

/** The person's Documents folder: on Windows the one the registry records (often in OneDrive), else the home's. */
export async function documentsFolder(env: GamesEnv): Promise<string> {
  const p = pathsOf(env);
  if (env.platform !== StudioPlatform.Windows) return p.join(env.home, "Documents");
  const recorded = windowsPath((await env.registry?.(DOCUMENTS_KEY.key, DOCUMENTS_KEY.value)) ?? null);
  return recorded ?? p.join(env.home, "Documents");
}

/** Whether a Steam app is one of Steam's own tools rather than a game. */
const isSteamTool = (id: string, name: string): boolean => STEAM_TOOL_APPS.has(id) || STEAM_TOOL_NAME.test(name);

/** One Steam manifest's game, when its folder is there and it is a game. */
async function steamGame(env: GamesEnv, library: string, file: string): Promise<InstalledGame | null> {
  const p = pathsOf(env);
  const manifest = vdfBlock(
    parseVdf((await readSmall(p.join(library, "steamapps", file), MAX_VDF_CHARS)) ?? ""),
    "AppState",
  );
  const id = vdfText(manifest, "appid") ?? STEAM_MANIFEST.exec(file)?.[1] ?? "";
  const name = vdfText(manifest, "name")?.trim();
  const installdir = vdfText(manifest, "installdir");
  if (!name || !installdir || installdir.includes("/") || installdir.includes("\\") || installdir.startsWith("."))
    return null;
  if (isSteamTool(id, name)) return null;
  const folder = await folderAt(p.join(library, "steamapps", "common", installdir));
  return folder ? { id: `${GameStore.Steam}:${id}`, name, store: GameStore.Steam, storeId: id, folder } : null;
}

/** The games every Steam library's manifests list. */
async function steamGames(env: GamesEnv): Promise<InstalledGame[]> {
  const p = pathsOf(env);
  const games: InstalledGame[] = [];
  for (const library of await steamLibraries(env)) {
    const files = await readdir(p.join(library, "steamapps")).catch(() => []);
    for (const file of files.filter((f) => STEAM_MANIFEST.test(f)).slice(0, MAX_MANIFESTS)) {
      const game = await steamGame(env, library, file);
      if (game) games.push(game);
    }
  }
  return games;
}

/** Epic's manifests folder on this computer. */
function epicManifests(env: GamesEnv): string {
  const p = pathsOf(env);
  const parts = ["Epic", "EpicGamesLauncher", "Data", "Manifests"];
  if (env.platform === StudioPlatform.Windows) return p.join(env.programData, ...parts);
  return p.join(env.home, "Library", "Application Support", ...parts);
}

/** Whether an Epic manifest's categories make it a game (an engine or a plugin is listed the same way). */
function isEpicGame(categories: unknown): boolean {
  return !Array.isArray(categories) || categories.includes(EPIC_GAMES_CATEGORY);
}

/** One Epic manifest's game, when it is a whole install of a game whose folder is there. */
async function epicGame(env: GamesEnv, file: string): Promise<InstalledGame | null> {
  const text = await readSmall(pathsOf(env).join(epicManifests(env), file), MAX_EPIC_MANIFEST_BYTES);
  let item: Record<string, unknown>;
  try {
    item = JSON.parse(text ?? "null") ?? {};
  } catch {
    return null;
  }
  const name = typeof item.DisplayName === "string" ? item.DisplayName.trim() : "";
  const appName = typeof item.AppName === "string" ? item.AppName : "";
  const location = typeof item.InstallLocation === "string" ? item.InstallLocation : "";
  const whole = item.bIsIncompleteInstall !== true && isEpicGame(item.AppCategories);
  if (!name || !/^[\w.-]{1,120}$/.test(appName) || !pathsOf(env).isAbsolute(location) || !whole) return null;
  const folder = await folderAt(location);
  return folder ? { id: `${GameStore.Epic}:${appName}`, name, store: GameStore.Epic, storeId: appName, folder } : null;
}

/** The games Epic's manifests list. */
async function epicGames(env: GamesEnv): Promise<InstalledGame[]> {
  const files = await readdir(epicManifests(env)).catch(() => []);
  const games = await Promise.all(
    files
      .filter((f) => f.endsWith(".item"))
      .slice(0, MAX_MANIFESTS)
      .map((f) => epicGame(env, f)),
  );
  return games.filter((game): game is InstalledGame => game !== null);
}

/** Minecraft: Java Edition, when its launcher is installed and its game folder is there. */
async function minecraft(env: GamesEnv): Promise<InstalledGame | null> {
  const p = pathsOf(env);
  const windows = env.platform === StudioPlatform.Windows;
  if (!windows && !(await folderAt(p.join(env.applications, "Minecraft.app")))) return null;
  const data = windows
    ? p.join(env.appData, ".minecraft")
    : p.join(env.home, "Library", "Application Support", "minecraft");
  const folder = await folderAt(data);
  return folder ? { id: MINECRAFT_ID, name: "Minecraft", store: GameStore.Minecraft, folder } : null;
}

/** Every game installed on this computer that a store lists, each once, by name. */
export async function findGames(env: GamesEnv): Promise<InstalledGame[]> {
  const [steam, epic, mine] = await Promise.all([steamGames(env), epicGames(env), minecraft(env)]);
  const byId = new Map<string, InstalledGame>();
  for (const game of [...steam, ...epic, ...(mine ? [mine] : [])]) if (!byId.has(game.id)) byId.set(game.id, game);
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** This computer's folders, or a development test's made-up Mac (`STUDIO_ENGINE_TEST_ROOT`). */
export function systemGamesEnv(env: NodeJS.ProcessEnv = process.env, platform = process.platform): GamesEnv {
  const test = engineTestMac(env, platform);
  const home = test?.home ?? os.homedir();
  const windowsHome = env.USERPROFILE ?? home;
  return {
    platform,
    home: platform === StudioPlatform.Windows ? windowsHome : home,
    applications: test?.applications ?? "/Applications",
    appData: env.APPDATA ?? path.win32.join(windowsHome, "AppData", "Roaming"),
    programData: env.ProgramData ?? "C:\\ProgramData",
    programFilesX86: env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
    ...(platform === StudioPlatform.Windows ? { registry: systemRegistry(env) } : {}),
  };
}
