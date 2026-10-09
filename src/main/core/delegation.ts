/**
 * Delegation: `engine.delegate` (a brief handed to a coding engine in one folder, under one lock),
 * the tools a session is given (computer, director, playtest), and the game-file access they share.
 * Composed by `StudioCore`; its state stays in the core.
 */
import { uuidv7 } from "../../substrate/ids.ts";
import { replaceableCover } from "../../shared/game-library.ts";
import { COVER_TOOL } from "../../shared/cover-recipe.ts";
import { callProjectTool, ProjectToolSeat, projectTools } from "./project-tools.ts";
import { ChatActivityPhase, SessionActivityRole, delegationActivityScope } from "../../shared/chat-activity.ts";
import { CustomEvent, customRecord } from "../../shared/custom-events.ts";
import { HOUR_MS, MINUTE_MS } from "../../shared/duration.ts";
import {
  DelegationRefusal,
  EngineFailureKind,
  StopReason,
  type DelegateOwnership,
} from "../../shared/engine-requests.ts";
import { type ConversationRecord, type EventEnvelope, ThreadKind } from "../../shared/event-log.ts";
import { ExecutionStatus, RUN_START_EVENTS } from "../../shared/run-state.ts";
import { UiEvent } from "../../shared/ui-events.ts";
import type { McpLiveTool } from "../../substrate/mcp/registry.ts";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { coordinatorTools, isRunControl, runControlTools } from "../../shared/coordinator.ts";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { ensureDir, realpathNearest } from "../../substrate/fsx.ts";
import { isImageFile } from "../../substrate/game-workspace.ts";
import type { HostMethod, HarnessParams, HarnessResult } from "../../shared/harness-api.ts";
import { describeUnknownImage, sniffImage } from "../../substrate/image-sniff.ts";
import { git } from "../../substrate/snapshots.ts";
import {
  DelegateEventType,
  EngineError,
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
import { appLookFor, type LookCaller, runAppLook } from "./app-look-tool.ts";
import { type JobOwner, JobRole, JobScopeKind, JobStopper } from "../../shared/jobs.ts";
import { WORKER_TOOL_ANSWER } from "./worker-tools-prompts.ts";
import { DispatchActionType, HarnessCapability, type ReferenceFrame } from "../../shared/protocol.ts";
import { COMPUTER_TOOL_NAME } from "../../substrate/computer-tool.ts";
import { WorkClass, workClassOf } from "../../substrate/budget.ts";
import type { OptimizationCandidate } from "../../shared/optimization.ts";
import type { CoreInternals, StudioCore } from "../studio-core.ts";
import { chatTurnOf, openDoor, recordSteerDelivered, settleDoor, type SteerDoor } from "./chat-steer.ts";
import type { LeadAnswers, LeadSession, PersonSession } from "./chat-permissions.ts";
import type { ActiveDelegation } from "./internals.ts";
import { PluginCapability, type PluginAppliedSet, type PluginTool } from "../../shared/plugins.ts";
import type { PluginSnapshot } from "../../substrate/plugins/registry.ts";
import { type CutOffCall, clearCutOffs, peekCutOffs } from "./cut-off-calls.ts";
import { clearUnsaved, peekUnsaved, type UnsavedFile } from "./unsaved-files.ts";
import {
  anyWithdrawn,
  cutOffNotice,
  unsavedFilesNotice,
  leadToolsNote,
  mainAgentReachNote,
  withdrawnNotice,
  withdrawnSince,
} from "./delegation-prompts.ts";
import { computerTools, type ComputerGrant, type ComputerTools } from "./computer-tools.ts";
import { delegationMirror, scopedRecord, type ActivityScope, type DelegationMirror } from "./delegation-events.ts";
import { withFallbacks } from "./engine-failure.ts";
import { withPlanApproval } from "./plan-approval.ts";
import { threadOr } from "./main-thread.ts";
import { PLAYTEST_TOOLS, runPlaytestTool, type PlaytestContext } from "./playtest-tools.ts";
import { ShotKind, iterationDir, runDir, runShotsDir, safePathSegment } from "./run-shots.ts";
import type { SessionPort } from "./session-port.ts";
import { isBelow, isInside, toPosixRelative } from "../../substrate/paths.ts";
import { errorMessage } from "../../shared/errors.ts";
import { engineOf, GameEngine } from "../../shared/game-engine.ts";
import { readEngineBinding } from "../../substrate/game-engine-binding.ts";
import { FolderHolds, kindPending, type ProjectFact } from "../../shared/project-facts.ts";
import { CapabilityAudience } from "../planning-capabilities.ts";
import type { ConnectorCallOptions } from "./plugin-tools.ts";
import { workerHolder } from "./plugin-locks.ts";
import { type ToolOffered, toolAllowRule } from "../../substrate/plugins/tool-allow.ts";
import { type RunCreditCap, runCreditCap } from "./run-credits.ts";
import { checkpointWords } from "./plugin-hooks.ts";
import { CHECKPOINT_TOOL } from "../../substrate/engines/studio-tool-prompts.ts";
import { HookEvent } from "../../shared/plugin-hooks.ts";

/**
 * Ceiling for a delegation that arrives without its own time budget. Generous — a chat build
 * has no commission and may legitimately run for hours — but a ceiling all the same: no
 * contractor keeps a workspace locked forever because nobody was watching the clock.
 */
export const DEFAULT_CHAT_DELEGATION_TIMEOUT_MS = 6 * HOUR_MS;

/** A director tool answers within this (the Codex bridge shim waits ten minutes; a wait is capped at four). */
export const DIRECTOR_TOOL_TIMEOUT_MS = 11 * MINUTE_MS;

/** Told to a session that can set the game's cover. Model-facing: it reads this as written. */
const COVER_TOOL_GUIDANCE =
  "For a new game, call set_game_cover once to pick a sidebar cover look that suits the brief. It is a small side task; never let it delay the game.";

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
  coordinatorOnCandidate: "coordinator cannot edit an optimization candidate",
  coordinatorNeedsThread: "coordinator needs a thread",
  candidateFrozen: "candidate is frozen",
  folderBusy: (where: string, minutes: number) =>
    `a contractor is already building in ${where} (started ${minutes} min ago) — wait for it to finish before sending another brief`,
  tooManyWorkers: (max: number) =>
    `this chat already runs ${max} workers, the most the person's Settings allow: wait for one to finish (${WorkerTool.Wait}) before starting another`,
  toolCollision: (name: string) => `Plugin tool collision: ${name}`,
  unknownTool: (name: string) => `Unknown tool: ${name}`,
  turnEndUnrecorded: (err: unknown) => `[core] could not record the end of the lead's turn: ${errorMessage(err)}`,
  cleanupFailed: (step: string, err: unknown) =>
    `[core] ${step} release failed after a delegation: ${errorMessage(err)}`,
} as const;

/** The director's own tool names beside the computer; the harness's run tools may not reuse them. */
const DirectorTool = {
  Look: "look",
  Capture: "capture",
  ResolveRoot: "resolve_root",
} as const;
const DIRECTOR_RESERVED_TOOLS = new Set<string>([COMPUTER_TOOL_NAME, ...Object.values(DirectorTool)]);
/** The build a director's window shows unless it points it elsewhere: its own worktree. */
const INTEGRATION_TARGET = "integration";

type DelegateParams = HarnessParams<typeof HostMethod.EngineDelegate>;
type LiveTool = NonNullable<DelegateRequest["liveTools"]>[number];
type OnLiveTool = NonNullable<DelegateRequest["onLiveTool"]>;
type SelfCaptureGrant = NonNullable<DelegateParams["selfCapture"]>;
type PlaytestGrant = NonNullable<DelegateParams["playtest"]>;
type DirectorGrant = NonNullable<DelegateParams["director"]>;
/** A run's sub-agent, as its plugin calls are recorded: its run, and its agent id as the part they land on. */
type Attribution = NonNullable<DelegateParams["attribution"]>;
/** What the harness asks for a worker; honoured only by the host's own finding (`#workerSeat`). */
type WorkerAsked = NonNullable<DelegateParams["worker"]>;
/** The most characters of a worker's title its cards and records keep. */
const WORKER_TITLE_MAX = 80;

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

