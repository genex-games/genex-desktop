/**
 * The core's own state and services as the extracted services and harness RPC groups see it,
 * in narrow groups: work in flight, what the previews serve, the self-improvement and recovery
 * flags, and the core's views, checks and services. `StudioCore` builds the one object that
 * holds it and hands it only to what it composes.
 */
import path from "node:path";
import type { BuildProblem } from "../../shared/build-problem.ts";
import type { NativeTimers } from "../../shared/native-contract.ts";
import type { AgentScreen, AgentScreenFrame } from "../../shared/agent-screen.ts";
import type { Revision } from "../../shared/optimization.ts";
import type { PermissionMode } from "../../shared/permissions.ts";
import type { PluginAppliedSet, PluginBinding } from "../../shared/plugins.ts";
import type { LiveToolResult } from "../../substrate/engines/types.ts";
import type { GameProject } from "../../substrate/game-workspace.ts";
import type { SecretPort } from "../../substrate/mcp/store.ts";
import type { PreviewPool } from "../../substrate/preview-pool.ts";
import type { SeedUpgradeReport } from "../../substrate/seed-upgrade.ts";
import type { TurnHandle } from "../../substrate/turns.ts";
import type { EventEnvelope } from "../../substrate/types.ts";
import { workerLockKey } from "../../shared/workers.ts";
import type { PlanReviewController } from "../plan-review.ts";
import type { PluginConsent } from "../plugin-consent.ts";
import type { CppBuilds } from "../cpp-build.ts";
import { type GameBuildLane, GameBuildLanes, raylibLane } from "../game-build.ts";
import { RUST_TARGET_BUILDERS, type RustTargetBuilder } from "../rust-build.ts";
import { RUST_MOBILE_TARGET_BUILDERS } from "../rust-build-mobile.ts";
import { RUST_WEB_BUILDER } from "../rust-build-web.ts";
import { BuildTarget, GameStack } from "../../shared/game-project.ts";
import { STACK_REQUIRED_COMPONENTS, type StackComponents } from "../../shared/toolchain.ts";
import { rustCrossBuilders } from "./rust-cross-lane.ts";
import type { AssetCall } from "./asset-calls.ts";
import type { AssetService } from "./assets.ts";
import type { ChatPermissionService } from "./chat-permissions.ts";
import type { SteerDoor } from "./chat-steer.ts";
import type { CapabilityAudience } from "../planning-capabilities.ts";
import type { ConversationService } from "./conversation.ts";
import type { CutOffCall } from "./cut-off-calls.ts";
import type { UnsavedFile } from "./unsaved-files.ts";
import type { DelegationService } from "./delegation.ts";
import type { StudioSettings } from "./settings.ts";
import type { ObserverService } from "./observers.ts";
import type { FinishReviews } from "./finish-review.ts";
import type { HookService } from "./plugin-hooks.ts";
import type { LockService, PersonWrote } from "./plugin-locks.ts";
import type { PluginToolService } from "./plugin-tools.ts";
import type { PreviewService } from "./previews.ts";
import type { RecoveryService } from "./recovery.ts";
import type { ChatRewindService } from "./rewind.ts";
import type { SelfEditGateService } from "./self-edit-gate.ts";
import type { SelfImprovementService } from "./self-improvement.ts";
import type { NativeRunsHost } from "./native-runs.ts";
import type { ToolchainService } from "./toolchains.ts";
import type { ToolsInFlight } from "./steer-cut.ts";

