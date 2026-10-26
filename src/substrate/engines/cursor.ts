/**
 * Cursor: a delegated harness driven through Cursor's agent CLI, `cursor-agent --print`.
 *
 * Cursor runs its own agent loop on the models the person's Cursor account can run, and keeps the
 * sign-in itself, which the studio never reads. Its own sandbox cannot start inside the studio's
 * (macOS allows one Seatbelt profile per process), so every session runs in the studio's
 * `ProcessSandbox` with Cursor's sandbox off: the workspace (or, read-only, a scratch folder) is
 * all it can write, the studio's secrets and every other CLI's sign-in stay unreadable, and only
 * Cursor's hosts are reachable. Inside it every tool call is allowed (`--force`): the box is the
 * boundary, as for OpenCode.
 *
 * One turn is one process: the prompt goes in on stdin, each stdout line is one event
 * (`cursor-events.ts`), and the next turn resumes the session by its id (`--resume`). A failed turn
 * says why on stderr only; its Connect code (`[resource_exhausted]`) decides the failure's kind.
 * A turn whose CLI goes quiet for too long, or keeps running after its result, is stopped with
 * everything it started. Studio tools arrive through the same bridge Codex uses.
 */
import { execFile } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { CATALOG_DEADLINE_MS, ModelCatalog } from "./model-catalog.ts";
import { cliVersion, resolveCodingCli } from "./external-cli.ts";
import { runCommand } from "./claude-cli.ts";
import { lockUnowned, ownershipBriefing, releaseLocks, releaseStaleLocks, type LockRecord } from "./ownership-locks.ts";
import { StudioBridge, answerBridgeCall, bridgeTools } from "./studio-bridge.ts";
import { writeDelegateStills } from "./codex.ts";
import { BLIND_JUDGE_NOTE, JUDGE_RULES, offLimitsNote, planModeNote, readOnlyNote } from "./codex-prompts.ts";
import {
  CURSOR_FILE_STORE,
  CURSOR_HOSTS,
  CursorAccess,
  CursorCommand,
  cursorSessionArgv,
  parseCursorModels,
  parseCursorStatus,
} from "./cursor-cli.ts";
import {
  CursorEvent,
  CursorSubtype,
  cursorStream,
  translateCursorEvent,
  type CursorStream,
  type CursorTranslated,
} from "./cursor-events.ts";
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
} from "./types.ts";
import { abortControllerFor, CompletionStop, interruption, partialDelegateResult, STOPPED_BY_USER } from "./common.ts";
import type { PartialDelegateState } from "./common.ts";
import { ProcessSandbox, type SandboxOptions, shellQuote } from "../spawn.ts";
import { childEnv } from "../child-env.ts";
import { credentialHomes, cursorHomes } from "../credential-homes.ts";
import { killProcessTree } from "../process-tree.ts";
import type { Usage } from "../types.ts";
import { CodingCliState } from "../../shared/coding-cli.ts";
import { MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";
import { type EngineAccount, EngineKind, EngineStatusCode, LoginSource } from "../../shared/engine-descriptor.ts";
import { EngineFailureKind, StopReason } from "../../shared/engine-requests.ts";
import { ModelCatalogSource } from "../../shared/model-catalog.ts";
import { engineMode, PermissionMode } from "../../shared/permissions.ts";
import { EngineId } from "../../shared/providers.ts";
import { t } from "../../shared/i18n.ts";
import { stripTerminalCodes } from "../../shared/terminal.ts";

/** How long `cursor-agent models` or `status` may take: each starts the CLI and asks Cursor. */
const LISTING_TIMEOUT_MS = 30 * SECOND_MS;
/**
 * How long a sign-in check serves `status()` before the CLI is asked again, as long as a model list
 * does: each check starts the CLI. A sign-in or sign-out in Genex asks again at once.
 */
const SIGN_IN_FRESH_MS = MINUTE_MS;
/** How long a git probe for a worktree's metadata may take. */
const GIT_PROBE_TIMEOUT_MS = 5 * SECOND_MS;
/** How long a judge's one-shot answer may take before it is a timeout. */
const COMPLETE_TIMEOUT_MS = 15 * MINUTE_MS;
/** How long a stopped session gets to exit politely before its whole tree is killed. */
const KILL_GRACE_MS = 3 * SECOND_MS;
/** How much of stderr is kept to explain an exit the event stream never explained. */
const STDERR_TAIL_CHARS = 4_000;
/**
 * How long a session may print nothing before it counts as stalled: the model's turn, or (while a
 * tool call is open, which prints nothing until it ends) a long build or install.
 */
export const CURSOR_STALL_MS = 10 * MINUTE_MS;
export const CURSOR_TOOL_STALL_MS = 30 * MINUTE_MS;
/** How long the CLI may keep running once it printed its result (a reported `--print` hang). */
export const CURSOR_RESULT_EXIT_MS = 5 * SECOND_MS;

/** Connect's error codes in a failed turn's stderr (`[resource_exhausted] …`), by the failure each one is. */
const CONNECT_FAILURES: Readonly<Record<string, EngineFailureKind>> = {
  resource_exhausted: EngineFailureKind.UsageLimit,
  unauthenticated: EngineFailureKind.Auth,
  unavailable: EngineFailureKind.Unavailable,
  internal: EngineFailureKind.Unavailable,
  deadline_exceeded: EngineFailureKind.Unavailable,
};
/** A Connect error's code as it opens the message the CLI prints. */
const CONNECT_CODE = /\[([a-z_]+)\]/;

/**
 * What this engine says: statuses and remedies for Settings in the person's language (functions,
 * since main sets its language after it starts), and errors in English, since the harness and the
 * chat's model read them too.
 */
const MESSAGE = {
  NotInstalled: "Cursor's CLI isn't installed on this computer.",
  NotInstalledStatus: () => t("Cursor isn't installed on this computer."),
  InstallRemedy: () => t("Install Cursor from Settings › Model Providers."),
  SignedOut: () => t("Not signed in to Cursor."),
  SignInRemedy: () => t("Sign in to Cursor from Settings › Model Providers."),
  NoModels: () => t("Your Cursor account has no model it can run."),
  Ready: (version: string | undefined, count: number) =>
    t("Cursor {version}, {count, plural, other {# model(s)}}", { version: version ?? "", count }).trim(),
  NoTools: "Cursor's one-shot answers take no studio tools",
  NoCompact: "Cursor compacts its own sessions",
  Stopped: (code: number | null) => `Cursor's CLI exited with ${code}`,
  Stalled: (minutes: number) =>
    `Cursor printed nothing for ${minutes} min, so Genex stopped it. Send the message again to continue.`,
  NoAnswer: "Cursor gave no answer",
  JudgeTimedOut: (minutes: number) => `the judge did not answer within ${minutes} min`,
  Pictures: (paths: string[]) =>
    `PICTURES — open these with your read tool before you start; they are part of this message:\n${paths.map((file) => `  ${file}`).join("\n")}`,
} as const;

/** Where the CLI is, whether it works, and its version. */
export interface CursorCli {
  ready: boolean;
  path?: string;
  version?: string;
  detail: string;
}

/** One `cursor-agent --print` turn, as the engine starts it; injectable in tests. */
export interface CursorInvocation {
  argv: string[];
  /** Where the session runs: the workspace, or a read-only session's scratch folder. */
  cwd: string;
  prompt: string;
  env: Record<string, string>;
  signal: AbortSignal;
  /** The sandbox the real CLI is started in. */
  sandbox: SandboxOptions;
  /** The hosts the session may reach. */
  domains: string[];
}
export type CursorExec = (invocation: CursorInvocation) => AsyncIterable<Record<string, unknown>>;

/**
 * A turn the CLI ended without its result: its exit code, the tail of what it said on stderr, and
 * whether it got as far as starting the session. Thrown by the stream, read by the engine.
 */
export class CursorExit extends Error {
  readonly code: number | null;
  readonly started: boolean;
  constructor(code: number | null, stderr: string, started: boolean) {
    super(stripTerminalCodes(stderr).trim() || MESSAGE.Stopped(code));
    this.name = "CursorExit";
    this.code = code;
    this.started = started;
  }
}

/** A turn that printed nothing for too long and was stopped. */
export class CursorStall extends Error {
  constructor(ms: number) {
    super(MESSAGE.Stalled(Math.round(ms / MINUTE_MS)));
    this.name = "CursorStall";
  }
}

/** The clock a turn's watch runs on; a test moves it by hand. */
export type CursorSchedule = (run: () => void, ms: number) => () => void;
const realSchedule: CursorSchedule = (run, ms) => {
  const timer = setTimeout(run, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
};

export interface CursorEngineOptions {
  /**
   * Where read-only sessions run and their temporary files go: never under the engine homes, which
   * every sandbox denies. The system temporary folder when not given.
   */
  scratchRoot?: string;
  /** What no Cursor session may read: the studio's secrets, the engines' homes. */
  protectedPaths?: string[];
  toolPath?: () => Promise<string>;
  onModelsChanged?: () => void;
  /** Where locks are recovered from after a crash (as Codex's). */
  lockRecovery?: string;
  /** Test seam: run a session without the CLI. */
  execFn?: CursorExec;
  /** Test seam: the CLI's answer to `models`, instead of asking it. */
  listModels?: () => Promise<string>;
  /** Test seam: the CLI's answer to `status --format json`, instead of asking it. */
  readStatus?: () => Promise<string>;
  /** Test seam: where the CLI is and whether it works. */
  resolveCli?: () => Promise<CursorCli>;
  /** Test seam: the clock sign-in checks are kept by. */
  now?: () => number;
}

/** What a session has done so far. */
interface CursorRun {
  usage: Usage;
  turns: number;
  summary: string;
  reply: string;
  sessionId: string | undefined;
  /** The model the session reported running, by its display name. */
  reported: string | undefined;
  completed: boolean;
  deadlineHit: boolean;
  stream: CursorStream;
}

export class CursorEngine implements Engine {
  readonly id = EngineId.Cursor;
  readonly label = "Cursor";
  readonly kind = EngineKind.Delegated;
  readonly supportsSessions = true;
  readonly #scratchRoot: string;
  readonly #protectedPaths: string[];
  readonly #toolPath: (() => Promise<string>) | undefined;
  readonly #catalog: ModelCatalog;
  readonly #execFn: CursorExec | undefined;
  readonly #listModels: (() => Promise<string>) | undefined;
  readonly #readStatus: (() => Promise<string>) | undefined;
  readonly #resolveCli: () => Promise<CursorCli>;
  readonly #lockRecovery: string | undefined;
  readonly #now: () => number;
  /** The last sign-in check, and when it was made: `status()` runs often and each check starts the CLI. */
  #signIn: { at: number; signedIn: boolean } | null = null;

  constructor(options: CursorEngineOptions = {}) {
    this.#scratchRoot = options.scratchRoot ?? path.join(os.tmpdir(), `studio-${EngineId.Cursor}`);
    this.#protectedPaths = options.protectedPaths ?? [];
    this.#toolPath = options.toolPath;
    this.#catalog = new ModelCatalog(options.onModelsChanged);
    this.#execFn = options.execFn;
    this.#listModels = options.listModels;
    this.#readStatus = options.readStatus;
    this.#resolveCli = options.resolveCli ?? defaultResolveCli;
    this.#lockRecovery = options.lockRecovery;
    this.#now = options.now ?? Date.now;
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
    const signedIn = await this.#signedIn(cli).catch((err: unknown) =>
      err instanceof Error ? err : new Error(String(err)),
    );
    if (signedIn instanceof Error) return { code: EngineStatusCode.Error, detail: signedIn.message };
    if (!signedIn)
      return { code: EngineStatusCode.NeedsLogin, detail: MESSAGE.SignedOut(), remedy: MESSAGE.SignInRemedy() };
    await this.refreshModels().catch(() => {});
    const count = this.#catalog.models().length;
    if (count) return { code: EngineStatusCode.Ready, detail: MESSAGE.Ready(cliVersion(cli.version), count) };
    // A list that could not be read says why; an account that lists nothing has nothing to run.
    const problem = this.#catalog.snapshot().problem;
    if (problem) return { code: EngineStatusCode.Error, detail: problem.message };
    return { code: EngineStatusCode.NeedsLogin, detail: MESSAGE.NoModels(), remedy: MESSAGE.SignInRemedy() };
  }

  /** Whose sign-in Cursor runs on: its own (`system`), which Genex never reads, or no one's. */
  async account(): Promise<EngineAccount> {
    const cli = await this.#resolveCli();
    const signedIn = cli.ready ? await this.#signedIn(cli).catch(() => false) : false;
    return {
      source: signedIn ? LoginSource.System : LoginSource.None,
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

  /**
   * The models Cursor's account can run, as it lists them. A forced refresh follows a sign-in or a
   * sign-out, so the sign-in is checked again too.
   */
  async refreshModels(force = false): Promise<void> {
    if (force) this.#signIn = null;
    const cli = await this.#resolveCli();
    if (!cli.ready) return;
    if (!(await this.#signedIn(cli))) return;
    await this.#catalog.refresh(`${cli.path ?? ""}\0${cli.version ?? ""}`, () => this.#readModels(cli), force);
  }

  async #readModels(cli: CursorCli): Promise<{ models: EngineModel[]; source: typeof ModelCatalogSource.Provider }> {
    const stdout = this.#listModels ? await this.#listModels() : await askCli(cli.path, [CursorCommand.Models]);
    return { models: parseCursorModels(stdout), source: ModelCatalogSource.Provider };
  }

  /** Whether the CLI says an account is signed in, asked again once the last answer is stale. */
  async #signedIn(cli: CursorCli): Promise<boolean> {
    const known = this.#signIn;
    if (known && this.#now() - known.at < SIGN_IN_FRESH_MS) return known.signedIn;
    const stdout = this.#readStatus
      ? await this.#readStatus()
      : await askCli(cli.path, [CursorCommand.Status, "--format", "json"]);
    const { signedIn } = parseCursorStatus(stdout);
    this.#signIn = { at: this.#now(), signedIn };
    return signedIn;
  }

  /** Cursor keeps its own default model; with none picked, `--model` is left out and it uses that. */
  async defaultModel(): Promise<string | null> {
    return null;
  }

  /** Sign out of the account Genex's Cursor runs on: the CLI forgets its own sign-in file. */
  async signOut(): Promise<void> {
    const cli = await this.#resolveCli();
    if (cli.path) await askCli(cli.path, [CursorCommand.SignOut]);
    this.#signIn = null;
    this.#catalog.invalidate();
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
    const scratch = access === CursorAccess.Build ? null : await this.#scratch("run-");
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
        prompt: this.#brief(request, { access, cwd, scratch, locks, bridge, pictures: stills.paths }),
        signal: controller.signal,
      });
      await this.#readEvents(request, run, invocation);
    } catch (err) {
      return await this.#endingAfterThrow(err, run, request, partial);
    } finally {
      if (deadline) clearTimeout(deadline);
      if (stills.dir) await rm(stills.dir, { recursive: true, force: true }).catch(() => {});
      await this.#cleanUp(cwd, locks, scratch, bridge);
    }
    if (request.signal?.aborted || run.deadlineHit)
      return partialDelegateResult(this.id, interruption(request.signal?.aborted), partial());
    return completed(this.id, run, startedAt, request.model, recordedCalls(bridge, request));
  }

  /** A one-shot answer (a judge's verdict): no tools, Cursor's own read-only mode, in an empty folder of its own. */
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
    let run: CursorRun;
    try {
      run = await this.#answer(request, controller.signal);
    } catch (err) {
      throw stopped() ?? (await this.#failure(err));
    } finally {
      clearTimeout(timer);
    }
    const stop = stopped();
    if (stop) throw stop;
    const answer = run.reply || run.summary;
    if (!answer) throw new EngineError(EngineFailureKind.Other, this.id, MESSAGE.NoAnswer);
    return {
      message: { role: "assistant", content: answer },
      usage: run.usage,
      stopReason: CompletionStop.Stop,
      model: request.model ?? "",
      engine: this.id,
    };
  }

  /** One answer session in a scratch folder, its pictures beside it; both removed after. */
  async #answer(request: CompleteRequest, signal: AbortSignal): Promise<CursorRun> {
    const scratch = await this.#scratch("answer-");
    const images = request.messages.flatMap((message) => message.images ?? []);
    const stills = await writeDelegateStills(images.map((image) => ({ ...image, label: image.label ?? "" })));
    const run = newRun(this.id, undefined);
    try {
      const asked = { cwd: scratch, prompt: "", ...(request.model ? { model: request.model } : {}) };
      const invocation = await this.#invocation(asked, {
        access: CursorAccess.Answer,
        cwd: scratch,
        runDir: scratch,
        prompt: answerPrompt(request, stills.paths),
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

  /** The brief, plus what Cursor can only be told: its tools, its seam, its folder, its pictures, what is off limits. */
  #brief(
    request: DelegateRequest,
    ctx: {
      access: CursorAccess;
      cwd: string;
      scratch: string | null;
      locks: LockRecord | null;
      bridge: StudioBridge | null;
      pictures: string[];
    },
  ): string {
    const hasSeam = request.ownership && (request.ownership.owns.length || ctx.locks?.files.length);
    const plan = chatMode(request) === PermissionMode.Plan && ctx.scratch;
    return [
      request.prompt,
      ctx.pictures.length ? MESSAGE.Pictures(ctx.pictures) : "",
      ctx.bridge?.instructions() ?? "",
      hasSeam && request.ownership ? ownershipBriefing(request.ownership) : "",
      ctx.access === CursorAccess.Blind ? BLIND_JUDGE_NOTE : "",
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

  /** The command, environment and sandbox of one turn. */
  async #invocation(
    request: Pick<DelegateRequest, "model" | "resume" | "denyReads" | "cwd" | "prompt">,
    ctx: { access: CursorAccess; cwd: string; runDir: string; prompt: string; signal: AbortSignal },
  ): Promise<CursorInvocation> {
    const compileCache = path.join(this.#scratchRoot, "compile-cache");
    await mkdir(compileCache, { recursive: true });
    const argv = cursorSessionArgv({
      access: ctx.access,
      workspace: ctx.runDir,
      model: request.model,
      resume: request.resume,
    });
    return {
      argv,
      cwd: ctx.runDir,
      prompt: ctx.prompt,
      env: cursorSessionEnv({ compileCache }),
      signal: ctx.signal,
      sandbox: await this.#sandboxOptions(ctx, request.denyReads ?? [], compileCache),
      domains: [...CURSOR_HOSTS],
    };
  }

  async #sandboxOptions(
    ctx: { access: CursorAccess; cwd: string; runDir: string },
    denyReads: string[],
    compileCache: string,
  ): Promise<SandboxOptions> {
    return cursorSandbox({
      runDir: ctx.runDir,
      gameDir: ctx.cwd,
      gitDirs: ctx.access === CursorAccess.Build ? await gitMetadata(ctx.cwd) : [],
      scratchDir: path.join(this.#scratchRoot, "tmp"),
      compileCache,
      // A blind judge plays the build from an empty folder and may read none of it.
      secretPaths: [...this.#protectedPaths, ...denyReads, ...(ctx.access === CursorAccess.Blind ? [ctx.cwd] : [])],
      ...(this.#toolPath ? { toolPath: this.#toolPath } : {}),
    });
  }

  /** Read the turn's events to the end: the chat's live rows, its tokens and its summary. */
  async #readEvents(
    request: Pick<DelegateRequest, "onEvent">,
    run: CursorRun,
    invocation: CursorInvocation,
  ): Promise<void> {
    const events = (this.#execFn ?? runCursor)(invocation);
    for await (const event of events) applyTranslated(request, run, translateCursorEvent(event, run.stream));
  }

  /** A throw is a stop, a deadline, a failure the run policy acts on, or an outcome to report. */
  async #endingAfterThrow(
    err: unknown,
    run: CursorRun,
    request: DelegateRequest,
    partial: () => PartialDelegateState,
  ): Promise<DelegateResult> {
    if (request.signal?.aborted || run.deadlineHit)
      return partialDelegateResult(this.id, interruption(request.signal?.aborted), partial());
    const failure = await this.#failure(err);
    if (failure.kind !== EngineFailureKind.Other) throw failure;
    return partialDelegateResult(this.id, { stopReason: StopReason.Error, errorText: failure.message }, partial());
  }

  /**
   * What a failed turn was: the kind its Connect code names; a CLI that stopped before its session
   * started is a sign-in failure when the CLI says no account is signed in; anything else keeps
   * the CLI's own words.
   */
  async #failure(err: unknown): Promise<EngineError> {
    if (err instanceof EngineError) return err;
    const message = err instanceof Error ? err.message : String(err);
    const kind = connectFailure(message);
    if (kind) return new EngineError(kind, this.id, message);
    if (err instanceof CursorExit && !err.started && !(await this.#stillSignedIn()))
      return new EngineError(EngineFailureKind.Auth, this.id, message);
    return new EngineError(EngineFailureKind.Other, this.id, message);
  }

  /** Whether an account is still signed in, asked afresh; a CLI that cannot say counts as signed in. */
  async #stillSignedIn(): Promise<boolean> {
    this.#signIn = null;
    const cli = await this.#resolveCli().catch(() => null);
    if (!cli?.ready) return true;
    return this.#signedIn(cli).catch(() => true);
  }
}

/** The failure kind a Connect code in the CLI's words names, or null for none Genex reacts to. */
export function connectFailure(message: string): EngineFailureKind | null {
  const code = CONNECT_CODE.exec(message)?.[1];
  return code && Object.hasOwn(CONNECT_FAILURES, code) ? (CONNECT_FAILURES[code] ?? null) : null;
}

/** The sandbox a session runs in: the folder it works in, Cursor's own folders, and nothing it must not read. */
export function cursorSandbox(input: {
  runDir: string;
  gameDir: string;
  gitDirs: string[];
  scratchDir: string;
  compileCache: string;
  secretPaths: string[];
  toolPath?: () => Promise<string>;
}): SandboxOptions {
  return {
    writableRoots: [input.runDir, ...input.gitDirs, input.compileCache],
    scratchDir: input.scratchDir,
    secretPaths: input.secretPaths,
    // Cursor's settings, chats and sign-in file: its own to read and write in this sandbox alone.
    ownHome: cursorHomes(),
    // A game's own Cursor settings, rules, hooks and MCP servers are never the session's to plant.
    denyWrite: [path.join(input.gameDir, ".cursor")],
    ...(input.toolPath ? { toolPath: input.toolPath } : {}),
  };
}

/**
 * The variables a turn starts with, over the sandbox's allow-listed environment: the sign-in in
 * its file, no browser, Node's compile cache in a folder the sandbox lets it write, Node's own
 * requests through the sandbox's proxy (Cursor's agent connection reads the proxy itself), and
 * Cursor's folders named outright: on Windows the session runs as the sandbox's own user, whose
 * home holds none of them.
 */
export function cursorSessionEnv(
  ctx: { compileCache: string },
  env: Record<string, string | undefined> = process.env,
  home: string = os.homedir(),
): Record<string, string> {
  const config = absolute(env.CURSOR_CONFIG_DIR) ?? path.join(home, ".cursor");
  const data = absolute(env.CURSOR_DATA_DIR) ?? path.join(home, ".cursor");
  const own: Record<string, string> = {
    ...CURSOR_FILE_STORE,
    NO_OPEN_BROWSER: "1",
    NODE_COMPILE_CACHE: ctx.compileCache,
    NODE_USE_ENV_PROXY: "1",
    CURSOR_CONFIG_DIR: config,
    CURSOR_DATA_DIR: data,
  };
  const xdgConfig = absolute(env.XDG_CONFIG_HOME);
  if (xdgConfig) own.XDG_CONFIG_HOME = xdgConfig;
  const appData = absolute(env.APPDATA);
  if (appData) own.APPDATA = appData;
  return own;
}

/** A variable's folder when it names an absolute one. */
function absolute(value: string | undefined): string | undefined {
  return value && path.isAbsolute(value) ? value : undefined;
}

/** What a session's tools may do: a build edits; a read-only session, a lead while its build runs and Plan only look. */
function sessionAccess(request: DelegateRequest): CursorAccess {
  if (request.blind) return CursorAccess.Blind;
  const readOnly = Boolean(request.readOnly) && !request.coordinator;
  return readOnly || chatMode(request) === PermissionMode.Plan ? CursorAccess.ReadOnly : CursorAccess.Build;
}

/** The chat's mode as Cursor honours it (Auto or Plan), or null for unattended work. */
function chatMode(request: DelegateRequest): PermissionMode | null {
  return request.permissions ? engineMode(EngineId.Cursor, request.permissions.mode) : null;
}

/** A judge's question as one prompt: the system words, the conversation, its pictures and the critic's two rules. */
function answerPrompt(request: CompleteRequest, pictures: string[]): string {
  const conversation = request.messages.map((message) => `${message.role.toUpperCase()}:\n${message.content}`);
  return [
    request.systemPrompt ?? "",
    ...conversation,
    pictures.length ? MESSAGE.Pictures(pictures) : "",
    ...JUDGE_RULES,
  ]
    .filter((part) => part.trim())
    .join("\n\n");
}

function newRun(engine: string, resume: string | undefined): CursorRun {
  return {
    usage: { engine },
    turns: 0,
    summary: "",
    reply: "",
    sessionId: resume,
    reported: undefined,
    completed: false,
    deadlineHit: false,
    stream: cursorStream(),
  };
}

/** The usage counts each result reports, added up over a session. */
const SUMMED_USAGE = ["input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens"] as const;

/** One translated event: forwarded to the log, and folded into the run. */
function applyTranslated(
  request: Pick<DelegateRequest, "onEvent">,
  run: CursorRun,
  translated: CursorTranslated,
): void {
  if (translated.sessionId) run.sessionId = translated.sessionId;
  if (translated.model) run.reported = translated.model;
  const phase = translated.activity;
  if (phase)
    request.onEvent?.({
      type: DelegateEventType.Activity,
      payload: { phase, engine: EngineId.Cursor, sessionId: run.sessionId },
    });
  if (translated.delta)
    request.onEvent?.({
      type: DelegateEventType.TextDelta,
      payload: { streamId: translated.delta.streamId, delta: translated.delta.text },
    });
  for (const event of translated.events) request.onEvent?.(event);
  if (translated.text) run.summary = translated.text;
  if (translated.reply) run.reply = translated.reply;
  if (translated.turns) run.turns += translated.turns;
  if (translated.completed) run.completed = true;
  for (const key of SUMMED_USAGE) {
    const value = translated.usage?.[key];
    if (typeof value === "number") run.usage[key] = (run.usage[key] ?? 0) + value;
  }
}

/** What a run cut short had done. */
function partialState(
  run: CursorRun,
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

/**
 * A session whose turn completed, on the person's Cursor plan: its own models draw on the plan's
 * pool, so its tokens are quota, not a bill (Cursor reports no price).
 */
function completed(
  engine: string,
  run: CursorRun,
  startedAt: number,
  model: string | undefined,
  studioToolCalls: NonNullable<DelegateResult["studioToolCalls"]>,
): DelegateResult {
  return {
    ok: true,
    summary: run.summary || run.reply,
    usage: run.usage,
    turns: run.turns,
    billing: "subscription",
    engine,
    durationMs: Date.now() - startedAt,
    stopReason: StopReason.Completed,
    ...(model ? { model, requestedModel: model } : {}),
    ...(run.sessionId ? { sessionId: run.sessionId } : {}),
    ...(studioToolCalls.length ? { studioToolCalls } : {}),
  };
}

/** The CLI's state for its account row: working, installed but unusable, or missing. */
function cliState(cli: { ready: boolean; path?: string }): EngineAccount["cli"]["state"] {
  if (cli.ready) return CodingCliState.Ready;
  return cli.path ? CodingCliState.Incompatible : CodingCliState.Missing;
}

/** Where the CLI is, whether it works, and its version. */
async function defaultResolveCli(): Promise<CursorCli> {
  const installation = await resolveCodingCli(EngineId.Cursor);
  const { state, path: binary, version, detail } = installation.status;
  return {
    ready: state === CodingCliState.Ready && Boolean(binary),
    ...(binary ? { path: binary } : {}),
    ...(version ? { version } : {}),
    detail,
  };
}

/** One of the CLI's own commands, run on the host with its sign-in in its file: an answer, no session and no prompt. */
async function askCli(binary: string | undefined, args: string[]): Promise<string> {
  if (!binary) return "";
  const env = childEnv(process.env, { base: "contractor", vendor: "cursor", set: { ...CURSOR_FILE_STORE } });
  const result = await runCommand(binary, args, { env, timeoutMs: Math.max(LISTING_TIMEOUT_MS, CATALOG_DEADLINE_MS) });
  if (result.code !== 0) throw new Error(stripTerminalCodes(result.stderr).trim() || MESSAGE.Stopped(result.code));
  return result.stdout;
}

/** A linked worktree's Git metadata outside the workspace, which a build must be able to commit to. */
async function gitMetadata(cwd: string): Promise<string[]> {
  const dirs: string[] = [];
  for (const flag of ["--absolute-git-dir", "--git-common-dir"]) {
    const answer = await promisify(execFile)("git", ["-C", cwd, "rev-parse", flag], {
      windowsHide: true,
      timeout: GIT_PROBE_TIMEOUT_MS,
    }).catch(() => null);
    if (answer)
      dirs.push(
        await realpath(path.resolve(cwd, answer.stdout.trim())).catch(() => path.resolve(cwd, answer.stdout.trim())),
      );
  }
  return [...new Set(dirs)];
}

/** Start `cursor-agent` inside the studio's sandbox and yield its events. */
async function* runCursor(invocation: CursorInvocation): AsyncGenerator<Record<string, unknown>> {
  invocation.signal.throwIfAborted();
  const installation = await resolveCodingCli(EngineId.Cursor);
  const binary = installation.status.path;
  if (!binary) throw new EngineError(EngineFailureKind.Unavailable, EngineId.Cursor, MESSAGE.NotInstalled);
  const sandbox = await ProcessSandbox.create(invocation.sandbox);
  try {
    yield* cursorEvents(sandbox, binary, invocation);
  } finally {
    await sandbox.dispose().catch(() => {});
  }
}

/**
 * Start `binary` with the invocation's argv in `sandbox` and yield its events. The prompt is the
 * sandbox's to deliver: on Windows srt-win does not pass stdin on.
 */
export async function* cursorEvents(
  sandbox: Pick<ProcessSandbox, "spawnLongLived">,
  binary: string,
  invocation: Omit<CursorInvocation, "sandbox">,
  schedule: CursorSchedule = realSchedule,
): AsyncGenerator<Record<string, unknown>> {
  const command = [binary, ...invocation.argv].map(shellQuote).join(" ");
  const { child } = await sandbox.spawnLongLived({
    command,
    cwd: invocation.cwd,
    env: invocation.env,
    label: `cursor:${path.basename(invocation.cwd)}`,
    policy: { allowedDomains: invocation.domains },
    stdin: invocation.prompt,
  });
  yield* childEvents(child, invocation, schedule);
}

/** Stop a turn and everything it started (its process group; on Windows its tree), unless it is gone already. */
async function stopTree(child: Pick<ChildProcess, "pid" | "exitCode" | "signalCode">, signal: NodeJS.Signals) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await killProcessTree(child.pid, { signal });
}

/**
 * The turn's watch: the silence it allows (longer while a tool call is open, which prints nothing
 * until it ends), the stall that ends it, and the short grace a CLI gets to exit once it printed
 * its result.
 */
function turnWatch(child: ChildProcess, schedule: CursorSchedule) {
  let cancel: () => void = () => {};
  let stalled: CursorStall | null = null;
  const open = new Set<string>();
  const stop = () => {
    void stopTree(child, "SIGTERM");
    schedule(() => void stopTree(child, "SIGKILL"), KILL_GRACE_MS);
  };
  const quiet = (ms: number) => {
    cancel();
    cancel = schedule(() => {
      stalled = new CursorStall(ms);
      stop();
    }, ms);
  };
  return {
    stalled: () => stalled,
    /** One event arrived: the clock starts again, and a result gives the CLI its grace to exit. */
    saw(event: Record<string, unknown>): void {
      const call = typeof event.call_id === "string" ? event.call_id : "";
      const tool = event.type === CursorEvent.ToolCall;
      if (tool && event.subtype === CursorSubtype.Started && call) open.add(call);
      if (tool && event.subtype === CursorSubtype.Completed) open.delete(call);
      if (event.type === CursorEvent.Result) {
        cancel();
        cancel = schedule(stop, CURSOR_RESULT_EXIT_MS);
        return;
      }
      quiet(open.size ? CURSOR_TOOL_STALL_MS : CURSOR_STALL_MS);
    },
    start: () => quiet(CURSOR_STALL_MS),
    end: () => cancel(),
    stop,
  };
}

/**
 * The child's stdout as events, stopping it on abort or a stall. A turn that ends without its
 * result throws what the CLI said on stderr (`CursorExit`), or the stall. Whatever the turn left
 * running in its process group is stopped once it ends.
 */
async function* childEvents(
  child: ChildProcess,
  invocation: Pick<CursorInvocation, "signal">,
  schedule: CursorSchedule,
): AsyncGenerator<Record<string, unknown>> {
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-STDERR_TAIL_CHARS);
  });
  const watch = turnWatch(child, schedule);
  if (invocation.signal.aborted) watch.stop();
  else invocation.signal.addEventListener("abort", watch.stop, { once: true });
  const exit = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code));
  });
  let started = false;
  let finished = false;
  watch.start();
  try {
    if (child.stdout) {
      for await (const line of createInterface({ input: child.stdout })) {
        const event = parseCursorLine(line);
        if (!event) continue;
        watch.saw(event);
        started ||= event.type === CursorEvent.System;
        finished ||= event.type === CursorEvent.Result;
        yield event;
      }
    }
  } finally {
    invocation.signal.removeEventListener("abort", watch.stop);
  }
  const code = await exit;
  watch.end();
  sweepGroup(child.pid);
  const stall = watch.stalled();
  if (stall && !finished) throw stall;
  if (!finished && !invocation.signal.aborted) throw new CursorExit(code, stderr, started);
}

/**
 * A dev server or watcher the turn left running in its process group (macOS and Linux; the group
 * outlives its leader while a member runs) goes with it, the moment the CLI is gone. The group alone,
 * never the CLI's own process id, which another process may already have taken.
 */
function sweepGroup(pid: number | undefined): void {
  if (!pid || process.platform === "win32") return;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    /* the group is gone: nothing was left behind */
  }
}

/** One stdout line as an event, or null for a line that is not one (a stray log line). */
export function parseCursorLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const value = JSON.parse(trimmed) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
