/**
 * A finished build reopened, as the run reads it. After a build has finished, a message with Loop on
 * that asks for more reopens the SAME run (the chat's side is loop/reopen-run.ts): the chat rewrites
 * the run's journal (`reopenedJournal`) and starts the run again as a resume, with a fresh clock, no
 * wake state and no last health check. The run reads the mark for where it forks (`reopenCommits`,
 * setup.ts) and for its resume note. Its functions take plain facts or the run; they are not bound.
 */
import { isAncestor } from "../git.ts";
import { isCommit } from "../shell.ts";
import type { AnyRecord, HarnessCtx } from "../../types/harness.d.ts";
import type { LoopRun } from "./loop-run.ts";

/** A reopen as the journal keeps it: when, and the head the finished build stood on (the log's close). */
export interface ReopenMark {
  at: string;
  finishedHead: string | null;
}

/**
 * A finished run's journal reopened: `run` in place of the saved one (the Loop's new budgets), no clock
 * (a fresh budget), no wake state, no last health check, no reviewer's no's; the head the log's close
 * names, and the mark. Everything else — the log, the notes — goes on.
 */
export function reopenedJournal(journal: AnyRecord, run: AnyRecord, mark: ReopenMark): AnyRecord {
  const {
    clock: _spent,
    wake: _asked,
    integrationHealthy: _lastCheck,
    ...director
  } = journal.director ?? {};
  const integrationHead = mark.finishedHead ?? director.integrationHead ?? null;
  const finishTally = freshTally(director.finishTally);
  const counted = finishTally ? { finishTally } : {};
  return { ...journal, run, director: { ...director, ...counted, integrationHead, reopened: mark } };
}

/** A finished run's finish checks for a new ask: no no's, no reasons, the round number kept; none when there was none. */
function freshTally(saved: unknown): AnyRecord | null {
  if (!saved || typeof saved !== "object") return null;
  const round = Number((saved as AnyRecord).round);
  return { round: Number.isSafeInteger(round) && round > 0 ? round : 0, rejections: 0, checking: false, reasons: [] };
}

/** The reopen this journal starts a run from, or null (a new run, a paused one resumed). */
export function reopenMarkOf(priorJournal: AnyRecord | null | undefined): ReopenMark | null {
  const mark = priorJournal?.director?.reopened;
  if (!mark || typeof mark.at !== "string") return null;
  return { at: mark.at, finishedHead: isCommit(mark.finishedHead) ? mark.finishedHead : null };
}

/** Is this run a finished build reopened: resumed from a journal the chat marked? */
export function isReopened(loopRun: Pick<LoopRun, "resume" | "priorJournal">): boolean {
  return loopRun.resume === true && reopenMarkOf(loopRun.priorJournal) !== null;
}

/**
 * Where a reopened run stands. The game folder as it is now (`liveHead`: the start's snapshot
 * took in every change since, uncommitted ones too) is its start either way. It forks there when
 * the finished build is in it — landed, then maybe changed by the chat since — and from the
 * finished build itself when it is not (not landed, the folder reset, or git cannot tell), which
 * its close then lands over the folder.
 */
export async function reopenCommits(
  ctx: HarnessCtx,
  {
    project,
    runId,
    finishedHead,
    liveHead,
  }: { project: string; runId: string; finishedHead: string | null; liveHead: string },
): Promise<{ baseCommit: string; forkCommit: string }> {
  if (!isCommit(finishedHead)) return { baseCommit: liveHead, forkCommit: liveHead };
  const inFolder = await isAncestor(ctx, { project }, finishedHead, { label: `director:${runId}:reopen` });
  return { baseCommit: liveHead, forkCommit: inFolder ? liveHead : finishedHead };
}

