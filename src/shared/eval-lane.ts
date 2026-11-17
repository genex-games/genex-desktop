/**
 * The eval lane contract the app and the eval scripts share: what an eval launch of the app is
 * asked to do (`EvalLaneSpec`, written by `scripts/evals` and read by `src/main/smoke/eval-lane.ts`)
 * and what it reports back (`EvalLaneReport`), plus the small vocabularies both sides spell
 * (how a run ended, which launch the agent chose, tool categories, token kinds), and the two token
 * counting rules the app's field rows and the eval collectors share (`normalizedTokens`,
 * `repeatedBuildUsages`). Browser-safe. The rest of the eval vocabulary lives in
 * `scripts/evals/vocabulary.ts`, which re-exports these. Persisted in lane reports and ledger rows:
 * never rename a value.
 */
import type { ComposerSendOptions } from "./composer.ts";
import { CustomEvent, type RecordedRunBudgets, customPayload } from "./custom-events.ts";
import { EventKind, type EventEnvelope, MessageUsageSource, type Usage } from "./event-log.ts";
import type { PermissionMode } from "./permissions.ts";
import { EngineId } from "./providers.ts";
import type { CompletionPolicy } from "./run-state.ts";

/** The schema id a lane report carries, so a reader can refuse another shape. */
export const EVAL_LANE_REPORT_SCHEMA = "genex-evals/lane-report/1";

/** How a run ended. Our rails are not the model's decision: only `agent-finished` is an ending. */
export const EndedHow = {
  AgentFinished: "agent-finished",
  OwnBudget: "own-budget",
  Deadline: "deadline",
  MaxTurns: "max-turns",
  Crash: "crash",
  RateLimited: "rate-limited",
  HarnessFailure: "harness-failure",
  Cancelled: "cancelled",
} as const;
export type EndedHow = (typeof EndedHow)[keyof typeof EndedHow];

/** Which launch the Loop chat chose for a Genex run: none (it built the game itself), or a timed or unattended run. */
export const LaunchPath = {
  None: "none",
  StartAutopilot: "start_autopilot",
  StartUnattendedRun: "start_unattended_run",
} as const;
export type LaunchPath = (typeof LaunchPath)[keyof typeof LaunchPath];

/** The one answer policy every lane applies to a question the agent asks. */
export const AnswerPolicy = {
  /** Questions are not answered; typed questions get the shared "make reasonable assumptions" sentence. */
  NoAnswers: "no-answers",
} as const;
export type AnswerPolicy = (typeof AnswerPolicy)[keyof typeof AnswerPolicy];

/**
 * The sentence each answer policy gives the agent, word for word: raw lanes get it up front in the
 * shared suffix, and a Genex lane sends it as the answer to a typed question (§5.2). Every lane's
 * flags digest hashes it, so changing a sentence changes every lane's pin.
 */
export const EVAL_LANE_ANSWER_TEXT = {
  [AnswerPolicy.NoAnswers]: "Nobody will answer questions; make reasonable assumptions and continue.",
} as const satisfies Record<AnswerPolicy, string>;

/** The typed questions a Genex lane can be asked and auto-answers. */
export const QuestionKind = {
  AskUser: "ask_user",
  PlanReview: "plan_review",
} as const;
export type QuestionKind = (typeof QuestionKind)[keyof typeof QuestionKind];

/** What a Genex lane served as its mode, read back from the build under test (D3), never hard-coded by the scheduler. */
export const LaneModeServed = {
  /** Loop on with no time limit: the chat decides whether to launch a build. */
  AutopilotUntilSatisfied: "autopilot-until-satisfied",
  /** Loop on with an hours cap. */
  AutopilotTimed: "autopilot-timed",
  /** Loop off: the chat answered and edited with its own hands only. */
  ChatOnly: "chat-only",
  /** A raw CLI lane: one agent doing everything. */
  RawCli: "raw-cli",
  /** A fixture lane's scripted engines. */
  Fixture: "fixture",
} as const;
export type LaneModeServed = (typeof LaneModeServed)[keyof typeof LaneModeServed];

