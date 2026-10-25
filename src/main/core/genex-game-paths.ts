/**
 * The bound game's files a Studio-run Genex CLI command reads, and the shared item `items add`
 * writes into it (marketplace plan 8.1). The CLI never runs in the game (`genex-cli.ts`), so a store
 * item's picture, model and package are checked here by real path inside the game and copied into
 * the run folder before the run, and `items add`'s `genex-items/<id>/` is moved from the run folder
 * into the game after it, never through a link the game holds. A refused path stops the call before
 * anything is copied; a refused delivery leaves the game as it was.
 */
import { randomBytes } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { containedReal, isBelow } from "../../substrate/paths.ts";
import { type GamePathArg, GamePathTarget, GenexCliRefusal, GenexCliRefusalCode } from "./genex-cli-policy.ts";
import { GENEX_CLI_PROMPT } from "./genex-cli-prompts.ts";

const MIB = 1024 * 1024;
/** The most files of a package folder Studio copies: Genex refuses an item package with more (D47). */
export const PACKAGE_FILES_MAX = 2000;
/** The most bytes of a package folder Studio copies: Genex refuses a larger unpacked package (D47). */
export const PACKAGE_BYTES_MAX = 200 * MIB;
/** Folders an item package never carries (the CLI's packer leaves them out too): never copied. */
const LEFT_OUT: ReadonlySet<string> = new Set([".git", "node_modules", ".genex", "genex-items"]);
/** Where `items add` writes a shared item, in the game and in the run folder. */
export const SHARED_ITEMS_DIR = "genex-items";
/** Where an earlier copy of an item goes: under `.genex/`, which no publish ships (as the CLI does). */
const REPLACED_DIR = [".genex", "replaced-items"] as const;
/** The run folder's copies of the game's files. */
const INPUTS_DIR = ".studio-inputs";
/** Owner-only, like the rest of the run folder. */
const PRIVATE_DIR = 0o700;
const PRIVATE_FILE = 0o600;
/** Opening a file never follows a link put in its place (Windows has no such flag). */
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const STAGING_ID_BYTES = 4;

const refuse = (message: string) => new GenexCliRefusal(GenexCliRefusalCode.InvalidValue, message);

/** A path as the agent gave it, its segments joined with `/` and its `.` and empty ones gone. */
const plainRelative = (given: string): string =>
  given
    .split(/[/\\]+/)
    .filter((segment) => segment !== "" && segment !== ".")
    .join("/");

/** The real path `arg` names inside `game` (the game's real folder), of the kind it should be; refused otherwise. */
export async function resolveGamePath(
  game: string,
  arg: Pick<GamePathArg, "option" | "path" | "target">,
): Promise<string> {
  let real: string;
  try {
    real = await containedReal(game, plainRelative(arg.path));
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    const message = missing ? GENEX_CLI_PROMPT.GamePathMissing : GENEX_CLI_PROMPT.GamePathOutside;
    throw refuse(message(arg.option, arg.path));
  }
  const stats = await lstat(real);
  if (arg.target === GamePathTarget.File && !stats.isFile())
    throw refuse(GENEX_CLI_PROMPT.GamePathNotFile(arg.option, arg.path));
  if (arg.target === GamePathTarget.Folder && !stats.isDirectory())
    throw refuse(GENEX_CLI_PROMPT.GamePathNotFolder(arg.option, arg.path));
  return real;
}

/** Copy one regular file, never through a link put in its place since it was checked. */
async function copyRegularFile(source: string, target: string, notFile: () => Error): Promise<void> {
  const handle = await open(source, constants.O_RDONLY | NO_FOLLOW);
  const stats = await handle.stat().catch(() => null);
  if (!stats?.isFile()) {
    await handle.close();
    throw notFile();
  }
  // The stream closes the handle once it ends or fails.
  await pipeline(handle.createReadStream(), createWriteStream(target, { flags: "wx", mode: PRIVATE_FILE }));
}

/** What a package folder's copy has taken so far, against its caps. */
interface Budget {
  files: number;
  bytes: number;
}

/**
 * Copy a package folder of `game`: its files and folders, never a link, a special file or a folder an
 * item package leaves out, and refused once it holds more than Genex takes.
 */
