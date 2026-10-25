/**
 * The places a Roblox game can build in, and linking a game to one.
 *
 * - **Choose your place** (`places`) lists the places open in Studio first (each asked, in Edit,
 *   for its published ids), then place files from Studio's own recent list (a Mac's Studio
 *   preferences) and the top of Documents › Roblox: one row per real path, newest first, at most
 *   {@link MAX_PLACES}, the file scan kept for {@link SCAN_KEEP_MS}. macOS asks the person before an
 *   app reads Documents, so only this press reads it; the status, the toolbar and the steps card
 *   never do. Two Studios with one name are told apart as "Place1" and "Place1 (2)".
 * - **Use in this game** (`use-place`) links the bound game to a place:
 *   - a local place file where it is, by its real path (never a link, never another extension);
 *   - a published place through `default.project.json` in the game folder, listed first as
 *     Genex's own in the script sync's record (so it is never taken for the person's Rojo project),
 *     linked with its ids as decimal strings;
 *   - a place never saved to a file through that same project file, found in Studio by its name,
 *     which the backend keeps in its own record beside the link.
 *   One game per place: a place another live game builds in is refused in plain words, and is free
 *   again once that game's folder no longer links it (the game was removed, or linked elsewhere).
 */
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { PluginContext, PluginEngineLink } from "../../plugin-sdk/index.d.ts";
import { SECOND_MS } from "../../shared/duration.ts";
import { isJsonObject, readRegularFile } from "../../substrate/fsx.ts";
import { PluginService } from "../../shared/plugins.ts";
import { asAgentInStudio } from "./agent-marks.ts";
import { writeWhole } from "./place-files.ts";
import { PLACE_PROMPTS } from "./place-prompts.ts";
import { ROJO_PROJECT, recordWritten, writtenByGenex } from "./script-sync.ts";
import {
  type PlaceLink,
  type PlaceRecord,
  placeMatcher,
  ROBLOX_ENGINE,
  readPlaceLinks,
  readPlaceRecord,
  restorePlaceRecord,
  writePlaceRecord,
} from "./studio-binding.ts";
import type { StudioClient, StudioEntry } from "./studio-client.ts";
import { isMacPath, isWindowsPath, type LocateFs, type Run } from "./studio-locate.ts";
import { DATAMODEL_ARG, EDIT_DATAMODEL, STUDIO_ID_ARG, StudioTool } from "./studio-tools.ts";
import { MESSAGE } from "./words.ts";

/** The most place files Choose your place lists. */
export const MAX_PLACES = 12;
/** How long a scan of place files is kept before the next press reads the disk again. */
export const SCAN_KEEP_MS = 30 * SECOND_MS;
/** How long an open Studio gets to say what its place is. */
export const PLACE_ASK_MS = 5 * SECOND_MS;
/** Place files a game can link where they are. */
export const PLACE_FILE_EXTENSIONS = [".rbxl", ".rbxlx"] as const;
/** Studio's preferences on a Mac, whose recent-files list names the places opened lately. */
const MAC_DEFAULTS = "/usr/bin/defaults";
const STUDIO_DOMAIN = "com.Roblox.RobloxStudio";
/** A recent place in Studio's exported preferences: `<user id>rbxRecentFiles_v<n>.<i>name`. */
const RECENT_ENTRY = /<key>\d*rbxRecentFiles_v[\d.]+\.\d+name<\/key>\s*<string>([^<]{1,4096})<\/string>/g;
/** What a Studio says of its place, from {@link PLACE_READ_LUAU}. */
const PLACE_ANSWER = /genex-place (\d{1,20}) (\d{1,20})/;
/** Read-only, in Edit: the place's id and its experience's id, both 0 for a place never published. */
const PLACE_READ_LUAU = 'return "genex-place " .. tostring(game.PlaceId) .. " " .. tostring(game.GameId)';
const UNPUBLISHED = "0";
const CONTROL = /[\u0000-\u001f\u007f]/;
const CONTROLS = /[\u0000-\u001f\u007f]/g;
const MAX_META_BYTES = 1024 * 1024;
/** Folders macOS guards with a prompt: only the person's own press may read them. */
const GUARDED_FOLDERS = ["Documents", "Desktop", "Downloads"] as const;