/** The tool categories every lane's calls are counted in (Rule 17: commands pass through `unwrapShell` first). */
export const ToolCategory = {
  Read: "read",
  Search: "search",
  /** File edits, including writes made through the shell. */
  Edit: "edit",
  Shell: "shell",
  /** Build and test commands. */
  Build: "build",
  Install: "install",
  Browser: "browser",
  /** Studio's own MCP tools (`mcp__studio__*`). */
  Studio: "studio",
  Subagent: "subagent",
  Web: "web",
  Planning: "planning",
  Skill: "skill",
  /** A tool name the category table does not know, including an unknown MCP server's tools. */
  Other: "other",
} as const;
export type ToolCategory = (typeof ToolCategory)[keyof typeof ToolCategory];

/** The roles token counts are split by (`tokens.byRole`). */
export const TokenRole = {
  Lead: "lead",
  Workers: "workers",
  Judges: "judges",
  Subagents: "subagents",
  /** Models a CLI calls on its own, such as Claude Code's Haiku helper. */
  Auxiliary: "auxiliary",
} as const;
export type TokenRole = (typeof TokenRole)[keyof typeof TokenRole];

/**
 * The one normalized token shape for every lane (Rule 13). Codex's `input_tokens` includes cached
 * tokens and Anthropic's does not; the normalizers settle that before a row is written.
 */
export interface TokenUsage {
  uncachedInput: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  /** Thinking or reasoning tokens; counted inside `output` by some CLIs, never double-counted here. */
  reasoning: number;
}

/** A zero usage, the starting point of every sum. */
export const ZERO_TOKEN_USAGE: TokenUsage = { uncachedInput: 0, cacheWrite: 0, cacheRead: 0, output: 0, reasoning: 0 };

/** The token counts a usage record reports (an event log's `Usage`, a `by_model` row), in the provider's own meaning. */
export interface ReportedTokens {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  reasoning_tokens?: number;
}

/**
 * A usage record as the normalized shape (Rule 13), the one rule for the app and the eval
 * collectors: Codex's `input_tokens` holds its cache reads, so they are taken out; every other
 * engine's does not. An unreported count is 0.
 */
export function normalizedTokens(reported: ReportedTokens, engine: string | null | undefined): TokenUsage {
  const input = reported.input_tokens ?? 0;
  const cacheRead = reported.cache_read_tokens ?? 0;
  return {
    uncachedInput: engine === EngineId.Codex ? Math.max(0, input - cacheRead) : input,
    cacheWrite: reported.cache_write_tokens ?? 0,
    cacheRead,
    output: reported.output_tokens ?? 0,
    reasoning: reported.reasoning_tokens ?? 0,
  };
}

/** The counts a usage record may report, by their wire names. */
export const REPORTED_COUNTS = [
  "input_tokens",
  "cache_write_tokens",
  "cache_read_tokens",
  "output_tokens",
  "reasoning_tokens",
] as const satisfies ReadonlyArray<keyof ReportedTokens>;

const sameCounts = (a: Usage, b: Usage): boolean => REPORTED_COUNTS.every((key) => a[key] === b[key]);

/**
 * The `build_observation` records (by event id) whose `usage` repeats an engine call a `messages`
 * record of the same turn already carries: a delegated chat turn's reply holds its contractor's
 * report, and the turn's build record holds it again. Readers count that call once, from the
 * reply (the chat's call; it names the engine and model), and skip these build records' usage.
 *
 * A turn whose reply is marked `usage_source: delegation` repeats it in every build record that
 * reports usage. A turn with no marked reply (a seed from before the marker) pairs a build record
 * with an unmarked reply that reports the same five counts; records without a turn never pair.
 */
