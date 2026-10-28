/**
 * Settings → Storage's data folder: where Genex keeps its files, a folder the person picks to move
 * them to, and the move itself, which records the folder and restarts Genex (`data-move-launch.ts`
 * moves the files before anything opens them). A picked folder is checked before anything is
 * written: not inside Genex's own files, a game's folder or Genex's install; a fixed local drive
 * whose file system keeps permissions; empty, or a new `Genex` folder inside it; room for the
 * files. Only the folder picked last can be moved to: the window never names a path itself.
 */
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { type DataFolderChoice, DataFolderProblem, type DataFolderState } from "../shared/data-folder.ts";
import { StudioPlatform } from "../shared/boot.ts";
import { errorMessage } from "../shared/errors.ts";
import { SPARE_BYTES } from "../substrate/data-move.ts";
import { ensureDir } from "../substrate/fsx.ts";
import { isInside, samePath } from "../substrate/paths.ts";
import { type DriveFacts, DriveKind, isSharePath, keepsPermissions } from "../substrate/windows-drive.ts";
import { readDataFolderRecord, writeDataFolderRecord } from "./data-folder.ts";

/** The folder made inside a picked folder that already holds something, or a drive's root. */
export const DATA_FOLDER_NAME = "Genex";

/** What the data folder's choices need; the platform's own tools in the app, fakes in tests. */
export interface DataFolderChoiceDeps {
  platform: string;
  /** The person's own launch in the normal profile, where Settings offers the move. */
  normal: boolean;
  /** Electron's default data folder, which holds the record. */
  defaultDir: string;
  /** The folder Genex keeps its files in now. */
  dataDir: string;
  /** Folders the data folder may neither sit in nor hold: the games folder, each game, the install. */
  occupied(): Promise<string[]>;
  /** A build or a reply is under way. */
  busy(): boolean;
  /** The drive a folder is on (Windows), or null when the system cannot say. */
  drive(dir: string): Promise<DriveFacts | null>;
  /** Limit a new, empty folder's access to this account (Windows); throws when the drive refuses. */
  lockDown(dir: string): Promise<void>;
  /** Bytes of Genex's files that would move. */
  measure(): Promise<number>;
  /** Free bytes where `dir` is. */
  free(dir: string): Promise<number>;
  /** Whether two folders are on one volume, where the move renames and needs no room (default: their `stat`). */
  sameVolume?: (a: string, b: string) => Promise<boolean>;
  /** Start Genex again, which makes the move. */
  restart(): void;
  log(line: string): void;
}

/** The folder picked last and checked: where the files go and how much moves. */
interface Picked {
  to: string;
  bytes: number;
}

export interface DataFolderChoices {
  state(): DataFolderState;
  /** Check a folder from the picker; it becomes the one {@link move} moves to. */
  choose(picked: string): Promise<DataFolderChoice>;
  /** Move to the folder picked last: record it and restart. A refusal says why; nothing is written then. */
  move(): Promise<DataFolderChoice>;
}

/** A refusal for `to`. */
function refused(problem: DataFolderProblem, to: string | null): DataFolderChoice {
  return { ok: false, to, problem };
}

/** The names in a folder, or null when it is not one. */
async function entriesOf(dir: string): Promise<string[] | null> {
  const info = await lstat(dir).catch(() => null);
  if (!info?.isDirectory()) return null;
  return readdir(dir);
}

/** Whether `a` and `b` overlap: one is, or holds, the other. */
function overlaps(a: string, b: string): boolean {
  return isInside(a, b) || isInside(b, a);
}

/** The nearest folder of `dir` that exists, for the free space there. */
async function nearestExisting(dir: string): Promise<string> {
  for (let at = dir; ; at = path.dirname(at)) {
    if (await entriesOf(at)) return at;
    if (path.dirname(at) === at) return at;
  }
}

