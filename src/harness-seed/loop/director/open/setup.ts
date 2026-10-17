/**
 * The open Loop's first steps, which the director's setup (`../setup.ts` `prepareLoopRun`) takes in
 * place of the web method's: the game as Genex lists it (its folder, its facts, the moments its
 * plugins hook), the run's time and credit cap on its own record, Genex's snapshot of the folder
 * before the Loop, the Loop's own record on the run, and the run's worker pool. No scaffold, no
 * contract, no preview, no copy of the game for the lead: it works in the game folder itself.
 */
import type { AnyRecord, HarnessCtx, Run } from "../../../types/harness.d.ts";
import { DEFAULT_WALL_CLOCK_MS, MAX_RUN_HOURS } from "../../config.ts";
import { editorPlayOf, type LoopGame } from "../../engine-judges.ts";
import { type FactRef, factsOfGame, type FolderHolds } from "../../folder-facts.ts";
import { HostMethod } from "../../host-methods.ts";
import { modelOn, RoleKey, roleEffort, roleEngine } from "../../model-roles.ts";
import { HOUR_MS } from "../../time.ts";
import { UNTIL_DONE_CAP_MS } from "../../time-cap.ts";
import { folderLabelOf } from "../../workers/identity.ts";
import { RUN_POOL_WORDS } from "../../workers/prompts.ts";
import { type RunPoolSeat, runPool } from "../../workers/run-pool.ts";
import type { LoopRun } from "../loop-run.ts";
import { NoteKind } from "../wake-schedule.ts";
import { closeUnderWay } from "../close-latch.ts";
import { OPEN_NEWS, OPEN_WORDS } from "./prompts.ts";
import {
  creditCapOf,
  DEFAULT_CREDIT_CAP,
  gitQueue,
  type OpenClock,
  type OpenJournal,
  type OpenLoop,
} from "./contract.ts";

/**
 * The game as an open Loop starts on it: its folder, what it holds, the moments its plugins hook, and
 * whether the studio plays it in its engine's editor, with the judges that play it there.
 */
export interface OpenedGame extends Pick<LoopGame, "editorPlay" | "judges"> {
  projectDir: string;
  facts: FactRef[];
  holds: FolderHolds | null;
  hookEvents: string[];
}

/** The game as `game.list` lists it; a game with no folder throws, as a web run's does. */
export async function openGame(ctx: HarnessCtx, run: Run): Promise<OpenedGame> {
  const games = await ctx.call(HostMethod.GameList, {}).catch(() => []);
  const game = (Array.isArray(games) ? games : []).find((g: AnyRecord) => g?.name === run.project) ?? null;
  const projectDir = typeof game?.dir === "string" ? game.dir : null;
  if (!projectDir) throw new Error(`project ${run.project} has no folder`);
  return {
    projectDir,
    facts: factsOfGame(game),
    holds: typeof game?.holds === "string" ? (game.holds as FolderHolds) : null,
    hookEvents: Array.isArray(game?.hookEvents) ? game.hookEvents.map(String) : [],
    ...editorPlayOf(game),
  };
}

/** An open Loop's hours: its record's, held to the most a Loop runs; ∞ runs until its finish, `UNTIL_DONE_CAP_MS` at most. */
export function openRunMs(run: Run): number {
  if (run.budgets?.untilSatisfied === true) return UNTIL_DONE_CAP_MS;
  const asked = run.budgets?.wallClockMs;
  const total = typeof asked === "number" && asked > 0 ? asked : DEFAULT_WALL_CLOCK_MS;
  return Math.min(total, MAX_RUN_HOURS * HOUR_MS);
}

/**
 * The run's credit cap on its own record: its own whole number, or the default where it names none
 * (or none Genex can read), less what an earlier runner's jobs already spent (`spentBefore`, once:
 * the lowered cap is the record's from then on).
 */
export function recordCreditCap(run: Run, spentBefore = 0): void {
  const cap = creditCapOf(run) ?? DEFAULT_CREDIT_CAP;
  run.budgets = { ...run.budgets, creditCap: Math.max(0, cap - spentBefore) };
}

/**
 * A resumed open Loop's journal with what its lead asked for before the pause settled: a rewind or a
 * restart its last turn's end never ran (a Stop came first) is not run now over the next turn's
 * work, and the lead hears so in its first message.
 */
