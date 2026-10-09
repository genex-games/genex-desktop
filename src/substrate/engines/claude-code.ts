import { realpath } from "node:fs/promises";
import { ModelCatalog, CatalogError, CATALOG_DEADLINE_MS } from "./model-catalog.ts";
import { ModelCatalogSource, ModelCatalogProblemCode } from "../../shared/model-catalog.ts";
import { validateClaudeModels } from "./claude-telemetry.ts";
import { supportedPreferences, type ModelPreferences } from "../../shared/model-preferences.ts";
import type { ProviderUsage } from "../../shared/provider-usage.ts";
import { readClaudeTelemetry, readClaudeUsage, withClaudeModelCapabilities } from "./claude-telemetry.ts";
import { cliVersion, requireCodingCli, resolveCodingCli, invalidateCodingCli } from "./external-cli.ts";
/**
 * Delegated engine — Claude Code via the Agent SDK.
 *
 * **Compliance boundary, restated because it constrains the code:** we do not route a consumer
 * subscription through a model API ourselves — that is prohibited. The sanctioned mechanic is
 * "your subscription, through their harness": the SDK spawns Claude Code, which performs its own
 * login and keeps its own credentials in its own config directory. The studio never sees, stores
 * or forwards a token. `CLAUDE_CONFIG_DIR` points at a dedicated home under `userData`, which is
 * on the sandbox's deny-read list for agent processes.
 *
 * What self-improvement means for a delegated build: we improve the **brief** and the workspace
 * instruction files the contractor reads (`CLAUDE.md`, skills), not the contractor itself. The
 * contractor is environment; the briefing layer is self.
 */
import { allowedFile, ownershipReason, relativeGamePath, specOf } from "../ownership.ts";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listDirs } from "../fsx.ts";
import { childEnv } from "../child-env.ts";
import { credentialHomes } from "../credential-homes.ts";
import type { Usage } from "../types.ts";
import type { ModelTokenUsage } from "../../shared/event-log.ts";
import { claudeAuthStatus, type ClaudeAuthStatus } from "./claude-cli.ts";
import { steerFeed, steerSession, userFrame, type SteerFeed, type SteerSession } from "./claude-steer.ts";
import { autoModeRules } from "./claude-auto-mode.ts";
import {
  askingOptions,
  leadAskingOptions,
  leadScreenHook,
  liveControl,
  permissionRules,
  preToolDeny,
  quietly,
  reportedMode,
  type RunningSession,
} from "./claude-permissions.ts";
import { describeWithSchema, zodShapeFromJsonSchema } from "./tool-schema.ts";
import {
  type CompleteRequest,
  type CompleteResponse,
  type DelegateAsks,
  type DelegateImage,
  type DelegateRequest,
  type DelegateResult,
  type Engine,
  EngineError,
  type EngineAccount,
  type EngineModel,
  type EngineStatus,
  DelegateEventType,
  type LiveToolResult,
  type LiveToolSpec,
  type StudioToolSpec,
} from "./types.ts";
import {
  CHECKPOINT_TOOL,
  CLAUDE_CAPTURE_TOOL,
  intakeToolReply,
  STUDIO_MCP_SERVER,
  STUDIO_TOOL_PREFIX,
  StudioTool,
  studioToolName,
} from "./studio-tool-prompts.ts";
import { captureArgs } from "./capture-args.ts";
import {
  abortControllerFor,
  CHECKPOINT_NOTE_CHARS,
  clip,
  COMPLETE_TIMEOUT_MS,
  type DelegateEnding,
  hasCredentials,
  interruption,
  isAccessLost,
  type PartialDelegateState,
  partialDelegateResult,
  STOPPED_BY_USER,
  CompletionStop,
} from "./common.ts";
import { isInside, relativizeWorkspace } from "../paths.ts";
import { baseDenyRead } from "../spawn.ts";
import { isCommandScript, spawnCommand } from "../command-launch.ts";
import { errorMessage } from "../../shared/errors.ts";
import { CodingCliState } from "../../shared/coding-cli.ts";
import { HOUR_MS, MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";
import { limitResetMs } from "./limit-reset.ts";
import { EngineId } from "../../shared/providers.ts";
import { EngineKind, EngineStatusCode, LoginSource } from "../../shared/engine-descriptor.ts";
import { ChatActivityPhase } from "../../shared/chat-activity.ts";
import { ContextSource } from "../../shared/context.ts";
import { EngineFailureKind, StopReason } from "../../shared/engine-requests.ts";

export interface ClaudeCodeEngineOptions {
  onModelsChanged?: () => void;
  /** Dedicated config home, used when Claude Code has not already been signed in on this Mac. */
  engineHome: string;
  /**
   * Where Claude Code keeps its own credentials on this machine (`~/.claude`). If it is already
   * signed in there, the studio uses that login rather than asking for a second one: it is the
   * same person, the same subscription, the same machine. We still never read the credential — we
   * simply do not override `CLAUDE_CONFIG_DIR`, and the SDK finds its own.
   */
  systemHome?: string;
  /** Default model id; `undefined` means "whatever Claude Code is configured to use". */
  model?: string;
  /** Directories the contractor must never read (the studio's secrets, engine homes). */
  protectedPaths?: string[];
  /** Optional host-selected external executable. Never falls back to the SDK binary. */
  executable?: string;
  /** Host/test dependency injection; never supplied by an in-app agent. */
  resolveCli?: typeof requireCodingCli;
  /** Injected in tests. */
  queryFn?: typeof import("@anthropic-ai/claude-agent-sdk").query;
  /** Injected in tests. Production asks the `claude` CLI, never a credential file. */
  authStatusFn?: (home: string | null) => Promise<ClaudeAuthStatus>;
  /**
   * Where every judge session runs; defaults to the one stable `JUDGE_CWD` the app shares. A test
   * passes a directory it owns so a conformance run does not sit in the live judge's folder.
   */
  judgeCwd?: string;
  /**
   * Whether building the engine sweeps stale judge transcripts out of the homes it can see.
   * The app passes true; a test leaves it off, because a constructor must never delete inside a
   * home the caller does not own (`CLAUDE_CONFIG_DIR` can point the sweep at the user's own).
   */
  sweepOnBoot?: boolean;
  /**
   * Which bundled skills a session may load, per role. `Options.skills` is a CONTEXT FILTER,
   * not a sandbox: a skill's frontmatter is prompt weight the session pays for whether or not
   * it ever loads the body. A judge answers one question about one picture with `allowedTools:
   * []` and no shell — a skill about deploying to Cloudflare can only make two verdicts that
   * should have been the same differ — so the judge defaults to `[]`. The delegate default is
   * `undefined`, which means the key is not sent at all and the CLI keeps its own behaviour:
   * a builder session is exactly where a project skill earns its keep.
   */
  skills?: { judge?: string[]; delegate?: string[] };
  maxTurns?: number;
}

/** The model id that means "whatever Claude Code is configured to use": never passed on. */
const DEFAULT_MODEL = "default";
/** The file Claude Code keeps its sign-in in; only its presence is ever checked. */
const CREDENTIAL_FILE = ".credentials.json";
/** Plan limits move slowly; the composer rereads them at most once a minute. */
const USAGE_FRESH_MS = MINUTE_MS;
/** How often a running session's telemetry (context, models) is read again. */
const TELEMETRY_INTERVAL_MS = 30 * SECOND_MS;
/**
 * How long a finished session waits on shells it left in the background, as the CLI's env reads
 * it. 0 would mean wait forever: a dev server left running would hold the build to its deadline.
 */
const BG_WAIT_CEILING_MS = String(MINUTE_MS);
/** App output policy, not a provider-advertised model limit. */
const STANDARD_MAX_TOKENS = 64_000;
/** The trace keeps this much of a thought, a tool result, a final report, a denial and a tool input. */
const TRACE_THINKING_CHARS = 2_000;
const TRACE_TOOL_RESULT_CHARS = 12_000;
const TRACE_RESULT_CHARS = 4_000;
const TRACE_DENIAL_CHARS = 300;
const TRACE_TOOL_INPUT_CHARS = 96;

const RATE_LIMIT_PATTERNS = [/rate.?limit/i, /usage limit/i, /session limit/i, /too many requests/i, /429/];
/** A weekly or monthly cap, or a limit that resets on a named day: it ends the run. */
const USAGE_LIMIT_PATTERN = /(weekly|monthly).{0,12}limit|limit.{0,30}resets [A-Z][a-z]{2} \d/i;
/** A spawn that failed before Claude Code started: the binary is missing or its path went stale. */
const SPAWN_FAILURE_PATTERN = /\bspawn\b.*\b(ENOTDIR|ENOENT)\b|\b(ENOTDIR|ENOENT)\b.*\bspawn\b/i;

/** The Agent SDK's message types, as its stream spells them. Vendor wire values. */
const SdkMessage = {
  Assistant: "assistant",
  User: "user",
  System: "system",
  Result: "result",
  StreamEvent: "stream_event",
  RateLimitEvent: "rate_limit_event",
  /**
   * A receipt for a message handed in with a uuid — only steers carry one (claude-steer.ts).
   * Stream mechanics: never mirrored, never a turn.
   */
  CommandLifecycle: "command_lifecycle",
} as const;

/** The subtypes of an SDK `system` message this engine reads. */
const SdkSystemSubtype = {
  Init: "init",
  CompactBoundary: "compact_boundary",
  PermissionDenied: "permission_denied",
  /** A status report; one that carries `permissionMode` says the session's mode changed. */
  Status: "status",
} as const;

/** The only `result` subtype that means the turn ended well. */
const SDK_RESULT_SUCCESS = "success";

/**
 * The CLI's own code on a reply that is an API error (`SDKAssistantMessage.error`), for the codes
 * that mean the account cannot be used until somebody acts: a stale sign-in, an organization that
 * does not allow it, an account on hold, a billing problem.
 */
const SdkApiError = {
  AuthenticationFailed: "authentication_failed",
  OauthOrgNotAllowed: "oauth_org_not_allowed",
  AccountOnHold: "account_on_hold",
  BillingError: "billing_error",
} as const;
/** The codes a sign-in failure is read from, whatever the words beside them. */
const SIGN_IN_ERRORS: ReadonlySet<unknown> = new Set<string>(Object.values(SdkApiError));

/** Compact Now's command: Claude Code's own compaction of the resumed session (`DelegateRequest.compact`). */
const COMPACT_COMMAND = "/compact";
/** `/compact` runs no model turn; a CLI that did not know it may answer once, never build. */
const COMPACT_MAX_TURNS = 1;
/** How a compaction ended, as the status message after it reports (`compact_result`). */
const CompactOutcome = {
  Success: "success",
  Failed: "failed",
} as const;
/** The hook Claude Code runs once it has compacted, handed the summary it wrote. */
const POST_COMPACT_HOOK = "PostCompact";

/** Content block types inside an SDK message, and the partial-stream events that carry text. */
const SdkBlock = {
  Text: "text",
  Thinking: "thinking",
  ToolUse: "tool_use",
  ToolResult: "tool_result",
  MessageStart: "message_start",
  ContentBlockDelta: "content_block_delta",
  TextDelta: "text_delta",
} as const;

/** Claude Code's own tools, grouped by what taking them away prevents. */
const MESSAGING_TOOLS = ["SendMessage", "ListAgents"];
const EDIT_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit"];
const SUBAGENT_TOOLS = ["Agent", "Task"];
const SHELL_TOOL = "Bash";
const READ_TOOLS = ["Read", "Grep", "Glob"];
/** Research on the web. The shell stays sandboxed without a network; these are the way out. */
const WEB_TOOLS = ["WebSearch", "WebFetch"];
/**
 * Claude Code's own ways to ask and to plan, which a chat's session does not take: it asks with
 * the studio's question tool, and enters Plan from the mode picker. ExitPlanMode stays, because
 * that is how a plan comes back for approval.
 */
const ASKING_TOOLS = ["AskUserQuestion", "EnterPlanMode"];
/** The PreToolUse matcher for every tool that writes a file. */
const EDIT_TOOLS_MATCHER = "Edit|Write|MultiEdit|NotebookEdit";
/** A judge looks at what it was given: no shell, no files, no helpers, nothing looked up. */
const JUDGE_DISALLOWED_TOOLS = [
  ...MESSAGING_TOOLS,
  ...SUBAGENT_TOOLS,
  SHELL_TOOL,
  "Write",
  "Edit",
  ...READ_TOOLS,
  ...WEB_TOOLS,
];

/** What this engine says to the user: statuses, remedies and errors. */
const MESSAGE = {
  LoginHint: "Sign in with your Claude subscription. The studio never sees your password.",
  AccessLostHint:
    "Sign in with a Claude account that has access, or ask your organization's admin to turn Claude Code back on.",
  InstallRemedy: "Install Claude Code, then check again.",
  SdkMissing: "the Claude Agent SDK is not installed",
  SdkRemedy: "Reinstall the app; the SDK ships with it.",
  FromEnvironment: "Claude Code is configured from the environment",
  SystemLogin: "using your existing Claude Code sign-in on this Mac",
  IsolatedLogin: "signed in for Studio only",
  NotSignedIn: "Claude Code has not been signed in on this Mac",
  CliNotSignedIn: "Claude Code is not signed in",
  RecheckRemedy: "Recheck the external Claude CLI and sign-in.",
  NoToolLoop: "Claude Code has no tool-loop completion; use engine.delegate to build",
  DiscoveryTimeout: "time budget exhausted during CLI discovery",
  JudgeLaunchTimeout: "time budget exhausted before judge launch",
  JudgeFailed: "Claude Code judge failed",
  JudgeEmpty: "the Claude Code judge gave no reply",
  NotCompacted: "Claude Code did not compact the session",
} as const;

/**
 * What a limit message means for the run: a weekly/monthly cap ends the run (`usage_limit`),
 * a session/5-hour window is waitable (`rate_limit`), anything else is not a limit at all. The
 * CLI reports both only in result TEXT ("You've hit your session limit · resets 9:50pm"), never
 * in a subtype, so the text is read before the SDK's throw is classified, or a limit reads as a
 * plain "error".
 */
export function limitKind(
  text: string,
): typeof EngineFailureKind.UsageLimit | typeof EngineFailureKind.RateLimit | null {
  if (!text) return null;
  if (USAGE_LIMIT_PATTERN.test(text)) return EngineFailureKind.UsageLimit;
  const namesAReset = /limit.{0,40}resets/i.test(text);
  if (RATE_LIMIT_PATTERNS.some((re) => re.test(text)) || namesAReset) return EngineFailureKind.RateLimit;
  return null;
}

/** The wait a limit message names lives beside Codex's reading of it; kept here for its callers. */
export { limitResetMs } from "./limit-reset.ts";

/**
 * The one directory every judge session runs in.
 *
 * It used to be a fresh `mkdtemp` per verdict, which cost twice. Claude Code's own system prompt
 * names its working directory, so a new directory every time guaranteed a cache miss on the very
 * prefix that never changes: every vision call wrote cache and read back none of it. And the CLI
 * keeps a transcript directory per working directory, so a run left thousands of them (GBs) under
 * the engine home. One stable, empty directory fixes both: the
 * prefix is identical across sessions, and there is one transcript directory to sweep.
 *
 * It stays a *fresh* session — one turn, no resume, no tools, no game folder — because that is
 * what makes a verdict blind. Sharing a working directory is not sharing a context.
 */
export const JUDGE_CWD = path.join(os.tmpdir(), "studio-judge-sessions");

/** How long a judge transcript is worth keeping: long enough to debug last run, not last month. */
export const JUDGE_TRANSCRIPT_TTL_MS = 7 * 24 * HOUR_MS;

/**
 * Delete the CLI's own judge transcripts once they are older than a week.
 *
 * Claude Code writes one `projects/<slugified cwd>/` directory of `.jsonl` transcripts per
 * working directory, and nothing ever removes them: the judge's `mkdtemp` era left 1353 of them
 * behind. This sweeps every `*studio-judge*` directory under an engine home — the stale ones from
 * that era and the live one — dropping files past the ttl and the directory itself once it is
 * empty. Frames are the bulk of the bytes, so a week's worth is hundreds of megabytes.
 *
 * Returns the paths it removed, so a caller (or a test) can say what was swept.
 */
export async function sweepJudgeTranscripts(
  engineHome: string,
  options: { ttlMs?: number; now?: number } = {},
): Promise<string[]> {
  const projects = path.join(engineHome, "projects");
  const cutoff = (options.now ?? Date.now()) - (options.ttlMs ?? JUDGE_TRANSCRIPT_TTL_MS);
  const removed: string[] = [];
  for (const name of await listDirs(projects)) {
    if (!name.includes("studio-judge")) continue;
    const dir = path.join(projects, name);
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    let kept = 0;
    for (const entry of entries) {
      const file = path.join(dir, entry);
      const modified = await stat(file).then(
        (s) => s.mtimeMs,
        () => null,
      );
      // A file we cannot stat is left alone: this is housekeeping, not a cleaner.
      if (modified === null || modified >= cutoff) {
        kept++;
        continue;
      }
      await rm(file, { recursive: true, force: true }).catch(() => {
        kept++;
      });
      removed.push(file);
    }
    if (kept === 0) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      removed.push(dir);
    }
  }
  return removed;
}
// Matches what Claude Code actually says when a subscription login has gone stale, including
// "Failed to authenticate: OAuth session expired" — an auth failure the run must not mistake for
// a generic error, because the remedy is a sign-in, not a retry.
const AUTH_PATTERNS = [
  /not logged in/i,
  /unauthor/i,
  /authenticat/i,
  /oauth/i,
  /session expired/i,
  /login/i,
  /sign ?in/i,
  /credential/i,
];

