/**
 * Starting a run: the refusals a run meets before it is registered, the loop that conducts it,
 * the self-improvement pass that follows it, and the record a run that died still owes its chat.
 */
import {
  type FactsOfDescriptor,
  kindPending,
  kindUnknown,
  LoopProfile,
  loopProfileOf,
  openLoopBecause,
  startWebIfPending,
} from "./folder-facts.ts";
import { fireGates } from "./builtin-hooks.ts";
import { OLDER_LEAD_JOURNAL_KIND } from "./director/open/older-journal.ts";
import { openLoopServed } from "./open-loop-parts.ts";
import { leadsInPlace } from "./engine-seat.ts";
import { switchNamed, unrealRunnerOn } from "./loop-switch.ts";
import { OPEN_LOOP_REFUSAL } from "./open-loop-prompts.ts";
import { HookEvent } from "./hooks.ts";
import { runUnrealLead } from "./unreal/lead.ts";
import { EngineId, modelOn, supportsSessions, withRoles } from "./model-roles.ts";
import { runGauntlet } from "./gauntlet.ts";
import { runAutopilot } from "./autopilot.ts";
import { runDirector } from "./director.ts";
import { runSkillOpt } from "./skillopt.ts";
import { learningOn } from "./learning.ts";
import { createRunInbox, type RunInbox } from "./run-inbox.ts";
import { HostMethod } from "./host-methods.ts";
import { journalId, readJournal } from "./run-journal.ts";
import { EventKind, ExecutionStatus, RunEvent, RunMode, writeRunArtifact } from "./run-events.ts";
import { type ActiveRun, RunnerKind, type RunStart, type Studio, heldRuns } from "./studio-state.ts";
import { passCtx } from "./live-chat.ts";
import { resumeStopped } from "./after-loop-run.ts";
import { forgetProviderLosses } from "./provider-loss.ts";
import type { AnyRecord, ForwardedCall, HarnessCtx, HarnessEvent, Host, HostCall, Run } from "../types/harness.d.ts";
import type { EngineDescriptor, GameProject } from "../types/host-api.d.ts";

/**
 * This start reads a reopened run's inbox from its ask (`RunStart.reopen`), and closes a crashed
 * reopen (`closeFailedRun`): the chat reopens a finished build only when every part it depends on
 * says so (reopen-run.ts).
 */
export const SERVES_REOPEN = true;

/** This start leads a Loop on a project of any kind: the chat's launch reads it by namespace (`open-loop-parts.ts`). */
export const SERVES_OPEN_LOOP = true;

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
} as const;

/** How a runner is called: the thread the run tells its story in, the run, whether it resumes, and the folder's profile. */
type Runner = (
  ctx: HarnessCtx,
  options: {
    threadId: string;
    run: Run;
    resume: boolean;
    profile: LoopProfile;
    described: readonly EngineDescriptor[];
  },
) => Promise<AnyRecord>;

const RUNNERS: Record<RunnerKind, Runner> = {
  // A web game's Loop by the web method, or a Loop on any other project led in place.
  [RunnerKind.Director]: (ctx, options) => runDirector(ctx, options),
  [RunnerKind.Autopilot]: (ctx, { threadId, run, resume }) => runAutopilot(ctx, { threadId, run, resume }),
  // The gauntlet has no journal to resume from.
  [RunnerKind.Gauntlet]: (ctx, { threadId, run }) => runGauntlet(ctx, { threadId, run }),
  // The Unreal runner resumes from its journal (`kind: "unreal-lead"`, lead-journal.ts), behind the switch.
  [RunnerKind.Unreal]: (ctx, { threadId, run, resume }) => runUnrealLead(ctx, { threadId, run, resume }),
  [RunnerKind.NeedsSession]: (ctx, options) =>
    refusedRun(ctx, options, OPEN_LOOP_REFUSAL.needsSession(engineName(options.run, options.described))),
  [RunnerKind.WebOnly]: (ctx, options) => refusedRun(ctx, options, OPEN_LOOP_REFUSAL.webOnly),
};

