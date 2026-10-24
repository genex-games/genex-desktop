/**
 * After a publish, the game is linked to the place Roblox now has, by Genex itself.
 *
 * A first publish turns the place Studio has open into a new game on Roblox, and Studio may reopen
 * it under the game's name ("<name> (placeId: N)"), which the game's link (its place file, or its
 * name in Studio) no longer matches. So when the chat starts a first publish Genex handed it, or
 * Genex shows the person Studio's own clicks for it where it can't click, it notes it
 * (`publish/<game>.json` in the plugin's storage: the name, the linked project, the Studio holding
 * the game then, and the places already published in the open Studios then). A publish the chat
 * didn't start is not noted, nor one with no Studio holding the game (the game's bound Studio, else
 * one with its own place open): there is nothing to publish from. Studio's clicks are noted once per
 * Studio holding the game, never again as the panel keeps looking. Until that note is
 * {@link PUBLISH_NOTE_MS} old, each look (the panel's status, Genex's moments, a publish call) asks
 * the Studios that could be the game's whether Roblox has their place now: the Studio the note names
 * or the game is bound to, and, once no open Studio still holds the game's own unpublished place, one
 * whose place carries the published name (only for a note naming a Studio). With no note, it asks
 * the Studio the game's helper was last connected from: within {@link LOST_STUDIO_MS} once that
 * connection is lost, if its place carries the game's own name or title, and while it still holds
 * only when a publish call asks (`askBound`). Exactly one published place, published after the note
 * and held by no other game, is linked with its ids, keeping the link's project; the chat shows the
 * link with Undo. Two candidates, or none, link nothing; a link the host refuses puts the place
 * record back.
 */
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { PluginContext } from "../../plugin-sdk/index.d.ts";
import { MINUTE_MS } from "../../shared/duration.ts";
import { PluginService } from "../../shared/plugins.ts";
import { atomicWriteJson, isJsonObject, readRegularFile } from "../../substrate/fsx.ts";
import { agentFolder } from "./agent-marks.ts";
import { titleOf } from "./place-actions.ts";
import { askPlace, listedStudios, type PlaceDeps, placeHeldBy } from "./places.ts";
import {
  BINDING_MAX_AGE_MS,
  isGameId,
  type PlaceLink,
  placeMatcher,
  readLastBinding,
  readPlaceLink,
  readPlaceRecord,
  restorePlaceRecord,
  writePlaceRecord,
} from "./studio-binding.ts";
import type { StudioEntry } from "./studio-client.ts";

/** How long a publish's note is followed: a publish the chat or the person finishes later is a new one. */
export const PUBLISH_NOTE_MS = 30 * MINUTE_MS;
/** How long after the game's helper last spoke its Studio is still taken for the game's, with no note. */
export const LOST_STUDIO_MS = 10 * MINUTE_MS;
/** The folder of the notes in the plugin's storage. */
const NOTES_FOLDER = "publish";
const MAX_NOTE_BYTES = 4 * 1024;
/** What Studio adds after a published place's name: " (placeId: 129143288655360)". */
const PLACE_ID_SUFFIX = /\s*\(placeId:\s*\d+\)\s*$/i;
/** A place's published ids, never 0. */
const UNPUBLISHED = "0";
/** The longest name the chat's link line shows. */
const MAX_LINK_NAME_CHARS = 80;
/** The most published places a note keeps from the open Studios. */
const MAX_NOTED_PLACES = 32;
const PLACE_ID = /^\d{1,20}$/;

/**
 * A first publish Genex handed over or left to the person: when, under which name, from which
 * Studio, and the places that were published already then (never the game's).
 */
export interface PublishNote {
  at: number;
  project: string;
  name?: string;
  studioId?: string;
  before?: string[];
}

/** What relinking needs: the computer's Studios, and the Studio the game's helper is bound to now. */
export interface RelinkDeps extends PlaceDeps {
  bound?(game: string): string | undefined;
}

/** How far a look reaches: a publish call also asks the Studio the game is still connected to. */
export interface RelinkOptions {
  askBound?: boolean;
}

/** A relink that happened: the published place's name and ids. */
export interface Relinked {
  name: string;
  placeId: string;
  universeId: string;
}

const noteFile = (storage: string, game: string) => path.join(storage, NOTES_FOLDER, `${game}.json`);

/** The places published now in the open Studios, as they say. */
async function publishedNow(deps: PlaceDeps, storage: string): Promise<string[]> {
  const ids: string[] = [];
  for (const entry of await listedStudios(deps)) {
    const asked = await askPlace(deps, storage, entry);
    if (asked && asked.placeId !== UNPUBLISHED && !ids.includes(asked.placeId)) ids.push(asked.placeId);
  }
  return ids.slice(0, MAX_NOTED_PLACES);
}

