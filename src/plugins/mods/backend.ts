/**
 * The Game mods plugin's backend. A Genex project becomes a mod of a game the person installed
 * (`find-games`, then `use-game`); the agent builds the mod in the project with the game's own
 * modding route, `install` copies it into the game (asking the person first, keeping what it
 * replaces and the saves), `play` opens the game for testing, and `remove` puts the game back.
 * The panel, the toolbar button and Live's card show where the mod stands and offer Play and
 * Remove mod. Every folder written to is worked out from the linked game's id at each call.
 */
import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import type { Activate, PluginActivation, PluginContext } from "../../plugin-sdk/index.d.ts";
import { atomicWriteText, readRegularFile } from "../../substrate/fsx.ts";
import { HOOK_IMAGE_MAX_BYTES, type HookAnswer } from "../../shared/plugin-hooks.ts";
import { findGames, type GamesEnv, systemGamesEnv } from "./find-games.ts";
import {
  hasInstalled,
  type InstallPlaces,
  InstallRefused,
  InstallRoot,
  installMod,
  keptSavesAt,
  readRecord,
  removeMod,
  restoreSaves,
} from "./install.ts";
import { type Launch, openFolderLaunch, playLaunch, systemOpen } from "./launch.ts";
import {
  findTarget,
  linkedTarget,
  MOD_FILE,
  type ModTarget,
  modFileText,
  modTarget,
  projectKey,
  readLink,
  writeLink,
} from "./mod-link.ts";
import { steamPicture } from "./pictures.ts";
import { AGENT, gameLine, MAX_LISTED_GAMES, PERSON } from "./words.ts";

/** The host services this backend calls, by their public SDK names. */
const HostService = { StorageRoot: "storage.root" } as const;

/** The tools plugin.json declares: the agent's, then the observer's (`audience: harness`). */
export const ModsTool = {
  FindGames: "find-games",
  UseGame: "use-game",
  Install: "install",
  Remove: "remove",
  Play: "play",
  GameShots: "game-shots",
} as const;
type ModsTool = (typeof ModsTool)[keyof typeof ModsTool];
const TOOL_NAMES: ReadonlySet<string> = new Set(Object.values(ModsTool));
const isModsTool = (name: string): name is ModsTool => TOOL_NAMES.has(name);

/** The actions plugin.json declares: the panel's, the toolbar's and Live's card's. */
export const ModsAction = {
  Status: "status",
  StageStatus: "stage-status",
  ToolbarStatus: "toolbar-status",
  Play: "play",
  Remove: "remove",
  RestoreSaves: "restore-saves",
  OpenFolder: "open-folder",
} as const;
type ModsAction = (typeof ModsAction)[keyof typeof ModsAction];
const ACTION_NAMES: ReadonlySet<string> = new Set(Object.values(ModsAction));
const isModsAction = (name: string): name is ModsAction => ACTION_NAMES.has(name);

/** The folder of pictures of the game an agent keeps in the project (app_look's save), which the observer hands a reviewer. */
export const SHOTS_FOLDER = "shots";
/** The most pictures the observer hands over: the newest. */
const MAX_SHOTS = 4;
/** The picture files the observer reads. */
const SHOT_FILE = /\.(jpe?g|png)$/i;
/** The plugin's storage folder of each project's installs. */
const INSTALLS_FOLDER = "installs";

/** What the backend works with; tests hand in a made-up computer and record what would open. */
export interface ModsDeps {
  env: GamesEnv;
  open(launch: Launch): Promise<void>;
}

type Handler = (args: Record<string, unknown>, context: PluginContext) => Promise<unknown>;

/** The plugin's storage folder. */
const storageOf = async (context: PluginContext) => String(await context.host(HostService.StorageRoot));

/** The bound game's project name, or a refusal when the call has none. */
function projectOf(context: PluginContext): { project: string; directory: string } {
  if (!context.project || !context.directory) throw new Error(AGENT.NoGameHere);
  return { project: context.project, directory: context.directory };
}

/** A string argument, trimmed; empty when absent. */
const textArg = (args: Record<string, unknown>, key: string): string =>
  typeof args[key] === "string" ? args[key].trim() : "";

/** The places an install of `target` reads and writes for this project. */
async function placesFor(context: PluginContext, target: ModTarget): Promise<InstallPlaces> {
  const { project, directory } = projectOf(context);
  return {
    project: directory,
    kept: path.join(await storageOf(context), INSTALLS_FOLDER, projectKey(project)),
    roots: { [InstallRoot.Mods]: target.mods, [InstallRoot.Game]: target.folder },
    saves: target.saves,
  };
}

