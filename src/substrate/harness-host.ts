/**
 * Harness process supervision.
 *
 * One mechanism does three jobs, exactly as the plan intends: **restarting this process is
 * hot-reload of the agent's self-edits, is crash recovery, and is the guardian's "rebuild".**
 *
 *  - Boot: spawn the stable bootstrap (shipped in the app) inside the sandbox; it dynamically
 *    imports the *editable* harness from the workspace.
 *  - Self-modification: `guardian.rebuild_and_restart` writes a durable update record, snapshots
 *    the workspace, lets the current turn finish, then respawns. The outcome is appended to the
 *    log as a `custom` event so the reborn agent reads its own restart from its own state.
 *  - Failure: the watchdog (crash-loop or log silence) restores the newest *healthy* snapshot and
 *    restarts, appending `workspace_restored`.
 */
import type { ChildProcess } from "node:child_process";
import path from "node:path";
import { atomicWriteJson, ensureDir, listJsonFiles, readJson } from "./fsx.ts";
import { shortId } from "./ids.ts";
import { MINUTE_MS, SECOND_MS } from "../shared/duration.ts";
import { HostRefusal, harnessParamsProblem } from "../shared/harness-api.ts";
import {
  BootReason,
  DispatchActionType,
  HarnessState,
  LineCodec,
  encode,
  type BootNotice,
  type DispatchAction,
  type HarnessCapability,
  type HarnessToHost,
  type HostToHarness,
  type ReadyMessage,
  type RpcRequest,
  type RpcResponse,
} from "../shared/protocol.ts";
import { StudioPlatform } from "../shared/boot.ts";
import { type ProcessSandbox, killChild, shellQuote } from "./spawn.ts";
import { longPath } from "./windows-sandbox.ts";
import { HarnessInbox } from "./harness-inbox.ts";
import { rpcDeadlineMs } from "./rpc-deadlines.ts";

/** How long a freshly spawned harness has to send its ready message. */
const READY_TIMEOUT_MS = 20 * SECOND_MS;
/** How long `stop()` waits for the harness to exit before it kills the process tree. */
const STOP_GRACE_MS = 5 * SECOND_MS;
/** How long the healthcheck round-trip may take before the new self counts as unhealthy. */
const HEALTHCHECK_TIMEOUT_MS = 15 * SECOND_MS;
/** No heartbeat for this long (by default) ⇒ the harness is wedged. */
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 10 * MINUTE_MS;
/** The heartbeat monitor ticks about four times per timeout, within these bounds. */
const HEARTBEAT_TICKS_PER_TIMEOUT = 4;
const HEARTBEAT_TICK_MIN_MS = SECOND_MS;
const HEARTBEAT_TICK_MAX_MS = 30 * SECOND_MS;
/** A tick this many intervals late means the app itself was suspended. */
const SUSPENDED_TICK_FACTOR = 3;
/** Default crash-loop threshold: this many exits inside the window escalate to the watchdog. */
const DEFAULT_CRASH_LOOP = { count: 3, windowMs: 5 * MINUTE_MS } as const;
/** How much of a malformed protocol line the log keeps. */
const MALFORMED_LINE_PREVIEW_CHARS = 200;

const MESSAGE = {
  NotReady: "harness did not report ready within timeout",
  NotRunning: "harness is not running",
  Exited: "harness exited",
  DispatchFailed: "dispatch failed",
  ExitedDuringBoot: (code: number | null, signal: NodeJS.Signals | null) =>
    `harness exited during boot (code ${code}, signal ${signal})`,
  DispatchTimedOut: (type: string) => `dispatch ${type} timed out`,
  UnknownMethod: (method: string) => `unknown substrate method: ${method}`,
  RpcDeadline: (method: string, deadlineMs: number) =>
    `${method} took longer than ${Math.round(deadlineMs / SECOND_MS)} s; the host stopped waiting for it`,
  RpcDeadlineLog: (method: string, deadlineMs: number) =>
    `[host] ${method} took longer than ${deadlineMs} ms; answered the harness with RpcDeadline`,
} as const;

