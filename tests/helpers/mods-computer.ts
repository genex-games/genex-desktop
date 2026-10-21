/**
 * A made-up computer for the Game mods plugin, laid out as this platform's stores lay it out (a
 * Mac's Application Support, or Windows's Program Files, ProgramData and roaming app data): Steam
 * with its library list and the games' manifests and folders where the test puts them, Epic's
 * manifests, Minecraft's launcher and folder, and the Game mods backend over it in an open Genex
 * game, with every launch recorded. Nothing here starts a game or reads the real computer's stores.
 */
import { mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PluginContext } from "../../src/plugin-sdk/index.d.ts";
import { createModsBackend } from "../../src/plugins/mods/backend.ts";
import type { GamesEnv } from "../../src/plugins/mods/find-games.ts";
import { KNOWN_GAMES, placeFolder } from "../../src/plugins/mods/known-games.ts";
import type { Launch } from "../../src/plugins/mods/launch.ts";
import { StudioPlatform } from "../../src/shared/boot.ts";
import { tmpDir } from "./tmp.ts";

/** One Steam game the test installs: its app id, name, folder name and the files its folder holds. */
export interface FakeSteamGame {
  id: string;
  name: string;
  dir?: string;
  /** Paths below the game's folder, `/`-separated; a path ending in `/` is a folder. */
  files?: string[];
  /** A second library holds it instead of Steam's own folder. */
  library?: "second";
  /** The manifest is written but the folder is not. */
  noFolder?: boolean;
}

/** Whether these tests run on Windows, where the stores keep their files elsewhere. */
export const ON_WINDOWS = process.platform === StudioPlatform.Windows;

/** Valve's KeyValues for a manifest. */
function manifest(game: FakeSteamGame): string {
  return `"AppState"\n{\n\t"appid"\t\t"${game.id}"\n\t"name"\t\t"${game.name}"\n\t"installdir"\t\t"${game.dir ?? game.name}"\n}\n`;
}

/** A path as Valve's KeyValues write it: each backslash doubled. */
const vdfPath = (dir: string) => dir.replaceAll("\\", "\\\\");

/** Writes each `/`-path below `root`: a folder for one ending in `/`, else a file holding its path. */
export async function writeTree(root: string, files: readonly string[]): Promise<void> {
  for (const file of files) {
    const target = path.join(root, ...file.split("/").filter(Boolean));
    if (file.endsWith("/")) await mkdir(target, { recursive: true });
    else {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, file);
    }
  }
}

/** A made-up computer with these Steam games (and optionally Minecraft and Epic games). */
export async function fakeComputer(
  options: { steam?: FakeSteamGame[]; minecraft?: boolean; epic?: Array<Record<string, unknown>> } = {},
) {
  const root = await realpath(await tmpDir("mods-computer-"));
  const home = path.join(root, "home");
  const env: GamesEnv = {
    platform: process.platform,
    home,
    applications: path.join(root, "Applications"),
    appData: path.join(home, "AppData", "Roaming"),
    programData: path.join(root, "ProgramData"),
    programFilesX86: path.join(root, "Program Files (x86)"),
    registry: async () => null,
  };
  /** A folder below the data folder this platform keeps for apps (Application Support, roaming app data). */
  const support = (...parts: string[]) =>
    ON_WINDOWS ? path.join(env.appData, ...parts) : path.join(home, "Library", "Application Support", ...parts);
  const steam = ON_WINDOWS ? path.join(env.programFilesX86, "Steam") : support("Steam");
  const second = path.join(root, "Games", "SteamLibrary");
  await mkdir(path.join(steam, "steamapps"), { recursive: true });
  await mkdir(env.applications, { recursive: true });
  const list = `"libraryfolders"\n{\n\t"0"\n\t{\n\t\t"path"\t\t"${vdfPath(steam)}"\n\t}\n\t"1"\n\t{\n\t\t"path"\t\t"${vdfPath(second)}"\n\t}\n}\n`;
  await writeFile(path.join(steam, "steamapps", "libraryfolders.vdf"), list);
  for (const game of options.steam ?? []) {
    const library = game.library === "second" ? second : steam;
    await mkdir(path.join(library, "steamapps"), { recursive: true });
    await writeFile(path.join(library, "steamapps", `appmanifest_${game.id}.acf`), manifest(game));
    if (game.noFolder) continue;
    const folder = path.join(library, "steamapps", "common", game.dir ?? game.name);
    await mkdir(folder, { recursive: true });
    await writeTree(folder, game.files ?? []);
  }
  if (options.minecraft) {
    await mkdir(path.join(env.applications, "Minecraft.app", "Contents"), { recursive: true });
    const data = ON_WINDOWS ? path.join(env.appData, ".minecraft") : support("minecraft");
    await mkdir(path.join(data, "saves", "World"), { recursive: true });
  }
  const epic = ON_WINDOWS
    ? path.join(env.programData, "Epic", "EpicGamesLauncher", "Data", "Manifests")
    : support("Epic", "EpicGamesLauncher", "Data", "Manifests");
  for (const [at, item] of (options.epic ?? []).entries()) {
    await mkdir(epic, { recursive: true });
    await writeFile(path.join(epic, `${at}.item`), JSON.stringify(item));
  }
  /** A game's folder in Steam's own library. */
  const steamGame = (dir: string) => path.join(steam, "steamapps", "common", dir);
  /** Where Genex's table says a known game keeps its mods or saves on this made-up computer. */
  const known = (id: string, kind: "mods" | "saves", game = "") =>
    placeFolder(KNOWN_GAMES[id]?.[kind], {
      platform: env.platform,
      home,
      appData: env.appData,
      documents: path.join(home, "Documents"),
      game,
    });
  return { root, home, steam, second, epic, env, steamGame, support, known };
}

/** The Game mods backend on a made-up computer, in an open game (`valley`) whose folder is real. */
export async function modsBackend(
  computer: Awaited<ReturnType<typeof fakeComputer>>,
  game = "valley",
  now?: () => number,
) {
  const storage = path.join(computer.root, "storage");
  const gameDir = path.join(computer.root, "games", game);
  await mkdir(storage, { recursive: true });
  await mkdir(gameDir, { recursive: true });
  const launches: Launch[] = [];
  const backend = createModsBackend({
    env: computer.env,
    open: async (launch) => {
      launches.push(launch);
    },
    ...(now ? { now } : {}),
  });
  const host = (async (method: string) => {
    if (method === "storage.root") return storage;
    throw new Error(`unexpected host call ${method}`);
  }) as PluginContext["host"];
  const context = (more: Partial<PluginContext> = {}): PluginContext => ({
    project: game,
    directory: gameDir,
    signal: new AbortController().signal,
    callId: 1,
    host,
    ...more,
  });
  const { tool: callTool, action: callAction, card: callCard } = backend;
  if (!callTool || !callAction || !callCard) throw new Error("The Game mods backend answers tools, actions and cards");
  const tool = (name: string, args: Record<string, string | number | boolean> = {}, more?: Partial<PluginContext>) =>
    callTool(name, args, context(more));
  const act = (name: string, args: Record<string, unknown> = {}, more?: Partial<PluginContext>) =>
    callAction(name, args, context(more));
  const card = (name: string, args: Record<string, string | number | boolean> = {}) => callCard(name, args, context());
  return { storage, gameDir, launches, backend, context, tool, act, card };
}
