import { InstallPhase, type ModelInstallJob } from "../../shared/model-install.ts";
import { atomicWriteJson, pathExists, readJsonIfExists } from "../fsx.ts";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { mkdir, readFile, writeFile, readdir, rm, rename, stat, statfs } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import os from "node:os";
import { createWriteStream } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import {
  BONSAI_BINARY,
  BONSAI_MODELS,
  BONSAI_PROJECTOR,
  BONSAI_RUNTIME,
  BONSAI_NOTICES,
  bonsaiModel,
  type DownloadFile,
} from "./manifest.ts";
import { download, DownloadStatus, type DownloadProgress } from "./download.ts";
import { errorMessage } from "../../shared/errors.ts";
import { MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";
import { setTimeout as delay } from "node:timers/promises";

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
/** Hosts with at least this much memory get the large working window. */
const LARGE_HOST_MEMORY_BYTES = 32 * GIB;
const LARGE_CONTEXT_TOKENS = 102400;
const SMALL_CONTEXT_TOKENS = 16384;
const MIN_MEMORY_BYTES = 16 * GIB;
/** Temporary extraction needs several times the runtime archive, plus a fixed reserve. */
const EXTRACTION_EXPANSION_FACTOR = 8;
const DISK_RESERVE_BYTES = 512 * MIB;
const TAR_LIST_TIMEOUT_MS = 30 * SECOND_MS;
const TAR_EXTRACT_TIMEOUT_MS = 2 * MINUTE_MS;
const STARTUP_TIMEOUT_MS = 3 * MINUTE_MS;
const HEALTH_PROBE_TIMEOUT_MS = SECOND_MS;
const HEALTH_POLL_MS = 200;
const STDERR_TAIL_CHARS = 6000;
const RUNTIME_LOG_MAX_BYTES = 4 * MIB;
const STOP_GRACE_MS = 3 * SECOND_MS;
/** How deep under the runtime folder the `llama-server` binary may sit. */
const BINARY_SEARCH_DEPTH = 3;
const LOOPBACK_HOST = "127.0.0.1";
const JOB_FILE = "install-job.json";

const MESSAGE = {
  Interrupted: "Studio closed before this operation finished. Resume verifies existing bytes before continuing.",
  StatusUnreadable: "Cannot read model installation status.",
  AnotherInstall: "Another model installation is running.",
  NeedsAppleSilicon: "Bonsai currently requires an Apple Silicon Mac",
  AnotherDownload: "Another Bonsai download is running",
  NeedsMemory: "Bonsai requires at least 16 GiB of memory.",
  NotEnoughSpace: (required: number, available: number) =>
    `Not enough space: ${required} bytes needed for remaining downloads, temporary extraction and reserve; ${available} available.`,
  UnsafeArchive: "Unsafe runtime archive",
  DownloadCancelled: "Download cancelled. Verified files and resumable partials are retained.",
  RuntimeClosed: "Bonsai runtime is closed",
  StartupCancelled: "Bonsai startup cancelled",
  NotDownloaded: "Download this Bonsai model in Model setup first",
  RemoveWhileDownloading: "A model is downloading. Delete this one when the download finishes.",
  RemoveWhileAnswering: "Bonsai is answering a chat or build. Delete the model when it finishes.",
  StoppedDuringStartup: (stderr: string) => `Bonsai stopped during startup: ${stderr}`,
  StartupTimedOut: (stderr: string) => `Bonsai startup timed out: ${stderr}`,
} as const;

/** The llama-server flags Studio pins for Bonsai, after the per-launch model, port and context. */
const LLAMA_SERVER_TUNING = [
  "--parallel",
  "1",
  "--cache-ram",
  "0",
  "--batch-size",
  "256",
  "--ubatch-size",
  "256",
  "--jinja",
  "--n-gpu-layers",
  "99",
  "--flash-attn",
  "on",
  "--reasoning-budget",
  "-1",
  "--no-webui",
  "--cors-origins",
  `http://${LOOPBACK_HOST}`,
] as const;

/** The install phase a download progress report puts the job in. */
const INSTALL_PHASE_FOR_DOWNLOAD: Record<DownloadStatus, InstallPhase> = {
  [DownloadStatus.Downloading]: InstallPhase.Downloading,
  [DownloadStatus.Verifying]: InstallPhase.Verifying,
  [DownloadStatus.Verified]: InstallPhase.Verifying,
  [DownloadStatus.Success]: InstallPhase.Installed,
};

const exec = promisify(execFile);

/** Whether a Mac can run Bonsai, and how much memory it has. */
export interface Machine {
  appleSilicon: boolean;
  memoryBytes: number;
}

/**
 * A server no request has held for this long is stopped: it keeps the weights, projector and KV
 * cache in memory (about 10 GB on a 16 GB Mac) beside game previews. The next request reloads it.
 */
export const IDLE_STOP_MS = 5 * MINUTE_MS;

export interface BonsaiRuntimeOptions {
  /** Fetches and verifies one pinned file. Injected in tests so no suite downloads gigabytes. */
  download?: typeof download;
  /** The host's facts. Injected in tests so the install path runs on any CI host. */
  machine?: Machine;
  /** How long the server may run with no inference lease before it is stopped. */
  idleStopMs?: number;
  /** The clock the idle stop runs on; answers a cancel. Injected in tests. */
  schedule?: (run: () => void, ms: number) => () => void;
}

const thisMachine = (): Machine => ({
  appleSilicon: process.platform === "darwin" && process.arch === "arm64",
  memoryBytes: os.totalmem(),
});

function scheduleUnref(run: () => void, ms: number): () => void {
  const timer = setTimeout(run, ms);
  timer.unref();
  return () => clearTimeout(timer);
}

const totalBytes = (files: DownloadFile[]) => files.reduce((sum, f) => sum + f.bytes, 0);
const hasExited = (child: ChildProcess) => child.exitCode !== null || Boolean(child.signalCode);
const availableBytes = (disk: { bavail: number; bsize: number }) => disk.bavail * disk.bsize;

/** Ask the server to exit, force it after the grace period, and settle once it has. */
function terminate(child: ChildProcess): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, STOP_GRACE_MS);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

