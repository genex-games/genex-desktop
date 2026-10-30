/**
 * The run before its lead's first turn (`prepareLoopRun`): the run object itself, its clock, its
 * report and journal, and where the lead builds. A web game's Loop forks an integration worktree from
 * the game folder as it stands (a snapshot first), and opens the run's worker pool on it: a copy
 * worker forks from the integration head and its work merges back there. A Loop on any other project
 * works in the project's own folder (open/setup.ts). Nothing is built for the lead and nothing is
 * asked of the game: the lead decides how to start.
 */
import { DEFAULT_WALL_CLOCK_MS } from "../config.ts";
import { commitAll, gitAt, GIT, headOf } from "../git.ts";
import { HostMethod } from "../host-methods.ts";
import { factsOfGame, LoopProfile, ProjectStarter } from "../folder-facts.ts";
import { modelOn, RoleKey, roleEffort, roleEngine } from "../model-roles.ts";
import { runRef } from "../repo.ts";
import { EventKind, JournalPhase, RunEvent, RunMode } from "../run-events.ts";
import { createRunInbox } from "../run-inbox.ts";
import { isCommit } from "../shell.ts";
import { capClock, capHoursMs } from "../time-cap.ts";
import { MAX_WORKERS_AT_ONCE, WorkerIsolation } from "../workers/contract.ts";
import { folderLabelOf } from "../workers/identity.ts";
import { RUN_POOL_WORDS } from "../workers/prompts.ts";
import { REAL_CLOCK } from "../workers/records.ts";
import { type RunPoolSeat, runPool } from "../workers/run-pool.ts";
import { tellIfRefused } from "../workers/sandbox-refusal.ts";
import { bindLoopRun, BuildTarget } from "./loop-run.ts";
import { restoreLoopRun } from "./journal.ts";
import { closeUnderWay } from "./close-latch.ts";
import { reopenCommits, reopenMarkOf } from "./reopen.ts";
import { NoteKind } from "./wake-schedule.ts";
import { newOpenJournal, OPEN_WALL_CLOCK, type OpenClock, openJournalOf } from "./open/contract.ts";
import { resumedOpenJournal } from "./open/older-journal.ts";
import {
  type OpenedGame,
  openGame,
  openLoopOf,
  openLoopPool,
  openRunMs,
  openStartingPoint,
  recordCreditCap,
  settledAcrossPause,
} from "./open/setup.ts";
import type { AnyRecord, HarnessCtx, Run } from "../../types/harness.d.ts";
import type { ReferenceFrame } from "../../types/host-api.d.ts";
import type { LoopRun, LoopRunData, LoopRunState } from "./loop-run.ts";

/** This part serves a lead that is its chat's own session (lead-session.ts `servesLead`). */
export const SERVES_LEAD = true;
/** This part prepares a Loop on a project of any kind: a run reads it by namespace before it leads one. */
export const SERVES_OPEN_LOOP = true;

/** Why a web Loop's worker may not write in the game folder itself: the lead's build is its integration worktree. */
const LOCK_REFUSED =
  "Not started: in this Loop the build is the integration worktree, so a writer works in a copy (isolation copy) and you merge it with worker_mark.";

/** How a run starts: its thread, the run, whether it resumes, whether its lead takes the chat, its profile and an open Loop's clock. */
export interface LoopStart {
  threadId: string;
  run: Run;
  resume?: boolean;
  liveChat?: boolean;
  /** How the Loop works on its project: a web game's (the default), or in place (`LoopProfile.Open`). */
  profile?: LoopProfile;
  /** An open Loop's clock (the wake loop's); a web run reads the wall clock. */
  clock?: OpenClock;
}

/** The journal a resumed run reads, or null (a journal the host cannot read throws: the run stops on it). */
async function readPriorJournal(ctx: HarnessCtx, threadId: string, run: Run, resume: boolean): Promise<AnyRecord | null> {
  if (!resume) return null;
  return (await ctx.call(HostMethod.ArtifactRead, { threadId, artifactId: `autopilot_${run.runId}` })) ?? null;
}

/** The record a resumed or reopened run's earlier session closed with (its last `run_finished`), or null. */
async function earlierReport(ctx: HarnessCtx, threadId: string, runId: string): Promise<AnyRecord | null> {
  const events = await ctx.call(HostMethod.EventsList, { threadId }).catch(() => []);
  const close = events.findLast(
    (event) => event.data?.event_type === RunEvent.RunFinished && event.data.payload?.runId === runId,
  );
  return close?.data.payload ?? null;
}

/** A list from an earlier record, or none. */
const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? [...value] : []);

/** The report a run leaves behind, as it starts: a resumed or reopened run's carries its earlier sessions' notes and verdicts. */
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
    integrationHead: null,
  };
  if (!earlier) return report;
  return { ...report, notes: listOf(earlier.notes), verdicts: listOf(earlier.verdicts) };
}

