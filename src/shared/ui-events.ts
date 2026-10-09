/**
 * The transient UI events main pushes to the renderer on `studio:event` (`StudioApi.onEvent`).
 * They announce; they are not the record: whatever must survive a reload is in the event log.
 *
 * Three producers feed the channel: `StudioCore.emit`, `pushUiEvent` in `main/index.ts`, and the
 * harness's `host.notify`/`ctx.notify`, which main forwards as is. The harness is editable, so the
 * fields it writes stay optional here, and a name it invents still reaches the renderer, which
 * ignores types it does not know. `tests/conformance/ui-events.test.ts` checks that every literal
 * name those producers pass is a key of {@link UiEventMap}, and that every key is still produced.
 */
import type { AgentScreenEvent, AgentScreenFrame } from "./agent-screen.ts";
import type { ReadyUpdate } from "./app-update.ts";
import type { AssetDeliveredPayload } from "./game-assets.ts";
import type { LiveBehindEvent } from "./live-behind.ts";
import type { McpChange } from "./mcp.ts";
import type { CliInstallJob } from "./cli-install.ts";
import type { ModelInstallJob } from "./model-install.ts";
import type { ToolPermissionState } from "./permissions.ts";
import type { PluginChange, PluginConsentEvent } from "./plugins.ts";
import type { BootNotice, HarnessState } from "./protocol.ts";
import type { RunSummary } from "./run-summary.ts";
import type { StudioSettingsView } from "./studio-api.ts";

/** A record the harness wrote whole (a report, a verdict): the fields named are the ones read. */
type HarnessRecord<Named extends object = object> = Partial<Named> & { readonly [field: string]: unknown };

/** Every thread's live status line, as the harness last reported it. */
export type ThreadStatusMap = Record<string, { status: string; since: number }>;

/** A download step for a local model: Ollama's pull stream, Bonsai's installer, or the failure. */
export interface ModelPullProgress {
  status: string;
  digest?: string;
  completed?: number;
  total?: number;
  error?: string;
}

/** A contractor's reply streaming into a thread, before its words land in the log. */
export interface ChatDelta {
  threadId: string;
  streamId: string;
  delta?: string;
  /** The delta is the whole reply so far, not an addition. */
  replace?: boolean;
  /** The log head the stream follows; the reply sits after it. */
  afterEventId?: string | null;
}

export interface UiEventMap {
  // — chat and threads —
  "chat.message": { threadId?: string; role?: string; content?: string };
  "chat.error": { threadId?: string; message?: string };
  "chat.delta": ChatDelta;
  "chat.stream.started": { threadId: string; streamId: string; afterEventId: string | null };
  "chat.stream.ended": { threadId: string; streamId: string; failed?: boolean };
  "chat.stream.committed": { threadId: string; streamId: string; eventId: string };
  "thread.created": { threadId: string; project: string | null };
  "thread.updated": { threadId: string; title?: string; project?: string | null };
  "thread.bound": { threadId: string; project: string };
  /** A chat was rewound to before one of its messages (`main/core/rewind.ts`). */
  "thread.rewound": { threadId: string };
  "thread.compacted": { threadId?: string; messages?: number };
  "compact.finished": HarnessRecord<{ threadId: string }>;
  "context.usage": {
    threadId?: string;
    engine?: string;
    model?: string | null;
    promptTokens?: number;
    contextWindow?: number;
    percent?: number;
  };
  "tool.started": { name?: string; id?: string };
  "tool.finished": { name?: string; id?: string; ok?: boolean };
  "coordinator.status": { threadId?: string; status?: string };
  "coordinator.queued": { threadId?: string; messageId?: string };
  "coordinator.processing": { threadId?: string; messageId?: string };
  "coordinator.handled": { threadId?: string; messageId?: string };
  /** Steer: messages handed to the chat's running turn, read by it, or put back to wait. */
  "coordinator.steering": { threadId?: string; messageIds?: string[] };
  "coordinator.delivered": { threadId?: string; messageIds?: string[] };
  "coordinator.requeued": { threadId?: string; messageIds?: string[] };

