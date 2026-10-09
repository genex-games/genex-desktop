/**
 * The harness → host RPC contract: every method `StudioCore.api()` serves to the agent-editable
 * harness (`ctx.call(method, params)`), with the params it takes and the result it answers.
 *
 * `StudioCore.api()` is typed as {@link HarnessHostHandlers}, so a handler that reads a field its
 * params do not declare, or answers something its result does not describe, fails the typecheck.
 * The harness is plain JavaScript and is copied, not imported: its calls are held to the same
 * method names by `tests/conformance/rpc-surface.test.ts`, and its params — for every method that
 * names a file, a folder or a game folder — by {@link HARNESS_PARAM_SCHEMAS}, which
 * `substrate/harness-host.ts` checks before a message reaches its handler.
 *
 * The schemas complement the host's own containment; they never replace it. A path that passes
 * here is still resolved by realpath and refused outside its root by the handler.
 */
import { z } from "zod";
import type { AgentScreenFrame } from "./agent-screen.ts";
import type { ContextSettings } from "./context.ts";
import type { CompletionProvenance } from "./custom-events.ts";
import type { EngineDescriptor } from "./engine-descriptor.ts";
import type {
  CompleteResponse,
  DelegateCaptureGrant,
  DelegateDirectorGrant,
  DelegateImage,
  DelegateOwnership,
  DelegatePlaytestGrant,
  DelegateResult,
  LiveToolResult,
  LiveToolSpec,
  SteerMessage,
  StudioToolSpec,
  ToolDefinition,
} from "./engine-requests.ts";
import type { ComputerTraceSummary } from "./computer-target.ts";
import type { ConversationRecord, EventData, EventEnvelope, Message, SnapshotRecord } from "./event-log.ts";
import type { ProjectAssets } from "./game-assets.ts";
import type {
  AttachReport,
  ContentStamps,
  ContractWord,
  ExportResult,
  GameProject,
  ProjectRecent,
} from "./game-project.ts";
import type { McpLiveTool } from "./mcp.ts";
import type { SteerDelivery } from "./message-queue.ts";
import type { ModelPreferences } from "./model-preferences.ts";
import type { OptimizationCandidate, ProfileRequest, Revision } from "./optimization.ts";
import type { PluginTool } from "./plugins.ts";
import type {
  BuildObservation,
  CaptureSurface,
  CropRect,
  PixelDiff,
  PixelStats,
  PreviewConsoleEntry,
  PreviewInputAction,
  PreviewPixelStats,
  PreviewPortStatus,
  ReadyResult,
} from "./preview-contract.ts";
import type { ReferenceFrame } from "./protocol.ts";
import type { HardwareReport, StudioSettingsView } from "./studio-api.ts";
import type { StudioActivityItem } from "./studio-activity.ts";

/** Budget class of a completion or delegation; anything but `improvement` is user work. */
export const WorkClass = {
  User: "user",
  Improvement: "improvement",
} as const;
export type WorkClass = (typeof WorkClass)[keyof typeof WorkClass];

// The seed's generated types/host-api.d.ts has always exported this name, and harness code the
// in-app agent wrote may import it: it stays beside WorkClass rather than replacing it.
/** Budget class of a completion or delegation; anything but `improvement` is user work. */
export type HarnessWorkClass = WorkClass;

/** A snapshot's reach: the harness workspace, the game, or both. */
export type HarnessSnapshotScope = "harness" | "game" | "both";

/**
 * Where a self-edit tried in a validation fork stopped: the change itself was refused (a path that
 * is not the harness's own), it added type errors, the type check ran out of time, the copy did
 * not boot, or the check could not run at all (no compiler in this build) — which refuses too.
 */
export type SelfEditStage = "refused" | "types" | "timeout" | "boot" | "unavailable";

/** `guardian.validate_edit`'s answer: what passed, or where it stopped and why, as bounded text. */
export type SelfEditVerdict = { ok: true; checked: string[] } | { ok: false; stage: SelfEditStage; message: string };

/** What `guardian.write_self` did: the change written between two host snapshots, or why not. */
export type SelfWriteResult =
  | { ok: true; file: string; snapshotId: string; postSnapshotId: string; checked: string[] }
  | { ok: false; stage: SelfEditStage; message: string };