/** One brief in flight: the lock on its folder, and the contractor working there once it starts. */
export interface ActiveDelegation {
  project: string;
  threadId: string;
  engine: string;
  startedAt: number;
  abort: AbortController;
  started?: boolean;
  /**
   * Steer (`chat-steer.ts`): this session is its chat's current turn — the message it answers — so
   * what the person sends meanwhile can reach it (`engine.steer`). Only a chat's own session, or a
   * run's lead, whose turn is its run id.
   */
  chatTurn?: string;
  /** Its input mid-turn, when its engine reads messages as it works (`Engine.steersMidTurn`). */
  steer?: SteerDoor;
  /**
   * Interrupted to take steered messages, or to be at its next step: its caller resumes it with them
   * rather than reading a Stop.
   */
  steered?: boolean;
  /** A chat turn's session: its tool calls in flight, as its events say. A cut for a steer waits for them (`steer-cut.ts`). */
  tools?: ToolsInFlight;
  /** A cut for a steer waits for its tools in flight to end (`cutAtNextStep`). */
  cutPending?: boolean;
  /** A chat turn's session: the person's word that ends its plugin calls' waits for a lock (`engine.steer`). */
  personWrote?: PersonWrote;
  /** Its engine call has returned: nothing more is handed in. */
  ended?: boolean;
  /** A Loop's reviewer the host seated: the run it checks (`engine.abort` reaches it by that run alone). */
  reviewer?: string;
  /**
   * A Loop's lead in place the host seated: its run. `engine.abort` with that run as `lead` reaches
   * it alone, never another chat's session in the same folder; its run's unseated workers hold keys
   * of their own beside it.
   */
  leadsInPlace?: string;
  /** An unseated worker of this run in the game folder, on a key of its own beside the run's lead in place. */
  besideLeadOf?: string;
  /**
   * A worker of a chat's lead, as the host honoured it: its id (Stop reaches an in-place one by
   * it) and the chat it answers to, whose Settings ceiling it counts against, reader or writer.
   */
  worker?: { id: string; chatThreadId: string };
  /**
   * The worker id the harness's grant named, honoured or not: Stop and an interrupt by a worker's
   * id find it by this (`delegationAt`), seated or not.
   */
  askedWorker?: string;
  /** The lock holder its calls pass as (`workerHolder`): a worker whose in-place holds the harness took. */
  holder?: string;
  /** Aborts once its engine has let go (the session's end), however it ended. */
  settled?: AbortSignal;
}

/**
 * The delegations working in `dir`: the one keyed by the folder itself, and every in-place worker's
 * there, each under its own lock (`workerLockKey`). What "anyone building in the folder" means.
 */
export function delegationsIn(delegations: ReadonlyMap<string, ActiveDelegation>, dir: string): ActiveDelegation[] {
  const folder = path.resolve(dir);
  const workers = workerLockKey(folder, "");
  return [...delegations.entries()]
    .filter(([key]) => key.startsWith(workers) || path.resolve(key) === folder)
    .map(([, delegation]) => delegation);
}

/** Work in flight, keyed so Stop, a turn's end and a crash can find and settle it. */
export interface WorkInFlight {
  /**
   * In-flight direct completions by thread, so Stop can abort a local model *mid-generation*.
   * Without this, a stop only landed at the next round boundary — during a long qwen tool call
   * (minutes of silent generation) the button visibly did nothing.
   */
  readonly activeCompletions: Map<string, Set<AbortController>>;
  /**
   * Connector calls in flight, by the chat and game they were made for. A build's lead's call
   * outlives the chat's turns (`outlivesTurn`): only its session's end or a Stop ends it. One the
   * harness itself made (`mcp.invoke`, `byHarness`) ends with that harness, planned or not.
   */
  readonly activeConnectorCalls: Map<
    AbortController,
    { project?: string | null; threadId?: string; outlivesTurn?: boolean; byHarness?: boolean }
  >;
  /** Calls making an asset, in flight, by call id: the games' waiting jobs while they run (`asset-calls.ts`). */
  readonly assetCalls: Map<string, AssetCall>;
  /** Genex's moments the harness asked for, in flight, by the game and chat they answer to (`moment-stops.ts`). */
  readonly activeMoments: Map<AbortController, { project: string; threadId?: string }>;
  /**
   * Plugin and connector calls cut off before they answered (outcome unknown), by the thread that
   * made them, until that thread's next delegated session is told of them (`cut-off-calls.ts`).
   */
  readonly cutOffCalls: Map<string, CutOffCall[]>;
  /**
   * Files too large to save that a thread's chat said a checkpoint or a rewind left, until that
   * thread's next delegated session is told of them (`unsaved-files.ts`).
   */
  readonly unsavedFiles: Map<string, UnsavedFile[]>;
  /**
   * One contractor per *directory* (live game folder or facet worktree), keyed by resolved cwd.
   * The first live build proved why a dir takes a lock: a crash mid-delegation left the
   * contractor running detached, a second "hi" was delegated into the same folder, and the two
   * sessions spent half an hour negotiating file ownership with each other. Keying by cwd
   * rather than project is what lets N facet worktrees of one game build in parallel while two
   * sessions in one folder still collide.
   *
   * Every brief in flight, keyed by the folder it builds in. `started` flips when the engine
   * call begins: until then the entry is the per-cwd lock and nothing more, and `engine.delegations`
   * does not list it — a Stop that lands in that gap aborts a contractor that never started.
   */
  readonly activeDelegations: Map<string, ActiveDelegation>;
  /**
   * How many times each game was announced changed (`GameChanged`) in this app run: a session's end
   * announces a game that took its kind during the session only when nothing else announced it.
   */
  readonly gameChanges: Map<string, number>;
  /** Runs currently holding keep-awake (run.keepawake → run.settled) — idle means none. */
  readonly activeRunIds: Set<string>;
  /** Settled runs whose jobs are still stopping, until each job's end is in its chat. */
  readonly runJobStops: Set<string>;
  readonly openTurns: Map<string, TurnHandle>;
  /**
   * Bumped whenever the harness stops being ready (a planned restart too): a `turn.begin` from an
   * older loop is not registered, since nobody is left to end it.
   */
  harnessGeneration: number;
  /**
   * Who asked, for each plugin call in flight, keyed by the binding the call was made with — the
   * very object the plugin process hands back to the host services, so files delivered inside a
   * call are attributed to the worker that made it, and a build's lead's consent is asked as the
   * chat's own session's (`lead`). Weak: a dropped call leaves nothing behind.
   */
  readonly pluginCallAttribution: WeakMap<
    PluginBinding,
    { runId?: string; facetId?: string; iteration?: number; lead?: boolean }
  >;
  readonly pluginTurnLeases: Map<string, () => Promise<void>>;
  /**
   * Runs a harness that died was in the middle of. They are settled here the moment it dies, but
   * only the reborn loop can write their ending into their own thread, so the ids ride along in
   * the next boot notice. They are kept rather than handed over once, because a crash *loop*
   * restarts through the watchdog and not through the host's own auto-restart; offering an id
   * twice costs nothing, since the loop closes a run only when its thread has no ending yet.
   */
  readonly runsOrphanedByCrash: Set<string>;
}

