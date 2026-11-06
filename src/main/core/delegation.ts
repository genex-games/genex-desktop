/**
 * Delegation: `engine.delegate` (a brief handed to a coding engine in one folder, under one lock),
 * the tools a session is given (computer, director), and the game-file access they share.
 * Composed by `StudioCore`; its state stays in the core.
 */
import type { DesktopTools } from "./desktop-tools.ts";
import { assistGrants } from "./desktop-assist.ts";
import { desktopSessionTools } from "./desktop-session.ts";
import { editorPlayComputer, editorPlayTools } from "./editor-play-session.ts";
import { uuidv7 } from "../../substrate/ids.ts";
import { replaceableCover } from "../../shared/game-library.ts";
import { COVER_TOOL } from "../../shared/cover-recipe.ts";
import { callProjectTool, ProjectToolSeat, projectTools } from "./project-tools.ts";
import { ProjectTool } from "../../shared/project-tools.ts";
import { ChatActivityPhase, SessionActivityRole, delegationActivityScope } from "../../shared/chat-activity.ts";
import { CustomEvent, customRecord } from "../../shared/custom-events.ts";
import { MINUTE_MS } from "../../shared/duration.ts";
import {
  DelegationRefusal,
  EngineFailureKind,
  isMessageFrom,
  StopReason,
  type TurnFailure,
  turnFailure,
} from "../../shared/engine-requests.ts";
import { type ConversationRecord, type EventEnvelope, ThreadKind } from "../../shared/event-log.ts";
import { ExecutionStatus, RUN_START_EVENTS } from "../../shared/run-state.ts";
import { UiEvent } from "../../shared/ui-events.ts";
import type { McpLiveTool } from "../../substrate/mcp/registry.ts";
import os from "node:os";
import path from "node:path";
import { isRunControl, runControlTools } from "../../shared/chat-run.ts";
import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, readdir, realpath, rm } from "node:fs/promises";
import { ensureDir, realpathNearest } from "../../substrate/fsx.ts";
import { isImageFile, readProjectShape } from "../../substrate/game-workspace.ts";
import { TargetRuntime } from "../../shared/computer-target.ts";
import type { HostMethod, HarnessParams, HarnessResult } from "../../shared/harness-api.ts";
import { describeUnknownImage, sniffImage } from "../../substrate/image-sniff.ts";
import { git } from "../../substrate/snapshots.ts";
import {
  DelegateEventType,
  EngineError,
  type DelegatePermissions,
  type DelegateRequest,
  type DelegateResult,
  type LiveToolResult,
  type LiveToolSpec,
  type WorkerSeat,
} from "../../substrate/engines/types.ts";
import { credentialHomes } from "../../substrate/credential-homes.ts";
import { baseDenyRead } from "../../substrate/spawn.ts";
import { WorkerTool, type WorkerType, workerLockKey } from "../../shared/workers.ts";
import { neverTouchList } from "./never-touch-list.ts";
import { EngineKind } from "../../shared/engine-descriptor.ts";
import { writableRoots } from "../../substrate/engines/never-touch.ts";
import { forwardWorkerTool, heldInPlan, offeredWorkerTools } from "./worker-tools.ts";
import { callJobTool, type JobCaller, type JobNews, jobNews, jobToolsFor } from "./job-tools.ts";
import { appLookFor, type LookCaller, type LookSave, runAppLook } from "./app-look-tool.ts";
import { type JobOwner, JobRole, JobScopeKind, JobStopper } from "../../shared/jobs.ts";
import { WORKER_TOOL_ANSWER } from "./worker-tools-prompts.ts";
import { DispatchActionType, HarnessCapability, type ReferenceFrame } from "../../shared/protocol.ts";
import { DESKTOP_TOOL_NAME } from "../../substrate/computer-tool.ts";
import { WorkClass, workClassOf } from "../../substrate/budget.ts";
import type { CoreInternals, StudioCore } from "../studio-core.ts";
import { chatTurnOf, openDoor, recordSteerDelivered, settleDoor, type SteerDoor } from "./chat-steer.ts";
import type { LeadSession, PersonSession } from "./chat-permissions.ts";
import type { ActiveDelegation } from "./internals.ts";
import { CallCutOff, PluginCapability, type PluginInfo, type PluginTool } from "../../shared/plugins.ts";
import type { PluginRegistry, PluginSnapshot } from "../../substrate/plugins/registry.ts";
import { type CutOffCall, clearCutOffs, noteCutOff, peekCutOffs } from "./cut-off-calls.ts";
import { cutOffNotice, type HandedPlugin, handedPluginsNote, silentConnectorLog } from "./delegation-prompts.ts";
import { computerTools, type ComputerGrant, type ComputerTools } from "./computer-tools.ts";
import { delegationMirror, scopedRecord, type ActivityScope, type DelegationMirror } from "./delegation-events.ts";
import { withFallbacks } from "./engine-failure.ts";
import { withPlanApproval } from "./plan-approval.ts";
import { threadOr } from "./main-thread.ts";
import { ShotKind, runDir, runShotsDir, safePathSegment } from "./run-shots.ts";
import type { SessionPort } from "./session-port.ts";
import { isBelow, isInside, toPosixRelative } from "../../substrate/paths.ts";
import { errorMessage } from "../../shared/errors.ts";
import { type EngineId, engineOf, isEngineGame } from "../../shared/game-engine.ts";
import { EngineId as ProviderId } from "../../shared/providers.ts";
import { readEngineBinding } from "../../substrate/game-engine-binding.ts";
import { FolderHolds, kindPending, type ProjectFact } from "../../shared/project-facts.ts";
import type { ConnectorCallOptions } from "./plugin-tools.ts";
import { type PersonWrote, personWroteWatch, workerHolder } from "./plugin-locks.ts";
import { noteAsking, noteEvent, type ToolsInFlight, toolsInFlight } from "./steer-cut.ts";
import { type ToolOffered, toolAllowRule } from "../../substrate/plugins/tool-allow.ts";
import { type RunCreditCap, runCreditCap } from "./run-credits.ts";
import { checkpointWords } from "./plugin-hooks.ts";
import { CHECKPOINT_TOOL } from "../../substrate/engines/studio-tool-prompts.ts";
import { HookEvent } from "../../shared/plugin-hooks.ts";

/**
 * Engines whose own system prompt takes a session's lasting context (`DelegateRequest.system`):
 * Claude Code's append, Codex's developer instructions (on its app server; a new `codex exec`
 * session reads it as its first notice, codex.ts `#delegateTexts`).
 */
const SYSTEM_CONTEXT_ENGINES: ReadonlySet<string> = new Set([ProviderId.ClaudeCode, ProviderId.Codex]);

/** A brief's parts as one text, the empty ones left out. */
const joinParts = (parts: readonly string[]): string => parts.filter(Boolean).join("\n\n");

/** A director tool answers within this (the Codex bridge shim waits ten minutes; a wait is capped at four). */
export const DIRECTOR_TOOL_TIMEOUT_MS = 11 * MINUTE_MS;

/** How many stills a message may name for the model, and how large each may be. */
const MAX_NAMED_STILLS = 4;
const MAX_STILL_BYTES = 8 * 1024 * 1024;
/** How deep `game.tree` walks a game folder. */
const GAME_TREE_DEPTH = 6;
/** Folders `game.tree` never lists, beside anything hidden. */
const GAME_TREE_SKIPPED: ReadonlySet<string> = new Set(["node_modules", "export"]);
/** How many images a brief carries to the engine. */
const MAX_BRIEF_IMAGES = 16;

/** Why a delegation or a game-file path is refused, as the harness and the engines read it. */
const MESSAGE = {
  foreignCwd: (cwd: string) => `delegation cwd must be the project folder or a scratch worktree: ${cwd}`,
  outsideProject: (file: string) => `path is outside this project's folder: ${file}`,
  symlink: (file: string) => `refused: ${file} is a symlink`,
  directEngine: (engineId: string) => `${engineId} is a direct engine; use engine.complete`,
  cannotCompact: (engineId: string) => `${engineId} has no compaction of its own, or no session was named to compact`,
  folderBusy: (where: string, minutes: number) =>
    `a contractor is already building in ${where} (started ${minutes} min ago) — wait for it to finish before sending another brief`,
  /** A worker of this game's Loop works in the folder beside its lead (`#assertNoRunWorkerBeside`). */
  loopWorkerBusy: (where: string, minutes: number) =>
    `this game's Loop has a worker in ${where} (started ${minutes} min ago) — wait for it to finish, or stop the Loop`,
  /** The folder is held by this game's Loop's lead in place, working its turn. */
  loopLeadBusy: (where: string, minutes: number) =>
    `this game's Loop is working in ${where}: its lead's turn holds the folder (started ${minutes} min ago) — wait for that turn to end, or stop the Loop`,
  tooManyWorkers: (max: number) =>
    `this chat already runs ${max} workers, the most the person's Settings allow: wait for one to finish (${WorkerTool.Wait}) before starting another`,
  toolCollision: (name: string) => `Plugin tool collision: ${name}`,
  unknownTool: (name: string) => `Unknown tool: ${name}`,
  turnEndUnrecorded: (err: unknown) => `[core] could not record the end of the lead's turn: ${errorMessage(err)}`,
  cleanupFailed: (step: string, err: unknown) =>
    `[core] ${step} release failed after a delegation: ${errorMessage(err)}`,
  reviewerRefused:
    "a reviewer is seated only read-only, for a run of this game, reading the game's folder or the run's own copy of it",
} as const;

type DelegateParams = HarnessParams<typeof HostMethod.EngineDelegate>;
type LiveTool = NonNullable<DelegateRequest["liveTools"]>[number];
type OnLiveTool = NonNullable<DelegateRequest["onLiveTool"]>;
type SelfCaptureGrant = NonNullable<DelegateParams["selfCapture"]>;
type DirectorGrant = NonNullable<DelegateParams["director"]>;
/** A run's sub-agent, as its plugin calls are recorded: its run, and its agent id as the part they land on. */
type Attribution = NonNullable<DelegateParams["attribution"]>;
/** What the harness asks for a worker; honoured only by the host's own finding (`#workerSeat`). */
type WorkerAsked = NonNullable<DelegateParams["worker"]>;
/** The most characters of a worker's title its cards and records keep. */
const WORKER_TITLE_MAX = 80;

/**
 * A Loop's reviewer as the host seated it (`#reviewerSeat`): the run it checks, the folder it reads
 * (the game's as registered, or the run's own copy of it, by real path) and the run's captures.
 */
interface ReviewerFinding {
  runId: string;
  reads: string;
  captures: string;
}

/**
 * A worker of a chat's lead, as the host found it: the chat it answers to (its mode, its grants and
 * its cards), the run whose lead started it (null for one the chat's own turn started), and whether
 * it works in the game's own folder, under its own lock beside the chat's own session.
 */
interface WorkerFinding {
  id: string;
  title: string;
  research: boolean;
  chatThreadId: string;
  runId: string | null;
  /** The chat turn whose own session started it, for a worker that is no run's; null otherwise. */
  turn: string | null;
  inPlace: boolean;
}

/**
 * Stop what a session's tools started and give back its windows: the computers' games, the
 * desktop driver, the pooled windows. One that fails to stop never keeps the rest from stopping.
 */
async function releaseSessionTools(tools: SessionTools, windows: SessionWindows): Promise<void> {
  const held = [tools.builder, tools.desktop, windows.self];
  for (const one of held) await one?.release().catch(() => {});
}

/** A lead's run tools, each answered by the harness (`runToolsOnly`). */
interface DirectorTools {
  liveTools: NonNullable<DelegateRequest["liveTools"]>;
  onLiveTool: OnLiveTool;
}

/** Where a delegation runs, with what, and under which budget class. */
interface DelegationTarget {
  engineId: string;
  delegateTo: (request: DelegateRequest) => Promise<DelegateResult>;
  workClass: WorkClass;
  /** Where the contractor runs: the checked real path. */
  workCwd: string;
  /** The delegation's key: the name its caller used, which engine.abort and engine.interrupt send. */
  cwd: string;
  /** The engine reads the person's messages mid-turn (`Engine.steersMidTurn`). */
  steersMidTurn: boolean;
}

/** The grants honoured for this folder, where their pictures land, and what the session may read. */
interface DelegationGrants {
  selfCapture: SelfCaptureGrant | null;
  selfShotsDir: string | null;
  director: DirectorGrant | null;
  /** The folders the host itself derived for it (its game, its frames, a lead's run folder). */
  hostReads: string[];
  /** Those, and the folders the brief names. */
  extraReads: string[];
}

/**
 * What the session reads beyond its folder and what it may not, and the permissions of a session
 * the person is answering (`ChatPermissionService`): the chat's own (`person`), or a build's lead
 * the person may talk to (`lead`). Both null for unattended work.
 */
interface SessionReach {
  person: PersonSession | null;
  lead: LeadSession | null;
  /** A worker's seat in its lead's chat's mode (`#workerReach`); null for every other session. */
  worker: WorkerSeat | null;
  extraReads: string[];
  denyReads: string[];
}

/** What one session is: its thread, its reach, its stop signal and its mirrored events. */
interface DelegationSession {
  threadId: string;
  /** Host tools at all: plugins, connectors, the cover. See {@link hostToolsEligible}. */
  hostTools: boolean;
  /** The host tools a run's sub-agent may be offered (`toolAllow`); null offers every one. */
  offered: ToolOffered | null;
  /** A run's sub-agent: the run and agent its plugin calls are recorded under. */
  attribution: Attribution | null;
  /** The run's Genex credit cap its paid plugin calls count against (`creditCap`); null without one. */
  credits: RunCreditCap | null;
  activityScope: ActivityScope;
  /** A director's turn ends without a `turn_ended`, so the host records how it ended. */
  leadTurn: boolean;
  /** A lead that is its chat's own session, in the game folder: its session is the chat's bookmark. */
  chatLead: boolean;
  /**
   * A Loop's lead: the game folder it leads in, as its seat checked it (`seat.leads`). Its plugins act
   * there (the binding's directory); and, the lead not being the chat's turn, neither another turn's
   * end nor its own withdraws its plugin cards: only the person, the timeout or a Stop settles them.
   * Its connector calls end with its own session (`ended`). Null otherwise.
   */
  leads: string | null;
  abort: AbortController;
  /** Aborted once the delegation returns: a lead's connector calls end with it besides `abort`. */
  ended: AbortController;
  mirror: DelegationMirror;
  /** Steer: the chat turn this session answers, when it is the chat's own or a lead's (`chat-steer.ts`). */
  chatTurn?: string;
  /** Its input mid-turn, when it answers a chat turn on an engine that reads messages as it works. */
  door?: SteerDoor;
  /** A chat turn's session: its tool calls in flight, read from its events (`steer-cut.ts`), so a steer cuts it between them. */
  tools?: ToolsInFlight;
  /** A chat turn's session: the person's word that ends its plugin calls' waits for a lock (`engine.steer`). */
  personWrote?: PersonWrote;
  /** The run's controls it keeps: the chat's own session after a closed Loop run (`honouredRunControls`). */
  runControls?: RunControlGrant;
  /**
   * The run whose own consent covers its game's engine connector, asked at each call
   * (`#runConsents`): a Loop's lead's in the game folder. Null for every other session.
   */
  liveRun: string | null;
  /** What its game's folder holds (`seat.facts`): its plugin tools, skills and connectors are those that reach it. */
  facts: ProjectFact[];
  /** With no facts, what the folder holds (`seat.holds`): whether its kind is still to pick. */
  holds?: FolderHolds;
  /** A worker of a chat's lead, as the host honoured its grant (`#workerSeat`); null otherwise. */
  worker: WorkerFinding | null;
  /** A Loop's reviewer, as the host honoured it (`#reviewerSeat`): the run it checks; null otherwise. */
  reviewer: string | null;
  /**
   * The holder an in-place worker's calls pass as when the host carries no seat for it (a direct
   * engine's session): the in-place hold the harness took for its life names it alike, so its own
   * calls never wait behind it (`#unseatedHolder`). Null for every other session.
   */
  unseatedHolder: string | null;
}

/** The run and message a chat's own session keeps the run's controls for. */
type RunControlGrant = NonNullable<DelegateParams["runControls"]>;

/** The session-long window: the builder's own. */
interface SessionWindows {
  self: SessionPort | null;
}