/** An image the harness reads from a game folder: the bytes decide the type, never the extension. */
export interface GameImageRead {
  kind: "image";
  mimeType: string;
  data: string;
  bytes: number;
  file: string;
}

/** A stills source for `preview.pair`: inline bytes, or a path under the studio's runs. */
export interface StillSource {
  base64?: string;
  path?: string;
}

/**
 * `run.exec`'s answer as it crosses the pipe (`substrate/spawn.ts` `RunResult`): the signal is
 * whatever name the process died of.
 */
export interface ExecResult {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
  sandboxed: boolean;
  command: string;
  cwd: string;
}

/** What `engine.complete` takes: a completion request's serializable half plus the routing fields. */
export interface HarnessCompleteParams {
  messages: Message[];
  model?: string;
  systemPrompt?: string;
  tools?: ToolDefinition[];
  maxTokens?: number;
  temperature?: number;
  effort?: string;
  preferences?: ModelPreferences;
  timeoutMs?: number;
  /** Direct engine id; `ollama` when omitted. */
  engine?: string;
  /** `false` is a reviewer's call: no stream to the chat and no stream events. */
  stream?: boolean;
  threadId?: string;
  class?: HarnessWorkClass;
  toolRegistryRevision?: number;
  /** Who asked and why, for the call's `completion_call` record only: never sent to the model. */
  provenance?: CompletionProvenance;
}

/** What `engine.delegate` takes: a delegation's serializable half plus the routing fields. */
export interface HarnessDelegateParams {
  coordinator?: { runId: string; messageId?: string };
  /**
   * The chat's own session after a run it led: the run's controls it keeps (`run_status`,
   * `show_build`, `land_build`, shared/coordinator.ts `RunControl`), answered by the host for this
   * run and message as the coordinator's tools are. Honoured only for the chat's own session.
   */
  runControls?: { runId: string; messageId?: string };
  /**
   * This session is its chat's current turn: the message it answers. What the person sends
   * meanwhile can reach it (`engine.steer`); honoured only for the chat's own session, and for a
   * run's lead (a `director` session), whose turn is named by its run id instead.
   */
  chatTurn?: { messageId?: string };
  engine?: string;
  prompt: string;
  project: string;
  /** Build here instead of the live game folder — a facet worktree under scratch. */
  cwd?: string;
  threadId?: string;
  model?: string;
  effort?: string;
  preferences?: ModelPreferences;
  maxTurns?: number;
  timeoutMs?: number;
  resume?: string;
  /** Compact the `resume` session with its provider's own compaction instead of a turn (`EngineDescriptor.compactsNatively`). */
  compact?: boolean;
  extraReads?: string[];
  class?: HarnessWorkClass;
  /** A Loop chat's launch tool and `ask_user`, bridged to the contractor (MCP for Claude, the bridge for Codex). */
  interviewTools?: StudioToolSpec[];
  /** Builder eyes: capture-tool grant for the workspace this delegation builds in. */
  selfCapture?: DelegateCaptureGrant;
  /** Playtester hands: live preview tools over the build under test; implies read-only. */
  playtest?: DelegatePlaytestGrant;
  readOnly?: boolean;
  /** Stills into the builder's prompt. */
  images?: DelegateImage[];
  /** Edit-time ownership the engine enforces before a Write lands. */
  ownership?: DelegateOwnership;
  /** The computer: `false` withholds the builder's hands; default on with a capture grant. */
  computer?: boolean;
  /** The director: the run's orchestrating session, with the harness's run tools forwarded. */
  director?: DelegateDirectorGrant & { tools?: LiveToolSpec[] };
  candidateId?: string;
}

/**
 * Every method the host serves the harness: `params` is what `ctx.call` sends, `result` what the
 * call resolves to. A method that takes nothing has `void` params.
 */
export interface HarnessHostApi {
  // — assets —
  "assets.inventory": { params: { project: string }; result: ProjectAssets };
  "assets.checkpoint": {
    params: { project: string; runId: string; assetIds?: string[] };
    result: { revision: string; files: string[] };
  };

