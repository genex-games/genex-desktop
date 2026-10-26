import { CompletionPolicy } from "./completion-policy.ts";
/**
 * One user message, from the queue to its answer: which run (if any) it belongs to, the turn that
 * answers it — the chat's own, after a run its lead led too (after-loop-run.ts), else the run's
 * coordinator — the follow-up a coordinator commissions, the paused run the chat's own session
 * resumes, the finished build it or the coordinator reopens with Loop on (reopen-run.ts), and the
 * run an interview launches.
 */
import { runTurn, type TurnOptions, type TurnOutcome } from "./turn-loop.ts";
import * as turnLoopParts from "./turn-loop.ts";
import { sayInTurn, TurnStatus, TurnStop } from "./turn-record.ts";
import { runCoordinatorTurn } from "./coordinator.ts";
import { type StopAsk, stopAfterReply, stopAskedFor } from "./chat-stop.ts";
import { dropSteeringBacklog } from "./steering-backlog.ts";
import * as coordinatorParts from "./coordinator.ts";
import * as coordinatorPromptsParts from "./coordinator-prompts.ts";
import * as chatSessionParts from "./chat-session.ts";
import * as delegatedTurnParts from "./delegated-turn.ts";
import * as afterLoopRunPromptsParts from "./after-loop-run-prompts.ts";
import * as runDispatchParts from "./run-dispatch.ts";
import { afterLeadLoopRun, resumeAfterReply, servesAfterLoopRun, type AfterLoopRun } from "./after-loop-run.ts";
import {
  commissionHours,
  finishedLoopRun,
  firstLoopUnused,
  keepsCommission,
  type ReopenAsk,
  reopenAfterReply,
  type ReopenModels,
  reopens,
  servesReopen,
} from "./reopen-run.ts";
import { MESSAGE as REOPEN_MESSAGE } from "./reopen-run-prompts.ts";
import { conversationThrough, latestRun } from "./run-inbox.ts";
import { eventsToMessages } from "./prompt.ts";
import { EngineId, hasSessionRoles, supportsSessions } from "./model-roles.ts";
import {
  factsOfGame,
  LoopProfile,
  loopProfileOf,
  openLoopBecause,
  ProjectStarter,
  startWebIfPending,
} from "./folder-facts.ts";
import { leadsInPlace } from "./engine-seat.ts";
import { OPEN_LAUNCH_WORDS, OPEN_LOOP_REFUSAL } from "./open-loop-prompts.ts";
import { openLoopServed } from "./open-loop-parts.ts";
import { servesOpenLoop } from "./director/open/contract.ts";
import { OLDER_LEAD_JOURNAL_KIND } from "./director/open/older-journal.ts";
import { withSteers } from "./chat-steer-prompts.ts";
import { HostMethod } from "./host-methods.ts";
import { StudioContract } from "./page-contract.ts";
import { EventKind, RunEvent, RunMode, RunState } from "./run-events.ts";
import { HOUR_MS } from "./time.ts";
import { endClock } from "./wall-clock.ts";
import { handleRunStart, loopRunRefusal } from "./run-dispatch.ts";
import { runUnderWay } from "./live-chat.ts";
import { readJournal } from "./run-journal.ts";
import { followupAsk } from "./studio-prompts.ts";
import { type ActiveRun, type RunReopen, StatusLane, type Studio } from "./studio-state.ts";
import { clampRunHours, MAX_RUN_HOURS } from "./config.ts";
import { CLIP_GAME_TITLE } from "./text.ts";
import { createScope, userWordsInLog } from "./scope.ts";
import { type StoreItem, storeItemsOf, storeLaunchWords, storeScopeItems } from "./store-items.ts";
import { closeCarriedPool } from "./workers/carry.ts";
import type { AnyRecord, ForwardedCall, HarnessCtx, HarnessEvent, Host, HostCall } from "../types/harness.d.ts";
import type { ModelPreferences, RunSpec } from "../types/host-api.d.ts";
import { messageQueueState, type QueueAction, type SteerHandle } from "./message-queue.ts";

/** The run an interview commissions when it names no length, in hours. */
const DEFAULT_RUN_HOURS = 8;
/** The folder a run builds in when neither the chat nor the interview names one. */
const FALLBACK_PROJECT = "game";
/** A goal that says nothing: empty, or a missing value spelled out. */
const EMPTY_GOALS = new Set(["", "undefined", "null"]);
/** The session phase a stopped turn leaves on its thread (`session_activity`). */
const INTERRUPTED_PHASE = "interrupted";

/** What the chat is told. */
const MESSAGE = {
  studioThreadBuilds:
    "Builds happen in a game's chat — this is the Studio's own chat, which never builds. Press Start a game in the sidebar, set the hours there, and describe a feeling.",
  noGoal:
    "the interview produced no usable goal — the intake tool call must carry a real `goal`; ask again instead of launching",
  alreadyBuilding: (project: string) =>
    `a build is already running for ${project} — wait for it to finish, or stop it, before starting another`,
  couldNotLaunch: (failure: string) => `the run could not launch: ${failure}`,
  stoppedBeforeLaunch: "it was stopped before it started, and nothing new was started",
  stoppedBeforeTurn: "Stopped before it started — nothing was done. Send a message to go on.",
  turnFailed: (failure: unknown) => `turn failed: ${failure}`,
  // What the user is owed before they walk away: when to come back, that the machine has to
  // stay awake, and that a paused run is not a lost one. "until satisfied" alone
  // answered none of those — the first real run ended on the plan's five-hour window at 105
  // of 180 minutes and nobody had been told that could happen.
  buildPromised: (end: string) => `Building until about ${end} — keep the app open and the computer awake. `,
  // ∞ has no end to promise; its 24 h ceiling is a date, since as a bare clock it is "now".
  untilSatisfiedPromised: (ceiling: string) =>
    `It finishes when the required outcomes are verified, with a safety stop by about ${ceiling} — keep the app open and the computer awake. `,
  planWindow:
    "Your plan's usage window can pause it partway; it waits out the reset and resumes itself, or one tap on Resume.",
  connectionFirst:
    " Your game doesn't have the studio's connection yet, so the first thing this build does is add it — without it nothing can tell whether a change made the game better.",
} as const;