const DIRECTOR_LOOK: LiveTool = {
  name: DirectorTool.Look,
  description:
    'Point your window (the computer tool and capture) at a build of this run: "integration" (your worktree, the default), a worker id (its worktree, edits included), or "live" (the game folder the user sees). Reloads the build through its served entry, replays the requested-state setup, and returns a screenshot. Everything you then click, press and capture happens in that build.',
  parameters: {
    type: "object",
    properties: { target: { type: "string", description: "integration | live | <worker id>" } },
    required: ["target"],
  },
};

interface PlaytestTools {
  liveTools: NonNullable<DelegateRequest["liveTools"]>;
  onLiveTool: OnLiveTool;
  release: () => Promise<void>;
}

interface DirectorTools {
  liveTools: NonNullable<DelegateRequest["liveTools"]>;
  onLiveTool: OnLiveTool;
  /** Capture of what its window shows; none without a window (an Unreal game's director). */
  onCapture?: NonNullable<DelegateRequest["onCapture"]>;
}

/** Where a delegation runs, with what, and under which budget class. */
interface DelegationTarget {
  engineId: string;
  delegateTo: (request: DelegateRequest) => Promise<DelegateResult>;
  workClass: WorkClass;
  candidate: OptimizationCandidate | null;
  /** Where the contractor runs: the checked real path. */
  workCwd: string;
  /** The delegation's key: the name its caller used, which engine.abort and engine.interrupt send. */
  cwd: string;
  optimization: { denyWrites: string[] } | null;
  /** The engine reads the person's messages mid-turn (`Engine.steersMidTurn`). */
  steersMidTurn: boolean;
}

/** The grants honoured for this folder, where their pictures land, and what the session may read. */
interface DelegationGrants {
  selfCapture: SelfCaptureGrant | null;
  selfShotsDir: string | null;
  playtest: PlaytestGrant | null;
  playShotsDir: string | null;
  director: DirectorGrant | null;
  directorShotsDir: string | null;
  /** The folders the host itself derived for it (its game, its frames, a director's run folders). */
  hostReads: string[];
  /** Those, and the folders the brief names. */
  extraReads: string[];
}

/**
 * What the session reads beyond its folder and what it may not, and the permissions of a session
 * the person is answering (`ChatPermissionService`): the chat's own (`person`), or a build's lead or
 * the run's coordinator the person may talk to (`lead`). Both null for unattended work.
 */
interface SessionReach {
  person: PersonSession | null;
  lead: LeadSession | null;
  /** A worker's seat in its lead's chat's mode (`#workerReach`); null for every other session. */
  worker: WorkerSeat | null;
  extraReads: string[];
  denyReads: string[];
  /**
   * It is the chat's main agent on an engine that asks about every call, reads beyond its folders
   * included (`Engine.permissionPrompts`): it reaches the whole Mac, limited only by the chat's mode,
   * and its brief says so (`mainAgentReachNote`).
   */
  reachesMac: boolean;
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
  conversational: boolean;
  activityScope: ActivityScope;
  /** A director's turn ends without a `turn_ended`, so the host records how it ended. */
  leadTurn: boolean;
  /** A lead that is its chat's own session, in the game folder: its session is the chat's bookmark. */
  chatLead: boolean;
  /**
   * A lead in its game's folder: the worktree it leads, as its seat checked it (`seat.leads`). Its
   * plugins act there (the binding's directory), as a director's in its worktree, so what they
   * deliver reaches the game when the run lands; and, the lead not being the chat's turn, another
   * turn's end leaves its consent cards and connector calls going. Null otherwise.
   */
  leads: string | null;
  abort: AbortController;
  /**
   * Aborted once the delegation returns. A lead's plugin and connector calls end with it besides
   * `abort`: no turn of the chat's ending withdraws their consent cards or calls, so the end of its
   * own session must, or a card approved later would run a tool for a session that is gone.
   */
  ended: AbortController;
  mirror: DelegationMirror;
  /** Steer: the chat turn this session answers, when it is the chat's own or a lead's (`chat-steer.ts`). */
  chatTurn?: string;
  /** Its input mid-turn, when it answers a chat turn on an engine that reads messages as it works. */
  door?: SteerDoor;
  /** The run's controls it keeps: the chat's own session after a run it led (`honouredRunControls`). */
  runControls?: RunControlGrant;
  /**
   * The run whose own consent covers its game's engine connector, asked at each call
   * (`#runConsents`): the Unreal Loop's lead's (`liveRunOf`). Null for every other session.
   */
  liveRun: string | null;
  /** What its game's folder holds (`seat.facts`): its plugin tools, skills and connectors are those that reach it. */
  facts: ProjectFact[];
  /** With no facts, what the folder holds (`seat.holds`): whether its kind is still to pick. */
  holds?: FolderHolds;
  /** A worker of a chat's lead, as the host honoured its grant (`#workerSeat`); null otherwise. */
  worker: WorkerFinding | null;
  /**
   * The holder an in-place worker's calls pass as when the host carries no seat for it (a direct
   * engine's session): the in-place hold the harness took for its life names it alike, so its own
   * calls never wait behind it (`#unseatedHolder`). Null for every other session.
   */
  unseatedHolder: string | null;
}

/** The run and message a chat's own session keeps the run's controls for. */
type RunControlGrant = NonNullable<DelegateParams["runControls"]>;

/** The session-long windows: the builder's own, and the director's. */
interface SessionWindows {
  self: SessionPort | null;
  director: SessionPort | null;
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
  applied: PluginAppliedSet;
  /** A resumed session's plugins and skills that were handed to it before and are gone now. */
  withdrawn: PluginAppliedSet | null;
  /** The thread's cut-off calls its brief names; forgotten once the session answers (`#settled`). */
  cutOffs: CutOffCall[];
  /** The thread's files too large to save that its brief names; forgotten the same way. */
  unsaved: UnsavedFile[];
  capabilityFacts: string;
  builder: ComputerTools | null;
  playtest: PlaytestTools | null;
  director: DirectorTools | null;
}

/**
 * The one condition that decides whether this session gets host tools at all. Judges and
 * critics never reach here (they `complete()`); a playtester or another read-only session, the
 * coordinator and an optimization candidate are all sessions with a narrower job than "build this
 * game", and a connector is exactly the kind of reach they should not have. A chat that may launch
 * a build is a full contractor and gets what the Auto chat gets, and so does a build's lead: the
 * `readOnly` of its brief marks its seat in the game folder (`#leadRoot`), the host's own finding
 * decides, and its plugins act on the build it leads (`DelegationSession.leads`).
 */