  // — event log —
  "events.append": { params: { threadId?: string; batch: EventData[] }; result: string };
  "events.list": { params: { threadId?: string; after?: string; limit?: number }; result: EventEnvelope[] };
  "events.head": { params: { threadId?: string }; result: string | null };
  "events.messages": { params: { threadId?: string }; result: Message[] };
  /**
   * The follow-up queue records of every conversation that still owes an answer (a message not
   * yet answered or removed) or holds its queue: what a boot restores its inbox from, instead of
   * reading every conversation's whole log. The records read exactly as the whole log would.
   */
  "events.inbox": { params: void; result: Array<{ threadId: string; events: EventEnvelope[] }> };
  "thread.main": { params: void; result: string };
  "thread.create": { params: { title?: string }; result: string };
  "thread.list": { params: void; result: ConversationRecord[] };
  "thread.fork": { params: { threadId: string; upToInclusive: string; title?: string }; result: string };
  "artifact.read": { params: { threadId?: string; artifactId: string }; result: unknown };
  "artifact.write": { params: { threadId?: string; artifactId: string; value: unknown }; result: number };

  // — turns —
  "turn.begin": {
    params: { threadId?: string; input?: Message[]; metadata?: Record<string, unknown> };
    result: { turnId: string; sessionId: string; head: string };
  };
  "turn.append": { params: { turnId: string; batch: EventData[] }; result: string };
  /** End a turn; `outcome` is how the loop ended it (a TurnStop code), kept on its `turn_ended`. */
  "turn.end": {
    params: { turnId: string; status?: "ok" | "error" | "cancelled"; outcome?: string };
    result: string | null;
  };

  // — optimization: registered, isolated source authority —
  "optimization.baseline": {
    params: { project: string; snapshotId: string };
    result: { snapshotId: string; commit: string; tree: string };
  };
  "optimization.open": {
    params: { project: string; runId: string; baselineSnapshotId: string };
    result: OptimizationCandidate;
  };
  "optimization.freeze": {
    params: { candidateId: string };
    result: { diff: string; changedFiles: string[]; revision: Revision };
  };
  "optimization.promote": {
    params: { candidateId: string; expectedLive: Revision; verifiedCandidate: Revision; resultArtifact: string };
    result: { outcome: string; revision: Revision; reason: string | null };
  };
  "optimization.reconcile": {
    params: { project: string; baseline: Revision; candidate: Revision | null };
    result: { revision: Revision; retained: string };
  };
  "optimization.close": { params: { candidateId: string }; result: { closed: boolean } };

  // — snapshots —
  "snapshot.create": {
    params: { scope?: HarnessSnapshotScope; reason: string; project?: string; healthy?: boolean };
    result: SnapshotRecord;
  };
  "snapshot.restore": {
    params: {
      snapshotId: string;
      project?: string;
      reason?: string;
      /** Narrows the restore below what the record captured, e.g. game-only from a "both" snapshot. */
      scope?: HarnessSnapshotScope;
    };
    result: boolean;
  };
  "snapshot.list": { params: void; result: SnapshotRecord[] };
  "snapshot.markHealthy": { params: { snapshotId: string }; result: boolean };
  "snapshot.diff": { params: { workspace?: string; from: string; to?: string }; result: string };
  /** A detached, playable, sandbox-writable fork of a game under scratch, at `commit` or the live HEAD. */
  "snapshot.worktree": {
    params: { project: string; commit?: string; name: string; runId?: string };
    result: { path: string; commit: string };
  };
  "snapshot.removeWorktree": { params: { project: string; path: string }; result: boolean };

  // — plugins and connectors —
  "plugins.preflightMultiplayer": {
    params: { project: string; threadId?: string };
    result: { ready: boolean; reason: string; hostedVerified: false };
  };
  "plugins.tools": { params: void; result: { tools: PluginTool[]; guidance: string; revision: number } };
  /** What this game's builders can use, for a conversation that cannot call it (the local coordinator). */
  "capabilities.describe": { params: { threadId: string; project?: string }; result: string };
  "plugins.invoke": {
    params: { project: string; threadId?: string; name: string; args: Record<string, unknown> };
    result: unknown;
  };
  "mcp.tools": {
    params: { project?: string | null };
    result: { tools: McpLiveTool[]; guidance: string; revision: number };
  };
  "mcp.invoke": {
    params: { project: string; threadId?: string; name: string; args?: Record<string, unknown> };
    result: LiveToolResult;
  };

  // — sandboxed execution —
  "run.exec": {
    params: { command: string; cwd?: string; project?: string; timeoutMs?: number; label?: string };
    result: ExecResult;
  };

