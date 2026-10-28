/**
 * The launch that moves Genex's data (Settings → Storage asked for it, then restarted Genex). It
 * runs before any of Genex starts, on a temp folder of Electron's own (`data-folder.ts`), so no
 * file in the old folder is open: the data moves, what pointed into the old folder is pointed at
 * the new one, the record says where the data is now, and the caller starts Genex again.
 *
 * A move that fails is put back and recorded with why, for Storage to say. One that could not be
 * put back (entries left only in the new folder) stays recorded as a move, so starting Genex again
 * carries it on rather than opening on half the data.
 *
 * Copies a move leaves behind (an old folder's originals another program held, a failed move's
 * copies) are listed and removed later, except a file changed after the copy was made: someone
 * edited it there, and it stays.
 */
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import type { DataFolderProblem, DataMoveProgress } from "../shared/data-folder.ts";
import { errorMessage } from "../shared/errors.ts";
import {
  type DataMoved,
  DataMoveError,
  type EntryMove,
  moveData,
  moveProblemOf,
  removeEntries,
} from "../substrate/data-move.ts";
import { moveClaudeProjects, rebaseDataFiles, relinkLinks, repairWorktrees } from "../substrate/data-relink.ts";
import { isInside, samePath } from "../substrate/paths.ts";
import {
  DATA_FOLDER_FILE,
  type DataFolderRecord,
  type DataLeftover,
  LOCK_FILES,
  readDataFolderRecord,
  writeDataFolderRecord,
} from "./data-folder.ts";

/** What the moving launch needs; the moves and repairs default to the real ones. */
export interface DataMoveLaunchDeps {
  from: string;
  to: string;
  /** Electron's default data folder, which holds the record. */
  defaultDir: string;
  /** The start window's progress. */
  progress(progress: DataMoveProgress): void;
  log(line: string): void;
  /** Make Genex's own Git the host's before the copies are repaired (Windows); false when there is none. */
  hostGit?: () => Promise<boolean>;
  move?: typeof moveData;
  /** The clock a copy's leftovers are stamped with. */
  now?: () => number;
}

/**
 * How a moving launch ended: moved; not moved, with everything back where it was; or `stranded`,
 * entries left only in the new folder, which the next start carries on with.
 */
export type DataMoveOutcome =
  | { moved: true; mode: DataMoved["mode"] }
  | { moved: false; problem: DataFolderProblem; stranded?: string[] };

type Log = (line: string) => void;

/** A failed move's own copies in a folder nobody uses yet: no change to them is anyone's edit. */
const NOBODY_EDITS = Number.MAX_SAFE_INTEGER;

/** The record's folder field for `dir`: absent for the default folder. */
function chosen(dir: string, defaultDir: string): Pick<DataFolderRecord, "dir"> {
  return samePath(dir, defaultDir) ? {} : { dir };
}

/** The record's leftovers with `added`, the field left out when there are none. */
function withLeftovers(
  existing: DataLeftover[] | undefined,
  added: DataLeftover[],
): Pick<DataFolderRecord, "leftover"> {
  const leftover = [...(existing ?? []), ...added];
  return leftover.length ? { leftover } : {};
}

