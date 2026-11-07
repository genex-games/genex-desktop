/**
 * One user message, from the queue to its answer, always the chat's own turn: which run (if any) it
 * belongs to; after a closed Loop run, the run's controls on that turn (after-loop-run.ts); then the
 * paused run it resumes, and the Loop the turn started.
 */
import { runTurn, type TurnOptions, type TurnOutcome } from "./turn-loop.ts";
import { sayInTurn, turnFailureOf, TurnStatus, TurnStop } from "./turn-record.ts";
import { dropSteeringBacklog } from "./steering-backlog.ts";
import { afterLeadLoopRun, holdsSession, resumeAfterReply, type AfterLoopRun } from "./after-loop-run.ts";
import { conversationThrough, latestRun } from "./run-inbox.ts";
import { eventsToMessages } from "./prompt.ts";
import { EngineId, hasSessionRoles } from "./model-roles.ts";
import { ProjectStarter, startWebIfPending } from "./folder-facts.ts";
import { HostMethod } from "./host-methods.ts";
import { EventKind, RunEvent, RunState } from "./run-events.ts";
import { handleRunStart, loopRunRefusal } from "./run-dispatch.ts";
import { runUnderWay } from "./live-chat.ts";
import { type ActiveRun, StatusLane, type Studio } from "./studio-state.ts";
import { CLIP_GAME_TITLE } from "./text.ts";
import { type StoreItem, storeItemsOf, storeLaunchWords, storeScopeItems } from "./store-items.ts";
import { closeCarriedPool } from "./workers/carry.ts";
import { workAskOf, workBudget } from "./work-time.ts";
import type { AnyRecord, ForwardedCall, HarnessCtx, Host, HostCall } from "../types/harness.d.ts";
import type { ModelPreferences, RunSpec } from "../types/host-api.d.ts";
import { type QueueAction, type SteerHandle } from "./message-queue.ts";

/** The folder a run builds in when neither the chat nor the interview names one. */
const FALLBACK_PROJECT = "game";
/** A goal that says nothing: empty, or a missing value spelled out. */
const EMPTY_GOALS = new Set(["", "undefined", "null"]);
/** The session phase a stopped turn leaves on its thread (`session_activity`). */
const INTERRUPTED_PHASE = "interrupted";

/** What the chat is told. */
const MESSAGE = {
  noGoal: "no usable goal — call the launch tool again with a real `goal` instead of launching",
  alreadyBuilding: (project: string) =>
    `a build is already running for ${project} — wait for it to finish, or stop it, before starting another`,
  couldNotLaunch: (failure: string) => `the run could not launch: ${failure}`,
  stoppedBeforeLaunch: "it was stopped before it started, and nothing new was started",
  stoppedBeforeTurn: "Stopped before it started — nothing was done. Send a message to go on.",
  turnFailed: (failure: unknown) => `turn failed: ${failure}`,
} as const;

/** The run a message belongs to, when it names one (the queued action carries the same fields). */
type RunRecord = AnyRecord;

/**
 * Answer one user message: route it, run its turn, and launch the Loop that turn started.
 * `steer` is the queue's door into this turn for what the person sends while it works
 * (chat-steer.ts); Studio's own chat never takes it.
 */
export async function handleUserMessage(studio: Studio, action: QueueAction, steer?: SteerHandle): Promise<void> {
  const steering = steer && !action.studioThread ? steer : undefined;
  // A turn answered by a session: what is sent while it is set up joins it (Sending…), instead
  // of showing as Queued until the session starts. Known by the engine's name at once; any
  // other session engine is found by its description below, once the turn's engine is known.
  if (steering && hasSessionRoles(action.engine)) await steering.expect();
  // Its settings as the person sent them: what a message sent while it works is weighed against
  // (turn-switch.ts), as the queue weighs it.
  const asked: QueueAction = { ...action };
  const existing = await routeMessage(studio, action);
  const after = existing ? await afterLoopRunFor(studio.host, action, existing) : null;
  const ctx = studio.scoped(action.threadId, StatusLane.Chat);
  const metadata = turnMetadata(action, after);
  if (steering && (await holdsSession(studio.host, metadata.engine))) await steering.expect();
  // A build's late steering stays with that build: the section older builds left in NOTES.md goes
  // before the chat answers, so no later agent reads it as its own instruction.
  if (!action.studioThread) await dropSteeringBacklog(studio.host, action.project);

  ctx.setStatus("thinking");
  const turn = await studio.host.call(HostMethod.TurnBegin, {
    threadId: action.threadId,
    input: userInput(action),
    metadata,
  });
  try {
    // Stopped before its turn began: nothing answers it, and the chat is told.
    if (ctx.cancelled) await stoppedBeforeTurn(studio.host, ctx, turn.turnId);
    else await answerMessage(studio, ctx, action, { turnId: turn.turnId, after, asked }, steering);
  } catch (err: any) {
    await failChatTurn(studio.host, ctx, turn.turnId, err);
  } finally {
    studio.stoppedMessages?.delete(String(action.messageId));
    ctx.setStatus("idle");
  }
}