  // — engines —
  "engine.describe": { params: void; result: EngineDescriptor[] };
  "studio.context": {
    params: void;
    result: {
      settings: StudioSettingsView;
      games: Array<{ name: string; title: string }>;
      recentActivity: StudioActivityItem[];
      pendingProposals: Array<{ skill: string; title?: string; summary?: string[]; rationale: string | undefined }>;
    };
  };
  "context.policy": { params: { engine: string; model?: string; threadId?: string }; result: ContextSettings };
  /** The Self-improvement switch, asked by the harness before each thing it would learn. */
  "learning.enabled": { params: void; result: boolean };
  "engine.complete": { params: HarnessCompleteParams; result: CompleteResponse };
  /** Stop: aborts a thread's completions, a project's delegations, or the delegation in one worktree. */
  "engine.abort": { params: { threadId?: string; cwd?: string; project?: string }; result: { aborted: number } };
  /** Steering that cannot wait (M3.4): cuts one worktree's build turn short so its caller can resume it. */
  "engine.interrupt": { params: { cwd: string }; result: { interrupted: boolean } };
  "engine.delegate": { params: HarnessDelegateParams; result: DelegateResult };
  /**
   * Steer: messages the person sent while the chat's turn works, into the session answering that
   * turn (`chatTurn` is `into`). `accepted` lists what the session took; `how` is how (`SteerDelivery`
   * in `shared/message-queue.ts`), null when it took nothing. `interrupt: false` takes them only
   * into a session that reads them mid-turn, and never cuts one short.
   */
  "engine.steer": {
    params: { threadId: string; into: string; messages: SteerMessage[]; interrupt?: boolean };
    result: { how: SteerDelivery | null; accepted: string[] };
  };
  "coordinator.tool": {
    params: { threadId: string; runId: string; messageId?: string; name: string; args?: Record<string, unknown> };
    result: string;
  };
  "engine.delegations": {
    params: void;
    result: Array<{ project: string; cwd: string; engine: string; startedAt: number }>;
  };
  "engine.hardware": { params: void; result: HardwareReport };

  // — games —
  "game.list": { params: void; result: GameProject[] };
  "game.setCover": { params: { project: string; threadId?: string } & Record<string, unknown>; result: string };
  /** Harnesses installed before recipes still author custom GLSL covers through this. */
  "game.setCoverShader": { params: { project: string; surface: string; threadId?: string }; result: LiveToolResult };
  /**
   * The folder's content stamp; `split` answers both stamps from one walk ({@link ContentStamps}).
   * A caller that does not ask gets the full stamp as a string, as before.
   */
  "game.contentStamp": { params: { project: string; split?: boolean }; result: string | ContentStamps | null };
  "game.recents": { params: void; result: ProjectRecent[] };
  "game.scaffold": { params: { name: string; title?: string; threadId?: string; kind?: string }; result: GameProject };
  "game.validate": {
    params: { project: string; candidateId?: string };
    result: { ok: boolean; problems: string[]; warnings: string[]; contract: ContractWord };
  };
  /** The live half of `game.validate`: serve the page, wait for it, ask what the hook got hold of. */
  "game.attached": {
    params: { project: string; root?: string; entry?: string; candidateId?: string };
    result: AttachReport;
  };
  /**
   * v2 contract upgrade: an older `src/studio.js` that is a copy the studio shipped gets the template's
   * copy, the old one kept beside it. An older copy anyone edited is left alone and answered with
   * `edited` and the `generation` it stays at; its `src/hud.js` stays with it.
   * `hud` is there when the game's `src/hud.js` was older than the template's: replaced (a shipped copy,
   * kept as `backup`) or left alone (an edited copy, or one beside a kept contract, still at `generation`).
   */
  "game.upgradeContract": {
    params: { project: string };
    result: {
      upgraded: boolean;
      reason?: string;
      materialsAdded?: boolean;
      backup?: string | null;
      edited?: boolean;
      generation?: number;
      hud?: { generation: number; replaced: boolean; backup?: string };
    };
  };
  "game.read": { params: { project: string; file: string; candidateId?: string }; result: string | GameImageRead };
  "game.write": {
    params: { project: string; file: string; contents: string; candidateId?: string };
    result: { bytes: number };
  };
  "game.tree": { params: { project: string; candidateId?: string }; result: string[] };
  "game.export": { params: { project: string; target?: string }; result: ExportResult };
  /** The stills in `<project>/references/`, sniffed and resized. */
  "game.references": {
    params: { project: string; max?: number; maxPx?: number };
    result: { frames: ReferenceFrame[]; skipped: Array<{ file: string; why: string }> };
  };

