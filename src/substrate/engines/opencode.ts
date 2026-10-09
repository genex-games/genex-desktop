/**
 * OpenCode: a third delegated harness, driven through `opencode run --format json`.
 *
 * OpenCode runs its own agent loop on whichever providers the person signed it in to (its free
 * OpenCode Zen models, an Anthropic or OpenAI account, OpenRouter, and many more) and keeps those
 * sign-ins in its own store, which the studio never reads. Unlike Claude Code and Codex it has no
 * OS sandbox of its own, so the studio starts every session inside its `ProcessSandbox`: the
 * workspace (or, read-only, a scratch folder) is all it can write, the studio's secrets and every
 * other CLI's sign-in stay unreadable, and only its provider's host is reachable. OpenCode's own
 * permission rules (`openCodeConfig`) keep the model from even trying the rest.
 *
 * The prompt goes in on stdin; each stdout line is one event (`opencode-events.ts`); a session is
 * resumed by its id (`--session`). Studio tools arrive through the same bridge Codex uses.
 */
import { execFile } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { CATALOG_DEADLINE_MS, ModelCatalog } from "./model-catalog.ts";
import { resolveCodingCli } from "./external-cli.ts";
import { runCommand } from "./claude-cli.ts";
import { lockUnowned, ownershipBriefing, releaseLocks, releaseStaleLocks, type LockRecord } from "./ownership-locks.ts";
import { StudioBridge, answerBridgeCall, bridgeTools } from "./studio-bridge.ts";
import { writeDelegateStills } from "./codex.ts";
import { JUDGE_RULES, offLimitsNote, planModeNote, readOnlyNote } from "./codex-prompts.ts";
import { OpenCodeAccess, openCodeConfig, parseOpenCodeModels, type OpenCodeModel } from "./opencode-cli.ts";
import { parseOpenCodeLine, translateOpenCodeEvent, type Translated } from "./opencode-events.ts";
import {
  type CompleteRequest,
  type CompleteResponse,
  type DelegateRequest,
  type DelegateResult,
  type Engine,
  EngineError,
  type EngineModel,
  type EngineStatus,
  classifyHttpFailure,
} from "./types.ts";
import { abortControllerFor, CompletionStop, interruption, partialDelegateResult, STOPPED_BY_USER } from "./common.ts";
import type { PartialDelegateState } from "./common.ts";
import { ProcessSandbox, type SandboxOptions, shellQuote } from "../spawn.ts";
import { childEnv } from "../child-env.ts";
import { credentialHomes, openCodeDataHome } from "../credential-homes.ts";
import { stopChild } from "../process-tree.ts";
import type { Usage } from "../types.ts";
import { CodingCliState } from "../../shared/coding-cli.ts";
import { MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";
import { type EngineAccount, EngineKind, EngineStatusCode, LoginSource } from "../../shared/engine-descriptor.ts";
import { EngineFailureKind, StopReason } from "../../shared/engine-requests.ts";
import { ModelCatalogSource } from "../../shared/model-catalog.ts";
import { engineMode, PermissionMode } from "../../shared/permissions.ts";
import { EngineId } from "../../shared/providers.ts";

/** How long `opencode models --verbose` may take: it may refresh its catalog from models.dev first. */
const MODELS_TIMEOUT_MS = 30 * SECOND_MS;
/** How long a git probe for a worktree's metadata may take. */
const GIT_PROBE_TIMEOUT_MS = 5 * SECOND_MS;
/** How long a judge's one-shot answer may take before it is a timeout. */
const COMPLETE_TIMEOUT_MS = 15 * MINUTE_MS;
/** How long a stopped session gets to exit politely before it is killed. */
const KILL_GRACE_MS = 3 * SECOND_MS;
/** How much of stderr is kept to explain an exit the event stream never explained. */
const STDERR_TAIL_CHARS = 4_000;
/**
 * The provider statuses that refuse the request itself (a model a ChatGPT plan does not run, a
 * model gone): no wait or retry helps, another model might.
 */
const MODEL_REFUSED_STATUSES: ReadonlySet<number> = new Set([400, 404]);
/** The status the sandbox's proxy answers a host off its allow-list with. */
const PROXY_REFUSED_STATUS = 403;
/** Where OpenCode refreshes its model catalogs; opened beside the provider's own hosts. */
const CATALOG_HOSTS = ["models.dev", "models.opencode.ai"] as const;

/** What this engine says to the person. */
const MESSAGE = {
  NotInstalled: "OpenCode isn't installed on this Mac.",
  InstallRemedy: "Install OpenCode from Settings › Model Providers.",
  NoModels: "OpenCode has no model it can run yet.",
  SignInRemedy: "Sign in to a provider with OpenCode from Settings › Model Providers.",
  Ready: (version: string | undefined, count: number) => `OpenCode ${version ?? ""}, ${count} model(s)`.trim(),
  NoTools: "OpenCode's one-shot answers take no studio tools",
  NoCompact: "OpenCode compacts its own sessions",
  Stopped: (code: number | null) => `OpenCode exited with ${code}`,
  ModelRefused: (model: string, words: string) =>
    `The provider refused ${model} (${words}). Pick another model, then send again.`,
  HostUnknown: (provider: string) =>
    `Genex doesn't know where ${provider} answers, so its sandbox kept OpenCode from reaching it. Pick a model from another provider.`,
  FreeModelFailed: (model: string | null, words: string) =>
    `OpenCode's free model${model ? ` ${model}` : ""} failed (${words}). OpenCode runs its free models itself and they are sometimes down: try again later, or pick another model.`,
  NoAnswer: "OpenCode gave no answer",
  JudgeTimedOut: (minutes: number) => `the judge did not answer within ${minutes} min`,
} as const;

/** One `opencode run`, as the engine starts it; injectable in tests. */
export interface OpenCodeInvocation {
  argv: string[];
  /** Where the session runs: the workspace, or a read-only session's scratch folder. */
  cwd: string;
  prompt: string;
  env: Record<string, string>;
  signal: AbortSignal;
  /** The sandbox the real CLI is started in. */
  sandbox: SandboxOptions;
  /** The provider hosts the session may reach. */
  domains: string[];
}
export type OpenCodeExec = (invocation: OpenCodeInvocation) => AsyncIterable<Record<string, unknown>>;

export interface OpenCodeEngineOptions {
  /**
   * Where read-only sessions run and their temporary files go: never under the engine homes, which
   * every sandbox denies. The system temporary folder when not given.
   */
  scratchRoot?: string;
  /** What no OpenCode session may read: the studio's secrets, the engines' homes. */
  protectedPaths?: string[];
  toolPath?: () => Promise<string>;
  onModelsChanged?: () => void;
  /** Test seam: run a session without the CLI. */
  execFn?: OpenCodeExec;
  /** Test seam: the model listing, instead of asking the CLI. */
  listModels?: () => Promise<string>;
  /** Test seam: where the CLI is and whether it works. */
  resolveCli?: () => Promise<{ ready: boolean; path?: string; version?: string; detail: string }>;
  /** Where locks are recovered from after a crash (as Codex's). */
  lockRecovery?: string;
}

/** What a session has done so far. */
interface OpenCodeRun {
  usage: Usage;
  turns: number;
  summary: string;
  sessionId: string | undefined;
  failure: { message: string; status: number | null } | null;
  deadlineHit: boolean;
}

export class OpenCodeEngine implements Engine {
  readonly id = EngineId.OpenCode;
  readonly label = "OpenCode";
  readonly kind = EngineKind.Delegated;
  readonly supportsSessions = true;
  readonly #scratchRoot: string;
  readonly #protectedPaths: string[];
  readonly #toolPath: (() => Promise<string>) | undefined;
  readonly #catalog: ModelCatalog;
  readonly #execFn: OpenCodeExec | undefined;
  readonly #listModels: (() => Promise<string>) | undefined;
  readonly #resolveCli: () => Promise<{ ready: boolean; path?: string; version?: string; detail: string }>;
  readonly #lockRecovery: string | undefined;
  #hosts = new Map<string, string[]>();
  /** Whether the last listing named a model some provider's sign-in runs, not only OpenCode's free ones. */
  #signedIn = false;
  /** OpenCode's own free models in the last listing, which run with no sign-in. */
  #anonymous = new Set<string>();

  constructor(options: OpenCodeEngineOptions) {
    this.#scratchRoot = options.scratchRoot ?? path.join(os.tmpdir(), `studio-${EngineId.OpenCode}`);
    this.#protectedPaths = options.protectedPaths ?? [];
    this.#toolPath = options.toolPath;
    this.#catalog = new ModelCatalog(options.onModelsChanged);
    this.#execFn = options.execFn;
    this.#listModels = options.listModels;
    this.#resolveCli = options.resolveCli ?? defaultResolveCli;
    this.#lockRecovery = options.lockRecovery;
  }

  async status(): Promise<EngineStatus> {
    const cli = await this.#resolveCli();
    if (!cli.ready && !cli.path)
      return { code: EngineStatusCode.NotInstalled, detail: MESSAGE.NotInstalled, remedy: MESSAGE.InstallRemedy };
    if (!cli.ready) return { code: EngineStatusCode.Error, detail: cli.detail };
    await this.refreshModels().catch(() => {});
    const count = this.#catalog.models().length;
    if (!count) return { code: EngineStatusCode.NeedsLogin, detail: MESSAGE.NoModels, remedy: MESSAGE.SignInRemedy };
    return { code: EngineStatusCode.Ready, detail: MESSAGE.Ready(cli.version, count) };
  }

  /**
   * Whose sign-in OpenCode runs on: its own (`system`) once it lists a provider's model, and no
   * one's while it lists only its free models, which still run. Genex never reads the sign-ins.
   */
  async account(): Promise<EngineAccount> {
    const cli = await this.#resolveCli();
    if (cli.ready) await this.refreshModels().catch(() => {});
    return {
      source: this.#signedIn ? LoginSource.System : LoginSource.None,
      afterSignOut: "signed-out",
      cli: {
        state: cliState(cli),
        ...(cli.path ? { path: cli.path } : {}),
        ...(cli.version ? { version: cli.version } : {}),
      },
    };
  }

  catalogSnapshot = () => this.#catalog.snapshot();

  async models(): Promise<EngineModel[]> {
    void this.refreshModels().catch(() => {});
    return this.#catalog.models();
  }

  /** The models OpenCode can run with its sign-ins, as it lists them; a new sign-in shows on the next refresh. */
  async refreshModels(force = false): Promise<void> {
    const cli = await this.#resolveCli();
    if (!cli.ready) return;
    await this.#catalog.refresh(`${cli.path ?? ""}\0${cli.version ?? ""}`, () => this.#readModels(cli.path), force);
  }

  async #readModels(
    binary: string | undefined,
  ): Promise<{ models: EngineModel[]; source: typeof ModelCatalogSource.Provider }> {
    const stdout = this.#listModels ? await this.#listModels() : await listOpenCodeModels(binary);
    // A signed-in provider's models first: the picker starts with the first few it is given.
    const parsed = parseOpenCodeModels(stdout);
    const listed = [...parsed.filter((model) => !model.anonymous), ...parsed.filter((model) => model.anonymous)];
    this.#hosts = new Map(listed.map((model) => [model.row.id, model.hosts]));
    this.#signedIn = listed.some((model) => !model.anonymous);
    this.#anonymous = new Set(listed.filter((model) => model.anonymous).map((model) => model.row.id));
    return { models: listed.map((model: OpenCodeModel) => model.row), source: ModelCatalogSource.Provider };
  }

  /** OpenCode keeps its own default model; with none picked, `--model` is left out and it uses that. */
  async defaultModel(): Promise<string | null> {
    return null;
  }

  async delegate(request: DelegateRequest): Promise<DelegateResult> {
    if (request.compact) throw new EngineError(EngineFailureKind.Unavailable, this.id, MESSAGE.NoCompact);
    const startedAt = Date.now();
    const cwd = await realpath(path.resolve(request.cwd));
    const run = newRun(this.id, request.resume);
    const controller = abortControllerFor(request.signal);
    await releaseStaleLocks(cwd, this.#lockRecovery).catch(() => {});
    const locks = request.ownership
      ? await lockUnowned(cwd, request.ownership, this.#lockRecovery).catch(() => null)
      : null;
    const access = sessionAccess(request);
    const scratch = access === OpenCodeAccess.Build ? null : await this.#scratch("run-");
    const runDir = scratch ?? cwd;
    const bridge = await this.#openBridge(request, runDir).catch(async (err) => {
      await this.#cleanUp(cwd, locks, scratch, null);
      throw err;
    });
    const stills = await writeDelegateStills(request.images ?? []);
    const deadline = request.timeoutMs
      ? setTimeout(() => {
          run.deadlineHit = true;
          controller.abort();
        }, request.timeoutMs)
      : null;
    const partial = (): PartialDelegateState => partialState(run, startedAt, request.model, bridge, request);
    try {
      const invocation = await this.#invocation(request, {
        access,
        cwd,
        runDir,
        bridge: Boolean(bridge),
        prompt: this.#brief(request, { access, cwd, scratch, locks, bridge }),
        files: stills.paths,
        signal: controller.signal,
      });
      await this.#readEvents(request, run, invocation);
    } catch (err) {
      return this.#endingAfterThrow(err, run, request, partial);
    } finally {
      if (deadline) clearTimeout(deadline);
      if (stills.dir) await rm(stills.dir, { recursive: true, force: true }).catch(() => {});
      await this.#cleanUp(cwd, locks, scratch, bridge);
    }
    if (request.signal?.aborted || run.deadlineHit)
      return metered(partialDelegateResult(this.id, interruption(request.signal?.aborted), partial()));
    if (run.failure) return this.#failedEnding(run.failure, partial, request.model);
    return completed(this.id, run, startedAt, request.model, recordedCalls(bridge, request));
  }

  /** A one-shot answer (a judge's verdict): no tools, in an empty folder of its own. */
  async complete(request: CompleteRequest): Promise<CompleteResponse> {
    if (request.tools?.length) throw new EngineError(EngineFailureKind.Unavailable, this.id, MESSAGE.NoTools);
    const controller = abortControllerFor(request.signal);
    const ceiling = request.timeoutMs ?? COMPLETE_TIMEOUT_MS;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, ceiling);
    // A stop or the ceiling wins over whatever error it caused: neither must read as a failure.
    const stopped = (): EngineError | null => {
      if (timedOut)
        return new EngineError(
          EngineFailureKind.Timeout,
          this.id,
          MESSAGE.JudgeTimedOut(Math.round(ceiling / MINUTE_MS)),
        );
      return request.signal?.aborted ? new EngineError(EngineFailureKind.Aborted, this.id, STOPPED_BY_USER) : null;
    };
    let run: OpenCodeRun;
    try {
      run = await this.#answer(request, controller.signal);
    } catch (err) {
      throw stopped() ?? err;
    } finally {
      clearTimeout(timer);
    }
    const stop = stopped();
    if (stop) throw stop;
    if (run.failure) throw failureError(this.id, run.failure);
    if (!run.summary) throw new EngineError(EngineFailureKind.Other, this.id, MESSAGE.NoAnswer);
    return {
      message: { role: "assistant", content: run.summary },
      usage: run.usage,
      stopReason: CompletionStop.Stop,
      model: request.model ?? "",
      engine: this.id,
    };
  }

  /** One answer session in a scratch folder, its pictures attached as files; both removed after. */
  async #answer(request: CompleteRequest, signal: AbortSignal): Promise<OpenCodeRun> {
    const scratch = await this.#scratch("answer-");
    const images = request.messages.flatMap((message) => message.images ?? []);
    const stills = await writeDelegateStills(images.map((image) => ({ ...image, label: image.label ?? "" })));
    const run = newRun(this.id, undefined);
    try {
      const asked = {
        cwd: scratch,
        prompt: "",
        ...(request.model ? { model: request.model } : {}),
        ...(request.effort ? { effort: request.effort } : {}),
      };
      const invocation = await this.#invocation(asked, {
        access: OpenCodeAccess.Answer,
        cwd: scratch,
        runDir: scratch,
        bridge: false,
        prompt: answerPrompt(request),
        files: stills.paths,
        signal,
      });
      await this.#readEvents({}, run, invocation);
      return run;
    } finally {
      if (stills.dir) await rm(stills.dir, { recursive: true, force: true }).catch(() => {});
      await rm(scratch, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** A new folder of its own under the engine's scratch root. */
  async #scratch(prefix: string): Promise<string> {
    await mkdir(this.#scratchRoot, { recursive: true });
    return mkdtemp(path.join(this.#scratchRoot, prefix));
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

  async #cleanUp(
    cwd: string,
    locks: LockRecord | null,
    scratch: string | null,
    bridge: StudioBridge | null,
  ): Promise<void> {
    await bridge?.close().catch(() => {});
    await releaseLocks(cwd, locks, this.#lockRecovery).catch(() => {});
    if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }

  /** The brief, plus what OpenCode can only be told: its tools, its seam, its folder, what is off limits. */
  #brief(
    request: DelegateRequest,
    ctx: {
      access: OpenCodeAccess;
      cwd: string;
      scratch: string | null;
      locks: LockRecord | null;
      bridge: StudioBridge | null;
    },
  ): string {
    const hasSeam = request.ownership && (request.ownership.owns.length || ctx.locks?.files.length);
    const plan = chatMode(request) === PermissionMode.Plan && ctx.scratch;
    return [
      request.prompt,
      ctx.bridge?.instructions() ?? "",
      hasSeam && request.ownership ? ownershipBriefing(request.ownership) : "",
      plan
        ? planModeNote(ctx.cwd, ctx.scratch ?? "")
        : readOnlyNote(ctx.cwd, ctx.scratch, request.director ? path.resolve(request.director.root) : null),
      offLimitsNote([...this.#protectedPaths, ...credentialHomes(), ...(request.denyReads ?? [])]),
    ]
      .filter((part) => part.trim())
      .join("\n\n");
  }

  /** The command, environment and sandbox of one session. */
  async #invocation(
    request: Pick<DelegateRequest, "model" | "effort" | "resume" | "denyReads" | "cwd" | "prompt">,
    ctx: {
      access: OpenCodeAccess;
      cwd: string;
      runDir: string;
      bridge: boolean;
      prompt: string;
      files: string[];
      signal: AbortSignal;
    },
  ): Promise<OpenCodeInvocation> {
    const model = request.model;
    const variant = model && request.effort ? this.#variant(model, request.effort) : null;
    const argv = [
      "run",
      "--format",
      "json",
      // Plugins a game folder ships (`.opencode/`) never run inside a studio session.
      "--pure",
      ...(model ? ["--model", model] : []),
      ...(request.resume ? ["--session", request.resume] : []),
      ...(variant ? ["--variant", variant] : []),
      ...ctx.files.flatMap((file) => ["--file", file]),
    ];
    const env = sessionEnv(openCodeConfig(ctx.access, ctx.bridge));
    const sandbox = await this.#sandboxOptions(ctx, request.denyReads ?? []);
    return {
      argv,
      cwd: ctx.runDir,
      prompt: ctx.prompt,
      env,
      signal: ctx.signal,
      sandbox,
      domains: this.#domains(model),
    };
  }

  /** The reasoning variant a model offers for an effort, or none when it offers no such dial. */
  #variant(model: string, effort: string): string | null {
    const row = this.#catalog.models().find((candidate) => candidate.id === model);
    return row?.efforts?.includes(effort) ? effort : null;
  }

  /** The hosts a session may reach: its model's provider, or every listed provider when OpenCode picks. */
  #domains(model: string | undefined): string[] {
    const hosts = model ? (this.#hosts.get(model) ?? []) : [...this.#hosts.values()].flat();
    return [...new Set([...hosts, ...CATALOG_HOSTS])];
  }

  async #sandboxOptions(
    ctx: { access: OpenCodeAccess; cwd: string; runDir: string },
    denyReads: string[],
  ): Promise<SandboxOptions> {
    return openCodeSandbox({
      runDir: ctx.runDir,
      gameDir: ctx.cwd,
      gitDirs: ctx.access === OpenCodeAccess.Build ? await gitMetadata(ctx.cwd) : [],
      scratchDir: path.join(this.#scratchRoot, "tmp"),
      secretPaths: [...this.#protectedPaths, ...denyReads],
      ...(this.#toolPath ? { toolPath: this.#toolPath } : {}),
    });
  }

  /** Read the session's events to the end: the chat's live rows, its tokens and its summary. */
  async #readEvents(
    request: Pick<DelegateRequest, "onEvent">,
    run: OpenCodeRun,
    invocation: OpenCodeInvocation,
  ): Promise<void> {
    const events = (this.#execFn ?? runOpenCode)(invocation);
    for await (const event of events) applyTranslated(request, run, translateOpenCodeEvent(event));
  }

  /** A throw is a stop, a deadline, or a failure the run policy acts on. */
  #endingAfterThrow(
    err: unknown,
    run: OpenCodeRun,
    request: DelegateRequest,
    partial: () => PartialDelegateState,
  ): DelegateResult {
    if (request.signal?.aborted || run.deadlineHit)
      return metered(partialDelegateResult(this.id, interruption(request.signal?.aborted), partial()));
    if (err instanceof EngineError && err.kind !== EngineFailureKind.Other) throw err;
    const message = err instanceof Error ? err.message : String(err);
    return metered(partialDelegateResult(this.id, { stopReason: StopReason.Error, errorText: message }, partial()));
  }

  /** A failure OpenCode reported: one with a status the run policy knows is thrown, the rest is an outcome. */
  #failedEnding(
    failure: { message: string; status: number | null },
    partial: () => PartialDelegateState,
    model: string | undefined,
  ): DelegateResult {
    const blocked = this.#blockedHostText(failure, model);
    const error = failureError(this.id, failure);
    if (!blocked && error.kind !== EngineFailureKind.Other) throw this.#namedFreeModel(error, failure, model);
    const free = this.#ranFreeModel(model) ? MESSAGE.FreeModelFailed(this.#label(model), failure.message) : null;
    const errorText = blocked ?? this.#refusedModelText(failure, model) ?? free ?? failure.message;
    return metered(partialDelegateResult(this.id, { stopReason: StopReason.Error, errorText }, partial()));
  }

  /** A model's name as the picker shows it, or null with no pick. */
  #label(model: string | undefined): string | null {
    if (!model) return null;
    return this.#catalog.models().find((row) => row.id === model)?.label ?? model;
  }

  /** Did the run use one of OpenCode's free models: the one picked, or OpenCode's own default with no sign-in? */
  #ranFreeModel(model: string | undefined): boolean {
    if (model) return this.#anonymous.has(model);
    return !this.#signedIn && this.#anonymous.size > 0;
  }

  /** A failure on a free model, said as one, of the same kind so the run waits or stops as before. */
  #namedFreeModel(error: EngineError, failure: { message: string }, model: string | undefined): EngineError {
    if (!this.#ranFreeModel(model)) return error;
    const message = MESSAGE.FreeModelFailed(this.#label(model), failure.message);
    return new EngineError(error.kind, this.id, message, error.retryAfterMs);
  }

  /**
   * A 403 for a picked model whose provider has no host Genex knows: the sandbox's proxy refused
   * it, since no other host was open to the session. Null for anything else.
   */
  #blockedHostText(failure: { status: number | null }, model: string | undefined): string | null {
    if (!model || failure.status !== PROXY_REFUSED_STATUS) return null;
    const hosts = this.#hosts.get(model);
    if (!hosts || hosts.length > 0) return null;
    return MESSAGE.HostUnknown(model.slice(0, model.indexOf("/")));
  }

  /** A picked model the provider refused, by its name and with the provider's words; null for anything else. */
  #refusedModelText(failure: { message: string; status: number | null }, model: string | undefined): string | null {
    if (!model || failure.status === null || !MODEL_REFUSED_STATUSES.has(failure.status)) return null;
    return MESSAGE.ModelRefused(this.#label(model) ?? model, failure.message);
  }
}

/** The sandbox a session runs in: the folder it works in, its own state folders, and nothing it must not read. */
export function openCodeSandbox(input: {
  runDir: string;
  gameDir: string;
  gitDirs: string[];
  scratchDir: string;
  secretPaths: string[];
  toolPath?: () => Promise<string>;
  env?: Record<string, string | undefined>;
  home?: string;
}): SandboxOptions {
  const env = input.env ?? process.env;
  const home = input.home ?? os.homedir();
  const state = path.join(xdg(env.XDG_STATE_HOME, home, ".local/state"), "opencode");
  const cache = path.join(xdg(env.XDG_CACHE_HOME, home, ".cache"), "opencode");
  return {
    writableRoots: [input.runDir, ...input.gitDirs, state, cache],
    scratchDir: input.scratchDir,
    secretPaths: input.secretPaths,
    ownHome: [openCodeDataHome(env, home)],
    // A game's own OpenCode config and plugins are never the session's to plant.
    denyWrite: [path.join(input.gameDir, "opencode.json"), path.join(input.gameDir, ".opencode")],
    ...(input.toolPath ? { toolPath: input.toolPath } : {}),
  };
}

/** An XDG folder: the variable when it is absolute, else its default under the home folder. */
function xdg(value: string | undefined, home: string, fallback: string): string {
  return value && path.isAbsolute(value) ? value : path.join(home, fallback);
}

/** The variables a session starts with, over the sandbox's allow-listed environment. */
function sessionEnv(config: string): Record<string, string> {
  const env: Record<string, string> = { OPENCODE_CONFIG_CONTENT: config, OPENCODE_DISABLE_AUTOUPDATE: "1" };
  // OpenCode finds its sign-ins and sessions through these; the sandbox's own environment drops them.
  for (const key of ["XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) {
    const value = process.env[key];
    if (value && path.isAbsolute(value)) env[key] = value;
  }
  return env;
}

/** What a session's tools may do: a build edits; a read-only session, a lead while its build runs and Plan only look. */
function sessionAccess(request: DelegateRequest): OpenCodeAccess {
  const readOnly = Boolean(request.readOnly) && !request.coordinator;
  return readOnly || chatMode(request) === PermissionMode.Plan ? OpenCodeAccess.ReadOnly : OpenCodeAccess.Build;
}

/** The chat's mode as OpenCode honours it (Auto or Plan), or null for unattended work. */
function chatMode(request: DelegateRequest): PermissionMode | null {
  return request.permissions ? engineMode(EngineId.OpenCode, request.permissions.mode) : null;
}

/** A judge's question as one prompt: the system words, the conversation, and the critic's two rules. */
function answerPrompt(request: CompleteRequest): string {
  const conversation = request.messages.map((message) => `${message.role.toUpperCase()}:\n${message.content}`);
  return [request.systemPrompt ?? "", ...conversation, ...JUDGE_RULES].filter((part) => part.trim()).join("\n\n");
}

function newRun(engine: string, resume: string | undefined): OpenCodeRun {
  return { usage: { engine }, turns: 0, summary: "", sessionId: resume, failure: null, deadlineHit: false };
}

/** The usage counts each step reports, added up over a session. */
const SUMMED_USAGE = [
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "reasoning_tokens",
  "cost_usd",
] as const;

/** One translated event: forwarded to the log, and folded into the run. */
function applyTranslated(request: Pick<DelegateRequest, "onEvent">, run: OpenCodeRun, translated: Translated): void {
  if (translated.sessionId) run.sessionId = translated.sessionId;
  for (const event of translated.events)
    request.onEvent?.(event as Parameters<NonNullable<DelegateRequest["onEvent"]>>[0]);
  if (translated.text) run.summary = translated.text;
  if (translated.turns) run.turns += translated.turns;
  if (translated.failure) run.failure = translated.failure;
  for (const key of SUMMED_USAGE) {
    const value = translated.usage?.[key];
    if (typeof value === "number") run.usage[key] = (run.usage[key] ?? 0) + value;
  }
}

/** What a run cut short had done. */
function partialState(
  run: OpenCodeRun,
  startedAt: number,
  model: string | undefined,
  bridge: StudioBridge | null,
  request: DelegateRequest,
): PartialDelegateState {
  return {
    summary: run.summary,
    usage: run.usage,
    turns: run.turns,
    startedAt,
    sessionId: run.sessionId,
    model,
    requestedModel: model,
    studioToolCalls: recordedCalls(bridge, request),
  };
}

/** The interview calls the bridge recorded: the studio's own tools are not calls to run. */
function recordedCalls(
  bridge: StudioBridge | null,
  request: DelegateRequest,
): NonNullable<DelegateResult["studioToolCalls"]> {
  const interview = new Set((request.interviewTools ?? []).map((tool) => tool.name));
  return (bridge?.calls ?? []).filter((call) => interview.has(call.name));
}

/** A session whose turn completed. OpenCode runs on whatever the person signed it in to: billed as an API. */
function completed(
  engine: string,
  run: OpenCodeRun,
  startedAt: number,
  model: string | undefined,
  studioToolCalls: NonNullable<DelegateResult["studioToolCalls"]>,
): DelegateResult {
  return {
    ok: true,
    summary: run.summary,
    usage: run.usage,
    turns: run.turns,
    billing: "api",
    engine,
    durationMs: Date.now() - startedAt,
    stopReason: StopReason.Completed,
    ...(model ? { model, requestedModel: model } : {}),
    ...(run.sessionId ? { sessionId: run.sessionId } : {}),
    ...(studioToolCalls.length ? { studioToolCalls } : {}),
  };
}

/** A partial result, billed as OpenCode's work is. */
function metered(result: DelegateResult): DelegateResult {
  return { ...result, billing: "api" };
}

/** A reported failure as an engine error: by the HTTP status the provider answered, never by its words. */
function failureError(engine: string, failure: { message: string; status: number | null }): EngineError {
  if (failure.status !== null) return classifyHttpFailure(engine, failure.status, failure.message);
  return new EngineError(EngineFailureKind.Other, engine, failure.message);
}

/** The CLI's state for its account row: working, installed but unusable, or missing. */
function cliState(cli: { ready: boolean; path?: string }): EngineAccount["cli"]["state"] {
  if (cli.ready) return CodingCliState.Ready;
  return cli.path ? CodingCliState.Incompatible : CodingCliState.Missing;
}

/** Where the CLI is, whether it works, and its version. */
async function defaultResolveCli(): Promise<{ ready: boolean; path?: string; version?: string; detail: string }> {
  const installation = await resolveCodingCli(EngineId.OpenCode);
  const { state, path: binary, version, detail } = installation.status;
  return {
    ready: state === CodingCliState.Ready && Boolean(binary),
    ...(binary ? { path: binary } : {}),
    ...(version ? { version } : {}),
    detail,
  };
}

/** `opencode models --verbose`, run on the host: a listing, no session and no prompt. */
async function listOpenCodeModels(binary: string | undefined): Promise<string> {
  if (!binary) return "";
  const env = childEnv(process.env, {
    base: "contractor",
    vendor: "opencode",
    set: { OPENCODE_DISABLE_AUTOUPDATE: "1" },
  });
  const result = await runCommand(binary, ["models", "--verbose"], {
    env,
    timeoutMs: Math.max(MODELS_TIMEOUT_MS, CATALOG_DEADLINE_MS),
  });
  if (result.code !== 0) throw new Error(result.stderr.trim() || MESSAGE.Stopped(result.code));
  return result.stdout;
}

/** A linked worktree's Git metadata outside the workspace, which a build must be able to commit to. */
async function gitMetadata(cwd: string): Promise<string[]> {
  const dirs: string[] = [];
  for (const flag of ["--absolute-git-dir", "--git-common-dir"]) {
    const answer = await promisify(execFile)("git", ["-C", cwd, "rev-parse", flag], {
      timeout: GIT_PROBE_TIMEOUT_MS,
    }).catch(() => null);
    if (answer)
      dirs.push(
        await realpath(path.resolve(cwd, answer.stdout.trim())).catch(() => path.resolve(cwd, answer.stdout.trim())),
      );
  }
  return [...new Set(dirs)];
}

/**
 * Start `opencode run` inside the studio's sandbox and yield its events. The prompt goes in on
 * stdin (a brief is thousands of characters, and argv is not the place for it). OpenCode exits 0
 * even when its turn failed, so the `error` event, not the exit code, says that; a non-zero exit
 * with nothing said is the CLI failing to start, and stderr explains it.
 */
async function* runOpenCode(invocation: OpenCodeInvocation): AsyncGenerator<Record<string, unknown>> {
  invocation.signal.throwIfAborted();
  const installation = await resolveCodingCli(EngineId.OpenCode);
  const binary = installation.status.path;
  if (!binary) throw new EngineError(EngineFailureKind.Unavailable, EngineId.OpenCode, MESSAGE.NotInstalled);
  const sandbox = await ProcessSandbox.create(invocation.sandbox);
  try {
    const command = [binary, ...invocation.argv].map(shellQuote).join(" ");
    const { child } = await sandbox.spawnLongLived({
      command,
      cwd: invocation.cwd,
      env: invocation.env,
      label: `opencode:${path.basename(invocation.cwd)}`,
      policy: { allowedDomains: invocation.domains },
    });
    yield* childEvents(child, invocation);
  } finally {
    await sandbox.dispose().catch(() => {});
  }
}

/** The child's stdout as events, stopping it on abort; a silent non-zero exit throws stderr's words. */
async function* childEvents(
  child: ChildProcess,
  invocation: OpenCodeInvocation,
): AsyncGenerator<Record<string, unknown>> {
  child.stdin?.end(invocation.prompt);
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-STDERR_TAIL_CHARS);
  });
  const onAbort = (): void => {
    void stopChild(child, { signal: "SIGTERM" });
    setTimeout(() => void stopChild(child), KILL_GRACE_MS).unref?.();
  };
  if (invocation.signal.aborted) onAbort();
  else invocation.signal.addEventListener("abort", onAbort, { once: true });
  const exit = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code));
  });
  let said = false;
  try {
    if (child.stdout) {
      for await (const line of createInterface({ input: child.stdout })) {
        const event = parseOpenCodeLine(line);
        if (!event) continue;
        said = true;
        yield event;
      }
    }
  } finally {
    invocation.signal.removeEventListener("abort", onAbort);
  }
  const code = await exit;
  if (code !== 0 && !said && !invocation.signal.aborted) throw new Error(stderr.trim() || MESSAGE.Stopped(code));
}