/** A turn the user stopped before it began: said in the chat, then ended as interrupted. */
async function stoppedBeforeTurn(host: Host, ctx: HarnessCtx, turnId: string): Promise<void> {
  await sayInTurn(ctx, turnId, MESSAGE.stoppedBeforeTurn);
  await endInterrupted(host, turnId);
}

/** The engine and model a turn is recorded on: the message's, or the lead's session's after its run. */
function turnMetadata(action: QueueAction, after: AfterLoopRun | null): { engine: string; model?: string } {
  const engine = after?.engine ?? action.engine ?? EngineId.Ollama;
  const model = after ? after.model : action.model;
  return { engine, ...(model ? { model } : {}) };
}

/** Does this run own the message's thread or the game the message is about? */
function ownsMessage(active: ActiveRun, action: QueueAction): boolean {
  if (active.threadId === action.threadId) return true;
  return Boolean(action.project) && active.run.project === action.project;
}

/**
 * The run a message is for: the one under way on its thread or game, else the thread's last one.
 * A run that has closed is the log's (finished or paused).
 */
async function routeMessage(studio: Studio, action: QueueAction): Promise<RunRecord | null> {
  // A message never clears an active run's stop flag. Cancellation is an explicit action; a run
  // that has closed (a Stop's, settling) no longer holds it.
  const active = [...studio.activeRuns.values()].find((a) => ownsMessage(a, action) && !a.done);
  // A Stop pressed for this very message (still sending, or waiting at the front) is kept.
  const stoppedFirst = studio.stoppedMessages?.has(String(action.messageId)) === true;
  if (!active && !stoppedFirst) studio.cancels.delete(action.threadId);
  const previousRun = latestRun(await studio.host.call(HostMethod.EventsList, { threadId: action.threadId }));
  return existingRun(action, active, previousRun);
}

function existingRun(action: QueueAction, active: ActiveRun | undefined, previousRun: RunRecord | null) {
  // Older profiles recorded game runs in Studio. They remain history, never authority to
  // answer a new Studio question as that game's run or start another build.
  if (action.studioThread) return null;
  if (active) return active.run;
  // A New build queued before the composer dropped it still starts afresh.
  const startsAfresh = action.newRun === true && previousRun?.state === RunState.Finished;
  return startsAfresh ? null : previousRun;
}

/** The user's words as the turn's input; a queued message is already in the log. */
function userInput(action: QueueAction) {
  return action.messageId ? [] : [{ role: "user" as const, content: action.text as string }];
}

/** The turn a message is answered in: its id, the closed run it answers after, and the message as sent. */
interface AnswerTurn {
  turnId: string;
  after: AfterLoopRun | null;
  /** The message's settings as the person sent them. */
  asked: QueueAction;
}

/**
 * The turn itself, the chat's own — after a closed Loop run with the run's controls — then what the
 * reply asked for.
 */
async function answerMessage(
  studio: Studio,
  ctx: HarnessCtx,
  action: QueueAction,
  turn: AnswerTurn,
  steer: SteerHandle | undefined,
): Promise<void> {
  const { turnId, after } = turn;
  const turnCtx = threadViewCtx(ctx, action);
  const outcome = await runTurn(turnCtx, chatTurnOptions(action, turnId, steer, after, turn.asked));
  if (ctx.cancelled) {
    // A Stop the engine answered with a stopped result reads as one it threw (`failChatTurn`).
    await endInterrupted(studio.host, turnId);
    return;
  }
  // How the loop ended it stays on the turn's own record: a throttled or round-capped turn is not
  // an answer.
  const stopped = outcome?.stopped;
  await studio.host.call(HostMethod.TurnEnd, {
    turnId,
    status: TurnStatus.Ok,
    ...(stopped ? { outcome: stopped } : {}),
  });
  await afterTheReply(studio, ctx, action, outcome, after);
}