/** The error name and code a call answered by its deadline carries to the harness. */
const RPC_DEADLINE = { name: "RpcDeadline", code: "rpc_deadline" } as const;

type RpcError = NonNullable<RpcResponse["error"]>;

/** A host-call being serviced: what, since when, and the timer that answers it at its deadline. */
interface InFlightRpc {
  method: string;
  startedAt: number;
  timer?: NodeJS.Timeout;
}

interface PendingDispatch {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer?: NodeJS.Timeout;
}

/**
 * The structured detail a thrown error carries across the pipe: every own field but the stack,
 * the message and functions. The harness decides what to do about a rate limit (pause? fall
 * back?) and needs `kind`/`fallbacks`, not just a message.
 */
function errorData(error: Error & Record<string, unknown>): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const key of Object.keys(error)) {
    if (key === "stack" || key === "message") continue;
    const value = error[key];
    if (typeof value === "function") continue;
    data[key] = value;
  }
  return data;
}

export interface SubstrateApi {
  [method: string]: (params: never) => Promise<unknown> | unknown;
}

/** Where a self-update stands in its durable record. Persisted: never rename a value. */
export const UpdateStatus = {
  Queued: "queued",
  Applied: "applied",
  Failed: "failed",
} as const;
export type UpdateStatus = (typeof UpdateStatus)[keyof typeof UpdateStatus];

export interface UpdateRecord {
  id: string;
  status: UpdateStatus;
  reason: string;
  requested_at: string;
  snapshot_id?: string;
  applied_at?: string;
  error?: string;
}

export interface HarnessHostOptions {
  /** Directory of the agent-editable harness workspace. */
  workspace: string;
  /** Absolute path to the stable bootstrap shipped with the app. */
  bootstrap: string;
  /** Node-capable binary: `process.execPath` (Electron with ELECTRON_RUN_AS_NODE, or node). */
  execPath: string;
  /** Set for Electron: the binary must be told to behave as plain node. */
  runAsNode?: boolean;
  sandbox: ProcessSandbox;
  api: SubstrateApi;
  updatesDir: string;
  env?: Record<string, string>;
  onNotify?: (type: string, payload: unknown) => void;
  onLog?: (line: string, stream: "stdout" | "stderr") => void;
  onStateChange?: (state: HarnessState) => void;
  /** No heartbeat for this long ⇒ the harness is wedged. */
  heartbeatTimeoutMs?: number;
  /** Crash-loop threshold (default ≥3 in 5 min). */
  crashLoop?: { count: number; windowMs: number };
  /** Called when the harness dies repeatedly — the watchdog's escalation hook. */
  onCrashLoop?: (exits: ExitInfo[]) => Promise<void> | void;
  /**
   * The harness died on its own — nobody asked it to. Whoever owns the work it was supervising
   * gets to act *before* anything restarts (abort what it briefed, settle what it was holding),
   * and whatever it returns is folded into the notice the reborn self boots with. Awaited, so
   * keep it short: the restart waits on it.
   */
  onUnexpectedExit?: (info: ExitInfo) => Promise<Partial<BootNotice> | void> | Partial<BootNotice> | void;
  /** Called when the harness stops heart-beating while work is in flight. */
  onWedged?: (sinceMs: number) => Promise<void> | void;
  /** How long a call of `method` is serviced before the harness is answered `RpcDeadline`; null for no deadline (`rpc-deadlines.ts`). */
  rpcDeadlineMs?: (method: string) => number | null;
  now?: () => number;
  /** Test seam: the platform whose stop and launch rules apply (default: this one). */
  platform?: NodeJS.Platform;
}

export interface ExitInfo {
  at: number;
  code: number | null;
  signal: NodeJS.Signals | null;
  harnessVersion: string | null;
}

export { HarnessState };