async function copyPackage(game: string, from: string, to: string, option: string, budget: Budget): Promise<void> {
  await mkdir(to, { mode: PRIVATE_DIR });
  const tooLarge = () => refuse(GENEX_CLI_PROMPT.GamePathTooLarge(option, PACKAGE_FILES_MAX, PACKAGE_BYTES_MAX / MIB));
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    if (entry.isDirectory() && !LEFT_OUT.has(entry.name)) {
      // A folder swapped for a link since it was listed is never followed out of the game.
      const real = await realpath(source);
      if (isBelow(game, real)) await copyPackage(game, real, path.join(to, entry.name), option, budget);
      continue;
    }
    if (!entry.isFile()) continue;
    const stats = await lstat(source);
    if (!stats.isFile()) continue;
    budget.files += 1;
    budget.bytes += stats.size;
    if (budget.files > PACKAGE_FILES_MAX || budget.bytes > PACKAGE_BYTES_MAX) throw tooLarge();
    await copyRegularFile(source, path.join(to, entry.name), tooLarge);
  }
}

/**
 * Copy each of the game's files and folders a call names into `<work>/.studio-inputs/<n>/`, checked
 * again by real path, and answer the argv with each value pointing at its copy.
 */
export async function stageGamePaths(
  game: string,
  args: readonly GamePathArg[],
  argv: readonly string[],
  work: string,
): Promise<string[]> {
  const staged = [...argv];
  for (const [n, arg] of args.entries()) {
    const real = await resolveGamePath(game, arg);
    const into = path.join(work, INPUTS_DIR, String(n));
    await mkdir(into, { recursive: true, mode: PRIVATE_DIR });
    const copy = path.join(into, path.basename(real));
    if (arg.target === GamePathTarget.Folder) await copyPackage(game, real, copy, arg.option, { files: 0, bytes: 0 });
    else await copyRegularFile(real, copy, () => refuse(GENEX_CLI_PROMPT.GamePathNotFile(arg.option, arg.path)));
    staged[arg.index] = copy;
  }
  return staged;
}

/** Why an item's folder did not go into the game, in words the agent reads. */
export class ItemNotDelivered extends Error {
  constructor(why: string) {
    super(why);
    this.name = "ItemNotDelivered";
  }
}

/** `segments` under `game` as real folders, made where absent; a link or a file on the way is refused. */
async function realFolder(game: string, segments: readonly string[]): Promise<string> {
  let dir = game;
  for (const segment of segments) {
    dir = path.join(dir, segment);
    const stats = await lstat(dir).catch(() => null);
    if (!stats) await mkdir(dir);
    else if (!stats.isDirectory())
      throw new ItemNotDelivered(GENEX_CLI_PROMPT.ItemFolderLink(path.relative(game, dir).split(path.sep).join("/")));
  }
  return dir;
}

/** Copy the folder the CLI wrote: folders and files only, anything else refused. */
async function copyItemFolder(from: string, to: string): Promise<void> {
  await mkdir(to);
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) await copyItemFolder(source, target);
    else if (entry.isFile())
      await copyRegularFile(source, target, () => new ItemNotDelivered(GENEX_CLI_PROMPT.ItemFolderEntry(entry.name)));
    else throw new ItemNotDelivered(GENEX_CLI_PROMPT.ItemFolderEntry(entry.name));
  }
}

/** A moment as a folder name can carry it: `2026-10-23T07-30-00-000Z`. */
const stampOf = (at: number): string => new Date(at).toISOString().replace(/[:.]/g, "-");

/**
 * Move `items add`'s `genex-items/<itemId>/` from the run folder `work` into `game` (its real
 * folder), through a staging folder beside it; an earlier copy moves under `.genex/replaced-items/`
 * first, stamped `at`. Answers the folder, relative to the game.
 */
export async function deliverSharedItem(work: string, game: string, itemId: string, at: number): Promise<string> {
  const from = path.join(work, SHARED_ITEMS_DIR, itemId);
  const written = await lstat(from).catch(() => null);
  if (!written?.isDirectory()) throw new ItemNotDelivered(GENEX_CLI_PROMPT.ItemFolderMissing);
  const items = await realFolder(game, [SHARED_ITEMS_DIR]);
  const final = path.join(items, itemId);
  const existing = await lstat(final).catch(() => null);
  if (existing && !existing.isDirectory())
    throw new ItemNotDelivered(GENEX_CLI_PROMPT.ItemFolderLink(`${SHARED_ITEMS_DIR}/${itemId}`));
  const keep = existing ? await realFolder(game, REPLACED_DIR) : null;
  const staging = path.join(items, `.${itemId}.incoming-${randomBytes(STAGING_ID_BYTES).toString("hex")}`);
  try {
    await copyItemFolder(from, staging);
    if (keep) await rename(final, path.join(keep, `${itemId}-${stampOf(at)}`));
    await rename(staging, final);
  } finally {
    // Only this delivery's own staging folder, which holds only what it copied.
    await rm(staging, { recursive: true, force: true });
  }
  return `${SHARED_ITEMS_DIR}/${itemId}`;
}
