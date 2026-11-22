import { InstallPhase, type ModelInstallJob, ModelInstallProblem } from "../../shared/model-install.ts";
import { atomicWriteJson, pathExists, readJsonIfExists, renameFolder } from "../fsx.ts";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { mkdir, readFile, writeFile, readdir, rm, stat, statfs } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import os from "node:os";
import { createWriteStream } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import {
  MANAGED_MODELS,
  ManagedFamily,
  RUNTIME_BUILDS,
  managedModel,
  type DownloadFile,
  type ManagedModel,
  type RuntimeBuild,
} from "./manifest.ts";
import { StudioPlatform } from "../../shared/boot.ts";
import { download, DownloadStatus, type DownloadProgress } from "./download.ts";
import { CodedError, errorCodeIn, errorMessage } from "../../shared/errors.ts";
import { MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";
import { t } from "../../shared/i18n.ts";
import { setTimeout as delay } from "node:timers/promises";

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
/** Hosts with at least this much memory get the large working window. */
const LARGE_HOST_MEMORY_BYTES = 32 * GIB;
const LARGE_CONTEXT_TOKENS = 102400;
const SMALL_CONTEXT_TOKENS = 16384;
/**
 * Inkling's working window. Only 4 of its 24 layers keep a full-context KV cache (8 with the loop),
 * about 2 GB at this size, and Genex's first prompt alone is ~18K tokens.
 */
const INKLING_CONTEXT_TOKENS = 65536;
/** Bonsai's minimum machine; Inkling's is the fit rule Settings applies before offering a download. */
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
const SERVER_BINARY = "llama-server";
const WINDOWS_SERVER_BINARY = "llama-server.exe";
const WINDOWS_ROOT = "C:\\Windows";
const LOOPBACK_HOST = "127.0.0.1";
const JOB_FILE = "install-job.json";

/**
 * What the runtime says: Model setup's download and delete refusals in the person's language
 * (functions, since main sets its language after it starts), and the startup failures a chat's run
 * reads in English, since the harness and the model read them too. A download's reason is also kept
 * in the job file, only for Model setup to show again.
 */
const MESSAGE = {
  Interrupted: () =>
    t("Studio closed before this operation finished. Resume verifies existing bytes before continuing."),
  StatusUnreadable: () => t("Cannot read model installation status."),
  AnotherInstall: () => t("Another model installation is running."),
  NeedsAppleSilicon: () => t("Bonsai currently requires an Apple Silicon Mac"),
  UnsupportedMachine: (model: string) => t("{model} can't run on this computer.", { model }),
  AnotherDownload: () => t("Another Bonsai download is running"),
  NeedsMemory: () => t("Bonsai requires at least 16 GiB of memory."),
  NotEnoughSpace: (required: number, available: number) =>
    t(
      "Not enough space: {required, plural, other {# bytes}} needed for remaining downloads, temporary extraction and reserve; {available} available.",
      { required, available },
    ),
  UnsafeArchive: () => t("Unsafe runtime archive"),
  DownloadCancelled: () => t("Download cancelled. Verified files and resumable partials are retained."),
  RuntimeClosed: "The local model runtime is closed",
  StartupCancelled: "Local model startup cancelled",
  NotDownloaded: "Download this local model in Settings › Local Models first",
  RemoveWhileDownloading: () => t("A model is downloading. Delete this one when the download finishes."),
  RemoveWhileAnswering: () => t("A local model is answering a chat or build. Delete the model when it finishes."),
  StoppedDuringStartup: (stderr: string) => `The local model stopped during startup: ${stderr}`,
  StartupTimedOut: (stderr: string) => `The local model's startup timed out: ${stderr}`,
} as const;

/** What a failure in each phase of an install is, when nothing more exact was said. */
const PHASE_PROBLEMS: Partial<Record<InstallPhase, ModelInstallProblem>> = {
  [InstallPhase.Downloading]: ModelInstallProblem.Download,
  [InstallPhase.Verifying]: ModelInstallProblem.Download,
  [InstallPhase.Extracting]: ModelInstallProblem.Extract,
  [InstallPhase.Starting]: ModelInstallProblem.Startup,
};

/** Why an install failed in `phase`: the refusal's own code, else what failing in that phase means. */
export function installProblem(err: unknown, phase: InstallPhase | undefined): ModelInstallProblem {
  const coded = errorCodeIn(ModelInstallProblem, err);
  if (coded) return coded;
  return (phase && PHASE_PROBLEMS[phase]) || ModelInstallProblem.Other;
}

/** The llama-server flags Studio pins for Bonsai, after the per-launch model, port and context. */
const BONSAI_SERVER_TUNING = [
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

/**
 * Inkling's: no layer count, so llama-server's `--fit` (on by default) keeps on the graphics card
 * what fits there and the rest of the experts in RAM, as a 12 GB card needs. Its reasoning effort
 * travels with each request (`chat_template_kwargs`), not as a server flag.
 */
const INKLING_SERVER_TUNING = [
  "--parallel",
  "1",
  "--cache-ram",
  "0",
  "--jinja",
  "--no-webui",
  "--cors-origins",
  `http://${LOOPBACK_HOST}`,
] as const;

const SERVER_TUNING: Record<ManagedFamily, readonly string[]> = {
  [ManagedFamily.Bonsai]: BONSAI_SERVER_TUNING,
  [ManagedFamily.Inkling]: INKLING_SERVER_TUNING,
};

/** The install phase a download progress report puts the job in. */
const INSTALL_PHASE_FOR_DOWNLOAD: Record<DownloadStatus, InstallPhase> = {
  [DownloadStatus.Downloading]: InstallPhase.Downloading,
  [DownloadStatus.Verifying]: InstallPhase.Verifying,
  [DownloadStatus.Verified]: InstallPhase.Verifying,
  [DownloadStatus.Success]: InstallPhase.Installed,
};

const exec = promisify(execFile);

/** What kind of machine this is, for the build a model runs on, and how much memory it has. */
export interface Machine {
  appleSilicon: boolean;
  memoryBytes: number;
  /** `process.platform` and `process.arch`; an Apple Silicon machine without them is a Mac. */
  platform?: string;
  arch?: string;
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
  appleSilicon: process.platform === StudioPlatform.Mac && process.arch === "arm64",
  memoryBytes: os.totalmem(),
  platform: process.platform,
  arch: process.arch,
});

/** The machine as the manifest's builds see it. */
function hostOf(machine: Machine) {
  const mac = machine.appleSilicon ? { platform: StudioPlatform.Mac, arch: "arm64" } : null;
  return {
    platform: machine.platform ?? mac?.platform ?? process.platform,
    arch: machine.arch ?? mac?.arch ?? process.arch,
    appleSilicon: machine.appleSilicon,
  };
}

/** Every file a pinned build unpacks from. */
const ARCHIVES: ReadonlySet<DownloadFile> = new Set(RUNTIME_BUILDS.flatMap((build) => build.archives));

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

/** Where `child` and its tools find their libraries: a Linux build keeps its own beside the server. */
function serverEnv(platform: string, binary: string, key: string): NodeJS.ProcessEnv {
  const base = { PATH: process.env.PATH, LLAMA_API_KEY: key };
  if (platform === StudioPlatform.Windows)
    return {
      ...base,
      SystemRoot: process.env.SystemRoot ?? WINDOWS_ROOT,
      windir: process.env.windir ?? WINDOWS_ROOT,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
    };
  const libraries = platform === StudioPlatform.Linux ? { LD_LIBRARY_PATH: path.dirname(binary) } : {};
  return { ...base, TMPDIR: process.env.TMPDIR, ...libraries };
}

/** The archive tool: macOS's and Linux's `tar`, or Windows' own `tar.exe` (bsdtar, which reads zip). */
function tarOf(platform: string): string {
  if (platform !== StudioPlatform.Windows) return "/usr/bin/tar";
  return path.win32.join(process.env.SystemRoot ?? WINDOWS_ROOT, "System32", "tar.exe");
}

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

/** Find the server binary `name` at most `depth` folders below `dir`. */
async function findServerBinary(dir: string, name: string, depth: number): Promise<string | null> {
  for (const item of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (item.isFile() && item.name === name) return path.join(dir, item.name);
    if (!item.isDirectory() || depth <= 0) continue;
    const found = await findServerBinary(path.join(dir, item.name), name, depth - 1);
    if (found) return found;
  }
  return null;
}

/** An archive entry that would land outside the folder it unpacks into, on any platform. */
const isUnsafeArchiveEntry = (name: string) =>
  /^[\\/]/.test(name) || /^[a-z]:/i.test(name) || name.split(/[\\/]/).includes("..");

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
  /** A runtime archive waits in `downloads`; weights, projectors and notices live in `models`. */
  #directoryFor(file: DownloadFile): string {
    return path.join(this.root, ARCHIVES.has(file) ? "downloads" : "models");
  }
  /** The build `model` runs on on this machine, or null when it cannot run here. */
  #buildFor(model: ManagedModel): RuntimeBuild | null {
    return model.runtimeFor(hostOf(this.#machine));
  }
  /** Whether this machine has a pinned build that runs `id`. */
  runsHere(id: string): boolean {
    return Boolean(this.#buildFor(managedModel(id)));
  }
  /** The working window `id` runs with on this machine. */
  contextWindowFor(id: string): number {
    return managedModel(id).family === ManagedFamily.Inkling ? INKLING_CONTEXT_TOKENS : this.contextWindow;
  }
  async installStatus(): Promise<ModelInstallJob | null> {
    if (this.#job) return { ...this.#job };
    let job: ModelInstallJob | null;
    try {
      job = await readJsonIfExists<ModelInstallJob>(this.#jobFile);
    } catch {
      throw new Error(MESSAGE.StatusUnreadable());
    }
    if (!job) return null;
    if (job.active) {
      job.active = false;
      job.phase = InstallPhase.Interrupted;
      job.error = MESSAGE.Interrupted();
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
    const spec = managedModel(id);
    const build = this.#buildFor(spec);
    if (!build) return false;
    try {
      const receipt = JSON.parse(await readFile(this.#receiptFile(id), "utf8"));
      return (
        receipt.runtime === build.name &&
        receipt.sha256 === spec.file.sha256 &&
        (await stat(path.join(this.root, "models", spec.file.name))).size === spec.file.bytes &&
        (await stat(path.join(this.root, "models", spec.projector.name))).size === spec.projector.bytes &&
        Boolean(await this.#binaryOf(build))
      );
    } catch {
      return false;
    }
  }
  /** The server binary `id` runs (by default the first model this machine runs), once unpacked. */
  async binary(id?: string): Promise<string | null> {
    const model = id ? managedModel(id) : MANAGED_MODELS.find((m) => this.#buildFor(m));
    const build = model && this.#buildFor(model);
    return build ? this.#binaryOf(build) : null;
  }
  #binaryOf(build: RuntimeBuild): Promise<string | null> {
    const name = hostOf(this.#machine).platform === StudioPlatform.Windows ? WINDOWS_SERVER_BINARY : SERVER_BINARY;
    return findServerBinary(path.join(this.root, build.name), name, BINARY_SEARCH_DEPTH);
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
    const spec = managedModel(id);
    if (this.#installPromise) throw new Error(MESSAGE.RemoveWhileDownloading());
    if (this.#leases || this.#starting) throw new Error(MESSAGE.RemoveWhileAnswering());
    await rm(this.#receiptFile(id), { force: true });
    if (this.#model === id) await this.#stopProcess();
    await this.#removeDownload(spec.file);
    await this.#forgetJob(id);
    await this.#removeUnneeded(await this.#modelsKeepingBytes(id));
  }
  /** The projectors, notices and builds no model in `kept` needs any more, and their partials. */
  async #removeUnneeded(kept: ManagedModel[]): Promise<void> {
    const keptBuilds = new Set(kept.map((model) => this.#buildFor(model)));
    const needed = new Set<DownloadFile>(
      kept.flatMap((model) => [model.projector, ...model.notices, ...(this.#buildFor(model)?.archives ?? [])]),
    );
    const shared = new Set(MANAGED_MODELS.flatMap((model) => [model.projector, ...model.notices]));
    for (const file of [...ARCHIVES, ...shared]) if (!needed.has(file)) await this.#removeDownload(file);
    for (const build of RUNTIME_BUILDS) {
      if (keptBuilds.has(build)) continue;
      for (const folder of [build.name, `${build.name}.staging`])
        await rm(path.join(this.root, folder), { recursive: true, force: true });
    }
  }
  /** A pinned file and its resumable partial. */
  async #removeDownload(file: DownloadFile): Promise<void> {
    const target = path.join(this.#directoryFor(file), file.name);
    await rm(target, { force: true });
    await rm(`${target}.part`, { force: true });
  }
  /** The other models that still have a receipt, weights or a partial download here. */
  async #modelsKeepingBytes(id: string): Promise<ManagedModel[]> {
    const kept: ManagedModel[] = [];
    for (const other of MANAGED_MODELS) {
      if (other.id === id) continue;
      const weights = path.join(this.#directoryFor(other.file), other.file.name);
      for (const file of [this.#receiptFile(other.id), weights, `${weights}.part`])
        if (await pathExists(file)) {
          kept.push(other);
          break;
        }
    }
    return kept;
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
      if (this.#job?.model !== id)
        return Promise.reject(new CodedError(ModelInstallProblem.AnotherDownload, MESSAGE.AnotherInstall()));
      return this.#installPromise;
    }
    this.#installPromise = this.#performInstall(id, progress).finally(() => {
      this.#installPromise = null;
    });
    return this.#installPromise;
  }
  /** The build `model` runs on here; a machine that cannot run it is refused before anything is fetched. */
  #buildOrRefuse(model: ManagedModel): RuntimeBuild {
    const build = this.#buildFor(model);
    if (build) return build;
    if (model.family === ManagedFamily.Bonsai)
      throw new CodedError(ModelInstallProblem.NeedsAppleSilicon, MESSAGE.NeedsAppleSilicon());
    throw new CodedError(ModelInstallProblem.UnsupportedMachine, MESSAGE.UnsupportedMachine(model.label));
  }
  async #performInstall(id: string, progress: (p: DownloadProgress) => void): Promise<void> {
    const model = managedModel(id);
    const build = this.#buildOrRefuse(model);
    if (this.#install) throw new CodedError(ModelInstallProblem.AnotherDownload, MESSAGE.AnotherDownload());
    const controller = new AbortController();
    this.#install = controller;
    try {
      const files = [...build.archives, ...model.notices, model.file, model.projector];
      const total = totalBytes(files);
      await this.#preflight(model, build, files, total);
      await this.#downloadAll(build, files, total, controller.signal, progress);
      controller.signal.throwIfAborted();
      await writeFile(
        this.#receiptFile(id),
        JSON.stringify({ runtime: build.name, sha256: model.file.sha256, installedAt: new Date().toISOString() }),
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
      if (controller.signal.aborted) {
        await this.#updateJob({ phase: InstallPhase.Cancelled, error: MESSAGE.DownloadCancelled(), active: false });
        throw err;
      }
      const failedPhase = this.#job?.phase;
      const problem = installProblem(err, failedPhase);
      await this.#updateJob({
        phase: InstallPhase.Failed,
        error: errorMessage(err),
        problem,
        ...(failedPhase ? { failedPhase } : {}),
        active: false,
      });
      throw new CodedError(problem, errorMessage(err));
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
  async #preflight(model: ManagedModel, build: RuntimeBuild, files: DownloadFile[], total: number): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const disk = await statfs(this.root);
    const remaining = await this.#remainingBytes(files);
    const extraction = totalBytes([...build.archives]) * EXTRACTION_EXPANSION_FACTOR;
    const requiredBytes = remaining + extraction + DISK_RESERVE_BYTES;
    this.#job = {
      id: randomUUID(),
      model: model.id,
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
    if (model.family === ManagedFamily.Bonsai && this.#machine.memoryBytes < MIN_MEMORY_BYTES)
      throw new CodedError(ModelInstallProblem.NeedsMemory, MESSAGE.NeedsMemory());
    if (requiredBytes > availableBytes(disk))
      throw new CodedError(
        ModelInstallProblem.NotEnoughSpace,
        MESSAGE.NotEnoughSpace(requiredBytes, availableBytes(disk)),
      );
  }
  async #downloadAll(
    build: RuntimeBuild,
    files: DownloadFile[],
    total: number,
    signal: AbortSignal,
    progress: (p: DownloadProgress) => void,
  ): Promise<void> {
    let completed = 0;
    const unpacked: string[] = [];
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
      if (!build.archives.includes(file)) continue;
      unpacked.push(downloaded);
      // A build's archives unpack together, once the last of them is here.
      if (unpacked.length === build.archives.length && !(await this.#binaryOf(build)))
        await this.#extractRuntime(build, unpacked, signal);
    }
  }
  async #extractRuntime(build: RuntimeBuild, archives: string[], signal: AbortSignal): Promise<void> {
    await this.#updateJob({ phase: InstallPhase.Extracting });
    const stage = path.join(this.root, `${build.name}.staging`);
    await rm(stage, { recursive: true, force: true });
    await mkdir(stage, { recursive: true });
    const tar = tarOf(hostOf(this.#machine).platform);
    for (const archive of archives) {
      // `-t`/`-x` without a compression flag: macOS's and Windows' bsdtar and GNU tar each read a
      // gzip tarball, and bsdtar reads a zip, by what the file is.
      const listing = await exec(tar, ["-tf", archive], { signal, timeout: TAR_LIST_TIMEOUT_MS, windowsHide: true });
      if (listing.stdout.split(/\r?\n/).some(isUnsafeArchiveEntry))
        throw new CodedError(ModelInstallProblem.UnsafeArchive, MESSAGE.UnsafeArchive());
      // This exact publisher archive was verified above before any native code is extracted.
      await exec(tar, ["-xf", archive, "-C", stage], { signal, timeout: TAR_EXTRACT_TIMEOUT_MS, windowsHide: true });
    }
    await rm(path.join(this.root, build.name), { recursive: true, force: true });
    // On Windows, antivirus may still hold a just-unpacked .exe: renameFolder waits that out.
    await renameFolder(stage, path.join(this.root, build.name));
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
    const binary = await this.binary(id);
    if (!binary) throw new Error(MESSAGE.NotDownloaded);
    const child = spawn(binary, this.#serverArgs(id, port), {
      cwd: path.dirname(binary),
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...serverEnv(hostOf(this.#machine).platform, binary, this.#key), HOME: this.root },
      windowsHide: true,
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
    const model = managedModel(id);
    return [
      "--model",
      path.join(this.root, "models", model.file.name),
      "--mmproj",
      path.join(this.root, "models", model.projector.name),
      "--alias",
      id,
      "--host",
      LOOPBACK_HOST,
      "--port",
      String(port),
      "--ctx-size",
      String(this.contextWindowFor(id)),
      ...SERVER_TUNING[model.family],
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