  // — harness —
  "harness.state": { state: HarnessState };
  "harness.status": { threadId?: string; status?: string; all?: ThreadStatusMap };
  "harness.log": { line: string; stream: "stdout" | "stderr" };
  "harness.boot": Partial<BootNotice>;
  "seed.upgraded": { added: string[]; updated: string[]; kept: string[]; retired: string[] };
  "watchdog.triggered": { reason: string; snapshot: string | null };
  "watchdog.recovered": { reason: string; ok: boolean; reseeded?: boolean };
  "watchdog.failed": { reason: string; error: string };
  "studio.ready": { userData: string };
  /** The person clicked a macOS notification Studio showed; `id` is the one `notify` was given. */
  "notification.open": { id: string };
  /** A new version of the app is downloaded; a restart installs it (`main/auto-update.ts`). */
  "update.ready": ReadyUpdate;

  // — engines and models —
  "engines.changed": { engine?: string };
  "engine.auth": { engine?: string; message?: string };
  "engine.fallback": { from?: string; to?: string; kind?: string; role?: string };
  "model.install": ModelInstallJob;
  /** An in-app Claude Code or Codex install started, finished or failed. */
  "cli.install": CliInstallJob;
  "model.pull": { model: string; progress: ModelPullProgress };

  // — games and builds —
  "game.changed": { project?: string; file?: string; warning?: string };
  "game.archived": { project: string; trash: boolean };
  "delegation.started": { project: string; engine: string; active: number };
  "delegation.finished": { project: string; engine: string; active: number };
  "delegation.checkpoint": { project: string; cwd: string; note: string };
  /** One event of a delegated contractor session, as its engine reported it. */
  "delegated.event": { engine: string; type: string; payload: unknown };
  "asset.delivered": AssetDeliveredPayload;
  /** A coordinator tool put a build on screen: the chat of that game brings Live forward. */
  "stage.show": { project: string; view: "live" };

  // — runs —
  "run.keepawake": { runId?: string };
  "run.stopping": { runId?: string };
  "run.finished": HarnessRecord<{ runId: string }>;
  "run.settled": { runId?: string };
  "run.failed": { runId?: string; error?: string };
  "run.feedback": { threadId: string; runId: string | null };
  "run.iteration": HarnessRecord<{ runId: string }>;
  "run.optimization": { runId?: string; sequence?: number };
  "run.summary.changed": { runId: string };
  "autopilot.facet": HarnessRecord<{ runId: string }>;
  "autopilot.spike": { runId?: string; facetId?: string; checkId?: string; ok?: boolean; reason?: string };
  "judge.verdict": HarnessRecord;
  "judge.facet": HarnessRecord;
  "judge.vision": HarnessRecord<{ checkId: string }>;
  "judge.taste": HarnessRecord;
  "judge.panel": HarnessRecord;
  "judge.playtest": HarnessRecord;
  "judge.retry": { engine?: string; kind?: string; attempt?: number; waitMs?: number; message?: string };
  "judge.liveness": {
    facetId?: string;
    iterationId?: string;
    critic?: string;
    total?: number;
    max?: number;
    biggest?: unknown;
  };

  // — preview —
  "preview.identity": NonNullable<RunSummary["preview"]>;
  "preview.screen": AgentScreenEvent;
  "preview.frame": AgentScreenFrame;
  /** Something Live could show now waits for the person's Reload, or (`reason: null`) nothing does. */
  "live.behind": LiveBehindEvent;
  /** ⌥⌘M pressed while the Live game had the keyboard: the renderer owns the switch and flips it. */
  "preview.sound.toggle": { at: number };

  // — plugins and connectors —
  "plugins.changed": PluginChange;
  /** Something a plugin reported about itself; `event` is the plugin's own value, unchecked. */
  "plugin.event": { id: string; event: unknown; project?: string; threadId?: string };
  "plugin.consent": { consentId: string; threadId?: string; project: string; state: PluginConsentEvent["state"] };
  /**
   * A call waits for the person to finish in what a plugin's lock guards (`label`, the app they
   * see), or (`waiting: false`) no longer does: the chat's working line says so meanwhile.
   */
  "lock.person-first": { project: string; threadId?: string; label: string; waiting: boolean };
  /**
   * A game chat's Claude session asked the person (`tool_permission` in the log), or the question
   * settled. A nudge to read the log again, never state: the harness may send any name.
   */
  "tool.permission": { requestId: string; threadId: string; project: string; state: ToolPermissionState };
  /** A chat's mode, the mode new chats start in, a saved rule or where Auto is unavailable changed. */
  "permissions.changed": { threadId?: string };
  "mcp.changed": McpChange;
  "connections.changed": { revision: number };
  "connections.applied": { threadId: string; revision: number };

