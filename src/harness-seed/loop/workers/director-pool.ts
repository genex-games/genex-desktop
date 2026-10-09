/**
 * The director in Genex's one worker model. Its `worker_start` keeps building in copies (isolation
 * copy, the default: today's builder in its own worktree); isolation read starts a reader from the
 * run's shared pool, in the game folder, and isolation lock is refused, because the web method never
 * writes in the game folder itself. `worker_mark` is the lead's word on a builder: used integrates
 * its last accepted commit, rejected stops its news in every digest and `worker_wait`. The worker
 * tools reach a reader by its id. The marks live with the run; a resumed run starts with none.
 */
import type { AnyRecord } from "../../types/harness.d.ts";
import { slug } from "../director/args.ts";
import type { LoopRun, Worker } from "../director/loop-run.ts";
import { modelOn, roleEffort, RoleKey, roleEngine } from "../model-roles.ts";
import { isRunning, WorkerState } from "../outcomes.ts";
import { CLIP_DETAIL, clip, hasText } from "../text.ts";
import { WorkerEnd, WorkerIsolation, WorkerStopCode, WorkerTool, WorkerVerdict } from "./contract.ts";
import { recordWorkerFinished, recordWorkerStarted, type WorkerEventScope } from "./events.ts";
import { folderLabelOf, WEB_AT_ROOT } from "./identity.ts";
import { DIRECTOR_MARK_WORDS, FIT_IN_WORDS, RUN_POOL_WORDS } from "./prompts.ts";
import { REAL_CLOCK } from "./records.ts";
import { waitingWorkers } from "./questions.ts";
import { closeRunPool, type RunPoolSeat, runPool, runPoolCall, runPoolStatus } from "./run-pool.ts";

/** The worker tools that name one worker, which a reader of the run's pool answers for its own id. */
const ONE_WORKER_TOOLS: ReadonlySet<string> = new Set([
  WorkerTool.Status,
  WorkerTool.Wait,
  WorkerTool.Steer,
  WorkerTool.Stop,
  WorkerTool.Mark,
]);

/** The lead's marks on its builders, by run: what it said, and the note it gave. */
const marks = new WeakMap<object, Map<string, { verdict: WorkerVerdict; note: string | null }>>();

/** The run's marks, made on first use. */
function marksOf(loopRun: LoopRun): Map<string, { verdict: WorkerVerdict; note: string | null }> {
  const known = marks.get(loopRun);
  if (known) return known;
  const made = new Map<string, { verdict: WorkerVerdict; note: string | null }>();
  marks.set(loopRun, made);
  return made;
}

/** The builders the lead rejected: no digest and no `worker_wait` names them again. */
export function rejectedWorkers(loopRun: LoopRun): ReadonlySet<string> {
  const rejected = [...marksOf(loopRun)].filter(([, mark]) => mark.verdict === WorkerVerdict.Rejected);
  return new Set(rejected.map(([id]) => id));
}

/** Whether a line of the run's log is news of a worker the lead rejected (every such line opens `worker <id>`). */
export function rejectedNews(loopRun: LoopRun, text: string): boolean {
  for (const id of rejectedWorkers(loopRun))
    if (text.startsWith(`worker ${id}:`) || text.startsWith(`worker ${id} `)) return true;
  return false;
}

/** The workers a digest names: all but those the lead rejected. */
export function unrejected<T extends { id: string }>(loopRun: LoopRun, workers: readonly T[]): T[] {
  const rejected = rejectedWorkers(loopRun);
  return workers.filter((worker) => !rejected.has(worker.id));
}

/** The brief a director's `worker_start` carries: `task`, else a kept prompt's `brief`. */
export function briefOf(args: AnyRecord): string {
  return String((hasText(args.task) ? args.task : args.brief) ?? "").trim();
}

/** The director's run pool: the builders' engine, readers in the game folder, merges into the integration worktree. */
function seatOf(loopRun: LoopRun): RunPoolSeat {
  const { ctx, integrationWorktree, projectDir, run, threadId } = loopRun;
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
    gameDir: projectDir,
    ...(loopRun.game ? { game: loopRun.game } : {}),
    leadFolder: integrationWorktree,
    identity: { folderLabel: folderLabelOf(projectDir, run.project), facts: loopRun.gameFacts ?? WEB_AT_ROOT },
    clock: REAL_CLOCK,
    onEnded: (record) => loopRun.note(RUN_POOL_WORDS.ended(record.id, record.title, record.state)),
  };
}

/** A director's `worker_start` asking for a reader: one from the run's pool, in the game folder. */
async function startReader(loopRun: LoopRun, args: AnyRecord): Promise<string> {
  const pool = await runPool(seatOf(loopRun));
  const title = hasText(args.title) ? args.title : String(args.id ?? "");
  return pool.call(WorkerTool.Start, {
    title,
    task: briefOf(args),
    isolation: WorkerIsolation.Read,
    ...(args.research === undefined ? {} : { research: args.research }),
  });
}

