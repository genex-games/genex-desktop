import { realpath } from "node:fs/promises";
import { z } from "zod";
import { ModelCatalog, CatalogError, CATALOG_DEADLINE_MS } from "./model-catalog.ts";
import { ModelCatalogSource, ModelCatalogProblemCode } from "../../shared/model-catalog.ts";
import { readCodexModels } from "./codex-models.ts";
import { ReasoningEffort, supportedPreferences, type ModelPreferences } from "../../shared/model-preferences.ts";
import { cliVersion, requireCodingCli, resolveCodingCli, invalidateCodingCli } from "./external-cli.ts";
import { codexSessionMetadata, type CodexSessionMetadata } from "./codex-session.ts";
/**
 * Delegated engine — Codex on a ChatGPT subscription, the second
 * subscription the studio can hire.
 *
 * **Compliance boundary, restated because it constrains the code:** we do not route a consumer
 * subscription through a model API ourselves — that is prohibited. The sanctioned mechanic is
 * "your subscription, through their harness": we spawn the `codex` CLI, which performs its own
 * ChatGPT login and keeps its own credentials in its own home. The studio never sees, stores or
 * forwards a token. `CODEX_HOME` points at a dedicated home under `userData` when the studio
 * owns the login; that directory is on the sandbox's deny-read list for agent processes.
 * `CODEX_API_KEY`/`OPENAI_API_KEY` are stripped from every child environment built here, so a
 * key lying around in the user's shell can never flip this to a metered bill (the mirror of
 * what `claude-code.ts` does with `ANTHROPIC_API_KEY`).
 *
 * **Three things differ from the Claude Code path, and each is a deliberate choice:**
 *
 *  1. *Transport.* There is no SDK; the contract is `codex exec --json`, a JSONL event stream on
 *     stdout. Those events are translated here into the same compacted vocabulary the Claude
 *     path emits (`system/init`, `assistant` with `parts`, `result`), so the chat, the run graph
 *     and the morning review read a Codex build with no idea it was Codex.
 *  2. *Studio tools.* `codex exec` auto-denies MCP tool calls — a non-interactive session has
 *     nobody to approve them — and the only way round it is to give up the contractor's sandbox.
 *     Instead the studio's tools arrive as a command the contractor runs (`studio-bridge.ts`).
 *  3. *Ownership.* There is no `PreToolUse` hook to refuse a stray Write, so the facet's
 *     non-owned files are made read-only for the delegation (`ownership-locks.ts`) and the
 *     contractor's own sandbox does the refusing.
 */
import { spawnCommand } from "../command-launch.ts";
import {
  type CodexAppServer,
  type CodexAppServerConnection,
  type CodexCompaction,
  compactCodexThread,
  spawnCodexAppServer,
} from "./codex-app-server.ts";
import { stopChild } from "../process-tree.ts";
import { relativizeWorkspace } from "../paths.ts";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathExists } from "../fsx.ts";
import type { Usage } from "../types.ts";
import {
  codexAuthStatus,
  codexProfileArgs,
  codexSubscriptionEnv,
  readCodexRateLimits,
  refreshCodexCatalogue,
  type CodexAuthStatus,
} from "./codex-cli.ts";
import { credentialHomes } from "../credential-homes.ts";
import { neverTouchWhole, writableRoots } from "./never-touch.ts";
import { normalizeCodexUsage, type ProviderUsage } from "../../shared/provider-usage.ts";
import {
  type LockRecord,
  LOCK_RECOVERY_DIR,
  lockUnowned,
  ownershipBriefing,
  reapplyLocks,
  releaseLocks,
  releaseStaleLocks,
} from "./ownership-locks.ts";
import { StudioBridge, answerBridgeCall, bridgeTools } from "./studio-bridge.ts";