  // — self-improvement —
  "settings.changed": StudioSettingsView;
  "skillopt.accepted": { skill?: string; approvedBy?: "human" | "auto"; gate?: unknown };
  "skillopt.staged": { skill?: string; gate?: unknown };
  "skillopt.discarded": { skill: string };
  "skillopt.autoApplied": { skill: string };
  "skillopt.autoApplyFailed": { error: string };
  "skillopt.finished": HarnessRecord<{ note: string }>;
  "skillopt.failed": { error?: string };
  "improvement.finished": { id: string; status: "rejected" | "failed"; note: string };
  "improvement.applied": { id: string; file: string; reason: string };
  "selfchange.undone": { snapshotId: string; file: string };
  "selfmod.edited": { file?: string; reason?: string };
  "selfmod.tool_installed": { file?: string; reason?: string };
  "selfmod.skill_edited": { slug?: string; reason?: string };
  "selfmod.restart_queued": { updateId: string; reason: string; snapshotId: string };
  "selfmod.restarted": { updateId: string; ok: boolean };
}

export type UiEventType = keyof UiEventMap;

/** One UI event: a name from the map and its payload. Narrow on `type` to read the payload. */
export type UiEventOf<K extends UiEventType> = { [P in K]: { type: P; payload: UiEventMap[P] } }[K];
export type UiEvent = UiEventOf<UiEventType>;

/**
 * Every name in the map, as call sites write it: `core.emit(UiEvent.PreviewFrame, …)`. The type
 * named `UiEvent` is the event itself (name and payload); a bare name is a {@link UiEventType}.
 */
export const UiEvent = {
  ChatMessage: "chat.message",
  ChatError: "chat.error",
  ChatDelta: "chat.delta",
  ChatStreamStarted: "chat.stream.started",
  ChatStreamEnded: "chat.stream.ended",
  ChatStreamCommitted: "chat.stream.committed",
  ThreadCreated: "thread.created",
  ThreadUpdated: "thread.updated",
  ThreadBound: "thread.bound",
  ThreadRewound: "thread.rewound",
  ThreadCompacted: "thread.compacted",
  CompactFinished: "compact.finished",
  ContextUsage: "context.usage",
  ToolStarted: "tool.started",
  ToolFinished: "tool.finished",
  CoordinatorStatus: "coordinator.status",
  CoordinatorQueued: "coordinator.queued",
  CoordinatorProcessing: "coordinator.processing",
  CoordinatorHandled: "coordinator.handled",
  CoordinatorSteering: "coordinator.steering",
  CoordinatorDelivered: "coordinator.delivered",
  CoordinatorRequeued: "coordinator.requeued",
  HarnessState: "harness.state",
  HarnessStatus: "harness.status",
  HarnessLog: "harness.log",
  HarnessBoot: "harness.boot",
  SeedUpgraded: "seed.upgraded",
  WatchdogTriggered: "watchdog.triggered",
  WatchdogRecovered: "watchdog.recovered",
  WatchdogFailed: "watchdog.failed",
  StudioReady: "studio.ready",
  NotificationOpen: "notification.open",
  UpdateReady: "update.ready",
  EnginesChanged: "engines.changed",
  EngineAuth: "engine.auth",
  EngineFallback: "engine.fallback",
  ModelInstall: "model.install",
  CliInstall: "cli.install",
  ModelPull: "model.pull",
  GameChanged: "game.changed",
  GameArchived: "game.archived",
  DelegationStarted: "delegation.started",
  DelegationFinished: "delegation.finished",
  DelegationCheckpoint: "delegation.checkpoint",
  DelegatedEvent: "delegated.event",
  AssetDelivered: "asset.delivered",
  StageShow: "stage.show",
  RunKeepawake: "run.keepawake",
  RunStopping: "run.stopping",
  RunFinished: "run.finished",
  RunSettled: "run.settled",
  RunFailed: "run.failed",
  RunFeedback: "run.feedback",
  RunIteration: "run.iteration",
  RunOptimization: "run.optimization",
  RunSummaryChanged: "run.summary.changed",
  AutopilotFacet: "autopilot.facet",
  AutopilotSpike: "autopilot.spike",
  JudgeVerdict: "judge.verdict",
  JudgeFacet: "judge.facet",
  JudgeVision: "judge.vision",
  JudgeTaste: "judge.taste",
  JudgePanel: "judge.panel",
  JudgePlaytest: "judge.playtest",
  JudgeRetry: "judge.retry",
  JudgeLiveness: "judge.liveness",
  PreviewIdentity: "preview.identity",
  PreviewScreen: "preview.screen",
  PreviewFrame: "preview.frame",
  LiveBehind: "live.behind",
  PreviewSoundToggle: "preview.sound.toggle",
  PluginsChanged: "plugins.changed",
  PluginEvent: "plugin.event",
  PluginConsent: "plugin.consent",
  PersonFirst: "lock.person-first",
  ToolPermission: "tool.permission",
  PermissionsChanged: "permissions.changed",
  McpChanged: "mcp.changed",
  ConnectionsChanged: "connections.changed",
  ConnectionsApplied: "connections.applied",
  SettingsChanged: "settings.changed",
  SkilloptAccepted: "skillopt.accepted",
  SkilloptStaged: "skillopt.staged",
  SkilloptDiscarded: "skillopt.discarded",
  SkilloptAutoApplied: "skillopt.autoApplied",
  SkilloptAutoApplyFailed: "skillopt.autoApplyFailed",
  SkilloptFinished: "skillopt.finished",
  SkilloptFailed: "skillopt.failed",
  ImprovementFinished: "improvement.finished",
  ImprovementApplied: "improvement.applied",
  SelfchangeUndone: "selfchange.undone",
  SelfmodEdited: "selfmod.edited",
  SelfmodToolInstalled: "selfmod.tool_installed",
  SelfmodSkillEdited: "selfmod.skill_edited",
  SelfmodRestartQueued: "selfmod.restart_queued",
  SelfmodRestarted: "selfmod.restarted",
} as const satisfies Record<string, UiEventType>;

