import type { ModelPreferences } from "./model-preferences.ts";
/**
 * Substrate ↔ harness wire protocol.
 *
 * Newline-delimited JSON over stdio. Deliberately boring: the harness is the part of the system
 * the agent rewrites, so the channel it talks through must be something a broken self-edit cannot
 * corrupt in a confusing way — a bad line is dropped and reported, nothing more.
 *
 * **Why not a `utilityProcess`:** the original design
 * put the harness in an Electron `utilityProcess` talking over `parentPort`. It is instead a
 * child process spawned *through the sandbox primitive*, because the harness is agent-writable
 * code: a `utilityProcess` would run the agent's self-edits with the full authority of the app
 * (it could read `~/.ssh` or delete the user's files through plain `node:fs`), while a sandboxed
 * child inherits exactly the same containment as every other agent-originated process. Restart
 * semantics — hot-reload of self-edits, crash recovery — are unchanged.
 */

export interface RpcRequest {
  kind: "rpc";
  id: number;
  method: string;
  params: unknown;
}

export interface RpcResponse {
  kind: "rpc-result";
  id: number;
  ok: boolean;
  value?: unknown;
  error?: { message: string; name?: string; stack?: string; data?: Record<string, unknown> };
}

/** Harness → substrate: fire-and-forget stream events (chat deltas, status lines). */
export interface NotifyMessage {
  kind: "notify";
  type: string;
  payload?: unknown;
}

/** Harness → substrate: liveness ping; the watchdog's fast signal. */
export interface HeartbeatMessage {
  kind: "heartbeat";
  ts: number;
  /** What the harness believes it is doing, surfaced in the run report. */
  status?: string;
}

export interface ReadyMessage {
  kind: "ready";
  pid: number;
  /** mtime-based fingerprint of the loaded harness code — proves which "self" is running. */
  harnessVersion: string;
  /**
   * Names of dispatch features the loaded harness claims to handle. The harness is editable
   * code, so what it can do is a fact about the loaded self, not about the app: a copy that
   * predates a feature simply omits the name, and the host must not send it that work.
   */
  capabilities?: string[];
}

/** Substrate → harness: work to do. */
export interface DispatchMessage {
  kind: "dispatch";
  id: number;
  action: DispatchAction;
}

/** Composer Loop on a chat turn — hours from the stepper, stills the user dropped. */
export interface LoopCommission {
  hours: number;
  frames?: ReferenceFrame[];
}

/**
 * Composer Autopilot on a chat turn. Hours are the optional "stop after N hours" cap — absent
 * means run until the critics are satisfied (A2). Frames are the mood board.
 */
/** Who plans, builds and judges — one model id per job; `undefined`/"default" is the engine's own default. */
export interface RunRoles {
  /** Explicit reasoning per role; absent means that role model's own default. */
  efforts?: Partial<Record<"planner" | "builder" | "judge", string>>;
  planner?: string;
  builder?: string;
  judge?: string;
  /**
   * The other subscription, for the workers and/or the judges (cross-provider roles): the model
   * in that slot is then one of that engine's. Never the orchestrator, which is the run's engine.
   */
  engines?: { builder?: string; judge?: string };
}

export interface AutopilotCommission {
  hours?: number;
  frames?: ReferenceFrame[];
  /** The composer's roles panel: explicit orchestrator / workers / judges picks (harness-seed/loop/model-roles.ts). */
  roles?: RunRoles;
  /** Request host-owned explicit approval before execution (default off). */
  reviewPlan?: boolean;
}

/**
 * Who wrote a message the chat sends when the words are not the user's: the chat reporting how a
 * command the user ran from a reply went. The agent reads it; the transcript never draws it.
 * Recorded with the queued message: never rename a value.
 */
export const MessageOrigin = {
  CommandResult: "command-result",
} as const;
export type MessageOrigin = (typeof MessageOrigin)[keyof typeof MessageOrigin];
const MESSAGE_ORIGINS: ReadonlySet<unknown> = new Set(Object.values(MessageOrigin));