  // — preview (the senses): an omitted `handle` is the studio's stand-in for the live view (the
  // live view itself in a build with no hidden windows); only the person changes their Live —
  "preview.load": {
    params: {
      project: string;
      entry?: string;
      root?: string | null;
      handle?: string;
      candidateId?: string;
      revision?: Revision;
    };
    result: string;
  };
  "preview.profile": { params: ProfileRequest & { handle: string }; result: unknown };
  "preview.reload": { params: { handle?: string; retry?: boolean }; result: boolean };
  "preview.screenshot": {
    params: {
      quality?: number;
      runId?: string;
      label?: string;
      handle?: string;
      page?: boolean;
      surface?: CaptureSurface;
    };
    result: {
      base64: string;
      bytes: number;
      path: string | null;
      stats: PreviewPixelStats | null;
      surface: CaptureSurface | null;
    };
  };
  /** What the page holds outside the canvas: a DOM menu, an HTML HUD, a loader. */
  "preview.pageUi": { params: { handle?: string }; result: unknown };
  /**
   * `__studio.state()`, bounded by structure: over the studio's budget its largest lists become
   * `{__elided, length, chars}` stubs and the root names them under `__cut`. `keep` names the
   * dotted paths a board reads (at most 64, each up to 120 characters); they are cut last.
   */
  "preview.state": { params: { handle?: string; keep?: string[] }; result: unknown };
  "preview.call": { params: { method: string; arg?: unknown; handle?: string }; result: unknown };
  /** Read-only JS over the game's own graph; the answer is untrusted JSON, size-capped by the port. */
  "preview.evaluate": { params: { expression: string; handle?: string }; result: unknown };
  /** A `vision` check's crop, cut from a saved judged frame — never re-captured. */
  "preview.crop": {
    params: { runId: string; path: string; crop: CropRect; label?: string; handle?: string; quality?: number };
    result: { path: string; base64: string; bytes: number; width: number; height: number } | null;
  };
  /** Challenger against incumbent on one camera: diff fraction and heatmap. */
  "preview.diff": {
    params: { runId: string; a: string; b: string; label?: string; handle?: string };
    result: (PixelDiff & { heatmapPath: string | null }) | null;
  };
  /**
   * The `computer` tool, run by the host on a window the harness leased: the same tool every
   * session engine holds, for an engine whose tool loop is the harness's own (Ollama). `describe`
   * answers the tool's schema instead of running an action; otherwise `args` is one call.
   */
  "preview.computer": {
    params: DelegatePlaytestGrant & {
      handle: string;
      args?: Record<string, unknown>;
      describe?: boolean;
    };
    result: { tool: LiveToolSpec } | { answer: LiveToolResult; trace: ComputerTraceSummary };
  };
  "preview.input": {
    params: { actions?: PreviewInputAction[]; handle?: string };
    result: { ok: boolean; applied: number; width: number; height: number };
  };
  "preview.console": { params: { sinceMs?: number; handle?: string }; result: PreviewConsoleEntry[] };
  "preview.gpuErrors": { params: { handle?: string }; result: string[] };
  "preview.status": { params: { handle?: string }; result: PreviewPortStatus };
  /** Readiness is a fact the page reports, not a sleep. */
  "preview.ready": { params: { handle?: string; timeoutMs?: number; gesture?: boolean }; result: ReadyResult };
  /** A knock: the trusted click that grants user activation. */
  "preview.gesture": {
    params: { handle?: string; x?: number; y?: number; keys?: string[] };
    result: { knocked: boolean; trusted: boolean | null };
  };
  /** What the user's own window is showing right now: their game folder, or a build they chose to play. */
  "preview.showing": {
    params: void;
    result: { project: string; root: string | null; entry: string | undefined; loaded: string | null } | null;
  };
  "preview.observe": { params: { handle?: string }; result: BuildObservation };
  "preview.acquire": { params: { label?: string; purpose?: "optimization" }; result: { handle: string } };
  "preview.release": { params: { handle: string }; result: boolean };
  /**
   * One leased window at another size (the art director's 1600×900 look), for that lease only:
   * clamped to 320–1920 × 240–1200 and back at the facet size when the lease is released. Never
   * Live, the stand-in or a window a computer session plays in, so its view never changes size:
   * handing the lease to a session puts it back at the facet size, and the caller sizes it again
   * afterwards (`preview.status` `viewSize` says the size it is at now).
   */
  "preview.viewport": {
    params: { handle: string; width: number; height: number };
    result: { handle: string; width: number; height: number };
  };
  /** Pixel stats of an encoded still — the same numbers a capture yields. */
  "preview.statsOf": {
    params: { base64?: string; path?: string; handle?: string };
    result: { stats: PixelStats; width: number; height: number } | null;
  };
  /** LEFT | RIGHT composite of a reference still and a build frame. */
  "preview.pair": {
    params: { runId: string; left: StillSource; right: StillSource; label?: string; height?: number; handle?: string };
    result: { path: string; base64: string; bytes: number } | null;
  };
  "preview.screens": { params: void; result: AgentScreenFrame[] };
  "preview.capacity": {
    params: void;
    result: {
      max: number;
      inUse: number;
      free: number;
      live: boolean;
      headless: boolean;
      memory: { freeMb: number; totalMb: number };
    };
  };

