/**
 * Which open Roblox Studio is a game's own.
 *
 * The host runs one Roblox Studio connection per game, in `<plugin storage>/mcp/<game>` (the
 * manifest's `cwd: storage:project`; `_shared` when a call has no game). Once the Genex helper in
 * Studio has proved which Studio it is in, the backend writes the binding file `studio.json`
 * (`{studioId, session, at}`) there and refreshes `at` every {@link BINDING_REFRESH_MS}. The
 * connection reads it on every call: a file older than {@link BINDING_MAX_AGE_MS} (or dated ahead
 * of now by as much), or one that isn't a plain file with exactly those fields, is no binding, and
 * Studio counts as not open for the game.
 *
 * With no binding file at all, the connection matches the game's linked place against the names
 * `list_roblox_studios` gives (each holds its place's file name or id), and two matching Studios
 * are refused. The link is the host's record in the plugin's storage (`links/<game>.json`), which
 * agents can't write. A place never saved to a file is linked through a project file and found by
 * its name in Studio, which the backend keeps beside the link in its own record
 * (`places/<game>.json`), never in the game folder agents write.
 */
import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { SECOND_MS } from "../../shared/duration.ts";
import { ENGINE_LINKS_FOLDER } from "../../shared/plugins.ts";
import { atomicWriteJson, isJsonObject, readRegularFile } from "../../substrate/fsx.ts";
import type { StudioEntry } from "./studio-client.ts";

/** The binding file's name in a game's connection folder. */
export const BINDING_FILE = "studio.json";
/** How often the backend rewrites `at` while the helper stays connected. */
export const BINDING_REFRESH_MS = 10 * SECOND_MS;
/** How long a binding is believed after its last refresh: a few refreshes missed means it's gone. */
export const BINDING_MAX_AGE_MS = 45 * SECOND_MS;
/** This plugin's engine id, as the host writes it in a game's link. */
export const ROBLOX_ENGINE = "roblox";
/** The folder name of the connection that serves no game. */
const SHARED_BRIDGE = "_shared";
/** A game id as Genex names a game's folder: a plain folder name, never a path. */
const GAME_ID = /^[a-zA-Z0-9_-]{1,100}$/;
/** Whether `value` is a game id as Genex names a game's folder: a plain folder name, never a path. */
export const isGameId = (value: unknown): value is string => typeof value === "string" && GAME_ID.test(value);
/** An id Studio or the helper gives: printable, no spaces, bounded. */
const TOKEN = /^[\x21-\x7e]{1,200}$/;
/** A published place's id, as the host stores it: decimal digits. */
const PLACE_ID = /^[1-9]\d{0,19}$/;
/** A place's name as Studio lists it: one line of printable text, bounded. */
const TOKEN_NAME = /^[^\u0000-\u001f\u007f]{1,200}$/;
const MAX_BINDING_BYTES = 4 * 1024;
const MAX_LINK_BYTES = 64 * 1024;
/** A link record's file name ending. */
const LINK_SUFFIX = ".json";

/** A game's bound Studio, as the backend writes it. */
export interface StudioBinding {
  studioId: string;
  session: string;
  at: number;
}

/** What the binding file says. Wire values: never rename. */
export const BindingState = {
  /** No file: nothing has bound this game yet. */
  None: "none",
  /** A file that is too old, from the future, or not a binding: Studio isn't open for the game. */
  Stale: "stale",
  Bound: "bound",
} as const;
export type BindingState = (typeof BindingState)[keyof typeof BindingState];

export type BindingRead =
  | { state: typeof BindingState.None }
  | { state: typeof BindingState.Stale }
  | { state: typeof BindingState.Bound; binding: StudioBinding };

/** The plugin's storage and the game a connection folder serves (none for the shared one). */
export function bridgeHome(cwd: string): { storage: string; game?: string } {
  const folder = path.basename(cwd);
  const storage = path.dirname(path.dirname(cwd));
  return folder === SHARED_BRIDGE || !GAME_ID.test(folder) ? { storage } : { storage, game: folder };
}

const isMissing = (error: unknown) => (error as { code?: unknown })?.code === "ENOENT";

