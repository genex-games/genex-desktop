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
import { FINISH_REPORT } from "../../finish-check.ts";
import { gitAt } from "../../git.ts";
import { CheckpointSkip, HookEvent, hooksOn, runScope, takeCheckpoint } from "../../hooks.ts";
import { HostMethod } from "../../host-methods.ts";
import { EventKind, ExecutionStatus, JournalPhase, RunEvent, writeRunArtifact } from "../../run-events.ts";
import { CLIP_REASON, clip } from "../../text.ts";
import { SECOND_MS, sleep } from "../../time.ts";
import { TIME_CAP_WORDS } from "../../time-cap-prompts.ts";
import { closeRunPool } from "../../workers/run-pool.ts";
import { latchClose } from "../close-latch.ts";
import type { LoopRun } from "../loop-run.ts";
import { asksPending, newOpenJournal, type OpenJournal } from "./contract.ts";
import { FOLDER_GIT } from "./folder-git.ts";
import { leadRowAtClose, openCloseOf } from "./graph.ts";
import { wentBackUnheard } from "./news.ts";

/** How an open Loop ends: whether the goal was reached, why it ended, and what a reviewer found not done. */
export interface OpenEnd {
  victory: boolean;
  because: string;
  notDone?: readonly string[];
  /** Its time ran out before any claim was checked: the report says no reviewer read one (time-cap.ts). */
  unchecked?: boolean;
  /** A reviewer's check ended it (a yes, or the no's that stop a Loop): never a pause, whatever else holds. */
  checked?: boolean;
  /** The Loop pauses for a Resume whatever else holds (the project's app couldn't be brought back). */
  paused?: boolean;
  /** The Loop closes before it did anything (a paused run it can't pick up): no checkpoint of the folder. */
  keepNothing?: boolean;
  /**
   * No turn of the lead's ran this time (its start was held back or stopped while the plugins prepared
   * it): the journal keeps the working time the Loop came with, so the attempt spends none of its hours.
   */
  unworked?: boolean;
}

/** A close the log refuses is written again, at most this many times this far apart: one never written leaves the run running. */
const CLOSE_APPEND_ATTEMPTS = 3;
const CLOSE_APPEND_RETRY_MS = SECOND_MS;

/** The close's words for the run's feed and its last checkpoint. */
const MESSAGE = {
  loopEnd: "The Loop's end",
  /** A recovery took the folder back to a save point the lead never heard of before the close. */
  wentBack: (label: string) =>
    `The project's app stopped and wouldn't reopen, so Genex took the folder back to save point "${label}" as the Loop closed; the work since it is in the snapshot Genex took before going back.`,
  notKept: (why: string) => `Genex couldn't keep the Loop's last work in a checkpoint: ${why}`,
  notKeptPlain:
    "Genex couldn't keep the Loop's last work in a checkpoint; the files are in the folder as the lead left them.",
  /** A rewind or restart the lead asked for that the Loop's close came before. */
  askDropped: "The rewind or restart the lead asked for last didn't run: the Loop closed first.",
} as const;

/** The open Loop's own journal, or a new one on a run a kept older setup made. */
const journalOf = (loopRun: LoopRun): OpenJournal => loopRun.open?.journal ?? newOpenJournal();

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
  const answer = await (loopRun.open ? loopRun.open.gitWrite(take) : take());
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