export function repeatedBuildUsages(events: readonly EventEnvelope[]): ReadonlySet<string> {
  const marked = new Set<string>();
  const replies = new Map<string, Usage[]>();
  for (const { turn_id: turn, data } of events) {
    if (turn === null || data.type !== EventKind.Messages || !data.usage) continue;
    if (data.usage_source === MessageUsageSource.Delegation) marked.add(turn);
    else replies.set(turn, [...(replies.get(turn) ?? []), data.usage]);
  }
  const repeated = new Set<string>();
  for (const { id, turn_id: turn, data } of events) {
    const usage = customPayload(data, CustomEvent.BuildObservation)?.usage;
    if (!usage || turn === null) continue;
    if (marked.has(turn) || replies.get(turn)?.some((reply) => sameCounts(reply, usage))) repeated.add(id);
  }
  return repeated;
}

/** Model calls, and tool calls by category, as counted from one lane's transcripts. */
export interface CallCounts {
  modelCalls: number;
  tools: { total: number; byCategory: Partial<Record<ToolCategory, number>> };
}

/** The coding CLIs a Genex lane pins to the raw lanes' own paths (§5.2); unset = the app's own discovery. */
export interface EvalExecutables {
  /** Absolute path of the Claude Code CLI. */
  claude?: string;
  /** Absolute path of the Codex CLI. */
  codex?: string;
}

/** Where a lane's CLI homes are: the eval-owned `CLAUDE_CONFIG_DIR` and `CODEX_HOME` (§5.4). */
export interface EvalCliHomes {
  claude: string;
  codex: string;
}

/**
 * The composer options an eval lane forwards with the brief. A build has no Loop switch, so a send
 * commissions none: the chat's agent decides whether to start a Loop.
 */
export type EvalCommission = Pick<ComposerSendOptions, "reviewPlan" | "preferences">;

/**
 * What an eval launch of the app is asked to do: one brief through one chat, in the build's default
 * mode, with a deadline. Written as JSON beside the run and read by `--studio-eval-lane=<spec>`.
 */
export interface EvalLaneSpec {
  runId: string;
  laneId: string;
  caseId: string;
  engine: EngineId;
  model: string;
  /** Effort pinned per model, passed explicitly. */
  effort: string;
  /** The case brief, verbatim; the suffix is appended by the lane runner. */
  brief: string;
  /** The shared instruction suffix ("You have about N minutes…"), identical across lanes; its digest is a run pin. */
  suffix: string;
  commission: EvalCommission;
  /** The permission mode the chat starts in: the evaluated build's `DEFAULT_PERMISSION_MODE`. */
  permissionMode: PermissionMode;
  deadlineMs: number;
  /** Grace after the deadline before the core stop path is taken. */
  graceMs: number;
  answerPolicy: AnswerPolicy;
  /** How many typed questions get the policy's sentence before the rest are left unanswered. */
  maxAnswers: number;
  /** Lane D: pass the host-skill suppression list to the Codex engine (recorded in `harnessPin`). */
  codexHostSkillSuppression: boolean;
  gamesRoot: string;
  userDataRoot: string;
  /** The run's own folder, which every path above must sit inside. */
  workRoot: string;
  homes: EvalCliHomes;
  /** Where the report is written when the lane ends. */
  reportPath: string;
  /** `true`: scripted `fixtureEngines()` instead of real providers. */
  fixture: boolean;
  /** The CLIs this launch pins, absolute paths; absent = the app's own discovery. */
  executables?: EvalExecutables;
  /**
   * Plugin ids the launch turns off before the chat exists; absent = the fresh profile's own
   * defaults, where every bundled plugin but Blender (Genex included) is on.
   */
  disabledPlugins?: string[];
  /**
   * An edit case's start game: the name of a folder directly under `gamesRoot`, which the lane
   * runner laid there. The chat is bound to it, opened as a game the person brought, before the
   * brief is sent. Absent = the agent makes its own game.
   */
  startGame?: string;
}

/** How an eval launch exits: the scheduler reads the code, the report says why. */
export const EVAL_LANE_EXIT = { Ok: 0, Failed: 1, Refused: 78 } as const;