/** The bridge's tool list moved to `studio-bridge.ts`, shared with OpenCode; kept here for importers. */
export { bridgeTools };
import {
  type CompleteRequest,
  type CompleteResponse,
  type DelegateImage,
  DelegateEventType,
  type DelegateRequest,
  type DelegateResult,
  type Engine,
  EngineError,
  type EngineAccount,
  type EngineModel,
  type EngineStatus,
  ModelContextSource,
} from "./types.ts";
import {
  abortControllerFor,
  clip,
  COMPLETE_TIMEOUT_MS,
  hasCredentials,
  interruption,
  isAccessLost,
  type PartialDelegateState,
  partialDelegateResult,
  STOPPED_BY_USER,
  CompletionStop,
} from "./common.ts";
import { StudioTool, studioToolName } from "./studio-tool-prompts.ts";
import { limitResetMs } from "./limit-reset.ts";
import { JUDGE_RULES, offLimitsNote, planModeNote, readOnlyNote } from "./codex-prompts.ts";
import { engineMode, PermissionMode } from "../../shared/permissions.ts";
import { MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";
import { CodingCliState } from "../../shared/coding-cli.ts";
import { EngineId } from "../../shared/providers.ts";
import { EngineKind, EngineStatusCode, LoginSource } from "../../shared/engine-descriptor.ts";
import { ChatActivityPhase } from "../../shared/chat-activity.ts";
import { ContextSource } from "../../shared/context.ts";
import { EngineFailureKind, StopReason } from "../../shared/engine-requests.ts";

/**
 * Whether Codex may load the operator's host skills (`~/.agents/skills`). `suppress` is the eval
 * lane's (evals plan §5.3, lane D): every host skill disabled by path, and the computer-use and
 * browser features off, so no operator context reaches the lane. The app keeps them.
 */
export const HostSkills = {
  Keep: "keep",
  Suppress: "suppress",
} as const;
export type HostSkills = (typeof HostSkills)[keyof typeof HostSkills];

export interface CodexEngineOptions {
  /** `suppress`: the eval lane's host-skill and browser-feature suppression; unset keeps them. */
  hostSkills?: HostSkills;
  /** Where the host skills live; unset = `~/.agents/skills`. A test seam. */
  hostSkillsDir?: string;
  /**
   * Dedicated credential home, used when the studio signs into its own ChatGPT account. Its parent
   * is the studio's own folder: the host keeps its ownership-lock records beside the home.
   */
  engineHome: string;
  /**
   * Where Codex keeps its own credentials on this machine (`~/.codex`). If it is already signed
   * in there, the studio uses that login rather than asking for a second one: same person, same
   * subscription, same machine. We never read the credential — we simply do not override
   * `CODEX_HOME`, and the CLI finds its own.
   */
  systemHome?: string;
  /** Default model id; `undefined` means "whatever Codex is configured to use". */
  model?: string;
  /** Directories the contractor must never read (the studio's secrets, engine homes). */
  protectedPaths?: string[];
  /** The `codex` binary to spawn. Unset = host-owned external discovery. */
  executable?: string;
  resolveCli?: typeof resolveCodingCli;
  /** Injected in tests. */
  execFn?: CodexExec;
  /** Injected in tests: the app server Compact Now runs on (codex-app-server.ts). */
  appServerFn?: CodexAppServer;
  /** Injected catalog refresh; production delegates to the selected CLI. */
  refreshCatalogue?: typeof refreshCodexCatalogue;
  readModels?: typeof readCodexModels;
  onModelsChanged?: () => void;
  /** Injected in tests. Production asks the `codex` CLI, never a credential file. */
  authStatusFn?: (home: string | null) => Promise<CodexAuthStatus>;
  findBinaryFn?: () => Promise<string | null>;
}

/** One `codex exec` invocation, as an async stream of the CLI's own JSONL events. */
export type CodexExec = (invocation: {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  prompt: string;
  signal: AbortSignal;
  onStderr?: (chunk: string) => void;
}) => AsyncIterable<Record<string, unknown>>;

/**
 * Reasoning efforts the CLI's own enum accepts. The catalogue advertises `max` and `ultra` on
 * the newest models, but a CLI that predates them refuses the whole config line and the
 * delegation dies before it starts — so anything above the ceiling is clamped, not passed on.
 */
const CODEX_EFFORTS = [
  ReasoningEffort.Minimal,
  ReasoningEffort.Low,
  ReasoningEffort.Medium,
  ReasoningEffort.High,
  ReasoningEffort.Xhigh,
] as const;
/** Efforts Codex spells differently: the top two clamp to its ceiling, "auto" means the model's own. */
const EFFORT_ALIASES: Record<string, string> = {
  [ReasoningEffort.Max]: ReasoningEffort.Xhigh,
  [ReasoningEffort.Ultra]: ReasoningEffort.Xhigh,
  auto: "",
};

/** Plan limits move slowly; the composer rereads them at most once a minute. */
const USAGE_FRESH_MS = MINUTE_MS;
/** How long a sign-in check is trusted before `status()` asks the CLI again. */
const AUTH_CACHE_MS = 15 * SECOND_MS;
/** How often a running build's session file is read for its model, context and compactions. */
const METADATA_POLL_MS = 5 * SECOND_MS;
/** The end of stderr kept for a failure's explanation. */
const STDERR_TAIL_CHARS = 4_000;
/** How long a stopped CLI gets between SIGTERM and SIGKILL. */
const KILL_GRACE_MS = 5 * SECOND_MS;
/** The CLI command Compact Now's app server runs as (codex-app-server.ts). */
const APP_SERVER_COMMAND = "app-server";
/** The output cap every catalogue row advertises. */
const CODEX_MAX_TOKENS = 128_000;
/** The trace keeps this much of a thought, a tool result and a tool input. */
const TRACE_THINKING_CHARS = 2_000;
const TRACE_TOOL_RESULT_CHARS = 12_000;
const TRACE_TOOL_INPUT_CHARS = 96;
/** The model id that means "whatever Codex is configured to use": never passed on. */
const DEFAULT_MODEL = "default";
/** The file Codex keeps its sign-in in; only its presence is ever checked. */
const CREDENTIAL_FILE = "auth.json";
/** The marker a studio-connected profile leaves in the engine home, signed in or not. */
const STUDIO_LOGIN_MARKER = "studio-login.json";

/** A still's file name keeps at most this much of its label. */
const STILL_NAME_CHARS = 40;

/** The flags every `codex exec` runs with: JSONL out, any folder, none of the user's config. */
const CODEX_EXEC_FLAGS = ["--json", "--skip-git-repo-check", "--ignore-user-config"];

/** A critic's `codex exec`: ephemeral, read-only, never asking, inheriting no environment. */
const JUDGE_EXEC_ARGS = [
  "exec",
  ...CODEX_EXEC_FLAGS,
  "--ephemeral",
  "--sandbox",
  "read-only",
  "-c",
  'approval_policy="never"',
  // Nothing of the studio's environment travels into a critic: no paths, no tokens, no
  // hints about where the build it is judging lives.
  "-c",
  'shell_environment_policy.inherit="none"',
];

/** A command that calls a studio tool through the bridge, naming the tool. */
const STUDIO_BRIDGE_COMMAND = /(?:^|\s)node\s+\.studio\/bridge\/tool\.mjs\s+([a-z_][\w-]*)/i;
/** A spawn that failed before Codex started: the executable is missing or its path went stale. */
const SPAWN_FAILURE_PATTERN = /\bspawn\b.*\b(ENOTDIR|ENOENT)\b|\b(ENOTDIR|ENOENT)\b.*\bspawn\b/i;
/** A server error or a dropped connection: the service is unavailable, not the build broken. */
const UNAVAILABLE_PATTERN = /\b5\d\d\b|stream disconnected|connection (reset|closed)|timed? out/i;

/** `codex exec --json` event types, as the CLI spells them. Vendor wire values. */
const CodexEvent = {
  ThreadStarted: "thread.started",
  TurnCompleted: "turn.completed",
  TurnFailed: "turn.failed",
  Error: "error",
  ItemStarted: "item.started",
  ItemUpdated: "item.updated",
  ItemCompleted: "item.completed",
} as const;

/** The item types inside a Codex `item.*` event. */
const CodexItem = {
  AgentMessage: "agent_message",
  Reasoning: "reasoning",
  CommandExecution: "command_execution",
  FileChange: "file_change",
  McpToolCall: "mcp_tool_call",
  WebSearch: "web_search",
  Error: "error",
} as const;

/** Codex's `web_search` setting, as the CLI spells it: a worker's search is live or off. */
const CodexWebSearch = {
  Live: "live",
  Disabled: "disabled",
} as const;

/** Where a Codex item stands (`item.status`), as the CLI spells it. */
const CodexItemStatus = {
  Completed: "completed",
  Failed: "failed",
} as const;

/** The kind of one change in a `file_change` item that creates a file (the rest edit one). */
const FILE_CHANGE_ADD = "add";

/** Items that mean the session is using a tool, for the chat's activity line. */
const TOOL_ITEMS = new Set<string>([
  CodexItem.CommandExecution,
  CodexItem.McpToolCall,
  CodexItem.WebSearch,
  CodexItem.FileChange,
]);

/** What this engine says to the user: statuses, remedies and errors. */
const MESSAGE = {
  LoginHint: "Connect your ChatGPT subscription in the studio.",
  CliRequired: "An external Codex CLI is required.",
  InstallRemedy: "Install Codex, then check again.",
  IsolatedLogin: "ChatGPT connected for this studio",
  SystemLogin: "Using your existing ChatGPT sign-in on this Mac",
  ApiKeyLogin: "Codex is signed in with an API key. Connect your ChatGPT subscription instead.",
  NotConnected: "ChatGPT is not connected. Sign in to start building.",
  CheckFailed: "Could not check the Codex connection. Try again.",
  NoToolLoop: "Codex has no tool-loop completion; use engine.delegate to build",
  CliMissing: "An external Codex CLI is required. Install or select an external Codex CLI, then Recheck.",
  NotCompacted: "Codex did not compact the session",
} as const;

const RATE_LIMIT_PATTERNS = [/rate.?limit/i, /too many requests/i, /\b429\b/, /quota/i];
const USAGE_LIMIT_PATTERNS = [
  /(weekly|monthly).{0,16}limit/i,
  /usage limit reached/i,
  /limit.{0,30}resets [A-Z][a-z]{2} \d/i,
  /you'?ve hit your.{0,30}limit/i,
];
const AUTH_PATTERNS = [
  /not logged in/i,
  /unauthor/i,
  /authenticat/i,
  /credential/i,
  /session expired/i,
  /run `?codex login/i,
  /\b401\b/,
];

/** One model the picker offers, as the catalogue (the account's, or the studio's fallback) lists it. */
interface CatalogueRow {
  id: string;
  label: string;
  note?: string;
  efforts?: string[];
  defaultEffort?: string;
  contextWindow?: number;
  supportsFast?: boolean;
  hardLimitTokens?: number;
}

/** The first row of every catalogue: whatever model the user's Codex is configured for. */
const DEFAULT_ROW: CatalogueRow = {
  id: DEFAULT_MODEL,
  label: "Codex default",
  note: "Uses whatever model your Codex is configured for.",
  efforts: [],
};

function codexEngineModel(row: CatalogueRow): EngineModel {
  return {
    ...row,
    contextWindow: row.contextWindow ?? 0,
    contextSource: row.contextWindow ? ModelContextSource.Catalog : ModelContextSource.Unknown,
    maxTokens: CODEX_MAX_TOKENS,
    supportsTools: true,
    supportsVision: true,
    supportsThinking: true,
  };
}

export class CodexEngine implements Engine {
  readonly id = EngineId.Codex;
  readonly label = "Codex";
  readonly kind = EngineKind.Delegated;
  /** Compact Now compacts the resumed session on Codex's own app server (codex-app-server.ts). */
  readonly compactsNatively = true;
  readonly engineHome: string;
  readonly systemHome: string;
  readonly #lockRecovery: string;
  readonly #model: string | undefined;
  readonly #protectedPaths: string[];
  readonly #resolveCli: typeof resolveCodingCli;
  readonly #executable: string | undefined;
  #execFn: CodexExec | undefined;
  readonly #appServerFn: CodexAppServer | undefined;
  #authStatusFn: CodexEngineOptions["authStatusFn"];
  #findBinaryFn: CodexEngineOptions["findBinaryFn"];
  #binary: string | null | undefined;
  /** Set when a call failed on auth: credential *files* can exist while the session is stale. */
  #authFailure: string | null = null;
  #authCache: { at: number; status: EngineStatus } | null = null;
  #authProbe: Promise<EngineStatus> | null = null;
  readonly #refreshCatalogue: typeof refreshCodexCatalogue;
  readonly #catalog: ModelCatalog;
  readonly #readModels: typeof readCodexModels | undefined;
  #usage: ProviderUsage | null = null;
  #usageRead: Promise<ProviderUsage | null> | null = null;
  /** The host-skills folder whose skills every `codex exec` disables, or null when they are kept. */
  readonly #suppressedSkillsDir: string | null;

  constructor(options: CodexEngineOptions) {
    this.#suppressedSkillsDir =
      options.hostSkills === HostSkills.Suppress
        ? (options.hostSkillsDir ?? path.join(os.homedir(), HOST_SKILLS_DIR))
        : null;
    this.#catalog = new ModelCatalog(options.onModelsChanged);
    this.#readModels = options.readModels ?? (options.execFn || options.refreshCatalogue ? undefined : readCodexModels);
    this.engineHome = options.engineHome;
    this.systemHome = options.systemHome ?? path.join(os.homedir(), ".codex");
    this.#lockRecovery = path.join(path.dirname(this.engineHome), LOCK_RECOVERY_DIR);
    this.#model = options.model;
    this.#protectedPaths = options.protectedPaths ?? [];
    this.#executable = options.executable;
    this.#resolveCli = options.resolveCli ?? resolveCodingCli;
    this.#execFn = options.execFn;
    this.#appServerFn = options.appServerFn;
    this.#authStatusFn = options.authStatusFn;
    this.#refreshCatalogue = options.refreshCatalogue ?? (options.execFn ? async () => {} : refreshCodexCatalogue);
    this.#findBinaryFn = options.findBinaryFn;
  }

  /**
   * Settings' summary. Signing out of Studio's profile keeps the profile selected (see
   * resolveLogin), so it never silently falls back to a Terminal login of another account.
   */
  async account(): Promise<EngineAccount> {
    const found = this.#findBinaryFn
      ? null
      : await this.#resolveCli(EngineId.Codex, this.#executable).catch(() => null);
    const binary = found ? null : await this.#resolveBinary().catch(() => null);
    const version = cliVersion(found?.status.version);
    const login = await this.resolveLogin();
    return {
      source: login.source,
      ...(login.source === LoginSource.Env ? { variable: "CODEX_HOME" } : {}),
      afterSignOut: "signed-out",
      cli: {
        state: cliState(found, binary),
        path: found?.status.path ?? binary ?? undefined,
        ...(version ? { version } : {}),
      },
    };
  }

  /**
   * An explicitly selected studio profile wins, including while signed out. Legacy installs
   * retain environment/studio/system discovery until the user connects through the new UI.
   */
  async resolveLogin(): Promise<CodexLogin> {
    if (await pathExists(path.join(this.engineHome, STUDIO_LOGIN_MARKER)))
      return { source: LoginSource.Isolated, home: this.engineHome };
    if (process.env.CODEX_HOME) return { source: LoginSource.Env, home: process.env.CODEX_HOME };
    if (await hasCredentials(this.engineHome, CREDENTIAL_FILE))
      return { source: LoginSource.Isolated, home: this.engineHome };
    if (await hasCredentials(this.systemHome, CREDENTIAL_FILE))
      return { source: LoginSource.System, home: this.systemHome };
    return { source: LoginSource.None, home: null };
  }

  async #resolveBinary(): Promise<string | null> {
    if (this.#executable) return this.#executable;

    const find = this.#findBinaryFn ?? (await import("./codex-cli.ts")).findCodexBinary;
    this.#binary = await find();
    return this.#binary;
  }

  /** Cached native status, never inferred from files or a successful process spawn. */
  async status(): Promise<EngineStatus> {
    if (this.#authFailure) {
      return { code: EngineStatusCode.NeedsLogin, detail: this.#authFailure, remedy: this.loginHint() };
    }
    if (this.#authCache && Date.now() - this.#authCache.at < AUTH_CACHE_MS) return this.#authCache.status;
    return this.probeAuth();
  }

  loginHint(): string {
    return MESSAGE.LoginHint;
  }

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
    const installation = this.#findBinaryFn ? null : await this.#resolveCli(EngineId.Codex, this.#executable);
    if (installation && installation.status.state !== CodingCliState.Ready) {
      return {
        code:
          installation.status.state === CodingCliState.Missing ? EngineStatusCode.NotInstalled : EngineStatusCode.Error,
        detail: installation.status.detail,
      };
    }
    const binary = installation?.status.path ?? (await this.#resolveBinary());
    if (!binary) {
      return { code: EngineStatusCode.NotInstalled, detail: MESSAGE.CliRequired, remedy: MESSAGE.InstallRemedy };
    }
    const login = await this.resolveLogin();
    const home = login.home ?? this.systemHome;
    const cli = await (
      this.#authStatusFn ??
      ((home) => codexAuthStatus(home, { findBinary: async () => binary, env: installation?.env }))
    )(home);
    const connected = cli.loggedIn === true && cli.method === "chatgpt";
    if (connected) this.#authFailure = null;
    const status = connected ? connectedStatus(login) : notConnectedStatus(cli, this.loginHint());
    this.#authCache = { at: Date.now(), status };
    return status;
  }

  async recheckLogin(): Promise<EngineStatus> {
    invalidateCodingCli(EngineId.Codex);
    // Finish an earlier check before forcing a fresh result after login/logout.
    await this.#authProbe;
    this.#authFailure = null;
    this.#authCache = null;
    this.#usage = null;
    this.#catalog.invalidate();
    return this.probeAuth();
  }

  usageSnapshot = (): ProviderUsage | null => this.#usage;

  /** The plan's limits for the composer, read at most once a minute from the account itself. */
  async readUsage(): Promise<ProviderUsage | null> {
    if (this.#usage && Date.now() - Date.parse(this.#usage.measuredAt) < USAGE_FRESH_MS) return this.#usage;
    if (this.#usageRead) return this.#usageRead;
    this.#usageRead = (async () => {
      // A test double stands in for the CLI; it has no account to ask.
      if (this.#execFn) return null;
      const login = await this.resolveLogin();
      if (login.source === LoginSource.None) return null;
      const home = login.home ?? this.systemHome;
      const installation = await requireCodingCli(EngineId.Codex, this.#executable, undefined, false);
      const usage = normalizeCodexUsage(
        await readCodexRateLimits(
          installation.path,
          await codexProfileArgs(home),
          subscriptionEnv({ ...installation.env, CODEX_HOME: home }),
        ),
      );
      if (usage) this.#usage = usage;
      return usage ?? this.#usage;
    })()
      .catch(() => this.#usage)
      .finally(() => {
        this.#usageRead = null;
      });
    return this.#usageRead;
  }

  /**
   * The selected account's catalogue, refreshed through its CLI without a generation.
   * An unavailable catalogue offers only the explicit provider default. Reading it keeps the picker current
   * as OpenAI ships models, instead of freezing a table into this file.
   */
  catalogSnapshot = () => this.#catalog.snapshot();

  async models(): Promise<EngineModel[]> {
    void this.refreshModels().catch(() => {});
    return [codexEngineModel(DEFAULT_ROW), ...this.#catalog.models()];
  }

  async refreshModels(force = false): Promise<void> {
    const generation = this.#catalog.epoch();
    const installation = await this.#resolveCli(EngineId.Codex, this.#executable);
    if (installation.status.state !== CodingCliState.Ready) return;
    const login = await this.resolveLogin();
    if (generation !== this.#catalog.epoch()) return;
    const home = login.home ?? this.systemHome;
    const binary = installation.status.path;
    if (!binary) return;
    const identity = JSON.stringify([
      home,
      binary,
      await realpath(binary).catch(() => binary),
      installation.status.version,
    ]);
    if (generation !== this.#catalog.epoch()) return;
    await this.#catalog.refresh(
      identity,
      async () => {
        const deadline = Date.now() + CATALOG_DEADLINE_MS;
        if (this.#readModels) {
          try {
            const models = await this.#readModels(
              binary,
              await codexProfileArgs(home),
              subscriptionEnv({ ...installation.env, CODEX_HOME: home }),
            );
            return { models, source: ModelCatalogSource.Provider };
          } catch (error) {
            if (!(error instanceof CatalogError) || error.code !== ModelCatalogProblemCode.Unsupported) throw error;
          }
        }
        await this.#refreshCatalogue(binary, home, installation.env, Math.max(1, deadline - Date.now())).catch(
          () => {},
        );
        const rows = await readCodexCatalogue(home);
        if (!rows) throw new CatalogError(ModelCatalogProblemCode.Malformed, "The CLI model cache is unavailable.");
        return {
          models: rows.filter((row) => row.id !== DEFAULT_MODEL).map(codexEngineModel),
          source: ModelCatalogSource.Cache,
        };
      },
      force,
    );
  }

  /** The CLI config for the composer's preferences. Codex keeps its own window and compacts on its own. */
  async preferenceArgs(model: string | undefined, value?: ModelPreferences): Promise<string[]> {
    if (!value) return [];
    const descriptor = (await this.models()).find((m) => m.id === (model ?? this.#model ?? DEFAULT_MODEL));
    return supportedPreferences(value, descriptor ?? {}).fast ? ["-c", 'service_tier="fast"'] : [];
  }

  async defaultModel(): Promise<string | null> {
    return this.#model ?? null;
  }

  /**
   * Isolated one-shot for the critic. Not a second builder: a read-only sandbox in an empty temp
   * directory, no studio tools, no resume of a build session, and an environment it inherits
   * nothing from. Stills go in as `-i` image files — the same "look at the pictures" path the
   * local judge uses, spelled the way Codex spells it.
   *
   * **A known gap.** The Claude critic is toolless by construction —
   * `disallowedTools` takes Read, Bash and the rest away. Codex has no equivalent switch: its
   * shell tool cannot be removed, and `read-only` restrains writes, not reads. So the critic is
   * *told* what is off limits and started somewhere with nothing in it, rather than being
   * prevented at the boundary. Judge on both subscriptions and the panel is stronger for it.
   *
   * **The same gap, one step further: the CONTEXT this session inherits.** The Claude critic is
   * emptied at the boundary too (`settingSources: ["project"]`, `mcpServers: {}`, `skills: []`),
   * so nothing of the owner's own machine reaches a verdict. Codex has no equivalent switch
   * either. `--ignore-user-config` covers `$CODEX_HOME/config.toml` and nothing else; the CLI
   * still injects `$CODEX_HOME/AGENTS.md` as `# AGENTS.md instructions` and lists
   * `$CODEX_HOME/skills` in a `<skills_instructions>` block, and `CODEX_HOME` is the owner's own
   * `~/.codex` whenever the studio borrows their sign-in. `project_doc_max_bytes` does not reach
   * the global doc (0 and 1 both leave it whole) and there is no `skills` feature flag to
   * disable, so the same remedy applies as above: the critic is TOLD, in `JUDGE_RULES`, that
   * instructions it did not come here for are not part of the question.
   *
   * A third consequence of `--ephemeral`, for whoever reads a transcript census: a critic
   * session writes no rollout, so no per-role report built from session files can count one.
   */
  async complete(request: CompleteRequest): Promise<CompleteResponse> {
    if (request.tools?.length) {
      throw new EngineError(EngineFailureKind.Other, this.id, MESSAGE.NoToolLoop);
    }
    const cwd = await mkdtemp(path.join(os.tmpdir(), "studio-judge-"));
    const images = request.messages.flatMap((message) => message.images ?? []).filter((image) => image?.data);
    const imagePaths = await writeStills(
      cwd,
      images,
      (image, index) => `still-${index}.${extensionFor(image.mimeType)}`,
    );
    const prompt = [request.systemPrompt, ...request.messages.map((message) => message.content), ...JUDGE_RULES]
      .filter(Boolean)
      .join("\n\n");
    const model = pickModel(request.model ?? this.#model);
    const controller = abortControllerFor(request.signal);
    let ceilingHit = false;
    const ceiling = setTimeout(() => {
      ceilingHit = true;
      controller.abort();
    }, request.timeoutMs ?? COMPLETE_TIMEOUT_MS);

    const judge: JudgeState = { usage: emptyUsage(this.id), text: "", modelUsed: undefined, failure: null };
    try {
      const argv = [
        ...JUDGE_EXEC_ARGS,
        ...(model ? ["-m", model] : []),
        ...effortArgs(request.effort),
        ...(await this.preferenceArgs(request.model, request.preferences)),
        ...imageArgs(imagePaths),
        "-",
      ];
      for await (const event of await this.#exec({ argv, cwd, prompt, signal: controller.signal })) {
        readJudgeEvent(translateEvent(event, cwd), judge, request.onDelta);
      }
    } catch (err) {
      throw this.#judgeFailure(err, request, ceilingHit);
    } finally {
      clearTimeout(ceiling);
      await rm(cwd, { recursive: true, force: true }).catch(() => {});
    }
    if (judge.failure) throw this.#classify(new Error(judge.failure));

    return {
      message: { role: "assistant", content: judge.text },
      usage: judge.usage,
      stopReason: CompletionStop.Stop,
      model: judge.modelUsed ?? "unknown",
      engine: this.id,
    };
  }

  /** What a judge that did not answer threw: the caller's stop, the ceiling, or its own error. */
  #judgeFailure(err: unknown, request: CompleteRequest, ceilingHit: boolean): EngineError {
    if (request.signal?.aborted) return new EngineError(EngineFailureKind.Aborted, this.id, STOPPED_BY_USER);
    if (ceilingHit) {
      const ms = request.timeoutMs ?? COMPLETE_TIMEOUT_MS;
      const minutes = Math.round(ms / MINUTE_MS);
      return new EngineError(EngineFailureKind.Timeout, this.id, `the judge did not answer within ${minutes} min`);
    }
    return this.#classify(err as Error);
  }

  async delegate(request: DelegateRequest): Promise<DelegateResult> {
    if (request.compact) return this.#compact(request);
    const startedAt = Date.now();
    const cwd = path.resolve(request.cwd);
    const model = pickModel(request.model ?? this.#model);
    const controller = abortControllerFor(request.signal);
    const run = newCodexRun(this.id, request.resume);

    // A build left half-locked by an app that died keeps this workspace unwritable forever.
    await releaseStaleLocks(cwd, this.#lockRecovery).catch(() => {});
    const locks = request.ownership
      ? await lockUnowned(cwd, request.ownership, this.#lockRecovery).catch(() => null)
      : null;

    // A read-only session is started somewhere of its own, so the only folder its sandbox lets
    // it write is the studio's bridge — the build it is judging stays untouchable. A lead that is
    // its chat's own session is resumed from there by id (a Codex session is found by its id,
    // wherever it is started), and the chat resumes it from the game folder after the run.
    const { scratch, bridge } = await this.#openRunDir(request, cwd, locks);
    const runDir = scratch ?? cwd;
    // Interview tools are read off the bridge's own record — the authoritative list of what the
    // contractor asked the studio to do, in the order it asked. Read for every ending, not only
    // a clean one: the bridge told the contractor "the studio launches this when your reply
    // ends", and a deadline or a late error notice must not turn that promise into silence.
    const partialState = (): PartialDelegateState => ({
      ...runPartialState(run, startedAt, model),
      studioToolCalls: recordedCalls(bridge, request),
    });

    const stills = await writeDelegateStills(request.images ?? []);
    const prompt = await this.#delegatePrompt(request, { cwd, scratch, locks, bridge });
    const deadline = request.timeoutMs
      ? setTimeout(() => {
          run.deadlineHit = true;
          controller.abort();
        }, request.timeoutMs)
      : null;
    const metadata = this.#watchSessionMetadata(request, run, startedAt, model);
    try {
      const argv = await this.#delegateArgv(request, model, runDir, stills.paths);
      await this.#readStream(request, run, { argv, runDir, prompt, cwd, locks, model, signal: controller.signal });
      await metadata.refresh();
    } catch (err) {
      await metadata.refresh();
      return this.#endingAfterThrow(err, run, request, partialState);
    } finally {
      await metadata.stop();
      if (deadline) clearTimeout(deadline);
      await bridge?.close().catch(() => {});
      await releaseLocks(cwd, locks, this.#lockRecovery).catch(() => {});
      if (stills.dir) await rm(stills.dir, { recursive: true, force: true }).catch(() => {});
      if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => {});
    }

    // A killed CLI can close its stream normally; cancellation is not dependent on a throw.
    if (request.signal?.aborted || run.deadlineHit) {
      return partialDelegateResult(this.id, interruption(request.signal?.aborted), partialState());
    }
    if (run.failure) return this.#failedEnding(run.failure, run, partialState);

    this.#authFailure = null;
    return completedResult(this.id, run, { startedAt, model }, recordedCalls(bridge, request));
  }

  /**
   * Compact Now: the resumed session compacts itself on Codex's app server and goes on under the
   * same id. Its summary stays sealed inside the session, so the result carries none; the session
   * file's watcher reports the compaction as it reports an automatic one.
   */
  async #compact(request: DelegateRequest): Promise<DelegateResult> {
    const asked = { startedAt: Date.now(), model: pickModel(request.model ?? this.#model) };
    const controller = abortControllerFor(request.signal);
    const run = newCodexRun(this.id, request.resume);
    const deadline = request.timeoutMs
      ? setTimeout(() => {
          run.deadlineHit = true;
          controller.abort();
        }, request.timeoutMs)
      : null;
    const metadata = this.#watchSessionMetadata(request, run, asked.startedAt, asked.model);
    const interrupted = () => request.signal?.aborted || run.deadlineHit;
    let outcome: CodexCompaction;
    try {
      const server = await this.#appServer(path.resolve(request.cwd), controller.signal);
      outcome = await compactCodexThread(server, request.resume ?? "").finally(() => server.close());
      await metadata.refresh();
    } catch (err) {
      if (!interrupted()) throw this.#classify(err as Error);
      outcome = { compacted: false, error: null };
    } finally {
      await metadata.stop();
      if (deadline) clearTimeout(deadline);
    }
    const partial = runPartialState(run, asked.startedAt, asked.model);
    if (interrupted()) return partialDelegateResult(this.id, interruption(request.signal?.aborted), partial);
    if (!outcome.compacted) {
      const ending = { stopReason: StopReason.Error, errorText: outcome.error ?? MESSAGE.NotCompacted };
      return partialDelegateResult(this.id, ending, partial);
    }
    return { ...completedResult(this.id, run, asked, []), compacted: true };
  }

  /** The app server Compact Now runs on: the binary, sign-in and profile this engine's exec turns use. */
  async #appServer(cwd: string, signal: AbortSignal): Promise<CodexAppServerConnection> {
    const { home, env, installation } = await this.#cli(signal, Boolean(this.#appServerFn));
    const argv = [APP_SERVER_COMMAND, ...(await codexProfileArgs(home))];
    if (this.#appServerFn) return this.#appServerFn({ argv, cwd, env, signal });
    if (!installation?.path) throw new EngineError(EngineFailureKind.Unavailable, this.id, MESSAGE.CliMissing);
    return spawnCodexAppServer(installation.path)({ argv, cwd, env, signal });
  }

  /** The studio's bridge for this delegation's tools, when it grants any. */
  /**
   * Where the session runs and its bridge. A read-only session is started somewhere of its own,
   * so the only folder its sandbox lets it write is the studio's bridge. The locks and the scratch
   * folder are this call's: a bridge that cannot open (a planted `.studio`) must not leave the
   * game read-only until the next delegation.
   */
  async #openRunDir(
    request: DelegateRequest,
    cwd: string,
    locks: Awaited<ReturnType<typeof lockUnowned>> | null,
  ): Promise<{ scratch: string | null; bridge: StudioBridge | null }> {
    let scratch: string | null = null;
    try {
      if (startsElsewhere(request)) scratch = await mkdtemp(path.join(os.tmpdir(), "studio-playtest-"));
      return { scratch, bridge: await this.#openBridge(request, scratch ?? cwd) };
    } catch (err) {
      await releaseLocks(cwd, locks, this.#lockRecovery).catch(() => {});
      if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
  }

  async #openBridge(request: DelegateRequest, runDir: string): Promise<StudioBridge | null> {
    const tools = bridgeTools(request);
    if (!tools.length) return null;
    return StudioBridge.open({
      cwd: runDir,
      tools,
      onCall: async (name, args) => answerBridgeCall(name, args, request),
    });
  }

  /** The brief, plus what Codex can only be told: its tools, its seam, its folder, its limits. */
  async #delegatePrompt(
    request: DelegateRequest,
    ctx: { cwd: string; scratch: string | null; locks: OwnershipLocks | null; bridge: StudioBridge | null },
  ): Promise<string> {
    // Stills folders the user named, plus the run's own capture output: readable but not writable.
    // Codex's sandbox already grants read of the whole disk, so `extraReads` needs no flag; the
    // sibling games in `denyReads` are what a filesystem-level deny cannot express here, so they
    // are named in the brief instead — the same words the Claude path enforces with a rule.
    // SEC-3: both CLIs' sign-in homes and the one this login borrows are named with them. PH-4:
    // this is a brief, not a boundary — see "Residual risks" in docs/agent/architecture.md.
    const login = await this.resolveLogin();
    const offLimits = [
      ...this.#protectedPaths,
      ...credentialHomes(login.source === LoginSource.Isolated ? [] : [login.home]),
      ...(request.denyReads ?? []),
      // A worker's never-touch list: its box keeps it from writing there; its reads are the brief's.
      // Only the roots no folder it works in sits inside: its own copy under Genex's data is its own.
      ...(request.worker ? neverTouchWhole(request.worker.neverTouch) : []),
    ];
    // The rule is said whenever there is a seam to say, not only when a file happened to be
    // locked: a worktree whose unowned files were already read-only (or a game whose only
    // unowned files are lockfiles the locks leave alone) still has a seam the builder must
    // keep to, and it used to be told nothing at all.
    const hasSeam = request.ownership && (request.ownership.owns.length || ctx.locks?.files.length);
    const ownershipNote = hasSeam && request.ownership ? `\n\n${ownershipBriefing(request.ownership)}` : "";
    // A chat session in Plan is told it plans, not that it tests a build.
    const planScratch = chatMode(request) === PermissionMode.Plan ? ctx.scratch : null;
    return [
      request.prompt,
      ctx.bridge?.instructions() ?? "",
      ownershipNote,
      planScratch
        ? planModeNote(ctx.cwd, planScratch)
        : readOnlyNote(ctx.cwd, ctx.scratch, request.director ? path.resolve(request.director.root) : null),
      offLimitsNote(offLimits),
    ]
      .filter((part) => part?.trim())
      .join("\n\n");
  }

  /** `codex exec` (or `exec resume`) for this delegation: model, sandbox, effort, stills. */
  async #delegateArgv(
    request: DelegateRequest,
    model: string | undefined,
    runDir: string,
    imagePaths: string[],
  ): Promise<string[]> {
    return [
      "exec",
      ...(request.resume ? ["resume", request.resume] : []),
      ...CODEX_EXEC_FLAGS,
      ...(model ? ["-m", model] : []),
      ...sessionBox(request, runDir),
      ...effortArgs(request.effort),
      ...(await this.preferenceArgs(request.model, request.preferences)),
      ...imageArgs(imagePaths),
      "-",
    ];
  }

  /** The CLI's event stream, read to the end: the chat's live rows, the lock guard, the log. */
  async #readStream(request: DelegateRequest, run: CodexRun, stream: StreamContext): Promise<void> {
    const streamingItems = new Map<string, string>();
    const events = await this.#exec({
      onInstallation: (installation) => {
        run.cliPath = installation.path;
        run.cliVersion = installation.status.version;
      },
      argv: stream.argv,
      cwd: stream.runDir,
      prompt: stream.prompt,
      signal: stream.signal,
      onStderr: (chunk) => {
        run.stderrTail = `${run.stderrTail}${chunk}`.slice(-STDERR_TAIL_CHARS);
        request.onEvent?.({ type: DelegateEventType.Stderr, payload: chunk });
      },
    });
    for await (const event of events) {
      streamReplyText(event, streamingItems, request);
      this.#reportActivity(event, run, request);
      await this.#guardLocks(event, stream.cwd, stream.locks, request);
      const translated = translateEvent(event, stream.cwd);
      if (translated) applyTranslated(translated, run, request, stream.model);
    }
  }

  /** The chat's activity line: a tool starting, or the session thinking again after an item. */
  #reportActivity(event: Record<string, unknown>, run: CodexRun, request: DelegateRequest): void {
    const item = event.item as { type?: string } | undefined;
    if (event.type === CodexEvent.ItemStarted && TOOL_ITEMS.has(item?.type ?? "")) {
      request.onEvent?.({
        type: DelegateEventType.Activity,
        payload: { phase: ChatActivityPhase.Tool, sessionId: run.sessionId, engine: this.id },
      });
    }
    if (event.type === CodexEvent.ItemCompleted) {
      request.onEvent?.({
        type: DelegateEventType.Activity,
        payload: { phase: ChatActivityPhase.Thinking, sessionId: run.sessionId, engine: this.id },
      });
    }
  }

  /**
   * A contractor that tries to unlock a file it does not own gets the lock straight back — the
   * re-apply usually lands between its `chmod` and its write — and the attempt itself goes into
   * the log, where the reviewer and SkillOpt can see it. It is a narrower wall than Claude's
   * edit-time hook, and it is meant to be read as one.
   */
  async #guardLocks(
    event: Record<string, unknown>,
    cwd: string,
    locks: OwnershipLocks | null,
    request: DelegateRequest,
  ): Promise<void> {
    const unlock = chmodTarget(event);
    if (!unlock || !locks?.files.some((entry) => unlock.includes(entry.file))) return;
    await reapplyLocks(cwd, locks).catch(() => {});
    request.onEvent?.({
      type: DelegateEventType.System,
      payload: {
        subtype: "permission_denied",
        tool_name: "chmod",
        decision_reason: `${unlock} is not this facet's to edit — the studio put the lock back.`,
        message: null,
      },
    });
  }

  /**
   * Codex writes the session's model, CLI version, context and compactions to its own session
   * file. This reads it every few seconds while the build runs (and on demand at the end),
   * reporting each new context reading and each compaction once.
   */
  #watchSessionMetadata(
    request: DelegateRequest,
    run: CodexRun,
    startedAt: number,
    model: string | undefined,
  ): MetadataWatcher {
    let inFlight: Promise<void> | undefined;
    const stamps = { context: "", compactions: new Set<string>() };
    const refresh = async (): Promise<void> => {
      if (!run.sessionId) return;
      if (inFlight) return inFlight;
      const pending = this.#readSessionMetadata(request, run, { sessionId: run.sessionId, startedAt, model, stamps })
        .catch(() => {})
        .finally(() => {
          if (inFlight === pending) inFlight = undefined;
        });
      inFlight = pending;
      return pending;
    };
    const timer = setInterval(() => void refresh(), METADATA_POLL_MS);
    timer.unref();
    return {
      refresh,
      stop: async () => {
        clearInterval(timer);
        await inFlight;
      },
    };
  }

  /** One read of the session file: the model and CLI it names, a new compaction, a new context reading. */
  async #readSessionMetadata(request: DelegateRequest, run: CodexRun, read: MetadataRead): Promise<void> {
    const home = (await this.resolveLogin()).home ?? this.systemHome;
    const metadata = await codexSessionMetadata(home, read.sessionId, read.startedAt);
    run.modelUsed ??= metadata.model;
    run.cliVersion = metadata.cliVersion ?? run.cliVersion;
    // A compaction's reading names no prompt size: the context it measured is gone.
    if (metadata.context) run.contextTokens = metadata.context.promptTokens;
    const reading = {
      engine: this.id,
      sessionId: read.sessionId,
      model: run.modelUsed,
      requestedModel: read.model ?? null,
    };
    for (const compact of newCompactions(metadata, read)) {
      run.usage.compactions = (run.usage.compactions ?? 0) + 1;
      request.onEvent?.({
        type: DelegateEventType.Context,
        payload: {
          ...reading,
          source: ContextSource.ProviderSession,
          compacted: true,
          compactionId: compact.id,
          measuredAt: compact.at,
          lastCompactedAt: compact.at,
        },
      });
    }
    const stamp = JSON.stringify(metadata.context);
    if (metadata.context && stamp !== read.stamps.context) {
      read.stamps.context = stamp;
      request.onEvent?.({ type: DelegateEventType.Context, payload: { ...reading, ...withPercent(metadata.context) } });
    }
  }

  /** How a build whose stream threw ends: an interruption is an outcome; anything else is thrown. */
  #endingAfterThrow(
    err: unknown,
    run: CodexRun,
    request: DelegateRequest,
    partialState: () => PartialDelegateState,
  ): DelegateResult {
    // A spent time budget is an outcome, never a crash: the edits are on disk and the session
    // id survives for "Continue". A user stop that raced the deadline still reads as the user's.
    const aborted = request.signal?.aborted;
    if (aborted || run.deadlineHit) return partialDelegateResult(this.id, interruption(aborted), partialState());
    const classified = this.#classify(err as Error, run.stderrTail);
    if (classified.kind === EngineFailureKind.Auth) this.#authFailure = classified.message;
    throw classified;
  }

  /** A turn the CLI reported as failed: a limit or a sign-in is thrown, anything else reported. */
  #failedEnding(failure: string, run: CodexRun, partialState: () => PartialDelegateState): DelegateResult {
    const classified = this.#classify(new Error(failure), run.stderrTail);
    if (classified.kind === EngineFailureKind.Auth) this.#authFailure = classified.message;
    // A limit or a dead session is the run policy's business — pausing and signing in live
    // above us. Anything else left real work on disk and reports as an outcome.
    if (classified.kind !== EngineFailureKind.Other) throw classified;
    return partialDelegateResult(this.id, { stopReason: StopReason.Error, errorText: failure }, partialState());
  }

  async #exec(invocation: {
    argv: string[];
    cwd: string;
    prompt: string;
    signal: AbortSignal;
    onStderr?: (chunk: string) => void;
    onInstallation?: (installation: CodexInstallation) => void;
  }): Promise<AsyncIterable<Record<string, unknown>>> {
    const { home, env, installation } = await this.#cli(invocation.signal, Boolean(this.#execFn));
    // --ignore-user-config must not make a keychain login fall back to file-only auth.
    // Codex discards root -c values when exec/resume has its own -c options.
    // All overrides must be in the leaf command, before the stdin prompt argument.
    const argv = [
      ...invocation.argv.slice(0, -1),
      ...(await codexProfileArgs(home)),
      ...(await hostSkillArgs(this.#suppressedSkillsDir)),
      ...DISABLED_FEATURE_ARGS,
      invocation.argv.at(-1) ?? "-",
    ];
    if (this.#execFn) return this.#execFn({ ...invocation, argv, env });
    const binary = installation?.path;
    if (!binary) throw new EngineError(EngineFailureKind.Unavailable, this.id, MESSAGE.CliMissing);
    if (installation) invocation.onInstallation?.(installation);
    return streamCodex(binary, { ...invocation, argv, env });
  }

  /**
   * The CLI a session runs on, the sign-in home it runs under and the environment that carries
   * it. No installation is looked up when a test injected the process.
   */
  async #cli(
    signal: AbortSignal,
    injected: boolean,
  ): Promise<{ home: string; env: Record<string, string>; installation: CodexInstallation | null }> {
    const login = await this.resolveLogin();
    const home = login.home ?? this.systemHome;
    signal.throwIfAborted();
    const installation = injected ? null : await requireCodingCli(EngineId.Codex, this.#executable, signal);
    signal.throwIfAborted();
    return { home, env: subscriptionEnv({ ...installation?.env, CODEX_HOME: home }), installation };
  }

  #classify(err: Error, extra = ""): EngineError {
    const text = `${err.message}\n${extra}`.trim();
    if (SPAWN_FAILURE_PATTERN.test(text)) {
      return new EngineError(
        EngineFailureKind.Unavailable,
        this.id,
        `Codex could not be started. The external executable is missing or changed. Recheck the installation or choose its new path. (${text})`,
      );
    }
    // A weekly cap won't reset within any run's lifetime — it must end the run with an honest
    // reason, not burn retry strikes. A shorter window stays a rate limit the loop can wait out.
    // Either carries the wait its text names ("try again in 1 hour 30 minutes"), so the run can
    // wait it out and the host can resume a paused run after it.
    const resetMs = limitResetMs(text) ?? undefined;
    if (USAGE_LIMIT_PATTERNS.some((re) => re.test(text))) {
      return new EngineError(EngineFailureKind.UsageLimit, this.id, text, resetMs);
    }
    if (RATE_LIMIT_PATTERNS.some((re) => re.test(text))) {
      return new EngineError(EngineFailureKind.RateLimit, this.id, text, resetMs);
    }
    // A sign-in gone stale, or the account's access taken away (the table both engines share).
    if (AUTH_PATTERNS.some((re) => re.test(text)) || isAccessLost(text)) {
      return new EngineError(EngineFailureKind.Auth, this.id, `${text} — ${this.loginHint()}`);
    }
    if (UNAVAILABLE_PATTERN.test(text)) return new EngineError(EngineFailureKind.Unavailable, this.id, text);
    return new EngineError(EngineFailureKind.Other, this.id, text);
  }
}

// ── one delegation's state ─────────────────────────────────────────────────────────────────

type CodexInstallation = Awaited<ReturnType<typeof requireCodingCli>>;
type OwnershipLocks = LockRecord;

/** Which login a session uses, and the home it lives in. */
interface CodexLogin {
  source: LoginSource;
  home: string | null;
}

/** Everything one delegation learns from the CLI, in the order it learns it. */
interface CodexRun {
  usage: Usage;
  turns: number;
  /** The last agent message — the build's own summary of what it did. */
  summary: string;
  sessionId: string | undefined;
  modelUsed: string | undefined;
  cliVersion: string | undefined;
  cliPath: string | undefined;
  failure: string | null;
  /** Codex reports a stop as a failed turn; the last stderr line is usually the real reason. */
  stderrTail: string;
  /** Set by the deadline timer: the abort that follows is the time budget's, not the user's. */
  deadlineHit: boolean;
  /** The last request's prompt size the session file reported (`DelegateResult.contextTokens`). */
  contextTokens: number | undefined;
}

/**
 * A delegation that has not heard anything from the CLI yet. A resumed session is that session
 * from the start: a stop that lands before `thread.started` (the host interrupting to steer, or
 * the person) must still hand back what Continue resumes.
 */
function newCodexRun(engine: string, resume: string | undefined): CodexRun {
  return {
    usage: emptyUsage(engine),
    turns: 0,
    summary: "",
    sessionId: resume,
    modelUsed: undefined,
    cliVersion: undefined,
    cliPath: undefined,
    failure: null,
    stderrTail: "",
    deadlineHit: false,
    contextTokens: undefined,
  };
}

/** What a delegation cut short had done, for its partial result (the recorded calls are added by the caller). */
function runPartialState(run: CodexRun, startedAt: number, model: string | undefined): PartialDelegateState {
  return {
    summary: run.summary,
    usage: run.usage,
    turns: run.turns,
    startedAt,
    sessionId: run.sessionId,
    model: run.modelUsed,
    requestedModel: model,
    cliVersion: run.cliVersion,
    cliPath: run.cliPath,
    contextTokens: run.contextTokens,
  };
}

/** A build whose turn completed: what it did, on which model and CLI, and the launches it asked for. */
function completedResult(
  engine: string,
  run: CodexRun,
  asked: { startedAt: number; model: string | undefined },
  studioToolCalls: NonNullable<DelegateResult["studioToolCalls"]>,
): DelegateResult {
  return {
    ok: true,
    summary: run.summary,
    usage: run.usage,
    turns: run.turns,
    billing: "subscription",
    engine,
    durationMs: Date.now() - asked.startedAt,
    ...(run.modelUsed ? { model: run.modelUsed } : {}),
    ...(run.cliPath ? { cliPath: run.cliPath } : {}),
    ...(run.cliVersion ? { cliVersion: run.cliVersion } : {}),
    stopReason: StopReason.Completed,
    ...(asked.model ? { requestedModel: asked.model } : {}),
    ...(run.sessionId ? { sessionId: run.sessionId } : {}),
    ...(studioToolCalls.length ? { studioToolCalls } : {}),
    ...(run.contextTokens ? { contextTokens: run.contextTokens } : {}),
  };
}

/** The interview calls the bridge recorded: the studio's own tools are not calls to run. */
function recordedCalls(
  bridge: StudioBridge | null,
  request: DelegateRequest,
): NonNullable<DelegateResult["studioToolCalls"]> {
  return (bridge?.calls ?? [])
    .filter((call) => call.name !== StudioTool.Checkpoint && call.name !== StudioTool.Capture)
    .filter((call) => (request.interviewTools ?? []).some((tool) => tool.name === call.name));
}

/** What the stream reader needs besides the request. */
interface StreamContext {
  argv: string[];
  runDir: string;
  prompt: string;
  cwd: string;
  locks: OwnershipLocks | null;
  model: string | undefined;
  signal: AbortSignal;
}

/** The session-file poller: read now, or stop and wait for the read in flight. */
interface MetadataWatcher {
  refresh(): Promise<void>;
  stop(): Promise<void>;
}

/** One session-file read: whose session, since when, and what was last reported. */
interface MetadataRead {
  sessionId: string;
  startedAt: number;
  model: string | undefined;
  /** The last context reading reported, and every compaction already seen. */
  stamps: { context: string; compactions: Set<string> };
}

/**
 * The compactions this read found that no earlier one did and that happened during this build:
 * two between polls are two boundaries, and a boundary followed by a token count is still one.
 * Reopening an old session records the compactions it already had, without announcing them.
 */
function newCompactions(metadata: CodexSessionMetadata, read: MetadataRead): Array<{ id: string; at: string }> {
  const found: Array<{ id: string; at: string }> = [];
  for (const compact of metadata.compactions ?? []) {
    if (read.stamps.compactions.has(compact.id)) continue;
    read.stamps.compactions.add(compact.id);
    if (Date.parse(compact.at) >= read.startedAt) found.push(compact);
  }
  return found;
}

/** A session-file context reading, with the share of the window it fills when the CLI named the window. */
function withPercent<T extends { promptTokens?: number; contextWindow?: number }>(
  context: T,
): T & { percent?: number } {
  const { promptTokens, contextWindow } = context;
  const windowKnown = typeof contextWindow === "number" && contextWindow > 0;
  if (typeof promptTokens !== "number" || !windowKnown) return context;
  return { ...context, percent: Math.min(100, Math.max(0, (100 * promptTokens) / contextWindow)) };
}

/** What a judge said, on which model, at what cost, and whether its turn failed. */
interface JudgeState {
  usage: Usage;
  text: string;
  modelUsed: string | undefined;
  failure: string | null;
}

/** One translated event of the judge's stream, folded into what the judge said. */
function readJudgeEvent(translated: Translated | null, judge: JudgeState, onDelta: CompleteRequest["onDelta"]): void {
  if (!translated) return;
  if (translated.model) judge.modelUsed = translated.model;
  if (translated.text) {
    judge.text += (judge.text ? "\n" : "") + translated.text;
    onDelta?.(translated.text);
  }
  if (translated.usage) mergeUsage(judge.usage, translated.usage);
  if (translated.failure) judge.failure = translated.failure;
  if (translated.completed) judge.failure = null;
}

/**
 * The reply the user is watching arrive: Codex re-sends an agent message's whole text on every
 * update, so only what is new goes to the chat (or all of it, when the text was rewritten).
 */
function streamReplyText(
  event: Record<string, unknown>,
  streamingItems: Map<string, string>,
  request: DelegateRequest,
): void {
  const item = event.item as CodexTextItem | undefined;
  const updating = event.type === CodexEvent.ItemUpdated || event.type === CodexEvent.ItemStarted;
  if (updating && isReplySoFar(item)) {
    const previous = streamingItems.get(item.id) ?? "";
    const replace = !item.text.startsWith(previous);
    const delta = replace ? item.text : item.text.slice(previous.length);
    if (delta) {
      request.onEvent?.({ type: DelegateEventType.TextDelta, payload: { streamId: item.id, delta, replace } });
    }
    streamingItems.set(item.id, item.text);
  }
  if (event.type === CodexEvent.ItemCompleted && item?.id) streamingItems.delete(item.id);
}

/** The fields of a Codex item that streaming a reply reads. */
type CodexTextItem = { type?: string; id?: string; text?: string };

/** An agent message with its id and the text so far: a reply that is still arriving. */
function isReplySoFar(item: CodexTextItem | undefined): item is Required<CodexTextItem> {
  return item?.type === CodexItem.AgentMessage && Boolean(item.id) && typeof item.text === "string";
}

/** One translated event, folded into the run and mirrored into the log. */
function applyTranslated(
  translated: Translated,
  run: CodexRun,
  request: DelegateRequest,
  model: string | undefined,
): void {
  if (translated.sessionId) run.sessionId = translated.sessionId;
  if (translated.model) run.modelUsed = translated.model;
  if (translated.usage) mergeUsage(run.usage, translated.usage);
  if (translated.failure) run.failure = translated.failure;
  // Codex reports a stream hiccup or a notice ("Skill descriptions were shortened to fit
  // the skills context budget") as an `error` event and then carries on. The turn that
  // completes afterwards is the last word: a build that finished is a build that finished,
  // and an interview's recorded launch must not be thrown away over a warning. A fatal
  // stop arrives as `turn.failed`, with no completion after it.
  if (translated.completed) run.failure = null;
  if (translated.text) run.summary = translated.text;
  if (translated.turns) run.turns += translated.turns;
  for (const mirrored of translated.events) request.onEvent?.(withRequestedModel(mirrored, model));
}

/**
 * Codex's thread.started omits the model. Keep our requested model separate from
 * provider-reported identity so the UI can label it without claiming confirmation.
 */
function withRequestedModel(mirrored: MirroredEvent, model: string | undefined): MirroredEvent {
  const payload = mirrored.payload as { subtype?: string };
  if (mirrored.type !== DelegateEventType.System || payload.subtype !== "init") return mirrored;
  return { ...mirrored, payload: { ...payload, requested_model: model ?? DEFAULT_MODEL } };
}

/** The CLI's state for Settings: what discovery found, else whether a binary answers at all. */
function cliState(
  found: Awaited<ReturnType<typeof resolveCodingCli>> | null,
  binary: string | null,
): EngineAccount["cli"]["state"] {
  if (found) return found.status.state;
  return binary ? CodingCliState.Ready : CodingCliState.Missing;
}

/** Ready: which ChatGPT sign-in Studio is using. */
function connectedStatus(login: CodexLogin): EngineStatus {
  return {
    code: EngineStatusCode.Ready,
    detail: login.source === LoginSource.Isolated ? MESSAGE.IsolatedLogin : MESSAGE.SystemLogin,
  };
}

/** Not ready: signed in with a key, not signed in, or the check itself failed. */
function notConnectedStatus(cli: CodexAuthStatus, remedy: string): EngineStatus {
  return {
    code: cli.loggedIn === null ? EngineStatusCode.Error : EngineStatusCode.NeedsLogin,
    detail: notConnectedDetail(cli),
    remedy,
  };
}

function notConnectedDetail(cli: CodexAuthStatus): string {
  if (cli.method === "api_key") return MESSAGE.ApiKeyLogin;
  if (cli.loggedIn === false) return MESSAGE.NotConnected;
  return MESSAGE.CheckFailed;
}

/** Stills written to files for `-i`: Codex takes pictures as paths. */
async function writeStills(
  dir: string,
  images: Array<{ mimeType: string; data: string; label?: string }>,
  name: (image: { mimeType: string; label?: string }, index: number) => string,
): Promise<string[]> {
  const paths: string[] = [];
  for (const [index, image] of images.entries()) {
    const file = path.join(dir, name(image, index));
    await writeFile(file, Buffer.from(image.data, "base64"));
    paths.push(file);
  }
  return paths;
}

/** A builder's stills, in a folder of their own that the caller removes afterwards. */
export async function writeDelegateStills(all: DelegateImage[]): Promise<{ dir: string | null; paths: string[] }> {
  const images = all.filter((image) => image?.data);
  if (!images.length) return { dir: null, paths: [] };
  const dir = await mkdtemp(path.join(os.tmpdir(), "studio-stills-"));
  const paths = await writeStills(
    dir,
    images,
    (image, index) => `${index}-${sanitize(image.label)}.${extensionFor(image.mimeType)}`,
  );
  return { dir, paths };
}

// ── the CLI, as a stream ───────────────────────────────────────────────────────────────────

/**
 * Spawn `codex exec` and yield its JSONL events. The prompt goes in on stdin (and stdin is then
 * closed) rather than in argv: a brief is thousands of characters and argv is not.
 */
function streamCodex(
  binary: string,
  invocation: {
    argv: string[];
    cwd: string;
    env: Record<string, string>;
    prompt: string;
    signal: AbortSignal;
    onStderr?: (chunk: string) => void;
  },
): AsyncIterable<Record<string, unknown>> {
  invocation.signal.throwIfAborted();
  const child = spawnCommand(binary, invocation.argv, {
    cwd: invocation.cwd,
    env: invocation.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin?.end(invocation.prompt);
  child.stderr?.setEncoding("utf8");
  // Codex prints progress to stderr and only the outcome to stdout; the tail is kept because a
  // non-zero exit usually explains itself there and nowhere else.
  let stderr = "";
  child.stderr?.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-STDERR_TAIL_CHARS);
    invocation.onStderr?.(chunk);
  });

  const onAbort = (): void => {
    void stopChild(child, { signal: "SIGTERM" });
    // A contractor that ignores a polite ask still has to stop; the grace is short because the
    // user already pressed the button.
    setTimeout(() => void stopChild(child), KILL_GRACE_MS).unref?.();
  };
  if (invocation.signal.aborted) onAbort();
  else invocation.signal.addEventListener("abort", onAbort, { once: true });

  return (async function* () {
    const exit = new Promise<{ code: number | null }>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => resolve({ code }));
    });
    child.stdout?.setEncoding("utf8");
    try {
      yield* jsonlEvents(child.stdout as AsyncIterable<string>);
    } finally {
      invocation.signal.removeEventListener("abort", onAbort);
    }
    const { code } = await exit;
    // Exit 0 with no result line still counts as done; a non-zero exit is the CLI telling us
    // something the event stream never said, and stderr is where it said it.
    if (code !== 0 && !invocation.signal.aborted) {
      throw new Error(stderr.trim() || `codex exited with ${code}`);
    }
  })();
}