// Reserve headroom on smaller Macs; 32 GiB+ hosts use a 100 Ki-token working window.
// Shared context management must consume this configured capacity (also exposed by engine.models),
// not substitute the model's 262144-token training maximum. Capacity changes need native memory
// and long-prompt checks; see docs/local-models.md#future-context-manager-integration.
export const bonsaiContextWindow = (memoryBytes = os.totalmem()): number =>
  memoryBytes >= LARGE_HOST_MEMORY_BYTES ? LARGE_CONTEXT_TOKENS : SMALL_CONTEXT_TOKENS;

/** What a starting llama-server has said so far: the tail of stderr and any spawn error. */
interface ServerOutput {
  stderr: string;
  failure: Error | null;
}

/** Tail the server's stderr in memory and copy its first bytes to `logFile`. */
function watchServerOutput(child: ChildProcess, logFile: string): ServerOutput {
  const output: ServerOutput = { stderr: "", failure: null };
  const log = createWriteStream(logFile, { flags: "w", mode: 0o600 });
  log.on("error", () => {});
  let loggedBytes = 0;
  child.once("close", () => log.end());
  child.stderr?.on("data", (chunk) => {
    output.stderr = (output.stderr + String(chunk)).slice(-STDERR_TAIL_CHARS);
    if (loggedBytes < RUNTIME_LOG_MAX_BYTES) {
      log.write(chunk);
      loggedBytes += chunk.length;
    }
  });
  child.on("error", (err) => {
    output.failure = err;
  });
  return output;
}

/** A free loopback port: bind port 0, read what the OS chose, release it. */
async function freeLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, LOOPBACK_HOST, resolve);
  });
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  return port;
}

/** Find `llama-server` at most `depth` folders below `dir`. */
async function findServerBinary(dir: string, depth: number): Promise<string | null> {
  for (const item of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (item.isFile() && item.name === "llama-server") return path.join(dir, item.name);
    if (!item.isDirectory() || depth <= 0) continue;
    const found = await findServerBinary(path.join(dir, item.name), depth - 1);
    if (found) return found;
  }
  return null;
}

const isUnsafeArchiveEntry = (name: string) => name.startsWith("/") || name.split("/").includes("..");

/** One model's launch in flight, shared by everyone waiting on that model. */
interface Starting {
  id: string;
  promise: Promise<string>;
  abort: AbortController;
  waiters: number;
}

/** Another model's launch, or a cancelled one, has to settle before a start for `id` begins. */
const startBlocks = (starting: Starting, id: string) => starting.id !== id || starting.abort.signal.aborted;