/** A binding from parsed JSON, or undefined when it isn't exactly one. */
function bindingOf(value: unknown): StudioBinding | undefined {
  if (!isJsonObject(value)) return undefined;
  const { studioId, session, at } = value;
  const wellFormed =
    typeof studioId === "string" &&
    TOKEN.test(studioId) &&
    typeof session === "string" &&
    TOKEN.test(session) &&
    Number.isSafeInteger(at);
  return wellFormed ? { studioId, session, at: at as number } : undefined;
}

/** The game's binding as the connection in `folder` reads it at `now`. */
export async function readBinding(folder: string, now: number): Promise<BindingRead> {
  let bytes: Buffer;
  try {
    bytes = await readRegularFile(path.join(folder, BINDING_FILE), MAX_BINDING_BYTES);
  } catch (error) {
    return isMissing(error) ? { state: BindingState.None } : { state: BindingState.Stale };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    return { state: BindingState.Stale };
  }
  const binding = bindingOf(parsed);
  if (!binding || Math.abs(now - binding.at) > BINDING_MAX_AGE_MS) return { state: BindingState.Stale };
  return { state: BindingState.Bound, binding };
}

/**
 * The game's last binding whatever its age, or undefined when there is none or it isn't one: the
 * Studio the game's helper was last connected from, which a publish may have reopened.
 */
export async function readLastBinding(folder: string): Promise<StudioBinding | undefined> {
  const bytes = await readRegularFile(path.join(folder, BINDING_FILE), MAX_BINDING_BYTES).catch(() => undefined);
  if (!bytes) return undefined;
  try {
    return bindingOf(JSON.parse(bytes.toString("utf8")));
  } catch {
    return undefined;
  }
}

/** Writes (or refreshes) the game's binding in its connection folder, atomically. */
export async function writeBinding(folder: string, bound: Omit<StudioBinding, "at">, now: number): Promise<void> {
  if (!TOKEN.test(bound.studioId) || !TOKEN.test(bound.session)) throw new Error("Invalid Studio binding");
  await mkdir(folder, { recursive: true, mode: 0o700 });
  await atomicWriteJson(path.join(folder, BINDING_FILE), { studioId: bound.studioId, session: bound.session, at: now });
}

/** The place a game is linked to: its project file, the published place's id, or its name in Studio. */
export interface PlaceLink {
  project: string;
  placeId?: string;
  /** A place never saved to a file: the name Studio lists it by. */
  name?: string;
}

/** The backend's own record of the place a game builds in, kept in the plugin's storage. */
export const PLACE_RECORDS = "places";

/** What the backend recorded when it linked a game: the game's folder, the project and how Studio names it. */
export interface PlaceRecord {
  folder: string;
  project: string;
  name?: string;
  placeId?: string;
  universeId?: string;
}

const placeRecordFile = (storage: string, game: string) => path.join(storage, PLACE_RECORDS, `${game}.json`);

/** The backend's record for `game`, or undefined when it has none or it isn't one. */
export async function readPlaceRecord(storage: string, game: string): Promise<PlaceRecord | undefined> {
  if (!GAME_ID.test(game)) return undefined;
  const value = await readRegularFile(placeRecordFile(storage, game), MAX_LINK_BYTES)
    .then((bytes) => JSON.parse(bytes.toString("utf8")) as unknown)
    .catch(() => undefined);
  if (!isJsonObject(value)) return undefined;
  const { folder, project, name, placeId, universeId } = value;
  if (typeof folder !== "string" || !path.isAbsolute(folder)) return undefined;
  if (typeof project !== "string" || !path.isAbsolute(project)) return undefined;
  return {
    folder,
    project,
    ...(typeof name === "string" && TOKEN_NAME.test(name) ? { name } : {}),
    ...(typeof placeId === "string" && PLACE_ID.test(placeId) ? { placeId } : {}),
    ...(typeof universeId === "string" && PLACE_ID.test(universeId) ? { universeId } : {}),
  };
}