/** A queued message the chat wrote itself, which the transcript leaves out. */
export function isChatReport(action: Readonly<Record<string, unknown>> | undefined): boolean {
  return MESSAGE_ORIGINS.has(action?.origin);
}

export type DispatchAction =
  | {
      type: "user_message";
      threadId: string;
      text: string;
      /** The queue records the message under this id (the composer's optimistic bubble). */
      messageId?: string;
      engine?: string;
      model?: string;
      effort?: string;
      preferences?: ModelPreferences;
      project?: string;
      newProject?: boolean;
      studioThread?: boolean;
      resume?: string;
      newRun?: boolean;
      /** Absolute folder this chat is pinned to — shown in the prompt so the model stops guessing. */
      projectDir?: string;
      /** Extra stills folders the user named; readable, not writable. */
      extraReads?: string[];
      /** Stills already loaded so the model sees pixels without hunting the disk. */
      stills?: ReferenceFrame[];
      /** How many of `stills` the composer attached (they come first); a rewind gives them back. */
      pickedImages?: number;
      /** Reference files this message saved in the game (relative paths); a rewind with files removes them. */
      references?: string[];
      /** Composer Loop: the chat may start an unattended build when the ask needs one. */
      loop?: LoopCommission;
      /** Composer Autopilot: the chat may launch a build that decomposes into facets and runs until satisfied. */
      autopilot?: AutopilotCommission;
      /** Words the chat wrote itself (a command's result); the queue keeps it and the transcript hides it. */
      origin?: MessageOrigin;
    }
  | { type: "compact"; threadId: string; engine?: string; model?: string }
  | { type: "cancel"; threadId?: string }
  | { type: "queue_message"; threadId: string; messageId: string; operation: "hold" | "edit" | "remove"; text?: string }
  | { type: "queue_resume"; threadId: string }
  /**
   * The chat was rewound (capability "rewind"). `frames`, when present, is the Loop mood board
   * the interview still has after it (null: none); absent, the board is untouched.
   */
  | { type: "rewind"; threadId: string; frames?: ReferenceFrame[] | null }
  | { type: "healthcheck" }
  /** Run the loop's deterministic self-test (the architect's bar); rejects with the first failure. */
  | { type: "selftest" }
  | { type: "run_start"; threadId: string; run: RunSpec; resume?: boolean }
  | { type: "run_stop"; runId: string }
  | { type: "autopilot_resume"; threadId: string; runId: string }
  /**
   * The director's tools: a live tool call from the run's director session, hosted
   * by the studio, forwarded to the harness that owns the workers, the judges and the merge.
   * Unlike every other dispatch this one answers with a value — the tool's result.
   */
  | { type: "director_tool"; runId: string; name: string; args: Record<string, unknown> }
  /**
   * A worker tool (`WorkerTool`) the chat's own session called during the chat turn `turn` (its
   * message id), forwarded to the harness's worker pool for that turn. Answers with the tool's result.
   */
  | { type: "worker_tool"; threadId: string; turn: string; name: string; args: Record<string, unknown> }
  | { type: "skillopt_start"; threadId: string; options?: Record<string, unknown> }
  | { type: "boot_notice"; notice: BootNotice };

/** The `type` of a dispatch action: the work the host hands the harness. Wire names: never rename one. */
export const DispatchActionType = {
  UserMessage: "user_message",
  Compact: "compact",
  Cancel: "cancel",
  QueueMessage: "queue_message",
  QueueResume: "queue_resume",
  Rewind: "rewind",
  Healthcheck: "healthcheck",
  Selftest: "selftest",
  RunStart: "run_start",
  RunStop: "run_stop",
  AutopilotResume: "autopilot_resume",
  DirectorTool: "director_tool",
  WorkerTool: "worker_tool",
  SkilloptStart: "skillopt_start",
  BootNotice: "boot_notice",
} as const satisfies Record<string, DispatchAction["type"]>;
export type DispatchActionType = DispatchAction["type"];