/**
 * The closed Loop run the chat's own session answers after (after-loop-run.ts), with the message it
 * answers; null for a plain turn: a run under way, a run whose journal seated no lead, or an engine
 * without sessions.
 */
async function afterLoopRunFor(host: Host, action: QueueAction, existing: RunRecord): Promise<AfterLoopRun | null> {
  const loopRun = await afterLeadLoopRun(host, action, existing);
  if (!loopRun) return null;
  return { ...loopRun, ...(action.messageId ? { messageId: action.messageId } : {}) };
}

/**
 * What the reply asked for, done once it has ended: the paused run the chat's own session asked to
 * resume, or the Loop it started.
 */
async function afterTheReply(
  studio: Studio,
  ctx: HarnessCtx,
  asked: QueueAction,
  outcome: TurnOutcome | undefined,
  after: AfterLoopRun | null,
): Promise<void> {
  // A message sent while the turn worked may have changed its settings: what it asked for follows them.
  const action = followedSettings(asked, outcome);
  const resume = after ? outcome?.details?.resumeRun : null;
  if (after && resume) return resumeAfterReply(studio, ctx, after, resume);
  const spec = outcome?.stopped === TurnStop.LaunchRun ? outcome.details?.run : null;
  if (spec) await launchOrSayWhy(studio, ctx, action, spec);
}

/** The settings a message switched the turn to (turn-switch.ts), on the message it answers; it as it was when none did. */
function followedSettings(action: QueueAction, outcome: TurnOutcome | undefined): QueueAction {
  const followed = outcome?.details?.followed;
  if (!followed || typeof followed !== "object") return action;
  const settled: QueueAction = { ...action };
  for (const field of FOLLOWED_FIELDS) {
    if (followed[field] === undefined) delete settled[field];
    else settled[field] = followed[field];
  }
  return settled;
}

/** The settings a switch carries onto the message a turn answers: engine, model, effort, preferences and roles. */
const FOLLOWED_FIELDS = ["engine", "model", "effort", "preferences", "roles"] as const;

/**
 * The ctx the chat's own turn runs with: a queued message sees its thread only up to itself.
 * The live `cancelled` getter is kept; an object spread would freeze cancellation at turn start.
 */
function threadViewCtx(ctx: HarnessCtx, action: QueueAction): HarnessCtx {
  const turnCtx: HarnessCtx = {
    ...ctx,
    call: (async (method: string, p?: AnyRecord) => {
      const readsLog = method === HostMethod.EventsList || method === HostMethod.EventsMessages;
      const readsThisThread = readsLog && p?.threadId === action.threadId;
      if (action.messageId && readsThisThread) {
        const view = conversationThrough(await ctx.call(HostMethod.EventsList, p), action.messageId);
        return method === HostMethod.EventsMessages ? eventsToMessages(view) : view;
      }
      return (ctx.call as ForwardedCall)(method, p);
    }) as HostCall,
  };
  // Preserve the live getter; object spread would freeze cancellation at turn start.
  Object.defineProperty(turnCtx, "cancelled", { get: () => ctx.cancelled });
  return turnCtx;
}

/** A chat turn's options: the message's own fields, and the optional ones only when set. */
function chatTurnOptions(
  action: QueueAction,
  turnId: string,
  steer: SteerHandle | undefined,
  after: AfterLoopRun | null,
  asked: QueueAction = action,
): TurnOptions {
  return {
    text: action.text,
    threadId: action.threadId,
    turnId,
    engine: action.engine ?? EngineId.Ollama,
    model: action.model,
    effort: action.effort,
    preferences: action.preferences,
    project: action.project,
    newProject: action.newProject,
    studioThread: action.studioThread,
    resume: action.resume,
    ...(action.projectDir ? { projectDir: action.projectDir } : {}),
    ...(action.extraReads ? { extraReads: action.extraReads } : {}),
    ...(action.stills ? { stills: action.stills } : {}),
    ...(action.roles ? { roles: action.roles } : {}),
    ...(steer ? { steer } : {}),
    ...(after ? afterLoopRunOptions(after) : {}),
    // The message whose settings the turn follows, as it was sent: one sent meanwhile may change them (turn-switch.ts).
    asked,
  };
}