/** The events in a stream of JSONL text, one per whole line; a last line with no newline is never read. */
async function* jsonlEvents(stdout: AsyncIterable<string>): AsyncGenerator<Record<string, unknown>> {
  let buffer = "";
  for await (const chunk of stdout) {
    const lines = `${buffer}${chunk}`.split("\n");
    // The last piece has no newline yet: it is a line still arriving.
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const event = parseEventLine(line);
      if (event) yield event;
    }
  }
}

/** One JSONL line as an event; null for anything that is not a whole JSON object. */
function parseEventLine(raw: string): Record<string, unknown> | null {
  const line = raw.trim();
  if (!line.startsWith("{")) return null;
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    /* A partial or non-JSON line is noise on a stream we do not own. */
    return null;
  }
}

// ── event translation ──────────────────────────────────────────────────────────────────────

/** A contractor message mirrored into the log, in the compacted Claude Code shape. */
type MirroredEvent = {
  type:
    | typeof DelegateEventType.System
    | typeof DelegateEventType.Assistant
    | typeof DelegateEventType.User
    | typeof DelegateEventType.Result;
  payload: unknown;
};

interface Translated {
  /** Mirrored into the studio's log, in the compacted vocabulary the Claude path emits. */
  events: MirroredEvent[];
  sessionId?: string;
  model?: string;
  usage?: Partial<Usage>;
  /** The last agent message — the build's own summary of what it did. */
  text?: string;
  /** Set when the CLI reported the turn as failed. */
  failure?: string;
  /** Set when the CLI reported the turn as completed — any earlier error notice was survived. */
  completed?: true;
  turns?: number;
}

