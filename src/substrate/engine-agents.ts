/**
 * Whether agents may use an engine's editor while the person plays in it, for every game of that
 * engine: the engine panel's Agents checkbox, on unless the person turned it off, kept in the engine
 * plugin's storage. While it is on, the plugin's editor-lock probe lets an agent's call go ahead of
 * the person's play, and says so the first time for each game (`firstWentAhead`), so the chat tells
 * the person once; while it is off, agents wait for the person, as any lock does.
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { atomicWriteJson, isJsonObject, readJsonIfExists } from "./fsx.ts";

/** The setting's file in the plugin's storage. */
const SETTING_FILE = "agents.json";
/** The folder holding one record per game the chat was told for. */
const WENT_AHEAD_FOLDER = "went-ahead";
/** A game id as Genex names a game: a plain folder name, never a path. */
const GAME_ID = /^[a-zA-Z0-9_-]{1,100}$/;

/** What the panel reads and sets: whether agents may use the editor while the person plays. */
export interface AgentsSetting {
  whilePlaying: boolean;
}

/** The setting as the person left it, on where they never turned it off. */
export async function agentsSetting(storage: string): Promise<AgentsSetting> {
  const saved = await readJsonIfExists<unknown>(path.join(storage, SETTING_FILE)).catch(() => null);
  return { whilePlaying: !(isJsonObject(saved) && saved.whilePlaying === false) };
}

/** The person's choice, kept for every game. */
export async function setAgentsSetting(storage: string, whilePlaying: boolean): Promise<AgentsSetting> {
  await mkdir(storage, { recursive: true, mode: 0o700 });
  await atomicWriteJson(path.join(storage, SETTING_FILE), { whilePlaying });
  return { whilePlaying };
}

/**
 * Whether this is the first time an agent went ahead of the person in `game`, remembered from now
 * on: true once per game, false for a game id that names no game.
 */
export async function firstWentAhead(storage: string, game: string): Promise<boolean> {
  if (!GAME_ID.test(game)) return false;
  const file = path.join(storage, WENT_AHEAD_FOLDER, `${game}.json`);
  if (await readJsonIfExists<unknown>(file).catch(() => null)) return false;
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await atomicWriteJson(file, { told: true });
  return true;
}