/** The tools prepared for a session under its lock; each one is released by the delegation's finally. */
interface SessionTools {
  cover: (typeof COVER_TOOL)[];
  /** Genex's own project tools (`projectTools`), the chat's own session's: the web starter, the plugin search and card. */
  project: LiveToolSpec[];
  /** The worker tools, the chat's own session's while it answers a turn: answered by the harness's pool for it. */
  workers: LiveToolSpec[];
  /** The job tools (`job-tools.ts`): the chat's own session's, a lead's and a writing worker's. */
  jobs: LiveToolSpec[];
  /** Where its jobs run, what they reach and whose they are; null for a session with no job tools. */
  jobReach: JobCaller | null;
  /** The chat's own session's news of its jobs, and the ended ones it tells (marked told once it starts). */
  jobNews: JobNews;
  /** `app_look` (`app-look-tool.ts`): the chat's own session's, a lead's and every seated worker's, readers included. */
  look: LiveToolSpec[];
  /** Whom its looks answer to; null for a session without `app_look`. */
  lookCaller: LookCaller | null;
  mcp: McpLiveTool[];
  /** The plugin tools, their guidance and the set behind them: one registry snapshot, taken as the session began. */
  plugins: PluginTool[];
  pluginGuidance: string;
  /** The plugins behind them as its brief names them, read in the same tick as the snapshot. */
  handed: HandedPlugin[];
  /** The thread's cut-off calls its notices name; forgotten once the session answers (`#settled`). */
  cutOffs: CutOffCall[];
  builder: ComputerTools | null;
  director: DirectorTools | null;
  /** The person's computer, behind their consent: only the chat's own session holds it. */
  desktop: DesktopTools | null;
}

/**
 * The one condition that decides whether this session gets host tools at all. Judges and
 * critics never reach here (they `complete()`); a read-only session has a narrower job than "build
 * this game", and a connector is exactly the kind of reach it should not have. A chat that may launch
 * a build is a full contractor and gets what the Auto chat gets, and so does a build's lead: its
 * seat in the game folder is the host's own finding (`#inPlaceRoot`), and its plugins act in the
 * folder it leads (`DelegationSession.leads`).
 */
function hostToolsEligible(p: DelegateParams, seat: DelegationSeat): boolean {
  return !(p.readOnly && !seat.leads);
}

/**
 * How a lead's turn that answered ended: done, stopped (by the user, or by the harness dying or
 * restarting under it), or cut short otherwise.
 */
function answeredPhase(result: DelegateResult): ChatActivityPhase {
  if (result.ok) return ChatActivityPhase.Completed;
  return result.stopReason === StopReason.Stopped ? ChatActivityPhase.Interrupted : ChatActivityPhase.Failed;
}

/**
 * How a lead's turn that threw ended: an abort (the user's stop, or the harness dying or
 * restarting) reads as interrupted, anything else failed.
 */
/** How a chat turn's delegation failed, for the turn's end to record. */
function failedTurn(failure: unknown): TurnFailure {
  if (!(failure instanceof EngineError)) return turnFailure(EngineFailureKind.Other);
  return turnFailure(failure.kind, failure.retryAfterMs);
}

function thrownPhase(err: unknown): ChatActivityPhase {
  const stopped = err instanceof EngineError && err.kind === EngineFailureKind.Aborted;
  return stopped ? ChatActivityPhase.Interrupted : ChatActivityPhase.Failed;
}

/**
 * Only the chat's own contractor session is its bookmark: never a run's director or builder, and
 * never a session in a build worktree (`cwd`). Read from what the
 * caller asked for, so a grant dropped for pointing at another folder still marks a run's session.
 */
function isChatsOwnSession(p: DelegateParams): boolean {
  const asked = askedScope(p);
  const runScoped = Boolean(asked.runId || p.director || p.cwd || p.worker);
  return asked.role === SessionActivityRole.Planner && !runScoped;
}

/**
 * A run's sub-agent's attribution, honoured when it names both a run and an agent; null for every
 * other session. It only says whose calls these are: it grants nothing.
 */
function attributionOf(p: DelegateParams): Attribution | null {
  const asked = p.attribution;
  const named = (value: unknown) => typeof value === "string" && value.length > 0;
  return asked && named(asked.runId) && named(asked.agentId) ? { runId: asked.runId, agentId: asked.agentId } : null;
}

/** The grants a scope is read with: as asked, or as honoured for the folder (null when dropped). */
interface AskedGrants {
  director?: DirectorGrant | null;
  selfCapture?: SelfCaptureGrant | null;
}

/**
 * The scope the caller asked for (`delegationActivityScope`): a run's sub-agent reads as the
 * builder of its own part, so its records land on its node and its words never stream as the
 * chat's reply.
 */
function askedScope(p: DelegateParams, grants: AskedGrants = p) {
  const attribution = attributionOf(p);
  const selfCapture =
    grants.selfCapture ?? (attribution ? { runId: attribution.runId, facetId: attribution.agentId } : null);
  return delegationActivityScope({ ...p, ...grants, selfCapture });
}

/**
 * A brief shaped for work nobody answers: a run's builder, a worker, a run's lead,
 * improvement work, or anything with a clock or a
 * folder of its own. Read from what the caller asked for: forging the absence of these fields only
 * makes a session ask the person, in the mode the person chose.
 */
function unattendedBrief(p: DelegateParams): boolean {
  const narrower = [p.readOnly, p.selfCapture?.runId, p.director, p.attribution, p.worker];
  if (narrower.some(Boolean) || p.cwd) return true;
  return p.timeoutMs !== undefined || workClassOf(p.class) === WorkClass.Improvement;
}

/**
 * The run's controls the chat's own session keeps after a closed Loop run (`runControls`): honoured
 * only for the chat's own session — never a run's director or builder, a read-only session, or one
 * in a build worktree. A control for a run that is not the chat's latest is refused when it is
 * called (`conversation.ts` `runControl`).
 */
function honouredRunControls(p: DelegateParams): RunControlGrant | null {
  const asked = p.runControls;
  if (typeof asked?.runId !== "string" || !p.threadId) return null;
  return isChatsOwnSession(p) ? asked : null;
}

/** Where a delegation sits and how its director grant reads there (`#seatOf`). */
interface DelegationSeat {
  /** A Loop's lead in its game's folder, as `#inPlaceRoot` checked it: its grant's root, its reads and its lock. Null otherwise. */
  leads: string | null;
  /** It sits in its game's own folder: no build worktree. */
  gameFolder: boolean;
  /** The engine its game's record links it to: whether a chat's checkpoint without a hook is a snapshot. */
  engine: EngineId;
  /**
   * What its game's folder holds (`games.kindOf`): which plugin tools, skills and connectors the
   * session is handed. A game whose facts can't be read has none and is unreadable (`holds`),
   * served as no kind at all.
   */
  facts: ProjectFact[];
  /** With no facts, what the folder holds (`GameProject.holds`); one that can't be read is unreadable. */
  holds?: FolderHolds;
}

/**
 * The director: honoured only for a Loop's lead the host seated in its game's folder (`#seatOf`),
 * which the grant then names by its checked real path. A grant the host refused to seat is dropped
 * whole: honoured, it would hand an unattended session the run's tools there.
 */
function honouredDirector(p: DelegateParams, seat: DelegationSeat): DirectorGrant | null {
  const director = p.director;
  return director && seat.leads ? { ...director, root: seat.leads } : null;
}

/** A game's facts as one comparable key: each `id@path`, sorted. */
const factsKey = (facts: readonly { id: string; path: string }[]): string =>
  facts
    .map((fact) => `${fact.id}@${fact.path}`)
    .sort()
    .join("\n");

/** The game a thread is bound to (`metadata.project`), if any. */
function threadGame(thread: ConversationRecord): string | undefined {
  const project = (thread.metadata as { project?: unknown } | undefined)?.project;
  return typeof project === "string" ? project : undefined;
}

/** Does this record start (or restart) run `runId` (`run_registered`, `run_started`)? */
function startsRun(event: EventEnvelope, runId: string): boolean {
  const custom = customRecord(event.data);
  if (!custom || !RUN_START_EVENTS.has(custom.event_type)) return false;
  return custom.payload.runId === runId;
}

/** A run's start names no game, or `project`. */
function startNames(event: EventEnvelope, project: string): boolean {
  const named = customRecord(event.data)?.payload.project;
  return named === undefined || named === project;
}