/** Move the data, record where it went (or why it did not go), and repair what pointed into the old folder. */
export async function runDataMove(deps: DataMoveLaunchDeps): Promise<DataMoveOutcome> {
  const { from, to, defaultDir } = deps;
  const now = deps.now ?? Date.now;
  const report = (done: number, total: number) => deps.progress({ to, done, total });
  report(0, 0);
  // Old copies an earlier move left in the target go first: they would clash with the data coming in.
  await settleLeftovers(defaultDir, (dir) => samePath(dir, to), { inUse: from, log: deps.log });
  const record = readDataFolderRecord(defaultDir);
  const journal: Record<string, EntryMove> = { ...record.done };
  // A file in the old folder changed after this is someone's edit made while the copy ran (or
  // between attempts, for a move that carries on): it stays.
  const startedAt = (record.moving && record.movingSince) || now();
  let moved: DataMoved;
  try {
    moved = await (deps.move ?? moveData)(
      {
        from,
        to,
        keep: [...(samePath(from, defaultDir) ? [DATA_FOLDER_FILE] : []), ...LOCK_FILES],
        allowInTarget: [...(samePath(to, defaultDir) ? [DATA_FOLDER_FILE] : []), ...LOCK_FILES],
        ...(record.moving ? { resume: record.moving, done: journal } : {}),
      },
      {
        onProgress: report,
        onPlanned: (entries) =>
          writeDataFolderRecord(defaultDir, {
            ...record,
            moveTo: to,
            moving: [...entries],
            movingSince: startedAt,
            done: { ...journal },
          }),
        onEntryMoved: async (name, how) => {
          journal[name] = how;
          await writeDataFolderRecord(defaultDir, { ...readDataFolderRecord(defaultDir), done: { ...journal } });
        },
      },
    );
  } catch (error) {
    return failedMove(deps, error);
  }
  // From here the data is in its new folder: the record says so, and that its links are still to
  // repair, before anything is removed from the old one.
  const left = [
    ...(moved.copied.length ? [{ dir: from, entries: moved.copied, since: startedAt }] : []),
    // What was written under a renamed entry's old name after the rename is someone's: it stays.
    ...(moved.doubled.length ? [{ dir: from, entries: moved.doubled, since: startedAt, changed: true as const }] : []),
  ];
  await writeDataFolderRecord(defaultDir, {
    ...chosen(to, defaultDir),
    relinkFrom: from,
    ...withLeftovers(readDataFolderRecord(defaultDir).leftover, left),
  });
  deps.log(`data folder: moved ${from} to ${to} (${moved.mode}, ${moved.bytes} bytes)`);
  await finishMove(defaultDir, to, deps);
  await settleLeftovers(defaultDir, (dir) => samePath(dir, from), { inUse: to, log: deps.log });
  return { moved: true, mode: moved.mode };
}

/**
 * Repair what pointed into a move's old folder, when the record says that is still to do (the move
 * just made, or one Genex closed after recording), then clear it. A later start runs it again
 * before anything else, so a copy's originals are never removed before its links are repaired.
 */
export async function finishMove(
  defaultDir: string,
  dataDir: string,
  deps: Pick<DataMoveLaunchDeps, "log" | "hostGit">,
): Promise<void> {
  const record = readDataFolderRecord(defaultDir);
  // Only for the folder the record says is in use: never another launch's.
  if (!record.relinkFrom || !samePath(dataDir, record.dir ?? defaultDir)) return;
  await relink({ from: record.relinkFrom, to: dataDir, ...deps });
  const after = readDataFolderRecord(defaultDir);
  delete after.relinkFrom;
  await writeDataFolderRecord(defaultDir, after);
}

/** Record a move that did not happen: put back (with any copies it left listed), or stranded and still to finish. */
async function failedMove(deps: DataMoveLaunchDeps, error: unknown): Promise<DataMoveOutcome> {
  const { from, to, defaultDir } = deps;
  const failure = error instanceof DataMoveError ? error : new DataMoveError(moveProblemOf(error), errorMessage(error));
  const { problem } = failure;
  deps.log(`data folder: could not move ${from} to ${to} (${problem}): ${failure.message}`);
  const record = readDataFolderRecord(defaultDir);
  const failed = { to, problem };
  if (failure.stranded.length) {
    deps.log(
      `data folder: ${failure.stranded.join(", ")} could not be put back in ${from}; the move carries on next start`,
    );
    await writeDataFolderRecord(defaultDir, { ...record, moveTo: to, failed });
    return { moved: false, problem, stranded: [...failure.stranded] };
  }
  const copies = failure.left.length ? [{ dir: to, entries: [...failure.left], since: NOBODY_EDITS }] : [];
  await writeDataFolderRecord(defaultDir, {
    ...chosen(from, defaultDir),
    failed,
    ...withLeftovers(record.leftover, copies),
  });
  return { moved: false, problem };
}

/** One repair after a move: what it is called in the log, and the step, which says what it did or null. */
interface RelinkStep {
  name: string;
  run(): Promise<string | null>;
}

/**
 * Point what named a place in the old folder at the new one: the library's folders, links, Claude
 * Code's sessions of the moved folders and the build copies' Git links. Each repair stands alone:
 * one that fails, or Git that is missing, is logged and the others still run; the data stays moved.
 */