/**
 * The chat's own session after a closed Loop run: the run it answers after, on the turn's engine —
 * the message's, else the lead's — and, on the lead's engine when the message names none, on the
 * model the lead ran on: the same session on the same model, which a Resume's lead continues.
 */
function afterLoopRunOptions(after: AfterLoopRun): Partial<TurnOptions> {
  return { afterLoopRun: after, engine: after.engine, ...(after.model ? { model: after.model } : {}) };
}

/** Launch the Loop the chat's turn started, or say in the chat why it did not start. */
async function launchOrSayWhy(studio: Studio, ctx: HarnessCtx, action: QueueAction, spec: AnyRecord): Promise<void> {
  const { host } = studio;
  await launchFromIntake(studio, ctx, action, spec).catch(async (err: any) => {
    // The workers the turn left for this build to take over stop: no build takes them.
    await closeCarriedPool(action.threadId);
    const failure = err?.message ?? String(err);
    // A launch that dies before run_started needs no run_finished — but it still owes the
    // chat a durable word, not just a push that vanishes with the window.
    await host
      .call(HostMethod.EventsAppend, {
        threadId: action.threadId,
        batch: [{ type: EventKind.Error, message: MESSAGE.couldNotLaunch(failure) }],
      })
      .catch(() => {});
    host.notify("run.failed", { error: failure });
  });
}

/** A stopped turn's durable trace: it says it was interrupted, and ends cancelled. */
async function endInterrupted(host: Host, turnId: string): Promise<void> {
  await host.call(HostMethod.TurnAppend, {
    turnId,
    batch: [{ type: EventKind.Custom, event_type: RunEvent.SessionActivity, payload: { phase: INTERRUPTED_PHASE } }],
  });
  await host.call(HostMethod.TurnEnd, { turnId, status: TurnStatus.Cancelled });
}

/** A turn that threw: a stop is an interruption, anything else an error the chat is told about. */
async function failChatTurn(host: Host, ctx: HarnessCtx, turnId: string, err: any): Promise<void> {
  if (ctx.cancelled) {
    await endInterrupted(host, turnId);
    return;
  }
  await host.call(HostMethod.TurnAppend, {
    turnId,
    batch: [{ type: EventKind.Error, message: MESSAGE.turnFailed(err?.message ?? err) }],
  });
  // Why it failed, in typed words the app counts turns by: the message stays in the chat.
  await host.call(HostMethod.TurnEnd, { turnId, status: TurnStatus.Error, failure: turnFailureOf(err) });
  host.notify("chat.error", { message: err?.message ?? String(err) });
}

/**
 * Launch a Loop the chat's turn started (or a finishing Loop asked for next, next-loop.ts). Throws
 * the sentence the chat is owed when it cannot start: no goal, a folder that refuses, or a build
 * already running for this chat or game.
 */