export class HarnessHost {
  readonly options: HarnessHostOptions;
  #child: ChildProcess | null = null;
  #codec = new LineCodec();
  #state: HarnessState = HarnessState.Stopped;
  #nextDispatchId = 1;
  #pendingDispatch = new Map<number, PendingDispatch>();
  #readyWaiters: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];
  #exits: ExitInfo[] = [];
  #lastHeartbeat = 0;
  /**
   * Host-calls this process is currently servicing, by RPC id. A harness awaiting one (a
   * streaming completion, a long delegation) is working, not wedged, and the watchdog must not
   * rewind a healthy harness for that silence. A call with a deadline
   * leaves this set when its deadline answers it, so a hung page cannot mute the watchdog for good.
   */
  #inFlight = new Map<number, InFlightRpc>();
  /** Which spawned process a call belongs to: an answer for an exited one never reaches its successor. */
  #generation = 0;
  #lastStatus = "";
  /** Windows: the loopback channel the host speaks to the harness over (stdin does not reach it). */
  #inbox: HarnessInbox | null = null;
  #harnessVersion: string | null = null;
  /** What the loaded self said it can dispatch; [] until (and unless) a ready message says more. */
  #capabilities: string[] = [];
  #intentionalStop = false;
  /**
   * The caller of the current boot recovers it if it fails (a cold start, the watchdog's own
   * restart): the background crash restart would race it into the same broken self.
   */
  #callerRecovers = false;
  #heartbeatTimer: NodeJS.Timeout | null = null;
  #restarting: Promise<void> | null = null;

  constructor(options: HarnessHostOptions) {
    this.options = options;
  }

  get state(): HarnessState {
    return this.#state;
  }
  get pid(): number | undefined {
    return this.#child?.pid;
  }
  get harnessVersion(): string | null {
    return this.#harnessVersion;
  }
  get capabilities(): string[] {
    return [...this.#capabilities];
  }
  hasCapability(name: HarnessCapability): boolean {
    return this.#capabilities.includes(name);
  }
  get lastHeartbeat(): number {
    return this.#lastHeartbeat;
  }
  get lastStatus(): string {
    return this.#lastStatus;
  }
  get exits(): ExitInfo[] {
    return [...this.#exits];
  }

  #now(): number {
    return (this.options.now ?? Date.now)();
  }

  #setState(state: HarnessState): void {
    if (this.#state === state) return;
    this.#state = state;
    this.options.onStateChange?.(state);
  }

  // ── lifecycle ────────────────────────────────────────────────────────────────────────────
  /**
   * `callerRecovers`: a death before `ready` is only reported to this call — no background crash
   * restart — because the caller rewinds and retries itself.
   */
  async start(notice?: DispatchAction, options: { callerRecovers?: boolean } = {}): Promise<void> {
    if (this.#child) return;
    this.#setState(HarnessState.Starting);
    this.#intentionalStop = false;
    this.#callerRecovers = options.callerRecovers === true;
    // Capabilities belong to the self about to boot, not the one that just stopped — a restart
    // into a stale workspace must not inherit the previous copy's claims.
    this.#capabilities = [];
    this.#codec = new LineCodec((line, err) =>
      this.options.onLog?.(
        `[protocol] dropped malformed line (${err.message}): ${line.slice(0, MALFORMED_LINE_PREVIEW_CHARS)}`,
        "stderr",
      ),
    );

    const command = [
      this.options.runAsNode ? "export ELECTRON_RUN_AS_NODE=1;" : "",
      shellQuote(longPath(this.options.execPath, this.#platform)),
      shellQuote(longPath(this.options.bootstrap, this.#platform)),
    ]
      .filter(Boolean)
      .join(" ");

    this.#inbox?.close();
    this.#inbox = this.#platform === StudioPlatform.Windows ? await HarnessInbox.open() : null;
    const { child } = await this.options.sandbox.spawnLongLived({
      command,
      cwd: this.options.workspace,
      label: "harness-runtime",
      env: {
        // A launch path: the harness resolves its modules through it inside the sandbox, where an
        // 8.3 spelling (C:\Users\RUNNER~1\…) failed the walk with EPERM.
        HARNESS_WS: longPath(this.options.workspace, this.#platform),
        NODE_OPTIONS: "",
        ...this.#inbox?.env(),
        ...this.options.env,
      },
    });
    this.#child = child;
    this.#generation++;
    void this.#inbox?.connect(() => this.#child === child);

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      for (const message of this.#codec.push<HarnessToHost>(chunk)) void this.#onMessage(message);
    });
    let stderr = "";
    const emitStderr = (line: string) => {
      if (line.trim()) this.options.onLog?.(line.replace(/\r$/, ""), "stderr");
    };
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      const lines = chunk.split("\n");
      lines[0] = stderr + (lines[0] ?? "");
      stderr = lines.pop() ?? "";
      for (const line of lines) emitStderr(line);
    });
    child.stderr?.on("end", () => {
      emitStderr(stderr);
      stderr = "";
    });
    child.on("exit", (code, signal) => this.#onExit(code, signal));
    child.on("error", (err) => this.options.onLog?.(`[host] spawn error: ${err.message}`, "stderr"));
    // A write racing the child's death lands EPIPE on stdin's error event; unhandled, that is an
    // uncaughtException that can take down the whole process (it flaked the test suite for the
    // same reason). A dying child simply stops hearing us — that is already handled by #onExit.
    child.stdin?.on("error", (err) =>
      this.options.onLog?.(`[host] stdin write failed (child dying): ${err.message}`, "stderr"),
    );

    this.#lastHeartbeat = this.#now();
    this.#startHeartbeatMonitor();

    await this.#waitForReady();
    if (notice) await this.dispatch(notice);
  }

  async #waitForReady(timeoutMs = READY_TIMEOUT_MS): Promise<void> {
    if (this.#state === HarnessState.Ready) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(MESSAGE.NotReady));
      }, timeoutMs);
      this.#readyWaiters.push({
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
    });
  }