async function relink(deps: { from: string; to: string; log: Log; hostGit?: () => Promise<boolean> }): Promise<void> {
  const { from, to, log } = deps;
  const steps: RelinkStep[] = [
    {
      name: "the library's folders",
      run: async () => {
        const rebased = await rebaseDataFiles(to, from);
        return rebased.length ? `pointed ${rebased.join(", ")} at ${to}` : null;
      },
    },
    {
      name: "links",
      run: async () => {
        const links = await relinkLinks(to, from);
        return links.failed.length ? `${links.failed.length} links still point at ${from}` : null;
      },
    },
    {
      name: "Claude Code's sessions",
      run: async () => {
        const sessions = await moveClaudeProjects(to, from);
        return sessions ? `moved Claude Code's sessions of ${sessions} folders` : null;
      },
    },
    {
      name: "the build copies",
      run: async () => {
        if (deps.hostGit && !(await deps.hostGit())) return "no Git to repair the build copies with";
        const unrepaired = await repairWorktrees(to, from);
        return unrepaired.length ? `Git could not repair ${unrepaired.length} build copies` : null;
      },
    },
  ];
  for (const step of steps) {
    const said = await step.run().catch((error: unknown) => `repairing ${step.name} failed: ${errorMessage(error)}`);
    if (said) log(`data folder: ${said}`);
  }
}

/** Whether a file under `entry` changed after `since` (links not followed): someone edited the copy left there. */
async function changedSince(entry: string, since: number): Promise<boolean> {
  const info = await lstat(entry).catch(() => null);
  if (!info) return false;
  if (info.isFile()) return info.mtimeMs > since;
  if (!info.isDirectory()) return false;
  for (const name of await readdir(entry).catch((): string[] => [])) {
    if (await changedSince(path.join(entry, name), since)) return true;
  }
  return false;
}

/** Where a leftover may not be removed from, and the log. */
interface Settling {
  /** The data folder in use: an entry that is it, or holds it, is never removed. */
  inUse: string;
  log: Log;
}

/**
 * Remove one leftover's entries nobody changed since the copy; what stays: the changed ones (listed
 * as changed, so they stay for good and Storage names their folder) and the held ones (tried again).
 */
async function settleLeftover(leftover: DataLeftover, settling: Settling): Promise<DataLeftover[]> {
  const { log } = settling;
  if (leftover.changed) return [leftover];
  const changed: string[] = [];
  const stale: string[] = [];
  for (const name of leftover.entries) {
    const entry = path.join(leftover.dir, name);
    if (isInside(entry, settling.inUse)) {
      log(`data folder: left ${entry} alone: it holds the data folder in use`);
      continue;
    }
    if (await changedSince(entry, leftover.since)) changed.push(name);
    else stale.push(name);
  }
  if (changed.length) log(`data folder: kept ${changed.join(", ")} in ${leftover.dir}: changed after the move`);
  const held = await removeEntries(leftover.dir, stale);
  if (held.length) log(`data folder: ${held.length} old entries in ${leftover.dir} are still in use`);
  return [
    ...(changed.length ? [{ ...leftover, entries: changed, changed: true as const }] : []),
    ...(held.length ? [{ dir: leftover.dir, entries: held, since: leftover.since }] : []),
  ];
}

/** Settle the leftovers in the folders `which` picks; the record keeps the others and what stays of these. */
async function settleLeftovers(defaultDir: string, which: (dir: string) => boolean, settling: Settling): Promise<void> {
  const leftovers = readDataFolderRecord(defaultDir).leftover ?? [];
  if (!leftovers.some((item) => which(item.dir))) return;
  const settled: DataLeftover[] = [];
  for (const item of leftovers) settled.push(...(which(item.dir) ? await settleLeftover(item, settling) : [item]));
  const record = readDataFolderRecord(defaultDir);
  delete record.leftover;
  await writeDataFolderRecord(defaultDir, { ...record, ...withLeftovers([], settled) });
}

/**
 * A later launch removes what moves copied but could not remove then: only the names a move
 * recorded, never in or holding the folder now in use, and never a file changed after the copy.
 */
export async function removeLeftover(defaultDir: string, dataDir: string, log: Log): Promise<void> {
  // Only for the folder the record says is in use: never another launch's.
  if (!samePath(dataDir, readDataFolderRecord(defaultDir).dir ?? defaultDir)) return;
  await settleLeftovers(defaultDir, (dir) => !samePath(dir, dataDir), { inUse: dataDir, log });
}