  // — runs, guardian, ui —
  "run.artifact": { params: { runId: string; name: string; base64: string }; result: string };
  "guardian.rebuild_and_restart": { params: { reason: string }; result: { updateId: string; snapshotId: string } };
  /**
   * Try a change to the harness's own files in a validation fork before writing it: the fork is
   * type-checked (for code) and booted. Nothing live is touched; a pass lets the snapshot the
   * harness takes after writing the same code become healthy at once.
   */
  "guardian.validate_edit": { params: { files: Array<{ file: string; contents: string }> }; result: SelfEditVerdict };
  /**
   * The one way the harness changes one of its own files (`write_own_file`, `write_skill`,
   * `install_tool`): the host tries the change in a validation fork, snapshots before and after,
   * writes it, and records it where Activity and Undo read it. Prompts and skills are
   * write-denied to every agent process, so nothing else changes them. `title` and `summary` are
   * the plain words Activity shows for the change; the host bounds them.
   */
  "guardian.write_self": {
    params: { file: string; contents: string; reason: string; title?: string; summary?: string[] };
    result: SelfWriteResult;
  };
  /** A harness notification forwarded to the renderer as a `UiEvent`, name and payload as sent. */
  "ui.notify": { params: { type: string; payload?: unknown }; result: boolean };
}

export type HarnessHostMethod = keyof HarnessHostApi;
export type HarnessParams<K extends HarnessHostMethod> = HarnessHostApi[K]["params"];
export type HarnessResult<K extends HarnessHostMethod> = HarnessHostApi[K]["result"];

/** The handler table `StudioCore.api()` returns: one typed function per method. */
export type HarnessHostHandlers = { [K in HarnessHostMethod]: (params: HarnessParams<K>) => Promise<HarnessResult<K>> };

/**
 * Every host method, as call sites write it: `ctx.call(HostMethod.EventsList, { threadId })`. The
 * values are the wire names the harness sends: never rename one. `scripts/gen-harness-types.ts`
 * copies this object into the seed (`harness-seed/loop/host-methods.ts`).
 */