// Every name in the map has a member: a name added to the map without one fails here.
type UnlistedUiEvent = Exclude<UiEventType, (typeof UiEvent)[keyof typeof UiEvent]>;
const uiEventsAreListed: [UnlistedUiEvent] extends [never] ? true : { unlisted: UnlistedUiEvent } = true;
void uiEventsAreListed;

/** Every name in the map, for code that checks a name at run time. */
export const UI_EVENT_TYPES: readonly UiEventType[] = Object.freeze(Object.values(UiEvent));

const KNOWN: ReadonlySet<string> = new Set(UI_EVENT_TYPES);

export function isUiEventType(name: unknown): name is UiEventType {
  return typeof name === "string" && KNOWN.has(name);
}

/**
 * A value shaped like a UI event whose name is in the map. The payload is not validated: fields the
 * harness writes are optional in the map, and every consumer reads them tolerantly.
 */
export function isUiEvent(value: unknown): value is UiEvent {
  return (
    typeof value === "object" && value !== null && "type" in value && "payload" in value && isUiEventType(value.type)
  );
}

/** The events whose names start with `prefix` ("chat.", "skillopt."), narrowed to their union. */
export function isUiEventIn<Prefix extends string>(
  event: UiEvent,
  prefix: Prefix,
): event is Extract<UiEvent, { type: `${Prefix}${string}` }> {
  return event.type.startsWith(prefix);
}

/**
 * The event for a name and its payload. Every call is checked against the map; the one cast is
 * because TypeScript cannot relate a generic name to its own payload inside the union.
 */
export function uiEvent<K extends UiEventType>(type: K, payload: UiEventMap[K]): UiEvent {
  return { type, payload } as UiEventOf<K> as UiEvent;
}

/**
 * Events only the host may send: what they say the renderer acts on (`live.behind` names the
 * build Live's Reload plays), so the harness's forwarded notifications never carry one.
 */
const HOST_ONLY: ReadonlySet<string> = new Set<UiEventType>([UiEvent.LiveBehind]);

/** Whether a harness notification names an event only the host sends. */
export const isHostOnlyUiEvent = (name: string): boolean => HOST_ONLY.has(name);

/**
 * A notification from the harness, forwarded exactly as it came: its name may be one this map does
 * not know (an edited harness), and its payload is whatever the harness wrote.
 */
export function harnessUiEvent(type: string, payload: unknown): UiEvent {
  return { type, payload } as UiEvent;
}