export class ClaudeCodeEngine implements Engine {
  #usage: ProviderUsage | null = null;
  #usageRead: Promise<ProviderUsage | null> | null = null;
  readonly #catalog: ModelCatalog;
  #telemetryAt = new WeakMap<object, number>();
  #telemetryEpoch = new WeakMap<object, number>();
  #catalogEpoch = new WeakMap<object, number>();
  usageSnapshot = () => this.#usage;
  /**
   * Reread a running session's models, and its context when there is an `onEvent` to report it to.
   * Plan usage is never asked here (`readClaudeTelemetry`); `readUsage` has its own session.
   */
  #observeTelemetry(stream: unknown, onEvent?: DelegateRequest["onEvent"], sessionId?: string): void {
    if (!stream || typeof stream !== "object") return;
    if (Date.now() - (this.#telemetryAt.get(stream) ?? 0) < TELEMETRY_INTERVAL_MS) return;
    this.#telemetryAt.set(stream, Date.now());
    const epoch = this.#telemetryEpoch.get(stream) ?? 0;
    const catalogEpoch = this.#catalogEpoch.get(stream) ?? -1;
    void readClaudeTelemetry(stream, { readContext: Boolean(onEvent) }).then((data) => {
      if (data.models) {
        try {
          this.#catalog.publish(
            {
              models: withClaudeModelCapabilities([], validateClaudeModels(data.models)),
              source: ModelCatalogSource.Provider,
            },
            catalogEpoch,
          );
        } catch {
          /* Optional telemetry cannot invalidate a complete discovery. */
        }
      }
      // A reading taken before a compaction describes a context that no longer exists.
      const sameContext = (this.#telemetryEpoch.get(stream) ?? 0) === epoch;
      if (data.context && sameContext)
        onEvent?.({
          type: DelegateEventType.ContextUsage,
          // Claude Code's own meter: the provider's reading, not an estimate of the studio's.
          payload: { ...data.context, sessionId, source: ContextSource.Provider },
        });
    });
  }

  /** A compaction starts a new context: telemetry read before it must not be reported after it. */
  #markCompaction(stream: object): void {
    this.#telemetryEpoch.set(stream, (this.#telemetryEpoch.get(stream) ?? 0) + 1);
    this.#telemetryAt.delete(stream);
  }

  readonly id = EngineId.ClaudeCode;
  readonly label = "Claude Code";
  readonly kind = EngineKind.Delegated;
  /** A CLI that reports message lifecycles folds a pushed message in at its next tool result (claude-steer.ts). */
  readonly steersMidTurn = true;
  /**
   * A game chat's own session asks the person mid-turn (`DelegateRequest.permissions`), and so do a
   * build's lead and the run's coordinator, in the chat's mode (`leadAsks`).
   */
  readonly permissionPrompts = true;
  /** Compact Now sends the resumed session Claude Code's own `/compact`. */
  readonly compactsNatively = true;
  readonly engineHome: string;
  readonly systemHome: string;
  readonly #model: string | undefined;
  readonly #maxTurns: number | undefined;
  readonly #protectedPaths: string[];
  readonly #resolveCli: typeof requireCodingCli;
  readonly #executable: string | undefined;
  readonly judgeCwd: string;
  readonly #skills: { judge?: string[]; delegate?: string[] };
  #queryFn: ClaudeCodeEngineOptions["queryFn"];
  #authStatusFn: ClaudeCodeEngineOptions["authStatusFn"];
  /** Set when a call failed on auth: credential *files* can exist while the session is stale. */
  #authFailure: string | null = null;
  /** The `claude auth status` read under way; every probe in flight joins it. */
  #authProbe: Promise<EngineStatus> | null = null;
  /** A recheck waiting for the probe in flight to finish; a later recheck joins it. */
  #recheckQueued: Promise<EngineStatus> | null = null;
  /** The boot sweep of stale judge transcripts, resolved with what it removed. */
  readonly swept: Promise<string[]>;

