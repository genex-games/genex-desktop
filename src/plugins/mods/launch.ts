/**
 * Opening the person's own game and its folders: the store's own link starts a game the way its
 * library's Play does (Steam's `steam://rungameid/`, Epic's launcher link), Minecraft's launcher
 * opens as an app, and a folder opens in Finder or Explorer. Each launch is a value, so tests
 * record what would start instead of starting it. Genex starts no game process itself.
 */
import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { SECOND_MS } from "../../shared/duration.ts";
import { StudioPlatform } from "../../shared/boot.ts";
import { type GamesEnv, GameStore } from "./find-games.ts";
import type { ModTarget } from "./mod-link.ts";

/** One thing to start: a command, its arguments, and whether it outlives the call. */
export type Launch = { command: string; args: string[]; detached: boolean };

const MAC_OPEN = "/usr/bin/open";
/** Windows's own folder when the environment names none, and its program that opens a link or a folder. */
const WINDOWS_ROOT = "C:\\Windows";
const WINDOWS_EXPLORER = "explorer.exe";
/** How long `open` may take. */
const OPEN_TIMEOUT_MS = 10 * SECOND_MS;
/** Steam app ids and Epic app names, as a store link may carry them. */
const STORE_ID = /^[\w.-]{1,120}$/;

/** Windows's explorer by its whole path, so neither PATH nor the current folder stands in. */
function explorer(env: NodeJS.ProcessEnv): string {
  const named = env.SystemRoot;
  return path.win32.join(named && path.win32.isAbsolute(named) ? named : WINDOWS_ROOT, WINDOWS_EXPLORER);
}

/** Opens a link or a folder the platform's way. */
function openWith(env: GamesEnv, target: string, processEnv: NodeJS.ProcessEnv): Launch {
  if (env.platform === StudioPlatform.Windows) return { command: explorer(processEnv), args: [target], detached: true };
  return { command: MAC_OPEN, args: [target], detached: false };
}

/** The store's link that starts a game, or null for a game no link starts. */
function storeLink(game: ModTarget): string | null {
  if (!game.storeId || !STORE_ID.test(game.storeId)) return null;
  if (game.store === GameStore.Steam) return `steam://rungameid/${game.storeId}`;
  if (game.store === GameStore.Epic)
    return `com.epicgames.launcher://apps/${encodeURIComponent(game.storeId)}?action=launch&silent=true`;
  return null;
}

/** How the game starts on this computer, or null when Genex can't start it (Minecraft's launcher on Windows). */
export function playLaunch(env: GamesEnv, game: ModTarget, processEnv: NodeJS.ProcessEnv = process.env): Launch | null {
  if (game.store === GameStore.Minecraft) {
    if (env.platform === StudioPlatform.Windows) return null;
    return { command: MAC_OPEN, args: ["-a", path.posix.join(env.applications, "Minecraft.app")], detached: false };
  }
  const link = storeLink(game);
  return link ? openWith(env, link, processEnv) : null;
}

/** A folder in Finder or Explorer. */
export function openFolderLaunch(env: GamesEnv, folder: string, processEnv: NodeJS.ProcessEnv = process.env): Launch {
  return openWith(env, folder, processEnv);
}

const run = promisify(execFile);

/** This computer's: `open` waited on, a detached start let go once it started. */
export async function systemOpen(launch: Launch): Promise<void> {
  if (!launch.detached) {
    await run(launch.command, launch.args, { timeout: OPEN_TIMEOUT_MS });
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(launch.command, launch.args, { detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