/** What the live stage's preview is showing (`runPreview.state`, the `preview.identity` UI event). */
export const PreviewIdentityState = {
  Unknown: "unknown",
  Loading: "loading",
  Loaded: "loaded",
  Stale: "stale",
  Failed: "failed",
  RevisionUnverified: "revision-unverified",
} as const;
export type PreviewIdentityState = (typeof PreviewIdentityState)[keyof typeof PreviewIdentityState];

/** What the run's preview is showing, as `runPreviewIdentity` reports it. */
export interface RunPreview {
  project: string | null;
  head: string | null;
  state: PreviewIdentityState;
  error: string | null;
}

/** What a preview handle last served. */
export interface ServedRoot {
  project: string;
  root: string | null;
  entry: string | undefined;
  loaded: string | null;
}

/** What the previews serve, borrow and show. */
export interface PreviewState {
  /** The live folder's last build failure, per project — what the stage puts on screen. */
  readonly buildProblems: Map<string, BuildProblem>;
  /**
   * The harness boot that owns the windows borrowed over `preview.acquire`. A killed harness never
   * runs the `finally` that gives them back, so they are released, and this bumped, whenever that
   * boot ends (death, watchdog restore, self-update restart).
   */
  harnessBoot: number;
  readonly previewOperations: Map<string, Promise<unknown>>;
  /** Observation ports by handle; null until a preview is attached. */
  previewPool: PreviewPool | null;
  readonly profileSources: Map<string, { candidateId: string; revision: Revision }>;
  /**
   * Folders the user named in chat that sit outside the project — stills to look at, not to write.
   * Keyed by project id. Restored from thread metadata so an unattended run still sees them.
   */
  readonly readRoots: Map<string, Set<string>>;
  runPreview: RunPreview;
  /** Agent screens: what the UI shows of every window a worker is driving. */
  readonly screens: Map<string, AgentScreenFrame | (AgentScreen & { jpeg?: undefined })>;
  /**
   * What each preview handle last served, so Reload rebuilds a game that has its own build.
   * `loaded` is what the port was actually given — null when the build was broken and there was
   * nothing to show — so a Reload can tell "the same page again" from "a different folder now".
   */
  readonly servedRoots: Map<string, ServedRoot>;
}