// Every action has a member: an action added to `DispatchAction` without one fails here.
type UnlistedAction = Exclude<DispatchActionType, (typeof DispatchActionType)[keyof typeof DispatchActionType]>;
const actionsAreListed: [UnlistedAction] extends [never] ? true : { unlisted: UnlistedAction } = true;
void actionsAreListed;

/**
 * The dispatch features a loaded harness can claim in its ready message (`ReadyMessage.capabilities`,
 * the seed's `loop/main.ts`). The host checks one before it hands that work over. Wire names.
 */
export const HarnessCapability = {
  Loop: "loop",
  Autopilot: "autopilot",
  RunStart: "run.start",
  RunStop: "run.stop",
  Skillopt: "skillopt",
  Compact: "compact",
  Selftest: "selftest",
  Scoreboard: "scoreboard",
  Coordinator: "coordinator",
  Director: "director",
  MessageQueue: "message-queue",
  Rewind: "rewind",
  /** A message sent while the chat's own turn works joins that turn (`engine.steer`). */
  Steer: "steer",
  /** The chat's own session may run workers: the harness answers `worker_tool` for its turn. */
  Workers: "workers",
  /** A build whose jobs cross to or from a completion-only local engine (`crossesCompletionEngine`). */
  LocalRoles: "local-roles",
} as const;
export type HarnessCapability = (typeof HarnessCapability)[keyof typeof HarnessCapability];

/** Where the harness child process is in its life, as the host tracks it. Wire values: never rename one. */
export const HarnessState = {
  Stopped: "stopped",
  Starting: "starting",
  Ready: "ready",
  Restarting: "restarting",
  Failed: "failed",
} as const;
export type HarnessState = (typeof HarnessState)[keyof typeof HarnessState];

/** Why the harness booted, as its {@link BootNotice} says. Persisted in the log: never rename a value. */
export const BootReason = {
  ColdStart: "cold_start",
  SelfUpdate: "self_update",
  WatchdogRestore: "watchdog_restore",
  CrashRestart: "crash_restart",
} as const;
export type BootReason = (typeof BootReason)[keyof typeof BootReason];

/** What the reborn agent is told about its own restart — read from the log, not from us. */
export interface BootNotice {
  reason: BootReason;
  updateId?: string;
  snapshotId?: string;
  detail?: string;
  /**
   * Runs the incarnation that just died was in the middle of. Nothing can judge or commit them
   * any more — the host aborted every contractor the moment the child exited — so the reborn
   * loop owes each one an ending in its own thread. Absent on a cold start: the app repairs the
   * log itself before the harness wakes (StudioCore#closeInterruptedWork).
   */
  openRuns?: string[];
}

/** A still of the named title the critic compares against. */
export interface ReferenceFrame {
  label: string;
  mimeType: string;
  /** Raw bytes as base64. */
  data: string;
}

export interface RunReference {
  name: string;
  /** Saved file paths (the morning-review timeline). */
  shots: string[];
  notes?: string;
  /**
   * "reference" is a real game to beat (the blind panel is the exit); "direction" is free text
   * to push toward — no panel, the run spends its whole budget iterating.
   */
  kind?: "reference" | "direction";
  /** Pixels the critic actually sees. Not written into the event log. */
  frames?: ReferenceFrame[];
}

/**
 * The studio's environment variable that picks the director's loop for a run that names none
 * (`RunSpec.directorLoop`): a shipped build's way back to the long turn, for one release.
 * The seed's copy is loop/director/wake-schedule.ts `DIRECTOR_LOOP_ENV`.
 */
export const DIRECTOR_LOOP_ENV = "STUDIO_DIRECTOR_LOOP";

/** The studio's own variables a run's harness reads; nothing else of its environment is handed on. */
const HARNESS_RUN_ENV = [DIRECTOR_LOOP_ENV] as const;

/**
 * What of the studio's own environment the harness it spawns is handed: the run overrides it
 * reads, each when it is set. The harness's environment is an allow-list, so without this an
 * override never reached the runs the harness starts from chat.
 */