/** What an open Studio's place is. Wire values: never rename. */
export const PlaceKind = {
  /** A place saved to a file on this computer. */
  File: "file",
  /** A place published to Roblox. */
  Published: "published",
  /** A place never saved (a new Baseplate), known by its name in Studio. */
  Unsaved: "unsaved",
} as const;
export type PlaceKind = (typeof PlaceKind)[keyof typeof PlaceKind];

/** Why a game wasn't linked to a place. Wire values: never rename. */
export const PlaceRefusal = {
  /** Not a full .rbxl or .rbxlx path of this computer. */
  BadFile: "bad-file",
  /** Nothing there, or not a regular file. */
  NotPlace: "not-place",
  /** The file, or the game's project file, is a link. */
  Linked: "linked",
  /** The Studio isn't open any more. */
  NotListed: "not-listed",
  /** Another open Studio has a place of the same name, so neither can be told apart. */
  SameName: "same-name",
  /** Another live game builds in this place. */
  Taken: "taken",
  NoGame: "no-game",
  /** An agent named a place in a folder macOS guards with a prompt. */
  Guarded: "guarded",
  /** Studio didn't say what its place is. */
  NoAnswer: "no-answer",
  /** The host refused the link. */
  Refused: "refused",
} as const;
export type PlaceRefusal = (typeof PlaceRefusal)[keyof typeof PlaceRefusal];

/** A place that can't be linked, and why, in plain words. */
export class PlaceError extends Error {
  readonly code: PlaceRefusal;
  constructor(code: PlaceRefusal, message: string) {
    super(message);
    this.name = "PlaceError";
    this.code = code;
  }
}

/** A place open in Studio, as Choose your place lists it. */
export interface OpenPlace {
  studio: string;
  /** Its name, told apart from a same-named one: "Place1 (2)". */
  label: string;
  /** Its name in Studio. */
  name: string;
  kind: PlaceKind;
  placeId?: string;
  universeId?: string;
  /** The title of the other game that builds in it. */
  linkedTo?: string;
  /** The game this list is for builds in it. */
  here?: boolean;
}

/** A place file, as Choose your place lists it. */
export interface PlaceFileRow {
  file: string;
  name: string;
  /** A Studio has it open. */
  open: boolean;
  linkedTo?: string;
  here?: boolean;
}

/** Choose your place's answer. */
export interface PlacesAnswer {
  open: OpenPlace[];
  files: PlaceFileRow[];
}

/** Use in this game's answer. */
export interface UsePlaceAnswer {
  linked: boolean;
  message: string;
  reason?: PlaceRefusal;
  /** The place's name, once linked. */
  name?: string;
}

/** What listing and linking places need of the computer. */
export interface PlaceDeps {
  platform: NodeJS.Platform;
  home: string;
  fs: LocateFs;
  run: Run;
  now(): number;
  /** Studio's own MCP server; without it no Studio is open. */
  studio?: Pick<StudioClient, "studios" | "callTool">;
  /**
   * Lists a file Genex writes at the top of `game`'s folder in the script sync's record, in turn
   * with that game's sync; without it the record is written directly.
   */
  noteWritten?(storage: string, game: string, folder: string, name: string): Promise<void>;
}

/** The place files found last, and when. */
export interface ScanCache {
  at?: number;
  files?: FoundFile[];
}

/** A place file found on disk: its real path and when it last changed. */
interface FoundFile {
  file: string;
  modifiedMs: number;
}

const isPlaceName = (name: string) => PLACE_FILE_EXTENSIONS.some((extension) => name.toLowerCase().endsWith(extension));

/** A file's name without its place extension. */
const stemOf = (file: string) => {
  const base = file.split(/[\\/]/).pop() ?? file;
  return base.replace(/\.rbxlx?$/i, "");
};

const baseOf = (platform: NodeJS.Platform, file: string) =>
  (platform === "win32" ? path.win32 : path.posix).basename(file);

/** Whether `file` is a full path of `platform`'s spelling, with no control character. */
function fullPath(platform: NodeJS.Platform, file: string): boolean {
  if (CONTROL.test(file)) return false;
  if (platform === "win32") return isWindowsPath(file);
  return isMacPath(file);
}

