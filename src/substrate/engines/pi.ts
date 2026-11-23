/**
 * Pi: a delegated harness, driven through `pi --mode json`.
 *
 * Pi runs its own agent loop on whichever providers the person signed it in to (`/login` in its
 * TUI) and keeps those sign-ins in its own store, of which the studio reads only when a
 * subscription sign-in expires: a session gets a copy of the file (`pi-agent-view.ts`), and the
 * person's own Pi renews one that would not outlast it first (`pi-sign-in.ts`). It has no OS
 * sandbox of its own, so every session starts inside ProcessSandbox. The prompt goes in on stdin;
 * each stdout line is one JSON event (`pi-events.ts`); a session is continued by its id, or forked
 * into the turn's folder when it was made in another (`pi-sessions.ts`).
 * Studio tools arrive through the same bridge Codex and OpenCode use.
 */
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CATALOG_DEADLINE_MS, ModelCatalog } from "./model-catalog.ts";
import { resolveCodingCli } from "./external-cli.ts";
import { runCommand } from "./claude-cli.ts";
import { releaseStaleLocks } from "./ownership-locks.ts";
import { StudioBridge, answerBridgeCall, bridgeTools } from "./studio-bridge.ts";
import { writeDelegateStills } from "./codex.ts";
import { JUDGE_RULES, offLimitsNote, planModeNote, readOnlyNote } from "./codex-prompts.ts";
import { gitMetadataDirs } from "./session-commands.ts";
import { builtInPiHosts, parsePiModels, PI_LIST_MODELS_ARGS, readPiProviderHosts } from "./pi-cli.ts";
import { findPiSession, PI_SESSIONS_DIR, piSessionArgs, samePiFolder, type PiSessionFile } from "./pi-sessions.ts";
import { closePiView, openPiView, type PiView } from "./pi-agent-view.ts";
import {
  type PiSignInRenewal,
  piModelProvider,
  piRenewsSignIn,
  piSignInExpiry,
  piSignInRenewals,
  readPiSignIn,
  renewPiSignIn,
} from "./pi-sign-in.ts";
import { RENEWAL_RETRY_MS } from "./sign-in-renewal.ts";
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
import { gameSettingsDenyWrites, ProcessSandbox, type SandboxOptions, shellQuote } from "../spawn.ts";
import { childEnv } from "../child-env.ts";
import { credentialHomes, PI_AGENT_DIR_ENV, piAgentDir, piHomes } from "../credential-homes.ts";
import { stopChild } from "../process-tree.ts";
import type { Usage } from "../types.ts";
import { CodingCliState } from "../../shared/coding-cli.ts";
import { MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";
import { type EngineAccount, EngineKind, EngineStatusCode, LoginSource } from "../../shared/engine-descriptor.ts";
import { EngineFailureKind, StopReason } from "../../shared/engine-requests.ts";
import { ModelCatalogSource } from "../../shared/model-catalog.ts";
import { engineMode, PermissionMode } from "../../shared/permissions.ts";
import { EngineId } from "../../shared/providers.ts";
import { StudioPlatform } from "../../shared/boot.ts";
import { t } from "../../shared/i18n.ts";
import { redactSecrets } from "../../shared/redact.ts";
import type { ChildProcess } from "node:child_process";

const MODELS_TIMEOUT_MS = 30 * SECOND_MS;
const KILL_GRACE_MS = 3 * SECOND_MS;
const STDERR_TAIL_CHARS = 4_000;
/**
 * Pi's credential store refusing to save a renewed sign-in (a file the person keeps read-only, a
 * folder the sandbox could not grant): the errno code and the file it names, never a sentence — a
 * sandboxed session can fail on any other file too.
 */
const CREDENTIAL_STORE_DENIED = /\b(?:EPERM|EACCES|EROFS|EBUSY)\b[^\n]*[/\\]auth\.json/;
/**
 * OAuth's own error code for a refresh token that expired or was revoked (RFC 6749 §5.2): the
 * provider's code, never a sentence, and only as a whole word.
 */
const OAUTH_GRANT_REFUSED = /\binvalid_grant\b/;
/** How a read-only turn's own folder is named under the engine's scratch. */
const RUN_PREFIX = "run-";
/** Plan/read-only: look, and keep `bash` so the studio tools bridge can run. */
const PLAN_TOOLS = "read,grep,find,ls,bash";
/** The provider statuses that refuse the request itself: pick another model. */
const MODEL_REFUSED_STATUSES: ReadonlySet<number> = new Set([400, 404]);

const MESSAGE = {
  NotInstalled: "Pi isn't installed on this computer.",
  NotInstalledStatus: () => t("Pi isn't installed on this computer."),
  InstallRemedy: () => t("Install Pi from Settings › Model Providers."),
  NoModels: () => t("Pi has no model it can run yet."),
  SignInRemedy: () => t("Sign in to a provider with Pi from Settings › Model Providers."),
  SignInAgain: "Sign in to Pi again from Settings › Model Providers.",
  Ready: (version: string | undefined, count: number) =>
    t("Pi {version}, {count, plural, other {# model(s)}}", { version: version ?? "", count }).trim(),
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

/** The Pi on this computer, as the engine asks for it. */
export interface PiCli {
  ready: boolean;
  path?: string;
  version?: string;
  detail: string;
  /** Why a Pi that is there cannot run (a missing runtime, a manual path that names nothing); too old when not given. */
  state?: CodingCliState;
}

export interface PiEngineOptions {
  scratchRoot?: string;
  protectedPaths?: string[];
  toolPath?: () => Promise<string>;
  onModelsChanged?: () => void;
  execFn?: PiExec;
  listModels?: () => Promise<string>;
  resolveCli?: () => Promise<PiCli>;
  lockRecovery?: string;
  /** The person's environment, which may move Pi's folder (`PI_CODING_AGENT_DIR`); the studio's own when not given. */
  env?: Record<string, string | undefined>;
  /** The person's home folder; the real one when not given. */
  home?: string;
  /** The platform the sessions run on; this computer's when not given. */
  platform?: NodeJS.Platform;
  /** The time now, in milliseconds; the computer's clock when not given. */
  clock?: () => number;
  /** Test seam: the person's own Pi at `binary` renewing a sign-in (`renewPiSignIn`). */
  renewSignIn?: (binary: string, renewal: PiSignInRenewal) => Promise<void>;
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

/**
 * What a session writes of Pi's folder `agent`.
 *
 * Pi makes a lock folder beside each file it reads, and of what Pi keeps in its folder a session
 * may write none that Pi loads or runs: not an extension, not `models.json`, and not its sign-in,
 * where a stored key that starts with `!` is a command Pi runs. So on macOS and Linux a session
 * runs on a folder of its own that stands for Pi's (`view`, `pi-agent-view.ts`) and writes that and
 * Pi's transcripts. Windows has no link a session's user can read through, grants whole folders to the
 * sandbox's one user and keeps no deny inside a CLI's own folder (`keepWindowsDenies`), so a
 * session there writes Pi's folder, as OpenCode's, Grok Build's and Cursor's sessions write theirs.
 */
function piWrites(agent: string, platform: NodeJS.Platform, view: string | undefined): string[] {
  if (platform === StudioPlatform.Windows) return [agent];
  const transcripts = path.join(agent, PI_SESSIONS_DIR);
  return view ? [view, transcripts] : [transcripts];
}

/** The sandbox a session runs in: the folder it works in, and of Pi's own folder what Pi's session writes. */
export function piSandbox(input: {
  runDir: string;
  gameDir: string;
  gitDirs: string[];
  scratchDir: string;
  secretPaths: string[];
  toolPath?: () => Promise<string>;
  env?: Record<string, string | undefined>;
  home?: string;
  platform?: NodeJS.Platform;
  /** Pi's folder by its real path, where the session's folder is; as `env` names it when not given. */
  agentDir?: string;
  /** macOS and Linux: the folder that stands for Pi's in this session (`openPiView`). */
  agentView?: string;
  /** Whether a path is there now; the disk's answer when not given. */
  exists?: (file: string) => boolean;
}): SandboxOptions {
  const env = input.env ?? process.env;
  const home = input.home ?? os.homedir();
  const platform = input.platform ?? process.platform;
  const agent = input.agentDir ?? piAgentDir(env, home);
  return {
    writableRoots: [input.runDir, ...input.gitDirs, ...piWrites(agent, platform, input.agentView)],
    scratchDir: input.scratchDir,
    secretPaths: input.secretPaths,
    readableHome: piHomes(env, home),
    // The game's own Pi folder is never a session's to plant.
    denyWrite: gameSettingsDenyWrites([path.join(input.gameDir, ".pi")], platform, input.exists),
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
  readonly #resolveCli: () => Promise<PiCli>;
  readonly #lockRecovery: string | undefined;
  readonly #env: Record<string, string | undefined>;
  readonly #home: string;
  readonly #platform: NodeJS.Platform;
  readonly #clock: () => number;
  readonly #renewSignIn: ((binary: string, renewal: PiSignInRenewal) => Promise<void>) | undefined;
  /** The renewals of the person's sign-ins under way, by provider: every session starting meanwhile waits on its own. */
  readonly #renewals = new Map<string, Promise<void>>();
  /** A provider's sign-in a renewal left as it was, and when: not tried again until it changes or a while passed. */
  readonly #unrenewed = new Map<string, { expires: number; at: number }>();
  /** How long a provider's new token lasts, as its last renewal showed. */
  readonly #tokenLives = new Map<string, number>();
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
    this.#env = options.env ?? process.env;
    this.#home = options.home ?? os.homedir();
    this.#platform = options.platform ?? process.platform;
    this.#clock = options.clock ?? Date.now;
    this.#renewSignIn = options.renewSignIn;
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
    const count = this.#catalog.models().length;
    if (!count)
      return { code: EngineStatusCode.NeedsLogin, detail: MESSAGE.NoModels(), remedy: MESSAGE.SignInRemedy() };
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
    const readOnly = isReadOnly(request);
    const kept = request.resume ? await findPiSession(this.#sessionsRoot(), request.resume) : null;
    const scratch = readOnly ? await this.#runScratch(kept) : null;
    const runDir = scratch ?? cwd;
    const bridge = await this.#openBridge(request, runDir).catch(async (err) => {
      await this.#cleanUp(scratch, null);
      throw err;
    });
    const stills = await writeDelegateStills(request.images ?? [], this.#stillsRoot()).catch(async (err) => {
      await this.#cleanUp(scratch, bridge);
      throw err;
    });
    const deadline = request.timeoutMs
      ? setTimeout(() => {
          run.deadlineHit = true;
          controller.abort();
        }, request.timeoutMs)
      : null;
    const partial = (): PartialDelegateState => partialState(run, startedAt, request.model, bridge, request);
    let view: PiView | null = null;
    try {
      view = await this.#openView(request.model);
      const invocation = await this.#invocation(request, {
        cwd,
        runDir,
        view,
        session: piSessionArgs(sessionId, kept, runDir),
        readOnly,
        prompt: this.#brief(request, { cwd, scratch, bridge }),
        files: stills.paths,
        signal: controller.signal,
      });
      await this.#readEvents(request, run, invocation);
    } catch (err) {
      return this.#endingAfterThrow(err, run, request, partial);
    } finally {
      if (deadline) clearTimeout(deadline);
      if (stills.dir) await rm(stills.dir, { recursive: true, force: true }).catch(() => {});
      await this.#closeView(view);
      await this.#cleanUp(scratch, bridge);
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
    const images = request.messages.flatMap((message) => message.images ?? []);
    const stills = await writeDelegateStills(
      images.map((image) => ({ ...image, label: image.label ?? "" })),
      this.#stillsRoot(),
    );
    const run = newRun(this.id, undefined);
    let scratch: string | null = null;
    let view: PiView | null = null;
    try {
      scratch = await this.#scratch("answer-");
      view = await this.#openView(request.model);
      const invocation = await this.#invocation(
        { model: request.model, effort: request.effort, denyReads: [] },
        {
          cwd: scratch,
          runDir: scratch,
          view,
          session: [],
          readOnly: true,
          oneshot: true,
          prompt: answerPrompt(request),
          files: stills.paths,
          signal,
        },
      );
      await this.#readEvents({}, run, invocation);
      return run;
    } finally {
      if (stills.dir) await rm(stills.dir, { recursive: true, force: true }).catch(() => {});
      await this.#closeView(view);
      if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => {});
    }
  }

  async #readModels(
    binary: string | undefined,
  ): Promise<{ models: EngineModel[]; source: typeof ModelCatalogSource.Provider }> {
    const stdout = this.#listModels ? await this.#listModels() : await listPiModels(binary, this.#env);
    const extra = await readPiProviderHosts(piAgentDir(this.#env, this.#home)).catch(() => ({}));
    const listed = parsePiModels(stdout, extra);
    this.#hosts = new Map(listed.map((model) => [model.row.id, model.hosts]));
    this.#signedIn = listed.length > 0;
    return { models: listed.map((model) => model.row), source: ModelCatalogSource.Provider };
  }

  /** Where a turn's pictures are written: the sandbox's own scratch, which every session reads. */
  #stillsRoot(): string {
    return path.join(this.#scratchRoot, "tmp");
  }

  /** Where Pi files its sessions, one folder for each folder a session was started in. */
  #sessionsRoot(): string {
    return path.join(piAgentDir(this.#env, this.#home), PI_SESSIONS_DIR);
  }

  /**
   * A read-only turn's folder. The one its session was made in, when that is a run folder of this
   * engine's own: Pi then continues the session where it is, with no fork. Otherwise a new one.
   */
  async #runScratch(kept: PiSessionFile | null): Promise<string> {
    await mkdir(this.#scratchRoot, { recursive: true });
    const root = await realpath(this.#scratchRoot);
    const ownRun =
      kept !== null && samePiFolder(path.dirname(kept.cwd), root) && path.basename(kept.cwd).startsWith(RUN_PREFIX);
    if (!ownRun) return mkdtemp(path.join(this.#scratchRoot, RUN_PREFIX));
    // A turn removes its folder when it ends, so one that is there is another turn's: leave it alone.
    const free = await mkdir(kept.cwd).then(
      () => true,
      () => false,
    );
    return free ? kept.cwd : mkdtemp(path.join(this.#scratchRoot, RUN_PREFIX));
  }

  /**
   * The folder this session's Pi runs on in place of Pi's own (`pi-agent-view.ts`), with a copy of
   * a sign-in that outlasts the session where the person's own Pi could renew it; none on Windows,
   * where a session runs on Pi's folder itself.
   */
  async #openView(model: string | undefined): Promise<PiView | null> {
    if (this.#platform === StudioPlatform.Windows) return null;
    const agent = piAgentDir(this.#env, this.#home);
    await this.#renewDue(agent, model).catch(() => {});
    return openPiView(agent);
  }

  /**
   * Has the person's own Pi renew the sign-in `model` runs on when it would not outlast a session
   * (`piSignInRenewals`): what a session renews stays in its copy. With no model named Pi picks
   * one, so every sign-in that is due is renewed. A sign-in a renewal left as it was waits
   * `RENEWAL_RETRY_MS` before another try, and holds up no other.
   */
  async #renewDue(agent: string, model: string | undefined): Promise<void> {
    const now = this.#clock();
    const due = piSignInRenewals((await readPiSignIn(agent)) ?? "", {
      now,
      provider: piModelProvider(model),
      life: (provider) => this.#tokenLives.get(provider),
    });
    const tried = due.filter((renewal) => !this.#waitsToRetry(renewal, now));
    await Promise.all(tried.map((renewal) => this.#renewed(agent, renewal, now)));
  }

  /**
   * One provider's renewal, which every session starting meanwhile waits on. What it left is
   * kept: a sign-in it did not change, or how long the new token lasts.
   */
  #renewed(agent: string, renewal: PiSignInRenewal, now: number): Promise<void> {
    const { provider, expires } = renewal;
    const under = this.#renewals.get(provider);
    if (under) return under;
    const renewed = this.#renew(renewal)
      .catch(() => {})
      .then(async () => {
        const after = piSignInExpiry(await readPiSignIn(agent), provider);
        this.#renewals.delete(provider);
        if (after === null || after <= expires) {
          this.#unrenewed.set(provider, { expires, at: now });
          return;
        }
        this.#unrenewed.delete(provider);
        this.#tokenLives.set(provider, after - this.#clock());
      });
    this.#renewals.set(provider, renewed);
    return renewed;
  }

  /** Is this the sign-in a renewal left as it was, too lately to try again? */
  #waitsToRetry(renewal: PiSignInRenewal, now: number): boolean {
    const last = this.#unrenewed.get(renewal.provider);
    return last !== undefined && last.expires === renewal.expires && now - last.at < RENEWAL_RETRY_MS;
  }

  /** The person's own Pi, on the host with the model listing's environment, renewing a sign-in. */
  async #renew(renewal: PiSignInRenewal): Promise<void> {
    const cli = await this.#resolveCli();
    if (!cli.path || !piRenewsSignIn(cli.version)) return;
    if (this.#renewSignIn) return this.#renewSignIn(cli.path, renewal);
    await mkdir(this.#scratchRoot, { recursive: true });
    const env = childEnv(this.#env, { base: "contractor", vendor: "pi" });
    await renewPiSignIn(cli.path, { env, cwd: this.#scratchRoot, renewal });
  }

  /** The session has ended: its folder goes, with what the session left in it. */
  async #closeView(view: PiView | null): Promise<void> {
    if (view) await closePiView(view.dir).catch(() => {});
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

  async #cleanUp(scratch: string | null, bridge: StudioBridge | null): Promise<void> {
    await bridge?.close().catch(() => {});
    if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }

  #brief(request: DelegateRequest, ctx: { cwd: string; scratch: string | null; bridge: StudioBridge | null }): string {
    const plan = chatMode(request) === PermissionMode.Plan && ctx.scratch;
    return [
      request.prompt,
      ctx.bridge?.instructions() ?? "",
      plan
        ? planModeNote(ctx.cwd, ctx.scratch ?? "")
        : readOnlyNote(
            // A reviewer's cwd is its own empty home: the build it tests is the folder it reads.
            request.reviewer?.reads ?? ctx.cwd,
            ctx.scratch,
          ),
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
      /** The folder that stands for Pi's in this session; null on Windows. */
      view: PiView | null;
      /** The options that start or continue the session (`piSessionArgs`); none for a one-shot answer. */
      session: string[];
      readOnly: boolean;
      oneshot?: boolean;
      prompt: string;
      /** Pictures of this turn: Pi takes a file only as an `@file` argument, never from the prompt's text. */
      files: string[];
      signal: AbortSignal;
    },
  ): Promise<PiInvocation> {
    const model = request.model;
    const argv = [
      "--mode",
      "json",
      "--no-extensions",
      // A game folder's own Pi files (`.pi/settings.json`, `.agents/skills`) are never trusted: Pi
      // then neither loads them nor asks to trust the folder, an answer it would keep in `trust.json`.
      "--no-approve",
      ...(ctx.oneshot ? ["--no-tools", "--no-session"] : ctx.session),
      ...(model ? ["--model", model] : []),
      ...(request.effort ? ["--thinking", request.effort] : []),
      ...(!ctx.oneshot && ctx.readOnly ? ["--tools", PLAN_TOOLS] : []),
      ...ctx.files.map((file) => `@${file}`),
    ];
    const { view } = ctx;
    return {
      argv,
      cwd: ctx.runDir,
      prompt: ctx.prompt,
      // Pi's folder, named outright: Windows runs a session as the sandbox's own user, whose home
      // holds no Pi sign-in, and the others run it on the folder that stands for Pi's.
      env: { [PI_AGENT_DIR_ENV]: view?.dir ?? piAgentDir(this.#env, this.#home) },
      signal: ctx.signal,
      sandbox: piSandbox({
        runDir: ctx.runDir,
        gameDir: ctx.cwd,
        // A building session commits: a Loop worker's folder is a linked worktree whose Git
        // metadata lives outside it.
        gitDirs: ctx.readOnly ? [] : await gitMetadataDirs(ctx.cwd),
        scratchDir: path.join(this.#scratchRoot, "tmp"),
        secretPaths: [...this.#protectedPaths, ...(request.denyReads ?? [])],
        ...(this.#toolPath ? { toolPath: this.#toolPath } : {}),
        env: this.#env,
        home: this.#home,
        platform: this.#platform,
        // The session's folder is made in Pi's folder by its real path: the transcripts beside it.
        ...(view ? { agentView: view.dir, agentDir: view.agent } : {}),
      }),
      domains: this.#domains(model),
    };
  }

  #domains(model: string | undefined): string[] {
    const hosts = model ? (this.#hosts.get(model) ?? builtInPiHosts(model)) : [...this.#hosts.values()].flat();
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
  const readOnly = Boolean(request.readOnly);
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
function answerPrompt(request: CompleteRequest): string {
  const conversation = request.messages.map((message) => `${message.role.toUpperCase()}:\n${message.content}`);
  return [request.systemPrompt ?? "", ...conversation, ...JUDGE_RULES].filter((part) => part.trim()).join("\n\n");
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
  return CREDENTIAL_STORE_DENIED.test(failure.message) || OAUTH_GRANT_REFUSED.test(failure.message);
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

/**
 * Where Pi stands for its row: only a Pi that started and lacks what a session needs is too old
 * (`Incompatible`, the row's "Update needed"); one that could not start keeps its own reason.
 */
function cliState(cli: PiCli): EngineAccount["cli"]["state"] {
  if (cli.ready) return CodingCliState.Ready;
  if (!cli.path) return CodingCliState.Missing;
  return cli.state && cli.state !== CodingCliState.Ready ? cli.state : CodingCliState.Incompatible;
}

async function defaultResolveCli(): Promise<PiCli> {
  const installation = await resolveCodingCli(EngineId.Pi);
  const { state, path: binary, version, detail } = installation.status;
  return {
    ready: state === CodingCliState.Ready && Boolean(binary),
    ...(binary ? { path: binary } : {}),
    ...(version ? { version } : {}),
    detail,
    state,
  };
}

async function listPiModels(binary: string | undefined, person: Record<string, string | undefined>): Promise<string> {
  if (!binary) return "";
  const env = childEnv(person, { base: "contractor", vendor: "pi" });
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
    yield* piEvents(sandbox, binary, invocation);
  } finally {
    await sandbox.dispose().catch(() => {});
  }
}

/**
 * One `pi --mode json` in `sandbox`, as its events. The brief is the process's stdin, handed to
 * the sandbox to deliver: on Windows srt-win passes no pipe on, so a brief written down the
 * child's own stdin never reached Pi.
 */
export async function* piEvents(
  sandbox: Pick<ProcessSandbox, "spawnLongLived">,
  binary: string,
  invocation: Omit<PiInvocation, "sandbox">,
): AsyncGenerator<Record<string, unknown>> {
  const command = [binary, ...invocation.argv].map(shellQuote).join(" ");
  const { child } = await sandbox.spawnLongLived({
    command,
    cwd: invocation.cwd,
    env: invocation.env,
    label: `pi:${path.basename(invocation.cwd)}`,
    policy: { allowedDomains: invocation.domains },
    stdin: invocation.prompt,
  });
  yield* childEvents(child, invocation);
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

async function* childEvents(
  child: ChildProcess,
  invocation: Pick<PiInvocation, "signal">,
): AsyncGenerator<Record<string, unknown>> {
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
  if (code !== 0 && !invocation.signal.aborted) throw stderrFailure(stderr, code);
}

/** A failed Pi process as the chat's error: its stderr, redacted, or the exit status alone. */
export function stderrFailure(stderr: string, code: number | null): Error {
  return new Error(redactSecrets(stderr.trim()) || MESSAGE.Stopped(code));
}
