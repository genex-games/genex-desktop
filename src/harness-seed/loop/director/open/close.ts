/**
 * The open Loop's close, in place: there is no copy to land, the game folder is the live project.
 * Its workers settle (running ones stop; a copy's work stays on the run's refs), the last work is
 * kept in Genex's checkpoint when there is any (the plugins save their apps first), and the report,
 * the journal and the graph say how it ended: the goal reached, stopped, paused for a Resume, or
 * failed. Once per run, latched against any other close. Genex's run end (`run.end`) stays the
 * teardown's, as for every Loop.
 */
import type { AnyRecord } from "../../../types/harness.d.ts";
import type { EventData } from "../../../types/host-api.d.ts";
import { LoopProfile } from "../../folder-facts.ts";
import { FINISH_REPORT, stillToFixOf } from "../../finish-check.ts";
import { StopWhy } from "../../finish-contract.ts";
import { gitAt } from "../../git.ts";
import { CheckpointSkip, HookEvent, hooksOn, runScope, takeCheckpoint } from "../../hooks.ts";
import { HostMethod } from "../../host-methods.ts";
import { EventKind, ExecutionStatus, JournalPhase, RunEvent, writeRunArtifact } from "../../run-events.ts";
import { CLIP_REASON, clip } from "../../text.ts";
import { SECOND_MS, sleep } from "../../time.ts";
import { closeRunPool } from "../../workers/run-pool.ts";
import { latchClose } from "../close-latch.ts";
import type { LoopRun } from "../loop-run.ts";
import { asksPending } from "./contract.ts";
import { FOLDER_GIT } from "./folder-git.ts";
import { leadRowAtClose, openCloseOf } from "./graph.ts";

/** How an open Loop ends: whether the goal was reached, why it ended, and what a reviewer found not done. */
export interface OpenEnd {
  victory: boolean;
  because: string;
  notDone?: readonly string[];
  /** A reviewer's check ended it (a yes, or the no's that stop a Loop): never a pause, whatever else holds. */
  checked?: boolean;
  /** The Loop pauses for a Resume whatever else holds (its lead paused it for the person). */
  paused?: boolean;
  /** The Loop closes before it did anything (a paused run it can't pick up): no checkpoint of the folder. */
  keepNothing?: boolean;
  /**
   * No turn of the lead's ran this time (the person stopped it while its start was prepared): the app
   * counts none of the attempt as the run's worked time.
   */
  unworked?: boolean;
}

/** A close the log refuses is written again, at most this many times this far apart: one never written leaves the run running. */
const CLOSE_APPEND_ATTEMPTS = 3;
const CLOSE_APPEND_RETRY_MS = SECOND_MS;

/** The close's words for the run's feed and its last checkpoint. */
const MESSAGE = {
  loopEnd: "The Loop's end",
  notKept: (why: string) => `Genex couldn't keep the Loop's last work in a checkpoint: ${why}`,
  notKeptPlain:
    "Genex couldn't keep the Loop's last work in a checkpoint; the files are in the folder as the lead left them.",
  /** A rewind or restart the lead asked for that the Loop's close came before. */
  askDropped: "The rewind or restart the lead asked for last didn't run: the Loop closed first.",
} as const;

/** The game folder's uncommitted changes (`FOLDER_GIT.status`), trimmed; null when git couldn't say. */
async function folderStatus(loopRun: LoopRun): Promise<string | null> {
  const { ctx, run } = loopRun;
  const status = await gitAt(ctx, { project: run.project }, FOLDER_GIT.status, {
    label: `open:${run.runId}:close-status`,
  }).catch(() => null);
  return status === null ? null : status.trim();
}

/** Whether the game folder has uncommitted changes; null when git couldn't say. */
export async function folderChanged(loopRun: LoopRun): Promise<boolean | null> {
  const status = await folderStatus(loopRun);
  return status === null ? null : status.length > 0;
}

/**
 * The last work, kept in Genex's checkpoint: always when the folder changed (or git couldn't say),
 * only when something is unsaved where a plugin saves its app, and not at all otherwise. Answers the
 * snapshot's id, or null; a checkpoint that was held back or failed is said on the run's feed.
 */
async function keepLastWork(loopRun: LoopRun): Promise<string | null> {
  const { ctx, game } = loopRun;
  const changed = await folderChanged(loopRun);
  const appSaved = hooksOn(game, HookEvent.CheckpointBefore) || hooksOn(game, HookEvent.CheckpointAfter);
  if (changed === false && !appSaved) return null;
  const take = () =>
    takeCheckpoint(ctx, { ...runScope(loopRun), label: MESSAGE.loopEnd, onlyIfUnsaved: changed === false });
  const answer = await loopRun.open.gitWrite(take);
  if ("snapshot" in answer) return answer.snapshot.snapshot_id;
  if ("skipped" in answer && answer.skipped === CheckpointSkip.NothingUnsaved) return null;
  const why = "blocked" in answer ? answer.blocked : answer.reason;
  await loopRun.decision(MESSAGE.notKept(clip(why, CLIP_REASON)), MESSAGE.notKeptPlain).catch(() => {});
  return null;
}

/** The provider loss that paused the run, as its report keeps it. */
function limitRecord(limit: AnyRecord): AnyRecord {
  return {
    kind: limit.kind,
    message: clip(String(limit.message ?? ""), CLIP_REASON),
    retryAfterMs: limit.retryAfterMs ?? null,
    ...(typeof limit.at === "number" ? { at: limit.at } : {}),
  };
}

/**
 * What a close that is neither the goal reached nor a pause leaves for its result card: the last
 * no's lists, and why the Loop stopped (the person's Stop, or another end).
 */
