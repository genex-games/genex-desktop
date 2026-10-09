/**
 * A finished build reopened, as the run reads it. After a build whose run seated a lead has
 * finished, a message with Loop on that asks for more reopens the SAME run (the chat's side is
 * loop/reopen-run.ts): the chat rewrites the run's journal (`reopenedJournal`) and starts the run
 * again as a resume. The rewrite drops what a new run starts afresh — its clock, so it works the
 * Loop's new budget; its wake state, so it is not wrapped up for having been asked what next; the
 * last health pass, taken on a head it may no longer stand on; its verified checkpoints and progress
 * review — records its required outcomes as waiting for the lead's plan for the ask (`goals: null`),
 * and marks the journal (`director.reopened`). A kept older setup.ts, journal.ts or wake.ts from
 * before outcomes were kept reads those fields as a new run's.
 *
 * The run reads the mark for where it forks (`reopenCommits`, setup.ts) and for its words: the
 * first digest's heading, the resume note, and the workers "of the finished build" rather than
 * "from before the pause" (reopen-prompts.ts). Its functions take plain facts or the run; they
 * are not bound onto it. It imports only names every older seed exported
 * (tests/fixtures/seed-exports-pre-reopen.json).
 */
import { isAncestor } from "../git.ts";
import { isCommit } from "../shell.ts";
import { REOPEN_ERA } from "./reopen-prompts.ts";
import type { AnyRecord, HarnessCtx } from "../../types/harness.d.ts";
import type { PriorEra } from "./journal-prompts.ts";
import type { LoopRun } from "./loop-run.ts";

/** A reopen as the journal keeps it: when, and the head the finished build stood on (the log's close). */
export interface ReopenMark {
  at: string;
  finishedHead: string | null;
}

/**
 * A finished run's journal reopened: `run` in place of the saved one (the Loop's new budgets), no
 * clock (a fresh budget), no wake state, no last health pass; the head the log's close names (a
 * rewound reopen left a withdrawn one on the journal), and the mark. Its required outcomes are the
 * new commission's to set (`goals: null`, which journal.ts reads as waiting for the lead's plan for
 * the ask, never as the old plan's parts), and its checkpoints and progress review are earned anew:
 * the finished run's verified outcomes would tell the lead to finish, or refuse every worker for
 * the ask. So is the art director's word: its review judged the finished build for the old ask, and
 * the finish it turned back once (`shipFinishRefused`) was the old commission's, not the new one's.
 * Everything else — the plan, the workers, the defects nobody owns, the log — goes on.
 */
export function reopenedJournal(journal: AnyRecord, run: AnyRecord, mark: ReopenMark): AnyRecord {
  const {
    clock: _spent,
    wake: _asked,
    integrationHealthy: _lastPass,
    firstVerifiedCheckpoint: _first,
    latestVerifiedCheckpoint: _latest,
    softReviewAt: _reviewed,
    shipFinishRefused: _turnedBack,
    lastShip: _shipReview,
    ...director
  } = journal.director ?? {};
  const integrationHead = mark.finishedHead ?? director.integrationHead ?? null;
  return { ...journal, run, director: { ...director, goals: null, integrationHead, reopened: mark } };
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

/** How the workers of the run before are spoken of: of the finished build when reopened, else (the default) before a pause. */
export function priorEra(loopRun: Pick<LoopRun, "resume" | "priorJournal">): PriorEra | undefined {
  return isReopened(loopRun) ? REOPEN_ERA : undefined;
}

/**
 * A reopened run's required outcomes are its lead's plan for the ask (`goals: null`): outcomes a
 * kept journal.ts from before that rule rebuilt from the finished plan's parts are set aside. A run
 * that is not a reopen, or a Resume of one that planned, keeps what it restored.
 */
export function outcomesAwaitPlan(loopRun: Pick<LoopRun, "resume" | "priorJournal" | "state">): void {
  if (isReopened(loopRun) && loopRun.priorJournal?.director?.goals === null) loopRun.state.goals = undefined;
}