export function settledAcrossPause(journal: OpenJournal): OpenJournal {
  const { rewind, restart } = journal.between;
  const carried = [
    ...(rewind ? [OPEN_NEWS.rewindDropped(rewind.label)] : []),
    ...(restart ? [OPEN_NEWS.restartDropped] : []),
  ];
  return { ...journal, between: { rewind: null, restart: false }, carried: [...journal.carried, ...carried] };
}

/**
 * Genex's snapshot of the game folder before the Loop's first turn, whatever the folder holds: what
 * the run started from (a resumed run keeps the one its journal names).
 */
export async function openStartingPoint(
  ctx: HarnessCtx,
  run: Run,
  priorJournal: AnyRecord | null,
): Promise<string | null> {
  const snapshot = await ctx.call(HostMethod.SnapshotCreate, {
    scope: "game",
    reason: `run ${run.runId}: before the Loop`,
    project: run.project,
  });
  const taken = typeof snapshot?.git?.game === "string" ? snapshot.git.game : null;
  const kept = priorJournal?.director?.baseCommit;
  return typeof kept === "string" ? kept : taken;
}

/** What the run carries for its open Loop, before its pool opens. */
export function openLoopOf(game: OpenedGame, journal: OpenJournal, clock: OpenClock): OpenLoop {
  return {
    facts: game.facts,
    holds: game.holds,
    hookEvents: game.hookEvents,
    journal,
    halted: null,
    refused: null,
    refusalPauses: false,
    turnSavedFrom: journal.savePoints.length,
    turnWorked: false,
    turnMark: null,
    turnMarkAt: null,
    turnStart: null,
    unclearStreak: 0,
    folderOnlyStreak: 0,
    sessionActed: false,
    sessionWorked: false,
    treeUnread: false,
    betweenTurns: false,
    askPending: false,
    claimTurnedDown: false,
    gitWrite: gitQueue(),
    clock,
    pool: null,
    jobsRunning: 0,
    jobsReadAt: null,
    writerJobsRunning: 0,
    writerJobEndSeq: 0,
    leftoverJobs: [],
    since: clock.now(),
    heard: new Set(),
    asked: new Set(),
    healthAt: clock.now(),
    inTurn: false,
    recovering: null,
    recoveries: 0,
    restores: 0,
    wentBack: null,
    wentBackSeq: null,
    healthLook: null,
    remindedTurn: null,
    freshEyesAt: null,
  };
}

/** Why a worker's merge into the game folder is refused now (the Loop paused, closing, closed or stopped), or null. */
function mergeRefusedNow(loopRun: LoopRun): string | null {
  const { ctx, open, state } = loopRun;
  if (open?.halted) return OPEN_WORDS.paused;
  const over = state.finished || Boolean(state.finish) || closeUnderWay(state) || ctx.cancelled === true;
  return over ? OPEN_WORDS.ending : null;
}

/** The run's pool as an open Loop's workers use it: the Workers role, the game folder, the run's grant and cap. */
function poolSeat(loopRun: LoopRun, open: OpenLoop): RunPoolSeat {
  const { ctx, projectDir, run, threadId } = loopRun;
  const engine = roleEngine(run, RoleKey.Builder);
  const model = modelOn(run, engine);
  const effort = roleEffort(run, RoleKey.Builder);
  const cap = creditCapOf(run);
  return {
    ctx,
    project: run.project,
    threadId,
    runId: run.runId,
    engine,
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(cap === null ? {} : { creditCap: cap }),
    gameDir: projectDir,
    game: { hookEvents: open.hookEvents },
    leadFolder: { project: run.project },
    identity: { folderLabel: folderLabelOf(projectDir, run.project), facts: open.facts, holds: open.holds },
    clock: open.clock,
    // The pool's copies and merges take the game's one git index, as the lead's saves and restores do.
    gitWrite: open.gitWrite,
    // A merge whose turn comes once the Loop closes, stops or pauses lands nothing after its close kept the folder.
    mergeRefused: () => mergeRefusedNow(loopRun),
    // A worker's end is the lead's news: it wakes a resting lead with the rest.
    onEnded: (record) =>
      loopRun.note(RUN_POOL_WORDS.ended(record.id, record.title, record.state), NoteKind.WorkerEnded),
  };
}

/** Open the run's worker pool for the open Loop (its kept workers from before a pause stay reachable by id). */
export async function openLoopPool(loopRun: LoopRun, open: OpenLoop): Promise<void> {
  open.pool = await runPool(poolSeat(loopRun, open));
}