export class BonsaiRuntime {
  readonly root: string;
  readonly contextWindow: number;
  readonly #machine: Machine;
  readonly #download: typeof download;
  readonly #idleStopMs: number;
  readonly #schedule: (run: () => void, ms: number) => () => void;
  /** Requests using the server now; a held server is never stopped for being idle. */
  #leases = 0;
  #cancelIdleStop: (() => void) | null = null;
  /** The last stopped server's exit. A launch waits for it, so two copies never hold memory at once. */
  #exited: Promise<void> = Promise.resolve();
  #child: ChildProcess | null = null;
  #host: string | null = null;
  #model: string | null = null;
  #install: AbortController | null = null;
  #disposed = false;
  #starting: Starting | null = null;
  #installPromise: Promise<void> | null = null;
  #job: ModelInstallJob | null = null;
  #jobWrites: Promise<unknown> = Promise.resolve();
  #listeners = new Set<(job: ModelInstallJob) => void>();
  onInstall(listener: (job: ModelInstallJob) => void) {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
  get #jobFile(): string {
    return path.join(this.root, JOB_FILE);
  }
  #receiptFile(id: string): string {
    return path.join(this.root, `${id.replaceAll(":", "-")}.json`);
  }
  /** The runtime archive waits in `downloads`; weights and notices live in `models`. */
  #directoryFor(file: DownloadFile): string {
    return path.join(this.root, file === BONSAI_BINARY ? "downloads" : "models");
  }
  async installStatus(): Promise<ModelInstallJob | null> {
    if (this.#job) return { ...this.#job };
    let job: ModelInstallJob | null;
    try {
      job = await readJsonIfExists<ModelInstallJob>(this.#jobFile);
    } catch {
      throw new Error(MESSAGE.StatusUnreadable);
    }
    if (!job) return null;
    if (job.active) {
      job.active = false;
      job.phase = InstallPhase.Interrupted;
      job.error = MESSAGE.Interrupted;
    }
    this.#job = job;
    return { ...job };
  }
  async #updateJob(patch: Partial<ModelInstallJob>) {
    if (!this.#job) return;
    this.#job = { ...this.#job, ...patch, updatedAt: new Date().toISOString() };
    const snapshot = { ...this.#job };
    const write = this.#jobWrites.then(() => atomicWriteJson(this.#jobFile, snapshot));
    this.#jobWrites = write.catch(() => {});
    await write;
    for (const listener of this.#listeners) listener(snapshot);
  }
  #key = randomBytes(32).toString("hex");
  get processId(): number | null {
    return this.#child?.pid ?? null;
  }
  get authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.#key}` };
  }
  constructor(root: string, options: BonsaiRuntimeOptions = {}) {
    this.root = root;
    this.#machine = options.machine ?? thisMachine();
    this.#download = options.download ?? download;
    this.#idleStopMs = options.idleStopMs ?? IDLE_STOP_MS;
    this.#schedule = options.schedule ?? scheduleUnref;
    this.contextWindow = bonsaiContextWindow(this.#machine.memoryBytes);
  }
  /**
   * Keep the server loaded while one inference request uses it; call the returned release when it
   * ends. Once nothing has held it for the idle period it stops, and the next `start` reloads it.
   */
  hold(): () => void {
    this.#leases++;
    this.#disarmIdleStop();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#leases--;
      this.#armIdleStop();
    };
  }
  #armIdleStop(): void {
    this.#disarmIdleStop();
    if (this.#leases || !this.#child) return;
    this.#cancelIdleStop = this.#schedule(() => void this.#stopUnused(), this.#idleStopMs);
  }
  #disarmIdleStop(): void {
    this.#cancelIdleStop?.();
    this.#cancelIdleStop = null;
  }
  /** Stop the server unless a request holds it or a launch is under way; a holder re-arms the idle stop. */
  async #stopUnused(): Promise<void> {
    if (this.#leases || this.#starting) return;
    await this.#stopProcess();
  }
  async installed(id: string): Promise<boolean> {
    const spec = bonsaiModel(id);
    try {
      const receipt = JSON.parse(await readFile(this.#receiptFile(id), "utf8"));
      return (
        receipt.runtime === BONSAI_RUNTIME &&
        receipt.sha256 === spec.file.sha256 &&
        (await stat(path.join(this.root, "models", spec.file.name))).size === spec.file.bytes &&
        (await stat(path.join(this.root, "models", BONSAI_PROJECTOR.name))).size === BONSAI_PROJECTOR.bytes &&
        Boolean(await this.binary())
      );
    } catch {
      return false;
    }
  }
  async binary(): Promise<string | null> {
    return findServerBinary(path.join(this.root, BONSAI_RUNTIME), BINARY_SEARCH_DEPTH);
  }
  cancelInstall() {
    this.#install?.abort();
  }
  /**
   * Delete a downloaded model: its receipt first, so nothing starts it again, then its server and
   * weights. The projector, notices and runtime it shares go too once no other model keeps bytes
   * here. Refused, removing nothing, while a download runs or a request holds the server.
   */
  async remove(id: string): Promise<void> {
    const spec = bonsaiModel(id);
    if (this.#installPromise) throw new Error(MESSAGE.RemoveWhileDownloading);
    if (this.#leases || this.#starting) throw new Error(MESSAGE.RemoveWhileAnswering);
    await rm(this.#receiptFile(id), { force: true });
    if (this.#model === id) await this.#stopProcess();
    await this.#removeDownload(spec.file);
    await this.#forgetJob(id);
    if (await this.#othersKeepBytes(id)) return;
    for (const file of [BONSAI_BINARY, ...BONSAI_NOTICES, BONSAI_PROJECTOR]) await this.#removeDownload(file);
    for (const folder of [BONSAI_RUNTIME, `${BONSAI_RUNTIME}.staging`])
      await rm(path.join(this.root, folder), { recursive: true, force: true });
  }
  /** A pinned file and its resumable partial. */
  async #removeDownload(file: DownloadFile): Promise<void> {
    const target = path.join(this.#directoryFor(file), file.name);
    await rm(target, { force: true });
    await rm(`${target}.part`, { force: true });
  }
  /** Whether another model still has a receipt, weights or a partial download here. */
  async #othersKeepBytes(id: string): Promise<boolean> {
    for (const other of BONSAI_MODELS) {
      if (other.id === id) continue;
      const weights = path.join(this.#directoryFor(other.file), other.file.name);
      for (const file of [this.#receiptFile(other.id), weights, `${weights}.part`])
        if (await pathExists(file)) return true;
    }
    return false;
  }
  /** The download record of a deleted model goes with it; another model's stopped download stays. */
  async #forgetJob(id: string): Promise<void> {
    const job = await this.installStatus().catch(() => null);
    if (job?.model !== id) return;
    this.#job = null;
    await this.#jobWrites;
    await rm(this.#jobFile, { force: true });
  }
  install(id: string, progress: (p: DownloadProgress) => void): Promise<void> {
    if (this.#installPromise) {
      if (this.#job?.model !== id) return Promise.reject(new Error(MESSAGE.AnotherInstall));
      return this.#installPromise;
    }
    this.#installPromise = this.#performInstall(id, progress).finally(() => {
      this.#installPromise = null;
    });
    return this.#installPromise;
  }
  async #performInstall(id: string, progress: (p: DownloadProgress) => void): Promise<void> {
    if (!this.#machine.appleSilicon) throw new Error(MESSAGE.NeedsAppleSilicon);
    if (this.#install) throw new Error(MESSAGE.AnotherDownload);
    const controller = new AbortController();
    this.#install = controller;
    try {
      const model = bonsaiModel(id);
      const files = [BONSAI_BINARY, ...BONSAI_NOTICES, model.file, BONSAI_PROJECTOR];
      const total = totalBytes(files);
      await this.#preflight(id, files, total);
      await this.#downloadAll(files, total, controller.signal, progress);
      controller.signal.throwIfAborted();
      await writeFile(
        this.#receiptFile(id),
        JSON.stringify({ runtime: BONSAI_RUNTIME, sha256: model.file.sha256, installedAt: new Date().toISOString() }),
      );
      await this.#updateJob({ phase: InstallPhase.Installed, completed: total });
      await this.#updateJob({ phase: InstallPhase.Starting });
      // Ready means the server passed its native health check; it is not kept loaded. Until a
      // request needs it, it would only hold the weights, projector and KV cache (about 10 GB on
      // a 16 GB Mac). The first request starts it again.
      await this.start(id, controller.signal);
      await this.#stopUnused();
      await this.#updateJob({ phase: InstallPhase.Ready, active: false });
      progress({ status: DownloadStatus.Success, completed: total, total });
    } catch (err) {
      const cancelled = controller.signal.aborted;
      await this.#updateJob({
        phase: cancelled ? InstallPhase.Cancelled : InstallPhase.Failed,
        error: cancelled ? MESSAGE.DownloadCancelled : errorMessage(err),
        active: false,
      });
      throw err;
    } finally {
      this.#install = null;
    }
  }
  /** Bytes still to fetch: a complete file costs nothing, a partial one only its missing tail. */
  async #remainingBytes(files: DownloadFile[]): Promise<number> {
    let remaining = 0;
    for (const file of files) {
      const target = path.join(this.#directoryFor(file), file.name);
      const complete = (await stat(target).catch(() => null))?.size;
      const partial = (await stat(`${target}.part`).catch(() => null))?.size ?? 0;
      remaining += complete === file.bytes ? 0 : file.bytes - Math.min(partial, file.bytes);
    }
    return remaining;
  }
  /** Start the job record, then refuse a host without the memory or disk the install needs. */
  async #preflight(id: string, files: DownloadFile[], total: number): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const disk = await statfs(this.root);
    const remaining = await this.#remainingBytes(files);
    const requiredBytes = remaining + BONSAI_BINARY.bytes * EXTRACTION_EXPANSION_FACTOR + DISK_RESERVE_BYTES;
    this.#job = {
      id: randomUUID(),
      model: id,
      phase: InstallPhase.Preflight,
      completed: 0,
      total,
      requiredBytes,
      availableBytes: availableBytes(disk),
      location: this.root,
      updatedAt: new Date().toISOString(),
      active: true,
    };
    await this.#updateJob({});
    if (this.#machine.memoryBytes < MIN_MEMORY_BYTES) throw new Error(MESSAGE.NeedsMemory);
    if (requiredBytes > availableBytes(disk))
      throw new Error(MESSAGE.NotEnoughSpace(requiredBytes, availableBytes(disk)));
  }
  async #downloadAll(
    files: DownloadFile[],
    total: number,
    signal: AbortSignal,
    progress: (p: DownloadProgress) => void,
  ): Promise<void> {
    let completed = 0;
    for (const file of files) {
      const downloaded = await this.#download(file, this.#directoryFor(file), signal, (p) => {
        progress({ ...p, total, completed: completed + p.completed });
        void this.#updateJob({
          phase: INSTALL_PHASE_FOR_DOWNLOAD[p.status],
          completed: completed + p.completed,
          total,
        }).catch(() => {});
      });
      completed += file.bytes;
      if (file === BONSAI_BINARY && !(await this.binary())) await this.#extractRuntime(downloaded, signal);
    }
  }
  async #extractRuntime(archive: string, signal: AbortSignal): Promise<void> {
    await this.#updateJob({ phase: InstallPhase.Extracting });
    const stage = path.join(this.root, `${BONSAI_RUNTIME}.staging`);
    await rm(stage, { recursive: true, force: true });
    await mkdir(stage, { recursive: true });
    const listing = await exec("/usr/bin/tar", ["-tzf", archive], { signal, timeout: TAR_LIST_TIMEOUT_MS });
    if (listing.stdout.split("\n").some(isUnsafeArchiveEntry)) throw new Error(MESSAGE.UnsafeArchive);
    // This exact publisher archive was verified above before any native code is extracted.
    await exec("/usr/bin/tar", ["-xzf", archive, "-C", stage], { signal, timeout: TAR_EXTRACT_TIMEOUT_MS });
    await rm(path.join(this.root, BONSAI_RUNTIME), { recursive: true, force: true });
    await rename(stage, path.join(this.root, BONSAI_RUNTIME));
  }
  async start(id: string, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    if (this.#disposed) throw new Error(MESSAGE.RuntimeClosed);
    const previous = this.#starting;
    if (previous && startBlocks(previous, id)) {
      await new Promise<void>((resolve, reject) => {
        const cancel = () => {
          signal.removeEventListener("abort", cancel);
          reject(signal.reason);
        };
        signal.addEventListener("abort", cancel, { once: true });
        if (signal.aborted) cancel();
        previous.promise
          .finally(() => {
            signal.removeEventListener("abort", cancel);
            resolve();
          })
          .catch(() => {});
      });
      return this.start(id, signal);
    }
    if (!this.#starting) {
      const abort = new AbortController();
      const pending = { id, abort, waiters: 0, promise: Promise.resolve("") };
      pending.promise = this.#launch(id, abort.signal).finally(() => {
        if (this.#starting === pending) this.#starting = null;
      });
      this.#starting = pending;
    }
    const pending = this.#starting;
    pending.waiters++;
    return new Promise<string>((resolve, reject) => {
      let ended = false;
      const finish = (error: unknown, value = "") => {
        if (ended) return;
        ended = true;
        signal.removeEventListener("abort", cancel);
        pending.waiters--;
        if (!pending.waiters && this.#starting === pending) pending.abort.abort();
        if (error) reject(error);
        else resolve(value);
      };
      const cancel = () => finish(signal.reason ?? new Error(MESSAGE.StartupCancelled));
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
      pending.promise.then(
        (value) => finish(null, value),
        (error) => finish(error),
      );
    });
  }
  /** The server's address when it already serves `id` and is still alive. */
  #runningHost(id: string): string | null {
    const child = this.#child;
    const alive = child?.exitCode === null && !child.signalCode && !child.killed;
    return this.#model === id && alive ? this.#host : null;
  }
  async #launch(id: string, signal: AbortSignal): Promise<string> {
    if (this.#disposed) throw new Error(MESSAGE.RuntimeClosed);
    const running = this.#runningHost(id);
    if (running) return running;
    await this.#stopProcess();
    if (!(await this.installed(id))) throw new Error(MESSAGE.NotDownloaded);
    const port = await freeLoopbackPort();
    const binary = await this.binary();
    if (!binary) throw new Error(MESSAGE.NotDownloaded);
    const child = spawn(binary, this.#serverArgs(id, port), {
      cwd: path.dirname(binary),
      stdio: ["ignore", "ignore", "pipe"],
      env: { PATH: process.env.PATH, HOME: this.root, TMPDIR: process.env.TMPDIR, LLAMA_API_KEY: this.#key },
    });
    this.#child = child;
    const output = watchServerOutput(child, path.join(this.root, "runtime.log"));
    const host = `http://${LOOPBACK_HOST}:${port}`;
    try {
      await this.#waitUntilHealthy(child, host, signal, output);
    } catch (err) {
      await this.#stopProcess();
      throw err;
    }
    this.#model = id;
    this.#host = host;
    return host;
  }
  #serverArgs(id: string, port: number): string[] {
    return [
      "--model",
      path.join(this.root, "models", bonsaiModel(id).file.name),
      "--mmproj",
      path.join(this.root, "models", BONSAI_PROJECTOR.name),
      "--alias",
      id,
      "--host",
      LOOPBACK_HOST,
      "--port",
      String(port),
      "--ctx-size",
      String(this.contextWindow),
      ...LLAMA_SERVER_TUNING,
    ];
  }
  /** Poll `/health` until it answers, the process dies, the caller aborts or startup times out. */
  async #waitUntilHealthy(child: ChildProcess, host: string, signal: AbortSignal, output: ServerOutput) {
    const until = Date.now() + STARTUP_TIMEOUT_MS;
    while (Date.now() < until) {
      signal.throwIfAborted();
      if (output.failure) throw output.failure;
      if (hasExited(child)) throw new Error(MESSAGE.StoppedDuringStartup(output.stderr));
      if (await this.#healthy(host, signal)) return;
      await delay(HEALTH_POLL_MS);
    }
    throw new Error(MESSAGE.StartupTimedOut(output.stderr));
  }
  #healthy(host: string, signal: AbortSignal): Promise<boolean> {
    return fetch(`${host}/health`, {
      headers: this.authHeaders,
      signal: AbortSignal.any([signal, AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS)]),
    })
      .then((r) => r.ok)
      .catch(() => false);
  }
  async stop(): Promise<void> {
    const startup = this.#starting;
    startup?.abort.abort();
    await startup?.promise.catch(() => {});
    await this.#stopProcess();
  }
  async #stopProcess(): Promise<void> {
    const child = this.#child;
    this.#child = null;
    this.#host = null;
    this.#model = null;
    this.#disarmIdleStop();
    if (child?.pid && !hasExited(child)) this.#exited = terminate(child);
    await this.#exited;
  }
  async dispose() {
    this.#disposed = true;
    this.cancelInstall();
    await this.stop();
  }
}
