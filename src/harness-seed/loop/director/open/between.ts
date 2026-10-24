/**
 * What waits for the end of an open Loop's turn before the next (`LoopRun.afterTurn`, which the wake
 * loop awaits): a look at the project's app the turn started settles first, then a recovery of the
 * app under way; then, when the turn kept no save point, Genex keeps what it left (always when the
 * folder changed; only what is unsaved where a plugin saves the project's app; nothing otherwise, nor
 * while a worker writes in the folder in place); then the rewind the lead asked for (Genex's restore
 * of the save point, the plugins' steps around it, then a wait until the app answers) and the restart
 * (the project's restore moments with no file changed, then the wait), both waiting while a worker
 * writes in place; then, when the turn kept a save point the folder still holds, the game's judges
 * play it in turn (`judge-rounds.ts`). Each outcome is one line the lead's next message carries.
 * Never under a running turn, never after the Loop closed, and no recovery starts while this runs.
 *
 * Whether the turn did something is read from what the lead did (`didWork`), never from how the folder
 * stands after it: a rewind or restart newly asked for, a claim turned down, a worker marked, or the
 * folder's content changed since the turn began (a file already changed and edited again included).
 * A save point over a folder whose content did not change is no work; a change nobody else made is
 * the lead's when its own session acted in the turn (a tool call: `OpenLoop.sessionActed`) or it kept
 * a save point of its own. A change made while someone else may have written in the folder (a writer
 * in place, a job of one, a recovery: `writers.ts`) is the lead's only while none of them can still
 * write, and at most `MAX_UNCLEAR_TURNS` turns in a row: beside them the lead rests until it is news.
 * So is a turn whose two edges git read in different ways, when the lead's session acted. A change
 * whose session took no act of its own, nobody else known to write, is the lead's at most
 * `MAX_FOLDER_ONLY_TURNS` turns in a row: something outside the run writes there. A turn in which
 * Genex took the folder back to a save point shows nothing of the lead's in the folder: only its own
 * acts and save points count. An autosave is work only when it kept something the turn's end didn't
 * show (the project's app saving what it held): an empty one is none.
 * Who else may write is taken as the turn's start before the folder is read at it: as the turn begins
 * when the lead rested since (`openTurnBegins`, which reads the folder again), else as the turn before
 * it ended.
 */
import { GIT_TIMEOUT_MS } from "../../config.ts";
import {
  CheckpointSkip,
  fireHooks,
  HookEvent,
  hookBlocked,
  holdOf,
  hooksOn,
  REOPEN_WAIT_MS,
  runScope,
  waitReady,
} from "../../hooks.ts";
import { GIT, gitAt } from "../../git.ts";
import { HostMethod } from "../../host-methods.ts";
import { CLIP_REASON, clip } from "../../text.ts";
import { SECOND_MS } from "../../time.ts";
import type { LoopRun } from "../loop-run.ts";
import { closeUnderWay } from "../close-latch.ts";
import { folderChanged } from "./close.ts";
import {
  asksPending,
  MAX_FOLDER_ONLY_TURNS,
  MAX_UNCLEAR_TURNS,
  type OpenFolderMark,
  type OpenLoop,
  type OpenRewind,
  type TurnStart,
} from "./contract.ts";
import { FOLDER_GIT } from "./folder-git.ts";
import { heldForLead, OPEN_NEWS } from "./prompts.ts";
import { checkpointNow, queued, recordSavePoint } from "./save-point.ts";
import { judgeRound } from "./judge-rounds.ts";
import { activeWork } from "./active-work.ts";
import {
  markedSince,
  onlyLeftovers,
  othersWrote,
  othersWriting,
  readWaiting,
  turnStartOf,
  writersInPlace,
} from "./writers.ts";

const MESSAGE = {
  autosave: "Autosave",
  autosaveSummary: "Saved by Genex: the lead's turn ended with unsaved work.",
  notRestored: (why: string) => `the restore failed (${why})`,
  treeUnread: (why: string) =>
    `Genex couldn't read the game folder's content at a turn's edge (${why}); until it can, it tells the lead's work by what git lists as changed.`,
  treeUnreadPlain:
    "Genex couldn't read the project's files at the end of a turn, so it tells the lead's work by what git lists as changed.",
} as const;