  /**
   * Ask the harness to stop; kill the tree if it does not. On Windows there is no SIGTERM (Node
   * turns it into TerminateProcess, a hard kill), so the shutdown message gets the whole grace.
   */
  async stop(graceMs = STOP_GRACE_MS): Promise<void> {
    if (!this.#child) return;
    this.#intentionalStop = true;
    this.#stopHeartbeatMonitor();
    const child = this.#child;
    this.#send({ kind: "shutdown", graceMs });
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    const timer = setTimeout(() => killChild(child, this.#platform), graceMs);
    try {
      if (this.#platform !== StudioPlatform.Windows) child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
    await exited;
    clearTimeout(timer);
    this.#child = null;
    this.#setState(HarnessState.Stopped);
  }

  /**
   * The last resort on quit: SIGKILL the harness's whole process group now, without waiting. The
   * harness is spawned detached, so the app's own exit would leave it and its sandboxed children
   * running. No restart follows: this counts as an intentional stop.
   */
  kill(): void {
    const child = this.#child;
    if (!child) return;
    this.#intentionalStop = true;
    this.#stopHeartbeatMonitor();
    killChild(child, this.#platform);
  }

  get #platform(): NodeJS.Platform {
    return this.options.platform ?? process.platform;
  }

  /**
   * Restart = load whatever the harness workspace now contains. This is the *only* code path for
   * applying a self-edit, which is why a broken edit is always recoverable: the new self either
   * reports ready or the watchdog rewinds the workspace and restarts again.
   */
  async restart(notice?: DispatchAction, options: { callerRecovers?: boolean } = {}): Promise<void> {
    if (this.#restarting) return this.#restarting;
    this.#restarting = (async () => {
      this.#setState(HarnessState.Restarting);
      await this.stop();
      await this.start(notice, options);
    })().finally(() => {
      this.#restarting = null;
    });
    return this.#restarting;
  }

  // ── messaging ────────────────────────────────────────────────────────────────────────────
  #send(message: HostToHarness): void {
    if (this.#inbox) {
      if (this.#child) this.#inbox.write(encode(message));
      return;
    }
    if (!this.#child?.stdin?.writable) return;
    this.#child.stdin.write(encode(message));
  }

  /**
   * Send work to the harness and await its acknowledgement. Most dispatches answer nothing;
   * a `director_tool` answers with the tool's result.
   */
  async dispatch(action: DispatchAction, timeoutMs = 0): Promise<unknown> {
    if (!this.#child) throw new Error(MESSAGE.NotRunning);
    const id = this.#nextDispatchId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      const pending: PendingDispatch = { resolve, reject };
      this.#pendingDispatch.set(id, pending);
      if (timeoutMs > 0) {
        // Cleared when the answer arrives: a long tool timeout (the director's, eleven minutes)
        // must not keep the process alive after the tool has answered.
        pending.timer = setTimeout(() => {
          if (this.#pendingDispatch.delete(id)) reject(new Error(MESSAGE.DispatchTimedOut(action.type)));
        }, timeoutMs);
        pending.timer.unref?.();
      }
    });
    this.#send({ kind: "dispatch", id, action });
    return promise;
  }

  /** Trivial round-trip proving the newly booted self can actually run a turn. */
  async healthcheck(timeoutMs = HEALTHCHECK_TIMEOUT_MS): Promise<boolean> {
    try {
      await this.dispatch({ type: DispatchActionType.Healthcheck }, timeoutMs);
      return true;
    } catch {
      return false;
    }
  }

  async #onMessage(message: HarnessToHost): Promise<void> {
    switch (message.kind) {
      case "ready": {
        this.#onReady(message);
        return;
      }
      case "heartbeat": {
        this.#lastHeartbeat = this.#now();
        if (message.status) this.#lastStatus = message.status;
        return;
      }
      case "notify": {
        this.options.onNotify?.(message.type, message.payload);
        return;
      }
      case "dispatch-result": {
        const pending = this.#pendingDispatch.get(message.id);
        if (!pending) return;
        this.#pendingDispatch.delete(message.id);
        if (pending.timer) clearTimeout(pending.timer);
        if (message.ok) pending.resolve(message.value ?? null);
        else pending.reject(new Error(message.error ?? MESSAGE.DispatchFailed));
        return;
      }
      case "rpc": {
        await this.#serveRpc(message);
        return;
      }
    }
  }

  #onReady(message: ReadyMessage): void {
    this.#harnessVersion = message.harnessVersion;
    // An old bootstrap (or an old harness under the shipped bootstrap) sends no list; [] is
    // that absence made explicit, and it is a signal, not a default to paper over.
    this.#capabilities = Array.isArray(message.capabilities)
      ? message.capabilities.filter((c) => typeof c === "string")
      : [];
    this.#lastHeartbeat = this.#now();
    // Booted: from here on a death is an ordinary crash, restarted in the background.
    this.#callerRecovers = false;
    this.#setState(HarnessState.Ready);
    const waiters = this.#readyWaiters;
    this.#readyWaiters = [];
    for (const waiter of waiters) waiter.resolve();
  }

  /** Answer one host-call: refuse an unknown method or bad params, else run its handler. */
  async #serveRpc(message: RpcRequest): Promise<void> {
    // An inbound host-call is proof of life, whatever the heartbeat timer is doing.
    this.#lastHeartbeat = this.#now();
    const handler = this.options.api[message.method];
    if (!handler) {
      this.#refuseRpc(message.id, { message: MESSAGE.UnknownMethod(message.method), name: HostRefusal.UnknownMethod });
      return;
    }
    // A path-bearing method whose params are the wrong shape never reaches its handler: the
    // harness is agent-editable, and a folder name or a path must at least be a string before
    // the handler's own realpath checks see it.
    const refused = harnessParamsProblem(message.method, message.params);
    if (refused) {
      this.#refuseRpc(message.id, {
        message: refused.message,
        name: HostRefusal.InvalidParams,
        data: { method: refused.method, issues: refused.issues },
      });
      return;
    }
    const generation = this.#generation;
    const call = this.#track(message.id, message.method);
    try {
      const value = await handler(message.params as never);
      if (this.#settle(message.id, call, generation))
        this.#send({ kind: "rpc-result", id: message.id, ok: true, value: value ?? null });
    } catch (err) {
      if (!this.#settle(message.id, call, generation)) return;
      const error = err as Error & Record<string, unknown>;
      // Structured detail travels with the error (see `errorData`).
      this.#refuseRpc(message.id, {
        message: error.message,
        name: error.name,
        stack: error.stack,
        data: errorData(error),
      });
    }
  }