  constructor(options: ClaudeCodeEngineOptions) {
    this.#catalog = new ModelCatalog(options.onModelsChanged);
    this.engineHome = options.engineHome;
    this.systemHome = options.systemHome ?? path.join(os.homedir(), ".claude");
    this.#model = options.model;
    // No default cap. The first live build hit turn 61 of 60 with $7.54 of work on disk and the
    // whole thing reported as a failure — a turn limit protects nothing the stop button and the
    // run budgets don't already cover, and it throws away the report at the finish line.
    this.#maxTurns = options.maxTurns;
    this.#protectedPaths = options.protectedPaths ?? [];
    this.#executable = options.executable;
    this.#resolveCli = options.resolveCli ?? requireCodingCli;
    this.#queryFn = options.queryFn;
    this.#authStatusFn = options.authStatusFn;
    this.judgeCwd = options.judgeCwd ?? JUDGE_CWD;
    // The judge's filter is a default, not a policy the caller cannot change; the delegate's is
    // absent unless somebody sets it, so a build session's query goes out byte-identical.
    this.#skills = {
      judge: options.skills?.judge ?? [],
      ...(options.skills?.delegate !== undefined ? { delegate: options.skills.delegate } : {}),
    };
    // Boot housekeeping, from the layer that made the mess: the engine is built once per app
    // start, and a sweep that fails is a sweep that did not happen, never a boot that did not.
    this.swept = options.sweepOnBoot ? this.#sweepJudgeHomes().catch(() => []) : Promise.resolve([]);
  }

  /**
   * Sweep the homes this engine's own judge sessions write into: the studio's, and — when the
   * studio is borrowing the user's existing Claude Code sign-in — that one too, because the
   * transcripts land wherever the login lives. Only `*studio-judge*` directories are touched, and
   * only the studio's judge ever makes one, so a home the user shares with their own Claude Code
   * keeps everything else.
   */
  async #sweepJudgeHomes(): Promise<string[]> {
    const login = await this.resolveLogin();
    const homes = new Set([this.engineHome, ...(login.home ? [login.home] : [])]);
    const removed: string[] = [];
    for (const home of homes) removed.push(...(await sweepJudgeTranscripts(home)));
    return removed;
  }

  /** Settings' summary: which login Studio uses and whether the CLI is usable. Never reads a credential. */
  async account(): Promise<EngineAccount> {
    const cli = await this.#cliSummary();
    const variable = loginVariable();
    const login = await this.resolveLogin();
    // Forgetting Studio's login deletes only its own home; resolveLogin then finds the Terminal one.
    const afterSignOut =
      login.source === LoginSource.Isolated && (await hasCredentials(this.systemHome, CREDENTIAL_FILE))
        ? "terminal"
        : "signed-out";
    return variable
      ? { source: LoginSource.Env, variable, afterSignOut: "signed-out", cli }
      : { source: login.source, afterSignOut, cli };
  }

  /** The CLI's state and version for Settings: ready, or why it is not. */
  async #cliSummary(): Promise<EngineAccount["cli"]> {
    try {
      const installation = await this.#resolveCli(EngineId.ClaudeCode, this.#executable, undefined, false);
      const version = cliVersion(installation.status.version);
      return { state: CodingCliState.Ready, path: installation.path, ...(version ? { version } : {}) };
    } catch {
      const found =
        this.#resolveCli === requireCodingCli
          ? await resolveCodingCli(EngineId.ClaudeCode, this.#executable).catch(() => null)
          : null;
      const version = cliVersion(found?.status.version);
      return {
        state: found && found.status.state !== CodingCliState.Ready ? found.status.state : CodingCliState.Missing,
        ...(version ? { version } : {}),
      };
    }
  }

  /**
   * Which login this engine will use. Order: an explicit `CLAUDE_CONFIG_DIR` in the environment,
   * then a login the studio made for itself, then the user's existing Claude Code login, and only
   * failing all three does it ask for a sign-in.
   */
  async resolveLogin(): Promise<{ source: LoginSource; home: string | null }> {
    if (process.env.CLAUDE_CONFIG_DIR) return { source: LoginSource.Env, home: process.env.CLAUDE_CONFIG_DIR };
    if (await hasCredentials(this.engineHome, CREDENTIAL_FILE))
      return { source: LoginSource.Isolated, home: this.engineHome };
    if (await hasCredentials(this.systemHome, CREDENTIAL_FILE))
      return { source: LoginSource.System, home: this.systemHome };
    return { source: LoginSource.None, home: null };
  }

  async #installation(signal?: AbortSignal, timeoutMs?: number): Promise<Awaited<ReturnType<typeof requireCodingCli>>> {
    const controller = new AbortController();
    const stop = (): void => controller.abort(signal?.reason);
    if (signal?.aborted) stop();
    else signal?.addEventListener("abort", stop, { once: true });
    let expired = false;
    const timer =
      timeoutMs === undefined
        ? null
        : setTimeout(
            () => {
              expired = true;
              controller.abort();
            },
            Math.max(0, timeoutMs),
          );
    try {
      if (timeoutMs !== undefined && timeoutMs <= 0) {
        expired = true;
        controller.abort();
      }
      controller.signal.throwIfAborted();
      const installation = await this.#resolveCli(EngineId.ClaudeCode, this.#executable, controller.signal);
      controller.signal.throwIfAborted();
      return installation;
    } catch (error) {
      if (signal?.aborted) throw new EngineError(EngineFailureKind.Aborted, this.id, STOPPED_BY_USER);
      if (expired) throw new EngineError(EngineFailureKind.Timeout, this.id, MESSAGE.DiscoveryTimeout);
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
    }
  }

  async #query(): Promise<NonNullable<ClaudeCodeEngineOptions["queryFn"]>> {
    if (this.#queryFn) return this.#queryFn;
    try {
      const module = await import("@anthropic-ai/claude-agent-sdk");
      this.#queryFn = module.query;
      return module.query;
    } catch (err) {
      throw new EngineError(
        EngineFailureKind.Unavailable,
        this.id,
        `Claude Agent SDK is not installed: ${errorMessage(err)}`,
      );
    }
  }

  /**
   * Login state is inferred from the *presence* of Claude Code's credential files — never from
   * their contents, which the studio has no business reading. Unknown is reported as
   * `needs_login` with instructions rather than being optimistically treated as ready.
   */
  async status(): Promise<EngineStatus> {
    return this.#status(true);
  }

  /** `status()`, optionally without the remembered auth failure a probe is about to re-ask. */
  async #status(rememberFailure: boolean): Promise<EngineStatus> {
    try {
      await this.#resolveCli(EngineId.ClaudeCode, this.#executable, undefined, false);
    } catch (error) {
      return { code: EngineStatusCode.NotInstalled, detail: errorMessage(error), remedy: MESSAGE.InstallRemedy };
    }
    try {
      await import("@anthropic-ai/claude-agent-sdk");
    } catch {
      return { code: EngineStatusCode.NotInstalled, detail: MESSAGE.SdkMissing, remedy: MESSAGE.SdkRemedy };
    }
    // An ambient ANTHROPIC_API_KEY does NOT count as configured: D8 says subscription only, and
    // the key is stripped from every child environment anyway (subscriptionEnv).
    if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
      return { code: EngineStatusCode.Ready, detail: MESSAGE.FromEnvironment };
    }
    if (rememberFailure && this.#authFailure) {
      return { code: EngineStatusCode.NeedsLogin, detail: this.#authFailure, remedy: this.loginHint() };
    }
    const login = await this.resolveLogin();
    switch (login.source) {
      case LoginSource.Env:
        return { code: EngineStatusCode.Ready, detail: `using CLAUDE_CONFIG_DIR (${login.home})` };
      case LoginSource.System:
        return { code: EngineStatusCode.Ready, detail: MESSAGE.SystemLogin };
      case LoginSource.Isolated:
        return { code: EngineStatusCode.Ready, detail: MESSAGE.IsolatedLogin };
      default:
        return { code: EngineStatusCode.NeedsLogin, detail: MESSAGE.NotSignedIn, remedy: this.loginHint() };
    }
  }

  /** Shown in the UI. The login happens in Claude Code's own flow, with its own credential store. */
  loginHint(): string {
    return MESSAGE.LoginHint;
  }

  /**
   * Cheap `status()` trusts credential *files*, which can outlive a dead OAuth session.
   * This asks Claude Code itself — CLI first, then a one-turn handshake — and remembers
   * an auth failure the same way a failed build does. The last answer stands until the new one
   * arrives: clearing it first would report Ready to every status read during the probe.
   */
  async probeAuth(): Promise<EngineStatus> {
    if (this.#authProbe) return this.#authProbe;
    this.#authProbe = this.#readAuth();
    try {
      return await this.#authProbe;
    } finally {
      this.#authProbe = null;
    }
  }

  async #readAuth(): Promise<EngineStatus> {
    const cheap = await this.#status(false);
    if (cheap.code !== EngineStatusCode.Ready) return cheap;

    const login = await this.resolveLogin();
    const cliHome = login.source === LoginSource.System || login.source === LoginSource.None ? null : login.home;
    const installation = await this.#resolveCli(EngineId.ClaudeCode, this.#executable, undefined, false);
    const cli = await (
      this.#authStatusFn ??
      ((home) => claudeAuthStatus(home, { findBinary: async () => installation.path, env: installation.env }))
    )(cliHome);
    if (cli.loggedIn === null)
      return { code: EngineStatusCode.Error, detail: cli.detail, remedy: MESSAGE.RecheckRemedy };
    this.#authFailure = cli.loggedIn ? null : cli.detail || MESSAGE.CliNotSignedIn;
    return this.status();
  }

  /**
   * Forget the cached CLI, models and usage and ask Claude Code again. A recheck that arrives
   * while the CLI is being asked waits for that answer and then asks once more; rechecks that
   * arrive meanwhile join it, so a burst of them never asks the CLI more than twice.
   */
  recheckLogin(): Promise<EngineStatus> {
    if (this.#recheckQueued) return this.#recheckQueued;
    const running = this.#authProbe;
    this.#recheckQueued = (async () => {
      await running?.catch(() => {});
      this.#recheckQueued = null;
      invalidateCodingCli(EngineId.ClaudeCode);
      this.#catalog.invalidate();
      this.#usage = null;
      return this.probeAuth();
    })();
    return this.#recheckQueued;
  }

  /**
   * The plan's limits for the composer. A session is opened, asked for its account usage and
   * closed before any prompt is sent, so reading them never spends a turn. A reading from the
   * last minute is fresh enough to reuse.
   */
  async readUsage(): Promise<ProviderUsage | null> {
    if (this.#usage && Date.now() - Date.parse(this.#usage.measuredAt) < USAGE_FRESH_MS) return this.#usage;
    if (this.#usageRead) return this.#usageRead;
    this.#usageRead = (async () => {
      const login = await this.resolveLogin();
      if (login.source === LoginSource.None) return null;
      const installation = await this.#resolveCli(EngineId.ClaudeCode, this.#executable, undefined, false);
      const query = await this.#query();
      // The judges' empty directory: nothing of a game is in reach, and the OS may have swept it.
      await mkdir(this.judgeCwd, { recursive: true });
      const controller = new AbortController();
      let release = (): void => {};
      // A prompt that never yields: the CLI starts and answers control requests, and no turn begins.
      const idle = (async function* () {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      })();
      const stream = query({
        prompt: idle,
        options: {
          ...claudeLaunchOptions(installation.path),
          cwd: this.judgeCwd,
          settingSources: [],
          mcpServers: {},
          strictMcpConfig: true,
          allowedTools: [],
          // No prompt is ever sent, so no tool can run; the judge's sandbox shape holds regardless.
          maxTurns: 1,
          permissionMode: "default",
          sandbox: { enabled: true },
          env: this.#sessionEnv(installation.env, login),
          abortController: controller,
        },
      } as never);
      try {
        const usage = await readClaudeUsage(stream);
        if (usage) this.#usage = usage;
        return usage ?? this.#usage;
      } finally {
        controller.abort();
        release();
      }
    })()
      .catch(() => this.#usage)
      .finally(() => {
        this.#usageRead = null;
      });
    return this.#usageRead;
  }

  catalogSnapshot = () => this.#catalog.snapshot();

  async models(): Promise<EngineModel[]> {
    void this.refreshModels().catch(() => {});
    const models = this.#catalog.models();
    const reportedDefault = models.find((model) => model.id === DEFAULT_MODEL);
    const concrete = models.filter((model) => model.id !== DEFAULT_MODEL);
    // The CLI's default names a model it also lists; that row stands for the default in pickers.
    const target = reportedDefault?.resolvedModel;
    const named = target ? concrete.find((model) => model.resolvedModel === target) : undefined;
    return [
      ...claudeModelCatalog().map((model) => ({
        ...model,
        ...reportedDefault,
        id: DEFAULT_MODEL,
        label: "Claude Code default",
      })),
      ...concrete.map((model) => (model === named ? { ...model, providerDefault: true } : model)),
    ];
  }

  async refreshModels(force = false): Promise<void> {
    const generation = this.#catalog.epoch();
    const installation = await this.#resolveCli(EngineId.ClaudeCode, this.#executable, undefined, false);
    const login = await this.resolveLogin();
    if (generation !== this.#catalog.epoch()) return;
    const identity = JSON.stringify([
      login,
      installation.path,
      await realpath(installation.path).catch(() => installation.path),
      installation.status.version,
    ]);
    if (generation !== this.#catalog.epoch()) return;
    await this.#catalog.refresh(
      identity,
      async () => {
        const query = await this.#query();
        await mkdir(this.judgeCwd, { recursive: true });
        const abortController = new AbortController();
        let release = (): void => {};
        const prompt = (async function* () {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        })();
        const stream = query({
          prompt,
          options: {
            ...claudeLaunchOptions(installation.path),
            cwd: this.judgeCwd,
            settingSources: [],
            persistSession: false,
            settings: { disableAllHooks: true },
            mcpServers: {},
            strictMcpConfig: true,
            tools: [],
            allowedTools: [],
            maxTurns: 1,
            permissionMode: "default",
            sandbox: { enabled: true },
            env: this.#sessionEnv(installation.env, login),
            abortController,
          },
        });
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const models = await Promise.race([
            stream.supportedModels(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () =>
                  reject(new CatalogError(ModelCatalogProblemCode.Timeout, "Model discovery timed out. Try again.")),
                CATALOG_DEADLINE_MS,
              );
            }),
          ]);
          return {
            models: withClaudeModelCapabilities([], validateClaudeModels(models)),
            source: ModelCatalogSource.Provider,
          };
        } finally {
          clearTimeout(timer);
          abortController.abort();
          release();
          stream.close();
        }
      },
      force,
    );
  }

  async preferenceSettings(model: string | undefined, value: ModelPreferences): Promise<Record<string, unknown>> {
    const descriptor = (await this.models()).find((m) => m.id === (model ?? this.#model ?? DEFAULT_MODEL));
    const allowed = supportedPreferences(value, descriptor ?? {});
    return {
      ...(allowed.fast !== undefined ? { fastMode: allowed.fast } : {}),
    };
  }

  async defaultModel(): Promise<string | null> {
    return this.#model ?? null;
  }

  /**
   * The studio's own MCP server for the contractor. `checkpoint` lets the contractor decide which
   * moments are worth seeing — the studio lights Live's Reload and posts the note in chat the
   * moment it is called (Live itself changes only when the user reloads). (Designed with Simeon: not a file-watcher pushing half-broken states;
   * the builder chooses when there is something to show.) Capture, live and interview tools join
   * it when the delegation grants them.
   */
  async #studioServer(request: DelegateRequest, interviewTools: StudioToolSpec[]): Promise<unknown> {
    const [{ createSdkMcpServer, tool }, { z }] = await Promise.all([
      import("@anthropic-ai/claude-agent-sdk"),
      import("zod"),
    ]);
    const kit: McpKit = { tool, z };
    const { onCapture, onLiveTool } = request;
    return createSdkMcpServer({
      name: STUDIO_MCP_SERVER,
      version: "1.0.0",
      tools: [
        checkpointTool(kit, request.onEvent),
        ...(onCapture ? [captureTool(kit, onCapture)] : []),
        ...(onLiveTool ? (request.liveTools ?? []).map((spec) => liveTool(kit, spec, onLiveTool)) : []),
        ...interviewTools.map((spec) => intakeTool(kit, spec)),
      ],
    });
  }

  /**
   * Isolated one-shot for the critic. Not a second builder: no tools, no game folder, no
   * resume of the contractor session, still no `SendMessage`/`ListAgents`. The stills go in
   * as image blocks so this is the same "look at the pictures" path the local judge uses.
   */
  async complete(request: CompleteRequest): Promise<CompleteResponse> {
    if (request.tools?.length) {
      throw new EngineError(EngineFailureKind.Other, this.id, MESSAGE.NoToolLoop);
    }
    const preparationStartedAt = Date.now();
    const ceilingMs = request.timeoutMs ?? COMPLETE_TIMEOUT_MS;
    const cliInstallation = await this.#installation(request.signal, ceilingMs);
    request.signal?.throwIfAborted();
    const query = await this.#query();
    const login = await this.resolveLogin();
    // One stable, empty directory for every verdict (JUDGE_CWD) — remade if the OS swept it.
    await mkdir(this.judgeCwd, { recursive: true });
    const judge: JudgeState = { text: "", modelUsed: undefined, usage: { engine: this.id }, apiError: null };
    // One controller, two triggers, same shape as delegate: the caller's stop and the ceiling.
    const controller = abortControllerFor(request.signal);
    let ceilingHit = false;
    let ceiling: ReturnType<typeof setTimeout> | null = null;

    try {
      if (Date.now() - preparationStartedAt >= ceilingMs)
        throw new EngineError(EngineFailureKind.Timeout, this.id, MESSAGE.JudgeLaunchTimeout);
      request.signal?.throwIfAborted();
      const options = await this.#judgeOptions(request, cliInstallation, login, controller);
      const stream = query({ prompt: judgePrompt(request), options } as never);
      this.#catalogEpoch.set(stream, this.#catalog.epoch());
      // Started after the stream exists — a throw during setup must not leave a live timer.
      ceiling = setTimeout(
        () => {
          ceilingHit = true;
          controller.abort();
        },
        Math.max(0, ceilingMs - (Date.now() - preparationStartedAt)),
      );
      for await (const message of stream as AsyncIterable<Record<string, unknown>>) {
        this.#observeJudgeMessage(message, judge, request, stream);
      }
    } catch (err) {
      throw this.#judgeFailure(err, request, ceilingHit);
    } finally {
      if (ceiling) clearTimeout(ceiling);
    }

    // A judge that said nothing gave no verdict: a failure, not an empty string for the parser.
    if (!judge.text.trim()) throw new EngineError(EngineFailureKind.Unavailable, this.id, MESSAGE.JudgeEmpty);
    return {
      message: { role: "assistant", content: judge.text },
      usage: judge.usage,
      stopReason: CompletionStop.Stop,
      // The CLI names the model it ran on; when it does not, the one asked for stands in.
      model: judge.modelUsed ?? request.model ?? this.#model ?? "unknown",
      engine: this.id,
    };
  }

  /** The judge's session: one turn in the empty judge folder, every tool taken away. */
  async #judgeOptions(
    request: CompleteRequest,
    cliInstallation: ClaudeInstallation,
    login: ClaudeLogin,
    controller: AbortController,
  ): Promise<Record<string, unknown>> {
    return {
      ...claudeLaunchOptions(cliInstallation.path),
      cwd: this.judgeCwd,
      maxTurns: 1,
      permissionMode: "default",
      settingSources: [],
      mcpServers: {},
      strictMcpConfig: true,
      // No built-in tool at all: refusing them below still sent every definition on each verdict.
      tools: [],
      allowedTools: [],
      ...(this.#skills.judge !== undefined ? { skills: this.#skills.judge } : {}),
      disallowedTools: [...JUDGE_DISALLOWED_TOOLS],
      sandbox: { enabled: true },
      ...modelOption(request.model ?? this.#model),
      ...(request.effort ? { effort: request.effort } : {}),
      ...(request.preferences ? { settings: await this.preferenceSettings(request.model, request.preferences) } : {}),
      // Same bg-wait ceiling as delegate: the judge has no shell, but the env contract is
      // one contract — a future tool grant must not resurrect the wait-forever default.
      env: this.#sessionEnv(cliInstallation.env, login, { CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: BG_WAIT_CEILING_MS }),
      abortController: controller,
    };
  }

  /** One message of the judge's stream: the model it ran on, its words, and how it ended. */
  #observeJudgeMessage(message: Record<string, unknown>, judge: JudgeState, request: CompleteRequest, stream: unknown) {
    const type = String(message.type ?? "");
    if (type === SdkMessage.System) {
      this.#observeTelemetry(stream);
      if (message.subtype === SdkSystemSubtype.Init) judge.modelUsed = String(message.model ?? "") || undefined;
    }
    if (type === SdkMessage.Assistant) {
      judge.apiError = apiErrorOf(message);
      for (const text of assistantTexts(message)) {
        judge.text += text;
        request.onDelta?.(text);
      }
    }
    if (type === SdkMessage.Result) this.#judgeResult(message as SdkResult, judge);
  }

  /** The judge's result: its cost, its words when its replies had none, and the failure it reports. */
  #judgeResult(result: SdkResult, judge: JudgeState): void {
    recordResultUsage(judge.usage, result);
    if (result.result && !judge.text.trim()) judge.text = result.result;
    const failed = isFailedResult(result);
    const signedOut = this.#signedOut({
      failed,
      errorSubtype: resultErrorSubtype(result, !failed),
      apiError: judge.apiError,
      text: result.result || judge.text,
    });
    if (signedOut) throw signedOut;
    if (failed) throw this.#classify(new Error(result.result || result.subtype || MESSAGE.JudgeFailed));
  }

  /** What a judge that did not answer threw, in the order that says whose stop it was. */
  #judgeFailure(err: unknown, request: CompleteRequest, ceilingHit: boolean): EngineError {
    // A caller's stop that raced the ceiling still reads as theirs: their signal fired first.
    if (request.signal?.aborted) {
      return new EngineError(EngineFailureKind.Aborted, this.id, STOPPED_BY_USER);
    }
    if (ceilingHit) {
      const ceilingMs = request.timeoutMs ?? COMPLETE_TIMEOUT_MS;
      const ceilingLabel = ceilingMs >= MINUTE_MS ? `${Math.round(ceilingMs / MINUTE_MS)} min` : `${ceilingMs}ms`;
      return new EngineError(EngineFailureKind.Timeout, this.id, `the judge did not answer within ${ceilingLabel}`);
    }
    if (err instanceof EngineError) return err;
    return this.#classify(err as Error);
  }

  async delegate(request: DelegateRequest): Promise<DelegateResult> {
    const ready = request.steer?.ready;
    if (!ready) return this.#delegate(request, null);
    // Steer (DelegateRequest.steer): `ready` is said exactly once, whatever ends the delegation —
    // a session stopped before launch, or one that failed before its init, took nothing mid-turn,
    // and the host is waiting to hear so. Every result lists what the session read.
    const steer = steerSession(ready);
    try {
      const result = await this.#delegate(request, steer);
      return { ...result, steered: [...steer.steered] };
    } finally {
      steer.tell(null);
    }
  }

  async #delegate(request: DelegateRequest, steer: SteerSession | null): Promise<DelegateResult> {
    const startedAt = Date.now();
    const usage: Usage = { engine: this.id };
    const nothingYet: PartialDelegateState = { summary: "", usage, turns: 0, startedAt };
    let cliInstallation: ClaudeInstallation;
    try {
      request.signal?.throwIfAborted();
      cliInstallation = await this.#installation(request.signal, request.timeoutMs);
      request.signal?.throwIfAborted();
    } catch (error) {
      if (request.signal?.aborted)
        return this.#partial(interruption(true), { ...nothingYet, sessionId: request.resume });
      if (error instanceof EngineError && error.kind === EngineFailureKind.Timeout)
        return this.#partial(interruption(false), nothingYet);
      throw error;
    }
    const query = await this.#query();
    const run = newRunState(usage, cliInstallation);
    const login = await this.resolveLogin();
    // One controller, two triggers: the user's stop and the wall-clock deadline. The flag
    // (`run.deadlineHit`) is what tells them apart afterwards — the abort itself looks identical
    // to the SDK.
    const controller = abortControllerFor(request.signal);
    const budgetSpent = request.timeoutMs !== undefined && Date.now() - startedAt >= request.timeoutMs;
    if (request.signal?.aborted || budgetSpent) {
      return this.#partial(interruption(request.signal?.aborted), { ...nothingYet, sessionId: request.resume });
    }
    // The running session, for what an answer asks of it after the answer (claude-permissions.ts).
    const running: RunningSession = { stream: null };
    const options = await this.#delegateOptions(request, { cliInstallation, login, controller, running, run });
    const stream = query({ prompt: sessionPrompt(request, steer, run, controller.signal), options } as never);
    this.#catalogEpoch.set(stream, this.#catalog.epoch());
    running.stream = stream as RunningSession["stream"];
    // The mode picker reaches a running turn of a session that asks (the chat's own, a lead's, the
    // coordinator's): the host holds this until the session takes no more control requests (its
    // input ended at a result) or its end, whichever comes first.
    run.control = liveControl(asksOf(request), stream);
    // Started after the stream exists: a throw during setup must not leave a live timer whose
    // only job would be aborting a build that never began.
    const deadlineTimer = startDeadline(request.timeoutMs, startedAt, () => {
      run.deadlineHit = true;
      controller.abort();
    });

    const partialState = (): PartialDelegateState => runPartialState(run, request, startedAt, this.#model);
    try {
      for await (const message of stream as AsyncIterable<Record<string, unknown>>) {
        this.#observeMessage(message, run, request, stream);
      }
    } catch (err) {
      return this.#endingAfterThrow(err, run, request, partialState);
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      run.feed?.dispose();
      run.control.release();
    }

    // Some SDK streams end cleanly after abort instead of throwing.
    if (request.signal?.aborted || run.deadlineHit) {
      return this.#partial(interruption(request.signal?.aborted), partialState());
    }
    return this.#finish(run, request, startedAt);
  }

  /**
   * The contractor's session. It is a hired hand in ONE workspace, and every option here keeps
   * it there: its own sandbox, only the studio's MCP server, and none of the user's own config.
   */
  async #delegateOptions(request: DelegateRequest, ctx: SessionContext): Promise<Record<string, unknown>> {
    const { cliInstallation, login, controller } = ctx;
    const interviewTools = request.interviewTools ?? [];
    const maxTurns = request.compact ? COMPACT_MAX_TURNS : (request.maxTurns ?? this.#maxTurns);
    const { cwd, directories, protectedPaths, rules } = await this.#contractorReach(request, login);
    const asks = asksOf(request);
    return {
      ...claudeLaunchOptions(cliInstallation.path),
      cwd: request.cwd,
      includePartialMessages: true,
      ...permissionOptions(request, ctx.running),
      // Edit-time ownership: a Write outside the facet's files is refused before it
      // lands, with the reason in the contractor's face — the after-the-fact reviewer once
      // "reverted" such files by deleting eleven merged modules. A lead's calls are screened by
      // the host there too, ahead of every allow rule.
      ...sessionHooks(request, cwd, ctx.run),
      ...(maxTurns ? { maxTurns } : {}),
      ...(request.resume ? { resume: request.resume } : {}),
      ...modelOption(request.model ?? this.#model),
      ...(request.effort ? { effort: request.effort } : {}),

      // The contractor is a hired hand in ONE workspace. It gets none of the user's global
      // Claude Code config (no MCP servers, no personal settings — the first live build came
      // up with 111 tools and started messaging the user's other sessions), and an unattended
      // session's shell commands run inside Claude Code's own sandbox, confined to the
      // workspace. That is also what lets Bash be auto-allowed, so it can actually run `node`
      // and verify games — the first build shipped completely untested because every command
      // was denied. A chat's own session asks instead, so it runs where the person would.
      // Project configuration can execute hooks; only host-stored folder trust enables it.
      settingSources: request.trustedProjectSettings === true ? ["project"] : [],
      // The one exception: the studio's own MCP server (checkpoint → live preview, plus the
      // launch and question tools when this is a Loop chat). strictMcpConfig is
      // load-bearing: without it, passing ANY mcpServers makes the CLI also load the user's
      // own MCP configurations — the kiosk build came up with 111 tools including the user's
      // Linear and ElevenLabs. Only what is declared here exists.
      ...(this.#skills.delegate !== undefined ? { skills: this.#skills.delegate } : {}),
      mcpServers: { [STUDIO_MCP_SERVER]: await this.#studioServer(request, interviewTools) },
      strictMcpConfig: true,
      allowedTools: allowedToolsFor(request, interviewTools),
      disallowedTools: disallowedToolsFor(request),
      // No sandbox key at all for a session that asks: Claude Code's default, which a game's own
      // project settings may still turn on. Every command it runs was asked about first.
      ...(asks ? {} : { sandbox: unattendedSandbox(request, protectedPaths) }),
      ...(directories.length ? { additionalDirectories: directories } : {}),
      ...(await this.#delegateSettings(request, rules)),
      // Only pin a config home when the studio owns the login; otherwise let Claude Code find
      // its own, so an existing sign-in on this Mac just works. The SDK env REPLACES the
      // subprocess environment, so the process.env spread must come first. The bg-wait
      // ceiling: a dev server the contractor left in a background shell would otherwise hold
      // the finished build open until the deadline — a minute after the main thread goes
      // idle, background shells get 5s of grace and the run ends. (0 means wait forever,
      // never that.)
      env: this.#sessionEnv(cliInstallation.env, login, { CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: BG_WAIT_CEILING_MS }),
      stderr: (data: string) => request.onEvent?.({ type: DelegateEventType.Stderr, payload: data }),
      abortController: controller,
    };
  }

  /** Where the contractor may reach: its workspace, the extra folders it reads, and what stays off limits. */
  async #contractorReach(request: DelegateRequest, login: ClaudeLogin): Promise<ContractorReach> {
    const cwd = path.resolve(request.cwd);
    const outsideCwd = (dir: string): boolean => !isInside(cwd, dir);
    const additional = (request.extraReads ?? []).map((dir) => path.resolve(dir)).filter(outsideCwd);
    // The folders the person granted this chat ("Yes, and allow access to …") join the reads.
    const granted = (asksOf(request)?.directories ?? []).map((dir) => path.resolve(dir)).filter(outsideCwd);
    // The config home this session's CLI uses: the studio's, the one the environment names, or
    // (the person's sign-in, or none) the CLI's default `~/.claude`.
    const configHome = login.home ?? this.systemHome;
    // SEC-3: both CLIs' sign-in homes, and the one this login borrows when it is not the
    // studio's own, are off limits to the contractor's tools like the studio's own secrets. The
    // session's own config home is not fenced whole, whatever the login: its credentials are
    // unreadable and its settings never edited (`protectedTargets`). A person's session reaches
    // the rest as Claude Code does in their terminal, asking; an unattended one only what the CLI
    // hands it (its plans, shell snapshot and environment, todos, this working folder's
    // project), in a few rules whatever the home holds (`homeFence`).
    const protectedPaths = [
      ...this.#protectedPaths,
      ...credentialHomes(login.source === LoginSource.Isolated ? [] : [configHome]),
      ...baseDenyRead(),
    ];
    // Every rule path is absolute, at Claude Code's `//` (claude-permissions.ts `absoluteRule`):
    // the `Read(/…/secrets/**)` these once were guarded `<cwd>/…/secrets` and nothing real.
    const rules = await permissionRules({
      protectedPaths,
      configHome,
      cwd,
      denyReads: request.denyReads ?? [],
      permissions: asksOf(request),
      // What the Claude home fence left readable, in the session's own log.
      warn: (message) => request.onEvent?.({ type: DelegateEventType.Stderr, payload: message }),
    });
    return { cwd, directories: [...new Set([...additional, ...granted])], protectedPaths, rules };
  }

  /**
   * The session's `settings`: the model preferences, the permission rules, the studio's rules for
   * Auto's classifier (a session that asks, in any mode: the picker can move it to Auto mid-turn)
   * and thinking summaries.
   */
  async #delegateSettings(request: DelegateRequest, rules: ContractorReach["rules"]): Promise<Record<string, unknown>> {
    return {
      settings: {
        ...(request.preferences ? await this.preferenceSettings(request.model, request.preferences) : {}),
        ...(Object.keys(rules).length ? { permissions: rules } : {}),
        // The chat's own session works in its game folder (the host checked), checkpointed before
        // each message; a lead or the coordinator answers for a build.
        ...(asksOf(request)
          ? { autoMode: autoModeRules({ cwd: path.resolve(request.cwd), gameFolder: Boolean(request.permissions) }) }
          : {}),
        // Current models return thinking blocks empty unless a summary is asked for; the chat
        // shows the summary under a collapsed "Thinking details". Display only.
        showThinkingSummaries: true,
      },
    };
  }

  /** The child environment: the subscription's, with Studio's config home when Studio owns the login. */
  #sessionEnv(
    installationEnv: NodeJS.ProcessEnv,
    login: ClaudeLogin,
    extra: Record<string, string> = {},
  ): Record<string, string> {
    return subscriptionEnv({
      ...installationEnv,
      ...extra,
      ...(login.source === LoginSource.Isolated ? { CLAUDE_CONFIG_DIR: this.engineHome } : {}),
    });
  }

  /** One message of the contractor's stream: what it tells the chat, the log and the run's state. */
  #observeMessage(message: Record<string, unknown>, run: RunState, request: DelegateRequest, stream: unknown): void {
    const type = String(message.type ?? "unknown");
    // A steer's receipt: `started` is the session reading it, in stream order (claude-steer.ts).
    if (type === SdkMessage.CommandLifecycle) {
      run.feed?.lifecycle(message, request.onEvent);
      return;
    }
    // Partial text is ephemeral UI traffic, never another durable conversation event.
    if (type === SdkMessage.StreamEvent && !message.parent_tool_use_id) {
      observePartialText(message, run, request);
      return;
    }
    if (type === SdkMessage.Assistant || type === SdkMessage.User) this.#observeTurn(message, run, request, stream);
    if (type === SdkMessage.System) this.#observeSystem(message, run, request, stream);
    const compacted = compactSdkMessage(message, request.cwd);
    // The log is the state and gets replayed constantly — mirror the story, not the
    // heartbeat. (The first build wrote ~1,200 `thinking_tokens` ticks into the log.)
    if (compacted !== null) request.onEvent?.({ type: type as MirroredSdkType, payload: compacted });
    if (type !== SdkMessage.Result) return;
    readResult(message as SdkResult, run);
    run.feed?.answered();
    // A string brief's input closes at the first result, a steered session's once it has answered
    // everything it read: a mode picked after that reaches nothing, and is for the next message.
    if (!run.feed || run.feed.ended) run.control.release();
  }

  /** An assistant or user message: one more turn, the interview's calls, the activity line. */
  #observeTurn(message: Record<string, unknown>, run: RunState, request: DelegateRequest, stream: unknown): void {
    const fromAssistant = message.type === SdkMessage.Assistant;
    run.turns++;
    if (fromAssistant && request.interviewTools?.length) recordStudioToolCalls(message, run, request.interviewTools);
    this.#reportActivity(message, run, request);
    if (!fromAssistant) return;
    this.#observeTelemetry(stream, request.onEvent, run.sessionId);
    // A subagent's request is its own context, not the one the session's next turn starts from.
    if (message.parent_tool_use_id) return;
    run.contextTokens = requestTokens(message) ?? run.contextTokens;
    // Whether the main thread's last word was the CLI's own API error: a later reply clears it.
    run.apiError = apiErrorOf(message);
  }

  /** A system message: the session's init, a compaction boundary, and a telemetry reading. */
  #observeSystem(message: Record<string, unknown>, run: RunState, request: DelegateRequest, stream: unknown): void {
    if (message.subtype === SdkSystemSubtype.Init) {
      readInit(message, run);
      run.feed?.initialized(message, Boolean(request.interviewTools?.length));
    }
    // The mode the session really runs in: Auto falls back to Manual where the plan or the model
    // cannot use it, and a plan approval or a picker change moves it mid-turn.
    const onMode = request.permissions?.onMode;
    if (onMode && reportsMode(message)) quietly(() => onMode(reportedMode(message)));
    if (message.subtype === SdkSystemSubtype.CompactBoundary) this.#reportCompaction(stream as object, run, request);
    if (message.subtype === SdkSystemSubtype.Status && message.compact_result === CompactOutcome.Failed) {
      run.compactError = String(message.compact_error ?? "") || MESSAGE.NotCompacted;
    }
    this.#observeTelemetry(stream, request.onEvent, run.sessionId);
  }

  /** The session compacted its context: the meter restarts, and the chat marks the boundary. */
  #reportCompaction(stream: object, run: RunState, request: DelegateRequest): void {
    this.#markCompaction(stream);
    run.usage.compactions = (run.usage.compactions ?? 0) + 1;
    run.contextTokens = undefined;
    request.onEvent?.({
      type: DelegateEventType.Context,
      payload: {
        engine: this.id,
        sessionId: run.sessionId,
        model: run.modelUsed,
        source: ContextSource.Provider,
        compacted: true,
      },
    });
  }

  /** The chat's activity line: a tool call when the reply holds one, thinking otherwise. */
  #reportActivity(message: Record<string, unknown>, run: RunState, request: DelegateRequest): void {
    const blocks = (message.message as { content?: Array<{ type?: string }> } | undefined)?.content;
    const callsATool = Array.isArray(blocks) && blocks.some((b) => b.type === SdkBlock.ToolUse);
    const phase =
      message.type === SdkMessage.Assistant && callsATool ? ChatActivityPhase.Tool : ChatActivityPhase.Thinking;
    request.onEvent?.({
      type: DelegateEventType.Activity,
      payload: { phase, sessionId: run.sessionId, engine: this.id },
    });
  }

  /**
   * How a build whose stream threw ends: an interruption or a known ending is an outcome to
   * report; a limit, a sign-in or anything unexplained is thrown for the run policy above.
   */
  #endingAfterThrow(
    err: unknown,
    run: RunState,
    request: DelegateRequest,
    partialState: () => PartialDelegateState,
  ): DelegateResult {
    // A stop or a spent time budget is an outcome, never an error: the contractor's finished
    // edits are on disk and the session id survives, so "Continue" picks up exactly here. The
    // two keep their own reasons, so the run policy and the chat can say "out of time" rather
    // than "you stopped it"; a user stop that raced the deadline still reads as the user's,
    // because their signal fired first.
    const aborted = request.signal?.aborted;
    if (aborted || run.deadlineHit) return this.#partial(interruption(aborted), partialState());
    const classified = this.#classify(err as Error);
    if (classified.kind === EngineFailureKind.Auth) this.#authFailure = classified.message;
    // A limit that arrived as an error result: the text names it, the throw does not. Read the
    // text before treating the throw as "some error" — a session limit must reach the run as
    // a rate limit (waitable, pausable), never as a plain failure.
    const limitInText = limitKind(String(run.errorText ?? run.summary ?? ""));
    if (limitInText) {
      const text = String(run.errorText ?? run.summary);
      throw new EngineError(limitInText, this.id, text, limitResetMs(text) ?? undefined);
    }
    // The SDK throws AFTER yielding an error result ("Claude Code returned an error result:
    // …"). If we already heard how the build ended, that throw adds nothing — return the
    // partial outcome instead of letting 61 turns of work on disk read as a crash. Auth and
    // rate limits still throw: their remedy (sign in / fall back) lives above us.
    if (run.errorSubtype !== null && classified.kind === EngineFailureKind.Other) {
      return this.#partial(
        { stopReason: run.errorSubtype, errorText: run.errorText ?? classified.message },
        partialState(),
      );
    }
    throw classified;
  }

  /** How a build whose stream ended on its own is reported, or the limit it hit thrown. */
  #finish(run: RunState, request: DelegateRequest, startedAt: number): DelegateResult {
    const signedOut = this.#signedOut({
      failed: !run.ok,
      errorSubtype: run.errorSubtype,
      apiError: run.apiError,
      text: String(run.errorText ?? run.summary ?? ""),
    });
    if (signedOut) {
      this.#authFailure = signedOut.message;
      throw signedOut;
    }
    if (run.ok) this.#authFailure = null;
    this.#throwIfLimited(run);
    const model = request.model ?? this.#model;
    const result: DelegateResult = {
      ok: run.ok,
      summary: run.summary,
      usage: run.usage,
      turns: run.turns,
      // D8: always the subscription — subscriptionEnv strips any ambient API key from the child,
      // so cost_usd is prepaid quota, never a metered bill nobody agreed to.
      billing: "subscription",
      engine: this.id,
      durationMs: Date.now() - startedAt,
      ...(run.modelUsed ? { model: run.modelUsed } : {}),
      cliPath: run.cliPath,
      ...(run.cliVersion ? { cliVersion: run.cliVersion } : {}),
      stopReason: run.ok ? StopReason.Completed : (run.errorSubtype ?? StopReason.Error),
      ...(model ? { requestedModel: model } : {}),
      ...(run.sessionId ? { sessionId: run.sessionId } : {}),
      ...(run.studioToolCalls.length ? { studioToolCalls: run.studioToolCalls } : {}),
      ...(!run.ok && run.errorText ? { errorText: run.errorText } : {}),
      ...(run.contextTokens ? { contextTokens: run.contextTokens } : {}),
    };
    return request.compact ? compactionResult(result, run) : result;
  }

  /**
   * A weekly/monthly cap won't reset within any run's lifetime — it must end the run with an
   * honest reason, not burn retry strikes. A session/5-hour limit resets within hours and stays a
   * rate_limit the loop can wait out. The CLI reports both only in the result TEXT
   * (is_error:true, subtype "success"), so classify by message, not subtype.
   */
  #throwIfLimited(run: RunState): void {
    if (run.ok) return;
    const limitText = String(run.errorText ?? run.summary ?? "");
    const limit = limitKind(limitText);
    if (limit === EngineFailureKind.UsageLimit) {
      throw new EngineError(EngineFailureKind.UsageLimit, this.id, limitText, limitResetMs(limitText) ?? undefined);
    }
    const limitSubtype = /limit/i.test(run.errorSubtype ?? "");
    if (limit === EngineFailureKind.RateLimit || limitSubtype) {
      // Surfaced, not swallowed: the run policy decides between pausing and falling back.
      throw new EngineError(
        EngineFailureKind.RateLimit,
        this.id,
        limitText || `Claude Code stopped: ${run.errorSubtype}`,
        limitResetMs(limitText) ?? undefined,
      );
    }
  }

  /** A build that ended early but left real work behind: an outcome to report, not an error. */
  #partial(ending: DelegateEnding, state: PartialDelegateState): DelegateResult {
    return partialDelegateResult(this.id, ending, state);
  }

  #classify(err: Error): EngineError {
    const text = `${err.message}`;
    // A spawn that fails before Claude Code starts is an install problem, not a build failure:
    // the bundled binary is missing (ENOENT) or the app bundle was rewritten under a running
    // instance so the SDK resolves a path inside a stale archive (ENOTDIR). Say so in words
    // the user can act on — two chat turns once died with a raw errno.
    if (SPAWN_FAILURE_PATTERN.test(text)) {
      const code = /ENOTDIR/.test(text) ? "ENOTDIR" : "ENOENT";
      return new EngineError(
        EngineFailureKind.Other,
        this.id,
        `Claude Code could not be started (${code}): the studio's bundled Claude Code binary is missing or the app was replaced while this window was open. Quit and reopen the studio, then try again. (${text})`,
      );
    }
    // Weekly/monthly caps end the run; session/5-hour limits stay waitable rate limits. Either
    // carries the reset its text names, so the host can resume the run after it.
    const resetMs = limitResetMs(text) ?? undefined;
    if (USAGE_LIMIT_PATTERN.test(text)) {
      return new EngineError(EngineFailureKind.UsageLimit, this.id, text, resetMs);
    }
    if (RATE_LIMIT_PATTERNS.some((re) => re.test(text))) {
      return new EngineError(EngineFailureKind.RateLimit, this.id, text, resetMs);
    }
    if (isSignInText(text)) return this.#signInError(text);
    return new EngineError(EngineFailureKind.Other, this.id, text);
  }

  /** A sign-in failure in the CLI's words, with what the user can do about it. */
  #signInError(text: string): EngineError {
    const hint = isAccessLost(text) ? MESSAGE.AccessLostHint : this.loginHint();
    return new EngineError(EngineFailureKind.Auth, this.id, `${text} — ${hint}`);
  }

  /**
   * A turn whose last word was the CLI's own API error saying the account cannot be used, as the
   * sign-in failure it is, or null. The CLI reports one as a `success` result flagged `is_error`
   * (or, by its code alone, as a plain success); read as an ordinary failed turn, a revoked account
   * would close the run and land an unchecked build. A limit in those words stays a limit
   * (`#throwIfLimited`).
   */
  #signedOut(ending: ApiErrorEnding): EngineError | null {
    if (!endedOnApiError(ending)) return null;
    const text = ending.text || ending.apiError || MESSAGE.JudgeFailed;
    if (SIGN_IN_ERRORS.has(ending.apiError)) return this.#signInError(text);
    if (limitKind(text) || !isSignInText(text)) return null;
    return this.#signInError(text);
  }
}