/** A folder mark read longer ago than this when the lead's turn begins is read again: the lead rested since. */
const FRESH_MARK_MS = 5 * SECOND_MS;
/** How long reading the folder's content may take at a turn's edge before Genex reads git's status instead. */
const TURN_TREE_TIMEOUT_MS = GIT_TIMEOUT_MS.slow;
/** A folder's content read from git's status instead of its tree (`folderTree`): held only against another such read. */
const STATUS_MARK = "status:";

/** Whether the Loop is closing or closed, stopped, or paused: nothing runs between turns then. */
const over = (loopRun: LoopRun, open: OpenLoop): boolean =>
  loopRun.state.finished ||
  Boolean(loopRun.state.finish) ||
  closeUnderWay(loopRun.state) ||
  loopRun.ctx.cancelled === true ||
  Boolean(open.halted || open.refused);

/** A line the lead's next message carries. */
const carry = (open: OpenLoop, line: string): void => {
  open.journal.carried.push(line);
};

/**
 * The turn's unsaved work, kept as an autosave: always when the folder changed (or git couldn't
 * say), only what is unsaved where a plugin saves the project's app, and nothing otherwise.
 * Answers whether it kept a save point: a checkpoint Genex held back, that failed or that found
 * nothing unsaved kept none.
 */
async function autosave(loopRun: LoopRun, open: OpenLoop): Promise<boolean> {
  const changed = await folderChanged(loopRun);
  const appSaved =
    hooksOn(loopRun.game, HookEvent.CheckpointBefore) || hooksOn(loopRun.game, HookEvent.CheckpointAfter);
  if (changed === false && !appSaved) return false;
  const taken = await checkpointNow(loopRun, MESSAGE.autosave, changed === false);
  if ("snapshot" in taken) {
    const ask = { label: MESSAGE.autosave, summary: MESSAGE.autosaveSummary, auto: true };
    const point = await recordSavePoint(loopRun, ask, taken);
    carry(open, OPEN_NEWS.autosaved(point.label));
    return true;
  }
  if ("skipped" in taken && taken.skipped === CheckpointSkip.NothingUnsaved) return false;
  const why =
    "blocked" in taken ? heldForLead({ reason: taken.blocked, hold: taken.hold, label: taken.label }) : taken.reason;
  carry(open, OPEN_NEWS.notAutosaved(why));
  return false;
}

/** The autosave, unless a worker writes in the folder in place: it would keep that worker's half-done files. */
async function autosaveUnlessWriting(loopRun: LoopRun, open: OpenLoop, writers: readonly string[]): Promise<boolean> {
  if (!writers.length) return autosave(loopRun, open);
  if ((await folderChanged(loopRun)) !== false) carry(open, OPEN_NEWS.notAutosavedWriter(writers));
  return false;
}

/** Says once, on the run's feed, that the folder's content couldn't be read. */
async function saidUnread(loopRun: LoopRun, open: OpenLoop, err: unknown): Promise<void> {
  if (open.treeUnread) return;
  open.treeUnread = true;
  const why = clip(err instanceof Error ? err.message : String(err), CLIP_REASON);
  await loopRun.decision(MESSAGE.treeUnread(why), MESSAGE.treeUnreadPlain).catch(() => {});
}

/** The folder's content (`FOLDER_GIT.tree`), else git's list of its changes (`STATUS_MARK`); null when neither reads. */
async function folderTree(loopRun: LoopRun, open: OpenLoop): Promise<string | null> {
  const { ctx, run } = loopRun;
  const at = { project: run.project };
  try {
    const label = `open:${run.runId}:turn-tree`;
    const tree = await gitAt(ctx, at, FOLDER_GIT.tree(run.runId), {
      label,
      trim: "both",
      timeoutMs: TURN_TREE_TIMEOUT_MS,
    });
    return tree || null;
  } catch (err) {
    await saidUnread(loopRun, open, err);
    const label = `open:${run.runId}:turn-status`;
    const status = await gitAt(ctx, at, FOLDER_GIT.statusDigest, { label, trim: "both" }).catch(() => "");
    return status ? `${STATUS_MARK}${status}` : null;
  }
}

/** The game folder now: its commit and its content (`OpenFolderMark`). */
async function folderMark(loopRun: LoopRun, open: OpenLoop): Promise<OpenFolderMark> {
  const { ctx, run } = loopRun;
  const at = { project: run.project };
  const [head, tree] = await Promise.all([
    gitAt(ctx, at, GIT.head, { label: `open:${run.runId}:turn-head` }).catch(() => null),
    folderTree(loopRun, open),
  ]);
  return { head, tree };
}