/** Are both folders worktrees of one repository (`--git-common-dir`, on real paths)? */
async function sameRepository(a: string, b: string): Promise<boolean> {
  const commonDir = async (dir: string) =>
    realpath((await git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim());
  const [ours, theirs] = await Promise.all([commonDir(a), commonDir(b)]).catch(() => [null, null]);
  return Boolean(ours) && ours === theirs;
}

/** Whether a brief names a worker by id, whether or not the host seats it. */
const namesWorker = (p: DelegateParams): boolean => typeof p.worker?.id === "string" && p.worker.id.length > 0;

/** A worker of a run the host does not seat, as `#unseatedRunWorker` confirmed it: its id and its run. */
type UnseatedRunWorker = { id: string; runId: string };

/**
 * An honoured worker's brief, depth one: it never leads a run, keeps a run's controls, interviews,
 * coordinates, answers the chat's turn or runs workers of its own, so no grant that would let it
 * start workers survives. A building worker (one that writes) keeps no tool allowlist either: it is
 * offered every enabled plugin's tools, its jobs, its look and the connectors its lead is — a
 * worker type names the kind of work, never a fence. A reader keeps the one its type names.
 */
function workerBrief(p: DelegateParams): DelegateParams {
  const { director: _director, runControls: _controls, interviewTools: _interview, ...rest } = p;
  const { chatTurn: _turn, workers: _workers, ...brief } = rest;
  if (brief.readOnly === true) return brief;
  const { toolAllow: _allow, ...building } = brief;
  return building;
}

/**
 * A reviewer's brief: what it was asked and where it reads, and nothing else. Every other grant
 * (a director's, a worker's, a capture grant, run controls, the chat's turn,
 * a folder of its own) is dropped; its reads are the lead's folder and the run's captures (on Codex,
 * whose box reads the whole disk, a brief rather than a boundary), it offers no plugin tool, and has
 * no computer of its own.
 */
function reviewerBrief(asked: DelegateParams, found: ReviewerFinding): DelegateParams {
  return {
    engine: asked.engine,
    prompt: asked.prompt,
    project: asked.project,
    threadId: asked.threadId,
    model: asked.model,
    effort: asked.effort,
    preferences: asked.preferences,
    maxTurns: asked.maxTurns,
    timeoutMs: asked.timeoutMs,
    images: asked.images,
    class: asked.class,
    readOnly: true,
    computer: false,
    toolAllow: [],
    extraReads: [found.reads, found.captures],
    reviewer: { runId: found.runId, reads: found.reads },
  };
}

/** A worker's title as its cards show it: its own words, bounded, or its id. */
function workerTitle(asked: WorkerAsked): string {
  const title = typeof asked.title === "string" ? asked.title.trim().slice(0, WORKER_TITLE_MAX) : "";
  return title || asked.id;
}

/** Who a worker's plugin calls are recorded under: its run and its own id, when a run's lead started it. */
function workerAttribution(worker: WorkerFinding | null): Attribution | null {
  return worker?.runId ? { runId: worker.runId, agentId: worker.id } : null;
}

/** A refusal the harness reads by its typed `code` (`DelegationRefusal`), not by its words. */
class DelegationRefusedError extends Error {
  readonly code: DelegationRefusal;
  constructor(code: DelegationRefusal, message: string) {
    super(message);
    this.name = "DelegationRefusedError";
    this.code = code;
  }
}

/** Is this a non-null object whose fields can be read? */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * A plugin tool's answer as the engine takes it. The SDK types a tool's answer as unknown and
 * the work is already done: only a plain object can carry images; a string is the answer;
 * anything else is its JSON.
 */
function pluginAnswer(result: unknown): LiveToolResult {
  if (typeof result === "string") return result;
  if (!isRecord(result) || Array.isArray(result)) return JSON.stringify(result ?? null);
  const { images, ...record } = result as Record<string, unknown>;
  if (!images) return JSON.stringify(record);
  return {
    text: JSON.stringify(record),
    images: images as Array<{ mimeType: string; data: string; label?: string }>,
  };
}

export class DelegationService {
  readonly #core: StudioCore;
  readonly #x: CoreInternals;
  /**
   * The runs whose lead in place the host has seated: while such a run goes on, its confirmed
   * unseated workers in the game folder hold keys of their own for their whole lives (`#lockOf`).
   */
  readonly #inPlaceRuns = new Set<string>();

  constructor(core: StudioCore, x: CoreInternals) {
    this.#core = core;
    this.#x = x;
  }

  /** A listed game's folder, or null for a project the studio doesn't list. */
  #gameDirectory(project: string): string | null {
    try {
      return this.#core.games.dirFor(project);
    } catch {
      return null;
    }
  }

  /**
   * The computer: hands and eyes on one pooled window for the whole session — the
   * builder's worktree, the lead's build. Loaded
   * once through the served entry, the setup script applied, then kept running between
   * actions so a map the worker switched to stays switched. Actions are Anthropic's computer
   * vocabulary plus the studio's own verbs; every one leaves a frame on the agent's screen.
   */
  async _computerToolsFor(
    grant: ComputerGrant,
    initialRoot: string,
    outDir: string,
    session: SessionPort,
  ): Promise<ComputerTools> {
    // A game an engine plugin plays in its editor (an Unreal game) is played there, whoever the session is.
    const directory = this.#gameDirectory(grant.project);
    const use = { grant, outDir, session };
    const editor = directory
      ? await editorPlayComputer(this.#core, this.#x, { project: grant.project, directory }, use)
      : null;
    if (editor) return editor;
    // A build whose studio.json declares the bridge runtime is played as its own process, started
    // in the studio's sandbox; every other build in the session's browser window, as before.
    const shape = await readProjectShape(initialRoot).catch(() => null);
    if (shape?.runtime !== TargetRuntime.Bridge)
      return computerTools(this.#x.previews, grant, initialRoot, outDir, session);
    // Started on the session's first move, never here: every chat turn is handed a computer, and a
    // native game opens a window of its own. Until it runs, the tool offers what such a game may do.
    return computerTools(this.#x.previews, grant, initialRoot, outDir, session, {
      bridge: { sandbox: this.#core.sandbox, engine: (engine, root) => this.#core.startEngine(engine, root) },
    });
  }

  /**
   * A Loop lead's run tools — workers, a second opinion, save points, note, finish — which live in
   * the harness process (it owns the loop and the merges) and are reached through a dispatch that
   * answers (`runToolsOnly`). Tool names come from the harness so the studio stays generic.
   */
  #directorTools(
    d: NonNullable<DelegateRequest["director"]> & { tools?: DelegateRequest["liveTools"] },
  ): DirectorTools {
    return runToolsOnly(d.tools ?? [], (name, args) => this.#forwardDirectorTool(d, name, args));
  }

  /**
   * The worker tools of the chat's own session while it answers a chat turn, on a harness that serves
   * workers: never a worker's (depth one), a lead's or a run's. A plugin tool of the same name would
   * be called in their place: refused, as a cover's name is.
   */
  #offerWorkerTools(p: DelegateParams, engineId: string, session: DelegationSession, tools: SessionTools): void {
    const ownTurn = Boolean(session.chatTurn) && !session.worker && chatsOwnSession(p, session);
    // A worker's seat runs only on an engine that carries one: its workers would run unseated.
    const honoured = ownTurn && this.#seatsWorkers(engineId);
    const serves = this.#core.host.hasCapability(HarnessCapability.Workers);
    tools.workers = offeredWorkerTools(p.workers, honoured, serves);
    const taken = tools.plugins.find((plugin) => tools.workers.some((tool) => tool.name === plugin.name));
    if (taken) throw new Error(MESSAGE.toolCollision(taken.name));
  }

  /**
   * The job tools, for the chat's own session, a lead and a worker the host seated on an engine that
   * carries a seat, with the chat its jobs report to (`#jobCaller`); a session with no such chat gets
   * none. The chat's own session is also told of its jobs. A plugin tool of the same name would be
   * called in their place: refused, as a cover's name is.
   */
  async #offerJobTools(
    p: DelegateParams,
    target: DelegationTarget,
    grants: DelegationGrants,
    session: DelegationSession,
    reach: SessionReach,
    tools: SessionTools,
  ): Promise<void> {
    if (!session.hostTools || !this.#seatsWorkers(target.engineId)) return;
    const seat = projectToolSeat(p, session);
    const offered = jobToolsFor(seat).filter((tool) => offers(session, tool.name));
    if (!offered.length) return;
    const caller = await this.#jobCaller(p, target, grants, session, reach, seat);
    if (!caller) return;
    const taken = tools.plugins.find((plugin) => offered.some((tool) => tool.name === plugin.name));
    if (taken) throw new Error(MESSAGE.toolCollision(taken.name));
    tools.jobs = offered;
    tools.jobReach = caller;
    if (seat === ProjectToolSeat.Chat && !p.compact) tools.jobNews = await jobNews(this.#core, caller.owner);
  }

  /**
   * Where a session's jobs run and whose they are: a worker's in its own folder with its seat's
   * write roots and never-touch list, in its chat, for its run or turn; a lead's where its plugin
   * calls act (the build it leads, else its own folder), in its run's chat, for its run; the chat's
   * own session's in its game's folder, for the chat. Null when there is no chat to report to.
   */
  async #jobCaller(
    p: DelegateParams,
    target: DelegationTarget,
    grants: DelegationGrants,
    session: DelegationSession,
    reach: SessionReach,
    seat: ProjectToolSeat,
  ): Promise<JobCaller | null> {
    const game = await realpath(this.#core.games.dirFor(p.project)).catch(() => null);
    if (!game) return null;
    const home = os.homedir();
    const found = session.worker;
    if (seat === ProjectToolSeat.Worker && found && reach.worker) {
      const { writeRoots, neverTouch } = reach.worker;
      const owner = workerJobOwner(p.project, found);
      if (!owner) return null;
      const jobReach = { writeRoots, neverTouch, home, gameFolder: game };
      return { folder: target.workCwd, reach: jobReach, owner };
    }
    const chatThreadId = await this.#projectToolChat(p, grants, session);
    if (!chatThreadId) return null;
    const lead = seat === ProjectToolSeat.Lead ? grants.director : null;
    const own = seat === ProjectToolSeat.Chat && (await this.#openGameChat(p.project, chatThreadId));
    if (!own && !lead) return null;
    const folder = session.leads ?? target.workCwd;
    const neverTouch = await this.#neverTouch(p.project, [folder, game]);
    const writeRoots = writableRoots(await this.#writeRoots(folder, chatThreadId, p.project), neverTouch);
    const owner = chatOrLeadJobOwner(p.project, chatThreadId, lead, session.chatTurn);
    return { folder, reach: { writeRoots, neverTouch, home, gameFolder: game }, owner };
  }

  /**
   * `app_look`, look-only and so in every mode: for the chat's own session, a lead, every worker the
   * host seated (a reader too, which has no other host tool) and a Loop's
   * reviewer, on an engine that carries a seat.
   * Its access line goes to the session's chat. A plugin tool of the same name is refused.
   */
  async #offerLook(
    p: DelegateParams,
    target: DelegationTarget,
    grants: DelegationGrants,
    session: DelegationSession,
    tools: SessionTools,
  ): Promise<void> {
    if (!this.#seatsWorkers(target.engineId)) return;
    const seat = projectToolSeat(p, session);
    const reviewer = seat === ProjectToolSeat.Reviewer;
    const seated = session.hostTools || seat === ProjectToolSeat.Worker || reviewer;
    // A reviewer's seat decides its look: its tool allowlist (none) narrows plugin tools only.
    const offered = seated ? appLookFor(seat).filter((tool) => reviewer || offers(session, tool.name)) : [];
    if (!offered.length) return;
    const taken = tools.plugins.find((plugin) => offered.some((tool) => tool.name === plugin.name));
    if (session.hostTools && taken) throw new Error(MESSAGE.toolCollision(taken.name));
    const chatThreadId = await this.#lookChat(p, grants, session);
    tools.look = offered;
    tools.lookCaller = { project: p.project, chatThreadId: chatThreadId ?? null, save: this.#lookSave(tools) };
  }

  /**
   * Where a look's picture may be kept: the folder a session that runs jobs writes (the chat's own
   * session, a lead, a writing worker), outside what it never touches, never while its chat is in
   * Plan; nowhere for a reader or a reviewer, which have no job tools.
   */
  #lookSave(tools: SessionTools): LookSave | null {
    const jobs = tools.jobReach;
    if (!jobs) return null;
    const chat = jobs.owner.chatThreadId;
    return { folder: jobs.folder, neverTouch: jobs.reach.neverTouch, planning: () => this.#x.planning(chat) };
  }

  /** The chat a session's look access line goes to: a worker's, a reviewer's run's, or its project tools' chat. */
  async #lookChat(
    p: DelegateParams,
    grants: DelegationGrants,
    session: DelegationSession,
  ): Promise<string | undefined> {
    if (session.worker) return session.worker.chatThreadId;
    if (session.reviewer) return (await this.chatOfGameRun(p.project, session.reviewer)) ?? undefined;
    return this.#projectToolChat(p, grants, session);
  }

  /** The chat's own session answered its turn: the jobs its turn's workers started end with it. */
  async #stopTurnJobs(p: DelegateParams, session: DelegationSession): Promise<void> {
    const turn = session.chatTurn;
    if (!turn || session.worker || !chatsOwnSession(p, session)) return;
    await this.#core.jobs
      ?.stopScope(p.project, { kind: JobScopeKind.Turn, turn }, JobStopper.ScopeEnded)
      .catch((error) => this.#logCleanupFailure("turn jobs", error));
  }

  /** A worker tool call of the chat's own session, answered by the harness's pool for the turn it answers. */
  #forwardWorkerTool(session: DelegationSession, name: string, args: Record<string, unknown>): Promise<LiveToolResult> {
    const turn = session.chatTurn;
    if (!turn) throw new Error(MESSAGE.unknownTool(name));
    const host = {
      hasCapability: (capability: HarnessCapability) => this.#core.host.hasCapability(capability),
      dispatch: (action: Parameters<StudioCore["host"]["dispatch"]>[0], timeoutMs: number) =>
        this.#core.host.dispatch(action, timeoutMs),
      planning: (threadId: string) => this.#x.planning(threadId),
      workerTypes: () =>
        this.#core.plugins.workerTypes({ facts: session.facts, ...(session.holds ? { holds: session.holds } : {}) }),
    };
    return forwardWorkerTool(host, { threadId: session.threadId, turn, name, args }, DIRECTOR_TOOL_TIMEOUT_MS);
  }

  /**
   * A run tool, answered by the harness process that owns the loops and the merge. While the chat
   * the run was started in plans, a writer's start and a merge wait for the plan's approval, as
   * the chat's own session's do (`heldInPlan`): no snapshot, copy or merge is dispatched.
   */
  async #forwardDirectorTool(
    d: Pick<DirectorGrant, "runId" | "threadId" | "project">,
    name: string,
    args: Record<string, unknown>,
  ): Promise<LiveToolResult> {
    const { runId } = d;
    if (!this.#core.host.hasCapability(HarnessCapability.Director))
      return `the studio's loop code predates the director — ${name} is unavailable until the harness is upgraded`;
    const types = name === WorkerTool.Start ? await this.#gameWorkerTypes(d.project) : [];
    const held = heldInPlan(name, args, () => types);
    if (held) {
      const planning = await this.#runPlanning(d);
      if (planning === null) return WORKER_TOOL_ANSWER.runChatUnknown;
      if (planning) return held;
    }
    try {
      const value = await this.#core.host.dispatch(
        { type: DispatchActionType.DirectorTool, runId, name, args },
        DIRECTOR_TOOL_TIMEOUT_MS,
      );
      if (isRecord(value) && typeof value.text === "string") return value as LiveToolResult;
      return typeof value === "string" ? value : JSON.stringify(value ?? null);
    } catch (err) {
      return { text: `${name} failed: ${String(errorMessage(err))}`, isError: true };
    }
  }

  /** The worker types the plugins on offer to a game: what a run lead's typed start stands as. */
  async #gameWorkerTypes(project: string): Promise<WorkerType[]> {
    const { facts, holds } = await this.#core.games
      .kindOf(project)
      .catch(() => ({ facts: [], holds: FolderHolds.Unreadable }));
    return this.#core.plugins.workerTypes({ facts, ...(holds ? { holds } : {}) });
  }

  /**
   * Whether the chat a run was started in is in Plan mode, or null when the host cannot find that
   * chat (the caller then holds what waits for a plan). The chats are the host's own records of the
   * run's starts in this game's chats, and the chat the grant names when it is this game's: any of
   * them planning holds it, so naming another chat never lifts a hold.
   */
  async #runPlanning(d: Pick<DirectorGrant, "runId" | "threadId" | "project">): Promise<boolean | null> {
    const starts = await this.#runStarts(d.runId);
    const recorded = (await this.#startedInGame(d.project, starts)) ? starts.map((event) => event.thread_id) : [];
    const named = typeof d.threadId === "string" && (await this.#openGameChat(d.project, d.threadId));
    const chats = new Set([...recorded, ...(named ? [d.threadId as string] : [])]);
    if (!chats.size) return null;
    for (const chat of chats) if (await this.#x.planning(chat)) return true;
    return false;
  }

  /**
   * Where a delegation may build: the project's live folder (the default) or a worktree under
   * scratch. Anything else is refused — the harness is agent-editable, and "point a contractor
   * at an arbitrary directory" must not be a thing it can ask for.
   */
  async delegationCwd(project: string, cwd?: string): Promise<string> {
    const live = path.resolve(this.#core.games.dirFor(project));
    if (!cwd) return live;
    const resolved = path.resolve(cwd);
    // TQ-1: on real paths — a link under scratch is somewhere else entirely.
    // M1: a worktree is sent as the real path that was checked, not as a name under the
    // sandbox-writable scratch that can be repointed between this check and the spawn. The
    // game's own folder is the registered one, exactly as when no cwd is named.
    const real = await realpath(resolved).catch(() => null);
    if (real) {
      if (real === (await realpath(live).catch(() => null))) return live;
      const scratch = await realpath(this.#core.layout.scratch).catch(() => null);
      if (scratch && isBelow(scratch, real)) return real;
    }
    throw new Error(MESSAGE.foreignCwd(cwd));
  }

  /**
   * A game file the harness reads or writes (TQ-1), checked on real paths: the folder may hold
   * links the harness's own processes planted. A write never goes through a link leaf, and the
   * folder it lands in must really be inside the game; a read's real target must be inside the
   * game or a folder the user named for it.
   */
  async gameFile(project: string, file: string, mode: "read" | "write" = "write"): Promise<string> {
    await this.#x.assertHarnessRoot(project, null);
    const base = path.resolve(this.#core.games.dirFor(project));
    const target = path.isAbsolute(file) ? path.resolve(file) : path.resolve(base, file);
    const outside = () => new Error(MESSAGE.outsideProject(file));
    const realBase = await realpath(base).catch(() => null);
    if (!realBase) throw outside();
    const link = (await lstat(target).catch(() => null))?.isSymbolicLink() === true;
    const checked = { file, base, realBase, target, link, outside };
    if (mode === "write") return this.#writableGameFile(checked);
    return this.#readableGameFile(project, checked);
  }

  async #writableGameFile(c: CheckedGameFile): Promise<string> {
    if (!isInside(c.base, c.target)) throw c.outside();
    if (c.link) throw new Error(MESSAGE.symlink(c.file));
    if (!isInside(c.realBase, await realpathNearest(path.dirname(c.target)))) throw c.outside();
    return c.target;
  }

  async #readableGameFile(project: string, c: CheckedGameFile): Promise<string> {
    if (!this.isReadable(project, c.target)) throw c.outside();
    const real = await realpath(c.target).catch(() => null);
    if (!real) {
      if (c.link) throw new Error(MESSAGE.symlink(c.file));
      if (!isInside(c.realBase, await realpathNearest(c.target))) throw c.outside();
      return c.target;
    }
    if (isInside(c.realBase, real)) return real;
    for (const root of this.#x.readRoots.get(project) ?? []) {
      const realRoot = await realpath(root).catch(() => null);
      if (realRoot && isInside(realRoot, real)) return real;
    }
    throw c.outside();
  }

  addReadRoots(project: string, dirs: string[]): void {
    let set = this.#x.readRoots.get(project);
    if (!set) {
      set = new Set();
      this.#x.readRoots.set(project, set);
    }
    for (const dir of dirs) set.add(path.resolve(dir));
  }

  /**
   * Sibling folders the contractor must not Read: other games, and the folder's neighbours where the
   * studio keeps workspaces. Never a folder it was allowed (`extraReads`, which a caller extends
   * with the delegation's own game), nor anything around a game the person keeps elsewhere.
   */
  async workspaceDenyReads(cwd: string, extraReads: string[]): Promise<string[]> {
    const resolvedCwd = path.resolve(cwd);
    const extra = extraReads.map((dir) => path.resolve(dir));
    const allowed = (dir: string): boolean => {
      const resolved = path.resolve(dir);
      if (isInside(resolved, resolvedCwd) || isInside(resolvedCwd, resolved)) return true;
      return extra.some((root) => isInside(resolved, root) || isInside(root, resolved));
    };

    const deny: string[] = [];
    for (const game of await this.#core.games.list()) {
      const dir = path.resolve(game.dir);
      if (!allowed(dir)) deny.push(dir);
    }
    // Neighbours are scanned only where the studio keeps workspaces (other games, other
    // worktrees). A game the person keeps in their home folder has the whole home as neighbours:
    // denying those would take the toolchain (~/.nvm), git's config and Claude's own files from
    // the sandboxed shell.
    const parent = path.dirname(resolvedCwd);
    const { gamesRoot, scratch } = this.#core.layout;
    const owned = [gamesRoot, scratch].some((root) => isInside(root, parent));
    for (const entry of owned ? await readdir(parent, { withFileTypes: true }).catch(() => []) : []) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const dir = path.resolve(parent, entry.name);
      if (!allowed(dir)) deny.push(dir);
    }
    return [...new Set(deny)];
  }

  async rememberContractor(
    threadId: string,
    contractor: { engine: string; sessionId: string; project: string; model?: string; effort?: string },
  ): Promise<void> {
    await this.#core.store.updateThread(threadId, { metadata: { contractor } }).catch(() => {});
    this.#core.emit(UiEvent.ThreadUpdated, { threadId, project: contractor.project });
  }

  isReadable(project: string, target: string): boolean {
    const base = path.resolve(this.#core.games.dirFor(project));
    if (isInside(base, target)) return true;
    for (const root of this.#x.readRoots.get(project) ?? []) {
      if (isInside(root, target)) return true;
    }
    return false;
  }

  async loadNamedStills(files: string[]): Promise<ReferenceFrame[]> {
    const out: ReferenceFrame[] = [];
    for (const file of files) {
      if (out.length >= MAX_NAMED_STILLS) break;
      if (!isImageFile(file)) continue;
      const data = await readFile(file).catch(() => null);
      if (!data || data.length > MAX_STILL_BYTES) continue;
      const sniffed = sniffImage(data);
      if (!sniffed) {
        this.#core.options.onLog?.(
          `[core] still skipped: ${file} is ${describeUnknownImage(data)} — the preview cannot read it`,
          "stderr",
        );
        continue;
      }
      out.push({
        label: file,
        mimeType: sniffed.mimeType,
        data: data.toString("base64"),
      });
    }
    return out;
  }

  async gameTree(project: string): Promise<string[]> {
    const base = this.#core.games.dirFor(project);
    const out: string[] = [];
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > GAME_TREE_DEPTH) return;
      for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        if (entry.name.startsWith(".") || GAME_TREE_SKIPPED.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full, depth + 1);
        else out.push(toPosixRelative(path.relative(base, full)));
      }
    };
    await walk(base, 0);
    return out.sort();
  }

  async delegate(sent: DelegateParams): Promise<HarnessResult<typeof HostMethod.EngineDelegate>> {
    const asked = await this.#briefed(sent);
    const target = await this.#resolveTarget(asked);
    const { engineId, workClass, cwd } = target;
    // Read before the lock is taken: nothing may await between the free check and the lock.
    const worker = await this.#workerSeat(asked, target);
    // A brief that names a worker is a worker's, seated or not: never a lead's or a chat turn's.
    const p = worker || namesWorker(asked) ? workerBrief(asked) : asked;
    const seat = await this.#seatOf(p, target);
    const beside = worker ? null : await this.#unseatedRunWorker(asked, target);
    const lock = this.#lockOf(p, target, worker, seat, beside);
    this.#assertWorkerRoom(worker);
    this.#assertFolderFree(lock, p);
    this.#assertNoRunWorkerBeside(lock, p, seat, beside);
    const grants = this.#grants(p, cwd, seat);
    const releasePlugins = this.#core.plugins.lease();
    // In the same tick as the lease: the tools and the brief's guidance come from one view of the
    // plugins, however long the rest of the preparation waits.
    const plugins = this.#core.plugins.snapshot(
      { facts: seat.facts, holds: seat.holds },
      toolAllowRule(p.toolAllow) ?? undefined,
    );
    // Their names from the same view: the brief's list names exactly the plugins the snapshot hands,
    // less those under the hood, whose skills reach the brief as guidance alone.
    const handed = handedPlugins(this.#core.plugins.shown(), plugins);
    const releaseMcp = this.#core.mcp.lease(p.project);
    const session = this.#session(p, target, grants, seat, worker);
    const tools = sessionTools(plugins, handed);
    // Take the lock before any await — an async deny-list walk used to leave a gap
    // where a second brief into the same folder could also pass the running check.
    const delegation = {
      ...activeDelegation(p.project, engineId, session, asked.worker?.id),
      ...besideField(beside, lock, seat, target),
    };
    this.#x.activeDelegations.set(lock, delegation);
    this.#core.budget.beginWork(workClass);
    this.#core.emit(UiEvent.DelegationStarted, this.#activeIn(p.project, engineId));
    const windows = this.#sessionWindows(grants);
    const announced = this.#x.gameChanges.get(p.project) ?? 0;
    /** The session that asks, whose end the picker must hear of: the chat's own, or a lead's. */
    let asking: PersonSession | LeadSession | null = null;
    try {
      session.mirror.afterEventId = await this.#core.store.head(session.threadId);
      await this.#prepareTools(p, target, grants, session, windows, tools);
      const reach = await this.#reach(p, target, grants, session, seat);
      asking = reach.person ?? reach.lead;
      await this.#offerJobTools(p, target, grants, session, reach, tools);
      await this.#offerLook(p, target, grants, session, tools);
      // Stop can arrive while tools are being prepared under the workspace lock.
      if (session.abort.signal.aborted)
        throw new EngineError(EngineFailureKind.Aborted, engineId, "stopped before the contractor started");
      const registered = this.#x.activeDelegations.get(lock);
      if (registered && registered.abort === session.abort) registered.started = true;
      await this.#appendActivity(session, ChatActivityPhase.Thinking, engineId, { sessionId: p.resume ?? null });
      const request = {
        ...(await this.#request(p, target, grants, session, windows, tools, reach)),
        ...this.#checkpointField(p, target, session, seat),
      };
      await this.#core.jobs.markTold(p.project, tools.jobNews.told);
      const result = await withPlanApproval({
        engine: engineId,
        request,
        run: target.delegateTo,
        signal: session.abort.signal,
        // Read when the turn ends: a plan approved mid-turn has moved the chat out of Plan by then.
        planning: () => this.#x.planning(session.threadId),
      });
      await this.#settled(p, engineId, session, result, tools);
      this.#core.budget.recordUsage(workClass, result.usage, engineId);
      return result;
    } catch (err) {
      throw await this.#failed(engineId, session, err);
    } finally {
      session.ended.abort();
      asking?.end();
      // A release that throws (a pending plugin update that cannot activate) is logged and
      // never skips the rest: the folder's lock, the budget and the windows are freed below.
      await releasePlugins().catch((error) => this.#logCleanupFailure("plugin lease", error));
      await releaseMcp().catch((error) => this.#logCleanupFailure("connector lease", error));
      await releaseSessionTools(tools, windows);
      await this.#stopTurnJobs(p, session);
      this.#core.budget.endWork(workClass);
      // Nothing more is handed in; a steer still waiting to hear from the engine hears no.
      delegation.ended = true;
      settleDoor(delegation.steer, null);
      this.#x.activeDelegations.delete(lock);
      await this.#announceKindTaken(p.project, seat, announced).catch((error) =>
        this.#logCleanupFailure("kind announcement", error),
      );
      this.#core.emit(UiEvent.DelegationFinished, this.#activeIn(p.project, engineId));
    }
  }

  /**
   * A game whose facts changed during the session from files it wrote itself (no `start_web_game`,
   * no port, which announce it): a game with no kind that took one, or one that gained a project or
   * a web build (Godot's export in `web/`). The app's game list hears it, so Live stops showing the
   * first-idea state over a page that is there and offers the views the game has now. Anything
   * announced since the start (`announced`, the game's `GameChanged` count then) already told it.
   */
  async #announceKindTaken(project: string, seat: DelegationSeat, announced: number): Promise<void> {
    if ((this.#x.gameChanges.get(project) ?? 0) !== announced) return;
    const now = await this.#core.games.kindOf(project).catch(() => null);
    if (!now || kindPending(now)) return;
    if (kindPending(seat) || factsKey(seat.facts) !== factsKey(now.facts))
      this.#core.emit(UiEvent.GameChanged, { project });
  }

  /** A cleanup step that failed after a delegation: logged, never allowed to stop the rest. */
  #logCleanupFailure(step: string, error: unknown): void {
    this.#core.options.onLog?.(MESSAGE.cleanupFailed(step, error), "stderr");
  }

  /**
   * What a session reads and may not read. A session the person is answering on an engine that
   * asks about every call reads only what the host recorded (the folders the person named, kept on
   * the thread, and the host's own frames): a harness-supplied path would otherwise become a folder
   * Accept edits writes without asking. Its reach beyond that is the person's to grant, so it gets
   * no sibling-folder deny list; nor does a build's lead, the chat's main agent, whose reads beyond
   * its folders the chat's mode decides. Another engine's chat session,
   * and a Loop's lead in place on such an engine,
   * follows the chat's mode as far as that engine can (`permissionModesFor`) and keeps the
   * unattended fence: it is denied the other games and, where the studio keeps workspaces, its
   * folder's neighbours; a worktree still reads its own game (its node_modules link and git point
   * there).
   */
  async #reach(
    p: DelegateParams,
    target: DelegationTarget,
    grants: DelegationGrants,
    session: DelegationSession,
    seat: DelegationSeat,
  ): Promise<SessionReach> {
    const worker = session.worker ? await this.#workerReach(p, target, grants, session, session.worker) : null;
    if (worker) return worker;
    const person = await this.#personSession(p, target, session);
    const asksAll = this.#core.engines.get(target.engineId).permissionPrompts === true;
    // A game linked to a project outside its folder, of an engine whose agents change it as files,
    // works there: its folder is read (and, as the session's mode allows, written) like the game's own.
    const linked = await this.#linkedFolders(p.project);
    if (person && asksAll) {
      const hostDirs = [grants.selfShotsDir];
      const recorded = await this.#x.permissions.chatReads(session.threadId, grants.extraReads, hostDirs);
      return {
        person,
        lead: null,
        worker: null,
        extraReads: [...recorded, ...linked],
        denyReads: [],
      };
    }
    const lead = person ? null : await this.#leadSession(p, target, grants, session, seat);
    // A lead in place on an engine that does not ask about every call: the chat's mode as it honours
    // it, and the fence the chat's own session on that engine keeps (never the whole Mac).
    const placed = person || lead ? null : await this.#placedLeadSession(p, target, grants, session, seat);
    if (placed) {
      const recorded = await this.#x.permissions.chatReads(session.threadId, p.extraReads ?? [], []);
      const extraReads = [...grants.hostReads, ...recorded, ...linked];
      const allowed = [...grants.extraReads, this.#core.games.dirFor(p.project), ...linked];
      const denyReads = await this.workspaceDenyReads(target.cwd, allowed);
      return { person: placed, lead: null, worker: null, extraReads, denyReads };
    }
    if (lead) {
      // A folder it reads is one Accept edits (and Auto, inside its working folders) writes without
      // asking: the host's own folders and those the chat recorded, never a folder the brief names.
      const recorded = await this.#x.permissions.chatReads(session.threadId, p.extraReads ?? [], []);
      const extraReads = [...grants.hostReads, ...recorded, ...linked];
      return { person: null, lead, worker: null, extraReads, denyReads: [] };
    }
    const allowed = [...grants.extraReads, this.#core.games.dirFor(p.project)];
    // A reviewer reads its lead's folder and its run's captures: the rest of Genex's data is fenced too.
    const fence = session.reviewer ? await this.#reviewerFence(grants.extraReads) : [];
    return {
      person,
      lead: null,
      worker: null,
      extraReads: grants.extraReads,
      denyReads: [...new Set([...(await this.workspaceDenyReads(target.cwd, allowed)), ...fence])],
    };
  }

  /**
   * What a reviewer must not read of Genex's own data beside the other games: the other runs'
   * folders (their copies of games, their captures), the agents' jobs and the exports. Never a
   * folder it reads (`reads`), nor one that holds it.
   */
  async #reviewerFence(reads: readonly string[]): Promise<string[]> {
    const { exports, jobs, runs, scratch } = this.#core.layout;
    const real = (dir: string) => realpath(dir).catch(() => path.resolve(dir));
    const children = async (root: string) => {
      const at = await real(root);
      const entries = await readdir(at, { withFileTypes: true }).catch(() => []);
      return entries.filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => path.join(at, e.name));
    };
    const fenced = [
      await real(jobs),
      await real(exports),
      ...(await children(runs)),
      ...(await children(path.join(scratch, "autopilot"))),
    ];
    const reached = (dir: string) => reads.some((read) => isInside(dir, read) || isInside(read, dir));
    return fenced.filter((dir) => !reached(dir));
  }

  /**
   * A worker's reach: its seat in its lead's chat's mode, writing its own folder, the chat's
   * granted folders and its plugins' folders, never what the never-touch list names; it reads the
   * host's own folders and those the chat recorded. Null when the chat is no longer this game's
   * open chat: it then runs unattended, as any delegation the host cannot place.
   */
  async #workerReach(
    p: DelegateParams,
    target: DelegationTarget,
    grants: DelegationGrants,
    session: DelegationSession,
    found: WorkerFinding,
  ): Promise<SessionReach | null> {
    const chat = await this.#x.permissions.forWorker({
      project: p.project,
      threadId: found.chatThreadId,
      worker: { id: found.id, title: found.title },
      runId: found.runId,
      engine: target.engineId,
      model: p.model ?? "",
      asks: this.#core.engines.get(target.engineId).permissionPrompts === true,
      cwd: target.workCwd,
      signal: session.abort.signal,
    });
    if (!chat) return null;
    const recorded = await this.#x.permissions.chatReads(found.chatThreadId, p.extraReads ?? [], []);
    const runReads = found.runId ? await this.#runReads(found.runId, p.extraReads ?? []) : [];
    const open = [...this.#workerOpen(p.project, target, grants), ...runReads];
    const neverTouch = await this.#neverTouch(p.project, open);
    const worker: WorkerSeat = {
      id: found.id,
      title: found.title,
      mode: chat.mode,
      writeRoots: writableRoots(await this.#writeRoots(target.workCwd, found.chatThreadId, p.project), neverTouch),
      neverTouch,
      research: found.research,
      ...(chat.asks ? { asks: chat.asks } : {}),
    };
    const extraReads = [...new Set([...grants.hostReads, ...recorded, ...runReads])];
    return { person: null, lead: null, worker, extraReads, denyReads: [] };
  }

  /**
   * The folders a run's harness hands its worker to read that are that run's own (its spike and
   * base worktrees under its scratch folder, its captures), by real path: they stay open in the
   * never-touch list though Genex's data holds them. Any other folder the harness names is read
   * only when the chat recorded it.
   */
  async #runReads(runId: string, asked: readonly string[]): Promise<string[]> {
    const folders = [
      await this.#runFolder(runId),
      await realpath(runDir(this.#core.layout.runs, runId)).catch(() => null),
    ].filter((dir): dir is string => dir !== null);
    if (!folders.length) return [];
    const real = await Promise.all(asked.map((dir) => realpath(path.resolve(dir)).catch(() => null)));
    const own = real.filter((dir): dir is string => dir !== null && folders.some((folder) => isBelow(folder, dir)));
    return [...new Set(own)];
  }

  /**
   * What a worker's box may let it write: its own folder, the folders the person granted the chat,
   * the enabled plugins' folders for their engine programs and the project its game is linked to
   * outside its folder when its engine writes projects as files, by their real paths. A folder that does not exist yet is left out until it
   * does; the seat then drops any that is, holds or sits in a never-touch root (`writableRoots`),
   * whatever granted it.
   */
  async #writeRoots(cwd: string, chatThreadId: string, project: string): Promise<string[]> {
    const asked = [
      cwd,
      ...this.#x.permissions.chatDirs(chatThreadId),
      ...this.#core.plugins.workerFolders(),
      ...(await this.#linkedFolders(project)),
    ];
    const real = await Promise.all(asked.map((dir) => realpath(dir).catch(() => null)));
    return [...new Set(real.filter((dir): dir is string => dir !== null))];
  }

  /**
   * The folder of the project a game is linked to, when it lies outside the game's folder (one
   * inside is the game's already) and its engine declares that its agents change the project as
   * files (`writesProjectFiles`, as Godot's do); an engine whose agents change an outside project
   * only through its editor (Unreal's) gets none, as does a web game.
   */
  async #linkedFolders(project: string): Promise<string[]> {
    const dir = this.#core.games.dirFor(project);
    const catalog = this.#core.plugins.engines();
    const binding = await readEngineBinding(dir, catalog).catch(() => undefined);
    if (!binding || catalog.get(binding.kind)?.writesProjectFiles !== true) return [];
    const folder = path.dirname(binding.project);
    const root = await realpath(dir).catch(() => path.resolve(dir));
    return isInside(root, folder) ? [] : [folder];
  }

  /** The folders a worker keeps inside the never-touch list's roots: its own, its run's captures, its game's. */
  #workerOpen(project: string, target: DelegationTarget, grants: DelegationGrants): string[] {
    const captures = grants.hostReads.filter((dir) => isInside(this.#core.layout.runs, path.resolve(dir)));
    return [target.workCwd, ...captures, path.resolve(this.#core.games.dirFor(project))];
  }

  /**
   * What no worker of this game reaches, in any mode: the sign-ins (the coding CLIs' homes, the
   * sign-in stores every agent's box denies, Genex's login, secrets and engine homes), Genex's own
   * data (this profile's and any other the app named, `StudioCoreOptions.neverTouch`), and every
   * other game (this profile's, and the other profiles' folders the app named,
   * `StudioCoreOptions.neverTouchGames`).
   */
  async #neverTouch(project: string, open: string[]) {
    const { layout } = this.#core;
    const own = path.resolve(this.#core.games.dirFor(project));
    const games = await this.#core.games.list();
    const sources = {
      home: os.homedir(),
      credentialHomes: credentialHomes(),
      signInStores: baseDenyRead(),
      genexLogins: [layout.secrets, layout.engineHomes],
      genexData: [path.dirname(layout.exoharness), ...(this.#core.options.neverTouch ?? [])],
      otherGames: [
        ...games.map((game) => path.resolve(game.dir)).filter((dir) => dir !== own),
        ...(this.#core.options.neverTouchGames ?? []),
      ],
    };
    return neverTouchList(sources, open);
  }

  /**
   * The permissions of the chat's own session a person is answering, or null for every other
   * delegation. The chat's own turn only, on any engine (each honours the chat's mode as far as it
   * can, `permissionModesFor`): the brief has no narrower job, it answers a message (`chatTurn`,
   * which the permission service checks the person sent on this thread) and it works in its game's
   * own folder. A build's lead answers the chat too, from its own seat (`#leadSession`), on an
   * engine that asks about every call.
   */
  async #personSession(
    p: DelegateParams,
    target: DelegationTarget,
    session: DelegationSession,
  ): Promise<PersonSession | null> {
    const chatsOwn = !unattendedBrief(p) && !session.leadTurn && isChatsOwnSession(p);
    const { chatTurn } = session;
    if (!chatsOwn || !chatTurn || typeof p.threadId !== "string") return null;
    if (target.workCwd !== path.resolve(this.#core.games.dirFor(p.project))) return null;
    return this.#x.permissions.forSession({
      project: p.project,
      threadId: p.threadId,
      messageId: chatTurn,
      engine: target.engineId,
      model: p.model ?? "",
      cwd: target.workCwd,
      signal: session.abort.signal,
    });
  }

  /**
   * How a build's lead asks, or null (unattended work). Only where its engine asks and the seat is
   * the host's own finding: this game's lead of a run started in this chat, answering the chat
   * (`chatTurn` is its run). The permission service then checks the thread is this game's open chat,
   * and routes every question by the chat's mode.
   */
  async #leadSession(
    p: DelegateParams,
    target: DelegationTarget,
    grants: DelegationGrants,
    session: DelegationSession,
    seat: DelegationSeat,
  ): Promise<LeadSession | null> {
    const threadId = p.threadId;
    const asks = this.#core.engines.get(target.engineId).permissionPrompts === true;
    const { leads } = seat;
    if (!asks || !leads || typeof threadId !== "string") return null;
    if (!(await this.#answersChat(p, grants, session, threadId))) return null;
    return this.#x.permissions.forLead({
      project: p.project,
      threadId,
      engine: target.engineId,
      model: p.model ?? "",
      cwd: target.workCwd,
      // The lead builds in the worktree it leads, as its seat checked it.
      leads,
      signal: session.abort.signal,
    });
  }

  /**
   * How a Loop's lead asks on an engine that does not ask about every call, or null: only for the
   * seat `#leadSession` checks (this game's lead of a run started in this chat, answering it), in the
   * game folder itself or leading the run's integration worktree from it. It runs in the chat's mode
   * as that engine honours it, as the chat's own session there does (Bypass unboxed, Plan read-only);
   * without it such a lead would run unattended, whatever the chat's mode, a Plan chat's included.
   */
  async #placedLeadSession(
    p: DelegateParams,
    target: DelegationTarget,
    grants: DelegationGrants,
    session: DelegationSession,
    seat: DelegationSeat,
  ): Promise<PersonSession | null> {
    const threadId = p.threadId;
    const asks = this.#core.engines.get(target.engineId).permissionPrompts === true;
    const { leads } = seat;
    if (asks || !leads || typeof threadId !== "string") return null;
    if (!(await this.#answersChat(p, grants, session, threadId))) return null;
    return this.#x.permissions.forPlacedLead({
      project: p.project,
      threadId,
      engine: target.engineId,
      model: p.model ?? "",
      cwd: target.workCwd,
      leads,
      signal: session.abort.signal,
    });
  }

  /** Does this lead answer the person in this chat: the lead of a run started here, its turn that run's? */
  async #answersChat(
    p: DelegateParams,
    grants: DelegationGrants,
    session: DelegationSession,
    threadId: string,
  ): Promise<boolean> {
    const { director } = grants;
    if (!director) return false;
    const answersChat = session.chatTurn === director.runId && director.threadId === threadId;
    return answersChat && (await this.#runOfChat(p.project, threadId, director.runId));
  }

  /** The engine, the budget class and the folder a brief runs in; everything here is checked before the lock. */
  async #resolveTarget(p: DelegateParams): Promise<DelegationTarget> {
    // No engine named (a harness tool that predates two subscriptions, a resumed brief):
    // whichever subscription is actually signed in, rather than a hardcoded guess that
    // fails for someone who only has the other one.
    const engineId = p.engine ?? (await this.#core.defaultDelegatedEngine());
    const engine = this.#core.engines.get(engineId);
    const steersMidTurn = engine.steersMidTurn === true;
    const delegateTo = engine.delegate?.bind(engine);
    if (!delegateTo) throw new Error(MESSAGE.directEngine(engineId));
    if (p.compact && !(engine.compactsNatively && p.resume)) throw new Error(MESSAGE.cannotCompact(engineId));
    const workClass = workClassOf(p.class);
    this.#core.budget.assertAllowed(workClass);
    const workCwd = await this.#workCwd(p, engineId);
    // The contractor runs in the checked real path (M1); the delegation stays keyed by the
    // name its caller used, which is the name engine.abort and engine.interrupt send.
    const cwd = p.cwd ? path.resolve(p.cwd) : workCwd;
    return { engineId, delegateTo, workClass, workCwd, cwd, steersMidTurn };
  }

  async #workCwd(p: DelegateParams, engineId: string): Promise<string> {
    // A reviewer (honoured, or `delegate` refused it) sits in its run's home: the lead holds its folder.
    if (p.reviewer) return this.#reviewerHome(p.reviewer.runId, engineId);
    return this.delegationCwd(p.project, p.cwd);
  }

  /**
   * What a delegation runs as: a Loop's reviewer's brief (`#reviewerSeat`, which refuses one it
   * cannot place before any engine is asked for), or what was sent.
   */
  async #briefed(sent: DelegateParams): Promise<DelegateParams> {
    const reviewer = await this.#reviewerSeat(sent);
    return reviewer ? reviewerBrief(sent, reviewer) : sent;
  }

  /**
   * A reviewer's home for one call: a fresh empty folder in its run's home on one engine, in the
   * host's own reviewers folder, which no box writes (scratch is every box's). The earlier calls'
   * homes there go first. Made by real path; a link or a file on the way is refused, never
   * followed, and a home that is not where it was made is refused.
   */
  async #reviewerHome(runId: string, engineId: string): Promise<string> {
    const root = await realpath(this.#core.layout.reviewers);
    const home = createHash("sha256").update(runId).digest("hex").slice(0, 24);
    let dir = root;
    for (const part of [home, safePathSegment(engineId)]) {
      dir = path.join(dir, part);
      const info = await lstat(dir).catch(() => null);
      if (info && !info.isDirectory()) throw new Error(MESSAGE.reviewerRefused);
    }
    // The run's earlier reviewers' homes on this engine go: each call starts empty.
    await rm(dir, { recursive: true, force: true });
    const call = path.join(dir, randomUUID());
    await ensureDir(call);
    if ((await realpath(call)) !== call) throw new Error(MESSAGE.reviewerRefused);
    return call;
  }

  /**
   * A Loop's reviewer, on the host's own finding, or null when none was asked for. Honoured only for
   * a read-only session, of a run the host's records say is this game's (`#runOfGame`), reading the
   * game's folder or the run's own copy of it (`#reviewerReads`); anything else is refused (thrown)
   * before any engine is asked for. The run's captures folder is made so it can be read.
   */
  async #reviewerSeat(p: DelegateParams): Promise<ReviewerFinding | null> {
    const asked = p.reviewer;
    if (!asked) return null;
    const named = typeof asked.runId === "string" && typeof asked.reads === "string";
    if (p.readOnly !== true || !named) throw new Error(MESSAGE.reviewerRefused);
    if (!(await this.#runOfGame(p.project, asked.runId))) throw new Error(MESSAGE.reviewerRefused);
    const reads = await this.#reviewerReads(p.project, asked.runId, asked.reads);
    if (!reads) throw new Error(MESSAGE.reviewerRefused);
    return { runId: asked.runId, reads, captures: await this.#reviewerCaptures(asked.runId) };
  }

  /**
   * The run's captures folder a reviewer reads, made when missing: refused when it is not where the
   * runs folder holds it by real path (a link to anywhere else would add a read root).
   */
  async #reviewerCaptures(runId: string): Promise<string> {
    const dir = runDir(this.#core.layout.runs, runId);
    const info = await lstat(dir).catch(() => null);
    if (info && !info.isDirectory()) throw new Error(MESSAGE.reviewerRefused);
    await ensureDir(dir);
    const expected = path.join(await realpath(this.#core.layout.runs), path.basename(dir));
    const real = await realpath(dir);
    if (real !== expected || path.dirname(dir) !== path.resolve(this.#core.layout.runs)) {
      throw new Error(MESSAGE.reviewerRefused);
    }
    return real;
  }

  /**
   * The folder a reviewer reads, by real path: the game's own (as registered), or a worktree of the
   * game's own repository inside the run's folder under scratch (as `#inPlaceRoot` checks a lead's).
   * Null for anything else: another game, a link that leads elsewhere, another repository, nothing.
   */
  async #reviewerReads(project: string, runId: string, asked: string): Promise<string | null> {
    const live = path.resolve(this.#core.games.dirFor(project));
    const real = await realpath(path.resolve(asked)).catch(() => null);
    if (!real) return null;
    if (real === (await realpath(live).catch(() => null))) return live;
    const runFolder = await this.#runFolder(runId);
    if (!runFolder || !isBelow(runFolder, real)) return null;
    return (await sameRepository(live, real)) ? real : null;
  }

  /** The engine the delegation's game builds in; a game whose record can't be read is a web game. */
  async #gameEngine(project: string): Promise<EngineId> {
    const directory = this.#core.games.dirFor(project);
    return engineOf(await readEngineBinding(directory, this.#core.plugins.engines()).catch(() => undefined));
  }

  /**
   * Whether this delegation sits in its game's own folder, and whether its director grant is a
   * lead's there (one session): the lead of a waking run is its chat's own session, so it sits
   * and works in the game folder itself.
   */
  async #seatOf(p: DelegateParams, target: DelegationTarget): Promise<DelegationSeat> {
    const live = path.resolve(this.#core.games.dirFor(p.project));
    // The game's own folder: no build worktree.
    const gameFolder = target.cwd === live;
    const leads = gameFolder ? await this.#inPlaceRoot(p, live) : null;
    const { facts, holds } = await this.#core.games
      .kindOf(p.project)
      .catch(() => ({ facts: [], holds: FolderHolds.Unreadable }));
    return {
      leads,
      gameFolder,
      engine: await this.#gameEngine(p.project),
      facts,
      ...(holds ? { holds } : {}),
    };
  }

  /**
   * A Loop's lead in place: the game folder as registered (`live`), or null, and the grant is
   * dropped. Honoured only for a lead that may write (never `readOnly`), of this game, whose root is
   * the game folder by name and by real path (never a link to it, nor a folder inside it), in this
   * game's own chat, open (never
   * an archived one, nor one whose record can't be read: nobody would answer its questions), for a
   * run the host's records say is this game's, was started in the chat the delegation and its grant
   * both name (`#runOfChat`) and is going now (`#runRunning`): never a run that finished or paused.
   */
  async #inPlaceRoot(p: DelegateParams, live: string): Promise<string | null> {
    const d = p.director;
    if (!d) return null;
    const asked = p.readOnly !== true && d.project === p.project && path.resolve(d.root) === live;
    const sameChat = typeof p.threadId === "string" && d.threadId === p.threadId;
    if (!asked || !sameChat) return null;
    const [root, game] = await Promise.all([realpath(d.root).catch(() => null), realpath(live).catch(() => null)]);
    if (!root || root !== game) return null;
    if (!(await this.#openGameChat(p.project, d.threadId))) return null;
    if (!(await this.#runOfChat(p.project, d.threadId, d.runId))) return null;
    if (!(await this.#runRunning(d.runId))) return null;
    this.#inPlaceRuns.add(d.runId);
    return live;
  }

  /**
   * A run's own folder under scratch, checked real: one plain directory named by its id — never a
   * link to another run's folder, nor a name that climbs out or reaches into one.
   */
  async #runFolder(runId: string): Promise<string | null> {
    const autopilot = await realpath(path.join(this.#core.layout.scratch, "autopilot")).catch(() => null);
    if (!autopilot) return null;
    const folder = path.join(autopilot, String(runId));
    if (path.dirname(folder) !== autopilot) return null;
    return (await realpath(folder).catch(() => null)) === folder ? folder : null;
  }

  /**
   * The host's own records say this run is this game's: it was started in a chat of this game and in
   * no other game's chat. Any run id can hold a worktree of any game (`snapshot.worktree`), so the
   * folder alone never says whose run it is.
   */
  async #runOfGame(project: string, runId: string): Promise<boolean> {
    return this.#startedInGame(project, await this.#runStarts(runId));
  }

  /** Whether this run is this game's by the host's own records: `preview.computer`'s run check. */
  runOfGame(project: string, runId: string): Promise<boolean> {
    return this.#runOfGame(project, runId);
  }

  /**
   * The chat a run of this game reports to, by the host's own records (`#runOfGame`): the chat its
   * first start was recorded in; null for a run that is not this game's or that no chat started.
   */
  async chatOfGameRun(project: string, runId: string): Promise<string | null> {
    const starts = await this.#runStarts(runId);
    if (!(await this.#startedInGame(project, starts))) return null;
    return starts[0]?.thread_id ?? null;
  }

  /** The chat a run of this game reports to (`chatOfGameRun`) while it is going now (`#runRunning`); null otherwise. */
  async chatOfRunningGameRun(project: string, runId: string): Promise<string | null> {
    if (!(await this.#runRunning(runId))) return null;
    return this.chatOfGameRun(project, runId);
  }

  /** This game's run (`#runOfGame`), started in this chat. */
  async #runOfChat(project: string, threadId: string, runId: string): Promise<boolean> {
    const starts = await this.#runStarts(runId);
    if (!starts.some((event) => event.thread_id === threadId)) return false;
    return this.#startedInGame(project, starts);
  }

  /** The records that started (or restarted) this run, in any chat. */
  async #runStarts(runId: string): Promise<EventEnvelope[]> {
    return (await this.#core.activityEvents()).filter((event) => startsRun(event, runId));
  }

  /** Some start, and every one in a chat of this game, naming no other game. */
  async #startedInGame(project: string, starts: readonly EventEnvelope[]): Promise<boolean> {
    if (!starts.length) return false;
    const games = new Map((await this.#core.store.listThreads()).map((thread) => [thread.id, threadGame(thread)]));
    return starts.every((event) => games.get(event.thread_id) === project && startNames(event, project));
  }

  /**
   * Whether the harness's worker grant is honoured, on the host's own finding, or null (the session
   * then runs unattended, as before): a worker of a run that is running and was started in exactly
   * one open chat of this game, in the game's folder or a copy of the game in that run's own folder;
   * or a worker of the chat turn the chat's own session answers now, on that chat, in the game's
   * folder or a copy of the game under scratch.
   */
  async #workerSeat(p: DelegateParams, target: DelegationTarget): Promise<WorkerFinding | null> {
    const asked = p.worker;
    if (typeof asked?.id !== "string" || !asked.id) return null;
    if (!this.#seatsWorkers(target.engineId)) return null;
    const inPlace = target.workCwd === path.resolve(this.#core.games.dirFor(p.project));
    const runId = typeof asked.runId === "string" && asked.runId ? asked.runId : null;
    const chatThreadId = runId
      ? await this.#runWorkerChat(p, runId, target.workCwd, inPlace)
      : await this.#turnWorkerChat(p, asked.turn, target.workCwd, inPlace);
    if (!chatThreadId) return null;
    const title = workerTitle(asked);
    const turn = !runId && typeof asked.turn === "string" ? asked.turn : null;
    return { id: asked.id, title, research: asked.research === true, chatThreadId, runId, turn, inPlace };
  }

  /**
   * The holder of a worker the harness asked for in the game's own folder whose session the host
   * does not seat (`#workerSeat` answered null): the harness held its in-place locks for its life
   * under this name (`locks.hold`), so its own calls pass them instead of waiting behind itself.
   * Null for a worker in a copy, or a session that names no worker.
   */
  #unseatedHolder(p: DelegateParams, target: DelegationTarget): string | null {
    const asked = p.worker;
    if (typeof asked?.id !== "string" || !asked.id) return null;
    if (typeof p.threadId !== "string" || !p.threadId) return null;
    if (target.workCwd !== path.resolve(this.#core.games.dirFor(p.project))) return null;
    const runId = typeof asked.runId === "string" && asked.runId ? asked.runId : null;
    return workerHolder({ threadId: p.threadId, runId, id: asked.id });
  }

  /**
   * The key a delegation holds while it runs. A lead holds the build it leads, never its game's
   * folder: the chat's other turns there, and Make it live, go on while it thinks (one session). Its
   * prompt leaves the game's changes to its builders; the chat's mode alone decides what it may do.
   * A lead in place holds the game folder it writes in. A seated in-place worker holds its own; so
   * does an unseated one of a run whose lead in place the host seated (`#unseatedRunWorker`), for its
   * whole life, whether that lead's turn holds the folder at this moment or not; any other session
   * there holds the folder's key. Synchronous: nothing awaits between it and the lock.
   */
  #lockOf(
    p: DelegateParams,
    target: DelegationTarget,
    worker: WorkerFinding | null,
    seat: DelegationSeat,
    beside: UnseatedRunWorker | null,
  ): string {
    if (worker?.inPlace) return workerLockKey(target.cwd, worker.id);
    const folder = seat.leads ?? target.cwd;
    return beside !== null && this.#inPlaceRuns.has(beside.runId) ? workerLockKey(target.cwd, beside.id) : folder;
  }

  /**
   * A run's unseated worker in the game folder (on its own key, `#lockOf`) and the folder's key
   * never meet but for that run's own lead in place: the worker starts beside no other session
   * holding the folder (the person's turn), and no other session takes the folder beside it.
   */
  #assertNoRunWorkerBeside(
    lock: string,
    p: DelegateParams,
    seat: DelegationSeat,
    beside: UnseatedRunWorker | null,
  ): void {
    const live = path.resolve(this.#core.games.dirFor(p.project));
    if (beside && lock !== live) {
      this.#assertFolderFreeBesides(live, p, beside.runId);
      return;
    }
    if (lock !== live) return;
    const ownRun = seat.leads ? p.director?.runId : undefined;
    const worker = [...this.#x.activeDelegations.values()].find(
      (delegation) =>
        delegation.project === p.project && delegation.besideLeadOf !== undefined && delegation.besideLeadOf !== ownRun,
    );
    if (!worker) return;
    const minutes = Math.round((Date.now() - worker.startedAt) / MINUTE_MS);
    throw new DelegationRefusedError(DelegationRefusal.FolderBusy, MESSAGE.loopWorkerBusy(`"${p.project}"`, minutes));
  }

  /** A run's unseated worker starts on its own key only while the folder is free or its run's lead in place holds it. */
  #assertFolderFreeBesides(live: string, p: DelegateParams, runId: string): void {
    const holder = this.#x.activeDelegations.get(live);
    if (holder && holder.leadsInPlace !== runId) this.#assertFolderFree(live, p);
  }

  /**
   * A worker of this game's run in the game folder whose session the host does not seat, on the
   * host's own finding, or null: an engine Genex never seats (a direct one), a brief with no
   * director grant, a run started in exactly the chat the delegation names (`#runChat`) and going
   * now (`#runRunning`). One of a run whose lead in place the host seated holds its own key
   * (`#lockOf`) for its whole life: its lead works beside it, the in-place locks (`locks.hold`) guard
   * the writers, and no other session takes the folder meanwhile (`#assertNoRunWorkerBeside`). A run
   * id the host can't confirm takes the folder's key, as any session there does.
   */
  async #unseatedRunWorker(p: DelegateParams, target: DelegationTarget): Promise<UnseatedRunWorker | null> {
    const runId = p.worker?.runId;
    if (typeof runId !== "string" || !runId || p.director || this.#seatsWorkers(target.engineId)) return null;
    if (!this.#unseatedHolder(p, target)) return null;
    if ((await this.#runChat(p.project, runId)) !== p.threadId) return null;
    if (await this.#runRunning(runId)) return { id: String(p.worker?.id), runId };
    // A run that ended keeps no lead in place: its id is let go.
    this.#inPlaceRuns.delete(runId);
    return null;
  }

  /**
   * Whether an engine carries a worker's seat — and so its workers, jobs and looks: every engine that
   * runs an agent session in a folder, a delegated CLI (Claude Code, Codex, …) or a local model's
   * session Genex runs itself (Bonsai, OpenRouter, a local server: local-session.ts), each in the
   * seat's mode, write roots and never-touch list. Any model orchestrates alike. Only an engine with
   * no session of its own (Ollama's harness tool loop) runs its work unattended, with the sibling
   * deny list.
   */
  #seatsWorkers(engineId: string): boolean {
    const engine = this.#core.engines.get(engineId);
    if (engine.kind === EngineKind.Delegated) return true;
    return engine.supportsSessions === true && typeof engine.delegate === "function";
  }

  /** The chat a run worker answers to: its run's one chat, running, and its folder that run's. */
  async #runWorkerChat(p: DelegateParams, runId: string, cwd: string, inPlace: boolean): Promise<string | null> {
    const chat = await this.#runChat(p.project, runId);
    if (!chat || !(await this.#runRunning(runId))) return null;
    // The delegation names that chat, or a thread that is no game chat at all (the run's own).
    const elsewhere = typeof p.threadId === "string" && p.threadId !== chat;
    if (elsewhere && (await this.#isGameChat(p.threadId as string))) return null;
    if (inPlace) return chat;
    const runFolder = await this.#runFolder(runId);
    if (!runFolder || !isBelow(runFolder, cwd)) return null;
    return (await sameRepository(this.#core.games.dirFor(p.project), cwd)) ? chat : null;
  }

  /** The chat a turn worker answers to: the open chat whose own session answers `turn` now. */
  async #turnWorkerChat(p: DelegateParams, turn: unknown, cwd: string, inPlace: boolean): Promise<string | null> {
    const threadId = p.threadId;
    if (typeof turn !== "string" || !turn || typeof threadId !== "string") return null;
    if (!(await this.#openGameChat(p.project, threadId))) return null;
    const live = path.resolve(this.#core.games.dirFor(p.project));
    const answering = this.#x.activeDelegations.get(live);
    const answers = answering?.threadId === threadId && answering.chatTurn === turn && !answering.ended;
    if (!answers || answering.worker) return null;
    if (inPlace) return threadId;
    const scratch = await realpath(this.#core.layout.scratch).catch(() => null);
    if (!scratch || !isBelow(scratch, cwd)) return null;
    return (await sameRepository(live, cwd)) ? threadId : null;
  }

  /** The one chat a run was started in, when it is this game's open chat and the run names no other game. */
  async #runChat(project: string, runId: string): Promise<string | null> {
    const starts = await this.#runStarts(runId);
    const chats = new Set(starts.map((event) => event.thread_id));
    const [chat] = chats;
    if (chats.size !== 1 || !chat || !(await this.#startedInGame(project, starts))) return null;
    return (await this.#openGameChat(project, chat)) ? chat : null;
  }

  /** Whether the host's own records say the run is going. */
  async #runRunning(runId: string): Promise<boolean> {
    const runs = await this.#core.activityItems();
    return runs.some((item) => item.runId === runId && item.runOutcome?.state === ExecutionStatus.Running);
  }

  /** Whether a thread is this game's own chat, open: never a thread the harness made, another game's or an archived one. */
  async #openGameChat(project: string, threadId: string): Promise<boolean> {
    const meta = (await this.#core.store.getRecord(threadId).catch(() => null))?.metadata;
    return meta?.kind === ThreadKind.Game && meta.project === project && meta.archived !== true;
  }

  /** Whether a thread is any game's chat. */
  async #isGameChat(threadId: string): Promise<boolean> {
    return (await this.#core.store.getRecord(threadId).catch(() => null))?.metadata?.kind === ThreadKind.Game;
  }

  /**
   * The Settings ceiling: a chat runs at most as many workers at once as the person allows, readers
   * and writers alike. Checked before the lock is taken, so a refusal leaves nothing behind.
   */
  #assertWorkerRoom(worker: WorkerFinding | null): void {
    if (!worker) return;
    const max = this.#core.settings.buildersMax;
    const running = [...this.#x.activeDelegations.values()].filter(
      (delegation) => delegation.worker?.chatThreadId === worker.chatThreadId,
    ).length;
    if (running >= max) throw new DelegationRefusedError(DelegationRefusal.TooManyWorkers, MESSAGE.tooManyWorkers(max));
  }

  #assertFolderFree(lock: string, p: DelegateParams): void {
    const running = this.#x.activeDelegations.get(lock);
    if (!running) return;
    const minutes = Math.round((Date.now() - running.startedAt) / MINUTE_MS);
    const where = p.cwd ? `"${p.project}" (worktree ${path.basename(lock)})` : `"${p.project}"`;
    // The person's other chats of the game hear that the Loop holds it, not a contractor.
    const words = running.leadsInPlace ? MESSAGE.loopLeadBusy : MESSAGE.folderBusy;
    throw new DelegationRefusedError(DelegationRefusal.FolderBusy, words(where, minutes));
  }

  /**
   * The capture and director grants, each honoured only for the folder this delegation
   * builds in — and a lead's director grant for its game's folder (`seat`).
   */
  #grants(p: DelegateParams, cwd: string, seat: DelegationSeat): DelegationGrants {
    const runs = this.#core.layout.runs;
    // Builder eyes: honoured only for the workspace this delegation actually builds in —
    // a capture grant pointing anywhere else is dropped by construction.
    const selfCapture = p.selfCapture && path.resolve(p.selfCapture.root) === cwd ? p.selfCapture : null;
    const director = honouredDirector(p, seat);
    const selfShotsDir = selfCapture ? runShotsDir(runs, selfCapture.runId, selfCapture.facetId, ShotKind.Self) : null;
    // The capture output rides along as a read root, so the contractor can Read its own frames.
    const hostReads = [
      ...(selfShotsDir ? [selfShotsDir] : []),
      ...(director ? this.#directorReads(p.project, director) : []),
    ];
    const extraReads = [...(p.extraReads ?? []), ...hostReads];
    return { selfCapture, selfShotsDir, director, hostReads, extraReads };
  }

  /** What a lead may read beyond its folder: its run's artifacts, and its game's folder. */
  #directorReads(project: string, director: DirectorGrant): string[] {
    return [runDir(this.#core.layout.runs, director.runId), this.#core.games.dirFor(project)];
  }

  #session(
    p: DelegateParams,
    target: DelegationTarget,
    grants: DelegationGrants,
    seat: DelegationSeat,
    worker: WorkerFinding | null,
  ): DelegationSession {
    const threadId = threadOr(this.#core, p.threadId);
    const { selfCapture, director } = grants;
    const activityScope = {
      delegationId: uuidv7(),
      ...askedScope(p, { director, selfCapture }),
    };
    const chatTurn = chatTurnOf(p, { director });
    const runControls = honouredRunControls(p);
    // A run's worker's plugin calls are its run's: recorded on its own node, answering to its chat.
    // A builder with a round of its own (its capture grant) keeps it: its calls stay on that round.
    const attribution = attributionOf(p) ?? (selfCapture ? null : workerAttribution(worker));
    return {
      ...(chatTurn ? { chatTurn } : {}),
      ...(runControls ? { runControls } : {}),
      // The run whose own consent may cover its calls to its game's engine connector: an honoured
      // director grant's, seated in this game's own folder (a Loop's lead). Asked again at each call.
      liveRun: director?.runId ?? null,
      ...(chatTurn && target.steersMidTurn ? { door: openDoor() } : {}),
      ...(chatTurn ? { tools: toolsInFlight(target.engineId), personWrote: personWroteWatch() } : {}),
      threadId,
      hostTools: hostToolsEligible(p, seat),
      offered: toolAllowRule(p.toolAllow),
      attribution,
      credits: runCreditCap(p.creditCap, attribution?.runId ?? worker?.runId ?? director?.runId),
      worker,
      reviewer: p.reviewer?.runId ?? null,
      unseatedHolder: worker ? null : this.#unseatedHolder(p, target),
      activityScope,
      leadTurn: Boolean(director),
      chatLead: Boolean(director?.chatSession === true && seat.leads),
      leads: seat.leads,
      facts: seat.facts,
      ...(seat.holds ? { holds: seat.holds } : {}),
      abort: new AbortController(),
      ended: new AbortController(),
      mirror: delegationMirror({
        core: this.#core,
        cwd: target.workCwd,
        threadId,
        requestThreadId: p.threadId,
        project: p.project,
        engineId: target.engineId,
        requestedModel: p.model,
        activityScope,
      }),
    };
  }

  #sessionWindows(grants: DelegationGrants): SessionWindows {
    const { selfCapture } = grants;
    return {
      // The builder's window for the whole session: capture reloads it, the computer tool
      // keeps playing in it, the agent-screen card in the UI watches it.
      self: selfCapture
        ? this.#x.previews.sessionPortFor({
            handle: selfCapture.handle,
            label: `build:${selfCapture.facetId ?? selfCapture.project}`,
          })
        : null,
    };
  }

  /** A delegation starting or finishing, with how many of the project's are running now. */
  #activeIn(project: string, engineId: string): { project: string; engine: string; active: number } {
    const active = [...this.#x.activeDelegations.values()].filter((d) => d.project === project).length;
    return { project, engine: engineId, active };
  }

  async #appendActivity(
    session: DelegationSession,
    phase: ChatActivityPhase,
    engineId: string,
    extra: { sessionId?: string | null } = {},
  ): Promise<void> {
    await this.#core.append(
      [scopedRecord(CustomEvent.SessionActivity, { phase, engine: engineId, ...extra, ...session.activityScope })],
      session.threadId,
    );
  }

  /**
   * A lead's turn ended: say how, so the chat's line and the build card fall back to the build's
   * work while the lead waits, without reading as the run's end. Never turns a delegation's
   * outcome into an error, nor hides the one it already has.
   */
  async #leadTurnEnded(session: DelegationSession, phase: ChatActivityPhase, engineId: string, sessionId?: string) {
    if (!session.leadTurn) return;
    await this.#appendActivity(session, phase, engineId, { sessionId: sessionId ?? null }).catch((err) =>
      this.#core.options.onLog?.(MESSAGE.turnEndUnrecorded(err), "stderr"),
    );
  }

  /** Everything the session is handed, prepared under its lock: awaits live under the lock. */
  async #prepareTools(
    p: DelegateParams,
    target: DelegationTarget,
    grants: DelegationGrants,
    session: DelegationSession,
    windows: SessionWindows,
    tools: SessionTools,
  ): Promise<void> {
    const { engineId, cwd } = target;
    // Covers belong to the desktop host (which also bakes legacy GLSL covers); test rigs opt in.
    if (session.hostTools && this.#core.options.renderGameCover && offers(session, COVER_TOOL.name))
      await this.#offerCover(p.project, tools);
    if (session.hostTools) offerProjectTools(p, session, tools);
    if (session.hostTools) this.#offerWorkerTools(p, engineId, session, tools);
    if (session.runControls) assertRunControlsFree(tools);
    // A director's turn is the build's line between its parts (planning), never "Connecting tools" on each wake.
    if (session.hostTools && !session.leadTurn)
      await this.#appendActivity(session, ChatActivityPhase.Connecting, engineId);
    // Awaits live under the lock — an await before it once let two briefs into one folder.
    if (grants.selfShotsDir) await ensureDir(grants.selfShotsDir);
    if (session.hostTools) await this.#offerConnectors(p, session, tools);
    if (session.hostTools) await this.#applyPlugins(session, engineId, tools);
    await this.#prepareWindowTools(p, cwd, grants, windows, tools);
    if (session.hostTools && (await this.#holdsChatScreens(p, grants, session)))
      await this.#offerChatScreens(p, target, grants, session, tools);
  }

  /**
   * Whether the session works the person's screens for its chat: the chat's own session, and a
   * Loop's lead seated in its game folder answering that chat (`#answersChat`), so the person's
   * computer and the editor's play stay with the chat while its Loop runs. Never a worker, a
   * reviewer or a lead of another chat.
   */
  async #holdsChatScreens(p: DelegateParams, grants: DelegationGrants, session: DelegationSession): Promise<boolean> {
    if (isChatsOwnSession(p)) return true;
    const threadId = p.threadId;
    if (!session.leads || typeof threadId !== "string") return false;
    return this.#answersChat(p, grants, session, threadId);
  }

  /**
   * The chat's screen tools (its own session's, or its Loop's lead's): the person's computer, behind
   * consent, and on a game played in its engine's editor (an Unreal game) the computer on that
   * editor's play.
   */
  async #offerChatScreens(
    p: DelegateParams,
    target: DelegationTarget,
    grants: DelegationGrants,
    session: DelegationSession,
    tools: SessionTools,
  ): Promise<void> {
    tools.desktop = await this.#desktopTools(p, target, session);
    if (!tools.builder && p.computer !== false) {
      const place = {
        project: p.project,
        directory: target.cwd,
        threadId: session.threadId,
        engineId: target.engineId,
      };
      tools.builder = await editorPlayTools(this.#core, this.#x, { ...place, signal: session.abort.signal });
    }
  }

  /** The person's computer for the chat's session or its Loop's lead (`desktop-session.ts`), behind their consent. */
  #desktopTools(p: DelegateParams, target: DelegationTarget, session: DelegationSession): Promise<DesktopTools | null> {
    const binding = { project: p.project, directory: target.cwd, ...(p.threadId ? { threadId: p.threadId } : {}) };
    // A Loop's lead is not the chat's turn: its card waits through the chat's turns, as its plugin calls' do.
    if (session.leads !== null) this.#x.pluginCallAttribution.set(binding, { lead: true });
    return desktopSessionTools(this.#core, this.#x, {
      binding,
      threadId: session.threadId,
      ...(session.chatTurn ? { turn: session.chatTurn } : {}),
      signal: session.abort.signal,
    });
  }

  /**
   * The connectors' tools the session is handed: every in-scope connector is asked in parallel, each
   * with its own timeout, and one that will not answer contributes nothing. A building worker, seated
   * or not, is handed the server its game's kind brings (an engine's live editor) as its lead is:
   * its brief says the editor works on the game folder, not on a copy (workers/prompts.ts).
   */
  async #offerConnectors(p: DelegateParams, session: DelegationSession, tools: SessionTools): Promise<void> {
    const report = await this.#core.mcp.toolsReport(p.project, {
      signal: session.abort.signal,
      facts: session.facts,
      ...(session.holds ? { holds: session.holds } : {}),
    });
    tools.mcp = report.tools.filter((tool) => offers(session, tool.name));
    // A connector that gave nothing is said in the log; the session sees its tools are not there.
    for (const connector of report.silent)
      this.#core.options.onLog?.(`[core] ${silentConnectorLog(connector)} in ${p.project}`, "stderr");
  }

  /**
   * Record the revision this session is handed, each handed plugin's account state read first for
   * its system text to say which are not set up yet. No notice says what changed since it last ran:
   * its tool list is what it is handed now, while a resumed Claude Code or Codex session keeps the
   * plugin guidance of the system text it started with.
   */
  async #applyPlugins(session: DelegationSession, engineId: string, tools: SessionTools) {
    tools.handed = await withAccounts(this.#core.plugins, tools.handed);
    await this.#x.recordToolRevision(session.threadId, engineId);
  }

  async #offerCover(project: string, tools: SessionTools): Promise<void> {
    const cover = (await this.#core.games.presentation(project)).cover;
    if (replaceableCover(cover)) tools.cover = [COVER_TOOL];
    if (tools.cover.length && tools.plugins.some((tool) => tool.name === COVER_TOOL.name))
      throw new Error(MESSAGE.toolCollision(COVER_TOOL.name));
  }

  /** The session's computer on its own window (a lead's too: it is the chat's own session), and a lead's run tools. */
  async #prepareWindowTools(
    p: DelegateParams,
    cwd: string,
    grants: DelegationGrants,
    windows: SessionWindows,
    tools: SessionTools,
  ): Promise<void> {
    const { selfCapture, selfShotsDir, director } = grants;
    const { self: selfWindow } = windows;
    const builderLooks = selfCapture && selfShotsDir && selfWindow && p.computer !== false;
    if (builderLooks) {
      tools.builder = await this.#core._computerToolsFor(
        { ...selfCapture, role: "builder" },
        cwd,
        selfShotsDir,
        selfWindow,
      );
    }
    if (director) tools.director = this.#directorTools(director);
  }

  /**
   * Whether the session loads the game's project settings, and a reviewer's folder: the trust is for
   * the game's folder, so a reviewer's home under scratch loads none, and its brief names what it reads.
   */
  async #settingsAndReads(
    p: DelegateParams,
    session: DelegationSession,
  ): Promise<Pick<DelegateRequest, "trustedProjectSettings" | "reviewer">> {
    if (session.reviewer && p.reviewer) return { trustedProjectSettings: false, reviewer: { reads: p.reviewer.reads } };
    return { trustedProjectSettings: (await this.#core.games.presentation(p.project)).trustProjectSettings === true };
  }

  /** The request the engine is handed. */
  async #request(
    p: DelegateParams,
    target: DelegationTarget,
    grants: DelegationGrants,
    session: DelegationSession,
    windows: SessionWindows,
    tools: SessionTools,
    reach: SessionReach,
  ): Promise<DelegateRequest> {
    const { engineId } = target;
    const { extraReads, denyReads } = reach;
    return {
      contextPolicy: (await this.#core.contextPreferences.get(engineId, p.model ?? "", p.threadId)).policy,
      ...(await this.#settingsAndReads(p, session)),
      ...this.#brief(p, session, tools, engineId),
      // Who wrote the prompt: each engine says it its own way (claude-steer.ts, genex-mark-prompts.ts).
      ...(isMessageFrom(p.from) ? { from: p.from } : {}),
      cwd: target.workCwd,
      signal: session.abort.signal,
      ...(p.model ? { model: p.model } : {}),
      ...(p.effort ? { effort: p.effort } : {}),
      ...(p.preferences ? { preferences: p.preferences } : {}),
      ...(p.maxTurns ? { maxTurns: p.maxTurns } : {}),
      // A delegation has a time limit only when its caller gives one: a chat turn, a lead and a worker have none.
      ...(p.timeoutMs !== undefined ? { timeoutMs: p.timeoutMs } : {}),
      ...(p.resume ? { resume: p.resume } : {}),
      ...(p.compact ? { compact: true } : {}),
      ...(extraReads.length ? { extraReads } : {}),
      ...(denyReads.length ? { denyReads } : {}),
      ...askFields(reach, session.tools),
      ...(p.interviewTools?.length ? { interviewTools: p.interviewTools } : {}),
      ...(Array.isArray(p.images) && p.images.length
        ? { images: p.images.filter((i) => i?.data).slice(0, MAX_BRIEF_IMAGES) }
        : {}),
      ...this.#toolFields(p, target, grants, session, windows, tools),
      ...steerField(session),
      onEvent: this.#onEvent(session),
    };
  }

  /**
   * The studio's checkpoint made real for the chat's own session in the game's folder, on a game
   * whose plugins hook checkpoints: their steps around a snapshot of the folder (`plugin-hooks.ts`
   * `takeCheckpoint`), answered as the session reads it (an Unreal game's editor is saved by the
   * Unreal plugin's own step). A game in an engine's own editor whose plugin is off still gets the
   * snapshot, with no step (the session is told to save in the editor itself). A web game no plugin
   * hooks there, a run's session and a worktree keep the note alone.
   */
  #checkpointField(
    p: DelegateParams,
    target: DelegationTarget,
    session: DelegationSession,
    seat: DelegationSeat,
  ): Pick<DelegateRequest, "onCheckpoint"> {
    const inGame = target.workCwd === path.resolve(this.#core.games.dirFor(p.project));
    if (!(inGame && isChatsOwnSession(p))) return {};
    const events = this.#core.plugins.hookEvents({ facts: seat.facts, ...(seat.holds ? { holds: seat.holds } : {}) });
    const hooked = events.includes(HookEvent.CheckpointBefore) || events.includes(HookEvent.CheckpointAfter);
    if (!hooked && !isEngineGame(seat.engine)) return {};
    const ask = { project: p.project, threadId: session.threadId, signal: session.abort.signal };
    const take = (note: string) => this.#core.hooks.takeCheckpoint({ ...ask, label: note });
    return { onCheckpoint: async (note) => checkpointWords(await take(note), CHECKPOINT_TOOL.reply) };
  }

  /**
   * Every event the session reports, mirrored into the log — except a steered message it read
   * (`steer_delivered`), which is recorded where it was read in the chat, never mirrored. A lead's
   * is recorded nowhere: the queue recorded its messages delivered when it handed them over, and
   * the lead's own loop reads what it read from the result (`steered`).
   */
  #onEvent(session: DelegationSession): NonNullable<DelegateRequest["onEvent"]> {
    return (event) => {
      if (event.type !== DelegateEventType.SteerDelivered) {
        // Read before it is mirrored: a steer waiting to cut this session hears its tools ended.
        if (session.tools) noteEvent(session.tools, event);
        return session.mirror.onEvent(event);
      }
      const { chatTurn } = session;
      const { id } = event.payload;
      const chatsOwn = chatTurn && !session.leadTurn;
      if (!chatsOwn || typeof id !== "string") return;
      recordSteerDelivered(this.#core, session.threadId, chatTurn, id);
      // A setup assist's message read by this running turn: its grant ends with this turn.
      assistGrants(this.#core).steered(session.threadId, chatTurn, id);
    };
  }

  /**
   * The prompt as the harness wrote it, never with anything glued to it. What holds for the session's
   * whole life (the harness's `system`, its plugins and their guidance) is its system text on an
   * engine that takes one (`DelegateRequest.system`), said once there, not again in every message;
   * an engine with none reads it as the first notice of a new session, its history keeping it after.
   * Genex's own lines for this message are its notices, each a block of its own the engine marks: the
   * harness's, then calls of its thread cut off before they answered, to a session that could repeat
   * them (host tools, and a turn, not a compaction), until one answers; and to the chat's own session
   * its jobs that ended since it was last told. Files a checkpoint left out for their size are the
   * chat's line to the person alone (`rewind.ts`): no session is told of them.
   */
  #brief(
    p: DelegateParams,
    session: DelegationSession,
    tools: SessionTools,
    engineId: string,
  ): Pick<DelegateRequest, "prompt" | "system" | "notices"> {
    const told = this.#notices(p, session, tools);
    const system = joinParts(this.#contextParts(p, session, tools));
    const ownSystem = SYSTEM_CONTEXT_ENGINES.has(engineId);
    const notices = ownSystem || p.resume ? told : [system, ...told].filter(Boolean);
    return {
      prompt: p.prompt,
      ...(ownSystem && system ? { system } : {}),
      ...(notices.length ? { notices } : {}),
    };
  }

  /** Genex's own lines for this message, beside the prompt: the harness's, then the host's news since the session last ran. */
  #notices(p: DelegateParams, session: DelegationSession, tools: SessionTools): string[] {
    const told = session.hostTools && !p.compact;
    tools.cutOffs = told ? peekCutOffs(this.#x.cutOffCalls, p.threadId) : [];
    return [...(p.notices ?? []), cutOffNotice(tools.cutOffs), tools.jobNews.notice].filter(Boolean);
  }

  /**
   * The session's system text: the harness's context, its plugins, their guidance and connectors, the
   * same for a chat's own session and its lead. A resumed Claude Code or Codex session keeps the text
   * it started with, so of a plugin turned on or off since, only its tool list follows.
   */
  #contextParts(p: DelegateParams, session: DelegationSession, tools: SessionTools): string[] {
    return [
      p.system ?? "",
      session.hostTools ? handedPluginsNote(tools.handed) : "",
      session.hostTools ? tools.pluginGuidance : "",
      this.#core.mcp.guidance(tools.mcp),
    ];
  }

  /**
   * The session's live tools and grants. Later fields win: the builder's computer, then the host
   * tools over it (a lead's run tools among them).
   */
  #toolFields(
    p: DelegateParams,
    target: DelegationTarget,
    grants: DelegationGrants,
    session: DelegationSession,
    windows: SessionWindows,
    tools: SessionTools,
  ): Partial<DelegateRequest> {
    const { selfCapture, selfShotsDir, director } = grants;
    const { builder } = tools;
    return {
      ...(selfCapture && selfShotsDir && windows.self
        ? {
            selfCapture,
            onCapture: this.#x.previews.captureFor(selfCapture, target.cwd, selfShotsDir, windows.self),
          }
        : {}),
      ...(builder ? { liveTools: builder.liveTools, onLiveTool: builder.onLiveTool } : {}),
      // A lead always gets host tools, which carry its run tools beside its window's.
      ...(director ? { director } : {}),
      ...readOnlyField(p, session),
      ...(session.hostTools ? this.#hostToolFields(p, target, grants, session, tools) : this.#lookFields(tools)),
    };
  }

  /**
   * Host tools: the window's own tools and a lead's run tools first, then the cover, Genex's project
   * tools, the run's controls (the chat's own session after a run it led), the plugins and the
   * connectors.
   */
  #hostToolFields(
    p: DelegateParams,
    target: DelegationTarget,
    grants: DelegationGrants,
    session: DelegationSession,
    tools: SessionTools,
  ): Partial<DelegateRequest> {
    const controls = session.runControls ? runControlTools : [];
    const desktop = tools.desktop?.liveTools ?? [];
    return {
      liveTools: [
        ...(tools.builder?.liveTools ?? []),
        ...(tools.director?.liveTools ?? []),
        ...desktop,
        ...tools.cover,
        // Genex's own project and worker tools load with the prompt: no brief line restates them.
        ...tools.project.map(withPrompt),
        ...tools.workers.map(withPrompt),
        ...tools.jobs,
        ...tools.look,
        ...controls,
        ...tools.plugins,
        ...tools.mcp,
      ],
      onLiveTool: (name: string, args: Record<string, unknown>) =>
        this.#hostTool(name, args, p, target, grants, session, tools),
    };
  }

  /**
   * A session without host tools that may still look (a reader worker): its window's tools, if
   * any, and `app_look`, each answered by its own handler; nothing for any other session.
   */
  #lookFields(tools: SessionTools): Partial<DelegateRequest> {
    const caller = tools.lookCaller;
    if (!caller || !tools.look.length) return {};
    const windowTools = tools.builder;
    return {
      liveTools: [...(windowTools?.liveTools ?? []), ...tools.look],
      onLiveTool: async (name: string, args: Record<string, unknown>) => {
        if (tools.look.some((tool) => tool.name === name)) return runAppLook(this.#core, args, caller);
        if (!windowTools) throw new Error(MESSAGE.unknownTool(name));
        return windowTools.onLiveTool(name, args);
      },
    };
  }

  async #hostTool(
    name: string,
    args: Record<string, unknown>,
    p: DelegateParams,
    target: DelegationTarget,
    grants: DelegationGrants,
    session: DelegationSession,
    tools: SessionTools,
  ): Promise<LiveToolResult> {
    const signal = session.abort.signal;
    const sessionTool = this.#sessionTool(name, args, session, tools);
    if (sessionTool) return sessionTool;
    if (tools.project.some((tool) => tool.name === name))
      return callProjectTool(this.#core, this.#x, name, args, {
        project: p.project,
        threadId: await this.#projectToolChat(p, grants, session),
        canCheck: tools.project.some((tool) => tool.name === ProjectTool.PluginCheck),
      });
    if (tools.cover.some((tool) => tool.name === name))
      return this.#x.setGameCover(p.project, args, p.threadId, signal);
    if (session.runControls && isRunControl(name))
      return this.#x.conversation.runControl(
        session.threadId,
        session.runControls.runId,
        name,
        args,
        session.runControls.messageId,
        session.abort,
      );
    // A lead's plugins act on the build it leads, never the live game folder it sits in. Its plugin
    // calls outlive the chat's turns and its own: a Loop's lead ends its turn to wait for its workers,
    // and a card it asked with (a package, a store item) stays the person's to answer. Stop ends them.
    const directory = session.leads ?? target.cwd;
    const binding = { project: p.project, directory, ...(p.threadId ? { threadId: p.threadId } : {}) };
    const lead = session.leads !== null;
    const outlivesTurn = runsOwnCall(session);
    // A connector call waits on a service, not on the person: it ends with the lead's own session.
    const connectorSignal = lead ? AbortSignal.any([signal, session.ended.signal]) : signal;
    // A worker's calls pass the locks it holds for its life (an in-place writer's); the lead's hold their own.
    // A chat turn's call stops waiting for one once the person writes: its signal taken now, as the call starts.
    const locking = { ...holderField(session), ...personWroteField(session) };
    // Connector first: its names are `<connector>__<tool>`, and the registry is the
    // only thing that can say whether one of them is really on this list. A call to one the
    // session was not handed (another game's kind, a narrowed session's) is refused before
    // anything is asked or run.
    if (this.#core.mcp.owns(name)) {
      if (!handed(session, tools, name)) throw new Error(MESSAGE.unknownTool(name));
      return this.#x.pluginTools.invokeConnectorTool(name, args, binding, connectorSignal, {
        outlivesTurn,
        ...this.#runConsentFor(name, p, session),
        ...callRunField(session),
        ...locking,
      });
    }
    if (!tools.plugins.some((tool) => tool.name === name)) {
      const owner = windowOrRunTools(tools, name);
      if (!owner) throw new Error(MESSAGE.unknownTool(name));
      return owner.onLiveTool(name, args);
    }
    const result = await this.#x.pluginTools.invokePluginTool(name, args, binding, signal, {
      engine: target.engineId,
      selfCapture: grants.selfCapture,
      director: grants.director,
      attribution: session.attribution,
      credits: session.credits,
      lead,
      outlivesTurn,
      ...locking,
    });
    return pluginAnswer(result);
  }

  /**
   * The desktop's, a worker tool's, a job tool's or `app_look`'s answer, when `name` is one this
   * session was handed; null otherwise.
   */
  #sessionTool(
    name: string,
    args: Record<string, unknown>,
    session: DelegationSession,
    tools: SessionTools,
  ): Promise<LiveToolResult> | null {
    if (tools.desktop && name === DESKTOP_TOOL_NAME) return tools.desktop.onLiveTool(name, args);
    if (tools.workers.some((tool) => tool.name === name)) return this.#forwardWorkerTool(session, name, args);
    const looker = tools.lookCaller;
    if (looker && tools.look.some((tool) => tool.name === name)) return runAppLook(this.#core, args, looker);
    const caller = tools.jobReach;
    if (!caller || !tools.jobs.some((tool) => tool.name === name)) return null;
    return callJobTool(this.#core, this.#x, name, args, caller, session.abort.signal);
  }

  /**
   * The chat a project tool's card shows in: a lead's, the one chat its run was started in, as the
   * host's records say (`#runChat`), never a thread the harness names; the chat's own session's,
   * its own. None for anyone else, so a card they could name has nowhere to show.
   */
  async #projectToolChat(
    p: DelegateParams,
    grants: DelegationGrants,
    session: DelegationSession,
  ): Promise<string | undefined> {
    const seat = projectToolSeat(p, session);
    if (seat === ProjectToolSeat.Chat) return p.threadId;
    if (seat !== ProjectToolSeat.Lead || !grants.director) return undefined;
    return (await this.#runChat(p.project, grants.director.runId)) ?? undefined;
  }

  /**
   * A Loop lead's connector call carries its run's consent, asked only once nothing else settled
   * the call, and only when the delegation names the chat the run was started in: that chat's Plan
   * mode is what refuses the call first. A worker the host seated for that run stands on the same
   * consent: it has its lead's engine connector, and no card stops it for what its lead may do.
   */
  #runConsentFor(
    name: string,
    p: DelegateParams,
    session: DelegationSession,
  ): Pick<ConnectorCallOptions, "runConsent"> {
    const runId = session.liveRun ?? session.worker?.runId ?? null;
    const threadId = p.threadId;
    return runId && threadId ? { runConsent: () => this.#runConsents(name, p.project, threadId, runId) } : {};
  }

  /**
   * The run-consent rule: a lead in place's call needs no card while its run is going (held awake
   * by the harness, and running by its records), the run is this game's and was started in the chat
   * the delegation names (`#runOfChat`), and the connector is the game's engine plugin's. That
   * chat's Plan mode refuses before this.
   */
  async #runConsents(name: string, project: string, threadId: string, runId: string): Promise<boolean> {
    if (!this.#x.activeRunIds.has(runId)) return false;
    if (!(await this.#enginePluginConnector(name, project))) return false;
    if (!(await this.#runOfChat(project, threadId, runId))) return false;
    const runs = await this.#core.activityItems();
    return runs.some((item) => item.runId === runId && item.runOutcome?.state === ExecutionStatus.Running);
  }

  /**
   * Whether a connector is the game's engine plugin's: a plugin that links games to an engine
   * (`game-engine`) and holds the game's current link, the one its studio.json mirrors. A web game
   * has none; a user's connector, another plugin's and another engine plugin's are never it.
   */
  async #enginePluginConnector(name: string, project: string): Promise<boolean> {
    const owner = this.#core.mcp.ownerOf(name.slice(0, Math.max(0, name.indexOf("__"))));
    const manifest = this.#core.plugins.list().find((p) => p.manifest.id === owner)?.manifest;
    if (!owner || !manifest?.capabilities.includes(PluginCapability.GameEngine)) return false;
    const directory = this.#core.games.dirFor(project);
    const bound = await readEngineBinding(directory, this.#core.plugins.engines()).catch(() => undefined);
    if (!bound) return false;
    const link = await this.#core.engineLinks.read(owner, { project, directory }).catch(() => null);
    return link?.project === bound.project;
  }

  /**
   * The contractor answered: close a failed reply's stream, record the plugins its session now
   * holds, and remember the chat's own session (or its lead's) for Continue.
   */
  async #settled(
    p: DelegateParams,
    engineId: string,
    session: DelegationSession,
    result: DelegateResult,
    tools: SessionTools,
  ) {
    session.mirror.flush();
    const streamId = session.mirror.streamId();
    if (!result.ok && streamId)
      this.#core.emit(UiEvent.ChatStreamEnded, { threadId: session.threadId, streamId, failed: true });
    const { threadId } = p;
    const { sessionId } = result;
    // A session that failed may never have read its notices: its cut-off calls are named again.
    if (result.ok) {
      clearCutOffs(this.#x.cutOffCalls, p.threadId, tools.cutOffs);
    }
    // Calls it made once a background task woke it past its turn's end: the CLI refused them in the
    // person's words, so the next session hears they were Genex's and are not done.
    for (const call of result.cutAfterTurn ?? [])
      noteCutOff(this.#x.cutOffCalls, p.threadId, { ...call, reason: CallCutOff.TurnEnded });
    const resumable = threadId && sessionId && (isChatsOwnSession(p) || session.chatLead);
    if (resumable) {
      await this.rememberContractor(threadId, {
        engine: engineId,
        sessionId,
        project: p.project,
        ...(p.model !== undefined ? { model: p.model } : {}),
        ...(p.effort !== undefined ? { effort: p.effort } : {}),
      });
    }
    await this.#leadTurnEnded(session, answeredPhase(result), engineId, sessionId);
  }

  /** The failure to throw: the reply's stream closed, the fallbacks attached, a lost sign-in announced. */
  async #failed(engineId: string, session: DelegationSession, err: unknown): Promise<Error> {
    session.mirror.flush();
    const streamId = session.mirror.streamId();
    if (streamId) this.#core.emit(UiEvent.ChatStreamEnded, { threadId: session.threadId, streamId, failed: true });
    await this.#leadTurnEnded(session, thrownPhase(err), engineId);
    const failure = await withFallbacks(this.#core.engines, engineId, err);
    if (session.leadTurn) this.#core.turns.noteFailure(session.threadId, failedTurn(failure));
    if (failure instanceof EngineError && failure.kind === EngineFailureKind.Auth) {
      this.#core.emit(UiEvent.EnginesChanged, { engine: engineId });
    }
    return failure;
  }
}

/** A checked game-file path: the game's folder (lexical and real) and whether the leaf is a link. */
interface CheckedGameFile {
  file: string;
  base: string;
  realBase: string;
  target: string;
  link: boolean;
  outside: () => Error;
}

/**
 * The plugins a snapshot hands a session, in its order, as its brief names them: each one's name and
 * description from the registry's list, and whether any tool of the snapshot carries its id.
 */
function handedPlugins(
  listed: readonly PluginInfo[],
  plugins: Pick<PluginSnapshot, "tools" | "applied">,
): HandedPlugin[] {
  const manifests = new Map(listed.map((info) => [info.manifest.id, info.manifest]));
  return plugins.applied.plugins.flatMap((id) => {
    const manifest = manifests.get(id);
    if (!manifest) return [];
    const tools = plugins.tools.some((tool) => tool.name.startsWith(`${id}__`));
    return [{ id, name: manifest.name, description: manifest.description, tools }];
  });
}

/**
 * Each handed plugin with its account's state, read from the registry's memory (never the secret
 * store); a plugin that declares no account is left as it was.
 */
async function withAccounts(
  registry: Pick<PluginRegistry, "accountState">,
  handed: readonly HandedPlugin[],
): Promise<HandedPlugin[]> {
  return Promise.all(
    handed.map(async (plugin) => {
      const account = await registry.accountState(plugin.id);
      return account === undefined ? plugin : { ...plugin, account };
    }),
  );
}

/** Genex's own live tool, loaded with the prompt on an engine that defers tools. */
const withPrompt = (tool: LiveToolSpec): LiveToolSpec => ({ ...tool, alwaysLoad: true });

/** A session's tools before they are prepared: the plugins of the snapshot it began with, and nothing else yet. */
function sessionTools(plugins: Pick<PluginSnapshot, "tools" | "guidance">, handed: HandedPlugin[]): SessionTools {
  return {
    cover: [],
    project: [],
    workers: [],
    jobs: [],
    jobReach: null,
    jobNews: { notice: "", told: [] },
    look: [],
    lookCaller: null,
    mcp: [],
    plugins: plugins.tools,
    pluginGuidance: plugins.guidance,
    handed,
    cutOffs: [],
    builder: null,
    director: null,
    desktop: null,
  };
}

/** The signal a chat turn's call takes as it starts: the person writing in its chat ends its wait for a lock. */
function personWroteField(session: Pick<DelegationSession, "personWrote">): { personWrote?: AbortSignal } {
  return session.personWrote ? { personWrote: session.personWrote.current.signal } : {};
}

/**
 * The holder a worker's plugin and connector calls hold their locks as (`workerHolder`): a seated
 * worker's, or an unseated in-place worker's; none for any other session.
 */
function holderField(session: Pick<DelegationSession, "worker" | "unseatedHolder">): { holder?: string } {
  const { worker, unseatedHolder } = session;
  if (worker) return { holder: workerHolder({ threadId: worker.chatThreadId, runId: worker.runId, id: worker.id }) };
  return unseatedHolder ? { holder: unseatedHolder } : {};
}

/**
 * A run's unseated worker on a key of its own (not the folder's): its entry names its run, so the
 * folder's other sessions find it (`#assertNoRunWorkerBeside`).
 */
function besideField(
  beside: UnseatedRunWorker | null,
  lock: string,
  seat: Pick<DelegationSeat, "leads">,
  target: Pick<DelegationTarget, "cwd">,
): { besideLeadOf?: string } {
  return beside && lock !== (seat.leads ?? target.cwd) ? { besideLeadOf: beside.runId } : {};
}

/**
 * The lock's entry for a session: what Stop, a steer and the worker ceiling find it by, and the
 * worker id its grant named (`askedWorker`), honoured or not.
 */
function activeDelegation(
  project: string,
  engine: string,
  session: DelegationSession,
  askedWorker: unknown,
): ActiveDelegation {
  const { worker } = session;
  return {
    project,
    threadId: session.threadId,
    engine,
    startedAt: Date.now(),
    abort: session.abort,
    settled: session.ended.signal,
    ...(session.chatTurn ? { chatTurn: session.chatTurn } : {}),
    ...(session.door ? { steer: session.door } : {}),
    ...(session.tools ? { tools: session.tools } : {}),
    ...(session.personWrote ? { personWrote: session.personWrote } : {}),
    ...(worker ? { worker: { id: worker.id, chatThreadId: worker.chatThreadId } } : {}),
    ...(session.reviewer ? { reviewer: session.reviewer } : {}),
    ...(session.liveRun ? { leadsInPlace: session.liveRun } : {}),
    ...(typeof askedWorker === "string" && askedWorker ? { askedWorker } : {}),
    ...holderField(session),
  };
}

/** Whether a session may be offered the host tool `name`: every one, unless a sub-agent's allowlist narrows it. */
/** Whether a connector tool is one the session was handed when its tools were prepared. */
function handed(session: Pick<DelegationSession, "offered">, tools: Pick<SessionTools, "mcp">, name: string): boolean {
  return offers(session, name) && tools.mcp.some((tool) => tool.name === name);
}

function offers(session: Pick<DelegationSession, "offered">, name: string): boolean {
  return session.offered === null || session.offered(name);
}

/**
 * Genex's project tools for this session (`projectTools`), by its seat (`projectToolSeat`). A plugin
 * tool of the same name would be called in their place: refused, as a cover's name is.
 */
function offerProjectTools(p: DelegateParams, session: DelegationSession, tools: SessionTools): void {
  const seat = projectToolSeat(p, session);
  // A worker's seat decides its project tools (it may look for a plugin), whatever plugin tools its
  // type narrows it to (`toolAllow`); every other seat is narrowed as its plugin tools are.
  const offered = projectTools(session, seat);
  tools.project = seat === ProjectToolSeat.Worker ? offered : offered.filter((tool) => offers(session, tool.name));
  const taken = tools.plugins.find((plugin) => tools.project.some((tool) => tool.name === plugin.name));
  if (taken) throw new Error(MESSAGE.toolCollision(taken.name));
}

/**
 * Where a session sits for Genex's project tools: a Loop's reviewer the host seated
 * (`#reviewerSeat`), a worker the host seated (`#workerSeat`), a run's lead (an honoured director
 * grant: the director, the Unreal Loop's lead, a lead that is its chat's own session), the chat's
 * own session, or none of them.
 */
function projectToolSeat(
  p: DelegateParams,
  session: Pick<DelegationSession, "leadTurn" | "worker" | "reviewer">,
): ProjectToolSeat {
  if (session.reviewer) return ProjectToolSeat.Reviewer;
  if (session.worker) return ProjectToolSeat.Worker;
  if (session.leadTurn) return ProjectToolSeat.Lead;
  return chatsOwnSession(p, session) ? ProjectToolSeat.Chat : ProjectToolSeat.None;
}

/**
 * Whose a lead's or the chat's own session's jobs are: the lead's run's, or the chat's (they outlive
 * the turn, but their records name the turn that started them).
 */
function chatOrLeadJobOwner(
  project: string,
  chatThreadId: string,
  lead: { runId: string } | null,
  chatTurn: string | undefined,
): JobOwner {
  if (lead) return { project, chatThreadId, role: JobRole.Lead, scope: { kind: JobScopeKind.Run, runId: lead.runId } };
  const turn = chatTurn ? { turn: chatTurn } : {};
  return { project, chatThreadId, role: JobRole.Chat, scope: { kind: JobScopeKind.Chat }, ...turn };
}

/** Whose a worker's jobs are: its chat's, for its run, or for the chat turn that started it; null for neither. */
function workerJobOwner(project: string, found: WorkerFinding): JobOwner | null {
  const worker = { id: found.id, title: found.title };
  const base = { project, chatThreadId: found.chatThreadId, role: JobRole.Worker, worker };
  if (found.runId) return { ...base, scope: { kind: JobScopeKind.Run, runId: found.runId } };
  return found.turn ? { ...base, scope: { kind: JobScopeKind.Turn, turn: found.turn } } : null;
}

/** The chat's own session, as its brief and its seat read: no narrower job, no lead's turn. */
function chatsOwnSession(p: DelegateParams, session: Pick<DelegationSession, "leadTurn">): boolean {
  return !unattendedBrief(p) && !session.leadTurn && isChatsOwnSession(p);
}

/** A plugin tool named like one of the run's controls would be called in its place: refused, as a cover's name is. */
function assertRunControlsFree(tools: SessionTools): void {
  const taken = tools.plugins.find((tool) => isRunControl(tool.name));
  if (taken) throw new Error(MESSAGE.toolCollision(taken.name));
}

/** Who answers a tool that is no host tool: a lead's run tools one of theirs, any other the session's window, which refuses one it lacks. */
function windowOrRunTools(tools: Pick<SessionTools, "builder" | "director">, name: string) {
  return tools.director?.liveTools.some((tool) => tool.name === name) ? tools.director : tools.builder;
}

/**
 * A lead's run tools: only the ones it was handed, each answered by the harness; any other name is
 * refused, never forwarded. A lead looks at its game with the window and tools its chat's turns have.
 */
function runToolsOnly(
  forwarded: LiveTool[],
  forward: (name: string, args: Record<string, unknown>) => Promise<LiveToolResult>,
): DirectorTools {
  const names = new Set(forwarded.map((tool) => tool.name));
  const onLiveTool: OnLiveTool = async (name, args) => {
    if (!names.has(name)) throw new Error(MESSAGE.unknownTool(name));
    return forward(name, args);
  };
  return { liveTools: forwarded, onLiveTool };
}

/**
 * Whether a session's plugin and connector calls are a run's own, its lead's or a worker's: a card
 * one asks with waits out the chat's other turns, so a lead's turn ending never withdraws a worker's
 * question.
 */
function runsOwnCall(session: Pick<DelegationSession, "leads" | "worker">): boolean {
  return session.leads !== null || Boolean(session.worker?.runId);
}

/**
 * The run a session's connector call works for (a run's worker or sub-agent, the Unreal Loop's
 * lead): the call answers to the chat that run was started in.
 */
function callRunField(
  session: Pick<DelegationSession, "attribution" | "liveRun" | "worker">,
): Pick<ConnectorCallOptions, "runId"> {
  const runId = session.attribution?.runId ?? session.worker?.runId ?? session.liveRun;
  return runId ? { runId } : {};
}

/**
 * How the session asks, if it does: the chat's own session's permissions, a lead's,
 * or a worker's seat in the chat's mode. A chat turn's call waiting for the person's answer is not
 * in flight for a cut (`noteAsking`): a message that switches the turn does not wait for the card.
 */
function askFields({ person, lead, worker }: SessionReach, tools?: ToolsInFlight): Partial<DelegateRequest> {
  if (worker) return { worker };
  if (person) return { permissions: tools ? askingNoted(person.request, tools) : person.request };
  return lead ? { leadAsks: lead.request } : {};
}

/** The chat's permissions, each question noted as asking while its card waits for the person. */
function askingNoted(permissions: DelegatePermissions, tools: ToolsInFlight): DelegatePermissions {
  return {
    ...permissions,
    ask: (request, signal) => {
      noteAsking(tools, request.toolUseId, true);
      return permissions.ask(request, signal).finally(() => noteAsking(tools, request.toolUseId, false));
    },
  };
}

/** A chat turn's session on an engine that reads messages mid-turn: its engine says once whether it takes them. */
function steerField(session: DelegationSession): Partial<DelegateRequest> {
  const { door } = session;
  if (!door) return {};
  return { steer: { ready: (send) => settleDoor(door, send) } };
}

/**
 * A read-only session's flag. A lead the host seated is never read-only, whatever its brief says
 * (a kept older seed's still says so).
 */
function readOnlyField(p: DelegateParams, session: Pick<DelegationSession, "leads">): Partial<DelegateRequest> {
  return p.readOnly && session.leads === null ? { readOnly: true } : {};
}