  /** Count a call as in flight, and answer it with `RpcDeadline` if its class's deadline passes first. */
  #track(id: number, method: string): InFlightRpc {
    const call: InFlightRpc = { method, startedAt: this.#now() };
    this.#inFlight.set(id, call);
    const deadlineMs = (this.options.rpcDeadlineMs ?? rpcDeadlineMs)(method);
    if (deadlineMs !== null && deadlineMs > 0) {
      call.timer = setTimeout(() => this.#expire(id, call, deadlineMs), deadlineMs);
      call.timer.unref?.();
    }
    return call;
  }

  /**
   * The call ended: it leaves the in-flight set, and the harness gets a fresh silence window to
   * resume its own drumbeat. False when there is no one to answer: its deadline already did, or
   * the process that asked has exited (a new one reuses its RPC ids).
   */
  #settle(id: number, call: InFlightRpc, generation: number): boolean {
    if (this.#inFlight.get(id) !== call) return false;
    this.#inFlight.delete(id);
    if (call.timer) clearTimeout(call.timer);
    this.#lastHeartbeat = this.#now();
    return generation === this.#generation;
  }

  #expire(id: number, call: InFlightRpc, deadlineMs: number): void {
    if (this.#inFlight.get(id) !== call) return;
    this.#inFlight.delete(id);
    this.#lastHeartbeat = this.#now();
    this.options.onLog?.(MESSAGE.RpcDeadlineLog(call.method, deadlineMs), "stderr");
    this.#refuseRpc(id, {
      message: MESSAGE.RpcDeadline(call.method, deadlineMs),
      name: RPC_DEADLINE.name,
      data: { code: RPC_DEADLINE.code, method: call.method, deadlineMs },
    });
  }

  /** The host-calls being serviced now, oldest first, with how long each has run. */
  pendingRpcs(): Array<{ method: string; ageMs: number }> {
    const now = this.#now();
    return [...this.#inFlight.values()]
      .sort((a, b) => a.startedAt - b.startedAt)
      .map((call) => ({ method: call.method, ageMs: now - call.startedAt }));
  }

  #refuseRpc(id: number, error: RpcError): void {
    this.#send({ kind: "rpc-result", id, ok: false, error });
  }

  #onExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.#stopHeartbeatMonitor();
    this.#child = null;
    // Nobody is awaiting these any more; left counted, they would mute the next self's watchdog.
    for (const call of this.#inFlight.values()) if (call.timer) clearTimeout(call.timer);
    this.#inFlight.clear();
    this.#inbox?.close();
    this.#inbox = null;
    const info: ExitInfo = { at: this.#now(), code, signal, harnessVersion: this.#harnessVersion };
    const waiters = this.#readyWaiters;
    this.#readyWaiters = [];
    for (const waiter of waiters) waiter.reject(new Error(MESSAGE.ExitedDuringBoot(code, signal)));
    for (const [, pending] of this.#pendingDispatch) pending.reject(new Error(MESSAGE.Exited));
    this.#pendingDispatch.clear();

    if (this.#intentionalStop) {
      this.#setState(HarnessState.Stopped);
      return;
    }
    if (this.#callerRecovers) {
      // The boot's caller got the rejection above and owns the rewind and the retry.
      this.#callerRecovers = false;
      this.#setState(HarnessState.Failed);
      return;
    }

    this.#exits.push(info);
    this.#setState(HarnessState.Failed);
    // Recovery runs in the background; a failure here must never become an unhandled rejection
    // (in the app that would take down the substrate — the one process that must survive).
    void this.#recoverFromDeath(info).catch((err: Error) =>
      this.options.onLog?.(`[host] auto-restart failed: ${err.message}`, "stderr"),
    );
  }

  /**
   * A death nobody asked for. The owner of the work this process was supervising acts first —
   * the contractors it briefed cannot be judged or committed by a loop that no longer exists —
   * and what it says about that work rides along in the notice the next self boots with.
   */
  async #recoverFromDeath(info: ExitInfo): Promise<void> {
    const extras =
      (await Promise.resolve(this.options.onUnexpectedExit?.(info)).catch((err: Error) => {
        this.options.onLog?.(`[host] exit handler failed: ${err.message}`, "stderr");
        return undefined;
      })) ?? {};
    const { count, windowMs } = this.options.crashLoop ?? DEFAULT_CRASH_LOOP;
    const recent = this.#exits.filter((exit) => info.at - exit.at <= windowMs);
    if (recent.length >= count) {
      this.#exits = [];
      await Promise.resolve(this.options.onCrashLoop?.(recent)).catch((err: Error) =>
        this.options.onLog?.(`[host] crash-loop handler failed: ${err.message}`, "stderr"),
      );
      return;
    }
    await this.restart({
      type: DispatchActionType.BootNotice,
      notice: { reason: BootReason.CrashRestart, detail: `exit code ${info.code}`, ...extras },
    });
  }

  // ── liveness ─────────────────────────────────────────────────────────────────────────────
  #startHeartbeatMonitor(): void {
    const timeout = this.options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
    const every = Math.max(
      HEARTBEAT_TICK_MIN_MS,
      Math.min(timeout / HEARTBEAT_TICKS_PER_TIMEOUT, HEARTBEAT_TICK_MAX_MS),
    );
    this.#stopHeartbeatMonitor();
    let lastTick = this.#now();
    this.#heartbeatTimer = setInterval(() => {
      const now = this.#now();
      // A tick this late means the app itself was suspended — the Mac slept, or App Nap held
      // its timers — and the harness's heartbeats were held back just as long. That gap is
      // nobody's silence, never "stopped responding for ~930s" and a rewound harness.
      if (now - lastTick > every * SUSPENDED_TICK_FACTOR) this.#lastHeartbeat = now;
      lastTick = now;
      // A host-call being serviced means the harness is awaiting *us* — its silence is our
      // latency, bounded by the engines' own finite timeouts, and must not read as a wedge.
      if (this.#inFlight.size > 0) return;
      const silence = now - this.#lastHeartbeat;
      if (silence > timeout) {
        this.#stopHeartbeatMonitor();
        void Promise.resolve(this.options.onWedged?.(silence)).catch((err: Error) =>
          this.options.onLog?.(`[host] wedge handler failed: ${err.message}`, "stderr"),
        );
      }
    }, every);
    this.#heartbeatTimer.unref?.();
  }

  #stopHeartbeatMonitor(): void {
    if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
    this.#heartbeatTimer = null;
  }

  /** Reset crash bookkeeping after a successful recovery. */
  clearExits(): void {
    this.#exits = [];
  }
}