/**
 * A worker tool call the run's shared pool answers for the director: a reader's start, a lock
 * refused, or a call naming one of the pool's readers. Null for everything the director's own
 * handlers answer (a builder's start, a builder's id, or no id at all).
 */
export async function pooledAnswer(loopRun: LoopRun, name: string, args: AnyRecord): Promise<string | null> {
  if (name === WorkerTool.Start) {
    const isolation = String(args.isolation ?? "").trim();
    if (isolation === WorkerIsolation.Lock) return RUN_POOL_WORDS.noLock;
    return isolation === WorkerIsolation.Read ? startReader(loopRun, args) : null;
  }
  if (!ONE_WORKER_TOOLS.has(name)) return null;
  const id = args.id ?? args.worker;
  if (!hasText(id) || loopRun.state.workers.has(slug(id))) return null;
  return runPoolCall(loopRun.run.runId, name, args);
}

/** The run pool's readers, as lines after the builders' status; "" when there are none. */
export function readerLines(loopRun: LoopRun): Promise<string> {
  return runPoolStatus(loopRun.run.runId, (pool) => pool.call(WorkerTool.Status, {}));
}

/** The questions already told in each run's log, by `<worker>:<question>`: each is told once. */
const told = new WeakMap<object, Set<string>>();

/**
 * The run's builders that wait on the person now, by id, with what each asks: read from the
 * chat's log (`waitingWorkers`). A builder that newly waits is told once in the run's log, so
 * `worker_wait` wakes on it and the lead can stop it or work around it. The run pool's readers are
 * the pool's to read.
 */
export async function waitingBuilders(loopRun: LoopRun): Promise<Map<string, string>> {
  const waiting = await waitingWorkers(loopRun.ctx, loopRun.threadId);
  const builders = new Map([...waiting].filter(([id]) => loopRun.state.workers.has(id)));
  const said = told.get(loopRun) ?? new Set<string>();
  told.set(loopRun, said);
  for (const [id, question] of builders) {
    const key = `${id}:${question}`;
    if (said.has(key)) continue;
    said.add(key);
    loopRun.note(RUN_POOL_WORDS.waiting(id, question));
  }
  return builders;
}

/** The run closes: its readers stop. */
export function closeReaders(loopRun: LoopRun): Promise<void> {
  return closeRunPool(loopRun.run.runId);
}

// ── a builder's records ──────────────────────────────────────────────────────────────────────

/**
 * How each state a builder's close-out finds it in is recorded. A close-out ends the builder
 * whatever its state says: one still marked running there was cut off by the run's end before its
 * own state was set, so it reads as stopped.
 */
const BUILDER_END = {
  [WorkerState.Running]: WorkerEnd.Stopped,
  [WorkerState.Done]: WorkerEnd.Done,
  [WorkerState.Failed]: WorkerEnd.Failed,
  [WorkerState.Stopped]: WorkerEnd.Stopped,
} as const satisfies Record<WorkerState, WorkerEnd>;

/** Where a builder's records go: the run's chat, stamped with the run. */
function builderScope(loopRun: LoopRun): WorkerEventScope {
  const { ctx, run, threadId } = loopRun;
  return { ctx, threadId, project: run.project, runId: run.runId };
}

/**
 * The title a builder's records carry. A conflict worker's (conflict-worker.ts) names the work it
 * fits in, in plain words: the title the lead knows it by names the git step.
 */
function recordedTitle(loopRun: LoopRun, worker: Worker): string {
  if (!worker.merging) return worker.title;
  const of = loopRun.state.workers.get(worker.merging.of)?.title;
  return hasText(of) ? FIT_IN_WORDS.title(of) : FIT_IN_WORDS.someWork;
}

/**
 * A builder's start on the chat's log: a worker in its own copy, under the id the lead gave it.
 * A conflict worker's task is Genex's own brief, so its record asks what its title says.
 */
export function recordBuilderStarted(loopRun: LoopRun, worker: Worker): Promise<void> {
  const title = recordedTitle(loopRun, worker);
  const task = worker.merging ? title : worker.brief;
  const started = { workerId: worker.id, title, isolation: WorkerIsolation.Copy, task };
  return recordWorkerStarted(builderScope(loopRun), started);
}

/** Whether a builder left a commit of its own: work in its copy that waits for the lead to use it. */
const handsWorkBack = (worker: Worker): boolean => hasText(worker.lastCommit) && worker.lastCommit !== worker.from;

/** A builder's own summary: its session's (`runSingleWorker`); a conflict worker's is Genex's words on the merge. */
const ownSummary = (worker: Worker): string | null =>
  !worker.merging && hasText(worker.summary) ? worker.summary : null;

