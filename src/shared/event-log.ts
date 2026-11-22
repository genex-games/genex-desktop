/**
 * Event log schema: the contract the substrate writes, the harness reads over RPC and the
 * renderer reads through `window.studio`. `substrate/types.ts` re-exports these types next to the
 * store's own errors, so substrate code keeps importing them from there.
 *
 * The envelope is bit-compatible with Exo's `crates/exoharness/src/types.rs` event record so
 * that upstream Exo stays a living reference and cross-validation target (§12.2):
 *
 *   { id, thread_id, session_id, turn_id, created_at, data }
 *
 * `conversation_id` is accepted as an alias on read (Exo's serde alias) and never written.
 *
 * Deviation from Exo, documented in the plan: Exo's `sandbox_*` (Docker) event family is
 * replaced by the workspace family — `snapshot_created` / `workspace_restored` — because D7
 * makes git the snapshot engine. Everything else keeps Exo's kind names, including using
 * `custom { event_type: "rebuild_and_restart_studio" }` for guardian outcomes.
 */

export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

/** A still the model should look at — JPEG/PNG/WebP bytes, never a file path. */
export interface MessageImage {
  mimeType: string;
  /** Raw bytes as base64. */
  data: string;
  /** Short caption for the accompanying text ("BUILD A / close"). */
  label?: string;
}

export interface Message {
  role: Role;
  content: string;
  /** User messages may attach pixels. Omitted from logged conversation; used on one-shot judge calls. */
  images?: MessageImage[];
  /** Assistant messages may carry tool calls. */
  tool_calls?: ToolCall[];
  /** Tool messages carry the id of the call they answer. */
  tool_call_id?: string;
  /** A tool message whose call failed: engines that mark failures tell the model so. */
  is_error?: boolean;
  /** Optional reasoning trace (kept out of the prompt by default). */
  reasoning?: string;
  name?: string;
}

/**
 * What one engine call used. The token fields are the session's main loop (Claude's
 * `result.usage`, per turn and added up; a Codex turn's usage); every other model it called is in
 * `by_model`. `output_tokens` counts everything the model produced, its reasoning included, so
 * `reasoning_tokens` is a part of it and is never added again. `input_tokens` keeps the
 * provider's own meaning: Anthropic's excludes cache reads, Codex's (OpenAI's) includes them.
 * A figure the provider did not report is absent, never zero.
 */
export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  /** Thinking or reasoning tokens, already counted inside `output_tokens`. */
  reasoning_tokens?: number;
  cost_usd?: number;
  model?: string;
  engine?: string;
  /**
   * Every model the session called — main loop, subagents, compaction and auxiliary calls —
   * keyed by the id the CLI reported, as its running total (Claude's `modelUsage`).
   */
  by_model?: Record<string, ModelTokenUsage>;
  /** Time the provider's API spent answering, as the latest result reports it (Claude's `duration_api_ms`). */
  duration_api_ms?: number;
  /** Time to the first token of the session's first reply (Claude's `ttft_ms`). */
  ttft_ms?: number;
  /** Context compactions the session went through during this call. */
  compactions?: number;
}

/** One model's share of a session, in `Usage`'s units (a row of Claude's `modelUsage`). */
export interface ModelTokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  /** Thinking tokens, already inside `output_tokens`; absent when the CLI did not record them. */
  reasoning_tokens?: number;
  cost_usd?: number;
  context_window?: number;
}

/** What a snapshot covers: the game, the harness, or both. Persisted in records: never rename a value. */
export const SnapshotScope = {
  Game: "game",
  Harness: "harness",
  Both: "both",
} as const;
export type SnapshotScope = (typeof SnapshotScope)[keyof typeof SnapshotScope];

export interface SnapshotGitRefs {
  game?: string;
  harness?: string;
  /**
   * The branch a game snapshot was taken on (`refs/heads/…`), `null` when HEAD was detached,
   * absent on harness-only and older records. A game restore refuses when it moved.
   */
  gameBranch?: string | null;
}

/**
 * Whose engine call a `messages` record's `usage` reports, when the record says (`usage_source`).
 * `delegation`: a delegated chat turn's reply carrying its contractor's report, which the turn's
 * `build_observation` repeats when the turn built (`repeatedBuildUsages` in `eval-lane.ts`). The
 * seed writes it (`loop/delegated-turn.ts` holds the copy). Persisted: never rename a value.
 */
export const MessageUsageSource = {
  Delegation: "delegation",
} as const;
export type MessageUsageSource = (typeof MessageUsageSource)[keyof typeof MessageUsageSource];

/**
 * Which of Genex's own fixed chat lines a `messages` record says (`genex_line`), so the app shows
 * it in its own language while the record keeps the English the agents read. The seed writes it
 * (`loop/genex-lines.ts` holds the copy). Persisted: never rename a value.
 */
