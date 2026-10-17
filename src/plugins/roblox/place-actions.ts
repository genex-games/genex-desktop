/**
 * New Roblox game, Open in Studio and Quit Studio, for the panel's buttons and the agent's tools.
 *
 * - **New Roblox game** writes `<name>.rbxlx` from the shipped Baseplate into the open game's
 *   folder (or into a Genex game made for it when none is open), keeps Studio's lock files out of
 *   save points, links the game to it and opens it in Studio with `--task EditFile`.
 * - **Open in Studio** opens the game's own place (a local file with EditFile, a published place
 *   with EditPlace) or, when a Studio has it open already, brings Studio forward instead of opening
 *   it twice. With no game or no place, it opens Studio alone.
 * - **Quit Studio** is Studio's normal quit, which asks the person to save; never while a build is
 *   using Studio.
 */
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { PluginContext, PluginEngineLink } from "../../plugin-sdk/index.d.ts";
import { errorMessage } from "../../shared/errors.ts";
import { PluginService } from "../../shared/plugins.ts";
import { writeCheckConfigs } from "./check-scripts.ts";
import { createPlace, SHIPPED_TEMPLATE, suggestName } from "./create-place.ts";
import { PLACE_PROMPTS } from "./place-prompts.ts";
import { type PlaceDeps, placeOpenNow } from "./places.ts";
import { ignoreLocks } from "./script-sync.ts";
import { type PlaceLink, readPlaceLink, writePlaceRecord } from "./studio-binding.ts";
import {
  focusLaunch,
  type LaunchDeps,
  type Launch,
  markStarting,
  openLaunch,
  openPlaceLaunch,
  type PlaceTarget,
  quitStudio,
} from "./studio-launch.ts";
import { locateStudio, type StudioInstall, studioRunning } from "./studio-locate.ts";
import { MESSAGE } from "./words.ts";

/** A project file for a place with no file of its own. */
const PROJECT_FILE = ".project.json";

/** What the place actions need of the computer. */
export interface PlaceActionDeps extends PlaceDeps, LaunchDeps {
  /** The Baseplate a new place is written from; the shipped one by default. */
  template?: string;
  /** A Genex game made for a new place: the script sync learns its folder. */
  gameSeen?(storage: string, game: string, folder: string): Promise<void>;
}

/** New Roblox game's answer. */
export interface CreateAnswer {
  created: boolean;
  message: string;
  file?: string;
  /** The Genex game made for the place when none was open. */
  game?: { project: string };
  opened?: boolean;
}

/** Open in Studio's answer. */
export interface OpenAnswer {
  opened: boolean;
  message: string;
}

/** Why Quit Studio left Studio open. Wire values: never rename. */
export const QuitMiss = {
  /** A build is using Studio. */
  InUse: "in-use",
  NotRunning: "not-running",
  /** Studio was asked to quit and is still open: it may be asking the person to save. */
  StillOpen: "still-open",
} as const;
export type QuitMiss = (typeof QuitMiss)[keyof typeof QuitMiss];

/** Quit Studio's answer. */
export interface QuitAnswer {
  quit: boolean;
  message: string;
  reason?: QuitMiss;
  /** The build using Studio, when one is. */
  inUse?: string;
}

/** The game's title from its studio.json, else its id. */
export async function titleOf(folder: string, game: string): Promise<string> {
  const meta = await readFile(path.join(folder, "studio.json"), "utf8")
    .then((text) => JSON.parse(text) as { title?: unknown })
    .catch(() => undefined);
  return typeof meta?.title === "string" && meta.title.trim() ? meta.title.trim() : game;
}

const isMadeGame = (value: unknown): value is { project: string; directory: string } =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { project?: unknown }).project === "string" &&
  typeof (value as { directory?: unknown }).directory === "string";