/** How a turn ended, as far as telling the CLI's own API error from the model's words goes. */
interface ApiErrorEnding {
  /** The result said the turn failed (`is_error`, or a failing subtype). */
  failed: boolean;
  /** The failure's stop reason: `StopReason.Error` when the result's own subtype was "success". */
  errorSubtype: string | null;
  /** The CLI's code on the main thread's last reply, when that reply was an API error. */
  apiError: string | null;
  text: string;
}

/**
 * Did the turn end on the CLI's own error message rather than on the model's words: a reply that
 * carried an API error code, or a failed result whose subtype still said "success" (the shape the
 * CLI gives an API error the turn could not get past)?
 */
function endedOnApiError(ending: ApiErrorEnding): boolean {
  if (ending.apiError !== null) return true;
  return ending.failed && ending.errorSubtype === StopReason.Error;
}

/** Does a CLI's error text say the sign-in no longer works: stale, missing, or the access taken away? */
function isSignInText(text: string): boolean {
  return AUTH_PATTERNS.some((re) => re.test(text)) || isAccessLost(text);
}

// ── one delegation's state, and the stream it is read from ─────────────────────────────────

type ClaudeInstallation = Awaited<ReturnType<typeof requireCodingCli>>;

/** Which login a session uses, and the home it lives in. */
interface ClaudeLogin {
  source: LoginSource;
  home: string | null;
}

