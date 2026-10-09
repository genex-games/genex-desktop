/**
 * Starting a run: the refusals a run meets before it is registered, the loop that conducts it,
 * the self-improvement pass that follows it, and the record a run that died still owes its chat.
 */
import { EngineId, modelOn, supportsSessions, withRoles } from "./model-roles.ts";
import { runGauntlet } from "./gauntlet.ts";
import { runAutopilot } from "./autopilot.ts";
import { runDirector } from "./director.ts";
import { runSkillOpt } from "./skillopt.ts";
import { learningOn } from "./learning.ts";
import { createRunInbox, type RunInbox } from "./run-inbox.ts";
import { HostMethod } from "./host-methods.ts";
import { readJournal } from "./run-journal.ts";
import { EventKind, ExecutionStatus, RunEvent, RunMode } from "./run-events.ts";
import { type ActiveRun, RunnerKind, type RunStart, type Studio, heldRuns } from "./studio-state.ts";
import { passCtx } from "./live-chat.ts";
import { resumeStopped } from "./after-loop-run.ts";
import { forgetProviderLosses } from "./provider-loss.ts";
import type { AnyRecord, HarnessCtx, HarnessEvent, Host, Run } from "../types/harness.d.ts";
import type { EngineDescriptor } from "../types/host-api.d.ts";

/**
 * This start reads a reopened run's inbox from its ask (`RunStart.reopen`), and closes a crashed
 * reopen (`closeFailedRun`): the chat reopens a finished build only when every part it depends on
 * says so (reopen-run.ts).
 */
export const SERVES_REOPEN = true;

/** Where the post-run self-improvement pass stands (`run_learning`). Persisted: never rename a value. */
const LearningState = {
  Running: "running",
  Completed: "completed",
  Failed: "failed",
} as const;
type LearningState = (typeof LearningState)[keyof typeof LearningState];

/** What the chat and the run record are told. */
const MESSAGE = {
  runOwnsThread: "A run already owns this thread or project. Message its coordinator instead.",
  noJournal: "no resumable journal for this run — it may predate Autopilot or have been archived",
  alreadyBuilding: (project: string) =>
    `A build is already running for **${project}** — nothing new was started. Ask here about the one that is running, or stop it first.`,
  engineExport: (name: string | undefined) =>
    `${name} was exported from a game engine, so the studio cannot edit or judge it — it can only open it, play it and take screenshots. Open the folder with the project's own scenes and scripts, and start the build there.`,
  stoppedBeforeStart: "Stopped before the build started — nothing was built.",
  notReady: (name: string, missing: readonly string[]) =>
    `${name} is not ready for a run: ${missing.join("; ")}. Fix that first (a chat build can), then start again.`,
} as const;

/** How a runner is called: the thread the run tells its story in, the run, and whether it resumes. */
type Runner = (ctx: HarnessCtx, options: { threadId: string; run: Run; resume: boolean }) => Promise<AnyRecord>;

const RUNNERS: Record<RunnerKind, Runner> = {
  [RunnerKind.Director]: (ctx, options) => runDirector(ctx, options),
  [RunnerKind.Autopilot]: (ctx, options) => runAutopilot(ctx, options),
  // The gauntlet has no journal to resume from.
  [RunnerKind.Gauntlet]: (ctx, { threadId, run }) => runGauntlet(ctx, { threadId, run }),
};

/**
 * Which loop conducts `run`. Session-capable engines (including Bonsai) conduct a director run.
 * Completion-only engines keep the classic loop, as does an explicit run.classic.
 */
export function chooseRunner(run: Run, described: readonly EngineDescriptor[]): RunnerKind {
  if (run.mode !== RunMode.Autopilot) return RunnerKind.Gauntlet;
  const delegated = supportsSessions(described.find((e) => e.id === (run.engine ?? EngineId.Ollama)));
  return delegated && run.classic !== true ? RunnerKind.Director : RunnerKind.Autopilot;
}

