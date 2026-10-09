/**
 * Delegation: `engine.delegate` (a brief handed to a coding engine in one folder, under one lock),
 * the tools a session is given (computer, director, playtest), and the game-file access they share.
 * Composed by `StudioCore`; its state stays in the core.
 */
import { uuidv7 } from "../../substrate/ids.ts";
import { replaceableCover } from "../../shared/game-library.ts";
import { COVER_TOOL } from "../../shared/cover-recipe.ts";
import { ChatActivityPhase, SessionActivityRole, delegationActivityScope } from "../../shared/chat-activity.ts";
import { CustomEvent, customRecord } from "../../shared/custom-events.ts";
import { HOUR_MS, MINUTE_MS } from "../../shared/duration.ts";
import type { ComputerTraceSummary } from "../../shared/computer-target.ts";
import {
  DelegationRefusal,
  EngineFailureKind,
  StopReason,
  type DelegateOwnership,
} from "../../shared/engine-requests.ts";
import type { ConversationRecord, EventEnvelope } from "../../shared/event-log.ts";
import { RUN_START_EVENTS } from "../../shared/run-state.ts";
import { UiEvent } from "../../shared/ui-events.ts";
import type { McpLiveTool } from "../../substrate/mcp/registry.ts";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { coordinatorTools, isRunControl, runControlTools } from "../../shared/coordinator.ts";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { ensureDir, realpathNearest } from "../../substrate/fsx.ts";
import { isImageFile, readProjectShape } from "../../substrate/game-workspace.ts";
import { TargetRuntime } from "../../shared/computer-target.ts";
import type { HostMethod, HarnessParams, HarnessResult } from "../../shared/harness-api.ts";
import { describeUnknownImage, sniffImage } from "../../substrate/image-sniff.ts";
import { git } from "../../substrate/snapshots.ts";
import {
  DelegateEventType,
  EngineError,
  type DelegateRequest,
  type DelegateResult,
  type LiveToolResult,
} from "../../substrate/engines/types.ts";
import { DispatchActionType, HarnessCapability, type ReferenceFrame } from "../../shared/protocol.ts";
import { COMPUTER_TOOL_NAME } from "../../substrate/computer-tool.ts";
import { WorkClass, workClassOf } from "../../substrate/budget.ts";
import type { OptimizationCandidate } from "../../shared/optimization.ts";
import type { CoreInternals, StudioCore } from "../studio-core.ts";
import { chatTurnOf, openDoor, recordSteerDelivered, settleDoor, type SteerDoor } from "./chat-steer.ts";
import type { LeadAnswers, LeadSession, PersonSession } from "./chat-permissions.ts";
import type { ActiveDelegation } from "./internals.ts";
import type { PluginAppliedSet, PluginTool } from "../../shared/plugins.ts";
import {
  anyWithdrawn,
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
import { CapabilityAudience } from "../planning-capabilities.ts";

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
  noPlaytestWindow: (tool: string) =>
    `${tool} drives the studio's browser window, and this game runs as its own process — use the computer tool instead`,
  directEngine: (engineId: string) => `${engineId} is a direct engine; use engine.complete`,
  cannotCompact: (engineId: string) => `${engineId} has no compaction of its own, or no session was named to compact`,
  coordinatorOnCandidate: "coordinator cannot edit an optimization candidate",
  coordinatorNeedsThread: "coordinator needs a thread",
  candidateFrozen: "candidate is frozen",
  folderBusy: (where: string, minutes: number) =>
    `a contractor is already building in ${where} (started ${minutes} min ago) — wait for it to finish before sending another brief`,
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

/** A playtest's or judge's result, with what its computer's trace adds up to. */
function withPlayTrace(result: DelegateResult, tools: SessionTools): DelegateResult {
  return tools.playtest ? { ...result, trace: tools.playtest.trace() } : result;
}

/** The scratch folder a blind judge starts in: empty, shared, and never a build. */
const BLIND_JUDGE_FOLDER = "blind-judge";

interface PlaytestTools {
  liveTools: NonNullable<DelegateRequest["liveTools"]>;
  onLiveTool: OnLiveTool;
  release: () => Promise<void>;
  /** What the session's computer trace adds up to: where it was written, whether the goal was verified. */
  trace: () => ComputerTraceSummary;
}

interface DirectorTools {
  liveTools: NonNullable<DelegateRequest["liveTools"]>;
  onLiveTool: OnLiveTool;
  onCapture: NonNullable<DelegateRequest["onCapture"]>;
  /** Stop what the director's computer started (a Play Protocol game); its window is released apart. */
  release: () => Promise<void>;
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
  mcp: McpLiveTool[];
  /** The plugin tools, their guidance and the set behind them: one registry snapshot, taken as the session began. */
  plugins: PluginTool[];
  pluginGuidance: string;
  applied: PluginAppliedSet;
  /** A resumed session's plugins and skills that were handed to it before and are gone now. */
  withdrawn: PluginAppliedSet | null;
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
  const asked = delegationActivityScope(p);
  const runScoped = Boolean(asked.runId || p.coordinator || p.director || p.cwd);
  return asked.role === SessionActivityRole.Planner && !runScoped;
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
    // A build whose studio.json declares the bridge runtime is played as its own process, started
    // in the studio's sandbox; every other build in the session's browser window, as before.
    const shape = await readProjectShape(initialRoot).catch(() => null);
    const bridge = shape?.runtime === TargetRuntime.Bridge ? { sandbox: this.#core.sandbox } : undefined;
    return computerTools(this.#x.previews, grant, initialRoot, outDir, session, { bridge });
  }

  /**
   * The director's tools: the computer on a window of its own, `look` to point that
   * window at any build of the run, capture of whatever it is looking at, and the harness's
   * run tools — plan, worker_start, wait, judge, playtest, integrate, show, note, finish — which
   * live in the harness process (it owns the loops and the merge) and are reached through a
   * dispatch that answers. Tool names come from the harness so the studio stays generic. `root` is
   * the build its window opens on: its integration worktree, wherever its session sits.
   */
  async _directorToolsFor(
    d: NonNullable<DelegateRequest["director"]> & { tools?: DelegateRequest["liveTools"] },
    root: string,
    outDir: string,
    session: SessionPort,
  ): Promise<DirectorTools> {
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
    const forwarded = (d.tools ?? []).filter((t) => !DIRECTOR_RESERVED_TOOLS.has(t.name));
    const forward = (name: string, args: Record<string, unknown>) => this.#forwardDirectorTool(d.runId, name, args);
    const onLiveTool: OnLiveTool = async (name, args) => {
      if (name === COMPUTER_TOOL_NAME) return computer.onLiveTool(name, args);
      if (name === DirectorTool.Look) return this.#directorLook(d, computer, forward, args);
      return forward(name, args);
    };
    return {
      liveTools: [...computer.liveTools, DIRECTOR_LOOK, ...forwarded],
      onLiveTool,
      onCapture,
      release: () => computer.release(),
    };
  }

  /** A run tool, answered by the harness process that owns the loops and the merge. */
  async #forwardDirectorTool(runId: string, name: string, args: Record<string, unknown>): Promise<LiveToolResult> {
    if (!this.#core.host.hasCapability(HarnessCapability.Director))
      return `the studio's loop code predates the director — ${name} is unavailable until the harness is upgraded`;
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
    const trace = () => computer.trace();
    const release = async () => {
      await computer.release().catch(() => {});
      await session.release();
    };
    // A judge plays with the computer alone: the shorthands are a playtester's, and their files
    // land outside the trace a judge's evidence is read from.
    if (pt.role === "judge") {
      return { liveTools: computer.liveTools, onLiveTool: computer.onLiveTool, release, trace };
    }
    // The shorthands drive the browser window; a Play Protocol game has none, so they are not
    // offered there, and a call by name anyway is answered with the tool that does work.
    const browserWindow = computer.runtime === TargetRuntime.Browser;
    const onLiveTool: OnLiveTool = async (name, args) => {
      if (name === COMPUTER_TOOL_NAME) return computer.onLiveTool(name, args);
      if (!browserWindow) return MESSAGE.noPlaytestWindow(name);
      const { port: live, problem } = await computer.ensureLoaded();
      if (problem) return problem;
      if (!live) return MESSAGE.noPlaytestWindow(name);
      return runPlaytestTool(name, args, live, context);
    };
    return {
      liveTools: [...computer.liveTools, ...(browserWindow ? PLAYTEST_TOOLS : [])],
      onLiveTool,
      release,
      trace,
    };
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

  async delegate(p: DelegateParams): Promise<HarnessResult<typeof HostMethod.EngineDelegate>> {
    const target = await this.#resolveTarget(p);
    const { engineId, workClass, cwd } = target;
    // Read before the lock is taken: nothing may await between the free check and the lock.
    const seat = await this.#seatOf(p, target);
    // A lead holds the build it leads, never its game's folder: the chat's other turns there, and
    // Make it live, go on while it thinks (one session). Its prompt leaves the game's changes to
    // its builders; the chat's mode alone decides what it may do.
    const lock = seat.leads ?? cwd;
    this.#assertFolderFree(lock, p);
    const grants = this.#grants(p, cwd, seat);
    const releasePlugins = this.#core.plugins.lease();
    // In the same tick as the lease: the tools and the brief's guidance come from one view of the
    // plugins, however long the rest of the preparation waits.
    const plugins = this.#core.plugins.snapshot();
    const releaseMcp = this.#core.mcp.lease(p.project);
    const session = this.#session(p, target, grants, seat);
    const tools: SessionTools = {
      cover: [],
      mcp: [],
      plugins: plugins.tools,
      pluginGuidance: plugins.guidance,
      applied: plugins.applied,
      withdrawn: null,
      capabilityFacts: "",
      builder: null,
      playtest: null,
      director: null,
    };
    // Take the lock before any await — an async deny-list walk used to leave a gap
    // where a second brief into the same folder could also pass the running check.
    const delegation: ActiveDelegation = {
      project: p.project,
      threadId: session.threadId,
      engine: engineId,
      startedAt: Date.now(),
      abort: session.abort,
      ...(session.chatTurn ? { chatTurn: session.chatTurn } : {}),
      ...(session.door ? { steer: session.door } : {}),
    };
    this.#x.activeDelegations.set(lock, delegation);
    this.#core.budget.beginWork(workClass);
    this.#core.emit(UiEvent.DelegationStarted, this.#activeIn(p.project, engineId));
    const windows = this.#sessionWindows(grants);
    /** The session that asks, whose end the picker must hear of: the chat's own, or a lead's. */
    let asking: PersonSession | LeadSession | null = null;
    try {
      session.mirror.afterEventId = await this.#core.store.head(session.threadId);
      await this.#prepareTools(p, target, grants, session, windows, tools);
      const reach = await this.#reach(p, target, grants, session, seat);
      asking = reach.person ?? reach.lead;
      // Stop can arrive while tools are being prepared under the workspace lock.
      if (session.abort.signal.aborted)
        throw new EngineError(EngineFailureKind.Aborted, engineId, "stopped before the contractor started");
      const registered = this.#x.activeDelegations.get(lock);
      if (registered && registered.abort === session.abort) registered.started = true;
      await this.#appendActivity(session, ChatActivityPhase.Thinking, engineId, { sessionId: p.resume ?? null });
      const request = await this.#request(p, target, grants, session, windows, tools, reach);
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
      return withPlayTrace(result, tools);
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
      if (tools.builder) await tools.builder.release().catch(() => {});
      if (tools.director) await tools.director.release().catch(() => {});
      if (windows.self) await windows.self.release().catch(() => {});
      if (windows.director) await windows.director.release().catch(() => {});
      this.#core.budget.endWork(workClass);
      // Nothing more is handed in; a steer still waiting to hear from the engine hears no.
      delegation.ended = true;
      settleDoor(delegation.steer, null);
      this.#x.activeDelegations.delete(lock);
      this.#core.emit(UiEvent.DelegationFinished, this.#activeIn(p.project, engineId));
    }
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
    const person = await this.#personSession(p, target, session);
    const asksAll = this.#core.engines.get(target.engineId).permissionPrompts === true;
    if (person && asksAll) {
      const hostDirs = [grants.selfShotsDir, grants.playShotsDir];
      const extraReads = await this.#x.permissions.chatReads(session.threadId, grants.extraReads, hostDirs);
      return { person, lead: null, extraReads, denyReads: [], reachesMac: true };
    }
    const lead = person ? null : await this.#leadSession(p, target, grants, session, seat);
    if (lead) {
      // A folder it reads is one Accept edits (and Auto, inside its working folders) writes without
      // asking: the host's own folders and those the chat recorded, never a folder the brief names.
      const recorded = await this.#x.permissions.chatReads(session.threadId, p.extraReads ?? [], []);
      return { person: null, lead, extraReads: [...grants.hostReads, ...recorded], denyReads: [], reachesMac: true };
    }
    const allowed = [...grants.extraReads, this.#core.games.dirFor(p.project)];
    return {
      person,
      lead: null,
      extraReads: grants.extraReads,
      denyReads: await this.workspaceDenyReads(target.cwd, allowed),
      reachesMac: false,
    };
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

  /**
   * Whether this delegation sits in its game's own folder, and whether its director grant is a
   * lead's there (one session): the lead of a waking run is its chat's own session, so it sits
   * in the game folder and reads the run's integration worktree it leads (`root`) without writing.
   */
  async #seatOf(p: DelegateParams, target: DelegationTarget): Promise<DelegationSeat> {
    const live = path.resolve(this.#core.games.dirFor(p.project));
    // The game's own folder: no build worktree, no coordinator home, no candidate.
    const gameFolder = !p.coordinator && !target.candidate && target.cwd === live;
    return { leads: gameFolder ? await this.#leadRoot(p, live) : null };
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
  ): DelegationSession {
    const threadId = threadOr(this.#core, p.threadId);
    const { selfCapture, playtest, director } = grants;
    const activityScope = {
      delegationId: uuidv7(),
      ...delegationActivityScope({ ...p, director, selfCapture, playtest }),
    };
    const chatTurn = chatTurnOf(p, { director, playtest, candidate: target.candidate });
    const runControls = honouredRunControls(p);
    return {
      ...(chatTurn ? { chatTurn } : {}),
      ...(runControls ? { runControls } : {}),
      ...(chatTurn && target.steersMidTurn ? { door: openDoor() } : {}),
      threadId,
      hostTools: hostToolsEligible(p, target.candidate, seat),
      // The chat's coordinator speaks for this game in its chat without the builders' tools: it
      // reads what the builders have, never instructions for tools it cannot call (which read
      // as "Genex is unavailable" to the user).
      conversational: Boolean(p.coordinator),
      activityScope,
      leadTurn: Boolean(director),
      chatLead: Boolean(director?.chatSession === true && seat.leads),
      leads: seat.leads,
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
    const { selfCapture, director } = grants;
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
    if (session.hostTools && this.#core.options.renderGameCover) await this.#offerCover(p.project, tools);
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
    // Every in-scope connector is asked for its tools in parallel, each with its own
    // timeout; one that will not answer contributes nothing and this delegation goes on.
    if (session.hostTools) tools.mcp = await this.#core.mcp.toolsFor(p.project, { signal: session.abort.signal });
    if (session.hostTools) await this.#applyPlugins(p, session, engineId, tools);
    await this.#prepareWindowTools(p, cwd, grants, windows, tools);
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
    const directorLooks = director && directorShotsDir && directorWindow;
    if (directorLooks) {
      await ensureDir(directorShotsDir);
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
    const { engineId, optimization } = target;
    const { blindness, workCwd, extraReads, denyReads } = await this.#sessionReach(target, grants, reach);
    const ownership = normalizeOwnership(p.ownership);
    return {
      ...blindness,
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
   * Where the session starts and what it may read. A judge that plays starts in an empty folder
   * and reads nothing but its own frames: the build reaches it only through the computer tool, so
   * no note in the code can answer for the game.
   */
  async #sessionReach(
    target: DelegationTarget,
    grants: DelegationGrants,
    reach: SessionReach,
  ): Promise<{ blindness: { blind?: true }; workCwd: string; extraReads: string[]; denyReads: string[] }> {
    if (grants.playtest?.role !== "judge") {
      return { blindness: {}, workCwd: target.workCwd, extraReads: reach.extraReads, denyReads: reach.denyReads };
    }
    return {
      blindness: { blind: true },
      workCwd: await this.#blindCwd(),
      extraReads: grants.playShotsDir ? [grants.playShotsDir] : [],
      denyReads: [...reach.denyReads, target.workCwd],
    };
  }

  /** The one empty folder every blind judge starts in, made again if something swept it. */
  async #blindCwd(): Promise<string> {
    const dir = path.join(this.#core.layout.scratch, BLIND_JUDGE_FOLDER);
    await ensureDir(dir);
    return dir;
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
   * whatever the brief says.
   */
  #prompt(p: DelegateParams, session: DelegationSession, tools: SessionTools, reach: SessionReach): string {
    return [
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
            onCapture: directorTools.onCapture,
          }
        : {}),
      ...playtestFields(p, grants, tools),
      ...(session.hostTools ? this.#hostToolFields(p, target, grants, session, tools) : {}),
    };
  }

  /**
   * Host tools: the window's own tools first, then the cover, the run's controls (the chat's own
   * session after a run it led), the plugins and the connectors.
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
      liveTools: [...(windowTools?.liveTools ?? []), ...tools.cover, ...controls, ...tools.plugins, ...tools.mcp],
      onLiveTool: (name: string, args: Record<string, unknown>) =>
        this.#hostTool(name, args, p, target, grants, session, tools),
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
    // Connector first: its names are `<connector>__<tool>`, and the registry is the
    // only thing that can say whether one of them is really on this list.
    if (this.#core.mcp.owns(name))
      return this.#x.pluginTools.invokeConnectorTool(name, args, binding, callSignal, { outlivesTurn: lead });
    if (!tools.plugins.some((tool) => tool.name === name)) {
      const handler = tools.director?.onLiveTool ?? tools.builder?.onLiveTool;
      if (!handler) throw new Error(MESSAGE.unknownTool(name));
      return handler(name, args);
    }
    const result = await this.#x.pluginTools.invokePluginTool(name, args, binding, callSignal, {
      engine: target.engineId,
      selfCapture: grants.selfCapture,
      director: grants.director,
      lead,
    });
    return pluginAnswer(result);
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

/** A plugin tool named like one of the run's controls would be called in its place: refused, as a cover's name is. */
function assertRunControlsFree(tools: SessionTools): void {
  const taken = tools.plugins.find((tool) => isRunControl(tool.name));
  if (taken) throw new Error(MESSAGE.toolCollision(taken.name));
}

/** How the session asks, if it does: the chat's own session's permissions, or a lead's or coordinator's. */
function askFields({ person, lead }: SessionReach): Partial<DelegateRequest> {
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