/** The run's engine as the person knows it: its listed name, else its id. */
function engineName(run: Run, described: readonly EngineDescriptor[]): string {
  const engine = run.engine ?? EngineId.Ollama;
  return described.find((listed) => listed.id === engine)?.label ?? engine;
}

/** The runners that refuse a run with words: it closes at once, and nothing learns from it. */
const REFUSING_RUNNERS: ReadonlySet<RunnerKind> = new Set([RunnerKind.NeedsSession, RunnerKind.WebOnly]);

/**
 * Which loop conducts `run`. The gauntlet works on web games only. A web game's Loop is the
 * director's on a session-capable engine (including Bonsai) and the classic loop on a
 * completion-only engine or an explicit run.classic. A Loop on any other project (`LoopProfile.Open`)
 * is led by the chat's own session in place, so it needs an engine the host seats there
 * (`leadsInPlace`); classic is a web game's internal only. The internal switch (`unrealRunner`,
 * loop-switch.ts) sends it to the Unreal runner.
 */
export function chooseRunner(
  run: Run,
  described: readonly EngineDescriptor[],
  profile: LoopProfile = LoopProfile.Web,
  { unrealRunner = false }: { unrealRunner?: boolean } = {},
): RunnerKind {
  const open = profile === LoopProfile.Open;
  if (run.mode !== RunMode.Autopilot) return open ? RunnerKind.WebOnly : RunnerKind.Gauntlet;
  const engine = described.find((e) => e.id === (run.engine ?? EngineId.Ollama));
  if (!open) return supportsSessions(engine) && run.classic !== true ? RunnerKind.Director : RunnerKind.Autopilot;
  if (unrealRunner) return RunnerKind.Unreal;
  return leadsInPlace(engine) ? RunnerKind.Director : RunnerKind.NeedsSession;
}

/**
 * What a refusal's close keeps of the run's earlier close: what was built and where it stands (its
 * build, its landing, its workers, rounds and notes). How that session stopped (a provider's limit,
 * its stop code, its failure, where its working time ended) is never kept: the refusal is the stop
 * now, read in its own words.
 */
const KEPT_ON_REFUSAL = [
  "landed",
  "integrationHead",
  "baseCommit",
  "deliveredHead",
  "landingResult",
  "profile",
  "workers",
  "iterations",
  "facets",
  "notes",
  "verdicts",
  "savePoints",
  "lastCheckpoint",
  "summary",
  "reference",
  "mode",
] as const;

/** The parts of an earlier close a refusal keeps (`KEPT_ON_REFUSAL`); a finished build's reopen keeps its outcome too. */
function keptOfEarlier(earlier: AnyRecord | null, reopen: boolean): AnyRecord {
  if (!earlier) return {};
  const kept: AnyRecord = {};
  for (const key of KEPT_ON_REFUSAL) if (key in earlier) kept[key] = earlier[key];
  if (reopen && typeof earlier.victory === "boolean") kept.victory = earlier.victory;
  return kept;
}

/**
 * A run refused with words before it did anything: its start and its close, `stoppedBecause` the
 * words, and its report. Nothing was built this time. A resumed run stays paused (Resume picks it up
 * once the cause is fixed) and keeps what its earlier session built (`KEPT_ON_REFUSAL`, under the
 * refusal's own outcome); a finished build's reopen stays finished, its report and outcome kept too,
 * and the chat says why it was not picked up, which the finished build's card would not.
 */