/** A Codex item, as `item.*` events carry it. */
type CodexItemRecord = Record<string, unknown>;

/**
 * Codex's JSONL → the studio's log vocabulary. Every consumer downstream (the chat rows, the
 * run graph, SkillOpt's miner, the morning review) already speaks the Claude Code shape, so
 * translating here is what makes a Codex run indistinguishable from a Claude one everywhere
 * that matters.
 */
export function translateEvent(event: Record<string, unknown>, cwd?: string): Translated | null {
  switch (String(event.type ?? "")) {
    case CodexEvent.ThreadStarted:
      return threadStarted(event);
    case CodexEvent.TurnCompleted:
      return turnCompleted(event);
    case CodexEvent.TurnFailed:
    case CodexEvent.Error:
      return turnFailed(event);
    case CodexEvent.ItemCompleted:
      return translateItem((event.item ?? {}) as CodexItemRecord, cwd);
    default:
      return { events: [] };
  }
}

/** The session began: its id is what "Continue" resumes. */
function threadStarted(event: Record<string, unknown>): Translated {
  const id = String(event.thread_id ?? "") || undefined;
  return {
    events: [
      {
        type: DelegateEventType.System,
        payload: { subtype: "init", model: undefined, tools: 0, ...(id ? { session_id: id } : {}) },
      },
    ],
    ...(id ? { sessionId: id } : {}),
  };
}