/** The real path of a plain .rbxl or .rbxlx file; anything else is refused with its reason. */
export async function placeFile(fs: LocateFs, platform: NodeJS.Platform, file: unknown): Promise<string> {
  const named = typeof file === "string" ? file : "";
  if (!named || !fullPath(platform, named) || !isPlaceName(named))
    throw new PlaceError(PlaceRefusal.BadFile, MESSAGE.Places.BadFile(named));
  const info = await fs.lstat(named);
  if (info?.link) throw new PlaceError(PlaceRefusal.Linked, MESSAGE.Places.LinkedFile(named));
  if (!info?.file) throw new PlaceError(PlaceRefusal.NotPlace, MESSAGE.Places.NotPlace(named));
  const real = await fs.realpath(named);
  if (!isPlaceName(real)) throw new PlaceError(PlaceRefusal.BadFile, MESSAGE.Places.BadFile(named));
  return real;
}

/** The places in Studio's recent list on a Mac, from its exported preferences; none elsewhere. */
export async function studioRecents(run: Run, platform: NodeJS.Platform): Promise<string[]> {
  if (platform !== "darwin") return [];
  const answer = await run(MAC_DEFAULTS, ["export", STUDIO_DOMAIN, "-"]).catch(() => undefined);
  if (answer?.code !== 0) return [];
  const unescape = (text: string) =>
    text
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&quot;", '"')
      .replaceAll("&apos;", "'")
      .replaceAll("&amp;", "&");
  return [...answer.stdout.matchAll(RECENT_ENTRY)].map((match) => unescape(match[1] ?? ""));
}

/** Documents › Roblox, where Studio saves places by default. */
function documentsRoblox(deps: PlaceDeps): string {
  const flavour = deps.platform === "win32" ? path.win32 : path.posix;
  return flavour.join(deps.home, "Documents", "Roblox");
}

/** The place files at the top of Documents › Roblox; none when it can't be read. */
async function documentPlaces(deps: PlaceDeps): Promise<string[]> {
  const folder = documentsRoblox(deps);
  const flavour = deps.platform === "win32" ? path.win32 : path.posix;
  const names = await deps.fs.readdir(folder).catch(() => [] as string[]);
  return names.filter(isPlaceName).map((name) => flavour.join(folder, name));
}

/** A found place file, or undefined when it isn't a plain place file. */
async function found(deps: PlaceDeps, file: string): Promise<FoundFile | undefined> {
  const real = await placeFile(deps.fs, deps.platform, file).catch(() => undefined);
  if (!real) return undefined;
  const info = await deps.fs.lstat(real);
  return info ? { file: real, modifiedMs: info.mtimeMs } : undefined;
}

/**
 * Place files from Studio's recent list and, on the person's own press, Documents › Roblox: one per
 * real path, newest first.
 */
async function scanPlaceFiles(deps: PlaceDeps, documents: boolean): Promise<FoundFile[]> {
  const fromDocuments = documents ? await documentPlaces(deps) : [];
  const candidates = [...(await studioRecents(deps.run, deps.platform)), ...fromDocuments];
  const byPath = new Map<string, FoundFile>();
  for (const file of candidates) {
    const place = await found(deps, file);
    if (place && !byPath.has(place.file)) byPath.set(place.file, place);
  }
  return [...byPath.values()].sort((a, b) => b.modifiedMs - a.modifiedMs).slice(0, MAX_PLACES);
}

/** The place files, scanned again only once the last scan is {@link SCAN_KEEP_MS} old. */
async function keptScan(deps: PlaceDeps, cache: ScanCache): Promise<FoundFile[]> {
  const now = deps.now();
  if (cache.files && cache.at !== undefined && now - cache.at < SCAN_KEEP_MS) return cache.files;
  cache.files = await scanPlaceFiles(deps, true);
  cache.at = now;
  return cache.files;
}

/**
 * What an open Studio says of its place: its ids, or undefined when it didn't answer. Asked under
 * the busy mark of the game bound to that Studio, so its helper never reports the ask as the person's.
 */
export async function askPlace(
  deps: PlaceDeps,
  storage: string,
  entry: StudioEntry,
): Promise<{ placeId: string; universeId: string } | undefined> {
  const studio = deps.studio;
  if (!studio) return undefined;
  const args = { [STUDIO_ID_ARG]: entry.id, [DATAMODEL_ARG]: EDIT_DATAMODEL, code: PLACE_READ_LUAU };
  const ask = () => studio.callTool(StudioTool.ExecuteLuau, args, { timeoutMs: PLACE_ASK_MS });
  const result = await asAgentInStudio(storage, entry.id, deps.now, ask).catch(() => undefined);
  if (!result || result.isError) return undefined;
  const text = result.content.map((part) => (part.type === "text" ? String(part.text ?? "") : "")).join("\n");
  const match = PLACE_ANSWER.exec(text);
  return match ? { placeId: match[1] as string, universeId: match[2] as string } : undefined;
}

