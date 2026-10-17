/**
 * The place export in a game folder: what the Genex helper in Studio serializes, written as files
 * under `<game>/.genex/place/` so a save point holds the place beside the scripts, and read back
 * to load a save point's place into Studio.
 *
 * - `exportPlace` asks the helper for the parts that differ from the folder's `manifest.json` (or
 *   every part when the manifest is missing or `full`), checks each one's size and hash, writes it
 *   whole or not at all, removes parts the place no longer has, then writes the manifest.
 * - `loadPlace` sends every part the manifest names, each read back and checked first, and asks
 *   the helper to load them.
 * - When Studio isn't reachable for a load, `pending-load.json` waits in the folder, and
 *   `loadPendingPlace` loads it the next time the helper binds for the game, before agents can
 *   reach that Studio (the link's `beforeBind`).
 *
 * Every write stays inside `.genex/place/` by real path: a link anywhere on the way is refused and
 * nothing is written through it. Deadlines come from the caller and are never lengthened.
 */
import { lstat, readdir, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { SECOND_MS } from "../../shared/duration.ts";
import {
  createFileInDir,
  ensureDirBelow,
  NotARegularFileError,
  readRegularFile,
  replaceFile,
} from "../../substrate/fsx.ts";
import type { HelperAsk, Upload } from "./helper-link.ts";
import {
  type DataChunk,
  HelperMessage,
  helperHash,
  isPartPath,
  type KnownPart,
  MAX_PLACE_PARTS,
  type PlacePart,
} from "./helper-protocol.ts";
import { HELPER_VERSION } from "./setup.ts";

/** The place export's folder inside a game, as path segments. */
export const PLACE_FOLDER = [".genex", "place"] as const;
/** The export's own record: the helper's version and every part with its hash and size. */
export const PLACE_MANIFEST = "manifest.json";
/** Left by a load that couldn't reach Studio; the helper loads the export when it next binds. */
export const PENDING_LOAD = "pending-load.json";
/** Where a restore leaves its scripts' reconcile for the helper's next connection, when it couldn't run it. */
export const PENDING_SCRIPTS = "pending-scripts.json";
/**
 * The longest a place export may take, from the request to the last part written. Studio
 * serializes and sends a large place in a few seconds; past this the export answers a plain note
 * and the save point holds the scripts alone.
 */
export const PLACE_EXPORT_MAX_MS = 20 * SECOND_MS;
/** The longest a place load may take, from the first part sent to Studio's answer. */
export const PLACE_LOAD_MAX_MS = 30 * SECOND_MS;
/** The host's checkpoint file cap: a part larger than this is left out of save points (and never read back). */
export const SAVE_POINT_FILE_MAX_BYTES = 50 * 1024 * 1024;
const PART_READ_MAX_BYTES = SAVE_POINT_FILE_MAX_BYTES;
/** The largest manifest read back. */
const MANIFEST_MAX_BYTES = 1024 * 1024;
const TEMP_PREFIX = ".genex-part-";

const MESSAGE = {
  Missing: (part: string) => `The helper didn't send all of the place part ${part}.`,
  Mismatch: (part: string) => `The place part ${part} arrived damaged.`,
  Unknown: (part: string) => `The helper named the place part ${part} without sending it.`,
  NoManifest: "This game has no saved place to load.",
  Unreadable: (part: string) => `The saved place part ${part} can't be read.`,
} as const;

/** Why a place export or load was refused. Wire values: never rename. */
export const PlaceFailure = {
  /** A part arrived short, too long or with another hash. */
  Damaged: "damaged",
  /** The folder has no manifest to load. */
  NoManifest: "no-manifest",
  /** A saved part is missing, a link, or not what the manifest says. */
  Unreadable: "unreadable",
} as const;
export type PlaceFailure = (typeof PlaceFailure)[keyof typeof PlaceFailure];

/** A place export or load that couldn't be done, with its reason. */
export class PlaceFilesError extends Error {
  code: PlaceFailure;
  constructor(code: PlaceFailure, message: string) {
    super(message);
    this.name = "PlaceFilesError";
    this.code = code;
  }
}

/** The manifest the folder holds. */
export interface PlaceManifest {
  helper: number;
  parts: PlacePart[];
}

/** What an export did. */
export interface PlaceExported {
  parts: PlacePart[];
  /** The parts written now; the others were already in the folder. */
  written: string[];
  /** Files of parts the place no longer has, removed. */
  removed: string[];
  /** How long Studio took. */
  ms: number;
}

/** The export folder, made where missing, every step a real folder (never a link). */
const placeFolder = (game: string) => ensureDirBelow(game, PLACE_FOLDER);

/** The folder `parts` names below `root` when every step is a real folder already; nothing is made. */
export async function existingFolder(root: string, parts: readonly string[]): Promise<string | undefined> {
  let dir = await realpath(root);
  for (const part of parts) {
    dir = path.join(dir, part);
    const info = await lstat(dir).catch(() => undefined);
    if (!info?.isDirectory()) return undefined;
  }
  return dir;
}

/** The export folder when the game has one; reading never makes it. */
const foundPlaceFolder = (game: string) => existingFolder(game, PLACE_FOLDER);

const isPart = (value: unknown): value is PlacePart => {
  const part = value as PlacePart;
  return (
    typeof value === "object" &&
    value !== null &&
    isPartPath(part.name) &&
    typeof part.hash === "string" &&
    Number.isSafeInteger(part.bytes) &&
    part.bytes >= 0
  );
};

/** The folder's manifest, or undefined when it is missing or not one. */
export async function readManifest(game: string): Promise<PlaceManifest | undefined> {
  const folder = await foundPlaceFolder(game);
  if (!folder) return undefined;
  const bytes = await readRegularFile(path.join(folder, PLACE_MANIFEST), MANIFEST_MAX_BYTES).catch(() => undefined);
  if (!bytes) return undefined;
  try {
    const value = JSON.parse(bytes.toString("utf8")) as Partial<PlaceManifest>;
    const parts = Array.isArray(value.parts) && value.parts.length <= MAX_PLACE_PARTS ? value.parts : undefined;
    if (!parts?.every(isPart) || !Number.isSafeInteger(value.helper)) return undefined;
    return { helper: value.helper as number, parts };
  } catch {
    return undefined;
  }
}

/** Writes `data` as `name` in `folder` whole or not at all: a fresh file beside it, then a rename. */
export async function writeWhole(folder: string, name: string, data: Uint8Array | string): Promise<void> {
  const temp = `${TEMP_PREFIX}${process.pid}-${Math.random().toString(36).slice(2)}`;
  await createFileInDir(folder, temp, data);
  try {
    await replaceFile(path.join(folder, temp), path.join(folder, name));
  } catch (error) {
    await unlink(path.join(folder, temp)).catch(() => {});
    throw error;
  }
}

/** Writes a part at its path under the export folder, its folders made on the way, no link followed. */
async function writePart(folder: string, name: string, data: Uint8Array): Promise<void> {
  const segments = name.split("/");
  const dir = await ensureDirBelow(folder, segments.slice(0, -1));
  await writeWhole(dir, segments.at(-1) as string, data);
}

/** The bytes of one part from its chunks, checked against what the helper says it is. */
function joinChunks(part: PlacePart, chunks: DataChunk[] | undefined): Buffer {
  const count = chunks?.[0]?.count;
  const ordered = chunks ? [...chunks].sort((a, b) => a.index - b.index) : [];
  const whole =
    count !== undefined && ordered.length === count && ordered.every((chunk, index) => chunk.index === index);
  if (!whole || ordered.some((chunk) => chunk.count !== count))
    throw new PlaceFilesError(PlaceFailure.Damaged, MESSAGE.Missing(part.name));
  const bytes = Buffer.concat(ordered.map((chunk) => Buffer.from(chunk.data, "base64")));
  if (bytes.length !== part.bytes || helperHash(bytes) !== part.hash)
    throw new PlaceFilesError(PlaceFailure.Damaged, MESSAGE.Mismatch(part.name));
  return bytes;
}

/** Every part file under the export folder (not the manifest or the pending load), as part paths. */
async function partFiles(folder: string): Promise<string[]> {
  const entries = await readdir(folder, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(folder, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"))
    .filter((name) => name !== PLACE_MANIFEST && name !== PENDING_LOAD && name !== PENDING_SCRIPTS && isPartPath(name));
}

/** Removes the part files the place no longer has; a part reached through a link is left alone. */
async function removeStale(folder: string, keep: ReadonlySet<string>): Promise<string[]> {
  const removed: string[] = [];
  for (const name of await partFiles(folder)) {
    if (keep.has(name)) continue;
    const dir = await ensureDirBelow(folder, name.split("/").slice(0, -1)).catch(() => undefined);
    if (!dir) continue;
    const file = path.join(dir, path.basename(name));
    if (!(await lstat(file)).isFile()) continue;
    await unlink(file);
    removed.push(name);
  }
  return removed;
}

/**
 * Asks the game's helper for its place and writes what changed into `<game>/.genex/place/`. A
 * part the helper names but doesn't send must already be in the folder with that hash. Once
 * `signal` aborts, an answer still on its way writes nothing: the caller's snapshot may be taken.
 */
export async function exportPlace(
  ask: HelperAsk,
  game: string,
  options: { full?: boolean; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<PlaceExported> {
  const folder = await placeFolder(game);
  const manifest = await readManifest(game);
  const full = options.full === true || manifest === undefined || manifest.helper !== HELPER_VERSION;
  const known: KnownPart[] = full ? [] : manifest.parts.map(({ name, hash }) => ({ name, hash }));
  const chunks = new Map<string, DataChunk[]>();
  const answer = await ask(
    HelperMessage.PlaceExport,
    { full, known },
    {
      timeoutMs: options.timeoutMs ?? PLACE_EXPORT_MAX_MS,
      onChunk: (chunk) => chunks.set(chunk.part, [...(chunks.get(chunk.part) ?? []), chunk]),
    },
  );
  options.signal?.throwIfAborted();
  const sent = new Set(answer.sent);
  const held = new Map(known.map((part) => [part.name, part.hash]));
  const data = new Map<string, Buffer>();
  for (const part of answer.parts) {
    if (sent.has(part.name)) data.set(part.name, joinChunks(part, chunks.get(part.name)));
    else if (held.get(part.name) !== part.hash)
      throw new PlaceFilesError(PlaceFailure.Damaged, MESSAGE.Unknown(part.name));
  }
  for (const [name, bytes] of data) await writePart(folder, name, bytes);
  const removed = await removeStale(folder, new Set(answer.parts.map((part) => part.name)));
  const record: PlaceManifest = { helper: HELPER_VERSION, parts: answer.parts };
  await writeWhole(folder, PLACE_MANIFEST, `${JSON.stringify(record, null, 2)}\n`);
  return { parts: answer.parts, written: [...data.keys()], removed, ms: answer.ms };
}

/** A saved part's bytes, read without following a link and checked against the manifest. */
async function readPart(folder: string, part: PlacePart): Promise<Buffer> {
  const segments = part.name.split("/");
  try {
    const dir = await existingFolder(folder, segments.slice(0, -1));
    const bytes = dir && (await readRegularFile(path.join(dir, segments.at(-1) as string), PART_READ_MAX_BYTES));
    if (bytes && bytes.length === part.bytes && helperHash(bytes) === part.hash) return bytes;
  } catch (error) {
    if (!(error instanceof NotARegularFileError) && !(error as NodeJS.ErrnoException).code) throw error;
  }
  throw new PlaceFilesError(PlaceFailure.Unreadable, MESSAGE.Unreadable(part.name));
}

/** Sends the game's saved place to its helper and has Studio load it; answers how many parts loaded. */
export async function loadPlace(ask: HelperAsk, game: string, options: { timeoutMs?: number } = {}): Promise<number> {
  const folder = await foundPlaceFolder(game);
  const manifest = await readManifest(game);
  if (!folder || !manifest) throw new PlaceFilesError(PlaceFailure.NoManifest, MESSAGE.NoManifest);
  const upload: Upload[] = [];
  for (const part of manifest.parts) upload.push({ part: part.name, data: await readPart(folder, part) });
  const answer = await ask(
    HelperMessage.PlaceLoad,
    { parts: manifest.parts },
    { timeoutMs: options.timeoutMs ?? PLACE_LOAD_MAX_MS, upload },
  );
  return answer.loaded;
}

/** Leaves a load for the next time the game's helper binds: Studio wasn't reachable now. */
export async function writePendingLoad(game: string, now: number): Promise<void> {
  const folder = await placeFolder(game);
  await writeWhole(folder, PENDING_LOAD, `${JSON.stringify({ since: new Date(now).toISOString() })}\n`);
}

/**
 * Leaves the restored scripts' reconcile for the next time the game's helper binds: a restore put
 * `src/` back while Studio wasn't reachable, so its next reconcile must let the restored files win.
 */
export async function writePendingScripts(game: string, now: number): Promise<void> {
  const folder = await placeFolder(game);
  await writeWhole(folder, PENDING_SCRIPTS, `${JSON.stringify({ since: new Date(now).toISOString() })}\n`);
}

/** Whether restored scripts wait for their reconcile in the game's folder. */
export async function hasPendingScripts(game: string): Promise<boolean> {
  const folder = await foundPlaceFolder(game);
  if (!folder) return false;
  const info = await lstat(path.join(folder, PENDING_SCRIPTS)).catch(() => undefined);
  return info?.isFile() === true;
}

/** Clears the restored scripts' wait: their reconcile ran. */
export async function clearPendingScripts(game: string): Promise<void> {
  const folder = await foundPlaceFolder(game);
  if (folder) await unlink(path.join(folder, PENDING_SCRIPTS)).catch(() => undefined);
}

/** Whether a load waits in the game's folder. */
export async function hasPendingLoad(game: string): Promise<boolean> {
  const folder = await foundPlaceFolder(game);
  if (!folder) return false;
  const info = await lstat(path.join(folder, PENDING_LOAD)).catch(() => undefined);
  return info?.isFile() === true;
}

/** Clears a load left waiting: the place was loaded since. */
export async function clearPendingLoad(game: string): Promise<void> {
  const folder = await foundPlaceFolder(game);
  if (folder) await unlink(path.join(folder, PENDING_LOAD)).catch(() => undefined);
}

/**
 * Loads the export a pending load waits for, then clears the wait; does nothing when none waits.
 * A failed load keeps the wait, for the helper's next binding.
 */
export async function loadPendingPlace(ask: HelperAsk, game: string): Promise<boolean> {
  if (!(await hasPendingLoad(game))) return false;
  await loadPlace(ask, game);
  const folder = await foundPlaceFolder(game);
  if (folder) await unlink(path.join(folder, PENDING_LOAD));
  return true;
}