export function createDataFolderChoices(deps: DataFolderChoiceDeps): DataFolderChoices {
  const movable = deps.normal && deps.platform === StudioPlatform.Windows;
  let picked: Picked | null = null;

  /** Where the files would go for `dir`: the default folder as it is, an empty folder, else a `Genex` folder in it. */
  const targetFor = async (dir: string): Promise<{ to: string; problem?: DataFolderProblem }> => {
    if (samePath(dir, deps.defaultDir)) return { to: deps.defaultDir };
    const isRoot = path.parse(dir).root === dir;
    const names = await entriesOf(dir);
    if (!isRoot && names?.length === 0) return { to: dir };
    const to = path.join(dir, DATA_FOLDER_NAME);
    const inside = await entriesOf(to);
    if (inside?.length) return { to, problem: DataFolderProblem.NotEmpty };
    return { to };
  };

  /** The problem with `to` as Genex's data folder, or null. */
  const problemWith = async (to: string): Promise<DataFolderProblem | null> => {
    if (samePath(to, deps.dataDir)) return DataFolderProblem.Same;
    if (overlaps(to, deps.dataDir)) return DataFolderProblem.Overlaps;
    if (!samePath(to, deps.defaultDir) && overlaps(to, deps.defaultDir)) return DataFolderProblem.Overlaps;
    if ((await deps.occupied()).some((dir) => overlaps(to, dir))) return DataFolderProblem.Overlaps;
    // What a move left behind is removed later, whole: a folder in it would go with it.
    if (leftoverEntries(deps.defaultDir).some((entry) => isInside(entry, to))) return DataFolderProblem.Overlaps;
    if (isSharePath(to)) return DataFolderProblem.Network;
    return driveProblem(await deps.drive(to));
  };

  return {
    // Another launch reads nothing of the normal profile's record.
    state: () => {
      if (!movable) return { dir: deps.dataDir, movable, failed: null, kept: [] };
      const record = readDataFolderRecord(deps.defaultDir);
      const kept = (record.leftover ?? []).filter((item) => item.changed).map((item) => item.dir);
      return { dir: deps.dataDir, movable, failed: record.failed ?? null, kept: [...new Set(kept)] };
    },

    async choose(dir) {
      picked = null;
      if (!movable) return refused(DataFolderProblem.Unsupported, null);
      if (deps.busy()) return refused(DataFolderProblem.Busy, null);
      const real = await realpath(path.resolve(dir)).catch(() => path.resolve(dir));
      const target = await targetFor(real);
      if (target.problem) return refused(target.problem, target.to);
      const problem = await problemWith(target.to);
      if (problem) return refused(problem, target.to);
      const bytes = await deps.measure();
      if (!(await hasRoom(deps, target.to, bytes))) return refused(DataFolderProblem.NoSpace, target.to);
      picked = { to: target.to, bytes };
      return { ok: true, to: target.to, bytes };
    },

    async move() {
      const chosen = picked;
      if (!movable || !chosen) return refused(DataFolderProblem.Unsupported, null);
      if (deps.busy()) return refused(DataFolderProblem.Busy, chosen.to);
      try {
        await ensureDir(chosen.to);
        if (!samePath(chosen.to, deps.defaultDir)) await deps.lockDown(chosen.to);
      } catch (error) {
        deps.log(`data folder: could not prepare ${chosen.to}: ${errorMessage(error)}`);
        const facts = await deps.drive(chosen.to);
        const problem = facts && !keepsPermissions(facts) ? DataFolderProblem.FileSystem : DataFolderProblem.Unwritable;
        return refused(problem, chosen.to);
      }
      const record = readDataFolderRecord(deps.defaultDir);
      delete record.failed;
      delete record.moving;
      await writeDataFolderRecord(deps.defaultDir, { ...record, moveTo: chosen.to });
      deps.log(`data folder: moving to ${chosen.to} when Genex starts again`);
      deps.restart();
      return { ok: true, to: chosen.to, bytes: chosen.bytes };
    },
  };
}

/** The paths of every entry a move left to remove later. */
function leftoverEntries(defaultDir: string): string[] {
  return (readDataFolderRecord(defaultDir).leftover ?? []).flatMap((item) =>
    item.entries.map((name) => path.join(item.dir, name)),
  );
}

/** Whether `to` has room for `bytes`: always on the data's own volume, where the move only renames. */
async function hasRoom(deps: DataFolderChoiceDeps, to: string, bytes: number): Promise<boolean> {
  const nearest = await nearestExisting(to);
  if (await (deps.sameVolume ?? onOneVolume)(deps.dataDir, nearest)) return true;
  return (await deps.free(nearest)) >= bytes + SPARE_BYTES;
}

/** Whether two folders are on one volume, by their `stat`; false when either cannot be read. */
async function onOneVolume(a: string, b: string): Promise<boolean> {
  const [first, second] = await Promise.all([stat(a).catch(() => null), stat(b).catch(() => null)]);
  return first !== null && second !== null && first.dev === second.dev;
}

/** The problem with a drive as the home of Genex's data, or null; a drive Windows cannot describe passes here. */
function driveProblem(facts: DriveFacts | null): DataFolderProblem | null {
  if (!facts) return null;
  if (facts.kind === DriveKind.Network) return DataFolderProblem.Network;
  if (facts.kind === DriveKind.Removable) return DataFolderProblem.Removable;
  if (!keepsPermissions(facts)) return DataFolderProblem.FileSystem;
  return null;
}