// ── durable update records (guardian) ──────────────────────────────────────────────────────
/**
 * The guardian's durability trick, ported from Exo: the intent to restart is written to disk
 * *before* anything is torn down, so a crash in the middle of a self-update is still legible
 * afterwards — the record says "queued", and the reborn agent (or the watchdog) can see it.
 */
export class UpdateJournal {
  readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
  }

  async queue(reason: string, snapshotId?: string): Promise<UpdateRecord> {
    const record: UpdateRecord = {
      id: shortId("upd"),
      status: UpdateStatus.Queued,
      reason,
      requested_at: new Date().toISOString(),
      ...(snapshotId ? { snapshot_id: snapshotId } : {}),
    };
    await ensureDir(this.dir);
    await atomicWriteJson(path.join(this.dir, `${record.id}.json`), record);
    return record;
  }

  async complete(
    id: string,
    status: Exclude<UpdateStatus, typeof UpdateStatus.Queued>,
    error?: string,
  ): Promise<UpdateRecord | null> {
    const file = path.join(this.dir, `${id}.json`);
    const record = await readJson<UpdateRecord>(file).catch(() => null);
    if (!record) return null;
    record.status = status;
    record.applied_at = new Date().toISOString();
    if (error) record.error = error;
    await atomicWriteJson(file, record);
    return record;
  }

  async pending(): Promise<UpdateRecord[]> {
    const out: UpdateRecord[] = [];
    for (const file of await listJsonFiles(this.dir)) {
      const record = await readJson<UpdateRecord>(path.join(this.dir, file)).catch(() => null);
      if (record?.status === UpdateStatus.Queued) out.push(record);
    }
    return out;
  }
}