/** The self-improvement and recovery flags, timers and queues. */
export interface ImprovementState {
  applyChain: Promise<unknown>;
  architectRunning: boolean;
  autoApplying: boolean;
  readonly changeDiffs: Map<string, string>;
  idleTimer: NodeJS.Timeout | null;
  lastActivity: number;
  pendingUpdateId: string | null;
  recovering: boolean;
  seedReport: SeedUpgradeReport | null;
}

/** Read-only views of state the core owns. */
export interface CoreViews {
  /** The plan-review controller (TypeScript-private on the core, created on first use). */
  readonly planReviews: PlanReviewController;
  /** Questions an agent's plugin tool is waiting on the user for (`plugin_consent` cards in the chat). */
  readonly consent: PluginConsent;
  /** The same port the MCP registry reads, kept so a plugin server's `secret:<name>` can be resolved. */
  readonly mcpSecrets: SecretPort | null;
  /** The clock native runs and a builder's wait for a Mac run go by (`StudioCoreOptions.nativeTimers`, else the real one). */
  readonly nativeTimers: NativeTimers;
  readonly settings: StudioSettings;
  readonly started: boolean;
  readonly toolRegistryRevision: number;
}

/** The core's checks and actions the services share. */
export interface CoreChecks {
  assertHarnessRoot(project: string, root: string | null | undefined): Promise<string | null>;
  assertNoLinkBelow(base: string, target: string): Promise<void>;
  /** Abort the connector calls in scope: a Stop's (`stop`, the default), or a turn's end (`turn`), which a lead's call outlives. */
  cancelConnectorCalls(binding?: { project?: string; threadId?: string }, by?: "stop" | "turn"): void;
  capabilityFacts(
    threadId: string,
    project: string | null | undefined,
    audience: CapabilityAudience,
  ): Promise<{ revision: number; text: string }>;
  indexEvent(event: EventEnvelope): void;
  readyProject(project: GameProject): Promise<GameProject>;
  recordToolRevision(threadId: string, engine: string, revision?: number): Promise<void>;
  /** `engine`'s session `session` answered a brief that handed it `applied` (`ConnectionService.recordDelivered`). */
  recordDeliveredTools(threadId: string, engine: string, session: string, applied: PluginAppliedSet): Promise<void>;
  /** The plugins and skills `engine`'s session `session` on this thread was last handed (`ConnectionService.lastApplied`). */
  lastAppliedTools(threadId: string, engine: string, session: string): Promise<PluginAppliedSet | undefined>;
  setGameCover(
    project: string,
    args: Record<string, unknown>,
    threadId?: string,
    signal?: AbortSignal,
  ): Promise<string>;
  setGameCoverShader(
    project: string,
    surface: unknown,
    threadId?: string,
    signal?: AbortSignal,
  ): Promise<LiveToolResult>;
}

/** The services the core composes, for the ones that call each other. */
export interface CoreServices {
  readonly previews: PreviewService;
  readonly delegation: DelegationService;
  readonly recovery: RecoveryService;
  readonly selfImprovement: SelfImprovementService;
  readonly selfEditGate: SelfEditGateService;
  readonly pluginTools: PluginToolService;
  /** The locks plugin tools and connectors wait their turn for, the person first (`plugin-locks.ts`). */
  readonly locks: LockService;
  /** Genex's moments and the plugin steps they run (`plugin-hooks.ts`). */
  readonly hooks: HookService;
  /** A game's observers run inside a run, their pictures kept with it (`observers.ts`). */
  readonly observers: ObserverService;
  /** A Loop's finish checks: the reviewer's verdict is the host's to read and record (`finish-review.ts`). */
  readonly finishReviews: FinishReviews;
  readonly conversation: ConversationService;
  readonly assets: AssetService;
  readonly rewind: ChatRewindService;
  /** Claude Code permissions in game chats: who asks, the cards, the modes and what "always" keeps. */
  readonly permissions: ChatPermissionService;
  /** The C++ · raylib build lane. */
  readonly cppBuilds: CppBuilds;
  /** The managed C++ toolchain store's service. */
  readonly toolchains: ToolchainService;
  /** Every C++ · raylib game the studio started (the native run registry). */
  readonly nativeRuns: NativeRunsHost;
  /** Whether a game chat is in Plan mode, when nothing may act on its behalf (`ChatPermissionService.planning`). */
  planning(threadId: string): Promise<boolean>;
  /** A game chat's permission mode now, as its questions are answered by (`ChatPermissionService.modeOf`). */
  chatMode(threadId: string): Promise<PermissionMode>;
}