/** One custom event, as a batch entry. */
function customEvent(eventType: string, payload: AnyRecord) {
  return { type: EventKind.Custom, event_type: eventType, payload };
}

/** One assistant message, as a batch entry. */
function assistantSays(content: string) {
  return { type: EventKind.Messages, messages: [{ role: "assistant" as const, content }] };
}

/** Did this record close `runId`? */
function closesRun(event: HarnessEvent | null | undefined, runId: string): boolean {
  const data = event?.data;
  return data?.type === EventKind.Custom && data.event_type === RunEvent.RunFinished && data.payload?.runId === runId;
}

/** Did this record register `runId` (a start, or a resume or reopen starting it again)? */
function registersRun(event: HarnessEvent | null | undefined, runId: string): boolean {
  const data = event?.data;
  return data?.type === EventKind.Custom && data.event_type === RunEvent.RunRegistered && data.payload?.runId === runId;
}

/** Did this session of the run write its own close: a `run_finished` after its latest registration? */
function closedThisSession(events: readonly HarnessEvent[], runId: string): boolean {
  let closed = false;
  for (const event of events) {
    if (registersRun(event, runId)) closed = false;
    else if (closesRun(event, runId)) closed = true;
  }
  return closed;
}

/** A run that holds this start's thread or project. */
const conflictOf = (studio: Studio, action: RunStart): ActiveRun | undefined =>
  heldRuns(studio).find((a) => a.threadId === action.threadId || a.run.project === action.run.project);

/** When a run is over: `closed` settles, and each record of it is marked done, before its learning pass. */
interface RunClose {
  closed: Promise<unknown>;
  close(): void;
  /** The records of the run the close marks: its reservation, and the run once it is under way. */
  holders: ActiveRun[];
}

function runClose(): RunClose {
  let resolve: (value?: unknown) => void = () => {};
  const closed = new Promise((r) => {
    resolve = r;
  });
  const record: RunClose = {
    closed,
    holders: [],
    close: () => {
      for (const holder of record.holders) holder.done = true;
      resolve();
    },
  };
  return record;
}

/**
 * What holds this start's thread or project once any run that has closed there is past its
 * learning pass — or `stopped` when Stop reached such a run while this start waited for it: that
 * Stop was the user's for this start too.
 */
async function afterClosedRuns(studio: Studio, action: RunStart): Promise<{ stopped: boolean }> {
  let conflict = conflictOf(studio, action);
  while (conflict?.done) {
    const stoppedBefore = conflict.stopped === true;
    await conflict.settled;
    if (!stoppedBefore && conflict.stopped === true) return { stopped: true };
    conflict = conflictOf(studio, action);
  }
  return { stopped: false };
}

/**
 * Start a run. A run that already owns the thread or the project refuses the second one; the
 * reservation holds from before the first await until the run and its learning pass are over. A
 * run that has closed holds them only through its learning pass: a new start waits that out, and
 * does not start when Stop reached that pass meanwhile.
 */
export async function handleRunStart(
  studio: Studio,
  action: RunStart,
  { keepStop = false }: { keepStop?: boolean } = {},
): Promise<void> {
  const { stopped } = await afterClosedRuns(studio, action);
  if (stopped) return;
  // Read again after that await, in the same step as the reservation below: another start of this
  // chat or project may have reserved it while this one waited. A run that closed since
  // is waited out again.
  const conflict = conflictOf(studio, action);
  if (conflict?.done) return handleRunStart(studio, action, { keepStop });
  if (conflict) return refuseSecondRun(studio.host, action, conflict);
  // A run the chat's own session asked to resume, stopped since its reply ended: the reservation
  // below clears the thread's Stop, so it is asked first (after-loop-run.ts).
  if (resumeStopped(studio, action)) return;
  // Reserve before the first await, including resumed runs dispatched by the coordinator.
  let settle: (value?: unknown) => void = () => {};
  const settled = new Promise((resolve) => {
    settle = resolve;
  });
  const close = runClose();
  const reservation: ActiveRun = { run: action.run as Run, threadId: action.threadId, settled, closed: close.closed };
  close.holders.push(reservation);
  studio.startingRuns.set(action.run.runId, reservation);
  // A start of its own (Resume, the run IPC) clears an earlier Stop. A build a chat turn launched
  // (`keepStop`) does not: the chat cleared its Stop when the message began, so a Stop now was
  // pressed since — while the folder was scaffolded and checked — and is for this build.
  if (!keepStop) studio.cancels.delete(action.threadId);
  try {
    await startReservedRun(studio, action, settled, close);
  } finally {
    close.close();
    studio.startingRuns.delete(action.run.runId);
    settle();
  }
}