/** The run's first cards on its thread: the run started, as a Loop's. */
async function announceRunStart(
  ctx: HarnessCtx,
  threadId: string,
  run: Run,
  start: { resume: boolean; liveChat: boolean; profile?: LoopProfile },
) {
  const { resume, liveChat, profile } = start;
  const started = {
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
  const pool = {
    runId: run.runId,
    project: run.project,
    facets: [],
    integrationNotes: "",
    maxParallel: 1 + MAX_WORKERS_AT_ONCE,
    director: true,
    workerRecords: true,
    ...(resume ? { resumed: true } : {}),
    ...(liveChat ? { liveChat: true } : {}),
    ...(profile ? { profile } : {}),
  };
  await ctx.call(HostMethod.EventsAppend, {
    threadId,
    batch: [
      { type: EventKind.Custom, event_type: RunEvent.RunStarted, payload: started },
      { type: EventKind.Custom, event_type: RunEvent.AutopilotStarted, payload: pool },
    ],
  });
}

/** The game, ready: scaffolded if new, loaded in the studio window. Answers its folder, and keeps what it holds on the run. */
async function readyTheGame(loopRun: LoopRun): Promise<string> {
  const { ctx, run } = loopRun;
  await ctx.call(HostMethod.GameScaffold, { name: run.project, title: run.project, kind: ProjectStarter.Web });
  await ctx.call(HostMethod.PreviewLoad, { project: run.project }).catch(() => {});
  const games = await ctx.call(HostMethod.GameList, {}).catch(() => []);
  const game = games.find((g: AnyRecord) => g.name === run.project);
  const projectDir = game?.dir ?? null;
  if (!projectDir) throw new Error(`project ${run.project} has no folder`);
  loopRun.gameFacts = factsOfGame(game);
  loopRun.game = { hookEvents: game?.hookEvents };
  return projectDir;
}

/**
 * Where the run stands in the game's history: the starting point the user had (a snapshot of the
 * folder) and, on a resume, where this session picks the branch up. A finished build reopened starts
 * from the folder as it is now (director/reopen.ts).
 */
async function startingCommits(ctx: HarnessCtx, run: Run, priorJournal: AnyRecord | null) {
  const incumbent = await ctx.call(HostMethod.SnapshotCreate, {
    scope: "game",
    reason: `run ${run.runId}: starting point`,
    project: run.project,
  });
  const live = incumbent?.git?.game ?? null;
  const reopened = reopenMarkOf(priorJournal);
  if (reopened && isCommit(live)) {
    const facts = { project: run.project, runId: run.runId, finishedHead: reopened.finishedHead, liveHead: live };
    return reopenCommits(ctx, facts);
  }
  const baseCommit = priorJournal?.director?.baseCommit ?? priorJournal?.director?.integrationHead ?? live;
  const forkCommit = priorJournal?.director?.integrationHead ?? baseCommit;
  return { baseCommit, forkCommit };
}

/** The integration worktree, forked from where the run stands, its head kept on the run's ref. */
async function openIntegration(loopRun: LoopRun, forkCommit: string | null): Promise<string> {
  const { ctx, run } = loopRun;
  const wt = await ctx.call(HostMethod.SnapshotWorktree, {
    project: run.project,
    ...(forkCommit ? { commit: forkCommit } : {}),
    name: BuildTarget.Integration,
    runId: run.runId,
  });
  loopRun.integrationRef = runRef(run.runId, BuildTarget.Integration);
  await loopRun.protectHead(forkCommit);
  return wt.path;
}

/** The run's state as it starts: where the lead builds, the heads, an empty log. */
function loopRunState(
  facts: Pick<LoopRunState, "run" | "threadId" | "projectDir" | "baseCommit" | "integrationWorktree"> & {
    forkCommit: string | null;
    softDeadline: number;
    finalDeadline: number;
  },
): LoopRunState {
  return {
    run: facts.run,
    threadId: facts.threadId,
    projectDir: facts.projectDir,
    baseCommit: facts.baseCommit,
    integrationWorktree: facts.integrationWorktree,
    integrationHead: facts.forkCommit,
    healthByHead: new Map(),
    integrationHealthy: null,
    limit: null,
    log: [],
    finish: null,
    finished: false,
    judges: 0,
    softDeadline: facts.softDeadline,
    finalDeadline: facts.finalDeadline,
  };
}

/** The journal a resume replays: the run, its starting point and the lead's own record. */
function loopRunJournal(run: Run, baseCommit: string | null, forkCommit: string | null, prior: AnyRecord | null) {
  return {
    runId: run.runId,
    run: { ...run, reference: { ...(run.reference ?? {}), frames: undefined, stats: undefined } },
    mode: RunMode.Director,
    phase: JournalPhase.Director,
    director: {
      sessionId: prior?.director?.sessionId ?? null,
      baseCommit,
      integrationHead: forkCommit,
      notes: [],
      ...(prior?.director?.reopened ? { reopened: prior.director.reopened } : {}),
    },
  };
}

/** The counters every run starts with. */
const loopRunCounters = () => ({ logSeq: 0, waitSeq: 0, toolCalls: 0 });

/**
 * Everything a run knows before its first tool call, as one object, its functions put on it
 * (`bindLoopRun`). `modules` are the run's module namespaces.
 */
export async function prepareLoopRun(
  ctx: HarnessCtx,
  start: LoopStart,
  modules: ReadonlyArray<Record<string, unknown>>,
): Promise<LoopRun> {
  const { threadId, run, resume = false, liveChat = false, profile = LoopProfile.Web } = start;
  if (profile === LoopProfile.Open)
    return prepareOpenLoopRun(ctx, { threadId, run, resume, liveChat, clock: start.clock ?? OPEN_WALL_CLOCK }, modules);
  const loopRun = bindLoopRun({ ctx, threadId, run, resume }, modules);
  const inbox = ctx.runInbox ?? createRunInbox(ctx, { threadId, runId: run.runId });
  ctx.setStatus(`run ${run.runId} · lead`);
  const priorJournal = await readPriorJournal(ctx, threadId, run, resume);
  // A Resume goes on with the working time the run had left; the hours are a soft cap (time-cap.ts).
  const clock = capClock({
    saved: resume ? priorJournal?.director?.clock : null,
    now: Date.now(),
    totalMs: capHoursMs(run, run.budgets?.wallClockMs ?? DEFAULT_WALL_CLOCK_MS),
  });
  const report = loopRunReport(run, resume ? await earlierReport(ctx, threadId, run.runId) : null);
  await announceRunStart(ctx, threadId, run, { resume, liveChat });
  const projectDir = await readyTheGame(loopRun);
  const { baseCommit, forkCommit } = await startingCommits(ctx, run, priorJournal);
  const integrationWorktree = await openIntegration(loopRun, forkCommit);
  const known = {
    inbox,
    started: clock.started,
    softDeadline: clock.softDeadline,
    finalDeadline: clock.finalDeadline,
    clock,
    priorJournal,
    report,
    projectDir,
    baseCommit,
    forkCommit,
    integrationWorktree,
    state: loopRunState({
      run,
      threadId,
      projectDir,
      baseCommit,
      integrationWorktree,
      forkCommit,
      softDeadline: clock.softDeadline,
      finalDeadline: clock.finalDeadline,
    }),
    journal: loopRunJournal(run, baseCommit, forkCommit, priorJournal),
    profile: LoopProfile.Web,
    ...loopRunCounters(),
  } satisfies Omit<LoopRunData, "ctx" | "threadId" | "run" | "resume" | "integrationRef">;
  Object.assign(loopRun, known);
  restoreLoopRun(loopRun);
  await loopRun.saveJournal();
  loopRun.pool = await runPool(webPoolSeat(loopRun));
  return loopRun;
}

/**
 * Commit what the lead left in the integration worktree, and answer the head a copy forks from: a
 * worker starts from the lead's work so far.
 */
async function forkPoint(loopRun: LoopRun): Promise<string | null> {
  const { ctx, integrationWorktree, run } = loopRun;
  const dirty = await gitAt(ctx, integrationWorktree, GIT.status).catch(() => "");
  if (dirty) await commitAll(ctx, integrationWorktree, `lead ${run.runId}: work so far`).catch(() => "");
  const head = await headOf(ctx, integrationWorktree).catch(() => null);
  if (isCommit(head)) {
    loopRun.state.integrationHead = head;
    await loopRun.protectHead(head);
  }
  return head;
}

/** Why a merge into the integration worktree is refused now (the run closing, closed or stopped), or null. */
function mergeRefusedNow(loopRun: LoopRun): string | null {
  const { ctx, state } = loopRun;
  const over = state.finished || Boolean(state.finish) || closeUnderWay(state) || ctx.cancelled === true;
  return over ? "The Loop is ending; nothing more is merged. End your turn." : null;
}

/** The run's pool as a web Loop's workers use it: the Workers role, copies forked from and merged into the integration worktree. */
function webPoolSeat(loopRun: LoopRun): RunPoolSeat {
  const { ctx, integrationWorktree, run, threadId } = loopRun;
  const engine = roleEngine(run, RoleKey.Builder);
  const model = modelOn(run, engine);
  const effort = roleEffort(run, RoleKey.Builder);
  return {
    ctx,
    project: run.project,
    threadId,
    runId: run.runId,
    engine,
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    gameDir: integrationWorktree,
    game: { hookEvents: loopRun.game?.hookEvents ?? [] },
    leadFolder: integrationWorktree,
    identity: {
      folderLabel: folderLabelOf(loopRun.projectDir, run.project),
      facts: loopRun.gameFacts ?? [],
    },
    clock: REAL_CLOCK,
    forkFrom: () => forkPoint(loopRun),
    refusesIsolation: (isolation) => (isolation === WorkerIsolation.Lock ? LOCK_REFUSED : null),
    mergeRefused: () => mergeRefusedNow(loopRun),
    // The merged build's one health check is said with the merge.
    afterMerge: (record) => loopRun.afterMerge(record),
    onEnded: (record) => {
      loopRun.note(RUN_POOL_WORDS.ended(record.id, record.title, record.state), NoteKind.WorkerEnded);
      tellIfRefused(loopRun, engine, record.stopCode);
    },
  };
}

/** What an open Loop's run knows once its folder is snapshotted: the lead works in the game folder itself. */
function openLoopRunData(
  start: { run: Run; threadId: string; priorJournal: AnyRecord | null; inbox: LoopRunData["inbox"] },
  game: OpenedGame,
  baseCommit: string | null,
  clock: { started: number; softDeadline: number; finalDeadline: number },
  report: AnyRecord,
): Omit<LoopRunData, "ctx" | "threadId" | "run" | "resume"> {
  const { run, threadId, priorJournal, inbox } = start;
  const { projectDir } = game;
  return {
    inbox,
    started: clock.started,
    softDeadline: clock.softDeadline,
    finalDeadline: clock.finalDeadline,
    clock,
    priorJournal,
    report,
    projectDir,
    baseCommit,
    forkCommit: null,
    integrationWorktree: projectDir,
    integrationRef: "",
    state: loopRunState({
      run,
      threadId,
      projectDir,
      baseCommit,
      integrationWorktree: projectDir,
      forkCommit: null,
      softDeadline: clock.softDeadline,
      finalDeadline: clock.finalDeadline,
    }),
    journal: loopRunJournal(run, baseCommit, null, priorJournal),
    ...loopRunCounters(),
  };
}

/**
 * The run of an open Loop (a project that isn't a web game): the game as listed, its hours and
 * credit cap on the run's record, Genex's snapshot of the folder before the first turn, the Loop's
 * own record and the run's worker pool. The lead works in place.
 */
async function prepareOpenLoopRun(
  ctx: HarnessCtx,
  start: { threadId: string; run: Run; resume: boolean; liveChat: boolean; clock: OpenClock },
  modules: ReadonlyArray<Record<string, unknown>>,
): Promise<LoopRun> {
  const { threadId, run, resume, liveChat, clock } = start;
  const loopRun = bindLoopRun({ ctx, threadId, run, resume }, modules);
  const inbox = ctx.runInbox ?? createRunInbox(ctx, { threadId, runId: run.runId });
  ctx.setStatus(`run ${run.runId} · lead in place`);
  const read = await readPriorJournal(ctx, threadId, run, resume);
  // A run the Unreal runner paused goes on from its journal, turned into the one Loop's (older-journal.ts).
  const resumed = resumedOpenJournal(read, clock.now());
  const { prior: priorJournal, refused, spentBefore } = resumed;
  const saved = resume ? priorJournal?.director?.clock : null;
  const runClock = capClock({ saved, now: clock.now(), totalMs: openRunMs(run) });
  const game = await openGame(ctx, run);
  if (!refused) recordCreditCap(run, spentBefore);
  const report = loopRunReport(run, resume ? await earlierReport(ctx, threadId, run.runId) : null);
  if (!refused) await announceRunStart(ctx, threadId, run, { resume, liveChat, profile: LoopProfile.Open });
  const baseCommit = refused ? null : await openStartingPoint(ctx, run, priorJournal);
  Object.assign(loopRun, openLoopRunData({ run, threadId, priorJournal, inbox }, game, baseCommit, runClock, report));
  loopRun.gameFacts = game.facts;
  loopRun.game = { hookEvents: game.hookEvents };
  const journal = openJournalOf(priorJournal);
  const open = openLoopOf(game, journal ? settledAcrossPause(journal) : newOpenJournal(), clock);
  loopRun.journal.director.open = open.journal;
  loopRun.profile = LoopProfile.Open;
  loopRun.open = open;
  restoreLoopRun(loopRun);
  if (refused) {
    open.refused = refused;
    open.refusalPauses = resumed.staysPaused === true;
    return loopRun;
  }
  await loopRun.saveJournal();
  await openLoopPool(loopRun, open);
  return loopRun;
}
