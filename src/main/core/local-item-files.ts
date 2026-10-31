/**
 * A game's local item drafts (contract "Local item drafts"): store items the game's agent made before
 * the game was on Genex, which the CLI keeps in the game as `.genex/items/<localId>.json` and a
 * `<localId>/` folder of its picture, model and package. Studio never runs the CLI in the game
 * (`genex-cli.ts`), so a run that reads them gets a copy in its run folder, and a run that changed
 * them has what it changed carried back into the game afterwards. Either way only a draft goes: a
 * regular file named for a local id and, when it has one, a folder of regular files beside it; a link
 * (in the game or left by the CLI), a nested folder or a draft over its caps is never copied, and a
 * write into the game never follows a link on the way. A draft's fingerprint is Studio's own hash of
 * its bytes: what tells a draft the game changed since Studio last saw it.
 */
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { isLocalItemId } from "../../shared/item-draft.ts";
import { GENEX_CLI_PROMPT } from "./genex-cli-prompts.ts";

const MIB = 1024 * 1024;
/** Where the CLI keeps local drafts, in a game and in a run folder. */
export const LOCAL_ITEMS_DIR = [".genex", "items"] as const;
/** The largest draft file a draft has: a few fields and file names. */
const DRAFT_JSON_BYTES_MAX = 64 * 1024;
/** The most files a draft's folder holds: a picture, a model and a package, with room to spare. */
const DRAFT_FILES_MAX = 8;
/** The most bytes a draft's folder holds: the CLI's caps on a picture, a model and a packed package. */
const DRAFT_BYTES_MAX = 300 * MIB;
/** The most drafts Studio copies for one run. */
const DRAFTS_MAX = 200;
const DRAFT_SUFFIX = ".json";
/** Owner-only, like the rest of the run folder. */
const PRIVATE_DIR = 0o700;
const PRIVATE_FILE = 0o600;
/** Opening a file never follows a link put in its place (Windows has no such flag). */
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const STAGING_ID_BYTES = 4;

/** Each local draft's fingerprint, by local id. */
export type DraftPrints = Map<string, string>;

/** Why a run's local drafts did not go into the game, in words the agent reads. */
export class LocalDraftsNotCarried extends Error {
  constructor(why: string) {
    super(why);
    this.name = "LocalDraftsNotCarried";
  }
}

/** One regular file's bytes, never through a link put in its place, and never more than `max`; null otherwise. */
async function readPlainFile(file: string, max: number): Promise<Buffer | null> {
  const handle = await open(file, constants.O_RDONLY | NO_FOLLOW | constants.O_NONBLOCK).catch(() => null);
  if (!handle) return null;
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > max) return null;
    const bytes = await handle.readFile();
    return bytes.length > max ? null : bytes;
  } finally {
    await handle.close();
  }
}

/** `segments` under `root` when each is a real folder of its own (never a link or a file); null otherwise. */
async function existingFolder(root: string, segments: readonly string[]): Promise<string | null> {
  let dir = root;
  for (const segment of segments) {
    dir = path.join(dir, segment);
    const stats = await lstat(dir).catch(() => null);
    if (!stats?.isDirectory()) return null;
  }
  return dir;
}

/** One draft as read: its file's bytes and its folder's files' bytes by name, or null when it is no clean draft. */
interface DraftBytes {
  json: Buffer;
  files: Array<{ name: string; bytes: Buffer }>;
}

/** A draft's folder's files: regular files only, within the caps; null for a link, a nested folder or too much. */
async function folderFiles(dir: string): Promise<DraftBytes["files"] | null> {
  const stats = await lstat(dir).catch(() => null);
  if (!stats) return [];
  if (!stats.isDirectory()) return null;
  const entries = await readdir(dir, { withFileTypes: true });
  if (entries.length > DRAFT_FILES_MAX) return null;
  const files: DraftBytes["files"] = [];
  let total = 0;
  for (const entry of entries) {
    if (!entry.isFile()) return null;
    const bytes = await readPlainFile(path.join(dir, entry.name), DRAFT_BYTES_MAX - total);
    if (!bytes) return null;
    total += bytes.length;
    files.push({ name: entry.name, bytes });
  }
  return files.sort((a, b) => (a.name < b.name ? -1 : 1));
}

