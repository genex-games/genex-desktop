/**
 * Pi: a delegated harness, driven through `pi --mode json`.
 *
 * Pi runs its own agent loop on whichever providers the person signed it in to (`/login` in its
 * TUI) and keeps those sign-ins in its own store, which the studio never reads. It has no OS
 * sandbox of its own, so every session starts inside ProcessSandbox. The prompt goes in on stdin;
 * each stdout line is one JSON event (`pi-events.ts`); a session is resumed by `--session-id`.
 * Studio tools arrive through the same bridge Codex and OpenCode use.
 */
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CATALOG_DEADLINE_MS, ModelCatalog } from "./model-catalog.ts";
import { resolveCodingCli } from "./external-cli.ts";
import { runCommand } from "./claude-cli.ts";
import { lockUnowned, ownershipBriefing, releaseLocks, releaseStaleLocks, type LockRecord } from "./ownership-locks.ts";
import { StudioBridge, answerBridgeCall, bridgeTools } from "./studio-bridge.ts";
import { writeDelegateStills } from "./codex.ts";
import { JUDGE_RULES, offLimitsNote, planModeNote, readOnlyNote } from "./codex-prompts.ts";
import { parsePiModels, PI_LIST_MODELS_ARGS, readPiProviderHosts } from "./pi-cli.ts";
import { parsePiLine, translatePiEvent, type Translated } from "./pi-events.ts";
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
import {
  abortControllerFor,
  COMPLETE_TIMEOUT_MS,
  CompletionStop,
  interruption,
  partialDelegateResult,
  STOPPED_BY_USER,
} from "./common.ts";
import type { PartialDelegateState } from "./common.ts";
import { ProcessSandbox, type SandboxOptions, shellQuote } from "../spawn.ts";
import { childEnv } from "../child-env.ts";
import { credentialHomes } from "../credential-homes.ts";
import { stopChild } from "../process-tree.ts";
import type { Usage } from "../types.ts";
import { CodingCliState } from "../../shared/coding-cli.ts";
import { MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";
import { type EngineAccount, EngineKind, EngineStatusCode, LoginSource } from "../../shared/engine-descriptor.ts";
import { EngineFailureKind, StopReason } from "../../shared/engine-requests.ts";
import { ModelCatalogSource } from "../../shared/model-catalog.ts";
import { engineMode, PermissionMode } from "../../shared/permissions.ts";
import { EngineId } from "../../shared/providers.ts";
import type { ChildProcess } from "node:child_process";

const MODELS_TIMEOUT_MS = 30 * SECOND_MS;
const KILL_GRACE_MS = 3 * SECOND_MS;
const STDERR_TAIL_CHARS = 4_000;
/** Plan/read-only: look, and keep `bash` so the studio tools bridge can run. */
const PLAN_TOOLS = "read,grep,find,ls,bash";
/** The provider statuses that refuse the request itself: pick another model. */
const MODEL_REFUSED_STATUSES: ReadonlySet<number> = new Set([400, 404]);

const MESSAGE = {
  NotInstalled: "Pi isn't installed on this Mac.",
  InstallRemedy: "Install Pi from Settings › Model Providers.",
  NoModels: "Pi has no model it can run yet.",
  SignInRemedy: "Sign in to a provider with Pi from Settings › Model Providers.",
  SignInAgain: "Sign in to Pi again from Settings › Model Providers.",
  Ready: (version: string | undefined, count: number) => `Pi ${version ?? ""}, ${count} model(s)`.trim(),
  NoCompact: "Pi compacts its own sessions",
  NoTools: "Pi's one-shot answers take no studio tools",
  Stopped: (code: number | null) => `Pi exited with ${code}`,
  NoAnswer: "Pi gave no answer",
  JudgeTimedOut: (minutes: number) => `the judge did not answer within ${minutes} min`,
  ModelRefused: (model: string, words: string) =>
    `The provider refused ${model} (${words}). Pick another model, then send again.`,
} as const;

/** One `pi --mode json`, as the engine starts it; injectable in tests. */
export interface PiInvocation {
  argv: string[];
  cwd: string;
  prompt: string;
  env: Record<string, string>;
  signal: AbortSignal;
  sandbox: SandboxOptions;
  domains: string[];
}
export type PiExec = (invocation: PiInvocation) => AsyncIterable<Record<string, unknown>>;

export interface PiEngineOptions {
  scratchRoot?: string;
  protectedPaths?: string[];
  toolPath?: () => Promise<string>;
  onModelsChanged?: () => void;
  execFn?: PiExec;
  listModels?: () => Promise<string>;
  resolveCli?: () => Promise<{ ready: boolean; path?: string; version?: string; detail: string }>;
  lockRecovery?: string;
}

interface PiRun {
  usage: Usage;
  turns: number;
  summary: string;
  sessionId: string | undefined;
  failure: { message: string; status: number | null } | null;
  deadlineHit: boolean;
  pendingUsage: Partial<Usage> | undefined;
  pendingFailure: { message: string; status: number | null } | undefined;
}

/** The sandbox a session runs in: the folder it works in, Pi's own home, and nothing it must not read. */
export function piSandbox(input: {
  runDir: string;
  gameDir: string;
  gitDirs: string[];
  scratchDir: string;
  secretPaths: string[];
  toolPath?: () => Promise<string>;
  home?: string;
}): SandboxOptions {
  const home = input.home ?? os.homedir();
  const piHome = path.join(home, ".pi");
  const agent = path.join(piHome, "agent");
  return {
    writableRoots: [input.runDir, ...input.gitDirs, path.join(agent, "sessions"), path.join(agent, "auth.json.lock")],
    scratchDir: input.scratchDir,
    secretPaths: input.secretPaths,
    ownHome: [piHome],
    // The CLI must read its sign-ins; everything else under ~/.pi stays read-only so a session
    // cannot plant settings, packages or !command keys that later run unsandboxed.
    denyWrite: [
      path.join(agent, "auth.json"),
      path.join(agent, "settings.json"),
      path.join(agent, "models.json"),
      path.join(agent, "models-store.json"),
      path.join(agent, "mcp.json"),
      path.join(agent, "extensions"),
      path.join(agent, "skills"),
      path.join(agent, "npm"),
      path.join(agent, "agents"),
      path.join(piHome, "context-mode"),
      path.join(input.gameDir, ".pi"),
    ],
    ...(input.toolPath ? { toolPath: input.toolPath } : {}),
  };
}

export class PiEngine implements Engine {
  readonly id = EngineId.Pi;
  readonly label = "Pi";
  readonly kind = EngineKind.Delegated;
  readonly supportsSessions = true;
  readonly #scratchRoot: string;
  readonly #protectedPaths: string[];
  readonly #toolPath: (() => Promise<string>) | undefined;
  readonly #catalog: ModelCatalog;
  readonly #execFn: PiExec | undefined;
  readonly #listModels: (() => Promise<string>) | undefined;
  readonly #resolveCli: () => Promise<{ ready: boolean; path?: string; version?: string; detail: string }>;
  readonly #lockRecovery: string | undefined;
  #hosts = new Map<string, string[]>();
  #signedIn = false;

  constructor(options: PiEngineOptions) {
    this.#scratchRoot = options.scratchRoot ?? path.join(os.tmpdir(), `studio-${EngineId.Pi}`);
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

  async refreshModels(force = false): Promise<void> {
    const cli = await this.#resolveCli();
    if (!cli.ready) return;
    await this.#catalog.refresh(`${cli.path ?? ""}\0${cli.version ?? ""}`, () => this.#readModels(cli.path), force);
  }

  async defaultModel(): Promise<string | null> {
    return null;
  }

  async delegate(request: DelegateRequest): Promise<DelegateResult> {
    if (request.compact) throw new EngineError(EngineFailureKind.Unavailable, this.id, MESSAGE.NoCompact);
    const startedAt = Date.now();
    const cwd = await realpath(path.resolve(request.cwd));
    const sessionId = request.resume || randomUUID();
    const run = newRun(this.id, sessionId);
    const controller = abortControllerFor(request.signal);
    if (request.signal?.aborted)
      return metered(partialDelegateResult(this.id, interruption(true), partialState(run, startedAt, request.model)));
    await releaseStaleLocks(cwd, this.#lockRecovery).catch(() => {});
    const locks = request.ownership
      ? await lockUnowned(cwd, request.ownership, this.#lockRecovery).catch(() => null)
      : null;
    const readOnly = isReadOnly(request);
    const scratch = readOnly ? await this.#scratch("run-") : null;
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
        cwd,
        runDir,
        sessionId,
        readOnly,
        prompt: this.#brief(request, { cwd, scratch, locks, bridge }),
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
    const stopped = (): EngineError | null => {
      if (timedOut)
        return new EngineError(
          EngineFailureKind.Timeout,
          this.id,
          MESSAGE.JudgeTimedOut(Math.round(ceiling / MINUTE_MS)),
        );
      return request.signal?.aborted ? new EngineError(EngineFailureKind.Aborted, this.id, STOPPED_BY_USER) : null;
    };
    let run: PiRun;
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

  /** One answer session in a scratch folder; removed after. */
  async #answer(request: CompleteRequest, signal: AbortSignal): Promise<PiRun> {
    const scratch = await this.#scratch("answer-");
    const images = request.messages.flatMap((message) => message.images ?? []);
    const stills = await writeDelegateStills(images.map((image) => ({ ...image, label: image.label ?? "" })));
    const run = newRun(this.id, undefined);
    try {
      const invocation = await this.#invocation(
        { model: request.model, effort: request.effort, denyReads: [] },
        {
          cwd: scratch,
          runDir: scratch,
          sessionId: undefined,
          readOnly: true,
          oneshot: true,
          prompt: answerPrompt(request, stills.paths),
          signal,
        },
      );
      await this.#readEvents({}, run, invocation);
      return run;
    } finally {
      if (stills.dir) await rm(stills.dir, { recursive: true, force: true }).catch(() => {});
      await rm(scratch, { recursive: true, force: true }).catch(() => {});
    }
  }

  async #readModels(
    binary: string | undefined,
  ): Promise<{ models: EngineModel[]; source: typeof ModelCatalogSource.Provider }> {
    const stdout = this.#listModels ? await this.#listModels() : await listPiModels(binary);
    const extra = await readPiProviderHosts(os.homedir()).catch(() => ({}));
    const listed = parsePiModels(stdout, extra);
    this.#hosts = new Map(listed.map((model) => [model.row.id, model.hosts]));
    this.#signedIn = listed.length > 0;
    return { models: listed.map((model) => model.row), source: ModelCatalogSource.Provider };
  }

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

  #brief(
    request: DelegateRequest,
    ctx: { cwd: string; scratch: string | null; locks: LockRecord | null; bridge: StudioBridge | null },
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

  async #invocation(
    request: Pick<DelegateRequest, "model" | "effort" | "denyReads">,
    ctx: {
      cwd: string;
      runDir: string;
      sessionId: string | undefined;
      readOnly: boolean;
      oneshot?: boolean;
      prompt: string;
      signal: AbortSignal;
    },
  ): Promise<PiInvocation> {
    const model = request.model;
    const argv = [
      "--mode",
      "json",
      "--no-extensions",
      ...(ctx.oneshot ? ["--no-tools", "--no-session"] : ["--session-id", ctx.sessionId ?? ""]),
      ...(model ? ["--model", model] : []),
      ...(request.effort ? ["--thinking", request.effort] : []),
      ...(!ctx.oneshot && ctx.readOnly ? ["--tools", PLAN_TOOLS] : []),
    ];
    return {
      argv,
      cwd: ctx.runDir,
      prompt: ctx.prompt,
      env: {},
      signal: ctx.signal,
      sandbox: piSandbox({
        runDir: ctx.runDir,
        gameDir: ctx.cwd,
        gitDirs: [],
        scratchDir: path.join(this.#scratchRoot, "tmp"),
        secretPaths: [...this.#protectedPaths, ...(request.denyReads ?? [])],
        ...(this.#toolPath ? { toolPath: this.#toolPath } : {}),
      }),
      domains: this.#domains(model),
    };
  }

  #domains(model: string | undefined): string[] {
    const hosts = model ? (this.#hosts.get(model) ?? []) : [...this.#hosts.values()].flat();
    return [...new Set(hosts)];
  }

  async #readEvents(request: Pick<DelegateRequest, "onEvent">, run: PiRun, invocation: PiInvocation): Promise<void> {
    const events = (this.#execFn ?? runPi)(invocation);
    for await (const event of events) applyTranslated(request, run, translatePiEvent(event));
  }

  #endingAfterThrow(
    err: unknown,
    run: PiRun,
    request: DelegateRequest,
    partial: () => PartialDelegateState,
  ): DelegateResult {
    if (request.signal?.aborted || run.deadlineHit)
      return metered(partialDelegateResult(this.id, interruption(request.signal?.aborted), partial()));
    if (err instanceof EngineError && err.kind !== EngineFailureKind.Other) throw err;
    const message = err instanceof Error ? err.message : String(err);
    const mapped = failureError(this.id, { message, status: null });
    if (mapped.kind !== EngineFailureKind.Other) throw mapped;
    return metered(partialDelegateResult(this.id, { stopReason: StopReason.Error, errorText: message }, partial()));
  }

  /** A failure Pi reported: one with a status the run policy knows is thrown, the rest is an outcome. */
  #failedEnding(
    failure: { message: string; status: number | null },
    partial: () => PartialDelegateState,
    model: string | undefined,
  ): DelegateResult {
    const error = failureError(this.id, failure);
    if (error.kind !== EngineFailureKind.Other) throw error;
    const errorText = refusedModelText(failure, model) ?? failure.message;
    return metered(partialDelegateResult(this.id, { stopReason: StopReason.Error, errorText }, partial()));
  }
}

function isReadOnly(request: DelegateRequest): boolean {
  const readOnly = Boolean(request.readOnly) && !request.coordinator;
  return readOnly || chatMode(request) === PermissionMode.Plan;
}

function chatMode(request: DelegateRequest): PermissionMode | null {
  return request.permissions ? engineMode(EngineId.Pi, request.permissions.mode) : null;
}

function newRun(engine: string, sessionId: string | undefined): PiRun {
  return {
    usage: { engine },
    turns: 0,
    summary: "",
    sessionId,
    failure: null,
    deadlineHit: false,
    pendingUsage: undefined,
    pendingFailure: undefined,
  };
}

/** A judge's question as one prompt: the system words, the conversation, and the critic's two rules. */
function answerPrompt(request: CompleteRequest, files: string[]): string {
  const conversation = request.messages.map((message) => `${message.role.toUpperCase()}:\n${message.content}`);
  const attached = files.map((file) => `@${file}`).join("\n");
  return [request.systemPrompt ?? "", ...conversation, attached, ...JUDGE_RULES]
    .filter((part) => part.trim())
    .join("\n\n");
}

function refusedModelText(
  failure: { message: string; status: number | null },
  model: string | undefined,
): string | null {
  if (!model || failure.status === null || !MODEL_REFUSED_STATUSES.has(failure.status)) return null;
  return MESSAGE.ModelRefused(model, failure.message);
}

function needsPiSignIn(failure: { message: string; status: number | null }): boolean {
  if (failure.status === 401) return true;
  return /token expired|unauthori[sz]ed|not signed in|credential store modify|EPERM:.*auth\.json/i.test(
    failure.message,
  );
}

function failureError(engine: string, failure: { message: string; status: number | null }): EngineError {
  if (needsPiSignIn(failure)) return new EngineError(EngineFailureKind.Auth, engine, MESSAGE.SignInAgain);
  if (failure.status !== null) return classifyHttpFailure(engine, failure.status, failure.message);
  return new EngineError(EngineFailureKind.Other, engine, failure.message);
}

const SUMMED_USAGE = [
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "reasoning_tokens",
  "cost_usd",
] as const;

function keepFailure(
  current: { message: string; status: number | null } | null | undefined,
  next: { message: string; status: number | null },
): { message: string; status: number | null } {
  return current && next.message === "Pi stopped" ? current : next;
}

function applyFailure(run: PiRun, translated: Translated): void {
  if (translated.clearFailure) {
    run.pendingFailure = undefined;
    run.failure = null;
  }
  if (translated.pendingFailure) run.pendingFailure = keepFailure(run.pendingFailure, translated.pendingFailure);
  if (translated.confirmPending && run.pendingFailure && !run.failure) run.failure = run.pendingFailure;
  if (translated.failure) run.failure = keepFailure(run.failure, translated.failure);
}

function applyUsage(run: PiRun, translated: Translated): void {
  if (translated.latestUsage) run.pendingUsage = translated.latestUsage;
  const closing = Boolean(translated.usage) || Boolean(translated.turns) || Boolean(translated.failure);
  if (!closing) return;
  const usage = translated.usage ?? run.pendingUsage;
  run.pendingUsage = undefined;
  for (const key of SUMMED_USAGE) {
    const value = usage?.[key];
    if (typeof value === "number") run.usage[key] = (run.usage[key] ?? 0) + value;
  }
}

function applyTranslated(request: Pick<DelegateRequest, "onEvent">, run: PiRun, translated: Translated): void {
  if (translated.sessionId) run.sessionId = translated.sessionId;
  for (const event of translated.events)
    request.onEvent?.(event as Parameters<NonNullable<DelegateRequest["onEvent"]>>[0]);
  if (translated.text) run.summary = translated.text;
  if (translated.turns) run.turns += translated.turns;
  applyFailure(run, translated);
  applyUsage(run, translated);
}

function partialState(
  run: PiRun,
  startedAt: number,
  model: string | undefined,
  bridge?: StudioBridge | null,
  request?: DelegateRequest,
): PartialDelegateState {
  return {
    summary: run.summary,
    usage: run.usage,
    turns: run.turns,
    startedAt,
    sessionId: run.sessionId,
    model,
    requestedModel: model,
    studioToolCalls: request ? recordedCalls(bridge ?? null, request) : [],
  };
}

function recordedCalls(
  bridge: StudioBridge | null,
  request: DelegateRequest,
): NonNullable<DelegateResult["studioToolCalls"]> {
  const interview = new Set((request.interviewTools ?? []).map((tool) => tool.name));
  return (bridge?.calls ?? []).filter((call) => interview.has(call.name));
}

function completed(
  engine: string,
  run: PiRun,
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

function metered(result: DelegateResult): DelegateResult {
  return { ...result, billing: "api" };
}

function cliState(cli: { ready: boolean; path?: string }): EngineAccount["cli"]["state"] {
  if (cli.ready) return CodingCliState.Ready;
  return cli.path ? CodingCliState.Incompatible : CodingCliState.Missing;
}

async function defaultResolveCli(): Promise<{ ready: boolean; path?: string; version?: string; detail: string }> {
  const installation = await resolveCodingCli(EngineId.Pi);
  const { state, path: binary, version, detail } = installation.status;
  return {
    ready: state === CodingCliState.Ready && Boolean(binary),
    ...(binary ? { path: binary } : {}),
    ...(version ? { version } : {}),
    detail,
  };
}

async function listPiModels(binary: string | undefined): Promise<string> {
  if (!binary) return "";
  const env = childEnv(process.env, { base: "contractor", vendor: "pi" });
  const result = await runCommand(binary, [...PI_LIST_MODELS_ARGS], {
    env,
    timeoutMs: Math.max(MODELS_TIMEOUT_MS, CATALOG_DEADLINE_MS),
  });
  if (result.code !== 0) throw new Error(result.stderr.trim() || MESSAGE.Stopped(result.code));
  return result.stdout;
}

async function* runPi(invocation: PiInvocation): AsyncGenerator<Record<string, unknown>> {
  invocation.signal.throwIfAborted();
  const installation = await resolveCodingCli(EngineId.Pi);
  const binary = installation.status.path;
  if (!binary) throw new EngineError(EngineFailureKind.Unavailable, EngineId.Pi, MESSAGE.NotInstalled);
  const sandbox = await ProcessSandbox.create(invocation.sandbox);
  try {
    const command = [binary, ...invocation.argv].map(shellQuote).join(" ");
    const { child } = await sandbox.spawnLongLived({
      command,
      cwd: invocation.cwd,
      env: invocation.env,
      label: `pi:${path.basename(invocation.cwd)}`,
      policy: { allowedDomains: invocation.domains },
    });
    yield* childEvents(child, invocation);
  } finally {
    await sandbox.dispose().catch(() => {});
  }
}

/** Split stdout on LF only — Unicode separators are valid inside Pi JSON strings. */
async function* lfLines(stream: NodeJS.ReadableStream): AsyncGenerator<string> {
  let leftover = "";
  for await (const chunk of stream) {
    leftover += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    const parts = leftover.split("\n");
    leftover = parts.pop() ?? "";
    for (const part of parts) yield part.replace(/\r$/, "");
  }
  if (leftover) yield leftover.replace(/\r$/, "");
}

async function* childEvents(child: ChildProcess, invocation: PiInvocation): AsyncGenerator<Record<string, unknown>> {
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
  try {
    if (child.stdout) {
      for await (const line of lfLines(child.stdout)) {
        const event = parsePiLine(line);
        if (!event) continue;
        yield event;
      }
    }
  } finally {
    invocation.signal.removeEventListener("abort", onAbort);
  }
  const code = await exit;
  if (code !== 0 && !invocation.signal.aborted) throw new Error(stderr.trim() || MESSAGE.Stopped(code));
}