/** The run a message belongs to, when it names one (the queued action carries the same fields). */
type RunRecord = AnyRecord;

/**
 * The parts the chat's own session after a lead's run depends on: the runner that picks its
 * turn, the turn, and its brief.
 */
const AFTER_LOOP_RUN_PARTS = [turnLoopParts, delegatedTurnParts, chatSessionParts];

/**
 * Does the chat after a lead's run go to the chat's own session (after-loop-run.ts)? Only when its
 * runner, its turn and its brief serve it: a kept copy of any from before could give that session
 * no run controls and tell it to pick up where it left off — then the coordinator answers, as before.
 */
export function ownSessionAfterLoopRun(): boolean {
  return servesAfterLoopRun(AFTER_LOOP_RUN_PARTS);
}

/**
 * What reopening a finished build depends on: the runner (its model), the turn (its tools), the note
 * (its words) and the run's start (its inbox from the ask, its own close).
 */
const REOPEN_PARTS = [turnLoopParts, delegatedTurnParts, afterLoopRunPromptsParts, runDispatchParts];

/**
 * May a Loop message after a finished build the chat's own session led reopen that same run
 * (reopen-run.ts)? A kept older runner, turn, note or start: the message is answered as with Loop off.
 */
export function ownSessionReopens(): boolean {
  return ownSessionAfterLoopRun() && servesReopen(REOPEN_PARTS);
}

/**
 * What the coordinator's reopen depends on: the coordinator (it passes the Loop on), its prompt (it
 * words it) and the run's start (its inbox from the ask, its own close).
 */
const COORDINATOR_REOPEN_PARTS = [coordinatorParts, coordinatorPromptsParts, runDispatchParts];

/**
 * May a Loop message after a finished build the run's coordinator answers for reopen it through the
 * coordinator's continue_build (reopen-run.ts `finishedLoopRun`)? A kept older coordinator, prompt or
 * start: the message is answered as with Loop off.
 */
export function coordinatorReopens(): boolean {
  return servesReopen(COORDINATOR_REOPEN_PARTS);
}

/**
 * Answer one user message: route it, run its turn, and launch the run an interview asked for.
 * `steer` is the queue's door into this turn for what the person sends while it works
 * (chat-steer.ts); Studio's own chat never takes it.
 */