/**
 * The Studio that holds `game` now: the one its helper is bound to, else an open Studio showing its
 * own place (as its link names it); undefined when no Studio has it open.
 */
export async function studioHolding(
  deps: PlaceDeps,
  storage: string,
  game: string,
  bound: string | undefined,
): Promise<string | undefined> {
  if (bound) return bound;
  const link = await readPlaceLink(storage, game);
  if (!link) return undefined;
  return (await listedStudios(deps)).find(placeMatcher(link))?.id;
}

/**
 * Notes a first publish for `game` from the Studio holding it, with the places the open Studios
 * have published already, so the next looks link it to the place published after it and never to
 * one of those.
 */
export async function notePublish(
  deps: PlaceDeps,
  storage: string,
  game: string,
  note: Omit<PublishNote, "before" | "studioId"> & { studioId: string },
): Promise<void> {
  if (!isGameId(game)) return;
  const before = await publishedNow(deps, storage);
  await mkdir(path.join(storage, NOTES_FOLDER), { recursive: true, mode: 0o700 });
  await atomicWriteJson(noteFile(storage, game), { ...note, before });
}

/** The game's note of any age; undefined when there is none or it isn't one. */
async function readAnyNote(storage: string, game: string): Promise<PublishNote | undefined> {
  if (!isGameId(game)) return undefined;
  const value = await readRegularFile(noteFile(storage, game), MAX_NOTE_BYTES)
    .then((bytes) => JSON.parse(bytes.toString("utf8")) as unknown)
    .catch(() => undefined);
  if (!isJsonObject(value) || typeof value.project !== "string" || !Number.isSafeInteger(value.at)) return undefined;
  const at = value.at as number;
  const before = Array.isArray(value.before) ? value.before.filter(isPlaceId).slice(0, MAX_NOTED_PLACES) : [];
  return {
    at,
    project: value.project,
    ...(typeof value.name === "string" ? { name: value.name } : {}),
    ...(typeof value.studioId === "string" ? { studioId: value.studioId } : {}),
    before,
  };
}

const isPlaceId = (value: unknown): value is string => typeof value === "string" && PLACE_ID.test(value);

const clearNote = (storage: string, game: string) => rm(noteFile(storage, game), { force: true });

/** The game's note while it is fresh at `now`; undefined when there is none, it is old, or it isn't one. */
export async function readPublishNote(storage: string, game: string, now: number): Promise<PublishNote | undefined> {
  const note = await readAnyNote(storage, game);
  if (!note || now - note.at > PUBLISH_NOTE_MS || note.at - now > PUBLISH_NOTE_MS) return undefined;
  return note;
}

/**
 * Whether `game` was noted for `project` from `studioId` already, fresh or old: Studio's clicks shown
 * again in the same Studio are not a new publish, and a later note would forget the places
 * published meanwhile.
 */
export async function notedFrom(storage: string, game: string, project: string, studioId: string): Promise<boolean> {
  const note = await readAnyNote(storage, game);
  return note?.project === project && note.studioId === studioId;
}

/** A Studio's place name as Studio shows it before its published id. */
const bareName = (studio: StudioEntry) => studio.name.replace(PLACE_ID_SUFFIX, "");

/** What the game is known by: its own unpublished place (as its connection finds it) and its title. */
interface OwnPlace {
  matches(studio: StudioEntry): boolean;
  title?: string;
}

/** The game's own place, read from its link record and its folder; undefined with no link. */
async function ownPlaceOf(storage: string, game: string, directory: string | undefined): Promise<OwnPlace | undefined> {
  const link: PlaceLink | undefined = await readPlaceLink(storage, game);
  if (!link) return undefined;
  const title = directory ? await titleOf(directory, game) : undefined;
  return { matches: placeMatcher(link), ...(title ? { title } : {}) };
}

/** Whether a Studio's place carries the game's own name or title, before or after its published id. */
function carriesOwnName(studio: StudioEntry, own: OwnPlace | undefined): boolean {
  if (!own) return false;
  const bare = { ...studio, name: bareName(studio) };
  return own.matches(bare) || (own.title !== undefined && bare.name === own.title);
}

/**
 * The Studio the game's helper was last connected from, when a look with no note may ask it: a lost
 * connection within {@link LOST_STUDIO_MS}, or one that still holds when the look asks for it.
 */
async function lastStudio(deps: RelinkDeps, storage: string, game: string, options: RelinkOptions) {
  const folder = agentFolder(storage, game);
  const last = folder ? await readLastBinding(folder) : undefined;
  if (!last) return undefined;
  const age = deps.now() - last.at;
  if (age <= BINDING_MAX_AGE_MS) return options.askBound ? { id: last.studioId, lost: false } : undefined;
  return age <= LOST_STUDIO_MS ? { id: last.studioId, lost: true } : undefined;
}