/** The refusal of a second run where one already works, where the chat can see it. */
async function refuseSecondRun(host: Host, action: RunStart, conflict: ActiveRun): Promise<void> {
  await host.call(HostMethod.EventsAppend, {
    threadId: action.threadId,
    batch: [
      customEvent(RunEvent.RunStartBlocked, {
        runId: conflict.run.runId,
        requestedRunId: action.run.runId,
        reason: MESSAGE.runOwnsThread,
      }),
      // Without this the refusal is an event nothing renders, and the chat's last word is a
      // promise to build for the whole run.
      assistantSays(MESSAGE.alreadyBuilding(conflict.run.project)),
    ],
  });
}

async function startReservedRun(
  studio: Studio,
  action: RunStart,
  settled: Promise<unknown>,
  close: RunClose,
): Promise<void> {
  const { host } = studio;
  const { threadId } = action;
  // Whatever asked for this run — an interview, the run IPC, a resume — a folder the studio
  // can never build on refuses here as well, before a run is registered. Only the folder's own
  // impossibility counts at this point: what is merely missing is the launch path's question.
  const games = await host.call(HostMethod.GameList, {}).catch(() => []);
  const refused = loopRunRefusal(games.find((g) => g.name === action.run.project) ?? null, []);
  if (refused) {
    await host.call(HostMethod.EventsAppend, {
      threadId,
      batch: [
        customEvent(RunEvent.RunStartBlocked, { requestedRunId: action.run.runId, reason: refused }),
        assistantSays(refused),
      ],
    });
    return;
  }
  // One pick, three jobs: the spec arrives with the composer's model and leaves here with
  // its planner, builders and critics resolved (model-roles.ts). A resumed run keeps the
  // roles it was launched with; a reopened one arrives with them already resolved — its
  // message's picks, or the build's own for the coordinator's reopen (reopen-run.ts `reopenedRun`).
  const run = withRoles(action.run as Run);
  if (studio.cancels.has(threadId)) {
    // The chat was promised a build: it is told that none started.
    await host
      .call(HostMethod.EventsAppend, { threadId, batch: [assistantSays(MESSAGE.stoppedBeforeStart)] })
      .catch(() => {});
    return;
  }
  // The entry outlives the gauntlet on purpose: the self-improvement pass that follows is
  // still "the run" to the person pressing Stop, so run_stop must reach it too. The chat is not
  // held through that pass: the close marks the entry done (live-chat.ts).
  const active: ActiveRun = { run, threadId, settled, closed: close.closed };
  close.holders.push(active);
  studio.activeRuns.set(run.runId, active);
  const ctx = studio.scoped(threadId);
  ctx.setStatus(`run ${run.runId}`);
  host.notify("run.keepawake", { runId: run.runId });
  try {
    const begins = { resume: action.resume === true, after: action.reopen?.after ?? null };
    await conductRun(host, ctx, run, begins, { closed: close.close, active });
  } catch (err: any) {
    await closeFailedRun(host, ctx, run, err);
  } finally {
    close.close();
    studio.activeRuns.delete(run.runId);
    ctx.setStatus("idle");
    // Terminal, always: the run AND its self-improvement pass are over (or skipped). The app
    // holds the Mac awake until this — releasing at run.finished would let it nap mid-pass.
    host.notify("run.settled", { runId: run.runId });
  }
}