/** Where a new place goes: the open game, or a Genex game made for it. */
async function placeHome(
  context: PluginContext,
  title: string,
): Promise<{ game: string; folder: string; made: boolean; title: string }> {
  if (context.project && context.directory) {
    const folder = await realpath(context.directory);
    return { game: context.project, folder, made: false, title: await titleOf(folder, context.project) };
  }
  const made = await context.host(PluginService.GameCreate, { title });
  if (!isMadeGame(made)) throw new Error(PLACE_PROMPTS.NoGame);
  return { game: made.project, folder: await realpath(made.directory), made: true, title };
}

/** Opens a place in Studio, noting Starting for the button; why it didn't open, else undefined. */
async function openPlace(deps: PlaceActionDeps, install: StudioInstall, storage: string, target: PlaceTarget) {
  try {
    await deps.open(openPlaceLaunch(deps.platform, install, target));
    await markStarting(storage, deps.now());
    return undefined;
  } catch (error) {
    return errorMessage(error);
  }
}

/** Whether to take a snapshot first: the panel's press does; the agent's tool is snapshotted by Genex. */
export interface CreateOptions {
  snapshot: boolean;
  title?: string;
}

/**
 * New Roblox game: the place written, linked and opened. In an open game that already builds in a
 * place, nothing is written: the person chooses another place in the panel.
 */
export async function createGame(
  deps: PlaceActionDeps,
  context: PluginContext,
  options: CreateOptions,
): Promise<CreateAnswer> {
  const location = await locateStudio(deps);
  if (!location.installed) return { created: false, message: MESSAGE.Open.NotInstalled };
  if (context.project && (await context.host(PluginService.GameEngineRead).catch(() => null)))
    return { created: false, message: MESSAGE.Create.Exists };
  const storage = await context.host(PluginService.StorageRoot);
  const home = await placeHome(context, options.title?.trim() || MESSAGE.Create.DefaultTitle);
  const name = await suggestName(home.folder, home.title);
  if (options.snapshot && !home.made)
    await context.host(PluginService.GameSnapshot, { reason: MESSAGE.Create.SnapshotReason });
  const file = await createPlace({ folder: home.folder, name, template: deps.template ?? SHIPPED_TEMPLATE });
  await ignoreLocks(home.folder, () => undefined);
  // The Luau checks' settings a new game starts with; a game's own are never replaced.
  await writeCheckConfigs(home.folder).catch(() => []);
  await writePlaceRecord(storage, home.game, { folder: home.folder, project: file });
  if (home.made) await deps.gameSeen?.(storage, home.game, home.folder);
  await context.host(PluginService.GameEngineLink, { project: file, ...(home.made ? { game: home.game } : {}) });
  const why = await openPlace(deps, location.install, storage, { file });
  const answer: CreateAnswer = {
    created: true,
    file,
    opened: why === undefined,
    message: why === undefined ? MESSAGE.Create.Created(name) : MESSAGE.Create.CreatedNotOpened(name, why),
    ...(home.made ? { game: { project: home.game } } : {}),
  };
  return answer;
}

/** The agent's `new-game`: New Roblox game in its open game, answered in words. */
export async function newGameTool(deps: PlaceActionDeps, context: PluginContext): Promise<string> {
  if (!context.project || !context.directory) throw new Error(PLACE_PROMPTS.NoGame);
  const answer = await createGame(deps, context, { snapshot: false });
  if (!answer.created || !answer.file) throw new Error(answer.message);
  const name = path.basename(answer.file);
  if (answer.opened) return PLACE_PROMPTS.NewGame(name);
  return PLACE_PROMPTS.NewGameNotOpened(name, answer.message);
}

/** `engine-status`: whether a new Roblox game can be made here, and the engine question's words. */
export async function engineStatus(deps: PlaceActionDeps) {
  const location = await locateStudio(deps);
  if (!location.installed) return { ready: false, note: PLACE_PROMPTS.NotInstalled };
  const version = location.install.version;
  return { ready: true, note: PLACE_PROMPTS.Ready(version), ...(version ? { version } : {}) };
}