/** The Studios open now, by StudioMCP; none when it isn't there. */
export async function listedStudios(deps: PlaceDeps): Promise<StudioEntry[]> {
  const studios = (await deps.studio?.studios({ timeoutMs: PLACE_ASK_MS }).catch(() => [])) ?? [];
  return studios.filter((entry) => entry.name.trim().length > 0);
}

/** An open Studio's place, asked of it. */
async function openPlaceOf(deps: PlaceDeps, storage: string, entry: StudioEntry, label: string): Promise<OpenPlace> {
  const ids = await askPlace(deps, storage, entry);
  const base: OpenPlace = { studio: entry.id, label, name: entry.name, kind: PlaceKind.Unsaved };
  if (ids && ids.placeId !== UNPUBLISHED) return { ...base, kind: PlaceKind.Published, ...ids };
  return isPlaceName(entry.name) ? { ...base, kind: PlaceKind.File } : base;
}

/** Each Studio's name, told apart from the ones before it with the same name. */
function labelsOf(studios: readonly StudioEntry[]): string[] {
  const seen = new Map<string, number>();
  return studios.map((entry) => {
    const count = (seen.get(entry.name) ?? 0) + 1;
    seen.set(entry.name, count);
    return count === 1 ? entry.name : `${entry.name} (${count})`;
  });
}

/** A game that builds in a place now: its id, its title and its link. */
interface LiveLink {
  game: string;
  title: string;
  link: PlaceLink;
  record: PlaceRecord;
}