/** Whether two reads of the folder's content can be held against each other: both read, the same way. */
const comparable = (one: string | null, other: string | null): boolean =>
  one !== null && other !== null && one.startsWith(STATUS_MARK) === other.startsWith(STATUS_MARK);

/** The tree a turn's content is held against: the folder as the turn began, else its last commit's. */
async function turnBase(loopRun: LoopRun, open: OpenLoop): Promise<string | null> {
  if (open.turnMark?.tree) return open.turnMark.tree;
  const label = `open:${loopRun.run.runId}:turn-base`;
  return gitAt(loopRun.ctx, { project: loopRun.run.project }, FOLDER_GIT.headTree, { label }).catch(() => null);
}

/** What a turn's end reads of the lead's work (`didWork`). */
interface TurnRead {
  savedInTurn: boolean;
  /** The lead's own session took an act of its own in the turn (`OpenLoop.sessionActed`). */
  acted: boolean;
  /** Genex took the folder back to a save point since the turn began (a recovery's way back). */
  restored: boolean;
  /** The folder as the turn ended, before Genex's own work between turns. */
  now: OpenFolderMark;
  /** The folder's content as the turn began. */
  base: string | null;
  /** Someone else may have written in the folder since the turn began (`writers.ts`). */
  others: boolean;
  /** Those others were only jobs that ended writers in place left running (`onlyLeftovers`). */
  leftovers: boolean;
}

/** The lead's own acts Genex sees: a rewind or restart newly asked for, a claim turned down, a worker marked. */
const leadActed = (open: OpenLoop): boolean =>
  (asksPending(open.journal) && !open.askPending) || open.claimTurnedDown || markedSince(open, open.turnStart);

/** A turn that was the lead's own: the runs of turns read only from the folder start again. */
function ownWork(open: OpenLoop): boolean {
  open.unclearStreak = 0;
  open.folderOnlyStreak = 0;
  return true;
}

/**
 * A turn whose work is read only from the folder's content while someone else may have written in
 * it: none while one of them can still write (the lead rests beside it), else the lead's at most
 * `MAX_UNCLEAR_TURNS` times in a row.
 */
function unclearWork(open: OpenLoop): boolean {
  if (othersWriting(open)) return false;
  open.unclearStreak += 1;
  return open.unclearStreak <= MAX_UNCLEAR_TURNS;
}

/**
 * A turn whose only sign of work is the folder's content, nobody else known to write: the lead's when
 * its session acted or it kept a save point of its own, else at most `MAX_FOLDER_ONLY_TURNS` times in
 * a row (something outside the run wrote there).
 */
function folderWork(open: OpenLoop, read: Pick<TurnRead, "acted" | "savedInTurn">): boolean {
  if (read.acted || read.savedInTurn) return ownWork(open);
  open.folderOnlyStreak += 1;
  return open.folderOnlyStreak <= MAX_FOLDER_ONLY_TURNS;
}

/** A turn that did nothing Genex can tell: the runs of turns read only from the folder end. */
function noWork(open: OpenLoop): boolean {
  open.unclearStreak = 0;
  open.folderOnlyStreak = 0;
  return false;
}

/** Whether the lead's turn did something (the module's header). */
function didWork(open: OpenLoop, read: TurnRead): boolean {
  if (leadActed(open)) return ownWork(open);
  // The folder as Genex's way back left it shows nothing of the lead's: its own save point still counts.
  if (read.restored) return read.savedInTurn ? ownWork(open) : noWork(open);
  const known = comparable(read.now.tree, read.base);
  const changed = known && read.now.tree !== read.base;
  if (changed && !read.others) return folderWork(open, read);
  // Beside only what ended writers left running, the lead's own save point is its work: it holds those jobs now.
  if (changed && read.leftovers && read.savedInTurn) return ownWork(open);
  const before = open.turnMark;
  const moved = Boolean(before?.head && read.now.head && read.now.head !== before.head);
  // Two edges git read in different ways count by the turn's own acts, save points and commits, as an unclear turn.
  const unknownButActed = !known && (read.savedInTurn || moved || read.acted);
  if (changed || unknownButActed) return unclearWork(open);
  return noWork(open);
}

/**
 * The folder after an autosave: when the save added content the turn's end didn't show (the project's
 * app saving what it held), the turn did something, read only from the folder's content.
 */