async function refusedRun(
  ctx: HarnessCtx,
  { threadId, run, resume = false }: { threadId: string; run: Run; resume?: boolean },
  words: string,
  { reopen = false }: { reopen?: boolean } = {},
) {
  const paused = resume && !reopen;
  // Every reader takes the latest close as the truth: the earlier session's build, workers and notes stay on it.
  const earlier = resume || reopen ? await latestClose(ctx, threadId, run.runId) : null;
  const started = {
    runId: run.runId,
    goal: run.goal,
    project: run.project,
    ...(run.mode ? { mode: run.mode } : {}),
    ...(run.engine ? { engine: run.engine } : {}),
    budgets: run.budgets,
    ...(resume ? { resumed: true } : {}),
  };
  const report = {
    landed: false,
    victory: false,
    ...keptOfEarlier(earlier, reopen),
    runId: run.runId,
    project: run.project,
    goal: run.goal,
    executionStatus: paused ? ExecutionStatus.Paused : ExecutionStatus.Completed,
    ...(paused ? { paused: true } : {}),
    stoppedBecause: words,
    finishedAt: new Date().toISOString(),
  };
  const pausedRecord = customEvent(RunEvent.AutopilotPaused, { runId: run.runId, project: run.project });
  await ctx.call(HostMethod.EventsAppend, {
    threadId,
    batch: [
      customEvent(RunEvent.RunStarted, started),
      customEvent(RunEvent.RunFinished, report),
      ...(paused ? [pausedRecord] : []),
      ...(reopen && earlier ? [assistantSays(words)] : []),
    ],
  });
  if (!resume) await writeRunArtifact(ctx, run.runId, "report.json", report).catch(() => {});
  return report;
}

/** The run's latest close (`run_finished`) on its thread, as its report; null when none could be read. */
async function latestClose(ctx: HarnessCtx, threadId: string, runId: string): Promise<AnyRecord | null> {
  const events: HarnessEvent[] = await ctx.call(HostMethod.EventsList, { threadId }).catch(() => []);
  const close = events.findLast((event) => closesRun(event, runId));
  const payload = close?.data?.payload;
  return payload && typeof payload === "object" ? (payload as AnyRecord) : null;
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

/** A run that is over, or writing its own end: a start waits it out instead of being refused by it. */
const overOrClosing = (held: ActiveRun | undefined): held is ActiveRun => held?.done === true || held?.closing === true;

/** The records that end a run: its close, and the pause written beside it. */
const RUN_ENDS: ReadonlySet<string> = new Set([RunEvent.RunFinished, RunEvent.AutopilotPaused]);

/** Does this batch of records hold `runId`'s own end? */
function endsRun(batch: unknown, runId: string): boolean {
  if (!Array.isArray(batch)) return false;
  return batch.some(
    (data: AnyRecord | null) =>
      data?.type === EventKind.Custom && RUN_ENDS.has(data.event_type) && data.payload?.runId === runId,
  );
}

/**
 * The run's own ctx (`studio.scoped` makes one per call), its calls now marking each record of the
 * run `closing` just before the run's own end is appended: from the moment the chat can read that
 * the run paused or finished, a start (a Resume) waits for its close instead of being refused.
 */
function markingEnd(ctx: HarnessCtx, runId: string, close: RunClose): HarnessCtx {
  const call = ctx.call as ForwardedCall;
  ctx.call = ((method: string, params?: AnyRecord) => {
    if (method === HostMethod.EventsAppend && endsRun(params?.batch, runId))
      for (const holder of close.holders) holder.closing = true;
    return call(method, params);
  }) as HostCall;
  return ctx;
}

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
 * What holds this start's thread or project once any run that has closed there (or is writing its
 * end) is past its close and its learning pass — or `stopped` when Stop reached such a run while
 * this start waited for it: that Stop was the user's for this start too.
 */
async function afterClosedRuns(studio: Studio, action: RunStart): Promise<{ stopped: boolean }> {
  let conflict = conflictOf(studio, action);
  while (overOrClosing(conflict)) {
    // Any Stop that reaches the run meanwhile counts, also one on a run its own Stop paused.
    const stopsBefore = conflict.stops ?? 0;
    const stoppedBefore = conflict.stopped === true;
    await conflict.settled;
    const stoppedSince = (!stoppedBefore && conflict.stopped === true) || (conflict.stops ?? 0) > stopsBefore;
    if (stoppedSince) return { stopped: true };
    conflict = conflictOf(studio, action);
  }
  return { stopped: false };
}

