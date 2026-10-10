/**
 * What an engine is asked and what it answers, as data: the serializable halves of a completion
 * and a delegation that cross the harness RPC (`shared/harness-api.ts`), and the answers the
 * harness reads back. `substrate/engines/types.ts` re-exports them and adds the parts that never
 * travel — callbacks, abort signals and the host-injected tool handlers.
 */
import type { Message, Usage } from "./event-log.ts";
import type { ComputerTraceSummary } from "./computer-target.ts";
import type { PreviewSetup } from "./preview-contract.ts";

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema. pi-ai types this as typebox's TSchema, which is a JSON Schema at runtime. */
  parameters: Record<string, unknown>;
}

export interface CompleteResponse {
  /** Assistant message (with any tool calls), ready to be appended to the log verbatim. */
  message: Message;
  usage: Usage;
  stopReason: string;
  model: string;
  engine: string;
}

/**
 * What a live tool answers: text, and for the computer tool's screenshot/zoom the picture
 * itself — an MCP result carries image blocks; the Codex bridge prints the saved path.
 */
export type LiveToolResult =
  | string
  | {
      text: string;
      images?: Array<{ mimeType: string; data: string; label?: string }>;
      /** The call failed: an engine that marks failures tells the model so. */
      isError?: boolean;
    };

/** A studio tool in the flat shape a delegated engine exposes: string-typed properties only. */
export interface StudioToolSpec {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, { type: string; description?: string }>;
    required?: string[];
  };
}

/** A live studio tool: the flat projection, plus the real schema when the flat one cannot say it. */
export interface LiveToolSpec extends StudioToolSpec {
  /**
   * The tool's real JSON Schema, when it has one the flat `parameters` cannot express — an MCP
   * connector's arrays, enums, integers and nested objects. Authoritative when present;
   * `parameters` stays the flat projection every older consumer still reads. Studio's own live
   * tools and plugin tools are flat and never set it.
   */
  inputSchema?: Record<string, unknown>;
}

/** Builder eyes: the serializable capture grant for the workspace a delegation builds in. */
export interface DelegateCaptureGrant {
  project: string;
  root: string;
  runId?: string;
  facetId?: string;
  iteration?: number;
  handle?: string;
  entry?: string;
  setup?: PreviewSetup | null;
  label?: string;
  /** The worker's own cameras: what a capture that names none photographs (every registered camera when absent). */
  cameras?: string[];
}

/** Playtester hands: the serializable half of the live preview tools over the build under test. */
export interface DelegatePlaytestGrant {
  project: string;
  root: string;
  runId?: string;
  facetId?: string;
  iteration?: number;
  handle?: string;
  entry?: string;
  setup?: PreviewSetup | null;
  /** A `judge` plays blind (no files, no shell) on a stepped clock, with only the `computer` tool. */
  role?: "playtester" | "scout" | "judge";
  label?: string;
  /** A goal the studio checks after every move; the first time it holds is studio-verified. */
  quest?: { id: string; until: NonNullable<PreviewSetup["verify"]> };
  /** The most moves (input actions, waits, batch steps) the session may make, counted by the host. */
  maxActions?: number;
  /** How the build's clock is held between moves: wall-time pacing, or seeded exact steps. */
  pacing?: "paced" | "stepped";
}

/**
 * The director's session: the run's integration worktree it orchestrates from (`root`). A waking
 * run's lead sits in the game folder instead and leads `root`, leaving the game's changes to its
 * workers: the host honours its grant only with `readOnly`, for this game's own run, and hands the
 * engine `root`'s checked real path (delegation.ts `#leadRoot`).
 */
export interface DelegateDirectorGrant {
  runId: string;
  threadId: string;
  project: string;
  root: string;
  setup?: PreviewSetup | null;
  /**
   * The lead IS its chat's own session (one session): the session it answers with becomes the
   * chat's bookmark (`contractor`), so the chat goes on in it after the run. Honoured only for a
   * lead in its game's folder.
   */
  chatSession?: boolean;
}

/** A still that goes into the builder's prompt as an image block. */
export interface DelegateImage {
  label: string;
  mimeType: string;
  data: string;
}