/** How Studio opens the game's linked place, or undefined for a place with no file nor ids. */
function targetOf(link: PluginEngineLink): PlaceTarget | undefined {
  if (link.remote) return { placeId: link.remote.placeId, universeId: link.remote.universeId };
  return link.project.toLowerCase().endsWith(PROJECT_FILE) ? undefined : { file: link.project };
}

/** Brings Studio forward where the system can, saying the place is already open. */
async function bringForward(deps: PlaceActionDeps, install: StudioInstall, name: string): Promise<OpenAnswer> {
  const focus: Launch | undefined = focusLaunch(deps.platform, install);
  if (focus) await deps.open(focus).catch(() => undefined);
  return { opened: false, message: MESSAGE.Open.PlaceAlreadyOpen(name) };
}

/** Opens Studio alone, unless it is already open. */
async function openStudioAlone(deps: PlaceActionDeps, install: StudioInstall): Promise<OpenAnswer> {
  if (await studioRunning(deps)) return { opened: false, message: MESSAGE.Open.AlreadyOpen };
  await deps.open(openLaunch(deps.platform, install));
  return { opened: true, message: MESSAGE.Open.Opening };
}

/** Open in Studio: the game's own place, brought forward when a Studio has it open; else Studio alone. */
export async function openStudio(deps: PlaceActionDeps, context: PluginContext): Promise<OpenAnswer> {
  const location = await locateStudio(deps);
  if (!location.installed) return { opened: false, message: MESSAGE.Open.NotInstalled };
  const link = context.project ? await context.host(PluginService.GameEngineRead).catch(() => null) : null;
  if (!context.project || !link) return openStudioAlone(deps, location.install);
  const storage = await context.host(PluginService.StorageRoot);
  const place: PlaceLink = (await readPlaceLink(storage, context.project)) ?? { project: link.project };
  const name = place.name ?? link.name;
  if (await placeOpenNow(deps, place)) return bringForward(deps, location.install, name);
  const target = targetOf(link);
  if (!target) {
    const alone = await openStudioAlone(deps, location.install);
    return { opened: alone.opened, message: MESSAGE.Open.NotSaved(name) };
  }
  const why = await openPlace(deps, location.install, storage, target);
  return why === undefined
    ? { opened: true, message: MESSAGE.Open.OpeningPlace(name) }
    : { opened: false, message: why };
}

const isRun = (value: unknown): value is { title: string } =>
  typeof value === "object" && value !== null && typeof (value as { title?: unknown }).title === "string";

/** Quit Studio: its normal quit, which asks the person to save; never while a build uses Studio. */
export async function quitStudioAction(deps: PlaceActionDeps, context: PluginContext): Promise<QuitAnswer> {
  const runs = await context.host(PluginService.GameEngineRuns).catch(() => []);
  const busy = Array.isArray(runs) ? runs.find(isRun) : undefined;
  if (busy) return { quit: false, message: MESSAGE.Quit.InUse(busy.title), reason: QuitMiss.InUse, inUse: busy.title };
  if (!(await studioRunning(deps)))
    return { quit: false, message: MESSAGE.Quit.NotRunning, reason: QuitMiss.NotRunning };
  if (await quitStudio(deps)) return { quit: true, message: MESSAGE.Quit.Quitting };
  return { quit: false, message: MESSAGE.Quit.StillOpen, reason: QuitMiss.StillOpen };
}

/** The agent's `show-steps`: the setup card in its chat while a step is open. */
export async function showSteps(context: PluginContext, open: boolean): Promise<string> {
  if (!open) return PLACE_PROMPTS.StepsDone;
  return (await context.host(PluginService.GameEngineSteps)) ? PLACE_PROMPTS.StepsShown : PLACE_PROMPTS.StepsNoChat;
}