/** How a run begins: afresh or resumed, and where its inbox reads the log from (a reopen's ask; null: all of it). */
interface Begins {
  resume: boolean;
  after: string | null;
}

/** The run as its conduct reaches it: its close, said before the learning pass, and its record. */
interface Conduct {
  closed: () => void;
  active: ActiveRun;
}

/**
 * Register the run, conduct it with the loop it calls for, and learn from it when that is wanted.
 * `closed` is said as soon as the run is over, before the learning pass: the chat is free from then.
 * The pass keeps the run's own Stop (live-chat.ts `passCtx`): a message after it never sets the pass
 * going again.
 */
async function conductRun(
  host: Host,
  ctx: HarnessCtx,
  run: Run,
  { resume, after }: Begins,
  { closed, active }: Conduct,
): Promise<void> {
  const { threadId } = ctx;
  await host.call(HostMethod.EventsAppend, {
    threadId,
    batch: [customEvent(RunEvent.RunRegistered, { ...run, reference: { name: run.reference?.name }, resumed: resume })],
  });
  // A finished build reopened hears the user from its ask on: what was said before was that run's.
  const inbox = createRunInbox(ctx, { threadId, runId: run.runId, after });
  ctx.runInbox = inbox;
  const described =
    run.mode === RunMode.Autopilot ? await host.call(HostMethod.EngineDescribe, {}).catch(() => []) : [];
  // A run (a Resume included) starts trusting its providers again: a loss was the last stretch's.
  forgetProviderLosses(run.runId);
  const report = await RUNNERS[chooseRunner(run, described)](ctx, { threadId, run, resume });
  closed();
  host.notify("run.finished", report);
  // A finished run is the richest evidence there is — mine it while it is fresh. A stop
  // means stop, so a cancelled run skips the pass; so does Self-improvement switched off.
  const pass = passCtx(ctx, active);
  if (await wantsToLearn(pass, inbox, report)) await learnFromRun(host, pass, run);
}

/**
 * Learn from the run: nobody stopped it — before or while asking — nor asked it to finish, it kept
 * new rounds, and learning is on.
 */
async function wantsToLearn(pass: HarnessCtx, inbox: RunInbox, report: AnyRecord): Promise<boolean> {
  // A run its provider paused (`report.limit`: a limit, a lost sign-in, an outage) is not over, and
  // its provider is gone: it is learned from when it ends, not now against a dead account.
  if (report?.limit) return false;
  if (pass.cancelled || (await inbox.finishing()) || !keptNewRounds(report)) return false;
  return (await learningOn(pass)) && !pass.cancelled;
}

/**
 * Did this session keep rounds of its own? A resumed or reopened run that kept none — the user's
 * quick fix, made by its lead — has nothing the pass after its earlier session did not already mine
 * (golden-boot-glory: such a fix was learned from as a call made without the user).
 */
export function keptNewRounds(report: AnyRecord | null | undefined): boolean {
  const earlier = report?.earlier?.rounds;
  if (typeof earlier !== "number") return true;
  const rounds = Array.isArray(report?.iterations) ? report.iterations.length : 0;
  return rounds > earlier;
}