/**
 * A turn finished: its tokens. Codex's `output_tokens` already holds its reasoning (its
 * `total_tokens` is input plus output), so `reasoning_tokens` is that part of it, never added
 * again; its `input_tokens` already holds the cache reads. A count the CLI did not report — an
 * older CLI writes no cache writes — stays absent.
 */
function turnCompleted(event: Record<string, unknown>): Translated {
  const raw = (event.usage ?? {}) as Record<string, number>;
  return {
    events: [],
    completed: true,
    usage: {
      input_tokens: Number(raw.input_tokens ?? 0),
      output_tokens: Number(raw.output_tokens ?? 0),
      cache_read_tokens: Number(raw.cached_input_tokens ?? 0),
      ...reportedCount("reasoning_tokens", raw.reasoning_output_tokens),
      ...reportedCount("cache_write_tokens", raw.cache_write_input_tokens),
    },
  };
}

/** `{ [key]: value }` when the CLI reported a count, and nothing when it did not. */
function reportedCount<K extends keyof Usage>(key: K, value: unknown): Partial<Record<K, number>> {
  const counted = typeof value === "number" && Number.isFinite(value) && value >= 0;
  return counted ? ({ [key]: value } as Partial<Record<K, number>>) : {};
}

/** A failed turn or an error notice: its words, as the build's error result. */
function turnFailed(event: Record<string, unknown>): Translated {
  const message =
    String(((event.error ?? {}) as Record<string, unknown>).message ?? event.message ?? "the contractor stopped") ||
    "the contractor stopped";
  return { events: [errorResult(message)], failure: message };
}