/** What a delegation's session is started with, besides the request. */
interface SessionContext {
  cliInstallation: ClaudeInstallation;
  login: ClaudeLogin;
  controller: AbortController;
  /** The session once started, for what a person's answer asks of it afterwards. */
  running: RunningSession;
  /** What the delegation learns, including the summary a compaction's hook hands over. */
  run: RunState;
}

/** The folders a contractor session may reach, and the ones it may not. */
interface ContractorReach {
  /** The workspace, resolved. */
  cwd: string;
  /** Extra read folders outside the workspace, and the ones granted in a person's chat. */
  directories: string[];
  /** Folders its tools may neither read nor write. */
  protectedPaths: string[];
  /** Its settings' `permissions`: the saved allows of a person's session and the deny rules. */
  rules: { allow?: string[]; deny?: string[] };
}

/** An SDK message type this engine mirrors into the log. */
type MirroredSdkType =
  | typeof SdkMessage.Assistant
  | typeof SdkMessage.User
  | typeof SdkMessage.System
  | typeof SdkMessage.Result
  | typeof SdkMessage.RateLimitEvent;

/** The SDK's `result` message, the fields this engine reads. */
interface SdkResult {
  subtype?: string;
  is_error?: boolean;
  result?: string;
  num_turns?: number;
  total_cost_usd?: number;
  errors?: string[];
  /** The main loop's tokens for this result's turn only. */
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    /** The part of `output_tokens` that was thinking. */
    output_tokens_details?: { thinking_tokens?: number };
  };
  /** Every model the session called, as its running total: the latest result's replaces the last. */
  modelUsage?: Record<string, unknown>;
  duration_api_ms?: number;
  ttft_ms?: number;
}