/** The report's last fields: how the Loop ended, what it kept, and how it reads on the run's card. */
function finishReport(
  loopRun: LoopRun,
  end: OpenEnd,
  closed: { kept: string | null; paused: boolean; wentBack: string | null },
): void {
  const { report, state } = loopRun;
  const { kept, paused, wentBack } = closed;
  const journal = journalOf(loopRun);
  const opened = openCloseOf(journal, kept !== null, paused);
  // A paused Loop says a dropped ask on Resume (`settledAcrossPause`); a closed one says it here, and forgets it.
  const dropped = !paused && asksPending(journal);
  if (dropped) journal.between = { rewind: null, restart: false };
  const extra = [wentBack ? MESSAGE.wentBack(wentBack) : "", dropped ? MESSAGE.askDropped : ""].filter(Boolean);
  const close = extra.length ? { ...opened, summary: [opened.summary, ...extra].join(" ") } : opened;
  const notDone = end.unchecked ? [TIME_CAP_WORDS.notChecked] : [...(end.notDone ?? [])];
  const notDoneSaid = end.unchecked ? TIME_CAP_WORDS.notChecked : FINISH_REPORT.summaryNotDone(notDone);
  Object.assign(report, {
    profile: LoopProfile.Open,
    victory: end.victory,
    stoppedBecause: end.because,
    landed: close.landed,
    facets: close.facets,
    summary: notDone.length ? `${close.summary} ${notDoneSaid}` : close.summary,
    savePoints: journal.savePoints.map(({ label, snapshotId }) => ({ label, snapshotId })),
    ...(kept ? { lastCheckpoint: kept } : {}),
    ...(notDone.length ? { notDone } : {}),
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

/** How long the Loop had worked when this attempt began: its paused journal's count, or none for a new Loop. */
function workedBefore(loopRun: LoopRun): number {
  const worked = loopRun.resume ? loopRun.priorJournal?.director?.clock?.workedMs : 0;
  return typeof worked === "number" && Number.isFinite(worked) && worked >= 0 ? worked : 0;
}

/**
 * An attempt that ran no turn spends none of the Loop's hours: its clock is set back so the journal
 * counts the working time the Loop came with, and its close says its working time ended as it began
 * (`workedUntil`), so the app's count of the run's working time, which runs from the run's start
 * record to its close, adds none of this attempt either.
 */
function chargeNothing(loopRun: LoopRun): void {
  const { clock, open, report } = loopRun;
  if (!clock || !open) return;
  const before = workedBefore(loopRun);
  // When this attempt began, on the Loop's clock, then on the wall clock the app's records keep.
  const began = clock.started + before;
  report.workedUntil = new Date(Date.now() - Math.max(0, open.clock.now() - began)).toISOString();
  clock.started = open.clock.now() - before;
}

/** The close itself, once: workers settled, the last work kept, the report, journal, graph and thread. */
async function closeNow(loopRun: LoopRun, end: OpenEnd): Promise<void> {
  const { ctx, journal, run, state } = loopRun;
  if (state.finished) return;
  await closeRunPool(run.runId);
  // A way back a recovery already queued finishes first: the close reads, keeps and says the folder after it.
  if (loopRun.open) await loopRun.open.gitWrite(async () => {});
  const wentBack = wentBackUnheard(loopRun);
  if (wentBack) await loopRun.decision(MESSAGE.wentBack(wentBack), MESSAGE.wentBack(wentBack)).catch(() => {});
  // Over a folder just taken back there is none of the lead's work left to keep.
  const kept = end.keepNothing || wentBack ? null : await keepLastWork(loopRun);
  // A Stop or a lost provider with no reviewer's word pauses the Loop: Resume goes on from the folder.
  const paused = end.paused === true || (end.checked !== true && (ctx.cancelled === true || Boolean(state.limit)));
  finishReport(loopRun, end, { kept, paused, wentBack });
  if (end.unworked) chargeNothing(loopRun);
  state.finished = true;
  journal.phase = paused ? JournalPhase.Paused : JournalPhase.Done;
  await loopRun.saveJournal();
  await leadRowAtClose(loopRun, journalOf(loopRun), paused);
  // Before the close is written: once it is, the run is over for the host and the lead's call with it.
  await dropTurnReads(loopRun);
  await announce(loopRun, paused);
}

/** The run's reads of the folder leave nothing in the game's git once the Loop is over (`FOLDER_GIT.dropTurnStore`). */
async function dropTurnReads(loopRun: LoopRun): Promise<void> {
  const { ctx, run } = loopRun;
  const label = `open:${run.runId}:turn-store`;
  await gitAt(ctx, { project: run.project }, FOLDER_GIT.dropTurnStore(run.runId), { label }).catch(() => {});
}

/**
 * A resumed run the open Loop can't pick up, closed before anything of it runs: its start and its
 * close on the run's thread, paused for a Resume (another kind of Loop's journal) or for good (one no
 * version reads), with the person's words. Its journal and its earlier report are left as they were.
 */
export async function refuseResume(loopRun: LoopRun, because: string, paused: boolean): Promise<void> {
  const { report, run, state } = loopRun;
  if (state.finished) return;
  state.finished = true;
  Object.assign(report, {
    profile: LoopProfile.Open,
    victory: false,
    landed: false,
    stoppedBecause: because,
    finishedAt: new Date().toISOString(),
    executionStatus: paused ? ExecutionStatus.Paused : ExecutionStatus.Completed,
    ...(paused ? { paused: true } : {}),
  });
  const started = { runId: run.runId, goal: run.goal, project: run.project, budgets: run.budgets, resumed: true };
  const pausedRecord = { runId: run.runId, project: run.project };
  await appendClose(loopRun, [
    { type: EventKind.Custom, event_type: RunEvent.RunStarted, payload: started },
    { type: EventKind.Custom, event_type: RunEvent.RunFinished, payload: report },
    ...(paused ? [{ type: EventKind.Custom, event_type: RunEvent.AutopilotPaused, payload: pausedRecord }] : []),
  ]);
}

/** Close the open Loop in place (the module's header); a close already under way is joined, never repeated. */
export async function closeInPlace(loopRun: LoopRun, end: OpenEnd): Promise<void> {
  // Through the latch even once the run reads as finished: a close still writing its records is joined.
  await latchClose(loopRun.state, async () => {
    await closeNow(loopRun, end);
    return {};
  });
}