export async function handleUserMessage(studio: Studio, action: QueueAction, steer?: SteerHandle): Promise<void> {
  const steering = steer && !action.studioThread ? steer : undefined;
  // A turn answered by a session: what is sent while it is set up joins it (Sending…), instead
  // of showing as Queued until the session starts. Known by the engine's name at once; any
  // other session engine is found by its description below, once the turn's engine is known.
  if (steering && hasSessionRoles(action.engine)) await steering.expect();
  // Its settings as the person sent them, before routing may drop its Loop: what a message sent
  // while it works is weighed against (turn-switch.ts), as the queue weighs it.
  const asked: QueueAction = { ...action };
  const existing = await routeMessage(studio, action);
  const loopRuns = await loopRunsFor(studio.host, action, existing);
  const { after } = loopRuns;
  carryMoodBoard(studio.moodBoards, action);
  const ctx = studio.scoped(action.threadId, StatusLane.Chat);
  if (steering) await expectSession(studio.host, action, existing, steering);
  if (asksStudioThreadToBuild(action)) return answerStudioThreadBuild(studio.host, ctx, action);
  // A build's late steering stays with that build: the section older builds left in NOTES.md goes
  // before the chat answers, so no later agent reads it as its own instruction.
  if (!action.studioThread) await dropSteeringBacklog(studio.host, action.project);

  ctx.setStatus("thinking");
  const turn = await studio.host.call(HostMethod.TurnBegin, {
    threadId: action.threadId,
    input: userInput(action),
    metadata: turnMetadata(action, after),
  });
  try {
    // Stopped before its turn began: nothing answers it, and the chat is told.
    if (ctx.cancelled) await stoppedBeforeTurn(studio.host, ctx, turn.turnId);
    else await answerMessage(studio, ctx, action, { turnId: turn.turnId, existing, asked, ...loopRuns }, steering);
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

/**
 * The turn's engine answers with a session: expect it. The message may name none, and its run's
 * engine answers (a second expect is harmless); any other session engine is known only by its
 * description.
 */
async function expectSession(
  host: Host,
  action: QueueAction,
  existing: RunRecord | null,
  steer: SteerHandle,
): Promise<void> {
  if (await answersInSession(host, turnEngine(action, existing))) await steer.expect();
}

/** The engine a message is answered on: its own, else its run's. */
function turnEngine(action: QueueAction, existing: RunRecord | null): string {
  return action.engine ?? existing?.engine ?? EngineId.Ollama;
}

/** Does this engine answer with a session: one known by name, or described so? */
async function answersInSession(host: Host, engine: string): Promise<boolean> {
  if (hasSessionRoles(engine)) return true;
  const described = await host.call(HostMethod.EngineDescribe, {}).catch(() => []);
  return supportsSessions(described.find((e) => e.id === engine));
}

/**
 * The runs a routed message answers after, resolved once: the chat's own session's (after-loop-run.ts)
 * — its engine and model are the turn's — or, for the run's coordinator, a finished build its
 * continue_build may reopen with the message's Loop. A message for a run drops its commission, so it
 * cannot commission a second run — unless the build it answers after may be reopened with it
 * (reopen-run.ts). Decided once: from here the turn takes the messages sent meanwhile with the
 * commission it kept (message-queue.ts). A Loop dropped after a finished build is `loopUnused`.
 */
async function loopRunsFor(host: Host, action: QueueAction, existing: RunRecord | null): Promise<RoutedLoopRuns> {
  if (!existing) return { after: null, coordinated: null, loopUnused: false };
  // Words the chat wrote itself are never the person asking for more: whatever Loop they came with.
  if (chatWrote(action)) dropCommission(action);
  const after = await afterLoopRunFor(host, action, existing);
  const coordinated = after ? null : await coordinatorLoopRun(host, action, existing);
  const kept = keepsCommission(existing, after ?? coordinated);
  const commissioned = Boolean(action.autopilot ?? action.loop);
  if (!kept) dropCommission(action);
  return { after, coordinated, loopUnused: commissioned && !kept && existing.state === RunState.Finished };
}

/** The runs a message answers after (`loopRunsFor`). */
interface RoutedLoopRuns {
  after: AfterLoopRun | null;
  coordinated: AfterLoopRun | null;
  loopUnused: boolean;
}

/**
 * A finished build the run's coordinator answers for, when a Loop came with the message and the
 * coordinator may reopen it (reopen-run.ts `finishedLoopRun`). A coordinator on a model without
 * sessions answers with tools in bounded rounds and could take a question for work: it is never
 * handed a build's hours.
 */
async function coordinatorLoopRun(host: Host, action: QueueAction, existing: RunRecord): Promise<AfterLoopRun | null> {
  if (!(action.autopilot ?? action.loop) || !coordinatorReopens()) return null;
  if (!(await answersInSession(host, turnEngine(action, existing)))) return null;
  return finishedLoopRun(host, action.threadId, existing, action.messageId);
}

/** Does this run own the message's thread or the game the message is about? */
function ownsMessage(active: ActiveRun, action: QueueAction): boolean {
  if (active.threadId === action.threadId) return true;
  return Boolean(action.project) && active.run.project === action.project;
}

/**
 * The run a message is for: the one under way on its thread or game, else the thread's last one.
 * A run that has closed is the log's (finished or paused) even while its learning pass runs. Whether
 * the message keeps its commission is decided once the run it answers after is known
 * (`keepsCommission`). A Loop message after an Unreal game's finished run is for no run: it may
 * start the next one (`startsNextOpenLoop`).
 */
async function routeMessage(studio: Studio, action: QueueAction): Promise<RunRecord | null> {
  // A message never clears an active run's stop flag. Cancellation is an explicit action; a run
  // that has closed (a Stop's, settling) no longer holds it.
  const active = [...studio.activeRuns.values()].find((a) => ownsMessage(a, action) && !a.done);
  // A Stop pressed for this very message (still sending, or waiting at the front) is kept.
  const stoppedFirst = studio.stoppedMessages?.has(String(action.messageId)) === true;
  if (!active && !stoppedFirst) studio.cancels.delete(action.threadId);
  const previousRun = latestRun(await studio.host.call(HostMethod.EventsList, { threadId: action.threadId }));
  const existing = existingRun(action, active, previousRun);
  if (!active && (await startsNextOpenLoop(studio.host, action, existing))) return null;
  return existing;
}

/**
 * Does the person's Loop message start the next Loop of a project that isn't a web game (folder-facts.ts
 * `loopProfileOf`) whose last run has finished? Such a Loop worked in the game folder itself, with no
 * copy to go on from, so a finished one is never reopened (`reopen-run.ts` `finishedLoopRun`); the
 * next Loop builds on what the project holds, so a new run continues it. So does a finished web
 * Loop's whose folder now reads, from its facts, as another kind of project: its build can't go on
 * there. The message is then the chat's own, as before the first Loop: its session may launch the
 * build. Exported for its tests.
 */
export async function startsNextOpenLoop(host: Host, action: QueueAction, run: RunRecord | null): Promise<boolean> {
  if (run?.state !== RunState.Finished || chatWrote(action)) return false;
  if (!(action.autopilot ?? action.loop)) return false;
  // The finished run's own journal says what it was, whatever its folder reads as now.
  const inPlace = await finishedInPlace(host, action.threadId, run);
  if (inPlace === true) return true;
  const listed = await host.call(HostMethod.GameList, {}).catch(() => null);
  const project = run.project ?? action.project;
  const game = Array.isArray(listed) ? listed.find((one) => one.name === project) : undefined;
  if (!game) return false;
  // A finished web Loop's build can't go on in a folder that now reads, from facts Genex read, as
  // another kind of project: the next Loop starts there instead of a reopen it would refuse.
  if (inPlace === false) return factsOfGame(game).length > 0 && loopProfileOf(game) === LoopProfile.Open;
  return loopProfileOf(game) === LoopProfile.Open;
}

/**
 * Whether a finished run's journal is a Loop that worked in the game folder itself (`director.open`,
 * or the Unreal runner's from before); null when there is no journal to read.
 */
async function finishedInPlace(host: Host, threadId: string, run: RunRecord): Promise<boolean | null> {
  if (typeof run.runId !== "string") return null;
  const journal = await readJournal(host, threadId, run.runId).catch(() => null);
  if (!journal) return null;
  return Boolean(journal.director?.open) || journal.kind === OLDER_LEAD_JOURNAL_KIND;
}

/**
 * Did the chat write this message itself (`origin`: a command's result), not the person? It may
 * carry the chat's Loop — sent while the chat's history loaded, or queued before an upgrade — but it
 * never keeps one for a run, nor inherits one from a question to reopen a build with.
 */
function chatWrote(action: QueueAction): boolean {
  return action.origin !== undefined && action.origin !== null;
}

/** A routed message's Loop or Autopilot commission, dropped. */
function dropCommission(action: QueueAction): void {
  delete action.autopilot;
  delete action.loop;
}

function existingRun(action: QueueAction, active: ActiveRun | undefined, previousRun: RunRecord | null) {
  // Older profiles recorded game runs in Studio. They remain history, never authority to
  // route a new Studio question into that game's coordinator or start another build.
  if (action.studioThread) return null;
  if (active) return active.run;
  // A New build queued before the composer dropped it still starts afresh.
  const startsAfresh = action.newRun === true && previousRun?.state === RunState.Finished;
  return startsAfresh ? null : previousRun;
}

/**
 * Before a run exists, "keep going" can be the answer to its intake interview. Preserve the
 * explicitly selected mode and launch tool: the mood board a message brings is kept for the
 * thread, and a message without one gets the thread's.
 */
function carryMoodBoard(moodBoards: Studio["moodBoards"], action: QueueAction): void {
  if (!action.autopilot) return;
  if (action.autopilot.frames?.length) {
    moodBoards.set(action.threadId, action.autopilot.frames);
    return;
  }
  const kept = moodBoards.get(action.threadId);
  if (kept?.length) action.autopilot.frames = kept;
}

/**
 * The host rewound this chat (its log reads without the withdrawn turns). A Loop interview's
 * mood board rides in memory between messages: it becomes the one the remaining messages gave,
 * when the withdrawn ones had changed it. Absent `frames` leaves the board untouched.
 */
export function rewindMoodBoard(
  moodBoards: Studio["moodBoards"],
  action: { threadId: string; frames?: unknown[] | null },
): void {
  if (!("frames" in action)) return;
  if (action.frames?.length) moodBoards.set(action.threadId, action.frames);
  else moodBoards.delete(action.threadId);
}

function asksStudioThreadToBuild(action: QueueAction): boolean {
  return Boolean(action.studioThread && (action.loop || action.autopilot));
}

/** The user's words as the turn's input; a queued message is already in the log. */
function userInput(action: QueueAction) {
  return action.messageId ? [] : [{ role: "user" as const, content: action.text as string }];
}

/** The Studio's own chat never builds: say where builds happen instead. */
async function answerStudioThreadBuild(host: Host, ctx: HarnessCtx, action: QueueAction): Promise<void> {
  const content = MESSAGE.studioThreadBuilds;
  ctx.setStatus("thinking");
  const turn = await host.call(HostMethod.TurnBegin, {
    threadId: action.threadId,
    input: userInput(action),
    metadata: { engine: action.engine ?? EngineId.Ollama },
  });
  try {
    await host.call(HostMethod.TurnAppend, {
      turnId: turn.turnId,
      batch: [{ type: EventKind.Messages, messages: [{ role: "assistant", content }] }],
    });
    host.notify("chat.message", { role: "assistant", content });
    await host.call(HostMethod.TurnEnd, { turnId: turn.turnId, status: TurnStatus.Ok });
  } catch (err: any) {
    await host.call(HostMethod.TurnEnd, { turnId: turn.turnId, status: TurnStatus.Error });
    host.notify("chat.error", { message: err?.message ?? String(err) });
  } finally {
    ctx.setStatus("idle");
  }
}

/** The turn a message is answered in: its id, the run it is about, and the runs it answers after. */
interface AnswerTurn extends RoutedLoopRuns {
  turnId: string;
  existing: RunRecord | null;
  /** The message's settings as the person sent them. */
  asked: QueueAction;
}

/**
 * The turn itself: the chat's own turn — after a run its lead led too, with the run's controls —
 * or the run's coordinator with any follow-up it commissions; then what the reply asked for.
 */
async function answerMessage(
  studio: Studio,
  ctx: HarnessCtx,
  action: QueueAction,
  turn: AnswerTurn,
  steer: SteerHandle | undefined,
): Promise<void> {
  const { turnId, existing, after, coordinated } = turn;
  if (keepsBuilding(action) && (await keepBuildingNow(studio, ctx, action, turn))) return;
  // The Loop that came with it cannot continue this finished build: said once, not on every message.
  if (turn.loopUnused && firstLoopUnused(studio, String(existing?.runId)))
    await sayInTurn(ctx, turnId, REOPEN_MESSAGE.loopUnused);
  const turnCtx = threadViewCtx(ctx, action);
  const outcome =
    existing && !after
      ? await coordinatorAnswer(studio.host, ctx, turnCtx, { action, turnId, existing, steer, coordinated })
      : await runTurn(turnCtx, chatTurnOptions(action, turnId, steer, after, turn.asked));
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
  await afterTheReply(studio, ctx, action, outcome, turn);
}

/** The person's Keep building tap (`AutopilotCommission.keepBuilding`), never a message the chat wrote itself. */
function keepsBuilding(action: QueueAction): boolean {
  return action.autopilot?.keepBuilding === true && !chatWrote(action);
}

/**
 * Keep building, done without a turn deciding it: a finished build the chat may reopen goes on with
 * the tap's words as its ask; with no build to go on from (the next Loop of a project worked in its
 * own folder), the next Loop starts from that same goal. The turn ends at once. False when neither
 * can, so the message is answered as any other.
 */
async function keepBuildingNow(
  studio: Studio,
  ctx: HarnessCtx,
  action: QueueAction,
  turn: AnswerTurn,
): Promise<boolean> {
  const commission = action.autopilot ?? action.loop;
  const loopRun = turn.after ?? turn.coordinated;
  const text = String(action.text ?? "");
  const hours = commissionHours(commission);
  if (loopRun && reopens(loopRun, commission)) {
    await studio.host.call(HostMethod.TurnEnd, { turnId: turn.turnId, status: TurnStatus.Ok });
    const models = sessionModels(action, turn.after, { hours });
    await reopenOrSayWhy(studio, ctx, action, loopRun, { hours, text, models });
    return true;
  }
  if (turn.existing) return false;
  await studio.host.call(HostMethod.TurnEnd, { turnId: turn.turnId, status: TurnStatus.Ok });
  await launchOrSayWhy(studio, ctx, action, await nextLoopSpec(studio.host, action, hours));
  return true;
}

/**
 * The next Loop Keep building starts, as the launch tool would commission it: an Autopilot run on the
 * last Loop's goal (the one it was built on, so taps never pile up) with what is left, its reference,
 * the message's hours (∞ with the launch tool's ceiling) and models.
 */
async function nextLoopSpec(host: Host, action: QueueAction, hours: number | null): Promise<AnyRecord> {
  const events: HarnessEvent[] = await host.call(HostMethod.EventsList, { threadId: action.threadId }).catch(() => []);
  const last = latestRun(events);
  const base = baseGoalOf(last);
  const text = String(action.text ?? "").trim();
  const roles = action.autopilot?.roles;
  const reference = referenceOf(events, last?.runId);
  return {
    goal: base ? `${base}\n\n${text}` : text,
    ...(base ? { keepBuildingFrom: base } : {}),
    mode: RunMode.Autopilot,
    ...(reference ? { reference } : {}),
    hours: hours ?? MAX_RUN_HOURS,
    ...(hours === null ? { untilSatisfied: true } : {}),
    ...(action.engine ? { engine: action.engine } : {}),
    ...(action.model ? { model: action.model } : {}),
    ...(roles ? { roles } : {}),
  };
}

/** The goal a run was built on: a Keep building run's own base goal, else its goal. */
function baseGoalOf(run: AnyRecord | null): string {
  const base = typeof run?.keepBuildingFrom === "string" ? run.keepBuildingFrom : run?.goal;
  return typeof base === "string" ? base.trim() : "";
}

/**
 * A run's reference as a launch takes it again, from the newest of its start records (its close
 * keeps only a name): its name, kind and notes, its stills staying with that run.
 */
function referenceOf(events: readonly HarnessEvent[], runId: unknown): AnyRecord | null {
  const opened = events.filter((event) => {
    const data = event?.data;
    const opens = data?.event_type === RunEvent.RunStarted || data?.event_type === RunEvent.RunRegistered;
    return data?.type === EventKind.Custom && opens && data.payload?.runId === runId;
  });
  const reference = opened
    .map((event) => event.data.payload?.reference)
    .findLast((ref) => typeof ref?.name === "string");
  if (!reference?.name.trim()) return null;
  return {
    name: reference.name,
    shots: [],
    ...(typeof reference.kind === "string" ? { kind: reference.kind } : {}),
    ...(typeof reference.notes === "string" ? { notes: reference.notes } : {}),
  };
}

/**
 * The run the chat's own session answers after (after-loop-run.ts), with the message it answers;
 * null when the coordinator answers: a run under way, a run no lead of the chat's own led, an
 * engine without sessions, or a kept chat turn or brief that does not serve it.
 */
async function afterLoopRunFor(host: Host, action: QueueAction, existing: RunRecord): Promise<AfterLoopRun | null> {
  if (!ownSessionAfterLoopRun()) return null;
  const loopRun = await afterLeadLoopRun(host, action, existing);
  if (!loopRun) return null;
  return {
    ...loopRun,
    ...(action.messageId ? { messageId: action.messageId } : {}),
    // Its finished build may be reopened only when every part the reopen depends on serves it, and
    // only by the person's own words: a question's Loop a command's result would inherit is not theirs.
    // A Loop that worked in the game folder itself is never reopened: a Loop message starts the next.
    ...(ownSessionReopens() && !chatWrote(action) && !loopRun.inPlace ? { reopenable: true } : {}),
  };
}

/** What the coordinator answers with: the message it answers, the run it answers for, and the steer. */
interface CoordinatorAsk {
  action: QueueAction;
  turnId: string;
  existing: RunRecord;
  steer: SteerHandle | undefined;
  /** The finished build its continue_build may reopen with the message's Loop (`coordinatorLoopRun`). */
  coordinated: AfterLoopRun | null;
}

/**
 * The run's coordinator answers, and the builder takes the work it commissioned in this same chat
 * turn — or, when the message kept its Loop for a finished build, the same build goes on with it,
 * reopened once the reply ends.
 */
async function coordinatorAnswer(
  host: Host,
  ctx: HarnessCtx,
  turnCtx: HarnessCtx,
  { action, turnId, existing, steer, coordinated }: CoordinatorAsk,
): Promise<TurnOutcome | undefined> {
  const commission = action.autopilot ?? action.loop;
  // The stills it is shown reach the reopened build only as its words (`coordinatorReopenRules`).
  const frameCount = action.stills?.length ?? 0;
  const reopen = reopens(coordinated, commission) ? { hours: commissionHours(commission), frameCount } : null;
  await runCoordinatorTurn(ctx, { ...action, turnId, run: existing, ...(steer ? { steer } : {}), reopen });
  const stop = ctx.cancelled ? null : await stopAsked(host, action, existing);
  if (stop) return stopOutcome(stop);
  const followup = ctx.cancelled ? null : await followupFor(host, action, existing);
  if (!followup) return undefined;
  // A contained change is one builder turn, Loop or not: only more work reopens the build.
  if (reopen && !followup.contained) return reopenOutcome(reopen.hours, reopenRequest(followup.text, steer));
  return runTurn(turnCtx, followupOptions(action, turnId, followup, existing, steer));
}

/** The stop the run's coordinator recorded for this message (chat-stop.ts), or null. */
function stopAsked(host: Host, action: QueueAction, existing: RunRecord): Promise<StopAsk | null> {
  return stopAskedFor(host, { threadId: action.threadId, runId: String(existing.runId), messageId: action.messageId });
}

/** The coordinator's stop of the build, done once the reply ends (`afterTheReply`). */
function stopOutcome(stop: StopAsk): TurnOutcome {
  return { stopped: TurnStop.Done, round: 0, details: { stopRun: stop } };
}

/** The coordinator's continued work as a reopen of the same build, done once the reply ends (`afterTheReply`). */
function reopenOutcome(hours: number | null, text: string): TurnOutcome {
  return { stopped: TurnStop.Done, round: 0, details: { reopenRun: { hours, text } } };
}

/**
 * What the reply asked for, done once it has ended: the build the run's coordinator asked to stop
 * (and maybe go on again), the paused run the chat's own session asked to resume (its lead is that
 * same session), the finished build it or the run's coordinator asked to reopen, or the run an
 * interview launched.
 */
async function afterTheReply(
  studio: Studio,
  ctx: HarnessCtx,
  asked: QueueAction,
  outcome: TurnOutcome | undefined,
  { after, coordinated, existing }: RoutedLoopRuns & { existing: RunRecord | null },
): Promise<void> {
  // A message sent while the turn worked may have changed its settings: what it asked for follows them.
  const action = followedSettings(asked, outcome);
  const stop = existing ? outcome?.details?.stopRun : null;
  if (existing && stop) {
    const where = { threadId: action.threadId, runId: String(existing.runId), messageId: action.messageId };
    return stopAfterReply(studio, where, stop);
  }
  const resume = after ? outcome?.details?.resumeRun : null;
  if (after && resume) return resumeAfterReply(studio, ctx, after, resume);
  const loopRun = after ?? coordinated;
  const reopen: ReopenAsk | null = loopRun ? outcome?.details?.reopenRun : null;
  // The chat's own session's reopen takes the message's models; the coordinator's keeps the build's.
  if (loopRun && reopen)
    return reopenOrSayWhy(studio, ctx, action, loopRun, { ...reopen, models: sessionModels(action, after, reopen) });
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

/** The settings a switch carries onto the message a turn answers: engine, model, effort and Loop. */
const FOLLOWED_FIELDS = ["engine", "model", "effort", "preferences", "autopilot", "loop"] as const;

/**
 * What the reopened build's lead, workers and judges run on after the chat's own session's reopen:
 * the model it answers on, the Loop's roles and the message's effort and preferences, as a launch
 * from that message takes them; none (the build's own) after the coordinator's.
 */
function sessionModels(action: QueueAction, after: AfterLoopRun | null, ask: ReopenAsk): ReopenModels | null {
  if (!after) return null;
  return { model: after.model, ...(ask.roles ? { roles: ask.roles } : {}), ...commissionedWith(action) };
}

/**
 * Reopen the finished build the chat's own session or the coordinator asked for (reopen-run.ts), or say why not: the
 * same run started again as a resume from its ask on, like a launch from this turn — a Stop since
 * this message began is for it (`keepStop`).
 */
function reopenOrSayWhy(
  studio: Studio,
  ctx: HarnessCtx,
  action: QueueAction,
  loopRun: AfterLoopRun,
  ask: ReopenAsk & { models: ReopenModels | null },
): Promise<void> {
  const { threadId } = action;
  const start = (run: RunSpec & AnyRecord, reopen: RunReopen): Promise<void> =>
    handleRunStart(studio, { type: "run_start", threadId, run, resume: true, reopen }, { keepStop: true });
  return reopenAfterReply(studio, ctx, loopRun, { ...ask, words: String(action.text ?? "") }, start);
}

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
    ...(action.loop ? { loop: action.loop } : {}),
    ...(action.autopilot ? { autopilot: action.autopilot } : {}),
    ...(steer ? { steer } : {}),
    ...(after ? afterLoopRunOptions(after) : {}),
    // The message whose settings the turn follows, as it was sent: one sent meanwhile may change them (turn-switch.ts).
    asked,
  };
}

/**
 * The chat's own session after its run: the run it answers after, on the lead's engine — also
 * for a message that names none — and on the model it led on when the message names none: the same
 * session on the same model, which a Resume's lead continues.
 */
function afterLoopRunOptions(after: AfterLoopRun): Partial<TurnOptions> {
  return { afterLoopRun: after, engine: after.engine, ...(after.model ? { model: after.model } : {}) };
}

/**
 * The builder's turn for the work the coordinator commissioned, in this same chat turn: the
 * latest request, plus what the person steered into the coordinator's turn that it did not restate.
 */
function followupOptions(
  action: QueueAction,
  turnId: string,
  followup: { text: string; plan: unknown },
  existing: RunRecord,
  steer: SteerHandle | undefined,
): TurnOptions {
  const steered = steeredForBuilder(steer, followup.text);
  const stills = steered.flatMap((message) => message.stills ?? []);
  const request = withSteers(
    followup.text,
    steered.map((message) => String(message.text)),
  );
  return {
    ...action,
    loop: undefined,
    autopilot: undefined,
    followupOf: String(existing.runId),
    turnId,
    ...(steer ? { steer } : {}),
    ...(stills.length ? { stills: [...(action.stills ?? []), ...stills] } : {}),
    text: followupAsk(request, followup.plan, existing),
  };
}

/**
 * What the person steered into the coordinator's turn reaches the builder too, unless the
 * coordinator already wrote it into the request. A replay's carried messages are left out: the
 * builder's own first prompt carries them already (chat-steer.ts).
 */
function steeredForBuilder(steer: SteerHandle | undefined, request: string): QueueAction[] {
  if (!steer) return [];
  return unrestated(
    steer.delivered.filter((message) => !steer.carried.includes(message)),
    request,
  );
}

/** The messages with words that the request does not already restate. */
function unrestated(messages: readonly QueueAction[], request: string): QueueAction[] {
  const asked = request.toLowerCase();
  return messages.filter((message) => {
    const text = String(message.text ?? "").trim();
    return Boolean(text) && !asked.includes(text.toLowerCase());
  });
}

/**
 * The ask a coordinator's continued work reopens the build with: its request, plus what the person
 * steered into its turn that it did not restate — a replay's carried messages too, since the
 * reopened run's inbox reads only from this ask on.
 */
function reopenRequest(request: string, steer: SteerHandle | undefined): string {
  const steered = unrestated(steer?.delivered ?? [], request);
  return withSteers(
    request,
    steered.map((message) => String(message.text)),
  );
}

/** The follow-up the coordinator asked for on this message, with the plan the work was saved under. */
async function followupFor(
  host: Host,
  action: QueueAction,
  existing: RunRecord,
): Promise<{ text: string; plan: unknown; contained: boolean } | null> {
  const events = await host.call(HostMethod.EventsList, { threadId: action.threadId });
  // The latest request for this message: the coordinator may have restated it after a steer.
  const followup = events
    .filter(
      (e) =>
        e.data?.event_type === RunEvent.RunFollowupRequested && e.data.payload?.sourceMessageId === action.messageId,
    )
    .at(-1)?.data.payload;
  if (!followup) return null;
  const journal = await readJournal(host, action.threadId, existing.runId);
  const plan = journal?.director?.plan ?? journal?.plan ?? lastReviewedPlan(events);
  return { text: followup.text, plan, contained: followup.build === false };
}

function lastReviewedPlan(events: readonly HarnessEvent[]): unknown {
  return events.filter((e) => e.data?.event_type === RunEvent.PlanReview && e.data.payload?.plan).at(-1)?.data.payload
    ?.plan;
}

/** Launch the run an interview asked for, or say in the chat why it did not start. */
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
  await host.call(HostMethod.TurnEnd, { turnId, status: TurnStatus.Error });
  host.notify("chat.error", { message: err?.message ?? String(err) });
}