/** One row of the SDK's `modelUsage`, the fields this engine reads. */
interface SdkModelUsage {
  inputTokens?: unknown;
  outputTokens?: unknown;
  thinkingTokens?: unknown;
  cacheReadInputTokens?: unknown;
  cacheCreationInputTokens?: unknown;
  costUSD?: unknown;
  contextWindow?: unknown;
}

/** What a judge said, on which model, at what cost. */
interface JudgeState {
  text: string;
  modelUsed: string | undefined;
  usage: Usage;
  /** The CLI's code on its last reply, when that reply was an API error (`SdkApiError`). */
  apiError: string | null;
}

/** Everything one delegation learns from its stream, in the order it learns it. */
interface RunState {
  turns: number;
  summary: string;
  ok: boolean;
  /** The result's own subtype when the build did not end well; "error" when it gave none. */
  errorSubtype: string | null;
  errorText: string | null;
  /** What actually ran, reported by the contractor's own init event. */
  modelUsed: string | undefined;
  cliPath: string;
  cliVersion: string | undefined;
  /** The vendor's session id — what `resume` takes to continue after a stop. */
  sessionId: string | undefined;
  /** The id of the reply whose text is streaming, for the chat's live row. */
  textStreamId: string;
  // Read off the message stream, not the MCP handler — the stream is the record that a fake
  // query in tests (and a resumed session in production) reproduces faithfully.
  studioToolCalls: NonNullable<DelegateResult["studioToolCalls"]>;
  usage: Usage;
  /** Set by the deadline timer: the abort that follows is the time budget's, not the user's. */
  deadlineHit: boolean;
  /** What the main loop's last request sent (`DelegateResult.contextTokens`); none after a compaction. */
  contextTokens: number | undefined;
  /** The turns every result so far counted: a steered session can answer in several results. */
  resultTurns: number;
  /** A steerable session's input and the messages it took (claude-steer.ts); null otherwise. */
  feed: SteerFeed | null;
  /** The mode picker's hold on the session, taken back once (claude-permissions.ts `liveControl`). */
  control: { release(): void };
  /** The summary Claude Code's `PostCompact` hook handed over; null until it compacted. */
  compactSummary: string | null;
  /** Why it did not compact, as its status message said; null when it did not say. */
  compactError: string | null;
  /** The CLI's code on the main thread's last reply, when that reply was an API error (`SdkApiError`). */
  apiError: string | null;
}

/** A delegation that has not heard anything from its contractor yet. */
function newRunState(usage: Usage, cliInstallation: ClaudeInstallation): RunState {
  return {
    turns: 0,
    summary: "",
    ok: false,
    errorSubtype: null,
    errorText: null,
    modelUsed: undefined,
    cliPath: cliInstallation.path,
    cliVersion: cliInstallation.status.version,
    sessionId: undefined,
    textStreamId: "",
    studioToolCalls: [],
    usage,
    deadlineHit: false,
    contextTokens: undefined,
    resultTurns: 0,
    feed: null,
    control: { release: () => {} },
    compactSummary: null,
    compactError: null,
    apiError: null,
  };
}

/** The wall-clock deadline, counted from `startedAt`; none without a time budget. */
function startDeadline(
  timeoutMs: number | undefined,
  startedAt: number,
  onExpire: () => void,
): ReturnType<typeof setTimeout> | null {
  if (!timeoutMs) return null;
  return setTimeout(onExpire, Math.max(0, timeoutMs - (Date.now() - startedAt)));
}

/** What a delegation cut short had done, for its partial result. */
function runPartialState(
  run: RunState,
  request: DelegateRequest,
  startedAt: number,
  defaultModel: string | undefined,
): PartialDelegateState {
  return {
    summary: run.summary,
    usage: run.usage,
    turns: run.turns,
    startedAt,
    studioToolCalls: run.studioToolCalls,
    cliPath: run.cliPath,
    cliVersion: run.cliVersion,
    sessionId: run.sessionId,
    model: run.modelUsed,
    requestedModel: request.model ?? defaultModel,
    contextTokens: run.contextTokens,
  };
}

/** A partial-stream event: the start of a reply names its stream, a text delta goes to the chat. */
function observePartialText(message: Record<string, unknown>, run: RunState, request: DelegateRequest): void {
  const partial = message.event as
    | { type?: string; message?: { id?: string }; delta?: { type?: string; text?: string } }
    | undefined;
  if (partial?.type === SdkBlock.MessageStart) run.textStreamId = partial.message?.id ?? "";
  const isTextDelta = partial?.type === SdkBlock.ContentBlockDelta && partial.delta?.type === SdkBlock.TextDelta;
  const delta = isTextDelta ? partial?.delta?.text : undefined;
  if (delta) {
    request.onEvent?.({ type: DelegateEventType.TextDelta, payload: { streamId: run.textStreamId, delta } });
  }
}

/** The Loop chat's bridged launch and question calls in an assistant message. */
function recordStudioToolCalls(message: Record<string, unknown>, run: RunState, bridged: StudioToolSpec[]): void {
  const blocks = (message as { message?: { content?: Array<Record<string, unknown>> } }).message?.content;
  // Only the bridged launch and question tools are records for the harness to execute; the
  // session's capture, plugin and connector calls ran already.
  const recorded = new Set(bridged.map((t) => studioToolName(t.name)));
  for (const block of Array.isArray(blocks) ? blocks : []) {
    const name = typeof block?.name === "string" ? block.name : "";
    if (block?.type !== SdkBlock.ToolUse || !recorded.has(name)) continue;
    run.studioToolCalls.push({
      name: name.slice(STUDIO_TOOL_PREFIX.length),
      args: (block.input as Record<string, unknown>) ?? {},
    });
  }
}

/** The session's init message: which model runs, on which CLI, in which session. */
function readInit(message: Record<string, unknown>, run: RunState): void {
  run.modelUsed = String(message.model ?? "") || undefined;
  run.cliVersion = typeof message.claude_code_version === "string" ? message.claude_code_version : run.cliVersion;
  run.sessionId = String(message.session_id ?? "") || undefined;
}

/** The session's result message: how the build ended, what it said, what it cost. */
function readResult(result: SdkResult, run: RunState): void {
  run.ok = result.is_error !== true && result.subtype === SDK_RESULT_SUCCESS;
  run.errorSubtype = resultErrorSubtype(result, run.ok);
  run.errorText = run.ok ? null : (result.errors ?? []).filter(Boolean).join("; ") || result.result || run.errorSubtype;
  run.summary = result.result ?? "";
  // A steered session can answer in several results, each counting only its own turns.
  if (typeof result.num_turns === "number") {
    run.resultTurns += result.num_turns;
    run.turns = run.resultTurns;
  }
  recordResultUsage(run.usage, result);
}

/**
 * The stop reason a result that did not end well carries. A limit-hit result arrives as
 * is_error:true with subtype "success" — never let that subtype leak into stop reasons
 * ("failed 3 turns in a row — last: success").
 */
function resultErrorSubtype(result: SdkResult, ok: boolean): string | null {
  if (ok) return null;
  if (result.subtype && result.subtype !== SDK_RESULT_SUCCESS) return result.subtype;
  return StopReason.Error;
}

/** The CLI's code on an assistant message that is an API error, or null for an ordinary reply. */
function apiErrorOf(message: Record<string, unknown>): string | null {
  return typeof message.error === "string" && message.error ? message.error : null;
}

/** Did the result report a failure, by flag or by subtype? */
function isFailedResult(result: SdkResult): boolean {
  if (result.is_error === true) return true;
  return Boolean(result.subtype) && result.subtype !== SDK_RESULT_SUCCESS;
}

/**
 * The tokens and cost a result reports, onto `usage`. The cost is the session's running total;
 * tokens are each result's own, so a steered session that answered twice adds them up. They are
 * the main loop's alone (the SDK's `usage`); every model the session called, subagents and
 * auxiliary calls included, is in `by_model` (its `modelUsage`).
 */
function recordResultUsage(usage: Usage, result: SdkResult): void {
  const reported = result.usage;
  if (typeof result.total_cost_usd === "number") usage.cost_usd = result.total_cost_usd;
  const add = (key: PerTurnUsageKey, value?: number) => {
    if (typeof value === "number") usage[key] = (usage[key] ?? 0) + value;
  };
  add("input_tokens", reported?.input_tokens);
  add("output_tokens", reported?.output_tokens);
  add("cache_read_tokens", reported?.cache_read_input_tokens);
  add("cache_write_tokens", reported?.cache_creation_input_tokens);
  add("reasoning_tokens", reported?.output_tokens_details?.thinking_tokens);
  recordSessionTotals(usage, result);
}

/** The `Usage` fields a result reports for its own turn, added up across a steered session's results. */
type PerTurnUsageKey =
  | "input_tokens"
  | "output_tokens"
  | "cache_read_tokens"
  | "cache_write_tokens"
  | "reasoning_tokens";

/**
 * What a result reports for the whole session so far: every model's tokens and the API's time
 * replace the last result's; the time to the first token is the first reply's, kept once known.
 */
function recordSessionTotals(usage: Usage, result: SdkResult): void {
  const byModel = modelTokenUsage(result.modelUsage);
  if (byModel) usage.by_model = byModel;
  if (isCount(result.duration_api_ms)) usage.duration_api_ms = result.duration_api_ms;
  if (isCount(result.ttft_ms)) usage.ttft_ms ??= result.ttft_ms;
}

/** The tokens one assistant reply's request sent, every input kind counted; null when it reported none. */
function requestTokens(message: Record<string, unknown>): number | null {
  const usage = (message.message as { usage?: Record<string, unknown> } | undefined)?.usage;
  if (!usage || !isCount(usage.input_tokens)) return null;
  const cached = [usage.cache_read_input_tokens, usage.cache_creation_input_tokens].filter(isCount);
  return cached.reduce((sum, tokens) => sum + tokens, usage.input_tokens);
}