function hostToolsEligible(p: DelegateParams, candidate: OptimizationCandidate | null, seat: DelegationSeat): boolean {
  const readOnlyJob = p.readOnly && !seat.leads;
  const narrowerJob = readOnlyJob || p.playtest || p.coordinator || candidate;
  return !narrowerJob;
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
function thrownPhase(err: unknown): ChatActivityPhase {
  const stopped = err instanceof EngineError && err.kind === EngineFailureKind.Aborted;
  return stopped ? ChatActivityPhase.Interrupted : ChatActivityPhase.Failed;
}

/**
 * Only the chat's own contractor session is its bookmark: never a run's director, builder, scout,
 * playtester or coordinator, and never a session in a build worktree (`cwd`). Read from what the
 * caller asked for, so a grant dropped for pointing at another folder still marks a run's session.
 */
function isChatsOwnSession(p: DelegateParams): boolean {
  const asked = askedScope(p);
  const runScoped = Boolean(asked.runId || p.coordinator || p.director || p.cwd || p.worker);
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
  playtest?: PlaytestGrant | null;
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
 * A brief shaped for work nobody answers: a run's builder, a worker, a playtester, the coordinator,
 * a run's lead, an optimization candidate, improvement work, or anything with a clock or a
 * folder of its own. Read from what the caller asked for: forging the absence of these fields only
 * makes a session ask the person, in the mode the person chose.
 */
function unattendedBrief(p: DelegateParams): boolean {
  const narrower = [
    p.readOnly,
    p.ownership,
    p.candidateId,
    p.playtest,
    p.selfCapture?.runId,
    p.coordinator,
    p.director,
    p.attribution,
    p.worker,
  ];
  if (narrower.some(Boolean) || p.cwd) return true;
  return p.timeoutMs !== undefined || workClassOf(p.class) === WorkClass.Improvement;
}

/**
 * The run's controls the chat's own session keeps after a run it led (`runControls`): honoured
 * only for the chat's own session — never a run's director, builder, scout, playtester or
 * coordinator, a read-only session, or one in a build worktree. A control for a run that is not the
 * chat's latest is refused when it is called (`conversation.ts` `applyCoordinatorTool`).
 */
function honouredRunControls(p: DelegateParams): RunControlGrant | null {
  const asked = p.runControls;
  if (typeof asked?.runId !== "string" || !p.threadId) return null;
  return isChatsOwnSession(p) ? asked : null;
}

/** Where a delegation sits and how its director grant reads there (`#seatOf`). */
interface DelegationSeat {
  /**
   * A lead in its game's folder: the integration worktree of this game's run it leads, as the real
   * path that was checked (`#leadRoot`) — its grant's root, its reads and its lock. Null otherwise.
   */
  leads: string | null;
  /** It sits in its game's own folder: no build worktree, no coordinator home, no candidate. */
  gameFolder: boolean;
  /**
   * The engine its game builds in: whether a director works through a window (a web game) or in
   * the engine's own editor (`directorWindowed`).
   */
  engine: GameEngine;
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
 * The director: honoured only for the worktree the session runs in — its own
 * integration worktree, under scratch — or, for a waking run's lead, for its game's folder while
 * it leads that worktree (`#seatOf`), which the grant then names by its checked real path.
 */
function honouredDirector(p: DelegateParams, cwd: string, seat: DelegationSeat): DirectorGrant | null {
  const director = p.director;
  if (!director) return null;
  if (seat.leads) return { ...director, root: seat.leads };
  return path.resolve(director.root) === cwd ? director : null;
}

/** A director works through a browser window on a web game; on an Unreal game, in the Unreal editor. */
const directorWindowed = (engine: GameEngine): boolean => engine === GameEngine.Web;

/**
 * The run whose own consent may cover this session's calls to its game's engine connector: an
 * honoured director grant for this very game, seated in the game's own folder — the Unreal Loop's
 * lead. Never a worktree run's lead (it acts on the worktree it leads), a worker, a playtester, the
 * coordinator or the chat's own session. Whether the run still covers a call is asked at the call.
 */
function liveRunOf(p: DelegateParams, director: DirectorGrant | null, seat: DelegationSeat): string | null {
  if (!director || seat.leads || !seat.gameFolder) return null;
  return director.project === p.project ? director.runId : null;
}

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

/**
 * An honoured worker's brief, depth one: it never leads a run, keeps a run's controls, interviews,
 * coordinates, answers the chat's turn or runs workers of its own, so no grant that would let it
 * start workers survives.
 */
function workerBrief(p: DelegateParams): DelegateParams {
  const { director: _director, runControls: _controls, interviewTools: _interview, ...rest } = p;
  const { coordinator: _coordinator, chatTurn: _turn, workers: _workers, ...brief } = rest;
  return brief;
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

/**
 * Field by field, because the engine is handed only what the studio recognises. `template` and
 * `neverLock` are in this list for a reason nothing else would catch: dropping them typechecks,
 * every unit test passes, and a game the user brought silently keeps the template's locks and
 * the template's wiring rule.
 */
export function normalizeOwnership(raw: DelegateOwnership | undefined): DelegateOwnership | undefined {
  if (!raw || typeof raw.facetId !== "string") return undefined;
  const neverLock = Array.isArray(raw.neverLock) && raw.neverLock.length ? raw.neverLock.map(String) : null;
  return {
    facetId: raw.facetId,
    owns: Array.isArray(raw.owns) ? raw.owns.map(String) : [],
    ownsMain: raw.ownsMain === true,
    ...(typeof raw.main === "string" ? { main: raw.main } : {}),
    ...(typeof raw.studio === "string" ? { studio: raw.studio } : {}),
    ...(typeof raw.template === "boolean" ? { template: raw.template } : {}),
    ...(neverLock ? { neverLock } : {}),
  };
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

  constructor(core: StudioCore, x: CoreInternals) {
    this.#core = core;
    this.#x = x;
  }

  /**
   * The computer: hands and eyes on one pooled window for the whole session — the
   * builder's worktree, the playtester's build under test, the scout's live folder. Loaded
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
    return computerTools(this.#x.previews, grant, initialRoot, outDir, session);
  }

  /**
   * The director's tools: the computer on a window of its own, `look` to point that
   * window at any build of the run, capture of whatever it is looking at, and the harness's
   * run tools — plan, worker_start, wait, judge, playtest, integrate, show, note, finish — which
   * live in the harness process (it owns the loops and the merge) and are reached through a
   * dispatch that answers. Tool names come from the harness so the studio stays generic. `root` is
   * the build its window opens on: its integration worktree, wherever its session sits. A director
   * with no window (`session` null: an Unreal game's) gets the run tools alone (`runToolsOnly`).
   */
  async _directorToolsFor(
    d: NonNullable<DelegateRequest["director"]> & { tools?: DelegateRequest["liveTools"] },
    root: string,
    outDir: string,
    session: SessionPort | null,
  ): Promise<DirectorTools> {
    const forwarded = (d.tools ?? []).filter((t) => !DIRECTOR_RESERVED_TOOLS.has(t.name));
    const forward = (name: string, args: Record<string, unknown>) => this.#forwardDirectorTool(d, name, args);
    if (!session) return runToolsOnly(forwarded, forward);
    const grant = {
      project: d.project,
      root,
      runId: d.runId,
      facetId: "director",
      iteration: 0,
      setup: d.setup ?? null,
      label: "director",
    };
    const computer = await this.#core._computerToolsFor({ ...grant, role: "director" }, root, outDir, session);
    const onCapture = this.#x.previews.captureFor(grant, root, outDir, session, () => computer.root(), "director");
    const onLiveTool: OnLiveTool = async (name, args) => {
      if (name === COMPUTER_TOOL_NAME) return computer.onLiveTool(name, args);
      if (name === DirectorTool.Look) return this.#directorLook(d, computer, forward, args);
      return forward(name, args);
    };
    return { liveTools: [...computer.liveTools, DIRECTOR_LOOK, ...forwarded], onLiveTool, onCapture };
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
      const runStartedAt = found.runId ? await this.#runStartedAt(found.runId) : null;
      const jobReach = { writeRoots, neverTouch, home, gameFolder: game };
      return { folder: target.workCwd, reach: jobReach, owner, runStartedAt };
    }
    const chatThreadId = await this.#projectToolChat(p, grants, session);
    if (!chatThreadId) return null;
    const lead = seat === ProjectToolSeat.Lead ? grants.director : null;
    const own = seat === ProjectToolSeat.Chat && (await this.#openGameChat(p.project, chatThreadId));
    if (!own && !lead) return null;
    const folder = session.leads ?? target.workCwd;
    const neverTouch = await this.#neverTouch(p.project, [folder, game]);
    const writeRoots = writableRoots(await this.#writeRoots(folder, chatThreadId), neverTouch);
    const owner = chatOrLeadJobOwner(p.project, chatThreadId, lead, session.chatTurn);
    return { folder, reach: { writeRoots, neverTouch, home, gameFolder: game }, owner };
  }

  /**
   * `app_look`, look-only and so in every mode: for the chat's own session, a lead and every worker
   * the host seated (a reader too, which has no other host tool; never a playtester), on an engine
   * that carries a seat.
   * Its access line goes to the session's chat. A plugin tool of the same name is refused.
   */
  async #offerLook(
    p: DelegateParams,
    target: DelegationTarget,
    grants: DelegationGrants,
    session: DelegationSession,
    tools: SessionTools,
  ): Promise<void> {
    // A playtester plays with its own hands only.
    if (p.playtest || !this.#seatsWorkers(target.engineId)) return;
    const seat = projectToolSeat(p, session);
    const seated = session.hostTools || seat === ProjectToolSeat.Worker;
    const offered = seated ? appLookFor(seat).filter((tool) => offers(session, tool.name)) : [];
    if (!offered.length) return;
    const taken = tools.plugins.find((plugin) => offered.some((tool) => tool.name === plugin.name));
    if (session.hostTools && taken) throw new Error(MESSAGE.toolCollision(taken.name));
    const chatThreadId = session.worker?.chatThreadId ?? (await this.#projectToolChat(p, grants, session));
    tools.look = offered;
    tools.lookCaller = { project: p.project, chatThreadId: chatThreadId ?? null };
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

  /** `look`: point the director's window at a build of this run — never anywhere else — and screenshot it. */
  async #directorLook(
    d: NonNullable<DelegateRequest["director"]>,
    computer: ComputerTools,
    forward: (name: string, args: Record<string, unknown>) => Promise<LiveToolResult>,
    args: Record<string, unknown>,
  ): Promise<LiveToolResult> {
    const target = String(args.target ?? INTEGRATION_TARGET).trim() || INTEGRATION_TARGET;
    const resolved = await forward(DirectorTool.ResolveRoot, { target });
    const text = typeof resolved === "string" ? resolved : resolved.text;
    if (!path.isAbsolute(text)) return text;
    const root = path.resolve(text);
    const allowed = [
      path.resolve(this.#core.games.dirFor(d.project)),
      path.join(path.resolve(this.#core.layout.scratch), "autopilot", d.runId),
    ];
    if (!allowed.some((a) => isInside(a, root))) return `look: ${root} is not a build of this run`;
    computer.retarget(root);
    const loaded = await computer.ensureLoaded(true);
    if (loaded.problem)
      return `${loaded.problem} — the window is pointed at ${target} (${root}) but shows nothing usable`;
    const shot = await computer.onLiveTool(COMPUTER_TOOL_NAME, { action: "screenshot" });
    const prefix = `the window now shows ${target} (${root})${loaded.note ? ` — ${loaded.note}` : ""}\n`;
    return typeof shot === "string" ? prefix + shot : { ...shot, text: prefix + shot.text };
  }

  /**
   * Playtester hands: live MCP tools over a pooled preview of the
   * build under test — press keys, look, click, screenshot to a file, read the state — plus
   * the computer tool over the same window. The session is read-only; what it learns comes
   * back as its final JSON. One port for the whole session (the facet's idle lease when given,
   * otherwise a lease of its own), released by the delegation's finally.
   */
  async _playtestToolsFor(
    pt: NonNullable<DelegateRequest["playtest"]>,
    root: string,
    outDir: string,
  ): Promise<PlaytestTools> {
    const session = this.#x.previews.sessionPortFor({
      handle: pt.handle,
      label: `${pt.role ?? "playtest"}:${pt.facetId ?? pt.project}`,
    });
    const computer = await this.#core._computerToolsFor(
      { ...pt, role: pt.role ?? "playtester" },
      root,
      outDir,
      session,
    );
    const iterDir = iterationDir(outDir, pt.iteration);
    let shots = 0;
    const context: PlaytestContext = {
      frame: (port, jpeg, caption, act) => this.#x.previews.frame(port, computer.screen(), jpeg, caption, act),
      shotFile: async (camera) => {
        await ensureDir(iterDir);
        return path.join(iterDir, `p${++shots}_${safePathSegment(camera ?? "view")}.jpg`);
      },
      sleep: async (ms) => {
        await sleep(ms);
      },
    };
    const onLiveTool: OnLiveTool = async (name, args) => {
      if (name === COMPUTER_TOOL_NAME) return computer.onLiveTool(name, args);
      const { port: live, problem } = await computer.ensureLoaded();
      if (problem) return problem;
      return runPlaytestTool(name, args, live, context);
    };
    return { liveTools: [...computer.liveTools, ...PLAYTEST_TOOLS], onLiveTool, release: () => session.release() };
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
          `[core] still skipped: ${file} is ${describeUnknownImage(data)} — the judges cannot read it`,
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

  async delegate(asked: DelegateParams): Promise<HarnessResult<typeof HostMethod.EngineDelegate>> {
    const target = await this.#resolveTarget(asked);
    const { engineId, workClass, cwd } = target;
    // Read before the lock is taken: nothing may await between the free check and the lock.
    const worker = await this.#workerSeat(asked, target);
    const p = worker ? workerBrief(asked) : asked;
    const seat = await this.#seatOf(p, target);
    // A lead holds the build it leads, never its game's folder: the chat's other turns there, and
    // Make it live, go on while it thinks (one session). Its prompt leaves the game's changes to
    // its builders; the chat's mode alone decides what it may do. An in-place worker holds its own.
    const lock = worker?.inPlace ? workerLockKey(cwd, worker.id) : (seat.leads ?? cwd);
    this.#assertWorkerRoom(worker);
    this.#assertFolderFree(lock, p);
    const grants = this.#grants(p, cwd, seat);
    const releasePlugins = this.#core.plugins.lease();
    // In the same tick as the lease: the tools and the brief's guidance come from one view of the
    // plugins, however long the rest of the preparation waits.
    const plugins = this.#core.plugins.snapshot(
      { facts: seat.facts, holds: seat.holds },
      toolAllowRule(p.toolAllow) ?? undefined,
    );
    const releaseMcp = this.#core.mcp.lease(p.project);
    const session = this.#session(p, target, grants, seat, worker);
    const tools = sessionTools(plugins);
    // Take the lock before any await — an async deny-list walk used to leave a gap
    // where a second brief into the same folder could also pass the running check.
    const delegation = activeDelegation(p.project, engineId, session, asked.worker?.id);
    this.#x.activeDelegations.set(lock, delegation);
    this.#core.budget.beginWork(workClass);
    this.#core.emit(UiEvent.DelegationStarted, this.#activeIn(p.project, engineId));
    const windows = this.#sessionWindows(grants, seat.engine);
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
      if (tools.playtest) await tools.playtest.release().catch(() => {});
      if (windows.self) await windows.self.release().catch(() => {});
      if (windows.director) await windows.director.release().catch(() => {});
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
   * A game with no kind when the session started that has one now, from files the session wrote
   * itself (no `start_web_game`, no port, which announce it): the app's game list hears it, so Live
   * stops showing the first-idea state over a page that is there. Anything announced since the
   * start (`announced`, the game's `GameChanged` count then) already told it.
   */
  async #announceKindTaken(project: string, seat: DelegationSeat, announced: number): Promise<void> {
    if (!kindPending(seat) || (this.#x.gameChanges.get(project) ?? 0) !== announced) return;
    const now = await this.#core.games.kindOf(project).catch(() => null);
    if (now && !kindPending(now)) this.#core.emit(UiEvent.GameChanged, { project });
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
   * no sibling-folder deny list; nor does a build's lead or the run's coordinator, the chat's main
   * agent, whose reads beyond its folders the chat's mode decides. Another engine's chat session
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
    if (person && asksAll) {
      const hostDirs = [grants.selfShotsDir, grants.playShotsDir];
      const extraReads = await this.#x.permissions.chatReads(session.threadId, grants.extraReads, hostDirs);
      return { person, lead: null, worker: null, extraReads, denyReads: [], reachesMac: true };
    }
    const lead = person ? null : await this.#leadSession(p, target, grants, session, seat);
    if (lead) {
      // A folder it reads is one Accept edits (and Auto, inside its working folders) writes without
      // asking: the host's own folders and those the chat recorded, never a folder the brief names.
      const recorded = await this.#x.permissions.chatReads(session.threadId, p.extraReads ?? [], []);
      const extraReads = [...grants.hostReads, ...recorded];
      return { person: null, lead, worker: null, extraReads, denyReads: [], reachesMac: true };
    }
    const allowed = [...grants.extraReads, this.#core.games.dirFor(p.project)];
    return {
      person,
      lead: null,
      worker: null,
      extraReads: grants.extraReads,
      denyReads: await this.workspaceDenyReads(target.cwd, allowed),
      reachesMac: false,
    };
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
      runStartedAt: found.runId ? await this.#runStartedAt(found.runId) : null,
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
      writeRoots: writableRoots(await this.#writeRoots(target.workCwd, found.chatThreadId), neverTouch),
      neverTouch,
      research: found.research,
      ...(chat.asks ? { asks: chat.asks } : {}),
    };
    const extraReads = [...new Set([...grants.hostReads, ...recorded, ...runReads])];
    return { person: null, lead: null, worker, extraReads, denyReads: [], reachesMac: false };
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
   * What a worker's box may let it write: its own folder, the folders the person granted the chat
   * and the enabled plugins' folders for their engine programs, by their real paths. A folder that
   * does not exist yet is left out until it does; the seat then drops any that is, holds or sits in
   * a never-touch root (`writableRoots`), whatever granted it.
   */
  async #writeRoots(cwd: string, chatThreadId: string): Promise<string[]> {
    const asked = [cwd, ...this.#x.permissions.chatDirs(chatThreadId), ...this.#core.plugins.workerFolders()];
    const real = await Promise.all(asked.map((dir) => realpath(dir).catch(() => null)));
    return [...new Set(real.filter((dir): dir is string => dir !== null))];
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
   * own folder. A build's lead and the run's coordinator answer the chat too, from their own seats
   * (`#leadSession`), on an engine that asks about every call.
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
   * How a build's lead or the run's coordinator asks, or null (unattended work). Only where its engine
   * asks and the seat is the host's own finding: this game's lead of a run started in this chat,
   * answering the chat (`chatTurn` is its run), or the coordinator of such a run answering one of
   * the person's messages. The permission service then checks the thread is this game's open chat
   * (and, for the coordinator, that the message is one the person sent and still unanswered), and
   * routes every question by the chat's mode.
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
    if (!asks || typeof threadId !== "string") return null;
    const answers = await this.#answersPerson(p, grants, session, seat, threadId);
    if (!answers) return null;
    return this.#x.permissions.forLead({
      project: p.project,
      threadId,
      answers,
      engine: target.engineId,
      model: p.model ?? "",
      cwd: target.workCwd,
      // The lead builds in the worktree it leads, as its seat checked it; the coordinator has none.
      ...(seat.leads && "runId" in answers ? { leads: seat.leads } : {}),
      signal: session.abort.signal,
    });
  }

  /** Whom it answers in this chat: a lead, the messages handed to its run; the coordinator, its message. */
  async #answersPerson(
    p: DelegateParams,
    grants: DelegationGrants,
    session: DelegationSession,
    seat: DelegationSeat,
    threadId: string,
  ): Promise<LeadAnswers | null> {
    const { director } = grants;
    if (seat.leads && director) {
      const answersChat = session.chatTurn === director.runId && director.threadId === threadId;
      if (!answersChat || !(await this.#runOfChat(p.project, threadId, director.runId))) return null;
      return { runId: director.runId };
    }
    const runId = p.coordinator?.runId;
    const messageId = session.chatTurn ?? p.coordinator?.messageId;
    if (typeof runId !== "string" || typeof messageId !== "string") return null;
    return (await this.#runOfChat(p.project, threadId, runId)) ? { messageId } : null;
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
    // Coordinators and optimization workers have separate workspace authority.
    if (p.coordinator && p.candidateId) throw new Error(MESSAGE.coordinatorOnCandidate);
    if (p.coordinator && !p.threadId) throw new Error(MESSAGE.coordinatorNeedsThread);
    const candidate = p.candidateId ? await this.#core.candidates.get(p.candidateId, p.project) : null;
    if (candidate?.frozen) throw new Error(MESSAGE.candidateFrozen);
    const workCwd = await this.#workCwd(p, engineId, candidate);
    // The contractor runs in the checked real path (M1); the delegation stays keyed by the
    // name its caller used, which is the name engine.abort and engine.interrupt send.
    const cwd = !p.coordinator && !candidate && p.cwd ? path.resolve(p.cwd) : workCwd;
    const optimization = candidate ? await this.#optimizationFence(p.project, candidate) : null;
    return { engineId, delegateTo, workClass, candidate, workCwd, cwd, optimization, steersMidTurn };
  }

  async #workCwd(p: DelegateParams, engineId: string, candidate: OptimizationCandidate | null): Promise<string> {
    // The registrar has a stable, separate home. It can read the game but cannot write
    // the live folder or collide with a base builder's session/bridge/lock.
    if (p.coordinator && p.threadId) {
      const home = createHash("sha256").update(p.threadId).digest("hex").slice(0, 24);
      return path.join(this.#core.layout.scratch, "coordinators", home, engineId);
    }
    if (candidate) return candidate.root;
    return this.delegationCwd(p.project, p.cwd);
  }

  /** What an optimization candidate's worker may never write: the game, its git and the runs. */
  async #optimizationFence(project: string, candidate: OptimizationCandidate): Promise<{ denyWrites: string[] }> {
    const gameDir = this.#core.games.dirFor(project);
    return {
      denyWrites: [
        path.join(candidate.root, ".git"),
        gameDir,
        (await git(gameDir, ["rev-parse", "--absolute-git-dir"])).trim(),
        this.#core.layout.runs,
      ],
    };
  }

  /** The engine the delegation's game builds in; a game whose record can't be read is a web game. */
  async #gameEngine(project: string): Promise<GameEngine> {
    return engineOf(await readEngineBinding(this.#core.games.dirFor(project)).catch(() => undefined));
  }

  /**
   * Whether this delegation sits in its game's own folder, and whether its director grant is a
   * lead's there (one session): the lead of a waking run is its chat's own session, so it sits
   * in the game folder and reads the run's integration worktree it leads (`root`) without writing.
   */
  async #seatOf(p: DelegateParams, target: DelegationTarget): Promise<DelegationSeat> {
    const live = path.resolve(this.#core.games.dirFor(p.project));
    // The game's own folder: no build worktree, no coordinator home, no candidate.
    const gameFolder = !p.coordinator && !target.candidate && target.cwd === live;
    const leads = gameFolder ? await this.#leadRoot(p, live) : null;
    const { facts, holds } = await this.#core.games
      .kindOf(p.project)
      .catch(() => ({ facts: [], holds: FolderHolds.Unreadable }));
    return { leads, gameFolder, engine: await this.#gameEngine(p.project), facts, ...(holds ? { holds } : {}) };
  }

  /**
   * The worktree a lead in its game's folder leads, as its checked real path — or null, and the
   * grant is dropped. Honoured only for a lead that writes nothing (`readOnly`), of this game, for a
   * worktree of this game's own repository inside its run's own folder under scratch, of a run the
   * host's records say is this game's (`#runOfGame`).
   */
  async #leadRoot(p: DelegateParams, live: string): Promise<string | null> {
    const d = p.director;
    if (!d) return null;
    const asked = p.readOnly === true && d.project === p.project && path.resolve(d.root) !== live;
    if (!asked) return null;
    const runFolder = await this.#runFolder(d.runId);
    const root = await realpath(d.root).catch(() => null);
    if (!runFolder || !root || !isBelow(runFolder, root)) return null;
    if (!(await sameRepository(live, root))) return null;
    return (await this.#runOfGame(p.project, d.runId)) ? root : null;
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

  /** This game's run (`#runOfGame`), started in this chat. */
  async #runOfChat(project: string, threadId: string, runId: string): Promise<boolean> {
    const starts = await this.#runStarts(runId);
    if (!starts.some((event) => event.thread_id === threadId)) return false;
    return this.#startedInGame(project, starts);
  }

  /**
   * The run started in this chat that is going now (`#runChat`, `#runRunning`), and when it first
   * started; null when none is. What the person's "Don't wait for me" reaches while a run goes.
   */
  async runOfChatNow(threadId: string): Promise<{ runId: string; startedAt: number } | null> {
    const meta = (await this.#core.store.getRecord(threadId).catch(() => null))?.metadata;
    const project = meta?.kind === ThreadKind.Game && typeof meta.project === "string" ? meta.project : null;
    if (!project) return null;
    for (const item of await this.#core.activityItems()) {
      const going = item.project === project && item.runOutcome?.state === ExecutionStatus.Running;
      if (!going || !item.runId || (await this.#runChat(project, item.runId)) !== threadId) continue;
      return { runId: item.runId, startedAt: await this.#runStartedAt(item.runId) };
    }
    return null;
  }

  /** When a run first started, by the host's own records (ms since the epoch; 0 when it has none). */
  async #runStartedAt(runId: string): Promise<number> {
    const times = (await this.#runStarts(runId)).map((event) => Date.parse(event.created_at)).filter(Number.isFinite);
    return times.length ? Math.min(...times) : 0;
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
   * folder or a copy of the game under scratch. Never for a coordinator or a candidate.
   */
  async #workerSeat(p: DelegateParams, target: DelegationTarget): Promise<WorkerFinding | null> {
    const asked = p.worker;
    if (typeof asked?.id !== "string" || !asked.id || p.coordinator || target.candidate) return null;
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
   * Null for a coordinator, a candidate, a worker in a copy, or a session that names no worker.
   */
  #unseatedHolder(p: DelegateParams, target: DelegationTarget): string | null {
    const asked = p.worker;
    if (typeof asked?.id !== "string" || !asked.id || p.coordinator || target.candidate) return null;
    if (typeof p.threadId !== "string" || !p.threadId) return null;
    if (target.workCwd !== path.resolve(this.#core.games.dirFor(p.project))) return null;
    const runId = typeof asked.runId === "string" && asked.runId ? asked.runId : null;
    return workerHolder({ threadId: p.threadId, runId, id: asked.id });
  }

  /**
   * Whether an engine carries a worker's seat: a delegated engine (Claude Code, Codex) runs it in
   * the seat's mode, box and never-touch list. A local session's tool loop ignores a seat, so its
   * work stays unattended, with the sibling deny list.
   */
  #seatsWorkers(engineId: string): boolean {
    return this.#core.engines.get(engineId).kind === EngineKind.Delegated;
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
    throw new DelegationRefusedError(DelegationRefusal.FolderBusy, MESSAGE.folderBusy(where, minutes));
  }

  /**
   * The capture, playtest and director grants, each honoured only for the folder this delegation
   * builds in — and a lead's director grant for its game's folder (`seat`).
   */
  #grants(p: DelegateParams, cwd: string, seat: DelegationSeat): DelegationGrants {
    const runs = this.#core.layout.runs;
    // Builder eyes: honoured only for the workspace this delegation actually builds in —
    // a capture grant pointing anywhere else is dropped by construction.
    const selfCapture = p.selfCapture && path.resolve(p.selfCapture.root) === cwd ? p.selfCapture : null;
    // The playtester plays the build under test through live tools bound to a pooled
    // preview; its screenshots land beside the facet's own, readable but never writable.
    const playtest = p.playtest && path.resolve(p.playtest.root) === cwd ? p.playtest : null;
    const director = honouredDirector(p, cwd, seat);
    const selfShotsDir = selfCapture ? runShotsDir(runs, selfCapture.runId, selfCapture.facetId, ShotKind.Self) : null;
    const directorShotsDir = director ? runShotsDir(runs, director.runId, "director", ShotKind.Self) : null;
    // …under playtest/iter_NNN — the tool host adds the iteration folder itself.
    const playShotsDir = playtest ? runShotsDir(runs, playtest.runId, playtest.facetId, ShotKind.Playtest) : null;
    // The capture output rides along as a read root, so the contractor can Read its own frames.
    const hostReads = [
      ...(p.coordinator ? [this.#core.games.dirFor(p.project)] : []),
      ...(selfShotsDir ? [selfShotsDir] : []),
      ...(playShotsDir ? [playShotsDir] : []),
      ...(director ? this.#directorReads(p.project, director, seat) : []),
    ];
    const extraReads = [...(p.extraReads ?? []), ...hostReads];
    return { selfCapture, selfShotsDir, playtest, playShotsDir, director, directorShotsDir, hostReads, extraReads };
  }

  /**
   * What a director may read: its run's artifacts, its game's folder, and under scratch its run's
   * whole folder — or, for a lead, only the worktree it leads, by the real path its seat checked.
   */
  #directorReads(project: string, director: DirectorGrant, seat: DelegationSeat): string[] {
    const runFolder = path.join(this.#core.layout.scratch, "autopilot", director.runId);
    return [runDir(this.#core.layout.runs, director.runId), seat.leads ?? runFolder, this.#core.games.dirFor(project)];
  }

  #session(
    p: DelegateParams,
    target: DelegationTarget,
    grants: DelegationGrants,
    seat: DelegationSeat,
    worker: WorkerFinding | null,
  ): DelegationSession {
    const threadId = threadOr(this.#core, p.threadId);
    const { selfCapture, playtest, director } = grants;
    const activityScope = {
      delegationId: uuidv7(),
      ...askedScope(p, { director, selfCapture, playtest }),
    };
    const chatTurn = chatTurnOf(p, { director, playtest, candidate: target.candidate });
    const runControls = honouredRunControls(p);
    // A run's worker's plugin calls are its run's: recorded on its own node, answering to its chat.
    // A builder with a round of its own (its capture grant) keeps it: its calls stay on that round.
    const attribution = attributionOf(p) ?? (selfCapture ? null : workerAttribution(worker));
    return {
      ...(chatTurn ? { chatTurn } : {}),
      ...(runControls ? { runControls } : {}),
      liveRun: liveRunOf(p, director, seat),
      ...(chatTurn && target.steersMidTurn ? { door: openDoor() } : {}),
      threadId,
      hostTools: hostToolsEligible(p, target.candidate, seat),
      offered: toolAllowRule(p.toolAllow),
      attribution,
      credits: runCreditCap(p.creditCap, attribution?.runId ?? worker?.runId ?? director?.runId),
      worker,
      unseatedHolder: worker ? null : this.#unseatedHolder(p, target),
      // The chat's coordinator speaks for this game in its chat without the builders' tools: it
      // reads what the builders have, never instructions for tools it cannot call (which read
      // as "Genex is unavailable" to the user).
      conversational: Boolean(p.coordinator),
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

  #sessionWindows(grants: DelegationGrants, engine: GameEngine): SessionWindows {
    const { selfCapture } = grants;
    // An Unreal game's director has no window: it works in the Unreal editor.
    const director = directorWindowed(engine) ? grants.director : null;
    return {
      // The builder's window for the whole session: capture reloads it, the computer tool
      // keeps playing in it, the agent-screen card in the UI watches it.
      self: selfCapture
        ? this.#x.previews.sessionPortFor({
            handle: selfCapture.handle,
            label: `build:${selfCapture.facetId ?? selfCapture.project}`,
          })
        : null,
      // The pool label keeps the run id — that is what the window strip shows, and two
      // concurrent runs have to stay apart there.
      director: director ? this.#x.previews.sessionPortFor({ label: `director:${director.runId}` }) : null,
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
    if (p.coordinator) await ensureDir(cwd);
    if (session.conversational) {
      const facts = await this.#x
        .capabilityFacts(session.threadId, p.project, CapabilityAudience.Conversation)
        .catch(() => null);
      tools.capabilityFacts = facts?.text ?? "";
    }
    // Awaits live under the lock — an await before it once let two briefs into one folder.
    if (grants.selfShotsDir) await ensureDir(grants.selfShotsDir);
    if (session.hostTools) await this.#offerConnectors(p, session, tools);
    if (session.hostTools) await this.#applyPlugins(p, session, engineId, tools);
    await this.#prepareWindowTools(p, cwd, grants, windows, tools);
  }

  /**
   * The connectors' tools the session is handed: every in-scope connector is asked in parallel, each
   * with its own timeout, and one that will not answer contributes nothing. A worker, seated or not,
   * is never handed the server its game's kind brings (an engine's live editor): the run's lead
   * drives that editor alone, and a copy worker's edits there would land in the game.
   */
  async #offerConnectors(p: DelegateParams, session: DelegationSession, tools: SessionTools): Promise<void> {
    const asWorker = Boolean(session.worker) || typeof p.worker?.id === "string";
    const connectors = await this.#core.mcp.toolsFor(p.project, {
      signal: session.abort.signal,
      facts: session.facts,
      ...(session.holds ? { holds: session.holds } : {}),
      ...(asWorker ? { kindServers: false } : {}),
    });
    tools.mcp = connectors.filter((tool) => offers(session, tool.name));
  }

  /**
   * Record the revision this session is handed. A resumed session first learns what it was handed
   * before and is not now: its transcript still holds those plugins' instructions. The set itself
   * is recorded only once the session answers (`#settled`), so a brief that never reached it is
   * told again next time.
   */
  async #applyPlugins(p: DelegateParams, session: DelegationSession, engineId: string, tools: SessionTools) {
    if (p.resume) {
      const before = await this.#x.lastAppliedTools(session.threadId, engineId, p.resume);
      const withdrawn = withdrawnSince(before, tools.applied);
      tools.withdrawn = anyWithdrawn(withdrawn) ? withdrawn : null;
    }
    await this.#x.recordToolRevision(session.threadId, engineId);
  }

  async #offerCover(project: string, tools: SessionTools): Promise<void> {
    const cover = (await this.#core.games.presentation(project)).cover;
    if (replaceableCover(cover)) tools.cover = [COVER_TOOL];
    if (tools.cover.length && tools.plugins.some((tool) => tool.name === COVER_TOOL.name))
      throw new Error(MESSAGE.toolCollision(COVER_TOOL.name));
  }

  /** The builder's computer, the playtester's hands and the director's tools, each on its own window. */
  async #prepareWindowTools(
    p: DelegateParams,
    cwd: string,
    grants: DelegationGrants,
    windows: SessionWindows,
    tools: SessionTools,
  ): Promise<void> {
    const { selfCapture, selfShotsDir, playtest, playShotsDir, director, directorShotsDir } = grants;
    const { self: selfWindow, director: directorWindow } = windows;
    const builderLooks = selfCapture && selfShotsDir && selfWindow && p.computer !== false;
    if (builderLooks) {
      tools.builder = await this.#core._computerToolsFor(
        { ...selfCapture, role: "builder" },
        cwd,
        selfShotsDir,
        selfWindow,
      );
    }
    if (playtest && playShotsDir) {
      await ensureDir(playShotsDir);
      tools.playtest = await this.#core._playtestToolsFor(playtest, cwd, playShotsDir);
    }
    if (director && directorShotsDir) {
      if (directorWindow) await ensureDir(directorShotsDir);
      // Its window, its capture and its computer are on the build it leads, wherever it sits — a
      // lead's by the real path its seat checked (`honouredDirector`), never the name it was sent.
      const root = path.resolve(director.root);
      tools.director = await this.#core._directorToolsFor(director, root, directorShotsDir, directorWindow);
    }
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
    const { engineId, workCwd, optimization } = target;
    const { extraReads, denyReads } = reach;
    const ownership = normalizeOwnership(p.ownership);
    return {
      contextPolicy: (await this.#core.contextPreferences.get(engineId, p.model ?? "", p.threadId)).policy,
      trustedProjectSettings: (await this.#core.games.presentation(p.project)).trustProjectSettings === true,
      ...(optimization ? { optimization } : {}),
      prompt: this.#prompt(p, session, tools, reach),
      cwd: workCwd,
      signal: session.abort.signal,
      ...(p.model ? { model: p.model } : {}),
      ...(p.effort ? { effort: p.effort } : {}),
      ...(p.preferences ? { preferences: p.preferences } : {}),
      ...(p.maxTurns ? { maxTurns: p.maxTurns } : {}),
      // Every delegation carries a wall-clock ceiling: a caller's own budget, or the
      // chat default when none was given.
      timeoutMs: p.timeoutMs ?? DEFAULT_CHAT_DELEGATION_TIMEOUT_MS,
      ...(p.resume ? { resume: p.resume } : {}),
      ...(p.compact ? { compact: true } : {}),
      ...(extraReads.length ? { extraReads } : {}),
      ...(denyReads.length ? { denyReads } : {}),
      ...askFields(reach),
      ...(p.interviewTools?.length ? { interviewTools: p.interviewTools } : {}),
      ...this.#coordinatorFields(p),
      ...(Array.isArray(p.images) && p.images.length
        ? { images: p.images.filter((i) => i?.data).slice(0, MAX_BRIEF_IMAGES) }
        : {}),
      ...(ownership ? { ownership } : {}),
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
    if (!hooked && seat.engine === GameEngine.Web) return {};
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
      if (event.type !== DelegateEventType.SteerDelivered) return session.mirror.onEvent(event);
      const { chatTurn } = session;
      const { id } = event.payload;
      const chatsOwn = chatTurn && !session.leadTurn;
      if (chatsOwn && typeof id === "string") recordSteerDelivered(this.#core, session.threadId, chatTurn, id);
    };
  }

  /**
   * The brief, with guidance only where there is something to say: an unattended session with no
   * plugins and no connectors reads exactly the prompt it was given. A session the person answers
   * on an engine that asks about every call (`reach.reachesMac`) is told it reaches their whole Mac,
   * whatever the brief says. Calls of its thread cut off before they answered are named first, to a
   * session that could repeat them (host tools, and a turn, not a compaction, which reads no brief),
   * until one answers; then, to the same sessions, files Rewind cannot bring back; then, to the chat's
   * own session, its jobs that ended since it was last told and those still running.
   */
  #prompt(p: DelegateParams, session: DelegationSession, tools: SessionTools, reach: SessionReach): string {
    const told = session.hostTools && !p.compact;
    tools.cutOffs = told ? peekCutOffs(this.#x.cutOffCalls, p.threadId) : [];
    tools.unsaved = told ? peekUnsaved(this.#x.unsavedFiles, p.threadId) : [];
    return [
      cutOffNotice(tools.cutOffs),
      unsavedFilesNotice(tools.unsaved),
      tools.jobNews.notice,
      tools.withdrawn ? withdrawnNotice(tools.withdrawn) : "",
      p.prompt,
      reach.reachesMac ? mainAgentReachNote() : "",
      session.hostTools ? tools.pluginGuidance : tools.capabilityFacts,
      session.hostTools && session.leads && tools.plugins.length ? leadToolsNote() : "",
      this.#core.mcp.guidance(tools.mcp),
      tools.cover.length ? COVER_TOOL_GUIDANCE : "",
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  /** The chat's coordinator: read-only, with the coordinator's own tools. */
  #coordinatorFields(p: DelegateParams): Partial<DelegateRequest> {
    const coordinator = p.coordinator;
    const threadId = p.threadId;
    if (!coordinator || !threadId) return {};
    return {
      coordinator: true,
      readOnly: true,
      liveTools: [...coordinatorTools],
      onLiveTool: (name: string, args: Record<string, unknown>) =>
        this.#x.conversation.coordinatorTool(threadId, coordinator.runId, name, args, coordinator.messageId),
    };
  }

  /**
   * The session's live tools and grants. Later fields win: the builder's computer, then the
   * director's tools, then the playtester's, then the host tools over all of them.
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
    const { builder, director: directorTools } = tools;
    return {
      ...(selfCapture && selfShotsDir && windows.self
        ? {
            selfCapture,
            onCapture: this.#x.previews.captureFor(selfCapture, target.cwd, selfShotsDir, windows.self),
          }
        : {}),
      ...(builder ? { liveTools: builder.liveTools, onLiveTool: builder.onLiveTool } : {}),
      ...(directorTools && director
        ? {
            director,
            liveTools: directorTools.liveTools,
            onLiveTool: directorTools.onLiveTool,
            ...(directorTools.onCapture ? { onCapture: directorTools.onCapture } : {}),
          }
        : {}),
      ...playtestFields(p, grants, tools),
      ...(session.hostTools ? this.#hostToolFields(p, target, grants, session, tools) : this.#lookFields(tools)),
    };
  }

  /**
   * Host tools: the window's own tools first, then the cover, Genex's project tools, the run's
   * controls (the chat's own session after a run it led), the plugins and the connectors.
   */
  #hostToolFields(
    p: DelegateParams,
    target: DelegationTarget,
    grants: DelegationGrants,
    session: DelegationSession,
    tools: SessionTools,
  ): Partial<DelegateRequest> {
    const windowTools = tools.director ?? tools.builder;
    const controls = session.runControls ? runControlTools : [];
    return {
      liveTools: [
        ...(windowTools?.liveTools ?? []),
        ...tools.cover,
        ...tools.project,
        ...tools.workers,
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
    const windowTools = tools.director ?? tools.builder;
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
      });
    if (tools.cover.some((tool) => tool.name === name))
      return this.#x.setGameCover(p.project, args, p.threadId, signal);
    if (session.runControls && isRunControl(name))
      return this.#x.conversation.runControl(session.threadId, session.runControls, name, args, session.abort);
    // A lead's plugins act on the build it leads, never the live game folder it sits in, and its
    // calls outlive the chat's turns, ending with its own session instead.
    const directory = session.leads ?? target.cwd;
    const binding = { project: p.project, directory, ...(p.threadId ? { threadId: p.threadId } : {}) };
    const lead = session.leads !== null;
    const callSignal = lead ? AbortSignal.any([signal, session.ended.signal]) : signal;
    // A worker's calls pass the locks it holds for its life (an in-place writer's); the lead's hold their own.
    const holder = holderField(session);
    // Connector first: its names are `<connector>__<tool>`, and the registry is the
    // only thing that can say whether one of them is really on this list. A call to one the
    // session was not handed (another game's kind, a narrowed session's) is refused before
    // anything is asked or run.
    if (this.#core.mcp.owns(name)) {
      if (!handed(session, tools, name)) throw new Error(MESSAGE.unknownTool(name));
      return this.#x.pluginTools.invokeConnectorTool(name, args, binding, callSignal, {
        outlivesTurn: lead,
        ...this.#runConsentFor(name, p, session),
        ...callRunField(session),
        ...holder,
      });
    }
    if (!tools.plugins.some((tool) => tool.name === name)) {
      const handler = tools.director?.onLiveTool ?? tools.builder?.onLiveTool;
      if (!handler) throw new Error(MESSAGE.unknownTool(name));
      return handler(name, args);
    }
    const result = await this.#x.pluginTools.invokePluginTool(name, args, binding, callSignal, {
      engine: target.engineId,
      selfCapture: grants.selfCapture,
      director: grants.director,
      attribution: session.attribution,
      credits: session.credits,
      lead,
      ...holder,
    });
    return pluginAnswer(result);
  }

  /** A worker tool's, a job tool's or `app_look`'s answer, when `name` is one this session was handed; null otherwise. */
  #sessionTool(
    name: string,
    args: Record<string, unknown>,
    session: DelegationSession,
    tools: SessionTools,
  ): Promise<LiveToolResult> | null {
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
   * The Unreal lead's connector call carries its run's consent, asked only once nothing else settled
   * the call, and only when the delegation names the chat the run was started in: that chat's Plan
   * mode is what refuses the call first.
   */
  #runConsentFor(
    name: string,
    p: DelegateParams,
    session: DelegationSession,
  ): Pick<ConnectorCallOptions, "runConsent"> {
    const runId = session.liveRun;
    const threadId = p.threadId;
    return runId && threadId ? { runConsent: () => this.#runConsents(name, p.project, threadId, runId) } : {};
  }

  /**
   * The run-consent rule: the Unreal lead's call needs no card while its run is going (held awake
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
    const bound = await readEngineBinding(directory).catch(() => undefined);
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
    if (session.hostTools && sessionId)
      await this.#x.recordDeliveredTools(session.threadId, engineId, sessionId, tools.applied);
    // A session that failed may never have read its brief: its cut-off calls are named again.
    if (result.ok) {
      clearCutOffs(this.#x.cutOffCalls, p.threadId, tools.cutOffs);
      clearUnsaved(this.#x.unsavedFiles, p.threadId, tools.unsaved);
    }
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

/** A session's tools before they are prepared: the plugins of the snapshot it began with, and nothing else yet. */
function sessionTools(plugins: Pick<PluginSnapshot, "tools" | "guidance" | "applied">): SessionTools {
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
    applied: plugins.applied,
    withdrawn: null,
    cutOffs: [],
    unsaved: [],
    capabilityFacts: "",
    builder: null,
    playtest: null,
    director: null,
  };
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
    ...(session.chatTurn ? { chatTurn: session.chatTurn } : {}),
    ...(session.door ? { steer: session.door } : {}),
    ...(worker ? { worker: { id: worker.id, chatThreadId: worker.chatThreadId } } : {}),
    ...(typeof askedWorker === "string" && askedWorker ? { askedWorker } : {}),
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
 * Where a session sits for Genex's project tools: a worker the host seated (`#workerSeat`), a run's
 * lead (an honoured director grant: the director, the Unreal Loop's lead, a lead that is its chat's
 * own session), the chat's own session, or none of them.
 */
function projectToolSeat(p: DelegateParams, session: Pick<DelegationSession, "leadTurn" | "worker">): ProjectToolSeat {
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

/**
 * A director without a window — an Unreal game's, the Unreal Loop's lead, which works in the
 * visible Unreal editor through its game's engine connector: only the run tools it was handed, each
 * answered by the harness. No computer, `look` or capture; any other name is refused, never forwarded.
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
 * How the session asks, if it does: the chat's own session's permissions, a lead's or coordinator's,
 * or a worker's seat in the chat's mode.
 */
function askFields({ person, lead, worker }: SessionReach): Partial<DelegateRequest> {
  if (worker) return { worker };
  if (person) return { permissions: person.request };
  return lead ? { leadAsks: lead.request } : {};
}

/** A chat turn's session on an engine that reads messages mid-turn: its engine says once whether it takes them. */
function steerField(session: DelegationSession): Partial<DelegateRequest> {
  const { door } = session;
  if (!door) return {};
  return { steer: { ready: (send) => settleDoor(door, send) } };
}

/** The playtester's grant and hands, read-only; otherwise only a read-only session's flag. */
function playtestFields(p: DelegateParams, grants: DelegationGrants, tools: SessionTools): Partial<DelegateRequest> {
  const { playtest } = grants;
  if (tools.playtest && playtest) {
    return {
      playtest,
      liveTools: tools.playtest.liveTools,
      onLiveTool: tools.playtest.onLiveTool,
      readOnly: true,
    };
  }
  if (p.readOnly) return { readOnly: true };
  return {};
}