export const GenexLine = {
  Stopped: "stopped",
  StoppedWaiting: "stopped_waiting",
  StoppedBeforeTurn: "stopped_before_turn",
  StoppedBeforeBuild: "stopped_before_build",
  ModelOutOfMemory: "model_out_of_memory",
} as const;
export type GenexLine = (typeof GenexLine)[keyof typeof GenexLine];

export type EventData =
  | { type: "thread_created"; title?: string; metadata?: Record<string, unknown> }
  | { type: "thread_updated"; title?: string; metadata?: Record<string, unknown> }
  | { type: "thread_deleted" }
  | { type: "thread_forked"; source_thread_id: string; up_to_inclusive: string }
  | { type: "session_started"; metadata?: Record<string, unknown> }
  | { type: "session_ended"; reason?: string }
  | { type: "turn_started"; metadata?: Record<string, unknown> }
  | { type: "turn_ended"; status?: "ok" | "error" | "cancelled"; metadata?: Record<string, unknown> }
  | {
      type: "messages";
      messages: Message[];
      usage?: Usage;
      /** Whose engine call `usage` reports when it is not the chat's own: absent on the chat's own calls and older records. */
      usage_source?: MessageUsageSource;
      /** One of Genex's own fixed lines, by code: the app shows its own words for it. Absent on every other reply. */
      genex_line?: GenexLine;
    }
  | { type: "tool_requested"; tool_call_id: string; request: { name: string; arguments: unknown } }
  | {
      type: "tool_result";
      tool_call_id: string;
      result: { ok: boolean; content: string; details?: unknown };
    }
  | { type: "error"; message: string; details?: unknown }
  | { type: "artifact_written"; artifact_id: string; path: string; version: number }
  | {
      type: "snapshot_created";
      snapshot_id: string;
      scope: SnapshotScope;
      git: SnapshotGitRefs;
      healthy?: boolean;
      /** False when `healthy` vouches for the game half only (see `SnapshotRecord.harness_healthy`). */
      harness_healthy?: false;
      reason?: string;
    }
  | {
      type: "workspace_restored";
      snapshot_id: string;
      reason: string;
      scope: SnapshotScope;
      /** The rescue snapshot of the game folder, committed just before the folder was reset. */
      rescue_snapshot_id?: string;
    }
  | { type: "custom"; event_type: string; payload?: unknown };

/** The `type` of an event's `data`. Persisted in every log: never rename a value. */
export const EventKind = {
  ThreadCreated: "thread_created",
  ThreadUpdated: "thread_updated",
  ThreadDeleted: "thread_deleted",
  ThreadForked: "thread_forked",
  SessionStarted: "session_started",
  SessionEnded: "session_ended",
  TurnStarted: "turn_started",
  TurnEnded: "turn_ended",
  Messages: "messages",
  ToolRequested: "tool_requested",
  ToolResult: "tool_result",
  Error: "error",
  ArtifactWritten: "artifact_written",
  SnapshotCreated: "snapshot_created",
  WorkspaceRestored: "workspace_restored",
  Custom: "custom",
} as const satisfies Record<string, EventData["type"]>;
export type EventKind = EventData["type"];

// Every kind of event data has a member: a kind added to `EventData` without one fails here.
type UnlistedEventKind = Exclude<EventKind, (typeof EventKind)[keyof typeof EventKind]>;
const eventKindsAreListed: [UnlistedEventKind] extends [never] ? true : { unlisted: UnlistedEventKind } = true;
void eventKindsAreListed;

/** What a thread is for, as its `metadata.kind` records it. Persisted: never rename a value. */
export const ThreadKind = {
  /** The studio's own conversation. */
  Studio: "studio",
  /** A game's conversation, bound to its project (or waiting for one). */
  Game: "game",
} as const;
export type ThreadKind = (typeof ThreadKind)[keyof typeof ThreadKind];

export interface EventEnvelope {
  id: string;
  thread_id: string;
  session_id: string | null;
  turn_id: string | null;
  created_at: string;
  data: EventData;
}

export interface ConversationRecord {
  id: string;
  agent_id: string;
  created_at: string;
  updated_at: string;
  /** Optimistic-concurrency head. `null` until the first event lands. */
  latest_event_id: string | null;
  title?: string;
  /** Present on forks. */
  parent?: { thread_id: string; up_to_inclusive: string } | null;
  metadata?: Record<string, unknown>;
}

/**
 * One entry of the snapshot index (`substrate/snapshots.ts`): the commits a snapshot holds, plus —
 * for a game — the branch it was taken on (`SnapshotGitRefs.gameBranch`). It rides inside `git` so
 * the `snapshot_created` event carries it and a rebuilt index still has it.
 */
export interface SnapshotRecord {
  snapshot_id: string;
  scope: SnapshotScope;
  git: SnapshotGitRefs;
  created_at: string;
  reason: string;
  healthy: boolean;
  /**
   * False when `healthy` speaks for the game half only: a "both" snapshot of a won round holds a
   * harness nobody has booted yet, and the watchdog must not rewind to it (R2). Marking the
   * record healthy later (a restart, an inherited non-code diff) vouches for both halves.
   */
  harness_healthy?: false;
}