/** Records the place `game` builds in, in the plugin's storage. */
export async function writePlaceRecord(storage: string, game: string, record: PlaceRecord): Promise<void> {
  if (!GAME_ID.test(game)) throw new Error("Invalid game");
  await mkdir(path.join(storage, PLACE_RECORDS), { recursive: true, mode: 0o700 });
  await atomicWriteJson(placeRecordFile(storage, game), record);
}

/** Puts back the record `game` had before (`undefined`: none), when a link it was written for is refused. */
export async function restorePlaceRecord(
  storage: string,
  game: string,
  before: PlaceRecord | undefined,
): Promise<void> {
  if (before) await writePlaceRecord(storage, game, before);
  else if (GAME_ID.test(game)) await rm(placeRecordFile(storage, game), { force: true });
}

/**
 * The place the host linked `game` to, or undefined when it has none or the record isn't one. The
 * host writes the link's own fields at the record's top (`kind`, `project`, `linkedAt`, `remote?`),
 * the link it replaced under `previous`, and only `unlinkedAt` once Undo left the game unlinked.
 */
export async function readPlaceLink(storage: string, game: string | undefined): Promise<PlaceLink | undefined> {
  if (!game || !GAME_ID.test(game)) return undefined;
  const file = path.join(storage, ENGINE_LINKS_FOLDER, `${game}.json`);
  const record = await readRegularFile(file, MAX_LINK_BYTES)
    .then((bytes) => JSON.parse(bytes.toString("utf8")) as unknown)
    .catch(() => undefined);
  if (!isJsonObject(record) || record.kind !== ROBLOX_ENGINE) return undefined;
  if (typeof record.project !== "string" || !path.isAbsolute(record.project)) return undefined;
  const placeId = isJsonObject(record.remote) ? record.remote.placeId : undefined;
  if (typeof placeId === "string" && PLACE_ID.test(placeId)) return { project: record.project, placeId };
  // A place never saved is found by its name, recorded for exactly this project. A record with
  // published ids the link doesn't have (an automatic link undone, or refused) names the published
  // place, not this link's: the link is found by its project again.
  const own = await readPlaceRecord(storage, game);
  const byName = own?.name !== undefined && own.project === record.project && own.placeId === undefined;
  return byName ? { project: record.project, name: own.name as string } : { project: record.project };
}

/** A game the host linked to a Roblox place, and that place. */
export interface LinkedPlace {
  game: string;
  link: PlaceLink;
}

/** Every game the host linked to a Roblox place, read from the plugin's storage. */
export async function readPlaceLinks(storage: string): Promise<LinkedPlace[]> {
  const names = await readdir(path.join(storage, ENGINE_LINKS_FOLDER)).catch(() => [] as string[]);
  const games = names.filter((name) => name.endsWith(LINK_SUFFIX)).map((name) => name.slice(0, -LINK_SUFFIX.length));
  const read = await Promise.all(games.map(async (game) => ({ game, link: await readPlaceLink(storage, game) })));
  return read.flatMap(({ game, link }) => (link ? [{ game, link }] : []));
}

/** A whole number standing alone in `text`. */
const holdsNumber = (text: string, digits: string) => new RegExp(`(^|\\D)${digits}(\\D|$)`).test(text);

/** The base name of a project path written on either system. */
const baseName = (project: string) => project.split(/[\\/]/).pop() ?? project;

/**
 * Whether a listed Studio has the linked place open: a published place by its id in the name, a
 * local place by its whole file name or its stem (Studio may leave the extension off), without
 * letter case, as both systems' file names are. Never a part of the name: "race.rbxlx" is not
 * open in a Studio listing "sky-race.rbxlx".
 */
export function placeMatcher(link: PlaceLink): (studio: StudioEntry) => boolean {
  if (link.placeId) {
    const placeId = link.placeId;
    return (studio) => holdsNumber(studio.name, placeId);
  }
  if (link.name) {
    const name = link.name;
    return (studio) => studio.name === name;
  }
  const file = baseName(link.project).toLowerCase();
  const stem = file.replace(/\.[^.]+$/, "");
  return (studio) => {
    const name = studio.name.toLowerCase();
    return name === file || name === stem;
  };
}