export const HostMethod = {
  AssetsInventory: "assets.inventory",
  AssetsCheckpoint: "assets.checkpoint",
  EventsAppend: "events.append",
  EventsList: "events.list",
  EventsHead: "events.head",
  EventsMessages: "events.messages",
  EventsInbox: "events.inbox",
  ThreadMain: "thread.main",
  ThreadCreate: "thread.create",
  ThreadList: "thread.list",
  ThreadFork: "thread.fork",
  ArtifactRead: "artifact.read",
  ArtifactWrite: "artifact.write",
  TurnBegin: "turn.begin",
  TurnAppend: "turn.append",
  TurnEnd: "turn.end",
  OptimizationBaseline: "optimization.baseline",
  OptimizationOpen: "optimization.open",
  OptimizationFreeze: "optimization.freeze",
  OptimizationPromote: "optimization.promote",
  OptimizationReconcile: "optimization.reconcile",
  OptimizationClose: "optimization.close",
  SnapshotCreate: "snapshot.create",
  SnapshotRestore: "snapshot.restore",
  SnapshotList: "snapshot.list",
  SnapshotMarkHealthy: "snapshot.markHealthy",
  SnapshotDiff: "snapshot.diff",
  SnapshotWorktree: "snapshot.worktree",
  SnapshotRemoveWorktree: "snapshot.removeWorktree",
  PluginsTools: "plugins.tools",
  PluginsPreflightMultiplayer: "plugins.preflightMultiplayer",
  CapabilitiesDescribe: "capabilities.describe",
  PluginsInvoke: "plugins.invoke",
  McpTools: "mcp.tools",
  McpInvoke: "mcp.invoke",
  RunExec: "run.exec",
  EngineDescribe: "engine.describe",
  StudioContext: "studio.context",
  ContextPolicy: "context.policy",
  LearningEnabled: "learning.enabled",
  EngineComplete: "engine.complete",
  EngineAbort: "engine.abort",
  EngineInterrupt: "engine.interrupt",
  EngineDelegate: "engine.delegate",
  EngineSteer: "engine.steer",
  CoordinatorTool: "coordinator.tool",
  EngineDelegations: "engine.delegations",
  EngineHardware: "engine.hardware",
  GameList: "game.list",
  GameSetCover: "game.setCover",
  GameSetCoverShader: "game.setCoverShader",
  GameContentStamp: "game.contentStamp",
  GameRecents: "game.recents",
  GameScaffold: "game.scaffold",
  GameValidate: "game.validate",
  GameAttached: "game.attached",
  GameUpgradeContract: "game.upgradeContract",
  GameRead: "game.read",
  GameWrite: "game.write",
  GameTree: "game.tree",
  GameExport: "game.export",
  GameReferences: "game.references",
  PreviewLoad: "preview.load",
  PreviewProfile: "preview.profile",
  PreviewReload: "preview.reload",
  PreviewScreenshot: "preview.screenshot",
  PreviewPageUi: "preview.pageUi",
  PreviewState: "preview.state",
  PreviewCall: "preview.call",
  PreviewEvaluate: "preview.evaluate",
  PreviewCrop: "preview.crop",
  PreviewDiff: "preview.diff",
  PreviewInput: "preview.input",
  PreviewComputer: "preview.computer",
  PreviewConsole: "preview.console",
  PreviewGpuErrors: "preview.gpuErrors",
  PreviewStatus: "preview.status",
  PreviewReady: "preview.ready",
  PreviewGesture: "preview.gesture",
  PreviewShowing: "preview.showing",
  PreviewObserve: "preview.observe",
  PreviewAcquire: "preview.acquire",
  PreviewRelease: "preview.release",
  PreviewViewport: "preview.viewport",
  PreviewStatsOf: "preview.statsOf",
  PreviewPair: "preview.pair",
  PreviewScreens: "preview.screens",
  PreviewCapacity: "preview.capacity",
  RunArtifact: "run.artifact",
  GuardianRebuildAndRestart: "guardian.rebuild_and_restart",
  GuardianValidateEdit: "guardian.validate_edit",
  GuardianWriteSelf: "guardian.write_self",
  UiNotify: "ui.notify",
} as const satisfies Record<string, HarnessHostMethod>;
export type HostMethod = (typeof HostMethod)[keyof typeof HostMethod];

// Every method of the contract has a member: a method added without one fails here.
type UnlistedHostMethod = Exclude<HarnessHostMethod, HostMethod>;
const hostMethodsAreListed: [UnlistedHostMethod] extends [never] ? true : { unlisted: UnlistedHostMethod } = true;
void hostMethodsAreListed;

// ── params schemas for the path-bearing methods ─────────────────────────────────────────────
//
// A path-bearing method names a file, a folder or a game folder (`project`). Each schema checks
// exactly those fields plus the identifiers they are joined with, and lets every other field
// through untouched: the handler receives the params as sent, never the parsed copy, so a call
// that passes behaves exactly as it did before the check existed. Optional fields accept `null`,
// which every handler already reads as "not given".

const text = z.string();
const optionalText = z.string().nullish();
const project = z.string();

/**
 * Engine control on a worktree (`engine.abort`, `engine.interrupt`) is deliberately absent: its
 * `cwd` is only a key into the running delegations, never opened, and the stop path must answer
 * whatever the harness sends.
 */
