/**
 * The run before its lead's first turn (`prepareLoopRun`): the run object itself, its report and
 * journal, Genex's snapshot of the game folder before the Loop, the Loop's own record and the run's
 * worker pool. The lead works in the game folder itself, whatever the project is (open/setup.ts):
 * nothing is built for the lead and nothing is asked of the game: the lead decides how to start.
 */
import { HostMethod } from "../host-methods.ts";
import { LoopProfile } from "../folder-facts.ts";
import { EventKind, JournalPhase, RunEvent, RunMode } from "../run-events.ts";
import { createRunInbox } from "../run-inbox.ts";
import { MAX_WORKERS_AT_ONCE } from "../workers/contract.ts";
import { bindLoopRun } from "./loop-run.ts";
import { restoreLoopRun } from "./journal.ts";
import { settleWorkAsk, workedBefore } from "./work-time.ts";
import { newOpenJournal, OPEN_WALL_CLOCK, type OpenClock, type OpenLoop, openJournalOf } from "./open/contract.ts";
import {
  type OpenedGame,
  openGame,
  openLoopOf,
  openLoopPool,
  openStartingPoint,
  recordCreditCap,
  settledAcrossPause,
} from "./open/setup.ts";
import type { AnyRecord, HarnessCtx, Run } from "../../types/harness.d.ts";
import type { ReferenceFrame } from "../../types/host-api.d.ts";
import type { LoopRun, LoopRunData, LoopRunState } from "./loop-run.ts";

/** How a run starts: its thread, the run, whether it resumes, and the Loop's clock. */
export interface LoopStart {
  threadId: string;
  run: Run;
  resume?: boolean;
  /** The Loop's clock (the wake loop's); the wall clock when none is named. */
  clock?: OpenClock;
}

/** The journal a resumed run reads, or null (a journal the host cannot read throws: the run stops on it). */
async function readPriorJournal(
  ctx: HarnessCtx,
  threadId: string,
  run: Run,
  resume: boolean,
): Promise<AnyRecord | null> {
  if (!resume) return null;
  return (await ctx.call(HostMethod.ArtifactRead, { threadId, artifactId: `autopilot_${run.runId}` })) ?? null;
}

/** The record a resumed run's earlier session closed with (its last `run_finished`), or null. */
async function earlierReport(ctx: HarnessCtx, threadId: string, runId: string): Promise<AnyRecord | null> {
  const events = await ctx.call(HostMethod.EventsList, { threadId }).catch(() => []);
  const close = events.findLast(
    (event) => event.data?.event_type === RunEvent.RunFinished && event.data.payload?.runId === runId,
  );
  return close?.data.payload ?? null;
}

/** A list from an earlier record, or none. */
const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? [...value] : []);

/** The report a run leaves behind, as it starts: a resumed run's carries its earlier sessions' notes and verdicts. */
export function loopRunReport(run: Run, earlier: AnyRecord | null = null): AnyRecord {
  const report: AnyRecord = {
    runId: run.runId,
    project: run.project,
    goal: run.goal,
    reference: run.reference?.name ?? "unnamed",
    referenceStills: (run.reference?.frames ?? []).map((f: ReferenceFrame) => f.label),
    mode: RunMode.Director,
    workers: {},
    iterations: [],
    notes: [],
    verdicts: [],
    victory: false,
    stoppedBecause: "",
    landed: false,
  };
  if (!earlier) return report;
  return { ...report, notes: listOf(earlier.notes), verdicts: listOf(earlier.verdicts) };
}

/** A Loop's `run_started` payload: the run, its engines and models (the judge's included, which run activity names), its budgets. */
export function runStartedPayload(run: Run, resume: boolean): AnyRecord {
  return {
    runId: run.runId,
    goal: run.goal,
    project: run.project,
    mode: RunMode.Director,
    ...(run.engine ? { engine: run.engine } : {}),
    ...(run.model ? { model: run.model } : {}),
    ...(run.roles ? { roles: run.roles } : {}),
    ...(run.judgeModel ? { judgeModel: run.judgeModel } : {}),
    ...(run.builderEngine ? { builderEngine: run.builderEngine } : {}),
    ...(run.judgeEngine ? { judgeEngine: run.judgeEngine } : {}),
    ...(resume ? { resumed: true } : {}),
    reference: {
      name: run.reference?.name,
      kind: run.reference?.kind,
      frameCount: run.reference?.frames?.length ?? 0,
      frames: (run.reference?.frames ?? []).map((f) => f.label),
    },
    budgets: run.budgets,
  };
}