async function keptByApp(
  loopRun: LoopRun,
  open: OpenLoop,
  ended: OpenFolderMark,
  read: Pick<TurnRead, "others" | "acted" | "savedInTurn" | "restored">,
) {
  const kept = await folderMark(loopRun, open);
  const more = comparable(kept.tree, ended.tree) && kept.tree !== ended.tree;
  if (more && !open.turnWorked && !read.restored)
    open.turnWorked = read.others ? unclearWork(open) : folderWork(open, read);
  return kept;
}

/** Waits until the project's app answers again, when a plugin says whether it does; why not, or null. */
async function answered(loopRun: LoopRun, open: OpenLoop): Promise<string | null> {
  if (!hooksOn(loopRun.game, HookEvent.Health)) return null;
  const until = Math.min(open.clock.now() + REOPEN_WAIT_MS, loopRun.finalDeadline);
  const stopped = () => over(loopRun, open);
  const ready = await waitReady(loopRun.ctx, loopRun.game, runScope(loopRun), open.clock, until, stopped);
  return ready.ok || loopRun.ctx.cancelled || stopped() ? null : ready.reason;
}

/** Genex's restore of a snapshot, after every git write before it; why it didn't happen, or null. */
async function restoreSnapshot(loopRun: LoopRun, snapshotId: string, reason: string): Promise<string | null> {
  const params = { ...runScope(loopRun), snapshotId, reason };
  try {
    await queued(loopRun, () => loopRun.ctx.call(HostMethod.SnapshotRestore, params));
    return null;
  } catch (err) {
    if (hookBlocked(err))
      return heldForLead({ reason: String(err.reason ?? err.message), hold: err.hold, label: err.label });
    return MESSAGE.notRestored(err instanceof Error ? err.message : String(err));
  }
}

/**
 * The lead's rewind: back to the save point it named (the snapshot its label named when it asked),
 * then the app waited for. Whether the folder went back.
 */
async function rewind(loopRun: LoopRun, open: OpenLoop, { label, snapshotId }: OpenRewind): Promise<boolean> {
  open.journal.between.rewind = null;
  const why = await restoreSnapshot(loopRun, snapshotId, label);
  if (why) {
    carry(open, OPEN_NEWS.noRewind(label, why));
    return false;
  }
  carry(open, OPEN_NEWS.rewound(label));
  const notBack = await answered(loopRun, open);
  if (notBack) carry(open, OPEN_NEWS.notAnswering(notBack));
  return true;
}

/**
 * The project's restore moments with no file changed, on the git-write queue; whether the app was
 * restarted. A block before leaves the app as it is; Genex holding the reopen back is the outcome,
 * never read as an app that failed to reopen.
 */
async function restartSteps(loopRun: LoopRun, open: OpenLoop): Promise<boolean> {
  const scope = runScope(loopRun);
  const closing = await fireHooks(loopRun.ctx, loopRun.game, HookEvent.RestoreBefore, scope);
  if (closing.blocked) {
    carry(open, OPEN_NEWS.noRestart(heldForLead(closing.blocked)));
    return false;
  }
  const reopening = await fireHooks(loopRun.ctx, loopRun.game, HookEvent.RestoreAfter, scope);
  if (reopening.blocked && holdOf(reopening.blocked)) {
    carry(open, OPEN_NEWS.noRestart(heldForLead(reopening.blocked)));
    return false;
  }
  carry(open, OPEN_NEWS.restarted);
  return true;
}

/**
 * The lead's restart: its steps (`restartSteps`), then the app waited for outside the git-write
 * queue, so a recovery's way back never waits behind that wait.
 */
async function restart(loopRun: LoopRun, open: OpenLoop): Promise<void> {
  open.journal.between.restart = false;
  if (!(await queued(loopRun, () => restartSteps(loopRun, open)))) return;
  const notBack = await answered(loopRun, open);
  if (notBack) carry(open, OPEN_NEWS.notAnswering(notBack));
}

/**
 * The rewind and the restart the lead asked for; both wait while a worker writes in the folder in
 * place, whose edits would land on the files the rewind put back. Whether the folder went back.
 */
async function asksAtTurnEnd(loopRun: LoopRun, open: OpenLoop, writers: readonly string[]): Promise<boolean> {
  const { between } = open.journal;
  if (!asksPending(open.journal) || over(loopRun, open)) return false;
  if (writers.length) {
    carry(open, OPEN_NEWS.askWaitsForWriter(writers));
    return false;
  }
  const rewound = between.rewind ? await rewind(loopRun, open, between.rewind) : false;
  if (between.restart && !over(loopRun, open)) await restart(loopRun, open);
  return rewound;
}

