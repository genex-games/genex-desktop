/**
 * Grok Build: xAI's coding CLI as a delegated harness, driven through `grok --prompt-file …
 * --output-format streaming-json`.
 *
 * Grok Build runs its own agent loop on the person's own Grok sign-in (`grok login`, in the
 * browser) and keeps that sign-in in its home, which the studio never reads; an xAI key the
 * person's shell exports never reaches it (`childEnv`), so the studio never turns it into a
 * per-token bill. Whether it is signed in and which models it runs, the CLI says itself
 * (`probeGrok`). Like OpenCode it brings no sandbox the studio can rely on, so every session runs
 * inside the studio's `ProcessSandbox`: the workspace (or, read-only, a scratch folder) is all it
 * can write, the studio's secrets and every other CLI's sign-in stay unreadable, and only xAI's
 * hosts are reachable. Its own permission rules keep a read-only session to reading and the
 * studio bridge (`grokTurnArgv`).
 *
 * The prompt goes in a file of ACP content blocks (pictures included: Grok reads no piped stdin,
 * and on Windows the sandbox would not pass one on); each stdout line is one event
 * (`grok-events.ts`); a session is resumed by its id (`--resume`). Studio tools arrive through the
 * file bridge Codex uses.
 */
import { execFile } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { ModelCatalog } from "./model-catalog.ts";
import { cliVersion, resolveCodingCli } from "./external-cli.ts";
import { lockUnowned, ownershipBriefing, releaseLocks, releaseStaleLocks, type LockRecord } from "./ownership-locks.ts";
import { StudioBridge, answerBridgeCall, bridgeTools } from "./studio-bridge.ts";
import { BLIND_JUDGE_NOTE, JUDGE_RULES, offLimitsNote, planModeNote, readOnlyNote } from "./codex-prompts.ts";
import {
  GROK_HOSTS,
  GrokAccess,
  GrokAuthMethod,
  type GrokAccount,
  type GrokProbe,
  grokCompactArgv,
  grokEnv,
  grokPromptBlocks,
  grokSandbox,
  grokTurnArgv,
  probeGrok,
} from "./grok-cli.ts";
import { grokStderrStatus, grokStream, parseGrokLine, type Translated } from "./grok-events.ts";
import {
  type CompleteRequest,
  type CompleteResponse,
  DelegateEventType,
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
import { credentialHomes, grokHome } from "../credential-homes.ts";
import { stopChild } from "../process-tree.ts";
import type { Usage } from "../types.ts";
import { CodingCliState } from "../../shared/coding-cli.ts";
import { ContextSource } from "../../shared/context.ts";
import { MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";
import { type EngineAccount, EngineKind, EngineStatusCode, LoginSource } from "../../shared/engine-descriptor.ts";
import { EngineFailureKind, StopReason } from "../../shared/engine-requests.ts";
import { ModelCatalogSource } from "../../shared/model-catalog.ts";
import { engineMode, PermissionMode } from "../../shared/permissions.ts";
import { EngineId } from "../../shared/providers.ts";
import { t } from "../../shared/i18n.ts";
import { stripTerminalCodes } from "../../shared/terminal.ts";

/** How long a git probe for a worktree's metadata may take. */
const GIT_PROBE_TIMEOUT_MS = 5 * SECOND_MS;
/** How long a judge's one-shot answer may take before it is a timeout. */
const COMPLETE_TIMEOUT_MS = 15 * MINUTE_MS;
/** How long a stopped session gets to exit politely before it is killed. */
const KILL_GRACE_MS = 3 * SECOND_MS;
/** How much of stderr is kept to explain an exit the event stream never explained. */
const STDERR_TAIL_CHARS = 4_000;
/** The file a turn's prompt is written to, in a folder of its own. */
const PROMPT_FILE = "prompt.json";
/** The sandbox's temporary folder under the engine's scratch root. */
const TEMPORARY_DIR = "tmp";
/** The usage counts each model response reports, added up over a run cut short before its end. */
const SUMMED_USAGE = [
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "reasoning_tokens",
] as const;
/**
 * The statuses that refuse the request itself (a model the account does not run, a model gone):
 * no wait or retry helps, another model might.
 */
const MODEL_REFUSED_STATUSES: ReadonlySet<number> = new Set([400, 404]);

/**
 * What this engine says: statuses and remedies for Settings in the person's language (functions,
 * since main sets its language after it starts), and errors in English, since the harness and the
 * chat's model read them too.
 */
const MESSAGE = {
  NotInstalled: "Grok Build isn't installed on this Mac.",
  NotInstalledStatus: () => t("Grok Build isn't installed on this Mac."),
  InstallRemedy: () => t("Install Grok Build from Settings › Model Providers."),
  SignedOut: () => t("Grok Build isn't signed in."),
  SignInRemedy: () => t("Sign in to Grok from Settings › Model Providers."),
  Blocked: (reason: string) => t("xAI blocked this Grok account: {reason}", { reason }),
  Unreachable: () => t("Grok Build didn't answer. Check the installation, then try again."),
  Ready: (version: string | undefined, count: number) =>
    t("Grok Build {version}, {count, plural, one {# model} other {# models}}", {
      version: version ?? "",
      count,
    }).trim(),
  SignedOutRun: "Grok Build isn't signed in. Sign in to Grok from Settings › Model Providers, then send again.",
  NoTools: "Grok Build's one-shot answers take no studio tools",
  NotCompacted: "Grok Build did not compact the session",
  Stopped: (code: number | null) => `Grok Build exited with ${code}`,
  ModelRefused: (model: string, words: string) =>
    `xAI refused ${model} (${words}). Pick another model, then send again.`,
  NoAnswer: "Grok Build gave no answer",
  JudgeTimedOut: (minutes: number) => `the judge did not answer within ${minutes} min`,
} as const;

/** One `grok` run, as the engine starts it; injectable in tests. */
export interface GrokInvocation {
  argv: string[];
  /** Where the session runs: the workspace, or a read-only session's scratch folder. */
  cwd: string;
  env: Record<string, string>;
  signal: AbortSignal;
  /** The sandbox the real CLI is started in. */
  sandbox: SandboxOptions;
  /** The hosts the session may reach. */
  domains: string[];
  /** Hears the CLI's error log, which names the HTTP status of a failed call. */
  onStderr: (chunk: string) => void;
}
export type GrokExec = (invocation: GrokInvocation) => AsyncIterable<Record<string, unknown>>;

/** Where the CLI is, whether it works, and its version. */
type ResolvedCli = { ready: boolean; path?: string; version?: string; detail: string };

export interface GrokEngineOptions {
  /**
   * Where read-only sessions run and their prompts and temporary files go: never under the engine
   * homes, which every sandbox denies. The system temporary folder when not given.
   */
  scratchRoot?: string;
  /** What no Grok session may read: the studio's secrets, the engines' homes. */
  protectedPaths?: string[];
  toolPath?: () => Promise<string>;
  onModelsChanged?: () => void;
  /** Where locks are recovered from after a crash (as Codex's). */
  lockRecovery?: string;
  /** Grok Build's home (its sign-in, sessions and settings); `grokHome()` when not given. */
  home?: string;
  /** Test seam: run a session without the CLI. */
  execFn?: GrokExec;
  /** Test seam: the sign-in and models, instead of asking the CLI. */
  probe?: () => Promise<GrokProbe>;
  /** Test seam: where the CLI is and whether it works. */
  resolveCli?: () => Promise<ResolvedCli>;
}

/** What a session has done so far. */
interface GrokRun {
  usage: Usage;
  turns: number;
  summary: string;
  sessionId: string | undefined;
  failure: { message: string; status: number | null } | null;
  /** The last response's whole prompt: how full the session's context is. */
  contextTokens: number | undefined;
  compacted: boolean;
  /** The CLI's error log, last part. */
  stderr: string;
  deadlineHit: boolean;
}

/** How a session's turn is set up. */
interface TurnSetup {
  access: GrokAccess;
  cwd: string;
  runDir: string;
  bridge: boolean;
  prompt: string;
  images: ReadonlyArray<{ data: string; mimeType: string }>;
  signal: AbortSignal;
}

export class GrokEngine implements Engine {
  readonly id = EngineId.Grok;
  readonly label = "Grok Build";
  readonly kind = EngineKind.Delegated;
  readonly supportsSessions = true;
  /** Compact Now runs Grok's own `/compact` on the resumed session. */
  readonly compactsNatively = true;
  readonly #scratchRoot: string;
  readonly #protectedPaths: string[];
  readonly #toolPath: (() => Promise<string>) | undefined;
  readonly #catalog: ModelCatalog;
  readonly #execFn: GrokExec | undefined;
  readonly #probe: (() => Promise<GrokProbe>) | undefined;
  readonly #resolveCli: () => Promise<ResolvedCli>;
  readonly #lockRecovery: string | undefined;
  readonly #home: string;
  /** Whose sign-in the probe the picker shows found; none before the first one. */
  #account: GrokAccount | null = null;

  constructor(options: GrokEngineOptions = {}) {
    this.#scratchRoot = options.scratchRoot ?? path.join(os.tmpdir(), `studio-${EngineId.Grok}`);
    this.#protectedPaths = options.protectedPaths ?? [];
    this.#toolPath = options.toolPath;
    this.#catalog = new ModelCatalog(options.onModelsChanged);
    this.#execFn = options.execFn;
    this.#probe = options.probe;
    this.#resolveCli = options.resolveCli ?? defaultResolveCli;
    this.#lockRecovery = options.lockRecovery;
    this.#home = options.home ?? grokHome();
  }

  async status(): Promise<EngineStatus> {
    const cli = await this.#resolveCli();
    if (!cli.ready && !cli.path)
      return {
        code: EngineStatusCode.NotInstalled,
        detail: MESSAGE.NotInstalledStatus(),
        remedy: MESSAGE.InstallRemedy(),
      };
    if (!cli.ready) return { code: EngineStatusCode.Error, detail: cli.detail };
    await this.refreshModels().catch(() => {});
    const account = this.#account;
    if (!account) return { code: EngineStatusCode.Error, detail: MESSAGE.Unreachable() };
    if (account.blocked)
      return {
        code: EngineStatusCode.NeedsLogin,
        detail: MESSAGE.Blocked(account.blocked),
        remedy: MESSAGE.SignInRemedy(),
      };
    if (!account.method)
      return { code: EngineStatusCode.NeedsLogin, detail: MESSAGE.SignedOut(), remedy: MESSAGE.SignInRemedy() };
    return {
      code: EngineStatusCode.Ready,
      detail: MESSAGE.Ready(cliVersion(cli.version), this.#catalog.models().length),
    };
  }

  /** Whose sign-in Grok Build runs on: its own (`system`) once it says one, else none. Genex never reads it. */
  async account(): Promise<EngineAccount> {
    const cli = await this.#resolveCli();
    if (cli.ready) await this.refreshModels().catch(() => {});
    return {
      source: this.#account?.method ? LoginSource.System : LoginSource.None,
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

  /** The models Grok Build offers and whose sign-in it runs on, as it says; a new sign-in shows on the next refresh. */
  async refreshModels(force = false): Promise<void> {
    const cli = await this.#resolveCli();
    if (!cli.ready) return;
    await this.#catalog.refresh(
      `${cli.path ?? ""}\0${cli.version ?? ""}`,
      async () => {
        const probe = this.#probe ? await this.#probe() : await this.#probeCli(cli.path);
        this.#account = probe.account;
        return { models: probe.models, source: ModelCatalogSource.Provider };
      },
      force,
    );
  }

  /** `grok agent stdio`, asked on the host with the session's own environment, from a folder of its own. */
  async #probeCli(binary: string | undefined): Promise<GrokProbe> {
    if (!binary) throw new EngineError(EngineFailureKind.Unavailable, this.id, MESSAGE.NotInstalled);
    await mkdir(this.#scratchRoot, { recursive: true });
    const env = childEnv(process.env, { base: "contractor", vendor: "grok", set: grokEnv(this.#home) });
    return probeGrok(binary, { env, cwd: this.#scratchRoot });
  }

  /** Grok Build keeps its own default model; with none picked, `--model` is left out and it uses that. */
  async defaultModel(): Promise<string | null> {
    return null;
  }

  async delegate(request: DelegateRequest): Promise<DelegateResult> {
    if (request.compact) return this.#compact(request);
    const startedAt = Date.now();
    const cwd = await realpath(path.resolve(request.cwd));
    const run = newRun(this.id, request.resume);
    const controller = abortControllerFor(request.signal);
    await releaseStaleLocks(cwd, this.#lockRecovery).catch(() => {});
    const locks = request.ownership
      ? await lockUnowned(cwd, request.ownership, this.#lockRecovery).catch(() => null)
      : null;
    const access = sessionAccess(request);
    const scratch = access === GrokAccess.Build ? null : await this.#scratch("run-");
    const runDir = scratch ?? cwd;
    const bridge = await this.#openBridge(request, runDir).catch(async (err) => {
      await this.#cleanUp(cwd, locks, scratch, null);
      throw err;
    });
    const deadline = request.timeoutMs
      ? setTimeout(() => {
          run.deadlineHit = true;
          controller.abort();
        }, request.timeoutMs)
      : null;
    const partial = (): PartialDelegateState => partialState(run, startedAt, request.model, bridge, request);
    try {
      const prompt = this.#brief(request, { access, cwd, scratch, locks, bridge });
      const turn = { access, cwd, runDir, bridge: Boolean(bridge), prompt, images: request.images ?? [] };
      await this.#runTurn(request, run, { ...turn, signal: controller.signal });
    } catch (err) {
      return this.#endingAfterThrow(err, run, request, partial);
    } finally {
      if (deadline) clearTimeout(deadline);
      await this.#cleanUp(cwd, locks, scratch, bridge);
    }
    if (request.signal?.aborted || run.deadlineHit)
      return this.#billed(partialDelegateResult(this.id, interruption(request.signal?.aborted), partial()));
    if (run.failure) return this.#failedEnding(run, partial, request.model);
    return completed(this, run, startedAt, request.model, recordedCalls(bridge, request));
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
    let run: GrokRun;
    try {
      run = await this.#answer(request, controller.signal);
    } catch (err) {
      throw stopped() ?? err;
    } finally {
      clearTimeout(timer);
    }
    const stop = stopped();
    if (stop) throw stop;
    if (run.failure) throw await this.#failureError(run);
    if (!run.summary) throw new EngineError(EngineFailureKind.Other, this.id, MESSAGE.NoAnswer);
    return {
      message: { role: "assistant", content: run.summary },
      usage: run.usage,
      stopReason: CompletionStop.Stop,
      model: request.model ?? "",
      engine: this.id,
    };
  }

  /** One answer session in a scratch folder, its pictures in the prompt; the folder removed after. */
  async #answer(request: CompleteRequest, signal: AbortSignal): Promise<GrokRun> {
    const scratch = await this.#scratch("answer-");
    const images = request.messages.flatMap((message) => message.images ?? []);
    const run = newRun(this.id, undefined);
    const asked = {
      ...(request.model ? { model: request.model } : {}),
      ...(request.effort ? { effort: request.effort } : {}),
    };
    try {
      const turn = { access: GrokAccess.Answer, cwd: scratch, runDir: scratch, bridge: false, images, signal };
      await this.#runTurn(asked, run, { ...turn, prompt: answerPrompt(request) });
      return run;
    } finally {
      await rm(scratch, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * Compact Now: the resumed session compacts itself with Grok's own `/compact`, and no turn runs.
   * It goes on under the same id.
   */
  async #compact(request: DelegateRequest): Promise<DelegateResult> {
    const startedAt = Date.now();
    const cwd = await realpath(path.resolve(request.cwd));
    const run = newRun(this.id, request.resume);
    const controller = abortControllerFor(request.signal);
    const partial = (): PartialDelegateState => partialState(run, startedAt, request.model, null, request);
    try {
      const invocation = await this.#invocation(grokCompactArgv(request.resume ?? "", cwd), {
        access: GrokAccess.Build,
        cwd,
        runDir: cwd,
        signal: controller.signal,
        run,
      });
      await this.#readEvents(request, run, invocation);
    } catch (err) {
      return this.#endingAfterThrow(err, run, request, partial);
    }
    if (request.signal?.aborted) return this.#billed(partialDelegateResult(this.id, interruption(true), partial()));
    if (!run.compacted) {
      const ending = { stopReason: StopReason.Error, errorText: run.failure?.message ?? MESSAGE.NotCompacted };
      return this.#billed(partialDelegateResult(this.id, ending, partial()));
    }
    return { ...completed(this, run, startedAt, request.model, []), compacted: true };
  }

  /** One turn: its prompt file, its command line, and its events read to the end. */
  async #runTurn(
    request: Pick<DelegateRequest, "model" | "effort" | "resume" | "denyReads" | "onEvent">,
    run: GrokRun,
    turn: TurnSetup,
  ): Promise<void> {
    // In the sandbox's own temporary folder: readable to the session wherever it runs.
    const temporary = path.join(this.#scratchRoot, TEMPORARY_DIR);
    await mkdir(temporary, { recursive: true });
    const folder = await mkdtemp(path.join(temporary, "prompt-"));
    try {
      const promptFile = path.join(folder, PROMPT_FILE);
      await writeFile(promptFile, grokPromptBlocks(turn.prompt, turn.images), "utf8");
      const argv = grokTurnArgv({
        access: turn.access,
        promptFile,
        cwd: turn.runDir,
        model: request.model,
        effort: request.model && request.effort ? this.#effort(request.model, request.effort) : null,
        resume: request.resume,
        bridge: turn.bridge,
      });
      const invocation = await this.#invocation(argv, { ...turn, run }, request.denyReads ?? []);
      await this.#readEvents(request, run, invocation);
    } finally {
      await rm(folder, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** The effort a model offers, or none when it offers no such dial. */
  #effort(model: string, effort: string): string | null {
    const row = this.#catalog.models().find((candidate) => candidate.id === model);
    return row?.efforts?.includes(effort) ? effort : null;
  }

  /** The command, environment and sandbox of one run. */
  async #invocation(
    argv: string[],
    ctx: { access: GrokAccess; cwd: string; runDir: string; signal: AbortSignal; run: GrokRun },
    denyReads: string[] = [],
  ): Promise<GrokInvocation> {
    const sandbox = grokSandbox({
      runDir: ctx.runDir,
      gameDir: ctx.cwd,
      gitDirs: ctx.access === GrokAccess.Build ? await gitMetadata(ctx.cwd) : [],
      scratchDir: path.join(this.#scratchRoot, TEMPORARY_DIR),
      secretPaths: [...this.#protectedPaths, ...denyReads],
      home: this.#home,
      ...(this.#toolPath ? { toolPath: this.#toolPath } : {}),
    });
    return {
      argv,
      cwd: ctx.runDir,
      env: grokEnv(this.#home),
      signal: ctx.signal,
      sandbox,
      domains: [...GROK_HOSTS],
      onStderr: (chunk) => {
        ctx.run.stderr = `${ctx.run.stderr}${chunk}`.slice(-STDERR_TAIL_CHARS);
      },
    };
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

  /** The brief, plus what Grok can only be told: its tools, its seam, its folder, what is off limits. */
  #brief(
    request: DelegateRequest,
    ctx: {
      access: GrokAccess;
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
      ctx.access === GrokAccess.Blind ? BLIND_JUDGE_NOTE : "",
      plan
        ? planModeNote(ctx.cwd, ctx.scratch ?? "")
        : readOnlyNote(
            // A reviewer's cwd is its own empty home: the build it tests is the folder it reads.
            request.reviewer?.reads ?? ctx.cwd,
            ctx.scratch,
            request.director ? path.resolve(request.director.root) : null,
          ),
      offLimitsNote([...this.#protectedPaths, ...credentialHomes(), ...(request.denyReads ?? [])]),
    ]
      .filter((part) => part.trim())
      .join("\n\n");
  }

  /** Read the run's events to the end: the chat's live rows, its tokens, its context and its summary. */
  async #readEvents(
    request: Pick<DelegateRequest, "onEvent" | "model">,
    run: GrokRun,
    invocation: GrokInvocation,
  ): Promise<void> {
    const stream = grokStream();
    const events = (this.#execFn ?? runGrok)(invocation);
    for await (const event of events) this.#apply(request, run, stream.translate(event));
    this.#apply(request, run, stream.flush());
  }

  /** One translated event: forwarded to the log, and folded into the run. */
  #apply(request: Pick<DelegateRequest, "onEvent" | "model">, run: GrokRun, translated: Translated): void {
    if (translated.sessionId) run.sessionId = translated.sessionId;
    const phase = translated.activity;
    if (phase)
      request.onEvent?.({
        type: DelegateEventType.Activity,
        payload: { phase, engine: this.id, sessionId: run.sessionId },
      });
    for (const event of translated.events)
      request.onEvent?.(event as Parameters<NonNullable<DelegateRequest["onEvent"]>>[0]);
    if (translated.text) run.summary = translated.text;
    if (translated.failure) run.failure = translated.failure;
    if (translated.compacted) {
      run.compacted = true;
      run.usage.compactions = (run.usage.compactions ?? 0) + 1;
    }
    countTokens(run, translated);
    if (translated.promptTokens) this.#readContext(request, run, translated.promptTokens);
  }

  /** How full the session's context is after a response, against its model's window. */
  #readContext(request: Pick<DelegateRequest, "onEvent" | "model">, run: GrokRun, promptTokens: number): void {
    run.contextTokens = promptTokens;
    const window = this.#catalog.models().find((model) => model.id === request.model)?.contextWindow;
    request.onEvent?.({
      type: DelegateEventType.Context,
      payload: {
        engine: this.id,
        sessionId: run.sessionId,
        requestedModel: request.model ?? null,
        source: ContextSource.Provider,
        promptTokens,
        ...(window ? { contextWindow: window, percent: Math.min(100, (100 * promptTokens) / window) } : {}),
      },
    });
  }

  /** A throw is a stop, a deadline, or a failure the run policy acts on. */
  #endingAfterThrow(
    err: unknown,
    run: GrokRun,
    request: DelegateRequest,
    partial: () => PartialDelegateState,
  ): DelegateResult {
    if (request.signal?.aborted || run.deadlineHit)
      return this.#billed(partialDelegateResult(this.id, interruption(request.signal?.aborted), partial()));
    if (err instanceof EngineError && err.kind !== EngineFailureKind.Other) throw err;
    const message = err instanceof Error ? err.message : String(err);
    return this.#billed(
      partialDelegateResult(this.id, { stopReason: StopReason.Error, errorText: message }, partial()),
    );
  }

  /** A failure Grok reported: one the run policy knows is thrown, the rest is an outcome. */
  async #failedEnding(
    run: GrokRun,
    partial: () => PartialDelegateState,
    model: string | undefined,
  ): Promise<DelegateResult> {
    const error = await this.#failureError(run);
    if (error.kind !== EngineFailureKind.Other) throw error;
    const failure = run.failure ?? { message: MESSAGE.NoAnswer, status: null };
    const refused = model && failure.status !== null && MODEL_REFUSED_STATUSES.has(failure.status);
    const errorText = refused ? MESSAGE.ModelRefused(this.#label(model), failure.message) : failure.message;
    return this.#billed(partialDelegateResult(this.id, { stopReason: StopReason.Error, errorText }, partial()));
  }

  /**
   * A reported failure as an engine error: by the HTTP status xAI answered (in the error, else in
   * the CLI's error log), never by its words. One with no status at all is asked of the CLI: a
   * session that failed because Grok Build is signed out is a sign-in failure.
   */
  async #failureError(run: GrokRun): Promise<EngineError> {
    const failure = run.failure ?? { message: MESSAGE.NoAnswer, status: null };
    const status = failure.status ?? grokStderrStatus(run.stderr);
    if (status !== null) return classifyHttpFailure(this.id, status, failure.message);
    await this.refreshModels(true).catch(() => {});
    if (this.#account && !this.#account.method)
      return new EngineError(EngineFailureKind.Auth, this.id, MESSAGE.SignedOutRun);
    return new EngineError(EngineFailureKind.Other, this.id, failure.message);
  }

  /** A model's name as the picker shows it. */
  #label(model: string): string {
    return this.#catalog.models().find((row) => row.id === model)?.label ?? model;
  }

  /** Who pays for this work: an xAI API key is billed per token; the person's Grok sign-in is their plan. */
  billing(): DelegateResult["billing"] {
    return this.#account?.method === GrokAuthMethod.ApiKey ? "api" : "subscription";
  }

  #billed(result: DelegateResult): DelegateResult {
    return { ...result, billing: this.billing() };
  }
}

/**
 * A response's tokens are added up as they come, so a run cut short still counts them; the turn's
 * end replaces the sum with the CLI's own total.
 */
function countTokens(run: GrokRun, translated: Translated): void {
  if (translated.usage) {
    for (const key of SUMMED_USAGE) run.usage[key] = (run.usage[key] ?? 0) + (translated.usage[key] ?? 0);
    run.turns += translated.turns ?? 0;
  }
  if (!translated.totals) return;
  Object.assign(run.usage, translated.totals);
  if (translated.turns !== undefined) run.turns = translated.turns;
}

/** What a session's tools may do: a build edits; a read-only session, a lead while its build runs and Plan only look. */
function sessionAccess(request: DelegateRequest): GrokAccess {
  if (request.blind) return GrokAccess.Blind;
  const readOnly = Boolean(request.readOnly) && !request.coordinator;
  return readOnly || chatMode(request) === PermissionMode.Plan ? GrokAccess.ReadOnly : GrokAccess.Build;
}

/** The chat's mode as Grok Build honours it (Auto or Plan), or null for unattended work. */
function chatMode(request: DelegateRequest): PermissionMode | null {
  return request.permissions ? engineMode(EngineId.Grok, request.permissions.mode) : null;
}

/** A judge's question as one prompt: the system words, the conversation, and the critic's two rules. */
function answerPrompt(request: CompleteRequest): string {
  const conversation = request.messages.map((message) => `${message.role.toUpperCase()}:\n${message.content}`);
  return [request.systemPrompt ?? "", ...conversation, ...JUDGE_RULES].filter((part) => part.trim()).join("\n\n");
}

function newRun(engine: string, resume: string | undefined): GrokRun {
  return {
    usage: { engine },
    turns: 0,
    summary: "",
    sessionId: resume,
    failure: null,
    contextTokens: undefined,
    compacted: false,
    stderr: "",
    deadlineHit: false,
  };
}

/** What a run cut short had done. */
function partialState(
  run: GrokRun,
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
    contextTokens: run.contextTokens,
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

/** A session whose turn completed. */
function completed(
  engine: GrokEngine,
  run: GrokRun,
  startedAt: number,
  model: string | undefined,
  studioToolCalls: NonNullable<DelegateResult["studioToolCalls"]>,
): DelegateResult {
  return {
    ok: true,
    summary: run.summary,
    usage: run.usage,
    turns: run.turns,
    billing: engine.billing(),
    engine: engine.id,
    durationMs: Date.now() - startedAt,
    stopReason: StopReason.Completed,
    ...(model ? { model, requestedModel: model } : {}),
    ...(run.sessionId ? { sessionId: run.sessionId } : {}),
    ...(run.contextTokens ? { contextTokens: run.contextTokens } : {}),
    ...(studioToolCalls.length ? { studioToolCalls } : {}),
  };
}

/** The CLI's state for its account row: working, installed but unusable, or missing. */
function cliState(cli: { ready: boolean; path?: string }): EngineAccount["cli"]["state"] {
  if (cli.ready) return CodingCliState.Ready;
  return cli.path ? CodingCliState.Incompatible : CodingCliState.Missing;
}

/** Where the CLI is, whether it works, and its version. */
async function defaultResolveCli(): Promise<ResolvedCli> {
  const installation = await resolveCodingCli(EngineId.Grok);
  const { state, path: binary, version, detail } = installation.status;
  return {
    ready: state === CodingCliState.Ready && Boolean(binary),
    ...(binary ? { path: binary } : {}),
    ...(version ? { version } : {}),
    detail,
  };
}

/** A linked worktree's Git metadata outside the workspace, which a build must be able to commit to. */
async function gitMetadata(cwd: string): Promise<string[]> {
  const dirs: string[] = [];
  for (const flag of ["--absolute-git-dir", "--git-common-dir"]) {
    const answer = await promisify(execFile)("git", ["-C", cwd, "rev-parse", flag], {
      windowsHide: true,
      timeout: GIT_PROBE_TIMEOUT_MS,
    }).catch(() => null);
    if (!answer) continue;
    const dir = path.resolve(cwd, answer.stdout.trim());
    dirs.push(await realpath(dir).catch(() => dir));
  }
  return [...new Set(dirs)];
}

/** Start `grok` inside the studio's sandbox and yield its events. */
async function* runGrok(invocation: GrokInvocation): AsyncGenerator<Record<string, unknown>> {
  invocation.signal.throwIfAborted();
  const installation = await resolveCodingCli(EngineId.Grok);
  const binary = installation.status.path;
  if (!binary) throw new EngineError(EngineFailureKind.Unavailable, EngineId.Grok, MESSAGE.NotInstalled);
  const sandbox = await ProcessSandbox.create(invocation.sandbox);
  try {
    yield* grokEvents(sandbox, binary, invocation);
  } finally {
    await sandbox.dispose().catch(() => {});
  }
}

/** Start `binary` with the invocation's argv in `sandbox` and yield its events. */
export async function* grokEvents(
  sandbox: Pick<ProcessSandbox, "spawnLongLived">,
  binary: string,
  invocation: Omit<GrokInvocation, "sandbox">,
): AsyncGenerator<Record<string, unknown>> {
  const command = [binary, ...invocation.argv].map(shellQuote).join(" ");
  const { child } = await sandbox.spawnLongLived({
    command,
    cwd: invocation.cwd,
    env: invocation.env,
    label: `grok:${path.basename(invocation.cwd)}`,
    policy: { allowedDomains: invocation.domains },
  });
  yield* childEvents(child, invocation);
}

/**
 * The child's stdout as events, its stderr to the run, stopping it on abort. Grok ends a failed turn
 * with an `error` event; a non-zero exit with nothing said is the CLI failing to start, and stderr
 * explains it.
 */
async function* childEvents(
  child: ChildProcess,
  invocation: Pick<GrokInvocation, "signal" | "onStderr">,
): AsyncGenerator<Record<string, unknown>> {
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-STDERR_TAIL_CHARS);
    invocation.onStderr(chunk);
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
        const event = parseGrokLine(line);
        if (!event) continue;
        said = true;
        yield event;
      }
    }
  } finally {
    invocation.signal.removeEventListener("abort", onAbort);
  }
  const code = await exit;
  if (code !== 0 && !said && !invocation.signal.aborted)
    throw new Error(stripTerminalCodes(stderr).trim() || MESSAGE.Stopped(code));
}