/** The self-improvement pass over a finished run, with its state on the run's thread. */
async function learnFromRun(host: Host, ctx: HarnessCtx, run: Run): Promise<void> {
  const { threadId } = ctx;
  const learningState = async (state: LearningState) =>
    host
      .call(HostMethod.EventsAppend, {
        threadId,
        batch: [customEvent(RunEvent.RunLearning, { runId: run.runId, project: run.project, state })],
      })
      .catch(() => {});
  await learningState(LearningState.Running);
  ctx.setStatus("self-improving");
  try {
    // The pass runs on the engine that ran the run — the model that made the mistakes
    // is the one that studies them; the local default is only for engine-less history.
    const skillReport = await runSkillOpt(ctx, {
      threadId,
      ...(run.engine ? { engine: run.engine } : {}),
      // …on a model that engine knows: the builders' where they ran there, else the
      // orchestrator's (cross-provider roles).
      ...(modelOn(run, run.engine) ? { model: modelOn(run, run.engine) } : {}),
    });
    await learningState(LearningState.Completed);
    host.notify("skillopt.finished", skillReport);
  } catch (err: any) {
    await learningState(LearningState.Failed);
    host.notify("skillopt.failed", { error: err?.message ?? String(err) });
  }
}

/** A run that threw: its closing record (unless it wrote its own) and the error, then the push. */
async function closeFailedRun(host: Host, ctx: HarnessCtx, run: Run, err: any): Promise<void> {
  const { threadId } = ctx;
  const failure = err?.message ?? String(err);
  try {
    // Durable closure before any UI push: an unmatched run_started reads as a run still
    // going, and a notify dies with the window while the log survives the run. But the
    // gauntlet may have written its own run_finished before dying — a report-artifact
    // failure after a blind win, say — and a second closure would overwrite a victory
    // with a defeat in every reader that keeps the last word. Only this session's close
    // counts: a run started again (a Resume, a finished build reopened) has an earlier
    // session's close in the log, which is not this one's.
    const events = await host.call(HostMethod.EventsList, { threadId }).catch(() => []);
    const alreadyClosed = closedThisSession(events, run.runId);
    const closing = customEvent(RunEvent.RunFinished, {
      runId: run.runId,
      project: run.project,
      goal: run.goal,
      victory: false,
      executionStatus: ctx.cancelled ? ExecutionStatus.Cancelled : ExecutionStatus.Failed,
      stoppedBecause: failure,
      finishedAt: new Date().toISOString(),
    });
    await host.call(HostMethod.EventsAppend, {
      threadId,
      batch: [
        ...(alreadyClosed ? [] : [closing]),
        { type: EventKind.Error, message: `run ${run.runId} failed: ${failure}` },
      ],
    });
  } finally {
    host.notify("run.failed", { runId: run.runId, error: failure });
  }
}

/**
 * Resume a run from its saved journal. A continuation message or Resume requests the saved
 * journal, never boot alone: finished facets replay from it and only the unfinished work restarts.
 */
export async function resumeRun(studio: Studio, threadId: string, runId: string): Promise<void> {
  const journal = await readJournal(studio.host, threadId, runId);
  if (!journal?.run) {
    studio.host.notify("run.failed", { runId, error: MESSAGE.noJournal });
    return;
  }
  return handleRunStart(studio, { type: "run_start", threadId, run: journal.run, resume: true });
}

/**
 * Why this folder cannot have a run spent on it — a sentence for the chat, or null to launch.
 *
 * Two refusals, and both are about the folder rather than the model. A folder that cannot load
 * has nothing for six builders to work on: say what is missing now instead of judging black
 * frames for the whole run. And an engine export is already compiled — there is
 * no source to edit and no contract to read, so the run would photograph a page nobody can
 * change (Godot/Unity exports); the studio still opens it, plays it and screenshots
 * it. A missing studio contract is *not* a refusal: installing it is the base builder's first job.
 */
export function loopRunRefusal(
  descriptor: { name?: string; shape?: { kind?: string } | null } | null | undefined,
  problems: readonly string[] | null | undefined,
): string | null {
  if (descriptor?.shape?.kind === "engine-export") return MESSAGE.engineExport(descriptor.name);
  const missing = (problems ?? []).filter((problem) => /is missing$/.test(problem));
  if (missing.length) return MESSAGE.notReady(descriptor?.name ?? "this game", missing);
  return null;
}
