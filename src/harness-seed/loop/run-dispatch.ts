/**
 * Starting a run: the refusals a run meets before it is registered, the loop that conducts it, and
 * the record a run that died still owes its chat.
 */
import { type FactsOfDescriptor, kindUnknown, startWebIfPending } from "./folder-facts.ts";
import { leadsInPlace } from "./engine-seat.ts";
import { OPEN_LOOP_REFUSAL } from "./open-loop-prompts.ts";
import { EngineId, withRoles } from "./model-roles.ts";
import { runDirector } from "./director.ts";
import { createRunInbox } from "./run-inbox.ts";
import { HostMethod } from "./host-methods.ts";
import { journalId, readJournal } from "./run-journal.ts";
import { runRef } from "./repo.ts";
import { EventKind, ExecutionStatus, RunEvent, writeRunArtifact } from "./run-events.ts";
import { type ActiveRun, RunnerKind, type RunStart, type Studio, heldRuns } from "./studio-state.ts";
import { resumeStopped } from "./after-loop-run.ts";
import { forgetProviderLosses } from "./provider-loss.ts";
import type { AnyRecord, ForwardedCall, HarnessCtx, HarnessEvent, Host, HostCall, Run } from "../types/harness.d.ts";
import type { EngineDescriptor, GameProject } from "../types/host-api.d.ts";

/**
 * Why a run's start was refused (`refusal` on `run_start_blocked`, beside its `reason` for the
 * chat). The app reads it (its copy is `RunStartRefusal` in `shared/custom-events.ts`): never
 * rename a value. It lives here, beside the one module that writes it, so a kept copy of any
 * other loop file from before it still loads with this one.
 */
export const RunStartRefusal = {
  /** A run already owns the chat or the game. */
  RunOwnsThread: "run_owns_thread",
  /** The folder is an engine's export: compiled, with nothing a run could edit. */
  EngineExport: "engine_export",
  /**
   * Genex's `web.ready` gate: the web page lacked files it needs to load. Written only by seeds from
   * before its finding became a line the Loop's lead reads at its start: old records carry it.
   */
  WebNotReady: "web_not_ready",
} as const;
export type RunStartRefusal = (typeof RunStartRefusal)[keyof typeof RunStartRefusal];

/** What the chat and the run record are told. */
const MESSAGE = {
  runOwnsThread: "A run already owns this thread or project.",
  noJournal: "no resumable journal for this run — it may predate Autopilot or have been archived",
  alreadyBuilding: (project: string) =>
    `A build is already running for **${project}** — nothing new was started. Ask here about the one that is running, or stop it first.`,
  engineExport: (name: string | undefined) =>
    `${name} was exported from a game engine, so the studio cannot edit it — it can only open it, play it and take screenshots. Open the folder with the project's own scenes and scripts, and start the build there.`,
  stoppedBeforeStart: "Stopped before the build started — nothing was built.",
  olderBuild:
    "This build was paused by an earlier version of Genex and can't go on in this one, so it is closed as it stood: what it built is kept. Ask here for what you want next.",
} as const;

/** The ref an earlier web game's Loop kept its integration branch on (repo.ts `runRef`). */
const WEB_LOOP_BRANCH = "integration";

/** How a runner is called: the thread the run tells its story in, the run, whether it resumes, and the engines. */
type Runner = (
  ctx: HarnessCtx,
  options: { threadId: string; run: Run; resume: boolean; described: readonly EngineDescriptor[] },
) => Promise<AnyRecord>;

/**
 * Why a Loop did not run at all, typed on its close (`refusal` on its `run_finished` report) beside
 * the words the chat reads. The app words it by this code: never rename a value.
 */
export const LoopRefusal = {
  /** The engine keeps no session of its own (Ollama's tool loop): its chat is plain chat, and a Loop needs a lead's session. */
  NeedsSession: "needs_session",
} as const;
export type LoopRefusal = (typeof LoopRefusal)[keyof typeof LoopRefusal];

const RUNNERS: Record<RunnerKind, Runner> = {
  // The one Loop, led in the game folder by the chat's own session, on a project of any kind.
  [RunnerKind.Director]: (ctx, options) => runDirector(ctx, options),
  [RunnerKind.NeedsSession]: (ctx, options) =>
    refusedRun(ctx, options, OPEN_LOOP_REFUSAL.needsSession(engineName(options.run, options.described)), {
      refusal: LoopRefusal.NeedsSession,
    }),
};