/**
 * Launch the run an interview commissioned. Throws the sentence the chat is owed when it cannot
 * start: no goal, a folder that refuses, or a build already running for this chat or game.
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
  // A Loop on a project that isn't a web game: kept edited parts that can't lead it (the run's start
  // among them) refuse it first, before a web game's checks could ask for web files in the folder.
  const listed = games.find((g) => g.name === project) ?? null;
  const openLoop = listed !== null && loopProfileOf(listed) === LoopProfile.Open;
  if (openLoop && !openLoopLaunches()) throw new Error(OPEN_LOOP_REFUSAL.openLoopNeedsUpdate);
  // What the folder itself refuses (loopRunRefusal): a page that cannot load, a game that is
  // already compiled. Said in chat now, instead of found out at 3am.
  const readiness = await host.call(HostMethod.GameValidate, { project }).catch(() => null);
  const refusal = loopRunRefusal(
    games.find((g) => g.name === project) ?? null,
    readiness?.problems ?? [],
    readiness?.missing,
  );
  if (refusal) throw new Error(refusal);
  // A promise the run cannot keep is worse than no promise: a second Loop for a game
  // that already owns a run is refused below, and the only record of that refusal is an event
  // no chat surface renders. Ask the same question here, before anything is promised — once a
  // run that has closed there is past its learning pass, which a new run waits out.
  const busy = await runUnderWay(studio, action.threadId, project);
  if (busy) throw new Error(MESSAGE.alreadyBuilding(busy.run.project));
  // Stop while that pass was waited out was for this run too.
  if (ctx.cancelled) throw new Error(MESSAGE.stoppedBeforeLaunch);
  // A Loop on a project that isn't a web game is led by the chat's own session in place: said now,
  // before anything is promised, when the run's engine is none the host seats there.
  const needsSession = await needsSessionRefusal(host, listed, spec);
  if (needsSession) throw new Error(needsSession);
  // What the user sells for Nex rides the run's scope, so no plan can cut it; the build lists each
  // item once it has drawn its picture, since the store takes none without one.
  const store = storeItemsOf(spec.storeItems);
  const run = intakeRun(spec, action, project, readiness, await userWordsSoFar(host, action), store);
  // Such a Loop adds no connection and ends on a reviewer's yes: its own promise.
  const launched = openLoop
    ? openLaunchPromise(run.budgets, Date.now())
    : launchPromise(run.budgets, run.readiness, Date.now());
  const promise = [launched, storeLaunchWords(store)].filter(Boolean).join("\n\n");
  // The board did its job — the run spec carries the frames now; the next interview on this
  // thread starts with a clean slate.
  studio.moodBoards.delete(action.threadId);
  await host
    .call(HostMethod.EventsAppend, {
      threadId: action.threadId,
      batch: [
        {
          type: EventKind.Messages,
          messages: [{ role: "assistant", content: promise }],
        },
      ],
    })
    .catch(() => {});
  // Same thread: the run is this chat's story. handleRunStart holds keep-awake via notify.
  // The commission is handled at launch, so restart cannot replay it. Synchronous run
  // reservation keeps later queued messages behind the build until it saves and settles.
  // A Stop since this message is for this build: the start keeps it (`keepStop`).
  void handleRunStart(studio, { type: "run_start", threadId: action.threadId, run }, { keepStop: true }).catch(
    (err: unknown) => {
      void closeCarriedPool(action.threadId);
      host.notify("run.failed", { error: String(err) });
    },
  );
}

/** Whether a Loop on a project that isn't a web game can be launched: every part it needs serves one, the run's start (read by namespace) among them. */
function openLoopLaunches(): boolean {
  return openLoopServed() && servesOpenLoop([runDispatchParts]);
}