function leftToFix(loopRun: LoopRun, end: OpenEnd, paused: boolean): AnyRecord {
  if (paused || end.victory) return {};
  const why = loopRun.ctx.cancelled ? StopWhy.Person : StopWhy.Ended;
  const left = stillToFixOf(loopRun.state.finishTally, why);
  return left ? { stillToFix: left } : {};
}

/** The report's last fields: how the Loop ended, what it kept, and how it reads on the run's card. */
function finishReport(loopRun: LoopRun, end: OpenEnd, closed: { kept: string | null; paused: boolean }): void {
  const { report, state } = loopRun;
  const { kept, paused } = closed;
  const journal = loopRun.open.journal;
  const opened = openCloseOf(journal, kept !== null, paused);
  // A paused Loop says a dropped ask on Resume (`settledAcrossPause`); a closed one says it here, and forgets it.
  const dropped = !paused && asksPending(journal);
  if (dropped) journal.between = { rewind: null, restart: false };
  const close = dropped ? { ...opened, summary: `${opened.summary} ${MESSAGE.askDropped}` } : opened;
  const notDone = [...(end.notDone ?? [])];
  Object.assign(report, {
    profile: LoopProfile.Open,
    victory: end.victory,
    stoppedBecause: end.because,
    landed: close.landed,
    facets: close.facets,
    summary: notDone.length ? `${close.summary} ${FINISH_REPORT.summaryNotDone(notDone)}` : close.summary,
    savePoints: journal.savePoints.map(({ label, snapshotId }) => ({ label, snapshotId })),
    ...(kept ? { lastCheckpoint: kept } : {}),
    ...(notDone.length ? { notDone } : {}),
    ...leftToFix(loopRun, end, paused),
    ...(state.limit ? { limit: limitRecord(state.limit) } : {}),
    finishedAt: new Date().toISOString(),
  });
  report.notes = [...(report.notes ?? []), ...(loopRun.journal.director.notes ?? [])];
  report.executionStatus = executionStatusOf(report, paused);
}

/** How a close describes the Loop: failed, paused (a Resume picks it up) or completed. */
function executionStatusOf(report: AnyRecord, paused: boolean): ExecutionStatus {
  if (report.failure) return ExecutionStatus.Failed;
  return paused ? ExecutionStatus.Paused : ExecutionStatus.Completed;
}

/** The close's records on the run's thread, written again when the log refuses them; false when it never took them. */
async function appendClose(loopRun: LoopRun, batch: EventData[]): Promise<boolean> {
  const { ctx, threadId } = loopRun;
  for (let attempt = 1; attempt <= CLOSE_APPEND_ATTEMPTS; attempt++) {
    const written = await ctx.call(HostMethod.EventsAppend, { threadId, batch }).then(
      () => true,
      () => false,
    );
    if (written) return true;
    if (attempt < CLOSE_APPEND_ATTEMPTS) await sleep(CLOSE_APPEND_RETRY_MS);
  }
  return false;
}

/** The close on the run's thread (`run_finished`, and `autopilot_paused` for a pause) and in its folder. */
async function announce(loopRun: LoopRun, paused: boolean): Promise<void> {
  const { ctx, report, run } = loopRun;
  const pausedRecord = {
    type: EventKind.Custom,
    event_type: RunEvent.AutopilotPaused,
    payload: { runId: run.runId, project: run.project },
  };
  await appendClose(loopRun, [
    { type: EventKind.Custom, event_type: RunEvent.RunFinished, payload: report },
    ...(paused ? [pausedRecord] : []),
  ]);
  await writeRunArtifact(ctx, run.runId, "report.json", report);
}

/**
 * An attempt that ran no turn adds nothing to the run's worked time in the app, which runs from the
 * run's start record to its close: its close says its worked time ended as it began (`workedUntil`),
 * when the Loop took the project up, on the wall clock the app's records keep.
 */
function workedNothing(loopRun: LoopRun): void {
  const { open, report } = loopRun;
  if (!open) return;
  report.workedUntil = new Date(Date.now() - Math.max(0, open.clock.now() - open.since)).toISOString();
}

/** The close itself, once: workers settled, the last work kept, the report, journal, graph and thread. */
async function closeNow(loopRun: LoopRun, end: OpenEnd): Promise<void> {
  const { ctx, journal, run, state } = loopRun;
  if (state.finished) return;
  await closeRunPool(run.runId);
  // A git write already queued (a worker's merge, the lead's save point) finishes first: the close reads and keeps the folder after it.
  if (loopRun.open) await loopRun.open.gitWrite(async () => {});
  const kept = end.keepNothing ? null : await keepLastWork(loopRun);
  // A Stop or a lost provider with no reviewer's word pauses the Loop: Resume goes on from the folder.
  const paused = end.paused === true || (end.checked !== true && (ctx.cancelled === true || Boolean(state.limit)));
  finishReport(loopRun, end, { kept, paused });
  if (end.unworked) workedNothing(loopRun);
  state.finished = true;
  journal.phase = paused ? JournalPhase.Paused : JournalPhase.Done;
  await loopRun.saveJournal();
  await leadRowAtClose(loopRun, loopRun.open.journal, paused);
  await announce(loopRun, paused);
}

/** Close the open Loop in place (the module's header); a close already under way is joined, never repeated. */
export async function closeInPlace(loopRun: LoopRun, end: OpenEnd): Promise<void> {
  // Through the latch even once the run reads as finished: a close still writing its records is joined.
  await latchClose(loopRun.state, async () => {
    await closeNow(loopRun, end);
    return {};
  });
}