/** The game this project is a mod of, as installed now; throws the agent's words when there is none or it can't be modded. */
async function requireTarget(deps: ModsDeps, context: PluginContext): Promise<ModTarget> {
  const { project } = projectOf(context);
  const link = await readLink(await storageOf(context), project);
  if (!link) throw new Error(AGENT.NotLinked);
  const target = await findTarget(deps.env, link.id);
  if (!target) throw new Error(AGENT.Gone(link.name));
  if (target.refusal) throw new Error(AGENT.Refused(target));
  return target;
}

/** `find-games`: the installed games, or those whose name holds the person's words. */
async function findGamesTool(deps: ModsDeps, args: Record<string, unknown>): Promise<string> {
  const games = await findGames(deps.env);
  if (!games.length) return AGENT.NoGames;
  const name = textArg(args, "name").toLowerCase();
  const matching = name ? games.filter((g) => g.name.toLowerCase().includes(name)) : games;
  const listed = (matching.length ? matching : games).slice(0, MAX_LISTED_GAMES);
  const lines = (await Promise.all(listed.map((g) => modTarget(deps.env, g)))).map(gameLine);
  if (name && !matching.length) return AGENT.NoMatch(textArg(args, "name"), lines);
  return AGENT.Listed(lines, Math.max(0, (matching.length ? matching : games).length - listed.length));
}

/** `use-game`: makes this project a mod of an installed game, by the id `find-games` gave it. */
async function useGame(deps: ModsDeps, args: Record<string, unknown>, context: PluginContext): Promise<string> {
  const { project, directory } = projectOf(context);
  const id = textArg(args, "game");
  const target = await findTarget(deps.env, id);
  if (!target) return AGENT.UnknownGame(id);
  if (target.refusal) return AGENT.Refused(target);
  const storage = await storageOf(context);
  const linked = await readLink(storage, project);
  if (linked && linked.id !== target.id) return AGENT.OtherGame(linked.name);
  await writeLink(storage, project, target);
  await atomicWriteText(path.join(directory, MOD_FILE), modFileText(target));
  return AGENT.Linked(target);
}

/** Where an install goes: the place the agent named, else the mods folder when Genex knows one, else the game's folder. */
function intoOf(args: Record<string, unknown>, target: ModTarget): InstallRoot {
  if (args.into === InstallRoot.Mods || args.into === InstallRoot.Game) return args.into;
  return target.mods ? InstallRoot.Mods : InstallRoot.Game;
}

/** `install`: copies a file or folder of the project into the game; the person approved it on the card. */
async function install(deps: ModsDeps, args: Record<string, unknown>, context: PluginContext): Promise<string> {
  const target = await requireTarget(deps, context);
  const to = textArg(args, "to");
  const ask = {
    from: textArg(args, "from"),
    into: intoOf(args, target),
    contents: args.contents === true,
    ...(to ? { to } : {}),
  };
  try {
    const done = await installMod(await placesFor(context, target), target.id, ask);
    return AGENT.Installed(done.copied, done.replaced, done.folder, done.saves);
  } catch (error) {
    if (error instanceof InstallRefused) return `${error.message} Nothing was copied.`;
    throw error;
  }
}

/** `remove` (and Remove mod): takes everything the project put in the game out again. */
async function remove(deps: ModsDeps, context: PluginContext): Promise<string> {
  const { project } = projectOf(context);
  const target = await linkedTarget(deps.env, await storageOf(context), project);
  if (!target) throw new Error(AGENT.NotLinked);
  const places = await placesFor(context, target);
  if (!(await hasInstalled(places.kept, target.id))) return AGENT.NothingToRemove(target.name);
  const done = await removeMod(places, target.id);
  return AGENT.Removed(target.name, done.removed, done.restored);
}

/** `play` (and Play): opens the game through its store or launcher. */
async function play(deps: ModsDeps, context: PluginContext): Promise<string> {
  const target = await requireTarget(deps, context);
  const launch = playLaunch(deps.env, target);
  if (!launch) return AGENT.CantOpen(target.name);
  await deps.open(launch);
  return AGENT.Opened(target);
}

/** The observer's pictures: the newest pictures of the game the agent kept in the project's shots folder. */
async function gameShots(context: PluginContext): Promise<HookAnswer> {
  if (!context.directory) return {};
  const folder = path.join(context.directory, SHOTS_FOLDER);
  const files = await readdir(folder, { withFileTypes: true }).catch(() => []);
  const pictures = files.filter((f) => f.isFile() && SHOT_FILE.test(f.name)).map((f) => f.name);
  const images = [];
  for (const name of pictures.sort().reverse().slice(0, MAX_SHOTS)) {
    const bytes = await readRegularFile(path.join(folder, name), HOOK_IMAGE_MAX_BYTES).catch(() => null);
    if (bytes) images.push({ name, data: bytes.toString("base64") });
  }
  return images.length ? { images } : {};
}

/** The game as the panel shows it. */
interface PanelGame {
  name: string;
  store: string;
  builtWith: string | null;
  folder: string;
  mods: string | null;
  picture: string | null;
}