/** A turn's end while Genex brings the project's app back: why nothing was kept or restored. */
function whileRecovering(open: OpenLoop, savedInTurn: boolean): void {
  if (!savedInTurn) carry(open, OPEN_NEWS.notAutosaved(OPEN_NEWS.bringingBack));
  if (asksPending(open.journal)) carry(open, OPEN_NEWS.askWaits);
}

/** The between-turns work itself (the module's header), once no recovery can start beside it. */
async function betweenTurns(loopRun: LoopRun, open: OpenLoop): Promise<void> {
  const savedInTurn = open.journal.savePoints.length > open.turnSavedFrom;
  const restored = open.turnStart !== null && open.restores !== open.turnStart.restores;
  const others = await othersWrote(loopRun, open, open.turnStart);
  // Who else may write is taken before the folder is read: a writer that ends while git reads it counts for the next turn.
  const nextStart = turnStartOf(open);
  const ended = await folderMark(loopRun, open);
  const leftovers = others && onlyLeftovers(open, open.turnStart);
  const read = { savedInTurn, acted: open.sessionActed, restored, now: ended, others, leftovers };
  open.turnWorked = didWork(open, { ...read, base: await turnBase(loopRun, open) });
  // Rested beside a job only the lead can stop now: it hears which, and how its work counts.
  if (!open.turnWorked && open.leftoverJobs.length) carry(open, OPEN_NEWS.leftoverJobs(open.leftoverJobs));
  open.claimTurnedDown = false;
  if (open.recovering) {
    whileRecovering(open, savedInTurn);
    await nextTurnFrom(loopRun, open, ended, nextStart);
    return;
  }
  const writers = writersInPlace(open).map((record) => record.id);
  // A turn that kept a save point left nothing for an autosave.
  const autosaved = !savedInTurn && (await autosaveUnlessWriting(loopRun, open, writers));
  let next = autosaved ? await keptByApp(loopRun, open, ended, read) : ended;
  const rewound = await asksAtTurnEnd(loopRun, open, writers);
  if (rewound) next = await folderMark(loopRun, open);
  // The game's judges play the save point the turn kept; a folder taken back to an older one has none to play.
  else if (savedInTurn || autosaved) await judgeRound(loopRun, open);
  await nextTurnFrom(loopRun, open, next, nextStart);
}

/** The between-turns work (the module's header), for an open Loop's run. */
export async function openBetweenTurns(loopRun: LoopRun): Promise<void> {
  const open = loopRun.open;
  if (!open || over(loopRun, open)) return;
  // A look the turn started settles first: a crash it saw starts its recovery now, never in the middle of what follows.
  if (open.healthLook) await open.healthLook;
  open.betweenTurns = true;
  try {
    await betweenTurns(loopRun, open);
  } finally {
    open.betweenTurns = false;
  }
}

/** The folder as it stands now becomes the next turn's start. */
function markFrom(open: OpenLoop, mark: OpenFolderMark): void {
  open.turnMark = mark;
  open.turnMarkAt = open.clock.now();
}

/**
 * The next turn begins from here: its save points counted from now, the folder as it stands, who else
 * may write as it was taken before the folder was read (`start`), the journal kept.
 */
async function nextTurnFrom(loopRun: LoopRun, open: OpenLoop, mark: OpenFolderMark, start: TurnStart): Promise<void> {
  open.turnSavedFrom = open.journal.savePoints.length;
  open.sessionActed = false;
  markFrom(open, mark);
  open.turnStart = start;
  open.askPending = asksPending(open.journal);
  await loopRun.saveJournal().catch(() => {});
}

/**
 * As the lead's turn begins: when its folder mark is old (the lead rested, and others may have written
 * meanwhile), who else may write is taken again (`TurnStart`, the run's jobs and the workers'
 * questions read first), then the folder is read again; a fresh mark keeps the start the turn before
 * it took. Whether the lead's session acts is counted afresh for the turn either way.
 */
export async function openTurnBegins(loopRun: LoopRun): Promise<void> {
  const open = loopRun.open;
  if (!open) return;
  open.sessionActed = false;
  const stale = open.turnMarkAt === null || open.clock.now() - open.turnMarkAt > FRESH_MARK_MS;
  if (!stale && open.turnStart) return;
  await activeWork(loopRun, open.clock.now(), { fresh: true });
  await readWaiting(open);
  const start = turnStartOf(open);
  markFrom(open, await folderMark(loopRun, open));
  open.turnStart = start;
}
