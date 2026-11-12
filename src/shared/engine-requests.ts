/**
 * What an engine is asked and what it answers, as data: the serializable halves of a completion
 * and a delegation that cross the harness RPC (`shared/harness-api.ts`), and the answers the
 * harness reads back. `substrate/engines/types.ts` re-exports them and adds the parts that never
 * travel — callbacks, abort signals and the host-injected tool handlers.
 */
import type { Message, Usage } from "./event-log.ts";
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
  /** Genex's own tool, which an engine that defers tools loads with the prompt (Claude Code's `alwaysLoad`). */
  alwaysLoad?: boolean;
}

/** A live tool's number argument as a model sends it (a number, or a string of one); undefined otherwise. */
export function numberArg(value: unknown): number | undefined {
  const parsed = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : undefined;
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
}

/**
 * A Loop's lead: the chat's own session, in the game folder (`root`), with the run's tools. The host
 * honours its grant only for a `root` that is the game folder itself, for this game's own run started
 * in this chat, and hands the engine `root`'s checked real path (delegation.ts `#inPlaceRoot`).
 */
export interface DelegateDirectorGrant {
  runId: string;
  threadId: string;
  project: string;
  root: string;
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

/**
 * Who wrote a message into a session: the person, or Genex itself (a worker ended, a command's
 * result, the cover step). Each engine shows Genex's as not the person's words. Sent in requests:
 * never rename a value.
 */
export const MessageFrom = {
  Person: "person",
  Genex: "genex",
} as const;
export type MessageFrom = (typeof MessageFrom)[keyof typeof MessageFrom];
const MESSAGE_FROMS: ReadonlySet<unknown> = new Set(Object.values(MessageFrom));

/** Whether `value` names who wrote a message, in its exact wire spelling. */
export const isMessageFrom = (value: unknown): value is MessageFrom => MESSAGE_FROMS.has(value);

/** A message handed into the chat's turn while it works (steer): the person's, or Genex's own line. */
export interface SteerMessage {
  /** The queue's message id: what the delivery is recorded under. */
  id: string;
  text: string;
  images?: DelegateImage[];
  /** Who wrote it; absent means the person. */
  from?: MessageFrom;
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
  /**
   * The CLI refused the session before it did anything: the sandbox it asked for cannot run on this
   * computer (Claude Code's `failIfUnavailable`). No build exists, and another session on the same
   * engine would be refused the same way.
   */
  SandboxUnavailable: "sandbox_unavailable",
} as const;
export type StopReason = (typeof StopReason)[keyof typeof StopReason];

/**
 * Why the host refused a delegation before any engine ran (the error's `code`). Wire values: the
 * harness's copies are `DelegationRefusal` in `loop/director/lead-session.ts` (`FolderBusy`) and
 * `WorkerRefusal` in `loop/workers/contract.ts` (`TooManyWorkers`); never rename one.
 */
export const DelegationRefusal = {
  /** Another session is already working under the same lock (`delegation.ts` `#assertFolderFree`). */
  FolderBusy: "folder_busy",
  /** The chat already runs as many workers as the person's Settings allow. */
  TooManyWorkers: "too_many_workers",
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

/** A provider's limit a turn can end on. */
export type LimitKind = typeof EngineFailureKind.RateLimit | typeof EngineFailureKind.UsageLimit;

/** The limit a chat turn ended on, and when the provider said to try again. */
export interface TurnLimit {
  kind: LimitKind;
  retryAfterMs?: number;
}

/**
 * How a chat turn's delegated engine failed, as main adds it to the turn's `turn_ended` metadata:
 * the harness ends the turn and knows only the words. Persisted in the log: never rename a field.
 */
export interface TurnFailure {
  failure: EngineFailureKind;
  limit?: TurnLimit;
}

/**
 * Why a chat turn the harness ran threw, as `turn.end`'s `failure` names it and `turn_ended` keeps
 * it (`harnessFailure`): the seed's `TurnFailureCode` (`harness-seed/loop/turn-record.ts`), held to
 * this copy by `seed-contracts.test.ts`. Persisted in the log: never rename a value.
 */
export const TurnFailureCode = {
  /** The model's context cannot hold the turn's instructions and tools, whatever the history. */
  ContextTooSmall: "context_too_small",
  /** The conversation still does not fit the model's context after compaction. */
  ContextFull: "context_full",
  /** A host call the turn made failed (`method` names it). */
  HostCall: "host_call",
  /** A host call outlived its deadline (`method` names it). */
  HostDeadline: "host_deadline",
  /** The engine's call failed (its kind is on the turn's `completion_call`). */
  Engine: "engine",
  /** Anything else the harness's own code threw (`name` is its error's type). */
  Harness: "harness",
} as const;
export type TurnFailureCode = (typeof TurnFailureCode)[keyof typeof TurnFailureCode];

/** The error types a turn's failure may name: the built-in ones and the host's own; any other reads `other`. */
export const TurnErrorName = {
  Error: "Error",
  TypeError: "TypeError",
  RangeError: "RangeError",
  ReferenceError: "ReferenceError",
  SyntaxError: "SyntaxError",
  AbortError: "AbortError",
  SubstrateError: "SubstrateError",
  RpcDeadline: "RpcDeadline",
  InvalidParams: "InvalidParams",
  UnknownMethod: "UnknownMethod",
  Other: "other",
} as const;
export type TurnErrorName = (typeof TurnErrorName)[keyof typeof TurnErrorName];

/** What a failed chat turn says about why it failed: a code, the host call and the error's type, never its words. */
export interface HarnessTurnFailure {
  code: TurnFailureCode;
  /** The host method whose call failed (`HostMethod`'s wire name). */
  method?: string;
  name?: TurnErrorName;
}

const TURN_FAILURE_CODES: ReadonlySet<string> = new Set(Object.values(TurnFailureCode));
const TURN_ERROR_NAMES: ReadonlySet<string> = new Set(Object.values(TurnErrorName));

/** Is `value` one of the codes a turn's failure may name? */
export const isTurnFailureCode = (value: unknown): value is TurnFailureCode =>
  typeof value === "string" && TURN_FAILURE_CODES.has(value);

/** An error type as a turn's failure keeps it: one of `TurnErrorName`, else `other`; none without a name. */
export function turnErrorName(value: unknown): TurnErrorName | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  return TURN_ERROR_NAMES.has(value) ? (value as TurnErrorName) : TurnErrorName.Other;
}

/**
 * A turn failure from what the harness sent or the log kept, every field checked: a code of the
 * app's, a method `isMethod` knows and a known error type. Null when there is no usable code.
 */
export function harnessTurnFailure(value: unknown, isMethod: (method: string) => boolean): HarnessTurnFailure | null {
  if (value === null || typeof value !== "object") return null;
  const { code, method, name } = value as Record<string, unknown>;
  if (!isTurnFailureCode(code)) return null;
  const errorName = turnErrorName(name);
  const knownMethod = typeof method === "string" && isMethod(method);
  return { code, ...(knownMethod ? { method } : {}), ...(errorName ? { name: errorName } : {}) };
}

/** Is `kind` a provider's limit? */
export const isLimitKind = (kind: string): kind is LimitKind =>
  kind === EngineFailureKind.RateLimit || kind === EngineFailureKind.UsageLimit;

/** The failure a turn records for an engine failure of `kind`, with its limit when it was one. */
export function turnFailure(kind: EngineFailureKind, retryAfterMs?: number): TurnFailure {
  if (!isLimitKind(kind)) return { failure: kind };
  return { failure: kind, limit: { kind, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) } };
}

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
  /**
   * Genex tool calls the session made after its turn ended (a background task woke it), which no
   * answer could reach: by the name the agent called it by, without the server's prefix, and its
   * arguments as JSON.
   */
  cutAfterTurn?: Array<{ tool: string; args: string }>;
}