/** A message the person sent while the chat's turn works, handed into that turn (steer). */
export interface SteerMessage {
  /** The queue's message id: what the delivery is recorded under. */
  id: string;
  text: string;
  images?: DelegateImage[];
}

/**
 * Edit-time file ownership: the engine blocks Write/Edit outside `owns` (plus the facet's notes
 * and the wiring line of src/main.js) before the edit lands. See `DelegateRequest.ownership`.
 */
export interface DelegateOwnership {
  facetId: string;
  owns: string[];
  ownsMain: boolean;
  main?: string;
  studio?: string;
  template?: boolean;
  neverLock?: string[];
}

/**
 * Why a delegated build ended (`DelegateResult.stopReason`). A vendor's own subtype (such as
 * `error_max_turns`) may also arrive, so the field stays a string. Recorded in logs: never rename a value.
 */
export const StopReason = {
  Completed: "completed",
  /** The user stopped it. */
  Stopped: "stopped",
  /** Its time budget ran out. */
  Deadline: "deadline",
  Error: "error",
  /** The model's output hit its length limit. */
  Length: "length",
  ContextOverflow: "context_overflow",
  NoProgress: "no_progress",
  MaxTurns: "max_turns",
  Aborted: "aborted",
} as const;
export type StopReason = (typeof StopReason)[keyof typeof StopReason];

/**
 * Why the host refused a delegation before any engine ran (the error's `code`). Wire values: the
 * harness's copy is `DelegationRefusal` in `loop/director/lead-session.ts`; never rename one.
 */
export const DelegationRefusal = {
  /** Another session is already working under the same lock (`delegation.ts` `#assertFolderFree`). */
  FolderBusy: "folder_busy",
} as const;
export type DelegationRefusal = (typeof DelegationRefusal)[keyof typeof DelegationRefusal];

/** How an engine call failed (`EngineError.kind`); the harness reacts to each by policy. */
export const EngineFailureKind = {
  RateLimit: "rate_limit",
  /** A subscription cap (weekly/session) that no in-run wait can outlive — end the run, don't retry. */
  UsageLimit: "usage_limit",
  Auth: "auth",
  Unavailable: "unavailable",
  ContextThreshold: "context_threshold",
  ContextOverflow: "context_overflow",
  Aborted: "aborted",
  /** A completion outlived its ceiling. Distinct from "aborted": nobody asked for this stop. */
  Timeout: "timeout",
  Other: "other",
} as const;
export type EngineFailureKind = (typeof EngineFailureKind)[keyof typeof EngineFailureKind];

/** Did the call fail because the session's context is full (or past its compaction threshold)? */
export function isContextFailure(kind: string): boolean {
  return kind === EngineFailureKind.ContextThreshold || kind === EngineFailureKind.ContextOverflow;
}

export interface DelegateResult {
  requestedModel?: string;
  cliVersion?: string;
  cliPath?: string;
  ok: boolean;
  summary: string;
  usage: Usage;
  turns: number;
  engine: string;
  /** The model that actually ran, as the contractor reported it — not just what was asked for. */
  model?: string;
  durationMs?: number;
  /** Why a not-ok build ended: "stopped" (user), "deadline" (time budget), or the vendor's own subtype (e.g. error_max_turns). */
  stopReason?: string;
  /** Vendor session id — what `resume` takes to continue exactly where this build ended. */
  sessionId?: string;
  /** "subscription" usage is prepaid quota — cost_usd is then API-equivalent, not a bill. */
  billing?: "subscription" | "api";
  /** The vendor's own words for a not-ok ending, for the chat message. */
  errorText?: string;
  /** Calls the contractor made to `interviewTools`, in order — the harness executes them for real. */
  studioToolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
  /** Steered messages the session read (`DelegateRequest.steer`), by id, in the order it read them. */
  steered?: string[];
  /**
   * How many tokens the session's last request sent, as the provider counted them: what its next
   * turn starts from. Absent when the provider reported none, or compacted after its last request.
   */
  contextTokens?: number;
  /** A `compact` delegation compacted the session, which goes on under the same id. */
  compacted?: boolean;
  /** A playtest's or judge's computer trace: where it was written, and whether its goal was verified. */
  trace?: ComputerTraceSummary;
}