/** A finite, non-negative number: a count or a duration a CLI can honestly have reported. */
function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** The SDK's `modelUsage` in `Usage`'s units; a row whose token counts are not counts is left out. */
function modelTokenUsage(reported: SdkResult["modelUsage"]): Usage["by_model"] | null {
  if (!reported || typeof reported !== "object") return null;
  const rows = Object.entries(reported).flatMap(([model, row]) => {
    const usage = modelRow(row as SdkModelUsage | null);
    return usage ? [[model, usage] as const] : [];
  });
  return rows.length ? Object.fromEntries(rows) : null;
}

/** One `modelUsage` row, or null when its four token counts are not all counts. */
function modelRow(row: SdkModelUsage | null): ModelTokenUsage | null {
  if (!row || typeof row !== "object") return null;
  const { inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens } = row;
  if (!isCount(inputTokens) || !isCount(outputTokens)) return null;
  if (!isCount(cacheReadInputTokens) || !isCount(cacheCreationInputTokens)) return null;
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_read_tokens: cacheReadInputTokens,
    cache_write_tokens: cacheCreationInputTokens,
    ...(isCount(row.thinkingTokens) ? { reasoning_tokens: row.thinkingTokens } : {}),
    ...(isCount(row.costUSD) ? { cost_usd: row.costUSD } : {}),
    ...(isCount(row.contextWindow) ? { context_window: row.contextWindow } : {}),
  };
}

/** The text blocks of an assistant message, in order. */
function assistantTexts(message: Record<string, unknown>): string[] {
  const content = (message as { message?: { content?: unknown } }).message?.content;
  if (!Array.isArray(content)) return [];
  const texts: string[] = [];
  for (const part of content as Array<{ type?: string; text?: string }>) {
    if (part?.type === SdkBlock.Text && part.text) texts.push(part.text);
  }
  return texts;
}

// ── what a session is given ────────────────────────────────────────────────────────────────

/** The model option: none for "default", which lets Claude Code pick its own. */
function modelOption(model: string | undefined): { model?: string } {
  return model && model !== DEFAULT_MODEL ? { model } : {};
}

/** The judge's prompt: plain text when there are no stills, one user message with them otherwise. */
function judgePrompt(request: CompleteRequest): unknown {
  const parts = claudeJudgeContent(request);
  const textOnly = parts.length === 1 && parts[0]?.type === SdkBlock.Text;
  if (textOnly) return (parts[0] as { type: "text"; text: string }).text;
  return (async function* () {
    yield {
      type: "user" as const,
      message: { role: "user" as const, content: parts },
      parent_tool_use_id: null,
    };
  })();
}

/**
 * What the session reads: a steerable one is fed through an input the delegation holds open
 * (claude-steer.ts), any other gets the brief. No uuid on the brief itself: the CLI reports
 * lifecycles only for messages that carry one, and the only ones this delegation tracks are steers.
 */
function sessionPrompt(
  request: DelegateRequest,
  steer: SteerSession | null,
  run: RunState,
  signal: AbortSignal,
): unknown {
  if (request.compact) return COMPACT_COMMAND;
  if (!steer) return delegatePrompt(request);
  run.feed = steerFeed(steer, userFrame(request.prompt, briefImages(request)), signal, () => run.sessionId);
  return run.feed.prompt;
}

/** The stills a brief carries. */
function briefImages(request: DelegateRequest): DelegateImage[] {
  return (request.images ?? []).filter((image) => image?.data);
}

/**
 * The builder's prompt. Stills go in as image blocks, the same content-block shape the judge uses
 * — a builder that never saw the reference read it nine times in 2,245 turns.
 */
function delegatePrompt(request: DelegateRequest): unknown {
  const images = briefImages(request);
  if (!images.length) return request.prompt;
  return (async function* () {
    yield userFrame(request.prompt, images);
  })();
}

/**
 * The session's PreToolUse hooks: the one that refuses an edit outside the facet's files, when the
 * delegation has an owner map, and a lead's or coordinator's screen (`leadScreenHook`), which sees
 * every tool call before Claude Code's own rules do.
 */
function sessionHooks(request: DelegateRequest, cwd: string, run: RunState): { hooks?: unknown } {
  const preToolUse = [
    ...(request.ownership ? [{ matcher: EDIT_TOOLS_MATCHER, hooks: [ownershipHook(request.ownership, cwd)] }] : []),
    ...(request.leadAsks ? [{ hooks: [leadScreenHook(request.leadAsks)] }] : []),
  ];
  const hooks = {
    ...(preToolUse.length ? { PreToolUse: preToolUse } : {}),
    ...(request.compact ? { [POST_COMPACT_HOOK]: [{ hooks: [compactSummaryHook(run)] }] } : {}),
  };
  return Object.keys(hooks).length ? { hooks } : {};
}

/** Keeps the summary Claude Code wrote when it compacted (`PostCompactHookInput.compact_summary`). */
function compactSummaryHook(run: RunState) {
  return async (input: { compact_summary?: unknown }): Promise<Record<string, never>> => {
    if (typeof input.compact_summary === "string") run.compactSummary = input.compact_summary;
    return {};
  };
}

/**
 * A Compact Now delegation's result: compacted when the session reported its compaction boundary,
 * with the summary it wrote; otherwise not ok, with the reason Claude Code gave.
 */
function compactionResult(result: DelegateResult, run: RunState): DelegateResult {
  if (!run.usage.compactions) {
    const errorText = run.compactError ?? result.errorText ?? MESSAGE.NotCompacted;
    return { ...result, ok: false, summary: "", stopReason: StopReason.Error, errorText };
  }
  return { ...result, ok: true, compacted: true, summary: compactSummaryText(run.compactSummary) };
}

/** The summary without the scratch analysis Claude Code's compaction prompt asks the model for first. */
function compactSummaryText(raw: string | null): string {
  const text = (raw ?? "").replace(/<analysis>[\s\S]*?<\/analysis>/g, "");
  const inner = /<summary>([\s\S]*?)<\/summary>/.exec(text)?.[1];
  return (inner ?? text).trim();
}

/**
 * The tools the session may call without asking. A bare "Bash" entry auto-approves the whole
 * tool. For an UNATTENDED session it has to be blanket: headless permission evaluation splits
 * compound commands into subcommands and denies them piecemeal, so `cd game && node --check
 * main.js` died even with the sandbox's auto-allow on. Safe only together with the sandbox shape — allowUnsandboxedCommands:
 * false makes the CLI ignore dangerouslyDisableSandbox entirely, so the blanket allow can never
 * step outside the sandbox. One authority: no parallel permissions.allow rules. A read-only
 * session (the playtester, a waking run's lead) is never allowed its shell by a blanket rule, and
 * has none at all unless it asks in the chat's mode (`leadAsks`, `disallowedToolsFor`).
 */
function allowedToolsFor(request: DelegateRequest, interviewTools: StudioToolSpec[]): string[] {
  return [
    studioToolName(StudioTool.Checkpoint),
    ...(request.onCapture ? [studioToolName(StudioTool.Capture)] : []),
    ...(request.onLiveTool ? (request.liveTools ?? []).map((t) => studioToolName(t.name)) : []),
    ...interviewTools.map((t) => studioToolName(t.name)),
    // A session that asks gets no blanket allow either: it has no sandbox, and a bare "Bash"
    // would silence the very question it exists to ask. Its standing allows are the rules the
    // person saved (settings `permissions.allow`).
    ...(request.readOnly || asksOf(request) ? [] : [SHELL_TOOL]),
    ...(researches(request) ? WEB_TOOLS : []),
  ];
}

/**
 * Research is part of the work: the chat, a director and its builders may search and read the
 * web, and so may a read-only lead or coordinator the person may talk to (`leadAsks`), the chat's
 * main agent. Another read-only session answers from what it was handed, and a
 * performance-optimization candidate (an isolated copy of the game) is measured against its
 * baseline alone.
 */
function researches(request: DelegateRequest): boolean {
  return (!request.readOnly || Boolean(request.leadAsks)) && !request.optimization;
}

/**
 * The tools the session never gets. A chat that may launch a build is still a full contractor:
 * it answers, researches or edits itself and launches only when the ask needs a build. A
 * read-only session (the playtester) may not even run a command. A read-only lead or coordinator
 * the person may talk to (`leadAsks`), the chat's main agent, keeps what the chat's own session
 * keeps, its helpers included; the chat's mode decides each call.
 */
function disallowedToolsFor(request: DelegateRequest): string[] {
  if (request.readOnly && request.leadAsks) return [...MESSAGING_TOOLS, ...ASKING_TOOLS];
  if (request.readOnly) return [...MESSAGING_TOOLS, ...EDIT_TOOLS, SHELL_TOOL, ...SUBAGENT_TOOLS, ...WEB_TOOLS];
  return [
    ...MESSAGING_TOOLS,
    ...(request.optimization ? [...SUBAGENT_TOOLS, ...WEB_TOOLS] : []),
    ...(asksOf(request) ? ASKING_TOOLS : []),
  ];
}

/** What the session asks with: the person's own session's permissions, or a lead's; none when unattended. */
function asksOf(request: DelegateRequest): DelegateAsks | undefined {
  return request.permissions ?? request.leadAsks;
}

/**
 * How the session is permitted. An unattended contractor edits inside a git-snapshotted
 * workspace, where every edit is recoverable, which is what makes acceptEdits defensible there. A
 * game chat's own session asks the person instead, in the mode they chose; a build's lead or the
 * run's coordinator asks from its chat's Auto, Accept edits or Bypass, or from Manual, and the host
 * answers (claude-permissions.ts). The picker switches either mid-turn.
 */
function permissionOptions(request: DelegateRequest, running: RunningSession): Record<string, unknown> {
  if (request.permissions) return askingOptions(request.permissions, running);
  if (request.leadAsks) return leadAskingOptions(request.leadAsks, running);
  return { permissionMode: "acceptEdits" };
}

/**
 * An unattended session's shell: sandboxed, auto-allowed only because it cannot step outside
 * (allowUnsandboxedCommands: false makes the CLI ignore dangerouslyDisableSandbox entirely), and
 * never writing the studio's protected folders or an optimization candidate's fence.
 */
function unattendedSandbox(request: DelegateRequest, protectedPaths: string[]): Record<string, unknown> {
  return {
    enabled: true,
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: false,
    filesystem: {
      denyWrite: [...protectedPaths, ...(request.optimization?.denyWrites ?? [])],
      denyRead: [...baseDenyRead(), ...(request.denyReads ?? []), ...protectedPaths],
    },
  };
}

/** A system message that says which mode the session runs in: its init, or a status that changed it. */
function reportsMode(message: Record<string, unknown>): boolean {
  if (message.subtype === SdkSystemSubtype.Init) return true;
  return message.subtype === SdkSystemSubtype.Status && message.permissionMode !== undefined;
}

/** The first Claude Code that knows Opus 5.5 (and resolves the `opus` alias to it). */
/** The default is always available; concrete models come only from the CLI. */
function claudeModelCatalog(): EngineModel[] {
  return [
    {
      id: DEFAULT_MODEL,
      label: "Claude Code default",
      contextWindow: 0,
      maxTokens: STANDARD_MAX_TOKENS,
      supportsTools: true,
      supportsVision: true,
      supportsThinking: true,
      efforts: [],
      note: "Uses the CLI default under Genex settings.",
    },
  ];
}

/** The environment variable that decides the login, when one does: a token first, then a config home. */
function loginVariable(): string | undefined {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return "CLAUDE_CODE_OAUTH_TOKEN";
  if (process.env.CLAUDE_CONFIG_DIR) return "CLAUDE_CONFIG_DIR";
  return undefined;
}

/**
 * D8: the studio runs on the user's subscription, never a metered API key. An ambient
 * ANTHROPIC_API_KEY in the inherited shell environment would silently flip the SDK to per-token
 * billing that no UI ever agreed to, so it is stripped from every child environment built here.
 * SEC-2: so is every other credential — another vendor's key, a GitHub or Genex token — except
 * the one sign-in variable Claude Code itself reads. `extra` is usually the resolved CLI's whole
 * environment, so it is filtered too, not laid over the result.
 */
function subscriptionEnv(extra: Record<string, string | undefined> = {}): Record<string, string> {
  return childEnv(
    { ...process.env, ...extra },
    { base: "contractor", vendor: "claude", keep: ["CLAUDE_CODE_OAUTH_TOKEN"] },
  );
}

// ── the studio's MCP tools ─────────────────────────────────────────────────────────────────

type ZodType = import("zod").ZodTypeAny;
/** What the tool builders need from the SDK and zod, loaded once per session. */
interface McpKit {
  tool: typeof import("@anthropic-ai/claude-agent-sdk").tool;
  z: typeof import("zod").z;
}
/** A tool's MCP answer: its text, then any pictures it came back with. */
type ToolAnswer = {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  isError?: boolean;
};

