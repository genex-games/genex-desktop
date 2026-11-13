/**
 * Antigravity: Google's coding agent as a delegated harness, driven through `agy acp`, its Agent
 * Client Protocol server on stdio (`acp.ts`).
 *
 * Antigravity runs its own agent loop on the models the person's Google AI plan can run, and keeps
 * its Google sign-in itself, which the studio never reads. Its own controls are no box (its
 * terminal sandbox leaves its file tools out, its permission rules do not reach an ACP session),
 * so every session runs in the studio's `ProcessSandbox`: the workspace (or, read-only, a scratch
 * folder) is all it can write, the studio's secrets and every other CLI's sign-in stay unreadable,
 * and only Google's hosts are reachable. Inside it every tool call the agent asks about is
 * allowed: the box is the boundary, as for Cursor and OpenCode.
 *
 * One turn is one process: a session is opened (or an earlier one loaded, which replays its
 * history first, unread), its model set, the prompt sent, and every `session/update` read
 * (`antigravity-events.ts`) until `session/prompt` is answered with the turn's ending and tokens.
 * A turn whose agent goes quiet for too long is stopped with everything it started. Studio tools
 * arrive through the same bridge Codex uses.
 */
import { execFile } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import { type NeverTouchList, neverTouchVerdict, SHELL_TOOL } from "./never-touch.ts";
import path from "node:path";
import { createInterface } from "node:readline";
import type { Writable } from "node:stream";
import { promisify } from "node:util";
import {
  ACP_PROTOCOL_VERSION,
  AcpConnection,
  AcpError,
  AcpErrorCode,
  AcpMethod,
  AcpPermissionKind,
  AcpToolKind,
  AcpStopReason,
  AcpToolStatus,
  AcpUpdate,
} from "./acp.ts";
import {
  ANTIGRAVITY_CLIENT,
  ANTIGRAVITY_HOSTS,
  ANTIGRAVITY_SESSION_ARGV,
  AntigravityAccess,
  type AntigravitySession,
  type AntigravityTier,
  type Json,
  parseAntigravitySession,
  record,
  text,
} from "./antigravity-cli.ts";
import {
  type AntigravityStream,
  type AntigravityTranslated,
  antigravityStream,
  flushAntigravityStream,
  translateAntigravityUpdate,
} from "./antigravity-events.ts";
import { ModelCatalog } from "./model-catalog.ts";
import { cliVersion, resolveCodingCli } from "./external-cli.ts";
import { releaseStaleLocks } from "./ownership-locks.ts";
import { StudioBridge, answerBridgeCall, bridgeTools } from "./studio-bridge.ts";
import { JUDGE_RULES, offLimitsNote, planModeNote, readOnlyNote } from "./codex-prompts.ts";
import { textsAsSent } from "./genex-mark-prompts.ts";
import {
  type CompleteRequest,
  type CompleteResponse,
  type DelegateImage,
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
import { ProcessSandbox, type SandboxOptions, SandboxMachService, shellQuote } from "../spawn.ts";
import { childEnv } from "../child-env.ts";
import { antigravityHomes, antigravityKeychain, credentialHomes } from "../credential-homes.ts";
import { killProcessTree } from "../process-tree.ts";
import { spawnCommand } from "../command-launch.ts";
import { withEnvPath } from "../toolchain.ts";
import type { Usage } from "../types.ts";
import { ChatActivityPhase } from "../../shared/chat-activity.ts";
import { CodingCliState } from "../../shared/coding-cli.ts";
import { MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";
import { type EngineAccount, EngineKind, EngineStatusCode, LoginSource } from "../../shared/engine-descriptor.ts";
import { EngineFailureKind, StopReason } from "../../shared/engine-requests.ts";
import { ModelCatalogSource } from "../../shared/model-catalog.ts";
import { engineMode, PermissionMode } from "../../shared/permissions.ts";
import { EngineId } from "../../shared/providers.ts";
import { t } from "../../shared/i18n.ts";
import { stripTerminalCodes } from "../../shared/terminal.ts";

/**
 * How long a sign-in check serves `status()` before the CLI is asked again: each check starts the
 * CLI and opens a session. A sign-in or sign-out in Genex asks again at once.
 */
const SIGN_IN_FRESH_MS = MINUTE_MS;
/** How long the CLI may take to open the session a sign-in check asks for. */
const PROBE_TIMEOUT_MS = 30 * SECOND_MS;
/** How long a git probe for a worktree's metadata may take. */
const GIT_PROBE_TIMEOUT_MS = 5 * SECOND_MS;
/** How long a judge's one-shot answer may take before it is a timeout. */
const COMPLETE_TIMEOUT_MS = 15 * MINUTE_MS;
/** How long a failed sign-in check (offline, a CLI that hangs) stands before the CLI is asked again. */
const PROBE_RETRY_MS = 15 * SECOND_MS;
/** How long the CLI gets to exit by itself once its turn is answered and its input is closed. */
export const ANTIGRAVITY_EXIT_GRACE_MS = 2 * SECOND_MS;
/** How long a stopped session gets to exit politely before its whole tree is killed. */
const KILL_GRACE_MS = 3 * SECOND_MS;
/** How long a cancelled turn gets to answer its prompt (`cancelled`) before the CLI is stopped. */
export const ANTIGRAVITY_CANCEL_GRACE_MS = 5 * SECOND_MS;
/** How much of stderr is kept to explain an exit the protocol never explained. */
const STDERR_TAIL_CHARS = 4_000;
/**
 * How long a session may say nothing before it counts as stalled: the model's turn, or (while a
 * tool call is open, which says nothing until it ends) a long build or install.
 */
export const ANTIGRAVITY_STALL_MS = 10 * MINUTE_MS;
export const ANTIGRAVITY_TOOL_STALL_MS = 30 * MINUTE_MS;

/**
 * Google's status names in a failed turn's error (`RESOURCE_EXHAUSTED: …`), by the failure each
 * one is. Written from Google's API status vocabulary, not recorded: no account has run out yet.
 */
const GOOGLE_FAILURES: Readonly<Record<string, EngineFailureKind>> = {
  RESOURCE_EXHAUSTED: EngineFailureKind.UsageLimit,
  UNAUTHENTICATED: EngineFailureKind.Auth,
  UNAVAILABLE: EngineFailureKind.Unavailable,
  INTERNAL: EngineFailureKind.Unavailable,
  DEADLINE_EXCEEDED: EngineFailureKind.Unavailable,
};
/** A word in capitals in the error, as Google spells its status names. */
const GOOGLE_STATUS = /\b[A-Z][A-Z_]+\b/g;

/** How a prompt turn's own ending reads as a build's. */
const TURN_ENDINGS: Readonly<Record<string, StopReason>> = {
  [AcpStopReason.EndTurn]: StopReason.Completed,
  [AcpStopReason.MaxTokens]: StopReason.Length,
  [AcpStopReason.MaxTurnRequests]: StopReason.MaxTurns,
  [AcpStopReason.Refusal]: StopReason.Error,
  [AcpStopReason.Cancelled]: StopReason.Stopped,
};

/**
 * What this engine says: statuses and remedies for Settings in the person's language (functions,
 * since main sets its language after it starts), and errors in English, since the harness and the
 * chat's model read them too.
 */
const MESSAGE = {
  NotInstalled: "Antigravity's CLI isn't installed on this computer.",
  NotInstalledStatus: () => t("Antigravity isn't installed on this computer."),
  InstallRemedy: () => t("Install Antigravity from Settings › Model Providers."),
  SignedOut: () => t("Not signed in to Antigravity."),
  SignInRemedy: () => t("Sign in to Antigravity from Settings › Model Providers."),
  NoModels: () => t("Your Google account has no model Antigravity can run."),
  Ready: (version: string | undefined, plan: string | undefined) =>
    [t("Antigravity {version}", { version: version ?? "" }).trim(), plan].filter(Boolean).join(" · "),
  SignInFailed: "Antigravity says no Google account is signed in.",
  NoTools: "Antigravity's one-shot answers take no studio tools",
  NoCompact: "Antigravity compacts its own sessions",
  Stopped: (code: number | null) => `Antigravity's CLI exited with ${code}`,
  Stalled: (minutes: number) =>
    `Antigravity said nothing for ${minutes} min, so Genex stopped it. Send the message again to continue.`,
  NoAnswer: "Antigravity gave no answer",
  Refused: "Antigravity's model refused the request",
  JudgeTimedOut: (minutes: number) => `the judge did not answer within ${minutes} min`,
  NoSuchRequest: (method: string) => `Genex does not answer ${method}`,
} as const;

/** The log's record of a session opening, as every engine's mirror spells it (`shared/context.ts` reads it). */
const SESSION_OPENED = "init";

const count = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

/** Where the CLI is, whether it works, and its version. */
export interface AntigravityCli {
  ready: boolean;
  path?: string;
  version?: string;
  detail: string;
}

/** One `agy acp` process, as the engine starts it; injectable in tests. */
export interface AntigravityInvocation {
  argv: string[];
  /** Where the session runs: the workspace, or a read-only session's scratch folder. */
  cwd: string;
  env: Record<string, string>;
  /** The sandbox the real CLI is started in; none for a chat the person set to Bypass, which runs as them. */
  sandbox: SandboxOptions | null;
  /** The hosts the session may reach. */
  domains: string[];
}

/** A started CLI's two ends: what it prints, a line at a time, and the way to write to it and stop it. */
export interface AntigravityProcess {
  /** One line to the CLI's stdin. */
  send(line: string): void;
  /** Every line of its stdout, ending when it closes. */
  lines: AsyncIterable<string>;
  /** Its exit code and the tail of its stderr, once it is gone. */
  exited: Promise<{ code: number | null; stderr: string }>;
  /** No more input: the CLI exits by itself. */
  end(): void;
  /** Stop it and everything it started. */
  stop(): void;
}
export type AntigravityStart = (invocation: AntigravityInvocation) => Promise<AntigravityProcess>;

/** A CLI that went away before the turn ended: its exit code and what it said on stderr. */
export class AntigravityExit extends Error {
  readonly code: number | null;
  constructor(code: number | null, stderr: string) {
    super(stripTerminalCodes(stderr).trim() || MESSAGE.Stopped(code));
    this.name = "AntigravityExit";
    this.code = code;
  }
}

/** A turn that said nothing for too long and was stopped. */
export class AntigravityStall extends Error {
  constructor(ms: number) {
    super(MESSAGE.Stalled(Math.round(ms / MINUTE_MS)));
    this.name = "AntigravityStall";
  }
}

/** The clock a turn's watch runs on; a test moves it by hand. */
export type AntigravitySchedule = (run: () => void, ms: number) => () => void;
const realSchedule: AntigravitySchedule = (run, ms) => {
  const timer = setTimeout(run, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
};

export interface AntigravityEngineOptions {
  /**
   * Where read-only sessions run and their temporary files go: never under the engine homes, which
   * every sandbox denies. The system temporary folder when not given.
   */
  scratchRoot?: string;
  /** What no Antigravity session may read: the studio's secrets, the engines' homes. */
  protectedPaths?: string[];
  toolPath?: () => Promise<string>;
  onModelsChanged?: () => void;
  /** Where locks are recovered from after a crash (as Codex's). */
  lockRecovery?: string;
  /** Test seam: start a session without the CLI. */
  startFn?: AntigravityStart;
  /** Test seam: where the CLI is and whether it works. */
  resolveCli?: () => Promise<AntigravityCli>;
  /** Test seam: the clock sign-in checks are kept by. */
  now?: () => number;
  /** Test seam: the clock a turn's watch runs on. */
  schedule?: AntigravitySchedule;
}

/** What one turn is asked: the session's folder, the session to continue, its model and its prompt. */
export interface AntigravityTurnPlan {
  cwd: string;
  resume?: string | undefined;
  model?: string | undefined;
  /** The prompt's content blocks; none for a sign-in check, which only opens a session. */
  prompt: Json[];
  signal: AbortSignal;
  /** What a worker's seat never reaches: its commands are screened against it as well. */
  neverTouch?: NeverTouchList | undefined;
}

/** What a session has done so far. */
interface AntigravityRun {
  usage: Usage;
  turns: number;
  summary: string;
  sessionId: string | undefined;
  /** How the agent ended the turn (`AcpStopReason`), once it did. */
  ending: string | undefined;
  deadlineHit: boolean;
  stream: AntigravityStream;
}

/** What the engine learned about the account the last time it asked. */
interface SignIn {
  at: number;
  signedIn: boolean;
  tier?: AntigravityTier;
}

export class AntigravityEngine implements Engine {
  readonly id = EngineId.Antigravity;
  readonly label = "Antigravity";
  readonly kind = EngineKind.Delegated;
  readonly supportsSessions = true;
  readonly #scratchRoot: string;
  readonly #protectedPaths: string[];
  readonly #toolPath: (() => Promise<string>) | undefined;
  readonly #catalog: ModelCatalog;
  readonly #startFn: AntigravityStart;
  readonly #resolveCli: () => Promise<AntigravityCli>;
  readonly #lockRecovery: string | undefined;
  readonly #now: () => number;
  readonly #schedule: AntigravitySchedule;
  /** The last sign-in check, and when it was made: `status()` runs often and each check starts the CLI. */
  #signIn: SignIn | null = null;
  /** The check in flight, shared by every caller that asks meanwhile. */
  #checking: { asked: number; check: Promise<SignIn> } | null = null;
  /** Counts the sign-ins and sign-outs Genex knows of: a check answers for the count it started at. */
  #asked = 0;
  #probeFailed: { at: number; error: unknown } | null = null;

  constructor(options: AntigravityEngineOptions = {}) {
    this.#scratchRoot = options.scratchRoot ?? path.join(os.tmpdir(), `studio-${EngineId.Antigravity}`);
    this.#protectedPaths = options.protectedPaths ?? [];
    this.#toolPath = options.toolPath;
    this.#catalog = new ModelCatalog(options.onModelsChanged);
    this.#startFn = options.startFn ?? startAntigravity;
    this.#resolveCli = options.resolveCli ?? defaultResolveCli;
    this.#lockRecovery = options.lockRecovery;
    this.#now = options.now ?? Date.now;
    this.#schedule = options.schedule ?? realSchedule;
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
    const signIn = await this.#account(cli).catch((err: unknown) =>
      err instanceof Error ? err : new Error(String(err)),
    );
    if (signIn instanceof Error) return { code: EngineStatusCode.Error, detail: signIn.message };
    if (!signIn.signedIn)
      return { code: EngineStatusCode.NeedsLogin, detail: MESSAGE.SignedOut(), remedy: MESSAGE.SignInRemedy() };
    if (this.#catalog.models().length)
      return { code: EngineStatusCode.Ready, detail: MESSAGE.Ready(cliVersion(cli.version), signIn.tier?.name) };
    return { code: EngineStatusCode.NeedsLogin, detail: MESSAGE.NoModels(), remedy: MESSAGE.SignInRemedy() };
  }

  /** Whose sign-in Antigravity runs on: its own (`system`), which Genex never reads, or no one's. */
  async account(): Promise<EngineAccount> {
    const cli = await this.#resolveCli();
    const signIn = cli.ready ? await this.#account(cli).catch(() => null) : null;
    return {
      source: signIn?.signedIn ? LoginSource.System : LoginSource.None,
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
   * The models the account can run, as a new session lists them: the same question the sign-in
   * check asks. A forced refresh follows a sign-in, so the account is asked again.
   */
  async refreshModels(force = false): Promise<void> {
    if (force) this.forgetSignIn();
    const cli = await this.#resolveCli();
    if (cli.ready) await this.#account(cli);
  }

  /** Antigravity keeps its own default model; with none picked, the session runs the one it starts on. */
  async defaultModel(): Promise<string | null> {
    return null;
  }

  /**
   * The account as the CLI knows it, asked again once the last answer is stale: a session opened
   * in an empty folder says the models and the plan, or refuses with ACP's sign-in code.
   */
  async #account(cli: AntigravityCli): Promise<SignIn> {
    const known = this.#signIn;
    if (known && this.#now() - known.at < SIGN_IN_FRESH_MS) return known;
    const failed = this.#probeFailed;
    if (failed && this.#now() - failed.at < PROBE_RETRY_MS) throw failed.error;
    // A check that started before a sign-in or a sign-out answers for the account as it was: it
    // is left to finish, and a new one is asked.
    const asked = this.#asked;
    const running = this.#checking;
    if (running?.asked === asked) return running.check;
    const check = this.#probe(cli).then(
      (signIn) => this.#checked(asked, signIn),
      (error: unknown) => {
        if (asked === this.#asked) this.#probeFailed = { at: this.#now(), error };
        throw error;
      },
    );
    const checking = { asked, check };
    this.#checking = checking;
    const done = () => {
      if (this.#checking === checking) this.#checking = null;
    };
    check.then(done, done);
    return check;
  }

  /** A finished check's answer is kept only when nothing changed the sign-in while it ran. */
  #checked(asked: number, signIn: SignIn): SignIn {
    if (asked === this.#asked) this.#signIn = signIn;
    return signIn;
  }

  async #probe(cli: AntigravityCli): Promise<SignIn> {
    const scratch = await this.#scratch("probe-");
    const controller = new AbortController();
    const untimed = this.#schedule(() => controller.abort(), PROBE_TIMEOUT_MS);
    let session: AntigravitySession | null = null;
    try {
      const invocation = await this.#invocation(
        { access: AntigravityAccess.Answer, cwd: scratch, runDir: scratch },
        [],
      );
      await this.#runTurn(invocation, { cwd: scratch, prompt: [], signal: controller.signal }, (opened) => {
        session = opened;
      });
    } catch (err) {
      const failed = failure(err);
      if (failed.kind !== EngineFailureKind.Auth) throw failed;
    } finally {
      untimed();
      await rm(scratch, { recursive: true, force: true }).catch(() => {});
    }
    const opened = session as AntigravitySession | null;
    const identity = `${cli.path ?? ""}\0${cli.version ?? ""}\0${opened?.tier?.id ?? ""}`;
    if (opened)
      await this.#catalog.refresh(
        identity,
        async () => ({ models: opened.models, source: ModelCatalogSource.Provider }),
        true,
      );
    else this.#catalog.invalidate();
    return { at: this.#now(), signedIn: opened !== null, ...(opened?.tier ? { tier: opened.tier } : {}) };
  }

  /** A sign-in or a sign-out happened outside a check: the next status asks the CLI again. */
  forgetSignIn(): void {
    this.#asked += 1;
    this.#signIn = null;
    this.#probeFailed = null;
    this.#catalog.invalidate();
  }

  async delegate(request: DelegateRequest): Promise<DelegateResult> {
    if (request.compact) throw new EngineError(EngineFailureKind.Unavailable, this.id, MESSAGE.NoCompact);
    const startedAt = Date.now();
    const cwd = await realpath(path.resolve(request.cwd));
    const run = newRun(this.id, request.resume);
    const controller = abortControllerFor(request.signal);
    await releaseStaleLocks(cwd, this.#lockRecovery).catch(() => {});
    const access = sessionAccess(request);
    const scratch = access === AntigravityAccess.Build ? null : await this.#scratch("run-");
    const runDir = scratch ?? cwd;
    const bridge = await this.#openBridge(request, runDir).catch(async (err) => {
      await this.#cleanUp(scratch, null);
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
      const asPerson = runsAsPerson(request, access);
      const invocation = await this.#invocation({ access, cwd, runDir, asPerson }, request.denyReads ?? []);
      const plan: AntigravityTurnPlan = {
        cwd: runDir,
        resume: request.resume,
        model: request.model,
        prompt: promptBlocks(this.#brief(request, { cwd, scratch, bridge }), request.images ?? []),
        signal: controller.signal,
        neverTouch: request.worker?.neverTouch,
      };
      const answer = await this.#runTurn(
        invocation,
        plan,
        (session) => noteSession(request, run, session),
        (update) => applyTranslated(request, run, translateAntigravityUpdate(update, run.stream)),
      );
      applyTranslated(request, run, flushAntigravityStream(run.stream));
      noteAnswer(run, answer);
    } catch (err) {
      return this.#endingAfterThrow(err, run, request, partial);
    } finally {
      if (deadline) clearTimeout(deadline);
      await this.#cleanUp(scratch, bridge);
    }
    if (request.signal?.aborted || run.deadlineHit)
      return partialDelegateResult(this.id, interruption(request.signal?.aborted), partial());
    return ended(this.id, run, startedAt, request.model, recordedCalls(bridge, request));
  }

  /** A one-shot answer (a judge's verdict): no studio tools, a session of its own in an empty folder. */
  async complete(request: CompleteRequest): Promise<CompleteResponse> {
    if (request.tools?.length) throw new EngineError(EngineFailureKind.Unavailable, this.id, MESSAGE.NoTools);
    const controller = abortControllerFor(request.signal);
    const ceiling = request.timeoutMs ?? COMPLETE_TIMEOUT_MS;
    let timedOut = false;
    const untimed = this.#schedule(() => {
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
    let run: AntigravityRun;
    try {
      run = await this.#answer(request, controller.signal);
    } catch (err) {
      throw stopped() ?? failure(err);
    } finally {
      untimed();
    }
    const stop = stopped();
    if (stop) throw stop;
    if (!run.summary) throw new EngineError(EngineFailureKind.Other, this.id, MESSAGE.NoAnswer);
    return {
      message: { role: "assistant", content: run.summary },
      usage: run.usage,
      stopReason: CompletionStop.Stop,
      model: request.model ?? "",
      engine: this.id,
    };
  }

  /** One answer session in a scratch folder, removed after. */
  async #answer(request: CompleteRequest, signal: AbortSignal): Promise<AntigravityRun> {
    const scratch = await this.#scratch("answer-");
    const images = request.messages.flatMap((message) => message.images ?? []);
    const run = newRun(this.id, undefined);
    try {
      const invocation = await this.#invocation(
        { access: AntigravityAccess.Answer, cwd: scratch, runDir: scratch },
        [],
      );
      const plan: AntigravityTurnPlan = {
        cwd: scratch,
        model: request.model,
        prompt: promptBlocks(answerPrompt(request), images),
        signal,
      };
      const answer = await this.#runTurn(
        invocation,
        plan,
        (session) => noteSession({}, run, session),
        (update) => applyTranslated({}, run, translateAntigravityUpdate(update, run.stream)),
      );
      applyTranslated({}, run, flushAntigravityStream(run.stream));
      noteAnswer(run, answer);
      return run;
    } finally {
      await rm(scratch, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** A new folder of its own under the engine's scratch root. */
  async #scratch(prefix: string): Promise<string> {
    await mkdir(this.#scratchRoot, { recursive: true });
    return realpath(await mkdtemp(path.join(this.#scratchRoot, prefix)));
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

  /** The brief, plus what Antigravity can only be told: its tools, its folder, what is off limits. */
  #brief(request: DelegateRequest, ctx: { cwd: string; scratch: string | null; bridge: StudioBridge | null }): string {
    const plan = chatMode(request) === PermissionMode.Plan && ctx.scratch;
    return [
      ...textsAsSent(request),
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

  /** The command, environment and sandbox of one process; no sandbox for the person's Bypass. */
  async #invocation(
    ctx: { access: AntigravityAccess; cwd: string; runDir: string; asPerson?: boolean },
    denyReads: string[],
  ): Promise<AntigravityInvocation> {
    const builds = ctx.access === AntigravityAccess.Build;
    if (ctx.asPerson)
      return {
        argv: [...ANTIGRAVITY_SESSION_ARGV],
        cwd: ctx.runDir,
        // The studio's toolchain PATH, which a sandboxed session gets from its sandbox (`toolPath`).
        env: this.#toolPath ? { PATH: await this.#toolPath() } : {},
        sandbox: null,
        domains: [...ANTIGRAVITY_HOSTS],
      };
    return {
      argv: [...ANTIGRAVITY_SESSION_ARGV],
      cwd: ctx.runDir,
      env: {},
      sandbox: antigravitySandbox({
        runDir: ctx.runDir,
        gameDir: ctx.cwd,
        gitDirs: builds ? await gitMetadata(ctx.cwd) : [],
        scratchDir: path.join(this.#scratchRoot, "tmp"),
        secretPaths: [...this.#protectedPaths, ...denyReads],
        ...(this.#toolPath ? { toolPath: this.#toolPath } : {}),
      }),
      domains: [...ANTIGRAVITY_HOSTS],
    };
  }

  /** Start the CLI, run one turn over it, and leave nothing running. */
  async #runTurn(
    invocation: AntigravityInvocation,
    plan: AntigravityTurnPlan,
    onSession: (session: AntigravitySession) => void,
    onUpdate: (update: Json) => void = () => {},
  ): Promise<Json | null> {
    plan.signal.throwIfAborted();
    const agent = await this.#startFn(invocation);
    try {
      return await runTurn(agent, plan, { onSession, onUpdate, schedule: this.#schedule });
    } finally {
      agent.stop();
    }
  }

  /** A throw is a stop, a deadline, a failure the run policy acts on, or an outcome to report. */
  #endingAfterThrow(
    err: unknown,
    run: AntigravityRun,
    request: DelegateRequest,
    partial: () => PartialDelegateState,
  ): DelegateResult {
    if (request.signal?.aborted || run.deadlineHit)
      return partialDelegateResult(this.id, interruption(request.signal?.aborted), partial());
    const failed = failure(err);
    if (failed.kind === EngineFailureKind.Auth) this.forgetSignIn();
    if (failed.kind !== EngineFailureKind.Other) throw failed;
    return partialDelegateResult(this.id, { stopReason: StopReason.Error, errorText: failed.message }, partial());
  }
}

/**
 * What a failed turn was: the agent's own sign-in code, the kind Google's status names, or the
 * CLI's own words.
 */
export function failure(err: unknown): EngineError {
  if (err instanceof EngineError) return err;
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof AcpError && err.code === AcpErrorCode.AuthRequired)
    return new EngineError(EngineFailureKind.Auth, EngineId.Antigravity, MESSAGE.SignInFailed);
  // Only the agent's own error names a Google status: a CLI's exit carries its log, where a word
  // in capitals says nothing about the turn.
  const kind = err instanceof AcpError ? googleFailure(`${message} ${JSON.stringify(err.data ?? "")}`) : null;
  return new EngineError(kind ?? EngineFailureKind.Other, EngineId.Antigravity, message);
}

/** The failure kind a Google status name in the agent's words names, or null for none Genex reacts to. */
export function googleFailure(message: string): EngineFailureKind | null {
  for (const [status] of message.matchAll(GOOGLE_STATUS))
    if (Object.hasOwn(GOOGLE_FAILURES, status)) return GOOGLE_FAILURES[status] ?? null;
  return null;
}

/**
 * One turn over a started CLI: the handshake, the session, its model, the prompt, and every
 * update until the prompt is answered: the answer (the turn's ending and tokens) is what it gives.
 * A plan with no prompt ends once the session is open, with null. Throws the agent's `AcpError`, the CLI's exit (`AntigravityExit`) or the stall that ended it.
 */
export async function runTurn(
  agent: AntigravityProcess,
  plan: AntigravityTurnPlan,
  hooks: {
    onSession(session: AntigravitySession): void;
    onUpdate(update: Json): void;
    schedule: AntigravitySchedule;
  },
): Promise<Json | null> {
  const watch = turnWatch(agent, hooks.schedule);
  // A loaded session replays its history as updates before it answers: only the turn's own count.
  let live = false;
  const connection = new AcpConnection((line) => agent.send(line), {
    notification(method, params) {
      if (method !== AcpMethod.SessionUpdate) return;
      const update = record(params.update);
      watch.saw(update);
      if (live) hooks.onUpdate(update);
    },
    request: async (method, params) => {
      if (method === AcpMethod.RequestPermission) return antigravityPermission(params, plan.cwd, plan.neverTouch);
      throw new AcpError(AcpErrorCode.MethodNotFound, MESSAGE.NoSuchRequest(method));
    },
  });
  const reading = readLines(agent, connection, watch);
  let sessionId: string | undefined;
  const cancel = () => {
    if (sessionId && live) connection.tell(AcpMethod.SessionCancel, { sessionId });
    hooks.schedule(() => agent.stop(), sessionId && live ? ANTIGRAVITY_CANCEL_GRACE_MS : 0);
  };
  if (plan.signal.aborted) cancel();
  else plan.signal.addEventListener("abort", cancel, { once: true });
  watch.start();
  try {
    await connection.request(AcpMethod.Initialize, {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: ANTIGRAVITY_CLIENT,
    });
    const session = parseAntigravitySession(await connection.request(...sessionRequest(plan)), plan.resume);
    sessionId = session.sessionId;
    hooks.onSession(session);
    if (!plan.prompt.length) return null;
    if (plan.model) await connection.request(AcpMethod.SessionSetModel, { sessionId, modelId: plan.model });
    live = true;
    return record(await connection.request(AcpMethod.SessionPrompt, { sessionId, prompt: plan.prompt }));
  } catch (err) {
    throw watch.stalled() ?? err;
  } finally {
    plan.signal.removeEventListener("abort", cancel);
    watch.end();
    agent.end();
    connection.close();
    // A CLI that keeps its output open (it ignores its input closing, or something it started
    // holds the pipe) is stopped: nothing else is left that could end the wait.
    const unstopped = hooks.schedule(() => agent.stop(), ANTIGRAVITY_EXIT_GRACE_MS);
    await reading.catch(() => {});
    unstopped();
  }
}

/** The question that opens the turn's session: a new one in its folder, or an earlier one loaded. */
function sessionRequest(plan: AntigravityTurnPlan): [string, Json] {
  const where = { cwd: plan.cwd, mcpServers: [] };
  return plan.resume ? [AcpMethod.SessionLoad, { sessionId: plan.resume, ...where }] : [AcpMethod.SessionNew, where];
}

/** A list that names no folder: the sandbox fences folders, and the screen is left the keychain's tool. */
const NO_FOLDERS: NeverTouchList = { roots: [], open: [] };

/**
 * The agent asks before a tool runs. Inside the studio's sandbox the answer is yes, once (the
 * first option that allows), except for a command the never-touch screen stops: the Keychain's
 * files are readable in this sandbox, and macOS's keychain tool, which no file deny reaches, is
 * what reads another program's sign-in from them. Such a command, one the screen cannot read and
 * a command with no command line are refused. A question that offers no fitting option is left
 * unanswered-for (`cancelled`).
 */
export function antigravityPermission(params: Json, cwd: string, neverTouch: NeverTouchList = NO_FOLDERS): Json {
  const options = (Array.isArray(params.options) ? params.options : []).map(record);
  const offered = (...kinds: AcpPermissionKind[]) =>
    kinds.map((kind) => options.find((option) => option.kind === kind)).find((option) => option !== undefined);
  const pick = commandStopped(record(params.toolCall), cwd, neverTouch)
    ? offered(AcpPermissionKind.RejectOnce, AcpPermissionKind.RejectAlways)
    : offered(AcpPermissionKind.AllowOnce, AcpPermissionKind.AllowAlways);
  if (!pick) return { outcome: { outcome: "cancelled" } };
  return { outcome: { outcome: "selected", optionId: pick.optionId } };
}

/** Whether the call is a command the never-touch screen stops; a call that runs no command never is. */
function commandStopped(call: Json, cwd: string, neverTouch: NeverTouchList): boolean {
  if (call.kind !== AcpToolKind.Execute) return false;
  const command = text(record(call.rawInput).CommandLine);
  if (!command.trim()) return true;
  try {
    return neverTouchVerdict({ tool: SHELL_TOOL, input: { command } }, neverTouch, cwd, os.homedir()) !== null;
  } catch {
    // A command the screen cannot read is refused, as the worker hook refuses it.
    return true;
  }
}

/** Feed the CLI's lines to the connection; once it is gone, every open question fails with its exit. */
async function readLines(
  agent: AntigravityProcess,
  connection: AcpConnection,
  watch: ReturnType<typeof turnWatch>,
): Promise<void> {
  try {
    for await (const line of agent.lines) {
      watch.heard();
      connection.receive(line);
    }
  } finally {
    const { code, stderr } = await agent.exited.catch(() => ({ code: null, stderr: "" }));
    connection.close(new AntigravityExit(code, stderr));
  }
}

/**
 * The turn's watch: the silence it allows (longer while a tool call is open, which says nothing
 * until it ends) and the stall that ends it.
 */
function turnWatch(agent: Pick<AntigravityProcess, "stop">, schedule: AntigravitySchedule) {
  let cancel: () => void = () => {};
  let stalled: AntigravityStall | null = null;
  const open = new Set<string>();
  let over = false;
  const quiet = () => {
    cancel();
    if (over) return;
    const ms = open.size ? ANTIGRAVITY_TOOL_STALL_MS : ANTIGRAVITY_STALL_MS;
    cancel = schedule(() => {
      stalled = new AntigravityStall(ms);
      agent.stop();
    }, ms);
  };
  return {
    stalled: () => stalled,
    /** Anything the CLI printed: the clock starts again. */
    heard: quiet,
    /** One session update: a tool call opening or closing changes how long silence may last. */
    saw(update: Json): void {
      const id = text(update.toolCallId);
      const kind = update.sessionUpdate;
      if (!id || (kind !== AcpUpdate.ToolCall && kind !== AcpUpdate.ToolCallUpdate)) return;
      const over = update.status === AcpToolStatus.Completed || update.status === AcpToolStatus.Failed;
      if (over) open.delete(id);
      else open.add(id);
      quiet();
    },
    start: quiet,
    /** The turn is over: nothing it still prints starts the clock again. */
    end(): void {
      over = true;
      cancel();
    },
  };
}

/** The sandbox a session runs in: the folder it works in, Antigravity's own folders, and nothing it must not read. */
export function antigravitySandbox(input: {
  runDir: string;
  gameDir: string;
  gitDirs: string[];
  scratchDir: string;
  secretPaths: string[];
  toolPath?: () => Promise<string>;
}): SandboxOptions {
  return {
    writableRoots: [input.runDir, ...input.gitDirs],
    scratchDir: input.scratchDir,
    secretPaths: input.secretPaths,
    // Antigravity's settings and conversations, and where its sign-in is kept: its own in this sandbox alone.
    ownHome: antigravityHomes(),
    // The CLI is a Go program: on a Mac it verifies each HTTPS certificate through the system's
    // checker, and with that unreachable it cannot renew its sign-in and answers "sign in".
    machServices: [SandboxMachService.Trust],
    // A game's own Antigravity hooks, plugins and MCP servers are never the session's to plant, and
    // the Keychain's files are read, never written: a signed-in CLI works with them read-only.
    denyWrite: [path.join(input.gameDir, ".agents"), ...antigravityKeychain()],
    ...(input.toolPath ? { toolPath: input.toolPath } : {}),
  };
}

/** What a session's tools may do: a build edits; a read-only session, a lead while its build runs and Plan only look. */
function sessionAccess(request: DelegateRequest): AntigravityAccess {
  const readOnly = Boolean(request.readOnly);
  return readOnly || chatMode(request) === PermissionMode.Plan ? AntigravityAccess.ReadOnly : AntigravityAccess.Build;
}

/**
 * A session that builds for a chat the person set to Bypass (and confirmed): it runs as them,
 * outside the studio's sandbox, as Codex's and Grok Build's Bypass do. A read-only session of that
 * chat (a lead while its build runs) and unattended work keep the sandbox. The never-touch screen
 * still answers each command it asks about, as it does for Claude Code's Bypass.
 */
function runsAsPerson(request: DelegateRequest, access: AntigravityAccess): boolean {
  return access === AntigravityAccess.Build && chatMode(request) === PermissionMode.Bypass;
}

/** The chat's mode as Antigravity honours it (Auto, Plan or Bypass), or null for unattended work. */
function chatMode(request: DelegateRequest): PermissionMode | null {
  return request.permissions ? engineMode(EngineId.Antigravity, request.permissions.mode) : null;
}

/** A prompt as ACP content blocks: its words, then each picture as a picture (the agent takes images). */
function promptBlocks(words: string, images: readonly Pick<DelegateImage, "mimeType" | "data">[]): Json[] {
  const pictures = images
    .filter((image) => image?.data)
    .map((image) => ({ type: "image", mimeType: image.mimeType, data: image.data }));
  return [{ type: "text", text: words }, ...pictures];
}

/** A judge's question as one prompt: the system words, the conversation and the critic's two rules. */
function answerPrompt(request: CompleteRequest): string {
  const conversation = request.messages.map((message) => `${message.role.toUpperCase()}:\n${message.content}`);
  return [request.systemPrompt ?? "", ...conversation, ...JUDGE_RULES].filter((part) => part.trim()).join("\n\n");
}

function newRun(engine: string, resume: string | undefined): AntigravityRun {
  return {
    usage: { engine },
    turns: 0,
    summary: "",
    sessionId: resume,
    ending: undefined,
    deadlineHit: false,
    stream: antigravityStream(),
  };
}

/** The session opened: its id is what a resume continues, and the chat's first sign of life. */
function noteSession(request: Pick<DelegateRequest, "onEvent">, run: AntigravityRun, session: AntigravitySession) {
  run.sessionId = session.sessionId;
  request.onEvent?.({
    type: DelegateEventType.System,
    payload: { subtype: SESSION_OPENED, tools: 0, session_id: session.sessionId },
  });
  request.onEvent?.({
    type: DelegateEventType.Activity,
    payload: { phase: ChatActivityPhase.Thinking, engine: EngineId.Antigravity, sessionId: session.sessionId },
  });
}

/** One translated update: forwarded to the log, and folded into the run. */
function applyTranslated(
  request: Pick<DelegateRequest, "onEvent">,
  run: AntigravityRun,
  translated: AntigravityTranslated,
): void {
  const phase = translated.activity;
  if (phase)
    request.onEvent?.({
      type: DelegateEventType.Activity,
      payload: { phase, engine: EngineId.Antigravity, sessionId: run.sessionId },
    });
  if (translated.delta)
    request.onEvent?.({
      type: DelegateEventType.TextDelta,
      payload: { streamId: translated.delta.streamId, delta: translated.delta.text },
    });
  for (const event of translated.events) request.onEvent?.(event);
  if (translated.text) run.summary = translated.text;
  if (translated.turns) run.turns += translated.turns;
}

/**
 * The prompt's answer: how the agent ended the turn, and the tokens it used (its thoughts are
 * counted inside its output, as the recorded turn's total shows).
 */
function noteAnswer(run: AntigravityRun, answer: Json | null): void {
  const body = record(answer);
  run.ending = text(body.stopReason) || undefined;
  const used = record(body.usage);
  run.usage = {
    ...run.usage,
    input_tokens: count(used.inputTokens),
    output_tokens: count(used.outputTokens),
    cache_read_tokens: count(used.cachedReadTokens),
    cache_write_tokens: count(used.cachedWriteTokens),
    reasoning_tokens: count(used.thoughtTokens),
  };
}

/** What a run cut short had done. */
function partialState(
  run: AntigravityRun,
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
 * A session whose turn the agent ended, on the person's Google AI plan: its tokens are the plan's
 * quota, not a bill. A turn the model cut short (its length, its turn limit, a refusal) is an
 * outcome that says so, with the work it left.
 */
function ended(
  engine: string,
  run: AntigravityRun,
  startedAt: number,
  model: string | undefined,
  studioToolCalls: NonNullable<DelegateResult["studioToolCalls"]>,
): DelegateResult {
  const stopReason = TURN_ENDINGS[run.ending ?? ""] ?? StopReason.Completed;
  const ok = stopReason === StopReason.Completed;
  return {
    ok,
    summary: run.summary,
    usage: run.usage,
    turns: run.turns,
    billing: "subscription",
    engine,
    durationMs: Date.now() - startedAt,
    stopReason,
    ...(ok ? {} : { errorText: run.ending === AcpStopReason.Refusal ? MESSAGE.Refused : (run.ending ?? "") }),
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
async function defaultResolveCli(): Promise<AntigravityCli> {
  const installation = await resolveCodingCli(EngineId.Antigravity);
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
    if (answer)
      dirs.push(
        await realpath(path.resolve(cwd, answer.stdout.trim())).catch(() => path.resolve(cwd, answer.stdout.trim())),
      );
  }
  return [...new Set(dirs)];
}

/** Start `agy acp` inside the studio's sandbox, or as the person for their Bypass. */
async function startAntigravity(invocation: AntigravityInvocation): Promise<AntigravityProcess> {
  const installation = await resolveCodingCli(EngineId.Antigravity);
  const binary = installation.status.path;
  if (!binary) throw new EngineError(EngineFailureKind.Unavailable, EngineId.Antigravity, MESSAGE.NotInstalled);
  if (!invocation.sandbox) return antigravityOutside(binary, invocation, installation.env);
  const sandbox = await ProcessSandbox.create(invocation.sandbox);
  try {
    const env = childEnv(installation.env, { base: "contractor", vendor: "antigravity", set: invocation.env });
    return await antigravityProcess(sandbox, binary, { ...invocation, env: stringEnv(env) }, () =>
      sandbox.dispose().catch(() => {}),
    );
  } catch (err) {
    await sandbox.dispose().catch(() => {});
    throw err;
  }
}

/** An environment's set variables alone. */
function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (value !== undefined) out[key] = value;
  return out;
}

/**
 * Start `binary` with the invocation's argv in `sandbox`, its stdin kept open for the protocol
 * (through the sandbox's own input: on Windows srt-win does not pass stdin on). `gone` runs once
 * the process has exited.
 */
export async function antigravityProcess(
  sandbox: Pick<ProcessSandbox, "spawnLongLived">,
  binary: string,
  invocation: Omit<AntigravityInvocation, "sandbox">,
  gone: () => unknown = () => {},
): Promise<AntigravityProcess> {
  const command = [binary, ...invocation.argv].map(shellQuote).join(" ");
  const { child, input } = await sandbox.spawnLongLived({
    command,
    cwd: invocation.cwd,
    env: invocation.env,
    label: `antigravity:${path.basename(invocation.cwd)}`,
    policy: { allowedDomains: invocation.domains },
    liveInput: true,
  });
  return attached(child, input, gone);
}

/**
 * Start `binary` as the person, for a chat they set to Bypass: no sandbox, as Codex's and Grok
 * Build's Bypass, in their environment less every credential and other vendors' variables
 * (`childEnv`), the invocation's PATH under the one key `PATH`, in a process group of its own so a
 * stop takes everything it started.
 */
export function antigravityOutside(
  binary: string,
  invocation: Omit<AntigravityInvocation, "sandbox">,
  parent: Record<string, string | undefined>,
): AntigravityProcess {
  const env = childEnv(parent, { base: "contractor", vendor: "antigravity", set: invocation.env });
  const toolPath = invocation.env.PATH;
  const child = spawnCommand(binary, invocation.argv, {
    cwd: invocation.cwd,
    env: toolPath === undefined ? env : withEnvPath(env, toolPath),
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  if (!child.stdin) throw new EngineError(EngineFailureKind.Unavailable, EngineId.Antigravity, MESSAGE.NotInstalled);
  return attached(child, child.stdin, () => {});
}

/** A started CLI as the turn speaks to it: its lines, its input, its exit and its stop. */
function attached(child: ChildProcess, input: Writable, gone: () => unknown): AntigravityProcess {
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-STDERR_TAIL_CHARS);
  });
  // A CLI that exits before reading its input lands EPIPE here; its exit already says so.
  input.on("error", () => {});
  const exited = new Promise<{ code: number | null; stderr: string }>((resolve) => {
    child.once("error", () => resolve({ code: null, stderr }));
    child.once("close", (code) => {
      sweepGroup(child.pid);
      void gone();
      resolve({ code, stderr });
    });
  });
  let stopping = false;
  return {
    send: (line) => void input.write(`${line}\n`),
    lines: child.stdout ? createInterface({ input: child.stdout }) : (async function* none() {})(),
    exited,
    end: () => void input.end(),
    stop() {
      if (stopping) return;
      stopping = true;
      void stopTree(child, "SIGTERM");
      const kill = setTimeout(() => void stopTree(child, "SIGKILL"), KILL_GRACE_MS);
      kill.unref?.();
      void exited.then(() => clearTimeout(kill));
    },
  };
}

/** Stop a session and everything it started (its process group; on Windows its tree), unless it is gone already. */
async function stopTree(child: Pick<ChildProcess, "pid" | "exitCode" | "signalCode">, signal: NodeJS.Signals) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await killProcessTree(child.pid, { signal });
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