/** The run's first cards on its thread: the run started, as a Loop in place whose lead takes the chat. */
async function announceRunStart(ctx: HarnessCtx, threadId: string, run: Run, resume: boolean) {
  const started = runStartedPayload(run, resume);
  const pool = {
    runId: run.runId,
    project: run.project,
    facets: [],
    maxParallel: 1 + MAX_WORKERS_AT_ONCE,
    director: true,
    workerRecords: true,
    ...(resume ? { resumed: true } : {}),
    liveChat: true,
    profile: LoopProfile.Open,
  };
  await ctx.call(HostMethod.EventsAppend, {
    threadId,
    batch: [
      { type: EventKind.Custom, event_type: RunEvent.RunStarted, payload: started },
      { type: EventKind.Custom, event_type: RunEvent.AutopilotStarted, payload: pool },
    ],
  });
}

/** The run's state as it starts: its folder, an empty log. */
function loopRunState(run: Run, threadId: string, projectDir: string, baseCommit: string | null): LoopRunState {
  return { run, threadId, projectDir, baseCommit, limit: null, log: [], finish: null, finished: false, judges: 0 };
}

/** The journal a resume replays: the run, its starting point and the lead's own record. */
function loopRunJournal(run: Run, baseCommit: string | null, prior: AnyRecord | null): AnyRecord {
  return {
    runId: run.runId,
    run: { ...run, reference: { ...(run.reference ?? {}), frames: undefined, stats: undefined } },
    mode: RunMode.Director,
    phase: JournalPhase.Director,
    director: { sessionId: prior?.director?.sessionId ?? null, baseCommit, notes: [] },
  };
}

/** What the run knows once its folder is snapshotted: the lead works in the game folder itself. */
function loopRunData(
  start: { run: Run; threadId: string; priorJournal: AnyRecord | null; inbox: LoopRunData["inbox"] },
  game: OpenedGame,
  facts: { baseCommit: string | null; report: AnyRecord; open: OpenLoop },
): Omit<LoopRunData, "ctx" | "threadId" | "run" | "resume"> {
  const { run, threadId, priorJournal, inbox } = start;
  const { baseCommit, report, open } = facts;
  const { projectDir } = game;
  const journal = loopRunJournal(run, baseCommit, priorJournal);
  journal.director.open = open.journal;
  return {
    inbox,
    priorJournal,
    report,
    projectDir,
    baseCommit,
    gameFacts: game.facts,
    game: { hookEvents: game.hookEvents },
    state: loopRunState(run, threadId, projectDir, baseCommit),
    journal,
    open,
    workedBefore: workedBefore(priorJournal),
    logSeq: 0,
    waitSeq: 0,
    toolCalls: 0,
  };
}

/**
 * Everything a run knows before its first tool call, as one object, its functions put on it
 * (`bindLoopRun`; `modules` are the run's module namespaces): the game as listed, its credit cap on
 * the run's record, Genex's snapshot of the folder before the first turn, the Loop's own record and
 * the run's worker pool.
 */
export async function prepareLoopRun(
  ctx: HarnessCtx,
  start: LoopStart,
  modules: ReadonlyArray<Record<string, unknown>>,
): Promise<LoopRun> {
  const { threadId, run, resume = false, clock = OPEN_WALL_CLOCK } = start;
  const loopRun = bindLoopRun({ ctx, threadId, run, resume }, modules);
  const inbox = ctx.runInbox ?? createRunInbox(ctx, { threadId, runId: run.runId });
  ctx.setStatus(`run ${run.runId} · lead in place`);
  const priorJournal = await readPriorJournal(ctx, threadId, run, resume);
  const game = await openGame(ctx, run);
  recordCreditCap(run);
  // A resume after the person's time ran out goes on with none, unless they named a new one.
  settleWorkAsk(run, workedBefore(priorJournal));
  const report = loopRunReport(run, resume ? await earlierReport(ctx, threadId, run.runId) : null);
  await announceRunStart(ctx, threadId, run, resume);
  const baseCommit = await openStartingPoint(ctx, run, priorJournal);
  const open = openLoopOf(game, openJournalOf(priorJournal) ?? newOpenJournal(), clock);
  Object.assign(loopRun, loopRunData({ run, threadId, priorJournal, inbox }, game, { baseCommit, report, open }));
  restoreLoopRun(loopRun);
  settledAcrossPause(loopRun, open);
  await loopRun.saveJournal();
  await openLoopPool(loopRun, open);
  return loopRun;
}