/** `checkpoint`: the contractor says the game just became worth seeing; the chat shows the note. */
function checkpointTool(kit: McpKit, onEvent: DelegateRequest["onEvent"]) {
  const { tool, z } = kit;
  return tool(
    StudioTool.Checkpoint,
    CHECKPOINT_TOOL.description,
    { note: z.string().describe(CHECKPOINT_TOOL.note) },
    async (args: { note: string }) => {
      const note = String(args.note ?? "").slice(0, CHECKPOINT_NOTE_CHARS);
      onEvent?.({ type: DelegateEventType.Checkpoint, payload: { note } });
      return { content: [{ type: "text" as const, text: CHECKPOINT_TOOL.reply }] };
    },
  );
}

/** `capture`: the contractor looks at its own build. */
function captureTool(kit: McpKit, onCapture: NonNullable<DelegateRequest["onCapture"]>) {
  const { tool, z } = kit;
  return tool(
    StudioTool.Capture,
    CLAUDE_CAPTURE_TOOL.description,
    {
      cameras: z.string().optional().describe(CLAUDE_CAPTURE_TOOL.cameras),
      page: z.string().optional().describe(CLAUDE_CAPTURE_TOOL.page),
    },
    async (args: { cameras?: string; page?: string }) => {
      try {
        const text = await onCapture(captureArgs(args));
        return { content: [{ type: "text" as const, text }] };
      } catch (err) {
        // The tool reports failure as a result marked failed — a thrown capture must not end the build.
        return { content: [{ type: "text" as const, text: `capture failed: ${errorMessage(err)}` }], isError: true };
      }
    },
  );
}

/**
 * A live tool answers during the session: the playtester presses a key and sees the state come
 * back. A thrown handler reports as text — a broken tool must not end the session.
 */
function liveTool(kit: McpKit, spec: LiveToolSpec, onLiveTool: NonNullable<DelegateRequest["onLiveTool"]>) {
  // A connector's tool carries its own JSON Schema — arrays, enums, nested objects — and that is
  // the shape the model must be shown. Every other live tool is still flat.
  const shape = spec.inputSchema ? zodShapeFromJsonSchema(spec.inputSchema, kit.z) : flatLiveShape(kit.z, spec);
  const description = spec.inputSchema ? describeWithSchema(spec.description, spec.inputSchema) : spec.description;
  return kit.tool(spec.name, description, shape, async (args: Record<string, unknown>) => {
    try {
      return liveToolAnswer(await onLiveTool(spec.name, args ?? {}));
    } catch (err) {
      return liveToolAnswer({ text: `${spec.name} failed: ${errorMessage(err)}`, isError: true });
    }
  });
}

/** A live tool's result as the MCP answer the contractor reads. */
function liveToolAnswer(result: LiveToolResult): ToolAnswer {
  const text = typeof result === "string" ? result : result.text;
  // A screenshot comes back as the picture itself — a path is not a picture.
  const images = typeof result !== "string" && result.images?.length ? result.images : [];
  const failed = typeof result !== "string" && result.isError === true;
  return {
    content: [
      { type: "text", text },
      ...images.map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mimeType })),
    ],
    ...(failed ? { isError: true } : {}),
  };
}

/** A flat live tool's parameters as zod fields, each with its declared type (PLG-2). */
function flatLiveShape(z: McpKit["z"], spec: LiveToolSpec): Record<string, ZodType> {
  const shape: Record<string, ZodType> = {};
  for (const [key, prop] of Object.entries(spec.parameters?.properties ?? {})) {
    const field = flatField(z, prop).describe(prop.description ?? "");
    shape[key] = spec.parameters?.required?.includes(key) ? field : field.optional();
  }
  return shape;
}

/**
 * PLG-2: the flat declaration's own types. A plugin's boolean or object parameter registered as a
 * string could only be sent as text, which the plugin registry refuses.
 */
function flatField(z: McpKit["z"], prop: { type: string; acceptJsonString?: boolean }): ZodType {
  switch (prop.type) {
    case "number":
      return z.number();
    case "integer":
      return z.number().int();
    case "boolean":
      return z.boolean();
    case "array":
      return z.array(z.unknown());
    case "object": {
      const object = z.record(z.string(), z.unknown());
      return prop.acceptJsonString ? z.union([object, z.string()]) : object;
    }
    default:
      return z.string();
  }
}

/**
 * Intake tools are declared by the harness as flat string schemas; the handler only acknowledges
 * — the authoritative call record is read off the message stream, and the harness executes the
 * real tool after the delegation returns.
 */
function intakeTool(kit: McpKit, spec: StudioToolSpec) {
  const { tool, z } = kit;
  const shape: Record<string, ZodType> = {};
  for (const [key, prop] of Object.entries(spec.parameters?.properties ?? {})) {
    const field = z.string().describe(prop.description ?? "");
    shape[key] = spec.parameters?.required?.includes(key) ? field : field.optional();
  }
  return tool(spec.name, spec.description, shape, async () => ({
    content: [{ type: "text" as const, text: intakeToolReply(spec.name) }],
  }));
}

/** How the SDK is told to start the selected Claude, as `query` options. */
export interface ClaudeLaunchOptions {
  pathToClaudeCodeExecutable: string;
  executable: "node";
  spawnClaudeCodeProcess?: (options: ClaudeSpawnOptions) => ClaudeSpawnedProcess;
}
type ClaudeSpawnOptions = import("@anthropic-ai/claude-agent-sdk").SpawnOptions;
type ClaudeSpawnedProcess = import("@anthropic-ai/claude-agent-sdk").SpawnedProcess;

/**
 * The SDK starts a native Claude binary directly, which Windows refuses for npm's `claude.cmd`:
 * there the SDK gets a spawner that goes through cmd.exe (`command-launch.ts`). The signal is not
 * handed to `spawn`, as the SDK asks: it stops the CLI by closing stdin first.
 */
export function claudeLaunchOptions(
  executable: string,
  platform: NodeJS.Platform = process.platform,
): ClaudeLaunchOptions {
  const options: ClaudeLaunchOptions = { pathToClaudeCodeExecutable: executable, executable: "node" };
  if (!isCommandScript(executable, platform)) return options;
  options.spawnClaudeCodeProcess = (spawnOptions) =>
    spawnCommand(spawnOptions.command, spawnOptions.args, {
      cwd: spawnOptions.cwd,
      env: spawnOptions.env,
      stdio: ["pipe", "pipe", "pipe"],
    }) as ClaudeSpawnedProcess;
  return options;
}

/**
 * The PreToolUse hook that enforces file ownership. Pure over its inputs; exported so
 * the conformance suite can prove what it blocks and what it lets through.
 */
export function ownershipHook(ownership: NonNullable<DelegateRequest["ownership"]>, cwd: string) {
  return async (input: unknown): Promise<Record<string, unknown>> => {
    const hook = input as { hook_event_name?: string; tool_name?: string; tool_input?: Record<string, unknown> };
    if (hook?.hook_event_name !== "PreToolUse") return {};
    const toolInput = hook.tool_input ?? {};
    const targets = [toolInput.file_path, toolInput.notebook_path, toolInput.path].filter(
      (v): v is string => typeof v === "string" && v.length > 0,
    );
    for (const target of targets) {
      const rel = relativeGamePath(target, cwd);
      if (rel === null) continue;
      if (rel === ".." || rel.startsWith("../"))
        return preToolDeny(`${target} is outside the workspace — this facet edits only its own files under ${cwd}.`);
      if (!allowedFile(rel, specOf(ownership), ownership.ownsMain)) return preToolDeny(ownershipReason(rel, ownership));
    }
    return {};
  };
}

/** Flatten a complete() request into Claude content blocks — text plus stills, never file paths. */
export function claudeJudgeContent(
  request: CompleteRequest,
): Array<
  { type: "text"; text: string } | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
> {
  const text = [request.systemPrompt, ...request.messages.map((message) => message.content)]
    .filter(Boolean)
    .join("\n\n");
  const parts: Array<
    { type: "text"; text: string } | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  > = [];
  if (text) parts.push({ type: "text", text });
  for (const message of request.messages) {
    for (const image of message.images ?? []) {
      if (!image.data) continue;
      parts.push({
        type: "image",
        source: { type: "base64", media_type: image.mimeType || "image/jpeg", data: image.data },
      });
    }
  }
  return parts;
}

/** System-message subtypes that carry information a person (or SkillOpt) would act on. */
const SYSTEM_SUBTYPES_WORTH_KEEPING = new Set<string>([
  SdkSystemSubtype.Init,
  SdkSystemSubtype.PermissionDenied,
  SdkSystemSubtype.CompactBoundary,
]);

/**
 * Keep the mirrored event small: the log is the state and we replay it constantly, so a
 * contractor's full message tree would bloat every prompt materialisation for no benefit.
 *
 * Returns `null` for heartbeat noise (`thinking_tokens` ticks, task-progress pings,
 * command-lifecycle chatter) — those are stream mechanics, not part of the build's story,
 * and the first live build wrote over a thousand of them into the log.
 */
export function compactSdkMessage(message: Record<string, unknown>, cwd?: string): unknown {
  const type = message.type;
  if (type === SdkMessage.Assistant || type === SdkMessage.User) {
    const inner = (message.message ?? {}) as { content?: unknown };
    const content = Array.isArray(inner.content) ? inner.content : [];
    return { role: type, parts: content.map((part: Record<string, unknown>) => compactPart(part, cwd)) };
  }
  if (type === SdkMessage.Result) {
    const result = message as SdkResult;
    return {
      subtype: result.subtype,
      num_turns: result.num_turns,
      total_cost_usd: result.total_cost_usd,
      result: clip(String(result.result ?? ""), TRACE_RESULT_CHARS),
    };
  }
  if (type === SdkMessage.System) return compactSystemMessage(message);
  if (type === SdkMessage.RateLimitEvent) return { type: SdkMessage.RateLimitEvent };
  return null;
}

/** One content block of an assistant or user message, as the log keeps it. */
function compactPart(part: Record<string, unknown>, cwd?: string): Record<string, unknown> {
  if (part.type === SdkBlock.Text) return { type: SdkBlock.Text, text: String(part.text ?? "") };
  // Reasoning is part of the record: the log keeps what the contractor was thinking, so the
  // morning report (and SkillOpt) can see *why* it did things, not just what it did.
  if (part.type === SdkBlock.Thinking) {
    return { type: SdkBlock.Thinking, text: clip(String(part.thinking ?? ""), TRACE_THINKING_CHARS) };
  }
  if (part.type === SdkBlock.ToolUse) {
    return { type: SdkBlock.ToolUse, name: part.name, id: part.id, input: summariseToolInput(part.input, cwd) };
  }
  if (part.type === SdkBlock.ToolResult) {
    return {
      type: SdkBlock.ToolResult,
      tool_use_id: part.tool_use_id,
      is_error: part.is_error === true,
      content: clip(toolResultText(part.content), TRACE_TOOL_RESULT_CHARS),
    };
  }
  return { type: String(part.type ?? "unknown") };
}

/** A tool result's text: the string itself, or its text blocks joined. */
function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((p) => p?.type === SdkBlock.Text)
    .map((p) => p.text)
    .join("\n");
}

/** A system message worth keeping (init, a denial, a compaction), or null for the rest. */
function compactSystemMessage(message: Record<string, unknown>): Record<string, unknown> | null {
  const system = message as {
    subtype?: string;
    model?: string;
    tools?: unknown[];
    session_id?: string;
    tool_name?: string;
    decision_reason?: string;
    message?: string;
  };
  if (!SYSTEM_SUBTYPES_WORTH_KEEPING.has(String(system.subtype ?? ""))) return null;
  if (system.subtype === SdkSystemSubtype.PermissionDenied) {
    // The first live build logged 9 bare denials — ~15% of its turns burned on workarounds
    // with no way to know why. Keep the SDK's whole story: which tool, whose decision, and
    // what the model was told, so denials are diagnosable instead of folklore.
    return {
      subtype: system.subtype,
      tool_name: system.tool_name ?? null,
      decision_reason: clip(String(system.decision_reason ?? ""), TRACE_DENIAL_CHARS) || null,
      message: clip(String(system.message ?? ""), TRACE_DENIAL_CHARS) || null,
    };
  }
  return {
    subtype: system.subtype,
    model: system.model,
    tools: (system.tools ?? []).length,
    // The session id is what "Continue" resumes — it must survive in the log.
    ...(system.session_id ? { session_id: system.session_id } : {}),
  };
}

/**
 * The one argument a human scans for — the file, the command, the pattern — clipped short.
 * Paths are shown relative to the game's workspace: the person reading the trace thinks in
 * "src/enemies.js", not in `/Users/…/Application Support/…/games/hi/src/enemies.js`.
 */
function summariseToolInput(input: unknown, cwd?: string): string {
  if (!input || typeof input !== "object") return "";
  const record = input as Record<string, unknown>;
  for (const key of ["file_path", "path", "command", "pattern", "query", "url", "prompt", "description"]) {
    const value = record[key];
    if (typeof value === "string" && value) return clip(relativizePaths(value, cwd), TRACE_TOOL_INPUT_CHARS);
  }
  const first = Object.values(record).find((value) => typeof value === "string" && value);
  return first ? clip(relativizePaths(String(first), cwd), TRACE_TOOL_INPUT_CHARS) : "";
}

/** Strip the workspace prefix wherever it appears — file args and inside shell commands alike. */
function relativizePaths(text: string, cwd?: string): string {
  // A bare reference to the workspace itself (e.g. `cd "<cwd>" && …`) becomes ".".
  return cwd ? relativizeWorkspace(text, cwd) : text;
}