/** A completed item, as the tool call, thought or message it was. */
function translateItem(item: CodexItemRecord, cwd?: string): Translated {
  switch (String(item.type ?? "")) {
    case CodexItem.AgentMessage:
      return agentMessage(item);
    case CodexItem.Reasoning:
      return reasoning(item);
    case CodexItem.CommandExecution:
      return commandExecution(item, cwd);
    case CodexItem.FileChange:
      return fileChange(item, cwd);
    case CodexItem.McpToolCall:
      return mcpToolCall(item);
    case CodexItem.WebSearch:
      return {
        events: [toolUse(item, "WebSearch", clip(String(item.query ?? ""), TRACE_TOOL_INPUT_CHARS))],
      };
    case CodexItem.Error:
      return itemError(item);
    default:
      // todo_list and anything the CLI grows later: stream mechanics, not part of the build's story.
      return { events: [] };
  }
}

function agentMessage(item: CodexItemRecord): Translated {
  const text = String(item.text ?? "");
  if (!text.trim()) return { events: [] };
  return { events: [assistant([{ type: "text", text }])], text, turns: 1 };
}

function reasoning(item: CodexItemRecord): Translated {
  const text = String(item.text ?? item.summary ?? "");
  if (!text.trim()) return { events: [] };
  return { events: [assistant([{ type: "thinking", text: clip(text, TRACE_THINKING_CHARS) }])] };
}

