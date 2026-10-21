/**
 * A made-up Mac for the Game mods plugin: Steam with its library list and the games' manifests and
 * folders where the test puts them, Epic's manifests, Minecraft's launcher and folder, and the
 * Game mods backend over it in an open Genex game, with every launch recorded. Nothing here starts a
 * game or reads the real computer's stores.
 */
import { mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PluginContext } from "../../src/plugin-sdk/index.d.ts";
import { createModsBackend } from "../../src/plugins/mods/backend.ts";
import type { GamesEnv } from "../../src/plugins/mods/find-games.ts";
import type { Launch } from "../../src/plugins/mods/launch.ts";
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

/** Steam's folder below a made-up home. */
const STEAM = ["Library", "Application Support", "Steam"];

/** Valve's KeyValues for a manifest. */
function manifest(game: FakeSteamGame): string {
  return `"AppState"\n{\n\t"appid"\t\t"${game.id}"\n\t"name"\t\t"${game.name}"\n\t"installdir"\t\t"${game.dir ?? game.name}"\n}\n`;
}

/** Writes each `/`-path below `root`: a folder for one ending in `/`, else an empty file. */
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

/** A made-up Mac with these Steam games (and optionally Minecraft and Epic games). */
export async function fakeComputer(
  options: { steam?: FakeSteamGame[]; minecraft?: boolean; epic?: Array<Record<string, unknown>> } = {},
) {
  const root = await realpath(await tmpDir("mods-computer-"));
  const home = path.join(root, "home");
  const applications = path.join(root, "Applications");
  const steam = path.join(home, ...STEAM);
  const second = path.join(root, "Games", "SteamLibrary");
  await mkdir(path.join(steam, "steamapps"), { recursive: true });
  await mkdir(applications, { recursive: true });
  const list = `"libraryfolders"\n{\n\t"0"\n\t{\n\t\t"path"\t\t"${steam}"\n\t}\n\t"1"\n\t{\n\t\t"path"\t\t"${second}"\n\t}\n}\n`;
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
    await mkdir(path.join(applications, "Minecraft.app", "Contents"), { recursive: true });
    await mkdir(path.join(home, "Library", "Application Support", "minecraft", "saves", "World"), { recursive: true });
  }
  const epic = path.join(home, "Library", "Application Support", "Epic", "EpicGamesLauncher", "Data", "Manifests");
  for (const [at, item] of (options.epic ?? []).entries()) {
    await mkdir(epic, { recursive: true });
    await writeFile(path.join(epic, `${at}.item`), JSON.stringify(item));
  }
  const env: GamesEnv = {
    platform: "darwin",
    home,
    applications,
    appData: path.join(home, "AppData", "Roaming"),
    programData: path.join(root, "ProgramData"),
    programFilesX86: path.join(root, "Program Files (x86)"),
  };
  /** A game's folder in Steam's own library. */
  const steamGame = (dir: string) => path.join(steam, "steamapps", "common", dir);
  return { root, home, applications, steam, second, epic, env, steamGame };
}

/** The Game mods backend on a made-up computer, in an open game (`valley`) whose folder is real. */
export async function modsBackend(computer: Awaited<ReturnType<typeof fakeComputer>>, game = "valley") {
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
  const { tool: callTool, action: callAction } = backend;
  if (!callTool || !callAction) throw new Error("The Game mods backend answers tools and actions");
  const tool = (name: string, args: Record<string, string | number | boolean> = {}, more?: Partial<PluginContext>) =>
    callTool(name, args, context(more));
  const act = (name: string, args: Record<string, unknown> = {}, more?: Partial<PluginContext>) =>
    callAction(name, args, context(more));
  return { storage, gameDir, launches, backend, context, tool, act };
}