export async function launchFromIntake(
  studio: Studio,
  ctx: HarnessCtx,
  action: QueueAction,
  spec: AnyRecord,
): Promise<void> {
  const { host } = studio;
  requireGoal(spec);
  const games = await host.call(HostMethod.GameList, {});
  const project = intakeProject(action, spec, games);
  // A Loop with no game yet makes a web game; one on a game with no kind starts it as one.
  if (!games.some((g) => g.name === project)) {
    await ctx.call(HostMethod.GameScaffold, {
      name: project,
      title: spec.goal?.slice(0, CLIP_GAME_TITLE) || project,
      threadId: action.threadId,
      kind: ProjectStarter.Web,
    });
  }
  await startWebIfPending(host, project, games);
  // What the folder itself refuses (loopRunRefusal): a game that is already compiled. Said in chat
  // now, instead of found out at 3am. A page missing its files refuses nothing: the Loop's lead
  // reads that as it starts, and builds them.
  const readiness = await host.call(HostMethod.GameValidate, { project }).catch(() => null);
  const refusal = loopRunRefusal(
    games.find((g) => g.name === project) ?? null,
    readiness?.problems ?? [],
    readiness?.missing,
  );
  if (refusal) throw new Error(refusal);
  // A second Loop for a game that already owns a run is refused as it starts, in an event no chat
  // surface renders: asked here, the chat is told why — once a run that has closed there has
  // settled, which a new run waits out.
  const busy = await runUnderWay(studio, action.threadId, project);
  if (busy) throw new Error(MESSAGE.alreadyBuilding(busy.run.project));
  // Stop while that pass was waited out was for this run too.
  if (ctx.cancelled) throw new Error(MESSAGE.stoppedBeforeLaunch);
  // What the user sells in the Genex store rides the run's goal; the build lists each item once it
  // has drawn its picture, since the store takes none without one.
  const store = storeItemsOf(spec.storeItems);
  const run = intakeRun(spec, action, project, store);
  const sells = storeLaunchWords(store);
  if (sells)
    await host
      .call(HostMethod.EventsAppend, {
        threadId: action.threadId,
        batch: [{ type: EventKind.Messages, messages: [{ role: "assistant", content: sells }] }],
      })
      .catch(() => {});
  // Same thread: the run is this chat's story. handleRunStart holds keep-awake via notify.
  // The launch is handled here, so a restart cannot replay it. Synchronous run
  // reservation keeps later queued messages behind the build until it saves and settles.
  // A Stop since this message is for this build: the start keeps it (`keepStop`).
  void handleRunStart(studio, { type: "run_start", threadId: action.threadId, run }, { keepStop: true })
    .catch((err: unknown) => host.notify("run.failed", { error: String(err) }))
    // The workers the turn left for this build stop once it is over, if its run never took them (refused at its start).
    .finally(() => closeCarriedPool(action.threadId));
}

/**
 * A run without a goal is judged against nothing — one interview leaked its goal into the
 * reference field and a 4-hour run launched with goal "undefined". Refuse loudly instead.
 */
function requireGoal(spec: AnyRecord): void {
  const goal = typeof spec.goal === "string" ? spec.goal.trim() : "";
  if (EMPTY_GOALS.has(goal)) throw new Error(MESSAGE.noGoal);
}

/**
 * Where the run builds is the chat's answer, never the interviewer's. A thread bound to a
 * folder keeps it; otherwise the loop's own resolved folder rides on the spec (turn-loop
 * stamps it), and only a chat with no folder at all falls back to the tool's slug. The
 * slug once won over the binding and the run built in a second, empty folder — with the
 * user typing into the chat attached to the first.
 */
function intakeProject(action: QueueAction, spec: AnyRecord, games: readonly { name: string }[]): string {
  const bound = typeof action.project === "string" && games.some((g) => g.name === action.project);
  if (bound) return action.project;
  const named = typeof spec.project === "string" ? spec.project.trim() : "";
  return named || FALLBACK_PROJECT;
}

/** The goal a launch runs: the chat's goal, and what it sells in the Genex store when it sells anything. */
function intakeGoal(spec: AnyRecord, store: readonly StoreItem[]): string {
  const goal = String(spec.goal ?? "").trim();
  const items = storeScopeItems(store);
  return items.length ? `${goal}\n\nSell in the Genex store: ${items.join("; ")}.` : goal;
}

/** The Loop a launch starts, as `run_start` takes it. */
function intakeRun(
  spec: AnyRecord,
  action: QueueAction,
  project: string,
  store: readonly StoreItem[] = [],
): RunSpec & AnyRecord {
  return {
    runId: `run_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    goal: intakeGoal(spec, store),
    project,
    reference: spec.reference,
    budgets: launchBudgets(spec),
    ...(spec.mode ? { mode: spec.mode } : {}),
    ...(spec.engine ? { engine: spec.engine } : {}),
    ...(spec.model ? { model: spec.model } : {}),
    ...(spec.roles ? { roles: spec.roles } : {}),
    // The run inherits the chat's effort: workers work at exactly the model and effort the user
    // generates with, never a quieter tier than the chat that started them.
    ...commissionedWith(action),
  };
}

/** A launch's budgets: the time the person named for it (work-time.ts), and nothing else a launch could write there. */
function launchBudgets(spec: AnyRecord): AnyRecord {
  const ask = workAskOf(spec.budgets);
  return ask ? workBudget(ask.minutes) : {};
}

/** The effort and preferences a message's launch carries onto its build (`intakeRun`). */
function commissionedWith(action: QueueAction): { effort?: string; preferences?: ModelPreferences } {
  return {
    ...(action.effort ? { effort: action.effort } : {}),
    ...(action.preferences ? { preferences: action.preferences } : {}),
  };
}