function commandExecution(item: CodexItemRecord, cwd?: string): Translated {
  const command = unwrapShell(relativize(String(item.command ?? ""), cwd));
  const exit = item.exit_code;
  const failed = typeof exit === "number" && exit !== 0;
  // A studio-tool call is a tool call, not a shell command: it renders as what it is.
  const studioTool = STUDIO_BRIDGE_COMMAND.exec(command)?.[1];
  const name = studioTool ? studioToolName(studioTool) : "Bash";
  const output = clip(String(item.aggregated_output ?? ""), TRACE_TOOL_RESULT_CHARS);
  return {
    events: [
      toolUse(item, name, clip(command, TRACE_TOOL_INPUT_CHARS)),
      ...(typeof exit === "number" ? [toolResult(item, failed, output)] : []),
    ],
    turns: 1,
  };
}

function fileChange(item: CodexItemRecord, cwd?: string): Translated {
  const changes = (item.changes ?? []) as Array<{ path?: string; kind?: string }>;
  const first = changes[0];
  const name = first?.kind === FILE_CHANGE_ADD ? "Write" : "Edit";
  const firstPath = relativize(String(first?.path ?? ""), cwd);
  const label = changes.length > 1 ? `${firstPath} +${changes.length - 1} more` : firstPath;
  const failed = item.status === CodexItemStatus.Failed;
  const finished = failed || item.status === CodexItemStatus.Completed;
  return {
    events: [
      toolUse(item, name, label),
      ...(finished ? [user([{ type: "tool_result", tool_use_id: String(item.id ?? ""), is_error: failed }])] : []),
    ],
    turns: 1,
  };
}

function mcpToolCall(item: CodexItemRecord): Translated {
  const failed = Boolean(item.error);
  const name = `mcp__${String(item.server ?? "mcp")}__${String(item.tool ?? "tool")}`;
  const text = mcpResultText(item.error ?? item.result);
  const answered = failed || item.result != null || item.status === CodexItemStatus.Completed;
  return {
    events: [
      toolUse(item, name, clip(JSON.stringify(item.arguments ?? {}), TRACE_TOOL_INPUT_CHARS)),
      ...(answered ? [toolResult(item, failed, clip(text, TRACE_TOOL_RESULT_CHARS))] : []),
    ],
    turns: 1,
  };
}

function itemError(item: CodexItemRecord): Translated {
  const message = String(item.message ?? "the contractor reported an error");
  return { events: [errorResult(message)], failure: message };
}

/** An MCP tool's answer as text: the string, an error's message, or the result's text blocks. */
function mcpResultText(result: unknown): string {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return "";
  const record = result as { message?: unknown; content?: unknown };
  if (typeof record.message === "string") return record.message;
  if (!Array.isArray(record.content)) return "";
  return (record.content as Array<{ type?: string; text?: unknown }>)
    .filter((part) => part?.type === "text")
    .map((part) => String(part.text ?? ""))
    .join("\n");
}

/** The file a `chmod`-ish command was aimed at, if the contractor just ran one. */
export function chmodTarget(event: Record<string, unknown>): string | null {
  if (event.type !== CodexEvent.ItemCompleted) return null;
  const item = (event.item ?? {}) as Record<string, unknown>;
  if (item.type !== CodexItem.CommandExecution) return null;
  const command = unwrapShell(String(item.command ?? ""));
  return /\b(chmod|chflags)\b/.test(command) ? command : null;
}

function assistant(parts: unknown[]): MirroredEvent {
  return { type: DelegateEventType.Assistant, payload: { role: "assistant", parts } };
}

function user(parts: unknown[]): MirroredEvent {
  return { type: DelegateEventType.User, payload: { role: "user", parts } };
}

/** The item as a tool call in an assistant message. */
function toolUse(item: CodexItemRecord, name: string, input: string): MirroredEvent {
  return assistant([{ type: "tool_use", name, id: String(item.id ?? ""), input }]);
}

/** The item's outcome as a tool result in a user message. */
function toolResult(item: CodexItemRecord, failed: boolean, content: string): MirroredEvent {
  return user([{ type: "tool_result", tool_use_id: String(item.id ?? ""), is_error: failed, content }]);
}

/** A failure as the build's error result. */
function errorResult(message: string): MirroredEvent {
  return { type: DelegateEventType.Result, payload: { subtype: "error", result: message } };
}
// ── argv helpers ───────────────────────────────────────────────────────────────────────────

/**
 * The mode a chat session the person answers runs in, as Codex honours it (`permissionModesFor`),
 * or null for unattended work, which keeps the sandboxed contract.
 */
function chatMode(request: DelegateRequest): PermissionMode | null {
  return request.permissions ? engineMode(EngineId.Codex, request.permissions.mode) : null;
}

/**
 * A session started in a folder of its own, because Codex can always write where it is started:
 * a read-only one (the playtester, a lead while its build runs), and a chat session in Plan. The
 * only place it can write is the studio's bridge there.
 */
function startsElsewhere(request: DelegateRequest): boolean {
  const readOnly = Boolean(request.readOnly) && !request.coordinator;
  return readOnly || chatMode(request) === PermissionMode.Plan || request.worker?.mode === PermissionMode.Plan;
}

/** The session's box: the bypass flag only for the chat's own session in Bypass; a worker's own box; else one root. */
function sessionBox(request: DelegateRequest, runDir: string): string[] {
  if (request.worker) return [...workerBox(request, runDir), ...workerWebSearch(request)];
  return chatMode(request) === PermissionMode.Bypass ? BYPASS_ARGS : sandboxArgs(runDir);
}

/**
 * A worker's web search, as a Claude Code worker's (`researches`): live when its lead asked it to
 * research or it writes, and off for a reader or a worker in Plan that was not asked to.
 */
function workerWebSearch(request: DelegateRequest): string[] {
  const research = Boolean(request.worker?.research) || !startsElsewhere(request);
  return ["-c", `web_search="${research ? CodexWebSearch.Live : CodexWebSearch.Disabled}"`];
}

/**
 * A worker's box. Codex has no hook Genex sets and is not spawned through ProcessSandbox, and its
 * bypass flag drops every fence, so a worker is always boxed, whatever the chat's mode: it never
 * asks (`approval_policy=never`), writes only its write roots, and reaches the network only in a
 * Bypass chat. Its box never stops reads, so the never-touch list holds for its writes (and is
 * named in its brief). Plan and a reader start elsewhere and write only the studio's bridge.
 */
function workerBox(request: DelegateRequest, runDir: string): string[] {
  const seat = request.worker;
  if (!seat || startsElsewhere(request)) return sandboxArgs(runDir);
  // Its box cannot deny inside a writable folder: none that is, holds or sits in a never-touch root.
  const writes = writableRoots(
    seat.writeRoots.map((dir) => path.resolve(dir)),
    seat.neverTouch,
  );
  const roots = [...new Set([path.resolve(runDir), ...writes])];
  return sandboxArgs(runDir, roots, seat.mode === PermissionMode.Bypass);
}