/** The draft `localId` in the items folder `items`, read whole, or null when it is not a clean draft. */
async function readDraft(items: string, localId: string): Promise<DraftBytes | null> {
  const json = await readPlainFile(path.join(items, `${localId}${DRAFT_SUFFIX}`), DRAFT_JSON_BYTES_MAX);
  if (!json) return null;
  const files = await folderFiles(path.join(items, localId));
  return files ? { json, files } : null;
}

/** Studio's fingerprint of a draft's bytes: its file, then each of its folder's files by name. */
function fingerprintOf(draft: DraftBytes): string {
  const hash = createHash("sha256").update("draft\0").update(draft.json);
  for (const file of draft.files) {
    hash.update(`\0file\0${file.name}\0`);
    hash.update(createHash("sha256").update(file.bytes).digest("hex"));
  }
  return hash.digest("hex");
}

/** The local ids an items folder names drafts for (by their `.json`), at most {@link DRAFTS_MAX}. */
async function draftIds(items: string): Promise<string[]> {
  const names = await readdir(items).catch(() => []);
  return names
    .filter((name) => name.endsWith(DRAFT_SUFFIX))
    .map((name) => name.slice(0, -DRAFT_SUFFIX.length))
    .filter(isLocalItemId)
    .sort()
    .slice(0, DRAFTS_MAX);
}

/** The game's items folder, when it is a real folder inside it. */
const gameItemsFolder = (game: string) => existingFolder(game, LOCAL_ITEMS_DIR);

/** The fingerprint of the draft `localId` in an items folder, or null when there is no clean draft. */
export async function localDraftFingerprint(items: string, localId: string): Promise<string | null> {
  const draft = await readDraft(items, localId);
  return draft ? fingerprintOf(draft) : null;
}

/** Whether the game (its real folder) holds at least one clean local draft. */
export async function hasLocalDrafts(game: string): Promise<boolean> {
  const items = await gameItemsFolder(game);
  if (!items) return false;
  for (const localId of await draftIds(items)) if (await readDraft(items, localId)) return true;
  return false;
}

/** Each clean draft in an items folder, by local id. */
async function cleanDrafts(items: string): Promise<Map<string, DraftBytes>> {
  const drafts = new Map<string, DraftBytes>();
  for (const localId of await draftIds(items)) {
    const draft = await readDraft(items, localId);
    if (draft) drafts.set(localId, draft);
  }
  return drafts;
}

/** Write a draft's bytes as `<localId>.json` and `<localId>/` under `into`, which is new and Studio's own. */
async function writeDraft(into: string, localId: string, draft: DraftBytes): Promise<void> {
  await writeNew(path.join(into, `${localId}${DRAFT_SUFFIX}`), draft.json);
  if (draft.files.length === 0) return;
  const folder = path.join(into, localId);
  await mkdir(folder, { mode: PRIVATE_DIR });
  for (const file of draft.files) await writeNew(path.join(folder, file.name), file.bytes);
}

/** A file made new (never over something already there, never through a link). */
async function writeNew(file: string, bytes: Buffer): Promise<void> {
  const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW, PRIVATE_FILE);
  try {
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
}

/**
 * Copy the game's clean local drafts into `<work>/.genex/items/` for a run, and answer each copied
 * draft's fingerprint. A game whose `.genex` or `.genex/items` is a link or a file gives nothing.
 */
export async function stageLocalDrafts(game: string, work: string): Promise<DraftPrints> {
  const prints: DraftPrints = new Map();
  const items = await gameItemsFolder(game);
  if (!items) return prints;
  const drafts = await cleanDrafts(items);
  if (drafts.size === 0) return prints;
  const into = path.join(work, ...LOCAL_ITEMS_DIR);
  await mkdir(into, { recursive: true, mode: PRIVATE_DIR });
  for (const [localId, draft] of drafts) {
    await writeDraft(into, localId, draft);
    prints.set(localId, fingerprintOf(draft));
  }
  return prints;
}