/** What the panel, the toolbar and Live's card read: no game linked, a linked game that is gone, or the game and the mod's standing. */
type ModStatus =
  | { linked: false }
  | { linked: true; gone: true; name: string }
  | { linked: true; gone: false; game: PanelGame; files: number; savesAt: string | null; canPlay: boolean };

/** Where this project's mod stands. */
async function status(deps: ModsDeps, context: PluginContext): Promise<ModStatus> {
  if (!context.project) return { linked: false };
  const storage = await storageOf(context);
  const link = await readLink(storage, context.project);
  if (!link) return { linked: false };
  const target = await findTarget(deps.env, link.id);
  if (!target) return { linked: true, gone: true, name: link.name };
  const kept = path.join(storage, INSTALLS_FOLDER, projectKey(context.project));
  const game: PanelGame = {
    name: target.name,
    store: PERSON.Store(target.store),
    builtWith: PERSON.BuiltWith(target.builtWith),
    folder: target.folder,
    mods: target.mods,
    picture: await steamPicture(deps.env, target),
  };
  const files = (await readRecord(kept, target.id)).files.length;
  const savesAt = await keptSavesAt(kept, target.id);
  return { linked: true, gone: false, game, files, savesAt, canPlay: playLaunch(deps.env, target) !== null };
}

/** The mod's standing in one line: in the game or not yet. */
const standing = (game: PanelGame, files: number) =>
  files ? PERSON.InGame(game.name, files) : PERSON.NotInGame(game.name);

/** Live's card: where the mod stands in one line, and Play. */
async function stageStatus(deps: ModsDeps, context: PluginContext) {
  const s = await status(deps, context);
  if (!s.linked) return { line: PERSON.Lost };
  if (s.gone) return { line: PERSON.Gone(s.name) };
  const button = s.canPlay ? { button: { label: PERSON.Play(s.game.name), action: ModsAction.Play } } : {};
  return { line: standing(s.game, s.files), ...button };
}

/** The toolbar button: the mod's standing in its tooltip, a green dot while the mod is in the game. */
async function toolbarStatus(deps: ModsDeps, context: PluginContext) {
  const s = await status(deps, context);
  if (!s.linked || s.gone) return {};
  return { title: standing(s.game, s.files), ...(s.files ? { tone: "ok", dot: true } : {}) };
}

/** Show game folder: the game's folder (or its mods folder) in Finder or Explorer. */
async function openFolder(deps: ModsDeps, args: Record<string, unknown>, context: PluginContext) {
  const target = await requireTarget(deps, context);
  const folder = args.which === InstallRoot.Mods && target.mods ? target.mods : target.folder;
  await mkdir(folder, { recursive: true }).catch(() => {});
  await deps.open(openFolderLaunch(deps.env, folder));
  return { opened: true };
}

/** Put back saves: the saves copied aside before the first install go back over the game's. */
async function putBackSaves(deps: ModsDeps, context: PluginContext) {
  const target = await requireTarget(deps, context);
  return { restored: await restoreSaves(await placesFor(context, target), target.id) };
}

/** The backend over the computer it is given; tests hand in a made-up one. */
export function createModsBackend(deps: ModsDeps): PluginActivation {
  const tools: Record<ModsTool, Handler> = {
    [ModsTool.FindGames]: (args) => findGamesTool(deps, args),
    [ModsTool.UseGame]: (args, context) => useGame(deps, args, context),
    [ModsTool.Install]: (args, context) => install(deps, args, context),
    [ModsTool.Remove]: (_args, context) => remove(deps, context),
    [ModsTool.Play]: (_args, context) => play(deps, context),
    [ModsTool.GameShots]: (_args, context) => gameShots(context),
  };
  const actions: Record<ModsAction, Handler> = {
    [ModsAction.Status]: (_args, context) => status(deps, context),
    [ModsAction.StageStatus]: (_args, context) => stageStatus(deps, context),
    [ModsAction.ToolbarStatus]: (_args, context) => toolbarStatus(deps, context),
    [ModsAction.Play]: (_args, context) => play(deps, context),
    [ModsAction.Remove]: (_args, context) => remove(deps, context),
    [ModsAction.RestoreSaves]: (_args, context) => putBackSaves(deps, context),
    [ModsAction.OpenFolder]: (args, context) => openFolder(deps, args, context),
  };
  return {
    async tool(name, args, context) {
      if (!isModsTool(name)) throw new Error(AGENT.UnknownTool(name));
      return tools[name](args, context);
    },
    async action(name, args, context) {
      if (!isModsAction(name)) throw new Error(AGENT.UnknownAction(name));
      return actions[name](args, context);
    },
  };
}

export const activate: Activate = () => createModsBackend({ env: systemGamesEnv(), open: systemOpen });