/**
 * Why a builder stopped short, as the app words it: the lead's `worker_stop`; the run's end, which
 * cut it off at its close-out, stopped it at the close, or was the person's Stop; else an error.
 * Null for a builder that finished.
 */
function builderStopCode(loopRun: LoopRun, worker: Worker, state: WorkerEnd): WorkerStopCode | null {
  if (state === WorkerEnd.Done) return null;
  if (worker.stoppedByLead) return WorkerStopCode.StoppedByLead;
  const cutOff = worker.state === WorkerState.Running || worker.stopRequested || Boolean(loopRun.ctx.cancelled);
  return cutOff ? WorkerStopCode.RunEnded : WorkerStopCode.Error;
}

/**
 * A builder's end on the chat's log: how it ended, why in the app's code (`because` is for the
 * lead), with its own summary when it has one. A finished builder with a commit of its own
 * delivered work the lead has not used yet, so its row waits on the lead until it is integrated,
 * as a pool worker's copy does.
 */
export function recordBuilderEnded(loopRun: LoopRun, worker: Worker, because: string | null): Promise<void> {
  const state = BUILDER_END[worker.state] ?? WorkerEnd.Stopped;
  const delivered = state === WorkerEnd.Done && handsWorkBack(worker);
  const title = recordedTitle(loopRun, worker);
  const summary = ownSummary(worker);
  const stopCode = builderStopCode(loopRun, worker, state);
  const ended = { workerId: worker.id, title, state, stoppedBecause: because, stopCode, summary, delivered };
  return recordWorkerFinished(builderScope(loopRun), ended);
}

/** The lead's verdict on a builder, a second end record of it: a used builder's work was integrated. */
function recordBuilderMarked(loopRun: LoopRun, worker: Worker, verdict: WorkerVerdict, note: string | null) {
  const merged = verdict === WorkerVerdict.Used;
  return recordWorkerFinished(builderScope(loopRun), {
    workerId: worker.id,
    title: recordedTitle(loopRun, worker),
    verdict,
    note,
    merged,
  });
}

/** `worker_mark used`: the builder's last accepted commit is integrated; the mark stands once the head moved. */
async function markUsed(loopRun: LoopRun, worker: Worker, note: string | null): Promise<string> {
  const before = loopRun.state.integrationHead;
  const answer = await loopRun.integrate({ worker: worker.id });
  if (loopRun.state.integrationHead !== before) {
    marksOf(loopRun).set(worker.id, { verdict: WorkerVerdict.Used, note });
    await recordBuilderMarked(loopRun, worker, WorkerVerdict.Used, note);
  }
  return typeof answer === "string" ? answer : JSON.stringify(answer);
}

/** A builder whose work the lead integrated, by `worker_mark used` or `integrate`: it is in the game. */
const isIntegrated = (loopRun: LoopRun, worker: Worker): boolean =>
  worker.integrated === true || marksOf(loopRun).get(worker.id)?.verdict === WorkerVerdict.Used;

/**
 * `worker_mark rejected`: its news stops, and the feed says so. Work already in the game is
 * never marked rejected, so the chat and the graph never call work in the game unused.
 */
async function markRejected(loopRun: LoopRun, worker: Worker, note: string | null): Promise<string> {
  if (isRunning(worker)) return DIRECTOR_MARK_WORDS.stillRunning(worker.id);
  if (isIntegrated(loopRun, worker)) return DIRECTOR_MARK_WORDS.inGameAlready(worker.id);
  marksOf(loopRun).set(worker.id, { verdict: WorkerVerdict.Rejected, note });
  await recordBuilderMarked(loopRun, worker, WorkerVerdict.Rejected, note);
  await loopRun.decision(
    DIRECTOR_MARK_WORDS.rejectedCard(worker.id, note),
    DIRECTOR_MARK_WORDS.rejectedPlain(recordedTitle(loopRun, worker)),
  );
  return DIRECTOR_MARK_WORDS.rejected(worker.id);
}

/** `worker_mark`: the director's word on one of its builders. */
export async function markWorker(loopRun: LoopRun, args: AnyRecord): Promise<string> {
  const id = slug(args.id ?? args.worker);
  const worker = loopRun.state.workers.get(id);
  if (!worker) return DIRECTOR_MARK_WORDS.unknown(id);
  const note = hasText(args.note) ? clip(args.note.trim(), CLIP_DETAIL) : null;
  if (args.verdict === WorkerVerdict.Used) return markUsed(loopRun, worker, note);
  if (args.verdict === WorkerVerdict.Rejected) return markRejected(loopRun, worker, note);
  return DIRECTOR_MARK_WORDS.badVerdict;
}