/**
 * Bypass permissions, which only the person picks for their chat (and confirms): no sandbox, no
 * approvals. Codex then runs as it would in their terminal with the same flag.
 */
const BYPASS_ARGS = ["--dangerously-bypass-approvals-and-sandbox"];

/**
 * The contractor's confinement. `workspace-write` keeps every edit inside the folder it was
 * pointed at (plus the run's own capture output, which it must be able to read and the studio
 * writes); a read-only session — the playtester — may look and talk but never touch.
 * `approval_policy=never` is what makes it non-interactive: there is nobody to ask, so a command
 * the sandbox refuses fails honestly instead of hanging on a prompt nobody will see.
 */
function sandboxArgs(runDir: string, roots: string[] = [runDir], network = false): string[] {
  return [
    "-c",
    'sandbox_mode="workspace-write"',
    "-c",
    'approval_policy="never"',
    // One writable place (a worker's write roots: `workerBox`). For a builder that is the workspace it was hired for; for a
    // session that may look but never touch (the playtester) it is a scratch folder holding
    // nothing but the studio's own bridge, which leaves the build under test read-only at the
    // OS boundary rather than by request. Read stays wide: stills the user named and the run's
    // own capture output have to be openable, and Codex grants disk reads either way.
    "-c",
    `sandbox_workspace_write.writable_roots=${JSON.stringify(roots)}`,
    // The game is built from vendored files; a contractor that wants the network has to say so
    // to a human first; a worker reaches it only in a chat the person set to Bypass. (A Claude
    // session's shell is confined the same way; its web research goes through WebSearch/WebFetch,
    // never the shell.)
    "-c",
    `sandbox_workspace_write.network_access=${network}`,
  ];
}

/** `undefined`/"auto" = the model's own default. Anything above this CLI's ceiling is clamped. */
export function effortArgs(effort?: string): string[] {
  const value = normaliseEffort(effort);
  return value ? ["-c", `model_reasoning_effort="${value}"`] : [];
}

export function normaliseEffort(effort?: string): string {
  if (!effort) return "";
  const raw = String(effort).trim().toLowerCase();
  const mapped = EFFORT_ALIASES[raw] ?? raw;
  return (CODEX_EFFORTS as readonly string[]).includes(mapped) ? mapped : "";
}

function pickModel(model?: string): string | undefined {
  return model && model !== DEFAULT_MODEL ? model : undefined;
}

/** Where Codex finds the operator's host skills, under the home folder. */
const HOST_SKILLS_DIR = path.join(".agents", "skills");
/** The file that makes a host-skills subfolder a skill. */
const HOST_SKILL_FILE = "SKILL.md";
/**
 * Codex's screen and browser hands, off in every session: they reach past the workspace (the
 * desktop and browsers Genex does not hand out) and Codex turns them on by default. The
 * computer-use change turns the screen features back on where Genex gives a session the screen.
 */
export const CODEX_SCREEN_FEATURES = ["computer_use", "in_app_browser", "browser_use", "browser_use_external"] as const;
/**
 * Codex's own sub-agents, off in every session: Genex runs the workers, under the person's
 * ceiling and the chat's mode, and Codex turns them on by default.
 */
export const CODEX_SUBAGENT_FEATURES = ["multi_agent", "multi_agent_v2"] as const;
/** `--disable <feature>` for each feature every session runs without, once each. */
const DISABLED_FEATURE_ARGS = [...new Set([...CODEX_SCREEN_FEATURES, ...CODEX_SUBAGENT_FEATURES])].flatMap(
  (feature) => ["--disable", feature],
);

/**
 * `-c skills.config=[…]` disabling each of these SKILL.md files by path. Each path is a TOML
 * basic string: JSON's escapes (quote, backslash, control characters) are TOML's too.
 */
export function hostSkillSuppressionArgs(skillFiles: readonly string[]): string[] {
  if (!skillFiles.length) return [];
  const entries = skillFiles.map((file) => `{path=${JSON.stringify(file)},enabled=false}`);
  return ["-c", `skills.config=[${entries.join(",")}]`];
}

/** The suppression argv for a folder of host skills, or nothing when they are kept. Only reads. */
async function hostSkillArgs(dir: string | null): Promise<string[]> {
  if (dir === null) return [];
  return hostSkillSuppressionArgs(await hostSkillFiles(dir));
}

/**
 * Every `<dir>/<name>/SKILL.md`, sorted by name; a linked skill also by its real path, since
 * either spelling may be the one Codex records. A missing folder has none. The eval harness's raw
 * Codex lane disables the same list.
 */
export async function hostSkillFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const file = path.join(dir, entry.name, HOST_SKILL_FILE);
    if (!(await isRegularFile(file))) continue;
    files.push(file);
    if (entry.isSymbolicLink()) files.push(await realpath(file));
  }
  return files;
}

/** Whether `file` names a regular file, following links; false for anything unreadable. */
async function isRegularFile(file: string): Promise<boolean> {
  return (await stat(file).catch(() => null))?.isFile() ?? false;
}

/** Each still as an `-i` image argument. */
function imageArgs(paths: string[]): string[] {
  return paths.flatMap((file) => ["-i", file]);
}

// ── small shared pieces ────────────────────────────────────────────────────────────────────

/**
 * D8: the studio runs on the user's subscription, never a metered API key. An ambient
 * `CODEX_API_KEY`/`OPENAI_API_KEY` in the inherited shell environment would silently flip the
 * CLI to per-token billing that no UI ever agreed to, so both are stripped here. SEC-2: so is
 * every other credential and every Anthropic/Claude variable; `extra` (usually the resolved CLI's
 * whole environment plus CODEX_HOME) is filtered the same way.
 */
function subscriptionEnv(extra: Record<string, string | undefined> = {}): Record<string, string> {
  return codexSubscriptionEnv(extra) as Record<string, string>;
}

function emptyUsage(engine: string): Usage {
  return { engine };
}

/** The `Usage` counts each turn reports for itself, added up over a session's turns. */
const SUMMED_USAGE = [
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "reasoning_tokens",
  "cost_usd",
] as const;

/** A turn's counts, added onto the session's. */
function mergeUsage(into: Usage, from: Partial<Usage>): void {
  for (const key of SUMMED_USAGE) {
    if (typeof from[key] === "number") into[key] = (into[key] ?? 0) + from[key];
  }
}

/** The account's catalogue, read from Codex's own cache. Never the credential beside it. */
export async function readCodexCatalogue(home: string): Promise<CatalogueRow[] | null> {
  try {
    const text = await readFile(path.join(home, "models_cache.json"), "utf8");
    if (Buffer.byteLength(text) > 2 * 1024 * 1024) return null;
    const parsed = cachedCatalog.parse(JSON.parse(text));
    const listed = (parsed.models ?? [])
      .filter((model) => model.slug && model.visibility === "list")
      .sort((a, b) => (a.priority ?? UNRANKED) - (b.priority ?? UNRANKED));

    return [{ ...DEFAULT_ROW, efforts: [...CODEX_EFFORTS] }, ...listed.map(catalogueRow)];
  } catch {
    return null;
  }
}

/** A model the cache lists without a priority sorts after every ranked one. */
const UNRANKED = 999;

/** One model in Codex's `models_cache.json`. */
interface CachedModel {
  slug?: string;
  display_name?: string;
  description?: string;
  visibility?: string;
  priority?: number;
  additional_speed_tiers?: string[];
  default_reasoning_level?: string;
  supported_reasoning_levels?: Array<{ effort?: string }>;
  context_window?: number;
  effective_context_window_percent?: number;
}

const cachedCatalog = z.object({
  models: z
    .array(
      z.object({
        slug: z.string().min(1),
        display_name: z.string().optional(),
        description: z.string().optional(),
        visibility: z.string(),
        priority: z.number().finite().optional(),
        additional_speed_tiers: z.array(z.string()).optional(),
        default_reasoning_level: z.string().optional(),
        supported_reasoning_levels: z.array(z.object({ effort: z.string() })).optional(),
        context_window: z.number().positive().optional(),
        effective_context_window_percent: z.number().positive().optional(),
      }),
    )
    .max(2000),
});

/** A cached model as the picker's row. */
function catalogueRow(model: CachedModel): CatalogueRow {
  return {
    id: String(model.slug),
    label: String(model.display_name ?? model.slug),
    ...catalogueContext(model.context_window, model.effective_context_window_percent),
    supportsFast: model.additional_speed_tiers?.includes("fast") === true,
    ...(model.description ? { note: model.description } : {}),
    // Only the efforts this CLI can actually be told to use survive the trip to the picker.
    efforts: (model.supported_reasoning_levels ?? [])
      .map((level) => normaliseEffort(level.effort))
      .filter((level, index, all) => level && all.indexOf(level) === index),
    ...(model.default_reasoning_level ? { defaultEffort: normaliseEffort(model.default_reasoning_level) } : {}),
  };
}

/** A model's hard context limit, and the share of it (1–100%) the model may actually use. */
function catalogueContext(
  window: number | undefined,
  effectivePercent: number | undefined,
): Pick<CatalogueRow, "hardLimitTokens" | "contextWindow"> {
  const knownWindow = window !== undefined && Number.isFinite(window) && window > 0;
  if (!knownWindow) return {};
  const percent = Math.min(100, Math.max(1, effectivePercent ?? 100));
  return { hardLimitTokens: window, contextWindow: Math.floor((window * percent) / 100) };
}

function extensionFor(mimeType: string): string {
  if (/png/i.test(mimeType)) return "png";
  if (/webp/i.test(mimeType)) return "webp";
  return "jpg";
}

/** A still's label as a safe, short file name. */
function sanitize(label: string | undefined): string {
  return (
    String(label ?? "still")
      .replace(/[^a-z0-9._-]/gi, "-")
      .slice(0, STILL_NAME_CHARS) || "still"
  );
}

/**
 * Codex runs every command through a login shell, so the item's `command` is
 * `/bin/zsh -lc 'node --check src/main.js'`. The wrapper is stream mechanics; the person reading
 * the trace wants the command they would have typed.
 */
export function unwrapShell(command: string): string {
  const inner = /^\S*\/(?:ba|z|d)?sh\s+-[a-z]*c\s+([\s\S]+)$/.exec(command.trim())?.[1] ?? command.trim();
  const quoted = /^(['"])([\s\S]*)\1$/.exec(inner);
  return (quoted?.[2] ?? inner).trim();
}

/** Paths read relative to the workspace: a person thinks in "src/enemies.js", not in an absolute. */
function relativize(text: string, cwd?: string): string {
  return cwd ? relativizeWorkspace(text, cwd) : text;
}