/**
 * Start a run. A run that already owns the thread or the project refuses the second one; the
 * reservation holds from before the first await until the run and its learning pass are over. A
 * run that has closed, or has begun writing its end (a pause the chat can already read), holds them
 * only through its close and its learning pass: a new start waits that out, and does not start when
 * Stop reached that pass meanwhile.
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
  if (overOrClosing(conflict)) return handleRunStart(studio, action, { keepStop });
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
    await startReservedRun(studio, action, settled, close, keepStop);
  } finally {
    close.close();
    studio.startingRuns.delete(action.run.runId);
    settle();
  }
  // Not awaited: whoever waits for this run to close (a resume, a test) waits for it alone.
  void startAskedLoop(studio, action);
}

/**
 * The new Loop the user asked for while this one ran, started now that it has closed (next-loop.ts).
 * Loaded when needed: that module launches the way the chat does (chat-dispatch.ts), which starts
 * runs here.
 */
async function startAskedLoop(studio: Studio, action: RunStart): Promise<void> {
  const nextLoop = await import("./next-loop.ts").catch(() => null);
  await nextLoop?.startNextLoop(studio, action.threadId, action.run as Run).catch(() => {});
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
  launched: boolean,
): Promise<void> {
  const { host } = studio;
  const { threadId } = action;
  // Whatever asked for this run — an interview, the run IPC, a resume — a folder the studio
  // can never build on refuses here as well, before a run is registered. What is merely missing is
  // the launch path's question: asked again here for a web Loop a chat launched, so the gate holds
  // whichever copy of the launch an agent kept.
  const games = await host.call(HostMethod.GameList, {}).catch(() => []);
  const listed = games.find((g) => g.name === action.run.project) ?? null;
  const missing = launched && action.resume !== true ? await missingFiles(host, listed) : undefined;
  const refused = loopRunRefusal(listed, [], missing);
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
  const ctx = markingEnd(studio.scoped(threadId), run.runId, close);
  ctx.setStatus(`run ${run.runId}`);
  host.notify("run.keepawake", { runId: run.runId });
  try {
    const begins = {
      resume: action.resume === true,
      after: action.reopen?.after ?? null,
      reopen: Boolean(action.reopen),
    };
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

/**
 * What a web game's folder misses now (`game.validate`'s typed list); nothing asked for any other
 * project, nor for a game with no kind yet: its run's start gives it the web starter first.
 */
async function missingFiles(host: Host, game: GameProject | null): Promise<unknown> {
  if (!game || kindPending(game) || loopProfileOf(game) !== LoopProfile.Web) return undefined;
  const readiness = await host.call(HostMethod.GameValidate, { project: game.name }).catch(() => null);
  return readiness?.missing;
}

/** How a run begins: afresh or resumed (a finished build reopened, `reopen`), and where its inbox reads the log from (a reopen's ask; null: all of it). */
interface Begins {
  resume: boolean;
  after: string | null;
  reopen: boolean;
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
  { resume, after, reopen }: Begins,
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
  const route = await routeOf(host, run, { threadId, resume });
  const { games, profile } = route;
  const ask = { threadId, described, games, resume, reopen, profile, webElsewhere: route.webElsewhere };
  const chosen = route.refusal ? refusing(route.refusal, reopen) : await runnerFor(host, run, ask);
  const report = await chosen.runner(ctx, { threadId, run, resume, profile, described });
  closed();
  host.notify("run.finished", report);
  // A run refused with words did nothing to learn from; a Loop in place is no evidence for the web
  // method, the one skill the pass trains.
  if (chosen.refuses || profile === LoopProfile.Open) return;
  // A finished run is the richest evidence there is — mine it while it is fresh. A stop
  // means stop, so a cancelled run skips the pass; so does Self-improvement switched off.
  const pass = passCtx(ctx, active);
  if (await wantsToLearn(pass, inbox, report)) await learnFromRun(host, pass, run);
}

/** The Loop profile of the run's game, from the list the run already read (a game not listed is a web game's). */
function profileOf(games: readonly GameProject[], project: string): LoopProfile {
  const game = games.find((listed) => listed.name === project);
  return game ? loopProfileOf(game) : LoopProfile.Web;
}

/**
 * The profile a resumed run goes on in: its own journal's, never the folder's now. A Loop that worked
 * in place (`director.open`, or the Unreal runner's journal) goes on in place whatever the folder
 * reads as; any other journal (the director's, classic Autopilot's) is a web Loop's. Null with no
 * journal: the folder decides. A journal the host can't read throws, as the runner's own read does:
 * read as none, the folder would decide, and the run would resume from a journal of the other kind.
 */
async function resumedProfile(host: Host, threadId: string, runId: string): Promise<LoopProfile | null> {
  const journal = await host.call(HostMethod.ArtifactRead, { threadId, artifactId: journalId(runId) });
  if (!journal) return null;
  return journal.director?.open || journal.kind === OLDER_LEAD_JOURNAL_KIND ? LoopProfile.Open : LoopProfile.Web;
}

/** How a run is routed: its game list, its profile, a paused web Loop's folder read otherwise, or why it is refused. */
interface Route {
  games: readonly GameProject[];
  profile: LoopProfile;
  /** A paused web Loop resumed while its folder reads as no web game: the words that say what Genex finds there. */
  webElsewhere: string | null;
  refusal: string | null;
}

/** The game list as the run reads it (an answer that holds none is an empty list), or null when the host refused it. */
async function listedGames(host: Host): Promise<readonly GameProject[] | null> {
  try {
    const games = await host.call(HostMethod.GameList, undefined);
    return Array.isArray(games) ? games : [];
  } catch {
    return null;
  }
}

/** A route that refuses the run with these words. */
const refusedRoute = (refusal: string): Route => ({ games: [], profile: LoopProfile.Web, webElsewhere: null, refusal });

/**
 * The run's route (`Route`): a resumed run by its own journal, a fresh one by its folder. A journal
 * the host can't read, or a game list it can't give, refuses the run with words (a resume stays
 * paused) rather than taking the web Loop for one. A game with no kind yet takes the web starter
 * before the runner is chosen, but never under a paused Loop that worked in place, nor a resumed one
 * on a folder of a kind Genex can't name (that one is refused below, and stays paused).
 */
async function routeOf(host: Host, run: Run, { threadId, resume }: { threadId: string; resume: boolean }) {
  let resumedIn: LoopProfile | null = null;
  try {
    resumedIn = resume ? await resumedProfile(host, threadId, run.runId) : null;
  } catch {
    return refusedRoute(OPEN_LOOP_REFUSAL.journalUnreadable);
  }
  const games = await listedGames(host);
  if (!games) return refusedRoute(OPEN_LOOP_REFUSAL.gamesUnreadable);
  const game = games.find((listed) => listed.name === run.project);
  const unknownOnResume = resume && game !== undefined && kindUnknown(game);
  if (resumedIn !== LoopProfile.Open && !unknownOnResume) await startWebIfPending(host, run.project, games);
  const folder = profileOf(games, run.project);
  const elsewhere = resumedIn === LoopProfile.Web && folder !== LoopProfile.Web && game !== undefined;
  const webElsewhere = elsewhere ? OPEN_LOOP_REFUSAL.webElsewhere(openLoopBecause(game)) : null;
  const route: Route = { games, profile: resumedIn ?? folder, webElsewhere, refusal: null };
  return route;
}

/** The runner a run goes to, and whether it only refuses the run with words. */
interface ChosenRunner {
  runner: Runner;
  refuses: boolean;
}

/** What the runner is chosen from: the run's thread, its engines, its game's profile and whether it resumes. */
interface RunnerAsk {
  threadId: string;
  described: readonly EngineDescriptor[];
  games: readonly GameProject[];
  resume: boolean;
  /** A finished build reopened: a refusal keeps it finished, never paused. */
  reopen: boolean;
  profile: LoopProfile;
  /** A paused web Loop resumed while its folder reads as no web game: the words that refuse it there. */
  webElsewhere: string | null;
}

/** A runner that only refuses the run with `words` (paused for a Resume when it resumes one, finished when it reopens one). */
const refusing = (words: string, reopen = false): ChosenRunner => ({
  runner: (ctx, options) => refusedRun(ctx, options, words, { reopen }),
  refuses: true,
});

/**
 * Which runner conducts the run: by its mode, its engine and its game's profile, and for an open
 * Loop the internal switch. An open Loop on kept older parts that can't lead one is refused with
 * the words that say so, and so is a paused web Loop whose folder reads as no web game now: it stays
 * paused, its journal untouched, for a Resume once the folder reads as it did.
 */
async function runnerFor(host: Host, run: Run, ask: RunnerAsk): Promise<ChosenRunner> {
  const { threadId, described, games, resume, profile } = ask;
  const byKind = (kind: RunnerKind): ChosenRunner => ({ runner: RUNNERS[kind], refuses: REFUSING_RUNNERS.has(kind) });
  if (ask.webElsewhere)
    return refusing(ask.reopen ? OPEN_LOOP_REFUSAL.webBuildElsewhere : ask.webElsewhere, ask.reopen);
  if (profile !== LoopProfile.Open) return byKind(chooseRunner(run, described, profile));
  if (!openLoopServed()) return refusing(OPEN_LOOP_REFUSAL.openLoopNeedsUpdate);
  const game = games.find((listed) => listed.name === run.project);
  // The saved journal's kind is read only when the switch is named: no other run makes the call.
  const journalKind = resume && switchNamed(process.env) ? (await readJournal(host, threadId, run.runId))?.kind : null;
  const unrealRunner = unrealRunnerOn({ env: process.env, game, resume, journalKind });
  const kind = chooseRunner(run, described, profile, { unrealRunner });
  // The refusal names what Genex found that makes this project's Loop work in place.
  if (kind === RunnerKind.NeedsSession && game)
    return refusing(OPEN_LOOP_REFUSAL.needsSession(engineName(run, described), openLoopBecause(game)));
  return byKind(kind);
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
 * Two refusals, and both are about the folder rather than the model. An engine export is already
 * compiled — there is no source to edit and no contract to read, so the run would photograph a page
 * nobody can change (Godot/Unity exports); the studio still opens it, plays it and screenshots it.
 * And a web page that cannot load has nothing for six builders to work on: Genex's own `web.ready`
 * gate (builtin-hooks.ts) says what is missing now, from `game.validate`'s typed `missing`, and only
 * where a web game is served. `problems` are sentences and decide nothing; a caller that hands no
 * `missing` (an older copy of the launch) meets no missing-file refusal, and its run's base builder
 * still owes the page. A missing studio contract is *not* a refusal: installing it is the base
 * builder's first job.
 */
export function loopRunRefusal(
  descriptor: (FactsOfDescriptor & { name?: string; shape?: { kind?: string } | null }) | null | undefined,
  _problems: readonly string[] | null | undefined,
  missing?: unknown,
): string | null {
  if (descriptor?.shape?.kind === "engine-export") return MESSAGE.engineExport(descriptor.name);
  return fireGates(HookEvent.RunPrepare, { game: descriptor, missing }).blocked?.reason ?? null;
}