export const HARNESS_PARAM_SCHEMAS = {
  "assets.inventory": z.object({ project }),
  "assets.checkpoint": z.object({ project, runId: text }),
  "optimization.baseline": z.object({ project }),
  "optimization.open": z.object({ project, runId: text }),
  "optimization.promote": z.object({ candidateId: text, resultArtifact: text }),
  "optimization.reconcile": z.object({ project }),
  "snapshot.create": z.object({ project: optionalText }),
  "snapshot.restore": z.object({ project: optionalText }),
  "snapshot.diff": z.object({ workspace: optionalText }),
  "snapshot.worktree": z.object({ project, commit: optionalText, name: text, runId: optionalText }),
  "snapshot.removeWorktree": z.object({ project, path: text }),
  "capabilities.describe": z.object({ project: optionalText }),
  "plugins.invoke": z.object({ project }),
  "plugins.preflightMultiplayer": z.object({ project, threadId: optionalText }),
  "mcp.tools": z.object({ project: optionalText }).nullish(),
  "mcp.invoke": z.object({ project }),
  "run.exec": z.object({ cwd: optionalText, project: optionalText }),
  "engine.delegate": z.object({
    project,
    cwd: optionalText,
    extraReads: z.array(text).nullish(),
    selfCapture: z.object({ project, root: text, runId: optionalText, facetId: optionalText }).nullish(),
    playtest: z.object({ project, root: text, runId: optionalText, facetId: optionalText }).nullish(),
    director: z.object({ project, root: text, runId: text }).nullish(),
  }),
  "preview.computer": z.object({ project, root: text, handle: text, runId: optionalText, facetId: optionalText }),
  "game.setCover": z.object({ project }),
  "game.setCoverShader": z.object({ project }),
  "game.contentStamp": z.object({ project }),
  "game.scaffold": z.object({ name: text }),
  "game.validate": z.object({ project }),
  "game.attached": z.object({ project, root: optionalText, entry: optionalText }),
  "game.upgradeContract": z.object({ project }),
  "game.read": z.object({ project, file: text }),
  "game.write": z.object({ project, file: text }),
  "game.tree": z.object({ project }),
  "game.export": z.object({ project, target: optionalText }),
  "game.references": z.object({ project }),
  "preview.load": z.object({ project, entry: optionalText, root: optionalText }),
  "preview.crop": z.object({ runId: text, path: text }).nullish(),
  "preview.diff": z.object({ runId: text, a: text, b: text }).nullish(),
  "preview.statsOf": z.object({ path: optionalText }).nullish(),
  "preview.pair": z
    .object({
      runId: text,
      left: z.object({ path: optionalText }).nullish(),
      right: z.object({ path: optionalText }).nullish(),
    })
    .nullish(),
  "run.artifact": z.object({ runId: text, name: text }),
  "guardian.validate_edit": z.object({ files: z.array(z.object({ file: text, contents: text })) }),
  "guardian.write_self": z.object({
    file: text,
    contents: text,
    reason: text,
    // The plain words are bounded and cleaned by the host, so a messy line never refuses the change.
    title: z.unknown().optional(),
    summary: z.unknown().optional(),
  }),
} satisfies { [K in HarnessHostMethod]?: z.ZodType };

export type PathBearingMethod = keyof typeof HARNESS_PARAM_SCHEMAS;

function isPathBearing(method: string): method is PathBearingMethod {
  return Object.hasOwn(HARNESS_PARAM_SCHEMAS, method);
}

/** Why a harness call's params were refused: the method and one line per bad field. */
export interface HarnessParamsProblem {
  method: PathBearingMethod;
  message: string;
  issues: Array<{ path: string; message: string }>;
}

/**
 * Check a harness call's params before its handler runs. `null` means go ahead — the method is
 * not path-bearing, or its params have the shape the handler reads.
 */
export function harnessParamsProblem(method: string, params: unknown): HarnessParamsProblem | null {
  if (!isPathBearing(method)) return null;
  const checked = HARNESS_PARAM_SCHEMAS[method].safeParse(params);
  if (checked.success) return null;
  const issues = checked.error.issues.map((issue) => ({
    path: issue.path.map(String).join(".") || "params",
    message: issue.message,
  }));
  return {
    method,
    issues,
    message: `invalid params for ${method}: ${issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`,
  };
}