export function harnessRunEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const handed: Record<string, string> = {};
  for (const name of HARNESS_RUN_ENV) {
    const value = env[name]?.trim();
    if (value) handed[name] = value;
  }
  return handed;
}

export interface RunSpec {
  runId: string;
  goal: string;
  project: string;
  /** "autopilot" decomposes into facet loops; absent = the plain gauntlet. */
  mode?: "autopilot";
  /**
   * The programmed pipeline on purpose: planner → base → facet loops → merge. A
   * delegated engine's Autopilot is otherwise the director's — one session that decides the run.
   */
  classic?: boolean;
  /**
   * How a director's session is driven. "wake" (absent): the lead ends its turn after each
   * decision and the harness wakes the same session with a digest when something happens.
   * "turn": the long turn before the wake loop, with `wait` and continuation prompts — kept for
   * one release, set by rigs and dev dispatches; a run that names none follows
   * `DIRECTOR_LOOP_ENV` in the studio's environment.
   */
  directorLoop?: "wake" | "turn";
  /**
   * gauntlet reference bar — Named / Fetchable / Comparable. `kind` widens it:
   * "reference" is a real game to beat (the blind panel is the exit condition); "direction" is
   * free text to push toward — no reference panel. Completion is controlled by budgets.
   */
  reference: RunReference;
  /** observationDelays: backoff (ms) before re-trying a blind camera — a test/ops knob. */
  budgets: {
    wallClockMs: number;
    /** The composer's ∞: run until the judge is satisfied; `wallClockMs` is then only the safety ceiling. */
    untilSatisfied?: boolean;
    /** Explicit intent; absent records retain legacy untilSatisfied semantics. */
    completionPolicy?: "goal" | "duration";
    maxIterations?: number;
    observationDelays?: number[];
    /** v2 loop knobs: the pre-evidence code review (default on) and its model half (default on for delegated engines). */
    review?: boolean;
    modelReview?: boolean;
  };
  engine?: string;
  /** The builders' model. Arrives as the composer's pick; the harness resolves it at launch. */
  model?: string;
  /** The builders' engine, only when it is not the run's own (stamped from `roles.engines.builder`). */
  builderEngine?: string;
  judgeEngine?: string;
  judgeModel?: string;
  /**
   * Who plans, builds and judges — stamped by the harness at launch from the pick
   * (harness-seed/loop/model-roles.ts). `undefined` in a slot is the engine's own default.
   */
  roles?: RunRoles;
  /** Set once the harness has applied `roles` to `model`/`judgeModel` (a resume must not resolve twice). */
  rolesApplied?: boolean;
  /** The composer's "review the plan before building" tick; the harness writes it onto the run (loop/main.ts) and the director holds its first worker for the user's go. */
  reviewPlan?: boolean;
}

export type HarnessToHost =
  | RpcRequest
  | NotifyMessage
  | HeartbeatMessage
  | ReadyMessage
  | { kind: "dispatch-result"; id: number; ok: boolean; error?: string; value?: unknown };
export type HostToHarness = RpcResponse | DispatchMessage | { kind: "shutdown"; graceMs: number };

/** Split a stdio chunk stream into complete JSON messages. */
export class LineCodec {
  #parts: string[] = [];
  readonly #onError: (line: string, err: Error) => void;

  constructor(onError: (line: string, err: Error) => void = () => {}) {
    this.#onError = onError;
  }

  push<T>(chunk: string): T[] {
    const out: T[] = [];
    let start = 0;
    let index: number;
    while ((index = chunk.indexOf("\n", start)) >= 0) {
      this.#parts.push(chunk.slice(start, index));
      const line = this.#parts.join("").trim();
      this.#parts = [];
      start = index + 1;
      if (!line) continue;
      try {
        out.push(JSON.parse(line) as T);
      } catch (err) {
        this.#onError(line, err as Error);
      }
    }
    if (start < chunk.length) this.#parts.push(chunk.slice(start));
    return out;
  }
}

export function encode(message: unknown): string {
  return `${JSON.stringify(message)}\n`;
}