/** Where a look reaches: the game, its linked project and its own place, read only when a look needs it. */
interface Look {
  storage: string;
  game: string;
  project: string;
  own(): Promise<OwnPlace | undefined>;
}

/**
 * The Studios that may hold the game's published place after a noted publish: the Studios the note
 * and the binding name, and, once no open Studio still holds the game's own place, one whose place
 * carries the published name (Studio reopened it elsewhere).
 */
async function notedStudios(deps: RelinkDeps, look: Look, note: PublishNote, listed: readonly StudioEntry[]) {
  const ids = new Set<string>();
  if (note.studioId) ids.add(note.studioId);
  const bound = deps.bound?.(look.game);
  if (bound) ids.add(bound);
  const own = await look.own();
  const ownStillOpen = listed.some((entry) => ids.has(entry.id) || own?.matches(entry));
  const name = note.name;
  // Only a note that saw the game's own Studio follows a reopening by name: anything else may be the person's own place.
  const followsName = note.studioId !== undefined && !ownStillOpen && name !== undefined;
  const reopened = (entry: StudioEntry) => followsName && bareName(entry) === name;
  return listed.filter((entry) => ids.has(entry.id) || reopened(entry));
}

/** The Studios that may hold the game's published place, the places to pass over, and the name it was published under. */
async function candidatesOf(deps: RelinkDeps, look: Look, options: RelinkOptions) {
  const note = await readPublishNote(look.storage, look.game, deps.now());
  const followed = note?.project === look.project ? note : undefined;
  if (followed) {
    const studios = await notedStudios(deps, look, followed, await listedStudios(deps));
    return { studios, before: followed.before ?? [], name: followed.name };
  }
  const last = await lastStudio(deps, look.storage, look.game, options);
  if (!last) return { studios: [], before: [], name: undefined };
  // A lost Studio may have another place open by now: followed only under the game's own name.
  const own = last.lost ? await look.own() : undefined;
  const studios = (await listedStudios(deps)).filter(
    (entry) => entry.id === last.id && (!last.lost || carriesOwnName(entry, own)),
  );
  return { studios, before: [], name: undefined };
}

/** The one published place among `studios` that was not published before, with its Studio; undefined for none or several. */
async function onePublished(
  deps: RelinkDeps,
  storage: string,
  studios: readonly StudioEntry[],
  before: readonly string[],
) {
  const found = new Map<string, { entry: StudioEntry; ids: { placeId: string; universeId: string } }>();
  for (const entry of studios) {
    const ids = await askPlace(deps, storage, entry);
    if (ids && ids.placeId !== UNPUBLISHED && !before.includes(ids.placeId)) found.set(ids.placeId, { entry, ids });
  }
  return found.size === 1 ? [...found.values()][0] : undefined;
}

/**
 * Links the game a call is bound to with the place Roblox has now, after a publish (module comment).
 * Answers what was linked, or undefined when nothing was: no game, a link that has its ids already,
 * no publish to follow, or no single published place that is free.
 */
export async function relinkPublished(
  deps: RelinkDeps,
  context: PluginContext,
  options: RelinkOptions = {},
): Promise<Relinked | undefined> {
  const game = context.project;
  if (!game || !isGameId(game)) return undefined;
  const link = await context.host(PluginService.GameEngineRead).catch(() => null);
  if (!link || link.remote) return undefined;
  const storage = await context.host(PluginService.StorageRoot);
  const own = () => ownPlaceOf(storage, game, context.directory);
  const look = { storage, game, project: link.project, own };
  const { studios, before, name } = await candidatesOf(deps, look, options);
  const found = await onePublished(deps, storage, studios, before);
  if (!found || (await placeHeldBy(storage, game, found.ids.placeId))) return undefined;
  const published = (name ?? (bareName(found.entry) || link.name)).slice(0, MAX_LINK_NAME_CHARS);
  const record = await readPlaceRecord(storage, game);
  const folder = record?.folder ?? context.directory;
  // Recorded before the link: the helper link finds this game's Studio by its ids as soon as the link has them.
  if (folder) await writePlaceRecord(storage, game, { folder, project: link.project, name: published, ...found.ids });
  try {
    await context.host(PluginService.GameEngineLink, { project: link.project, remote: found.ids, name: published });
  } catch (error) {
    // Refused: the record goes back to the link the game still has.
    if (folder) await restorePlaceRecord(storage, game, record);
    throw error;
  }
  await clearNote(storage, game);
  return { name: published, ...found.ids };
}