/** Why main refuses an eval launch before any core starts. Printed on stderr: never rename a value. */
export const EvalLaunchRefusal = {
  NotSmoke: "not-smoke",
  /** A developer launch: its core runs on the dev profile and games, not the roots the guard checks. */
  DevLaunch: "dev-launch",
  InvalidSpec: "invalid-spec",
  LiveNotAllowed: "live-not-allowed",
  BypassMode: "bypass-mode",
  WorkRootTooBroad: "work-root-too-broad",
  OutsideWorkRoot: "outside-work-root",
  InsideAiGames: "inside-ai-games",
  DefaultUserData: "default-user-data",
} as const;
export type EvalLaunchRefusal = (typeof EvalLaunchRefusal)[keyof typeof EvalLaunchRefusal];

/** One typed question the lane answered, and when. */
export interface EvalLaneAnswer {
  /** Milliseconds since the prompt was submitted. */
  atMs: number;
  question: QuestionKind;
  questionId: string;
  policy: AnswerPolicy;
}

/** The budgets the agent registered for the run it launched, read from `run_registered`/`run_started`. */
export interface EvalLaneBudgets extends RecordedRunBudgets {
  completionPolicy: CompletionPolicy | null;
}

/** What went wrong inside the lane runner itself, as a code (never the provider's words). */
export const EvalLaneErrorCode = {
  UnknownModel: "unknown-model",
  EngineNotReady: "engine-not-ready",
  ThreadFailed: "thread-failed",
  StopFailed: "stop-failed",
  ReportWriteFailed: "report-write-failed",
  RailSigkill: "rail-sigkill",
  /** A plugin the spec turns off is not installed, or was still on after the launch turned it off. */
  PluginNotDisabled: "plugin-not-disabled",
} as const;
export type EvalLaneErrorCode = (typeof EvalLaneErrorCode)[keyof typeof EvalLaneErrorCode];

/** An error the lane runner recorded; `detail` is for the local report only and never reaches a ledger row. */
export interface EvalLaneError {
  code: EvalLaneErrorCode;
  detail: string;
}

/** One installed plugin and whether it was live when the run ended. */
export interface EvalLanePlugin {
  id: string;
  enabled: boolean;
}

/** What the harness workspace digest says about contamination: the eval profile's harness against the shipped seed. */
export interface HarnessDigest {
  workspace: string;
  shipped: string;
  matches: boolean;
}

/**
 * What the eval launch reports when it ends: identity, the served model, the harness digest, what
 * the agent chose, the answers given and how the run ended. Read by the collector; the ledger row
 * takes typed fields from it.
 */
export interface EvalLaneReport {
  schema: typeof EVAL_LANE_REPORT_SCHEMA;
  runId: string;
  laneId: string;
  caseId: string;
  engine: EngineId;
  modelRequested: string;
  /** The main-loop model the engine reported, or null when the stream never said. */
  modelServed: string | null;
  effort: string;
  effortServed: string | null;
  appVersion: string;
  harnessDigest: HarnessDigest;
  projectDir: string;
  /**
   * The workspace digest of the game as the app seeded it, taken the moment the chat was bound to
   * it and before the agent's first edit: what `template-untouched` is judged against at stop.
   * Null when the chat never got a game, or the launch could not see the binding.
   */
  templateDigest: string | null;
  threadId: string;
  startedAt: string;
  endedAt: string;
  endedHow: EndedHow;
  launch: LaunchPath;
  budgets: EvalLaneBudgets;
  /** Runs the chat launched, in order. */
  runIds: string[];
  permissionModeServed: PermissionMode;
  modeServed: LaneModeServed;
  commissionSent: EvalCommission;
  questionsAsked: number;
  answers: EvalLaneAnswer[];
  /** The first checkpoint or studio capture (the first-preview proxy until M4.4), ms after the prompt. */
  firstPreviewProxyMs: number | null;
  cliVersions: { claude: string | null; codex: string | null };
  fixture: boolean;
  errors: EvalLaneError[];
  /**
   * Every installed plugin, by id, as the run ended: the lane turned the spec's off and read them
   * back before the chat existed. Absent from a report written by a build from before plugin pins.
   */
  plugins?: EvalLanePlugin[];
}