/** The run's engine as the person knows it: its listed name, else its id. */
function engineName(run: Run, described: readonly EngineDescriptor[]): string {
  const engine = run.engine ?? EngineId.Ollama;
  return described.find((listed) => listed.id === engine)?.label ?? engine;
}

/**
 * Which loop conducts `run`. Every Loop is its lead's session, in place, on a project of any kind.
 * An engine that keeps no session of its own
 * (Ollama's tool loop) leads none: its run is refused with a typed reason (`LoopRefusal.NeedsSession`)
 * and its chat stays plain chat.
 */
export function chooseRunner(run: Run, described: readonly EngineDescriptor[]): RunnerKind {
  const engine = described.find((e) => e.id === (run.engine ?? EngineId.Ollama));
  return leadsInPlace(engine) ? RunnerKind.Director : RunnerKind.NeedsSession;
}

/**
 * What a refusal's close keeps of the run's earlier close: what was built and where it stands (in
 * the game folder or not, its workers, rounds, save points and notes). How that session stopped (a
 * provider's limit, its stop code, its failure, where its worked time ended) is never kept: the
 * refusal is the stop now, read in its own words.
 */
const KEPT_ON_REFUSAL = [
  "landed",
  "baseCommit",
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

/** The parts of an earlier close a refusal keeps (`KEPT_ON_REFUSAL`); a build it closes keeps its outcome too. */
function keptOfEarlier(earlier: AnyRecord | null, closes: boolean): AnyRecord {
  if (!earlier) return {};
  const kept: AnyRecord = {};
  for (const key of KEPT_ON_REFUSAL) if (key in earlier) kept[key] = earlier[key];
  if (closes && typeof earlier.victory === "boolean") kept.victory = earlier.victory;
  return kept;
}

/**
 * A run refused with words before it did anything: its start and its close, `stoppedBecause` the
 * words, and its report. Nothing was built this time. A resumed run stays paused (Resume picks it up
 * once the cause is fixed) and keeps what its earlier session built (`KEPT_ON_REFUSAL`, under the
 * refusal's own outcome). A paused build no Resume can pick up (`closes`) is closed as it stood, its
 * report and outcome kept too, and the chat says why it was not picked up.
 */
async function refusedRun(
  ctx: HarnessCtx,
  { threadId, run, resume = false }: { threadId: string; run: Run; resume?: boolean },
  words: string,
  { closes = false, refusal = null }: { closes?: boolean; refusal?: LoopRefusal | null } = {},
) {
  const paused = resume && !closes;
  // Every reader takes the latest close as the truth: the earlier session's build, workers and notes stay on it.
  const earlier = resume ? await latestClose(ctx, threadId, run.runId) : null;
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
    ...keptOfEarlier(earlier, closes),
    runId: run.runId,
    project: run.project,
    goal: run.goal,
    executionStatus: paused ? ExecutionStatus.Paused : ExecutionStatus.Completed,
    ...(paused ? { paused: true } : {}),
    stoppedBecause: words,
    ...(refusal ? { refusal } : {}),
    finishedAt: new Date().toISOString(),
  };
  const pausedRecord = customEvent(RunEvent.AutopilotPaused, { runId: run.runId, project: run.project });
  await ctx.call(HostMethod.EventsAppend, {
    threadId,
    batch: [
      customEvent(RunEvent.RunStarted, started),
      customEvent(RunEvent.RunFinished, report),
      ...(paused ? [pausedRecord] : []),
      ...(closes && earlier ? [assistantSays(words)] : []),
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

/** Did this record register `runId` (a start, or a Resume starting it again)? */
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

/** When a run is over: `closed` settles, and each record of it is marked done. */
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
 * end) is past its close — or `stopped` when Stop reached such a run while
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
 * reservation holds from before the first await until the run is over. A
 * run that has closed, or has begun writing its end (a pause the chat can already read), holds them
 * only through its close: a new start waits that out, and does not start when
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
  // Reserve before the first await, including resumed runs.
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
        refusal: RunStartRefusal.RunOwnsThread,
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
  // can never build on refuses here as well, before a run is registered. What is merely missing (a
  // web page's files) refuses nothing: the Loop's lead reads it as it starts, and builds there.
  const games = await host.call(HostMethod.GameList, {}).catch(() => []);
  const listed = games.find((g) => g.name === action.run.project) ?? null;
  const refused = loopRunRefused(listed);
  if (refused) {
    const { reason, refusal } = refused;
    await host.call(HostMethod.EventsAppend, {
      threadId,
      batch: [
        customEvent(RunEvent.RunStartBlocked, { requestedRunId: action.run.runId, reason, refusal }),
        assistantSays(reason),
      ],
    });
    return;
  }
  // One pick, three jobs: the spec arrives with the composer's model and leaves here with
  // its planner, builders and critics resolved (model-roles.ts). A resumed run keeps the
  // roles it was launched with.
  const run = withRoles(action.run as Run);
  if (studio.cancels.has(threadId)) {
    // The chat was promised a build: it is told that none started.
    await host
      .call(HostMethod.EventsAppend, { threadId, batch: [assistantSays(MESSAGE.stoppedBeforeStart)] })
      .catch(() => {});
    return;
  }
  // The close marks the entry done (live-chat.ts): the chat is free from then.
  const active: ActiveRun = { run, threadId, settled, closed: close.closed };
  close.holders.push(active);
  studio.activeRuns.set(run.runId, active);
  const ctx = markingEnd(studio.scoped(threadId), run.runId, close);
  ctx.setStatus(`run ${run.runId}`);
  host.notify("run.keepawake", { runId: run.runId });
  try {
    await conductRun(host, ctx, run, action.resume === true, { closed: close.close });
  } catch (err: any) {
    await closeFailedRun(host, ctx, run, err);
  } finally {
    close.close();
    studio.activeRuns.delete(run.runId);
    ctx.setStatus("idle");
    // Terminal, always: the run is over. The app holds the Mac awake until this.
    host.notify("run.settled", { runId: run.runId });
  }
}

/** The run as its conduct reaches it: its close, said as soon as the run is over. */
interface Conduct {
  closed: () => void;
}

/**
 * Register the run and conduct it with the loop it calls for. `closed` is said as soon as the run is
 * over: the chat is free from then.
 */
async function conductRun(host: Host, ctx: HarnessCtx, run: Run, resume: boolean, { closed }: Conduct): Promise<void> {
  const { threadId } = ctx;
  await host.call(HostMethod.EventsAppend, {
    threadId,
    batch: [customEvent(RunEvent.RunRegistered, { ...run, reference: { name: run.reference?.name }, resumed: resume })],
  });
  const inbox = createRunInbox(ctx, { threadId, runId: run.runId });
  ctx.runInbox = inbox;
  const described = await host.call(HostMethod.EngineDescribe, {}).catch(() => []);
  // A run (a Resume included) starts trusting its providers again: a loss was the last stretch's.
  forgetProviderLosses(run.runId);
  const runner = runnerFor(run, described, await routeOf(host, run, { threadId, resume }));
  const report = await runner(ctx, { threadId, run, resume, described });
  closed();
  host.notify("run.finished", report);
}

/**
 * The journal a resumed run goes on from, or null. A journal the host can't read throws: read as
 * none, the run would start over from its goal.
 */
async function resumedJournal(host: Host, threadId: string, runId: string): Promise<AnyRecord | null> {
  return (await host.call(HostMethod.ArtifactRead, { threadId, artifactId: journalId(runId) })) ?? null;
}

/** How a run is routed: why it is refused, or whether it is a paused build of a kind no Loop picks up. */
interface Route {
  refusal: string | null;
  /** A paused build no Loop is now: the classic pipeline's, or the Unreal runner's (no `director`). */
  olderBuild?: true;
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

/**
 * How a paused run's journal goes on: in place (`director.open`, the one Loop's), refused with its
 * branch named (a web game's Loop that built in a copy: `director`, and no `open`), or closed as it
 * stood (any other: the classic pipeline's, the Unreal runner's). A fresh run has none.
 */
function resumedRoute(journal: AnyRecord | null, runId: string): Route | null {
  if (!journal || journal.director?.open) return null;
  if (journal.director) return { refusal: OPEN_LOOP_REFUSAL.webLoopBefore(runRef(runId, WEB_LOOP_BRANCH)) };
  return { refusal: null, olderBuild: true };
}

/**
 * The run's route (`Route`): a resumed run by its own journal (`resumedRoute`). A journal the host
 * can't read, or a game list it can't give, refuses the run with words (a resume stays paused). A
 * game with no kind yet takes the web starter before the Loop starts, but never under a paused Loop,
 * nor a resumed one on a folder of a kind Genex can't name.
 */
async function routeOf(host: Host, run: Run, { threadId, resume }: { threadId: string; resume: boolean }) {
  let journal: AnyRecord | null = null;
  try {
    journal = resume ? await resumedJournal(host, threadId, run.runId) : null;
  } catch {
    return { refusal: OPEN_LOOP_REFUSAL.journalUnreadable };
  }
  const resumed = resumedRoute(journal, run.runId);
  if (resumed) return resumed;
  const games = await listedGames(host);
  if (!games) return { refusal: OPEN_LOOP_REFUSAL.gamesUnreadable };
  const game = games.find((listed) => listed.name === run.project);
  const unknownOnResume = resume && game !== undefined && kindUnknown(game);
  if (!journal && !unknownOnResume) await startWebIfPending(host, run.project, games);
  return { refusal: null };
}

/** A runner that closes a paused build no Resume can pick up as it stood, its work kept, and says why. */
const closingOlderBuild: Runner = (ctx, options) => refusedRun(ctx, options, MESSAGE.olderBuild, { closes: true });

/** A runner that only refuses the run with `words` (paused for a Resume when it resumes one). */
const refusing =
  (words: string): Runner =>
  (ctx, options) =>
    refusedRun(ctx, options, words);

/** Which runner conducts the run: its route's refusal, a paused build of a kind no Loop is now, or its engine's. */
function runnerFor(run: Run, described: readonly EngineDescriptor[], route: Route): Runner {
  if (route.refusal) return refusing(route.refusal);
  const kind = chooseRunner(run, described);
  // The one Loop can't pick up such a build: it would start it again from its goal.
  if (route.olderBuild && kind === RunnerKind.Director) return closingOlderBuild;
  return RUNNERS[kind];
}
/** A run that threw: its closing record (unless it wrote its own) and the error, then the push. */
async function closeFailedRun(host: Host, ctx: HarnessCtx, run: Run, err: any): Promise<void> {
  const { threadId } = ctx;
  const failure = err?.message ?? String(err);
  try {
    // Durable closure before any UI push: an unmatched run_started reads as a run still
    // going, and a notify dies with the window while the log survives the run. But the
    // run may have written its own run_finished before dying, and a second closure would
    // overwrite its outcome in every reader that keeps the last word. Only this session's close
    // counts: a run started again (a Resume) has an earlier session's close in the log, which is
    // not this one's.
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
 * One refusal, about the folder rather than the model: an engine export is already compiled — there
 * is no source to edit and no contract to read, so the run would photograph a page nobody can change
 * (Godot/Unity exports); the studio still opens it, plays it and screenshots it. Nothing else
 * refuses: a web page missing files it needs to load is what Genex's own `web.ready` gate tells the
 * Loop's lead as it starts (builtin-hooks.ts, read in director.ts), and the lead builds in that very
 * folder. `problems` and `missing` decide nothing here; the parameters stay for the callers that
 * hand them (an agent may have kept one).
 */
export function loopRunRefusal(
  descriptor: LoopRunFolder,
  _problems: readonly string[] | null | undefined,
  _missing?: unknown,
): string | null {
  return loopRunRefused(descriptor)?.reason ?? null;
}

/** The folder a run would be spent on, as `game.list` describes it. */
type LoopRunFolder = (FactsOfDescriptor & { name?: string; shape?: { kind?: string } | null }) | null | undefined;

/**
 * {@link loopRunRefusal} with its code: the sentence for the chat and the `RunStartRefusal` the
 * start's `run_start_blocked` records beside it, or null to launch.
 */
export function loopRunRefused(descriptor: LoopRunFolder): { reason: string; refusal: RunStartRefusal } | null {
  if (descriptor?.shape?.kind !== "engine-export") return null;
  return { reason: MESSAGE.engineExport(descriptor.name), refusal: RunStartRefusal.EngineExport };
}