/**
 * Why a Loop on this game can't start on the run's engine, or null: a Loop on a project that isn't a
 * web game needs an engine the host seats in place (`leadsInPlace`: its lead is the chat's own, with
 * its jobs and looks); a web game keeps classic Autopilot on any engine.
 */
async function needsSessionRefusal(host: Host, game: AnyRecord | null, spec: AnyRecord): Promise<string | null> {
  const openLoop = spec.mode === RunMode.Autopilot && game !== null && loopProfileOf(game) === LoopProfile.Open;
  if (!openLoop) return null;
  const engine = typeof spec.engine === "string" ? spec.engine : EngineId.Ollama;
  const listed = await host.call(HostMethod.EngineDescribe, {}).catch(() => []);
  const described = (Array.isArray(listed) ? listed : []).find((e) => e.id === engine);
  return leadsInPlace(described)
    ? null
    : OPEN_LOOP_REFUSAL.needsSession(described?.label ?? engine, openLoopBecause(game));
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

/**
 * The time a commissioned run is given: its hours (held to the run limits), and whether the
 * composer asked for ∞, which runs until what was asked is verified, with those hours as the ceiling.
 * The app reads these back (`src/shared/run-state.ts` `recordedRunLoop`).
 */
export function intakeBudgets(spec: AnyRecord): RunSpec["budgets"] {
  const hours = clampRunHours(Number(spec.hours) || DEFAULT_RUN_HOURS);
  return {
    wallClockMs: Math.round(hours * HOUR_MS),
    completionPolicy: spec.untilSatisfied === true ? CompletionPolicy.Goal : CompletionPolicy.Duration,
    ...(spec.untilSatisfied === true ? { untilSatisfied: true } : {}),
  };
}

/**
 * The user's own messages for this build, as the log has them (scope.ts `userWordsInLog`): since the
 * thread's previous run, up to the one that launched, never the chat's own reports nor a model's
 * words. With none in the log, the launching message's own text.
 */
async function userWordsSoFar(host: Host, action: QueueAction): Promise<string[]> {
  const events: HarnessEvent[] = await host
    .call(HostMethod.EventsList, { threadId: action.threadId })
    .then((listed) => (Array.isArray(listed) ? listed : []))
    .catch(() => []);
  const said = launchWords(events, action.messageId);
  return said.length ? said : [String(action.text ?? "")];
}

/**
 * The user's words a launched build is for: since the thread's previous run, through the launching
 * message, then each message its session read mid-turn (delivered into it, and not handed back since).
 * Those read after the launch was recorded reach the build no other way: the session can't launch
 * twice. A message sent meanwhile that never joined keeps its own turn, so it isn't counted here.
 */
export function launchWords(events: readonly HarnessEvent[], messageId: string | undefined): string[] {
  const asked = userWordsInLog(events, { through: messageId, sinceLastRun: true });
  return messageId ? [...asked, ...joinedWords(events, messageId)] : asked;
}

/** The words of the messages read into `messageId`'s turn and still part of it, in the order sent. */
function joinedWords(events: readonly HarnessEvent[], messageId: string): string[] {
  const read = readInto(events, messageId);
  const words: string[] = [];
  for (const message of messageQueueState(events).messages.values()) {
    const text = message.action?.text;
    // A message the chat queued itself (a command's result) is never the person's words.
    const fromThePerson = message.action?.origin === undefined || message.action?.origin === null;
    if (read.has(message.messageId) && fromThePerson && typeof text === "string" && text.trim()) words.push(text);
  }
  return words;
}

/** The messages whose latest steer record says `messageId`'s turn read them: a later hand-back or re-steer undoes it. */
function readInto(events: readonly HarnessEvent[], messageId: string): Set<string> {
  const read = new Set<string>();
  for (const event of events) {
    if (event.data?.type !== EventKind.Custom) continue;
    const payload = event.data.payload ?? {};
    const id = payload.messageId;
    if (typeof id !== "string") continue;
    const type = event.data.event_type;
    if (type === RunEvent.CoordinatorMessageDelivered && payload.into === messageId) read.add(id);
    else if (type === RunEvent.CoordinatorMessageRequeued || type === RunEvent.CoordinatorMessageSteering)
      read.delete(id);
  }
  return read;
}

/**
 * What the run is for (loop/scope.ts): the user's words as the log has them, the in-scope and cut
 * lists the launch named, and what it sells in the Genex store. None when there are no
 * words to keep.
 */
function intakeScope(spec: AnyRecord, asked: readonly string[], store: readonly StoreItem[]): AnyRecord {
  const scope = createScope({
    asked,
    inScope: Array.isArray(spec.inScope) ? spec.inScope : [],
    cut: Array.isArray(spec.cut) ? spec.cut : [],
    store: storeScopeItems(store),
  });
  return scope.asked.length ? { scope } : {};
}

/** The run an interview commissioned, as `run_start` takes it. */
function intakeRun(
  spec: AnyRecord,
  action: QueueAction,
  project: string,
  readiness: { contract?: string; problems?: string[] } | null,
  asked: readonly string[] = [],
  store: readonly StoreItem[] = [],
): RunSpec & AnyRecord {
  return {
    runId: `run_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    goal: spec.goal,
    project,
    reference: spec.reference,
    budgets: intakeBudgets(spec),
    // What the folder still needs, as `game.validate` found it a moment ago. Not a refusal —
    // `loopRunRefusal` above decides those — but the run's own first job: a page that never
    // loads the studio contract cannot be judged at all, so the run carries the fact and the
    // director installs it before anyone builds (M2.6, loop/director.ts `installContract`).
    ...(readiness
      ? { readiness: { contract: readiness.contract ?? "loaded", problems: readiness.problems ?? [] } }
      : {}),
    ...(spec.reviewPlan ? { reviewPlan: true } : {}),
    ...(spec.mode ? { mode: spec.mode } : {}),
    ...(typeof spec.keepBuildingFrom === "string" ? { keepBuildingFrom: spec.keepBuildingFrom } : {}),
    ...(spec.engine ? { engine: spec.engine } : {}),
    ...(spec.model ? { model: spec.model } : {}),
    ...(spec.roles ? { roles: spec.roles } : {}),
    ...intakeScope(spec, asked, store),
    // The run inherits the interview's effort: builders work at exactly the model and effort
    // the user generates with, never a quieter tier than the chat that commissioned them.
    ...commissionedWith(action),
  };
}

/** The effort and preferences a message commissions a build with: a launch's (`intakeRun`) and a reopen's. */
function commissionedWith(action: QueueAction): { effort?: string; preferences?: ModelPreferences } {
  return {
    ...(action.effort ? { effort: action.effort } : {}),
    ...(action.preferences ? { preferences: action.preferences } : {}),
  };
}

/**
 * The one sentence a run owes the user before they walk away when their game cannot yet be
 * judged: the studio has to wire its own connection into the game before it can tell whether
 * anything it changes is an improvement, and that is the first thing this run does (M2.6). Said
 * here, in the chat, rather than discovered in the morning as "the other build could not be
 * observed" — the words no one outside the harness could read.
 */
export function judgeableFirst(readiness: { contract?: string } | null | undefined): string {
  if (readiness?.contract !== StudioContract.Missing) return "";
  return MESSAGE.connectionFirst;
}

/** What the chat promises the moment a commissioned run launches at `now`: when it ends, and what it needs. */
export function launchPromise(
  budgets: RunSpec["budgets"],
  readiness: { contract?: string } | null | undefined,
  now: number,
): string {
  const when = budgets.untilSatisfied
    ? MESSAGE.untilSatisfiedPromised(dayAndClockAfter(budgets.wallClockMs, now))
    : MESSAGE.buildPromised(clockAfter(budgets.wallClockMs, now));
  return when + MESSAGE.planWindow + judgeableFirst(readiness);
}

/**
 * What the chat promises as a Loop on a project that isn't a web game launches at `now`: when it
 * ends (a reviewer's yes within its safety stop, or its hours) and the plan's window; it adds no
 * connection to the game, so it promises none.
 */
export function openLaunchPromise(budgets: RunSpec["budgets"], now: number): string {
  const when = budgets.untilSatisfied
    ? OPEN_LAUNCH_WORDS.untilFinish(dayAndClockAfter(MAX_RUN_HOURS * HOUR_MS, now))
    : MESSAGE.buildPromised(clockAfter(budgets.wallClockMs, now));
  return when + MESSAGE.planWindow;
}

/** "Sunday 10:05 PM" — the day and wall clock this many milliseconds after `now`. */
function dayAndClockAfter(ms: number, now: number): string {
  return new Date(now + ms).toLocaleString([], { weekday: "long", hour: "numeric", minute: "2-digit" });
}

/**
 * "07:10", or "13:44 tomorrow" — the local wall clock this many milliseconds after `now`, with its
 * day when that is not today (wall-clock.ts): a 24-hour build ends at the minute it began. A
 * duration is not an answer to "when can I look?".
 */
function clockAfter(ms: number, now: number): string {
  return endClock(ms, now);
}