/**
 * The build-lane seam as the core holds it (`x.gameBuilds`): every compiled stack's lane behind
 * one `ensure(game, target, purpose)`, built by {@link coreGameBuilds}. Every compiled build goes
 * through it; `cppBuilds` stays for the toolchain store's own needs and tests.
 */
export interface CoreBuildLanes {
  readonly gameBuilds: GameBuildLanes;
}

/**
 * The core's build lanes, registered by stack: C++ · raylib is the core's own `CppBuilds` behind
 * its adapter, Rust · wgpu the core's `RustBuilds` as it stands. A stack registered here is the
 * only way its games build; one missing is refused `lane-missing` (Rust in a core given no Rust lane).
 */
export function coreGameBuilds(services: {
  readonly cppBuilds: Pick<CppBuilds, "ensure" | "cancelAll" | "cancelGame" | "sweep">;
  readonly rustBuilds?: GameBuildLane;
}): GameBuildLanes {
  return new GameBuildLanes({
    [GameStack.RaylibCpp]: raylibLane(services.cppBuilds),
    ...(services.rustBuilds ? { [GameStack.RustWgpu]: services.rustBuilds } : {}),
  });
}

/**
 * The Rust lane's builders: the lane's own table with each later destination's builder registered
 * over it, one line per builder, by its slice integrator (web and phones M2.12c, Windows and Linux
 * M4.6, once `required`, the Rust row of `STACK_REQUIRED_COMPONENTS`, lists their cross
 * components: `rust-cross-lane.ts`). `studio-core` hands it to `RustBuilds`, with the settings
 * hook `rustTargetSettings` (the phones', Windows' and Linux's).
 */
export function rustTargetBuilders(
  required: StackComponents = STACK_REQUIRED_COMPONENTS[GameStack.RustWgpu],
): Record<BuildTarget, RustTargetBuilder> {
  return {
    ...RUST_TARGET_BUILDERS,
    [BuildTarget.Web]: RUST_WEB_BUILDER,
    [BuildTarget.Ios]: RUST_MOBILE_TARGET_BUILDERS[BuildTarget.Ios],
    [BuildTarget.Android]: RUST_MOBILE_TARGET_BUILDERS[BuildTarget.Android],
    ...rustCrossBuilders(required),
  };
}

/**
 * Everything the extracted services and RPC groups reach inside the core. Not part of the public
 * surface — only `StudioCore` builds it, and it hands it only to what it composes.
 */
export interface CoreInternals
  extends CoreBuildLanes,
    WorkInFlight,
    PreviewState,
    ImprovementState,
    CoreViews,
    CoreChecks,
    CoreServices {}

/** Nothing in flight yet. */
export function idleWork(): WorkInFlight {
  return {
    activeCompletions: new Map(),
    activeConnectorCalls: new Map(),
    assetCalls: new Map(),
    activeMoments: new Map(),
    cutOffCalls: new Map(),
    unsavedFiles: new Map(),
    activeDelegations: new Map(),
    gameChanges: new Map(),
    activeRunIds: new Set(),
    runJobStops: new Set(),
    openTurns: new Map(),
    harnessGeneration: 0,
    pluginCallAttribution: new WeakMap(),
    pluginTurnLeases: new Map(),
    runsOrphanedByCrash: new Set(),
  };
}

/** No preview served yet; the first harness boot is 1. */
export function unservedPreviews(): PreviewState {
  return {
    buildProblems: new Map(),
    harnessBoot: 1,
    previewOperations: new Map(),
    previewPool: null,
    profileSources: new Map(),
    readRoots: new Map(),
    runPreview: { project: null, head: null, state: PreviewIdentityState.Unknown, error: null },
    screens: new Map(),
    servedRoots: new Map(),
  };
}

/** Nothing applied, staged or recovering; activity counts from now. */
export function freshImprovementState(): ImprovementState {
  return {
    applyChain: Promise.resolve(),
    architectRunning: false,
    autoApplying: false,
    changeDiffs: new Map(),
    idleTimer: null,
    lastActivity: Date.now(),
    pendingUpdateId: null,
    recovering: false,
    seedReport: null,
  };
}