/** `segments` under `game` as real folders, made where absent; a link or a file on the way is refused. */
async function madeFolder(game: string, segments: readonly string[]): Promise<string> {
  let dir = game;
  for (const segment of segments) {
    dir = path.join(dir, segment);
    const stats = await lstat(dir).catch(() => null);
    if (!stats) await mkdir(dir);
    else if (!stats.isDirectory())
      throw new LocalDraftsNotCarried(
        GENEX_CLI_PROMPT.LocalDraftsLink(path.relative(game, dir).split(path.sep).join("/")),
      );
  }
  return dir;
}

/** Take the draft `localId` out of the game's items folder: its file and its folder, never through a link. */
async function removeDraft(items: string, localId: string): Promise<void> {
  // rm on a link removes the link itself, never what it leads to.
  await rm(path.join(items, `${localId}${DRAFT_SUFFIX}`), { force: true });
  await rm(path.join(items, localId), { recursive: true, force: true });
}

/** Put one draft in the game's items folder in place of what it held, through a staging folder beside it. */
async function replaceDraft(items: string, localId: string, draft: DraftBytes): Promise<void> {
  const staging = path.join(items, `.${localId}.incoming-${randomBytes(STAGING_ID_BYTES).toString("hex")}`);
  try {
    await mkdir(staging, { mode: PRIVATE_DIR });
    await writeDraft(staging, localId, draft);
    await removeDraft(items, localId);
    await rename(path.join(staging, `${localId}${DRAFT_SUFFIX}`), path.join(items, `${localId}${DRAFT_SUFFIX}`));
    if (draft.files.length > 0) await rename(path.join(staging, localId), path.join(items, localId));
  } finally {
    // Only this carry's own staging folder, which holds only what it wrote.
    await rm(staging, { recursive: true, force: true });
  }
}

/** What a run did to the game's drafts: each draft it wrote (with its fingerprint), and each it removed. */
export interface CarriedDrafts {
  written: DraftPrints;
  removed: string[];
}

/**
 * After a run that changes local drafts: every draft the CLI wrote or changed in `<work>/.genex/items/`
 * goes into the game, and every draft it took out of the copies (`staged`) leaves the game. A draft the
 * CLI left with a link, a nested folder or too much in it stops the carry before the game changes.
 */
export async function carryLocalDrafts(work: string, game: string, staged: DraftPrints): Promise<CarriedDrafts> {
  const runItems = await existingFolder(work, LOCAL_ITEMS_DIR);
  const ids = runItems ? await draftIds(runItems) : [];
  const after = new Map<string, DraftBytes>();
  for (const localId of ids) {
    const draft = runItems ? await readDraft(runItems, localId) : null;
    if (!draft) throw new LocalDraftsNotCarried(GENEX_CLI_PROMPT.LocalDraftUnclean(localId));
    after.set(localId, draft);
  }
  const written: DraftPrints = new Map();
  for (const [localId, draft] of after) {
    const print = fingerprintOf(draft);
    if (staged.get(localId) !== print) written.set(localId, print);
  }
  const removed = [...staged.keys()].filter((localId) => !after.has(localId));
  if (written.size === 0 && removed.length === 0) return { written, removed };
  const items = await madeFolder(game, LOCAL_ITEMS_DIR);
  for (const localId of written.keys()) {
    const draft = after.get(localId);
    if (draft) await replaceDraft(items, localId, draft);
  }
  for (const localId of removed) await removeDraft(items, localId);
  return { written, removed };
}

/**
 * After Studio's own `shop sync`: take each uploaded draft out of the game, but only while it is
 * still what the run was given (`staged`): a draft the game changed meanwhile stays.
 */
export async function removeSyncedDrafts(
  game: string,
  synced: readonly string[],
  staged: DraftPrints,
): Promise<string[]> {
  const items = await gameItemsFolder(game);
  if (!items) return [];
  const gone: string[] = [];
  for (const localId of synced) {
    const was = staged.get(localId);
    if (!was || (await localDraftFingerprint(items, localId)) !== was) continue;
    await removeDraft(items, localId);
    gone.push(localId);
  }
  return gone;
}