/** A game's studio.json, when it is a plain JSON object. */
async function studioMeta(folder: string): Promise<Record<string, unknown> | undefined> {
  const text = await readFile(path.join(folder, "studio.json"), "utf8").catch(() => undefined);
  if (!text || text.length > MAX_META_BYTES) return undefined;
  try {
    const value = JSON.parse(text) as unknown;
    return isJsonObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The games that build in a Roblox place now: linked by the host, recorded by this backend, and
 * whose own folder still links that place. A game that was removed, or linked elsewhere since, is
 * not one.
 */
async function liveLinks(storage: string): Promise<LiveLink[]> {
  const live: LiveLink[] = [];
  for (const { game, link } of await readPlaceLinks(storage)) {
    const record = await readPlaceRecord(storage, game);
    if (record?.project !== link.project) continue;
    const meta = await studioMeta(record.folder);
    const engine = isJsonObject(meta?.engine) ? meta.engine : undefined;
    if (engine?.kind !== ROBLOX_ENGINE || engine.project !== link.project) continue;
    const title = typeof meta?.title === "string" && meta.title.trim() ? meta.title.trim() : game;
    live.push({ game, title, link, record });
  }
  return live;
}

/** What a place is known by when comparing it with the places other games build in. */
interface PlaceKey {
  project?: string;
  placeId?: string;
  name?: string;
  /** The open Studio it is in: a game's link that this Studio's name matches is the same place. */
  studio?: StudioEntry;
}

/** Whether a game's live link is the place `key` names. */
function sameKey(live: LiveLink, key: PlaceKey): boolean {
  if (key.placeId) return live.link.placeId === key.placeId;
  // Matched as the game's own connection finds its Studio: by file name, or by name for a place never saved.
  if (key.studio && !live.link.placeId && placeMatcher(live.link)(key.studio)) return true;
  if (key.name) return !live.link.placeId && live.record.name === key.name;
  return key.project !== undefined && live.link.project === key.project;
}

/** The game, other than `game`, that builds in the place `key` names. */
function holderOf(links: readonly LiveLink[], game: string | undefined, key: PlaceKey): LiveLink | undefined {
  return links.find((live) => live.game !== game && sameKey(live, key));
}

/** An open place's key: its ids when published, else the Studio it is in, by its file or its name. */
function openKey(place: OpenPlace, files: readonly FoundFile[], platform: NodeJS.Platform): PlaceKey {
  if (place.placeId) return { placeId: place.placeId };
  const studio = { id: place.studio, name: place.name };
  const file = place.kind === PlaceKind.File ? fileNamed(files, place.name, platform) : undefined;
  return file ? { project: file, studio } : { name: place.name, studio };
}

/** The one found file with this base name, or undefined when there is none or more than one. */
function fileNamed(files: readonly FoundFile[], name: string, platform: NodeJS.Platform): string | undefined {
  const named = files.filter((found) => baseOf(platform, found.file) === name);
  return named.length === 1 ? named[0]?.file : undefined;
}

/** The title of the live game other than `game` that builds in the published place `placeId`, if one does. */
export async function placeHeldBy(storage: string, game: string, placeId: string): Promise<string | undefined> {
  return holderOf(await liveLinks(storage), game, { placeId })?.title;
}

/** Who builds in a place: another game's title, or this game. */
function holding(links: readonly LiveLink[], game: string | undefined, key: PlaceKey) {
  const other = holderOf(links, game, key);
  if (other) return { linkedTo: other.title };
  const own = links.find((live) => live.game === game && sameKey(live, key));
  return own ? { here: true } : {};
}

/**
 * Choose your place: open Studios first, then place files. Documents is read on the person's press
 * only; an agent's call (no `cache`) lists Studio's recent files alone, never kept for a press.
 */
export async function listPlaces(deps: PlaceDeps, context: PluginContext, cache?: ScanCache): Promise<PlacesAnswer> {
  const storage = await context.host(PluginService.StorageRoot);
  const studios = await listedStudios(deps);
  const labels = labelsOf(studios);
  const open = await Promise.all(
    studios.map((entry, at) => openPlaceOf(deps, storage, entry, labels[at] ?? entry.name)),
  );
  const files = cache ? await keptScan(deps, cache) : await scanPlaceFiles(deps, false);
  const links = await liveLinks(storage);
  const game = context.project;
  const openNames = new Set(studios.map((entry) => entry.name));
  return {
    open: open.map((place) => ({ ...place, ...holding(links, game, openKey(place, files, deps.platform)) })),
    files: files.map((found) => {
      const name = baseOf(deps.platform, found.file);
      return { file: found.file, name, open: openNames.has(name), ...holding(links, game, { project: found.file }) };
    }),
  };
}

/** The place a game is about to be linked to. */
interface Chosen {
  /** Its file, or the game's project file for a place with none. */
  project: string;
  name: string;
  key: PlaceKey;
  remote?: { placeId: string; universeId: string };
  /** The place has no file of its own: link it through the game's project file. */
  throughProject?: boolean;
}

/** A game's project file for a place with no file of its own: Genex's, or the person's own Rojo project. */
function projectFileOf(folder: string): string {
  return path.join(folder, ROJO_PROJECT);
}

/** A place file named for this game, refused with the reason. */
async function chosenFile(deps: PlaceDeps, file: unknown): Promise<Chosen> {
  const real = await placeFile(deps.fs, deps.platform, file);
  return { project: real, name: stemOf(real), key: { project: real } };
}

/** How a place is found: the files to look a saved place up in, or none when only names may be used. */
interface FindOptions {
  /** The plugin's storage, where the games bound to each Studio are found. */
  storage: string;
  files?: readonly FoundFile[];
}

/** An open Studio's place for this game. */
async function chosenStudio(deps: PlaceDeps, folder: string, studioId: unknown, options: FindOptions): Promise<Chosen> {
  const studios = await listedStudios(deps);
  const entry = studios.find((listed) => listed.id === studioId);
  if (!entry) throw new PlaceError(PlaceRefusal.NotListed, MESSAGE.Places.NotListed());
  return chosenFromEntry(deps, folder, entry, studios, options);
}

async function chosenFromEntry(
  deps: PlaceDeps,
  folder: string,
  entry: StudioEntry,
  studios: readonly StudioEntry[],
  options: FindOptions,
): Promise<Chosen> {
  const ids = await askPlace(deps, options.storage, entry);
  const project = projectFileOf(folder);
  if (ids && ids.placeId !== UNPUBLISHED)
    return { project, name: entry.name, key: { placeId: ids.placeId }, remote: ids, throughProject: true };
  const twins = studios.filter((listed) => listed.name === entry.name).length > 1;
  if (twins) throw new PlaceError(PlaceRefusal.SameName, MESSAGE.Places.SameName(entry.name));
  if (isPlaceName(entry.name)) {
    const file = fileNamed(options.files ?? [], entry.name, deps.platform);
    if (file) return { project: file, name: stemOf(file), key: { project: file, studio: entry } };
  }
  if (!ids) throw new PlaceError(PlaceRefusal.NoAnswer, MESSAGE.Places.NoAnswer(entry.name));
  return { project, name: entry.name, key: { name: entry.name, studio: entry }, throughProject: true };
}

/** The game's project file for a place with no file, made when it is missing or Genex's own. */
async function readyProjectFile(
  deps: PlaceDeps,
  target: { storage: string; game: string; folder: string },
  chosen: Chosen,
  context: PluginContext,
): Promise<void> {
  const info = await lstat(chosen.project).catch(() => undefined);
  if (info?.isSymbolicLink()) throw new PlaceError(PlaceRefusal.Linked, MESSAGE.Places.ProjectInTheWay(ROJO_PROJECT));
  if (info && !info.isFile()) throw new PlaceError(PlaceRefusal.NotPlace, MESSAGE.Places.ProjectInTheWay(ROJO_PROJECT));
  // The person's own Rojo project stays as they wrote it; it is linked as it is.
  if (info && !(await writtenByGenex(target.folder, ROJO_PROJECT))) return;
  await context.host(PluginService.GameSnapshot, { reason: MESSAGE.Places.SnapshotReason });
  // Listed as Genex's before it exists, so a sync pass in between never takes it for the person's.
  const note = deps.noteWritten ?? ((_storage, _game, folder, name) => recordWritten(folder, name));
  await note(target.storage, target.game, target.folder, ROJO_PROJECT);
  const rojo = { name: chosen.name.replace(CONTROLS, " ").slice(0, 100), tree: { $className: "DataModel" } };
  await writeWhole(target.folder, ROJO_PROJECT, `${JSON.stringify(rojo, null, 2)}\n`);
}

/** The place a call names: a file, or an open Studio. */
export interface PlaceChoice {
  file?: unknown;
  studio?: unknown;
}

/** A refusal as an answer; anything else is thrown on. */
function refusedAnswer(error: unknown): UsePlaceAnswer {
  if (!(error instanceof PlaceError)) throw error;
  return { linked: false, reason: error.code, message: error.message };
}

/** The bound game's folder by its real path; a call from no game is refused. */
async function boundGame(context: PluginContext): Promise<{ game: string; folder: string }> {
  if (!context.project || !context.directory) throw new PlaceError(PlaceRefusal.NoGame, MESSAGE.Places.NoGame());
  return { game: context.project, folder: await realpath(context.directory) };
}

/** Links the bound game to the place chosen, once nothing refuses it. */
async function linkChosen(deps: PlaceDeps, context: PluginContext, chosen: Chosen): Promise<UsePlaceAnswer> {
  const { game, folder } = await boundGame(context);
  const storage = await context.host(PluginService.StorageRoot);
  const holder = holderOf(await liveLinks(storage), game, chosen.key);
  if (holder) throw new PlaceError(PlaceRefusal.Taken, MESSAGE.Places.Taken(chosen.name, holder.title));
  if (chosen.throughProject) await readyProjectFile(deps, { storage, game, folder }, chosen, context);
  const record: PlaceRecord = {
    folder,
    project: chosen.project,
    ...(chosen.key.name ? { name: chosen.key.name } : {}),
    ...(chosen.remote ?? {}),
  };
  // Recorded before the link: the helper link finds this game's Studio by it as soon as the link exists.
  const before = await readPlaceRecord(storage, game);
  await writePlaceRecord(storage, game, record);
  try {
    await context.host(PluginService.GameEngineLink, {
      project: chosen.project,
      ...(chosen.remote ? { remote: chosen.remote } : {}),
      // The chat names the place, not the project file it is linked through.
      ...(chosen.throughProject ? { name: chosen.name } : {}),
    });
  } catch (error) {
    // Refused: the record goes back to the link the game still has.
    await restorePlaceRecord(storage, game, before);
    throw new PlaceError(PlaceRefusal.Refused, error instanceof Error ? error.message : String(error));
  }
  const message = chosen.key.name ? MESSAGE.Places.LinkedByName(chosen.name) : MESSAGE.Places.Linked(chosen.name);
  return { linked: true, message, name: chosen.name };
}

/** Use in this game, from the panel: a place file, or an open Studio's place. */
export async function usePlace(
  deps: PlaceDeps,
  context: PluginContext,
  choice: PlaceChoice,
  cache: ScanCache,
): Promise<UsePlaceAnswer> {
  try {
    const { folder } = await boundGame(context);
    const chosen =
      choice.studio !== undefined
        ? await chosenStudio(deps, folder, choice.studio, {
            storage: await context.host(PluginService.StorageRoot),
            files: await keptScan(deps, cache),
          })
        : await chosenFile(deps, choice.file);
    return await linkChosen(deps, context, chosen);
  } catch (error) {
    return refusedAnswer(error);
  }
}

/** Whether `file` lies in a folder macOS guards with a prompt (Documents, Desktop, Downloads). */
function guarded(deps: PlaceDeps, file: string): boolean {
  if (deps.platform !== "darwin") return false;
  return GUARDED_FOLDERS.some((folder) => {
    const relative = path.posix.relative(path.posix.join(deps.home, folder), file);
    return relative !== "" && !relative.startsWith("..") && !path.posix.isAbsolute(relative);
  });
}

/**
 * The agent's `use-project`: a place file by its path, or a place open in Studio by its name as
 * Choose your place lists it. Neither reads Documents: a file there is the person's to choose.
 */
export async function usePlaceNamed(deps: PlaceDeps, context: PluginContext, place: unknown): Promise<UsePlaceAnswer> {
  try {
    const named = typeof place === "string" ? place.trim() : "";
    if (named && fullPath(deps.platform, named)) {
      if (guarded(deps, named)) throw new PlaceError(PlaceRefusal.Guarded, PLACE_PROMPTS.Guarded);
      return await linkChosen(deps, context, await chosenFile(deps, named));
    }
    const { folder } = await boundGame(context);
    const studios = await listedStudios(deps);
    const labels = labelsOf(studios);
    const entry = studios.find((listed, at) => labels[at] === named || listed.name === named);
    if (!entry) throw new PlaceError(PlaceRefusal.NotListed, MESSAGE.Places.NotOpenNamed(named));
    const storage = await context.host(PluginService.StorageRoot);
    return await linkChosen(deps, context, await chosenFromEntry(deps, folder, entry, studios, { storage }));
  } catch (error) {
    return refusedAnswer(error);
  }
}

/** Whether a Studio has the game's linked place open now, matched as the game's connection matches it. */
export async function placeOpenNow(deps: PlaceDeps, link: PlaceLink): Promise<boolean> {
  return (await listedStudios(deps)).some(placeMatcher(link));
}

/** The largest project file Genex reads a place's name from. */
const MAX_PROJECT_BYTES = 64 * 1024;
/** The longest place name the panel shows. */
const MAX_NAME_CHARS = 100;

/** The game's place as the panel names it, and whether the person's own Rojo project keeps its scripts. */
export interface LinkedPlaceView {
  name: string;
  rojo: boolean;
}

/** The name a project file gives its place, when it is a plain file with a one-line name. */
async function projectName(file: string): Promise<string | undefined> {
  const value = await readRegularFile(file, MAX_PROJECT_BYTES)
    .then((bytes) => JSON.parse(bytes.toString("utf8")) as unknown)
    .catch(() => undefined);
  if (!isJsonObject(value) || typeof value.name !== "string") return undefined;
  const name = value.name.trim();
  return name && name.length <= MAX_NAME_CHARS && !CONTROL.test(name) ? name : undefined;
}

/**
 * The place a linked game builds in, named as Studio names it: a place never saved by its name in
 * Studio, a place linked through the game's project file by the name that file gives it, a place
 * file by its file name. Reads only the plugin's storage and the game's own folder.
 */
export async function linkedPlace(
  storage: string,
  game: { project: string; directory?: string },
  link: PluginEngineLink,
): Promise<LinkedPlaceView> {
  const own = await readPlaceRecord(storage, game.project);
  const throughProject = path.basename(link.project) === ROJO_PROJECT;
  const named = own?.name ?? (throughProject ? await projectName(link.project) : undefined);
  const rojo = game.directory ? await personsRojo(game.directory) : false;
  return { name: named ?? (throughProject ? link.name : stemOf(link.project)), rojo };
}

/** Whether the game's folder holds a Rojo project the person wrote, not Genex. */
async function personsRojo(folder: string): Promise<boolean> {
  const info = await lstat(path.join(folder, ROJO_PROJECT)).catch(() => undefined);
  return Boolean(info?.isFile()) && !(await writtenByGenex(folder, ROJO_PROJECT).catch(() => false));
}
