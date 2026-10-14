/**
 * The toolchain service: the one install job, the store's status, pruning, the Command Line Tools
 * and the lock a C++ build locates. Installs are person-initiated (`studio:toolchain.install` is a
 * native channel); no harness method reaches this service. The store itself (manifest, archives,
 * receipts, locks, prewarm) is `substrate/toolchain-store/`; this module orders its steps, owns
 * the job and its cancellation, and announces every change as `UiEvent.ToolchainInstall`.
 */
import { execFile } from "node:child_process";
import { lstat, readdir, rm, statfs } from "node:fs/promises";
import path from "node:path";
import { StudioPlatform } from "../../shared/boot.ts";
import { cppSetupTargets } from "../../shared/cpp-setup.ts";
import { SECOND_MS } from "../../shared/duration.ts";
import { BUILD_TARGETS, BuildTarget, type CompiledStack, GameStack } from "../../shared/game-project.ts";
import {
  isInstallRunning,
  PrewarmState,
  REQUIRED_COMPONENTS,
  STACK_REQUIRED_COMPONENTS,
  ToolchainError,
  ToolchainHost,
  type ToolchainEntry,
  type ToolchainDownload,
  type ToolchainId,
  ToolchainInstallPhase,
  type ToolchainInstallJob,
  type ToolchainLock,
  ToolchainProblem,
  ToolchainPruneRefusal,
  type ToolchainPruneResult,
  type ToolchainStatus,
  type ToolchainUnhosted,
} from "../../shared/toolchain.ts";
import { ProcessSandbox, type RunRequest, type RunResult, type SandboxRuntime } from "../../substrate/spawn.ts";
import {
  DISK_RESERVE_BYTES,
  type InstallDeps,
  installComponents,
  nearestExisting,
  pruneStore,
  readReceipts,
  STAGING_FOLDER,
  type ToolchainReceipt,
  unpackedBytes,
} from "../../substrate/toolchain-store/install.ts";
import {
  currentLock,
  type LocateOptions,
  type LocateResult,
  locateToolchain,
  lockFolder,
  PREWARM_FILE,
  requiredFor,
} from "../../substrate/toolchain-store/locate.ts";
import {
  COMPILED_STACKS,
  lockOf,
  readCurrentLock,
  readRecordedLock,
  referencedVersions,
  writeCurrentLock,
} from "../../substrate/toolchain-store/lock.ts";
import {
  entrySha12,
  isDownloadable,
  isPinned,
  manifestEntry,
  TOOLCHAIN_MANIFEST,
} from "../../substrate/toolchain-store/manifest.ts";
import { headlessPlatformPath } from "../../substrate/toolchain-store/genex-cmake.ts";
import { isBundled } from "../../substrate/toolchain-store/bundled.ts";
import { PREWARMED_TARGETS, prewarm, prewarmSandboxOptions } from "../../substrate/toolchain-store/prewarm.ts";
import {
  SeedError,
  SeedRefusal,
  seedPrewarm,
  writePrewarmManifest,
} from "../../substrate/toolchain-store/prewarm-seed.ts";
import { retainedLocks, stackOfLock, sweepLockRecords } from "../../substrate/toolchain-store/retention.ts";
import type { CrateCheckSandbox, CrateCheckTools } from "../../substrate/toolchain-store/crate-check.ts";
import {
  crateCheckEntries,
  crateCheckFolders,
  locateCrateCheckTools,
} from "../../substrate/toolchain-store/crate-check-store.ts";
import type { CratePolicy } from "../../substrate/toolchain-store/crate-policy.ts";
import { installRustBase } from "../../substrate/toolchain-store/rust-install.ts";
import { locateRust, readRustBase } from "../../substrate/toolchain-store/rust-locate.ts";
import {
  prewarmRust,
  RUST_EAGER_STORE_BUDGET_BYTES,
  type RustWarmProject,
} from "../../substrate/toolchain-store/rust-prewarm.ts";
import {
  type RustSeedResult,
  RustSeedPhase,
  readSeedLock,
  seedRustComponents,
} from "../../substrate/toolchain-store/rust-seed.ts";

/** Set by `scripts/build.mjs`: a developer build's checkout, or null in a release build; absent from source. */
declare const __STUDIO_DEV_BUILD__: { checkout: string; buildId: string } | null | undefined;

/** Whether this app is a release build: built, and from no developer checkout. */
function isReleaseBuild(): boolean {
  return typeof __STUDIO_DEV_BUILD__ !== "undefined" && __STUDIO_DEV_BUILD__ === null;
}

const MESSAGE = {
  unsupportedHost: "No C++ toolchain is pinned for this computer.",
  noPrewarmSandbox: "Prewarm runs only in its own sandbox, told which folders it must never write; one is missing.",
  releaseSeed: "A release build never seeds its Rust toolchain from local artifacts.",
  noRustHost: "No Rust toolchain is pinned for this computer.",
  noCrateCheckSandbox: "The crate checker has no sandbox here.",
  noWarmProject: "There is no warm project to prewarm with (the shipped Rust payload names no genex release).",
  noSeedSpace: (needed: number, free: number) =>
    `Not enough disk space to seed the Rust toolchain and its prewarms: ${Math.ceil(needed / 1024 ** 2)} MiB needed, ${Math.floor(free / 1024 ** 2)} MiB free.`,
} as const;

/** The Rust destinations a developer profile's seed prewarms, as the dev store does: the Mac's own and the browser. */
const RUST_SEED_TARGETS: readonly BuildTarget[] = [BuildTarget.Mac, BuildTarget.Web];

/** `xcode-select`: `-p` prints the selected developer folder; `--install` opens Apple's dialog. */
export const XCODE_SELECT = "/usr/bin/xcode-select";
/** `pkgutil --pkg-info` names the installed Command Line Tools package's version. */
const PKGUTIL = "/usr/bin/pkgutil";
/** The receipt the Command Line Tools installer leaves. */
const CLT_PACKAGE = "com.apple.pkg.CLTools_Executables";
/** How long one probe command may take. */
const CLT_PROBE_TIMEOUT_MS = 10 * SECOND_MS;
/** How long `xcode-select --install` may take to hand the request to Apple's installer. */
const CLT_INSTALL_TIMEOUT_MS = 30 * SECOND_MS;
/** How many files the store's size walk stats at once. */
const SIZE_WALK_BATCH = 64;

/**
 * What an untyped failure most likely was, by the phase it ended in; a typed one names its own
 * problem, and anything else reads as a failed download, which Try again can fix.
 */
const PHASE_PROBLEM: Partial<Record<ToolchainInstallPhase, ToolchainProblem>> = {
  [ToolchainInstallPhase.Downloading]: ToolchainProblem.Download,
  [ToolchainInstallPhase.Verifying]: ToolchainProblem.Integrity,
  [ToolchainInstallPhase.Extracting]: ToolchainProblem.Archive,
  [ToolchainInstallPhase.Probing]: ToolchainProblem.Probe,
  [ToolchainInstallPhase.Prewarming]: ToolchainProblem.Prewarm,
};

/** A host-owned command's outcome: `code` null when it did not exit normally (killed, missing). */
export interface HostExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs a fixed host program without a shell and outside the sandbox (the CLT probe and install). */
export type HostExec = (
  file: string,
  args: readonly string[],
  options?: { timeoutMs?: number; signal?: AbortSignal },
) => Promise<HostExecResult>;

/** What the Command Line Tools probe found. */
export interface CltProbe {
  present: boolean;
  version: string | null;
}

/** The exit code `execFile` reports: 0 without an error, null when the program did not exit on its own. */
function exitCode(error: { code?: unknown } | null): number | null {
  if (!error) return 0;
  return typeof error.code === "number" ? error.code : null;
}

/** {@link HostExec} over `execFile`: never throws, a failure is its exit code. */
export const execHost: HostExec = (file, args, options = {}) =>
  new Promise((resolve) => {
    execFile(
      file,
      [...args],
      { encoding: "utf8", timeout: options.timeoutMs, signal: options.signal, windowsHide: true },
      (error, stdout, stderr) => resolve({ code: exitCode(error), stdout: String(stdout), stderr: String(stderr) }),
    );
  });

/**
 * Whether a developer folder is selected (the Command Line Tools, or Xcode), and the Command Line
 * Tools package's version. Only `xcode-select -p` and `pkgutil --pkg-info` run: never clang, git
 * or python3, whose CLT shims can open Apple's installer dialog. Not a Mac: none.
 */
export async function probeCommandLineTools(exec: HostExec, platform: NodeJS.Platform): Promise<CltProbe> {
  const none: CltProbe = { present: false, version: null };
  if (platform !== StudioPlatform.Mac) return none;
  const selected = await exec(XCODE_SELECT, ["-p"], { timeoutMs: CLT_PROBE_TIMEOUT_MS });
  if (selected.code !== 0 || selected.stdout.trim() === "") return none;
  const info = await exec(PKGUTIL, [`--pkg-info=${CLT_PACKAGE}`], { timeoutMs: CLT_PROBE_TIMEOUT_MS });
  const version = info.code === 0 ? (/^version:\s*(\S+)/m.exec(info.stdout)?.[1] ?? null) : null;
  return { present: true, version };
}

/** The store substrate the service drives: one seam, so a test can stand in for the disk and the network. */
export interface ToolchainStoreOps {
  manifest: readonly ToolchainEntry[];
  manifestEntry: typeof manifestEntry;
  entrySha12: typeof entrySha12;
  lockOf: typeof lockOf;
  referencedVersions: typeof referencedVersions;
  installComponents: typeof installComponents;
  prewarm: typeof prewarm;
  readReceipts: typeof readReceipts;
  pruneStore: typeof pruneStore;
  currentLock: typeof currentLock;
  writeCurrentLock: typeof writeCurrentLock;
  locateToolchain: typeof locateToolchain;
  /** A lock read back by its digest (a stack's current one or its record): what a game on an older lock builds with. */
  readRecordedLock?: typeof readRecordedLock;
  /** Removes the records and prewarm manifests of locks nothing keeps. */
  sweepLockRecords?: typeof sweepLockRecords;
  /** Seeds a developer store's prewarm from the normal store's. */
  seedPrewarm?: typeof seedPrewarm;
  /** Records what a prewarmed lock folder holds, for a developer profile's seed. */
  writePrewarmManifest?: typeof writePrewarmManifest;
}

/** The real store substrate (`substrate/toolchain-store/`). */
export const TOOLCHAIN_STORE: Required<ToolchainStoreOps> = {
  manifest: TOOLCHAIN_MANIFEST,
  manifestEntry,
  entrySha12,
  lockOf,
  referencedVersions,
  installComponents,
  prewarm,
  readReceipts,
  pruneStore,
  currentLock,
  writeCurrentLock,
  locateToolchain,
  readRecordedLock,
  sweepLockRecords,
  seedPrewarm,
  writePrewarmManifest,
};

/** What the Toolchain sheet sizes its downloads and disk line with: the status's plan fields, all present. */
export type ToolchainPlan = Required<Pick<ToolchainStatus, "downloads" | "freeBytes" | "reserveBytes">>;

/** What the service reaches, injected. */
export interface ToolchainServiceOptions {
  /** The store root: `layout.toolchains`. */
  store: string;
  /** The manifest host this computer is; null where no toolchain is pinned. */
  host: ToolchainHost | null;
  /** Every change of the install job (`UiEvent.ToolchainInstall`). */
  emit: (job: ToolchainInstallJob) => void;
  /** Version probes run here: the core's `ProcessSandbox.run`. */
  run: (request: RunRequest) => Promise<RunResult>;
  exec: HostExec;
  probeClt: () => Promise<CltProbe>;
  /** The store substrate, piece by piece over {@link TOOLCHAIN_STORE}. */
  ops?: Partial<ToolchainStoreOps>;
  /** Downloads: the main process's `fetch` (no Chromium download, so nothing is quarantined). */
  fetch?: InstallDeps["fetch"];
  /** Free bytes on the disk holding `dir`. */
  freeBytes?: (dir: string) => Promise<number>;
  /**
   * The sandbox each prewarm runs in ({@link createPrewarmSandbox}), let go when it ends. Without
   * it prewarm refuses (typed `prewarm`) and runs nothing: the core's sandbox denies the store.
   */
  prewarmSandbox?: () => Promise<PrewarmSandbox>;
  /**
   * What no prewarm command may write besides the store's own folders: the games root, scratch and
   * runs. Absent or empty, prewarm refuses and runs nothing.
   */
  prewarmDenyWrite?: readonly string[];
  /** The lock digests the library's games record, when {@link ToolchainService.prune} is not given them. */
  gameLocks?: () => Promise<readonly string[]>;
  /**
   * The lock digest the library records for `project`'s last build of its own folder
   * (`GameWorkspaces.writeNativeLock`), or nothing: what keeps a Rust game on its lock after an
   * app update moved the current one on ({@link ToolchainService.currentLock} with a project).
   */
  recordedLock?: (project: string) => Promise<unknown>;
  now?: () => number;
  /**
   * The app's read-only resources (`StudioPaths.resources`). A release build has no checkout, so
   * its Mac prewarm and locate read the headless platform file `scripts/build.mjs` copied there.
   */
  resources?: string;
  /** Whether this app is a release build (default: what `scripts/build.mjs` defined); source and developer builds read the checkout's. */
  releaseBuild?: boolean;
  /**
   * The host-level download cache every profile shares (`layout.downloadCache`): archives are
   * fetched into it once and verified each time an install extracts one. Absent, every install
   * downloads into its own staging.
   */
  downloadCache?: string;
  /**
   * A developer profile only: the normal profile's store, read-only, whose prewarmed lock folders
   * seed this store's before a prewarm runs (`prewarm-seed.ts`). Never set for the normal profile:
   * nothing ever seeds it.
   */
  seedFrom?: string;
  /**
   * A developer build's owned profile only: the local Rust store and lock its Rust · wgpu stack is
   * seeded from ({@link ToolchainService.seedRust}), so Rust games build before any genex release
   * is published. Never set for the normal profile; a release build refuses it.
   */
  rustSeed?: RustSeedSource;
  /**
   * The sandbox the crate checker's engines run in for one vendor job: it writes only `writes` (the
   * job's check folder), reads `reads` and the system, and opens no domain. Absent: no checker runs.
   */
  crateCheckSandbox?: (spec: { writes: string; reads: readonly string[] }) => Promise<CrateCheckSandbox>;
}

/** Where a developer profile's Rust · wgpu stack is seeded from, and what its prewarm warms. */
export interface RustSeedSource {
  /** The local Rust store, read only: the developer's dev store (`dev-store.ts --stack rust-wgpu`). */
  from: string;
  /** The plain file holding the Rust lock to seed (the worktree's `dev-store-rust-lock.json`). */
  lockFile: string;
  /** Stores the seed must never write, however spelled: the normal profile's. */
  forbidden?: readonly string[];
  /** The project the profile's prewarms build, as a game's host-written manifest; null when none can be written. */
  warmProject: () => Promise<RustWarmProject | null>;
  /** The compiler flags every game build carries, so the prewarm is the one builds and sessions clone. */
  rustflags?: readonly string[];
}

/** How {@link ToolchainService.seedRust} ended; logged by the core. */
export type RustSeedOutcome =
  | ({
      phase: typeof RustSeedPhase.Seeded;
      lock: string;
      prewarmed: BuildTarget[];
      skipped: BuildTarget[];
    } & RustSeedResult)
  | { phase: typeof RustSeedPhase.Current; lock: string }
  | { phase: typeof RustSeedPhase.Refused; refusal: SeedRefusal; detail: string }
  | { phase: typeof RustSeedPhase.Failed; problem: ToolchainProblem; detail: string };

/** What an install can install: {@link ToolchainService} `#installable`. */
interface InstallPlan {
  entries: ToolchainEntry[];
  unavailable: BuildTarget[];
  /** The first component left out: it has no download, and why (no pin, or a pin with no download yet). */
  unpinned: { id: ToolchainId; problem: ToolchainProblem } | null;
}

/** A sandbox one prewarm runs its commands in, and how to let it go once the prewarm ends. */
export interface PrewarmSandbox {
  run: (request: RunRequest) => Promise<RunResult>;
  dispose: () => Promise<void>;
}

/** What the prewarm sandbox is built with; it has no writable root of its own. */
export interface PrewarmSandboxOptions {
  /** Its own scratch; prewarm points each command's `TMPDIR` at `<staging>/.tmp` instead. */
  scratchDir: string;
  /** Never readable nor writable: the studio's secrets and the engines' homes. */
  secretPaths: readonly string[];
  /** Always-readable roots besides the defaults (the app's resources). */
  readableRoots?: readonly string[];
  /** False only where the core's own sandbox is off. */
  enabled?: boolean;
  /** PATH for its commands, as the core's sandbox resolves it. */
  toolPath?: () => Promise<string>;
  /** sandbox-runtime itself; a test stands a fake one in. */
  runtime?: SandboxRuntime;
  /**
   * The core's sandbox, whose config (with the domains its runs in flight opened) goes back into
   * the one process-wide runtime once this one has pushed its own, and again once it is let go.
   */
  alongside?: Pick<ProcessSandbox, "refreshConfig">;
}

/**
 * A sandbox for one prewarm with no writable root, so each command's overlay (`prewarmPolicy`)
 * opens only `<store>/.staging/<lock>`. The core's own sandbox cannot run a prewarm: it denies
 * the whole store (`studioBaseDenyWrites`), and a run's overlay never weakens a deny.
 */
export async function createPrewarmSandbox(options: PrewarmSandboxOptions): Promise<PrewarmSandbox> {
  const sandbox = await ProcessSandbox.create({
    ...prewarmSandboxOptions(options.scratchDir, options.secretPaths),
    readableRoots: options.readableRoots ? [...options.readableRoots] : undefined,
    enabled: options.enabled,
    toolPath: options.toolPath,
    runtime: options.runtime,
  });
  // Its own runs carry its policy as a per-run overlay; the network allow-list is the runtime's.
  options.alongside?.refreshConfig();
  return {
    run: (request) => sandbox.run(request),
    dispose: async () => {
      await sandbox.dispose();
      options.alongside?.refreshConfig();
    },
  };
}

/** A job's outcome before it is stamped: where it ended, why, and on which component. */
interface JobEnd {
  phase: ToolchainInstallPhase;
  problem?: ToolchainProblem;
  entry?: ToolchainId | null;
  unavailable?: BuildTarget[];
}

/** Whether the manifest has `entry` with a download the store can install: pinned, and not local-only. */
const isDownloadableEntry = (entry: ToolchainEntry | null): entry is ToolchainEntry =>
  entry !== null && isDownloadable(entry);

/** Why a component has no download: a local-only pin is `not-hosted`; anything else `unpinned`. */
const missingDownload = (entry: ToolchainEntry | null): ToolchainProblem =>
  entry !== null && isPinned(entry) ? ToolchainProblem.NotHosted : ToolchainProblem.Unpinned;

/**
 * The disk the files under `root` take: every regular file once, however many hard links it has,
 * and links not followed (`install.ts` `treeBytes` counts a receipt's size, links as themselves).
 */
async function diskBytesUnder(root: string): Promise<number> {
  const entries = await readdir(root, { withFileTypes: true, recursive: true }).catch(() => []);
  const files = entries.filter((entry) => entry.isFile()).map((entry) => path.join(entry.parentPath, entry.name));
  const seen = new Set<string>();
  let total = 0;
  for (let at = 0; at < files.length; at += SIZE_WALK_BATCH) {
    const stats = await Promise.all(files.slice(at, at + SIZE_WALK_BATCH).map((file) => lstat(file).catch(() => null)));
    for (const stat of stats) {
      const key = stat ? `${stat.dev}:${stat.ino}` : null;
      if (!stat || !key || seen.has(key)) continue;
      seen.add(key);
      total += stat.size;
    }
  }
  return total;
}

/** Free bytes on the disk holding `dir`. */
async function diskFreeBytes(dir: string): Promise<number> {
  const stats = await statfs(dir);
  return stats.bavail * stats.bsize;
}

/** A prune that removed nothing, and why. */
const keptAll = (refused: ToolchainPruneRefusal): ToolchainPruneResult => ({ removed: 0, bytes: 0, refused });

/** Whether the store already holds `entry` at its pinned version and digest. */
function holds(receipts: readonly ToolchainReceipt[], entry: ToolchainEntry, sha12: string): boolean {
  return receipts.some((item) => item.id === entry.id && item.version === entry.version && item.sha12 === sha12);
}

/** Whether `file` is a regular file itself (a link, a folder or nothing at all is not). */
async function isRegularFile(file: string): Promise<boolean> {
  return lstat(file).then(
    (found) => found.isFile(),
    () => false,
  );
}

/** A destination's prewarm from what locating it found, and whether its lock folder records a prewarm. */
function prewarmState(found: LocateResult, recorded: boolean): PrewarmState {
  if (found.ok) return PrewarmState.Ready;
  return found.needsPrewarm && recorded ? PrewarmState.Stale : PrewarmState.Missing;
}

/** The toolchain store's one service: status, the install job, pruning, the CLT and locating a lock. */
export class ToolchainService {
  readonly #options: ToolchainServiceOptions;
  readonly #ops: Required<ToolchainStoreOps>;
  /** The running job's end, or null. A second install joins it. */
  #running: Promise<ToolchainInstallJob> | null = null;
  #abort: AbortController | null = null;
  /** The running job, or the last one to finish. */
  #job: ToolchainInstallJob | null = null;
  /** A prune in progress; an install waits for it, so nothing it swaps in is removed underneath it. */
  #pruning: Promise<unknown> | null = null;
  /** The store's size, walked once until an install or prune changes it. */
  #bytes: Promise<number> | null = null;
  /** The store is not this profile's own: prune removes nothing from it. */
  #shared = false;
  /** A developer profile's Rust seed in flight; the Rust lock a build asks for waits for it. */
  #seeding: Promise<RustSeedOutcome | null> | null = null;

  constructor(options: ToolchainServiceOptions) {
    this.#options = options;
    this.#ops = { ...TOOLCHAIN_STORE, ...options.ops };
  }

  /**
   * The host, the Command Line Tools, what is installed, the current lock, the job, the store's
   * size, whether each destination's prewarm is current, and the parts with no download yet.
   */
  async status(): Promise<ToolchainStatus> {
    const { store } = this.#options;
    const [clt, receipts, lock, storeBytes] = await Promise.all([
      this.#options.probeClt(),
      this.#ops.readReceipts(store),
      this.#ops.currentLock(store),
      this.#storeBytes(),
    ]);
    const [prewarm, unhosted] = await Promise.all([this.#prewarmStates(lock), this.#unhosted(receipts)]);
    return {
      host: this.#options.host,
      clt,
      installed: receipts.map(({ id, version, sha12, bytes }) => ({ id, version, sha12, bytes })),
      lock,
      job: this.#job,
      storeBytes,
      ...(prewarm ? { prewarm } : {}),
      ...(unhosted ? { unhosted } : {}),
    };
  }

  /**
   * Whether each destination this host builds and prewarm serves is prewarmed for `lock`: ready
   * when the lock locates; stale when its components are all there but the lock folder's
   * `prewarm.json` records another lock, recipe, `genex.cmake` format or headless platform file (an
   * app update); missing otherwise. Nothing without a current lock: there is nothing to judge.
   */
  async #prewarmStates(lock: ToolchainLock | null): Promise<ToolchainStatus["prewarm"] | null> {
    const { host, store } = this.#options;
    if (!host || !lock) return null;
    const built = cppSetupTargets(host);
    const targets = PREWARMED_TARGETS.filter((target) => built.includes(target));
    const recorded = await isRegularFile(path.join(lockFolder(store, lock), PREWARM_FILE));
    const states: Partial<Record<BuildTarget, PrewarmState>> = {};
    for (const target of targets) {
      const found = await this.#ops.locateToolchain(store, lock, [target], this.#locateOptions());
      states[target] = prewarmState(found, recorded);
    }
    return states;
  }

  /**
   * The components this host's destinations need with neither a bundle nor a published download,
   * and why; one the store already holds at its pin is no gap.
   */
  async #unhosted(receipts: readonly ToolchainReceipt[]): Promise<ToolchainStatus["unhosted"] | null> {
    const { host } = this.#options;
    if (!host) return null;
    const gaps: Array<{ id: ToolchainId; reason: ToolchainUnhosted }> = [];
    for (const id of requiredFor(cppSetupTargets(host))) {
      const entry = this.#ops.manifestEntry(id, host);
      const local = entry?.local;
      if (!entry || !local) continue;
      const gap = !isDownloadable(entry) && !holds(receipts, entry, this.#ops.entrySha12(entry));
      if (gap) gaps.push({ id, reason: local.reason });
    }
    return gaps;
  }

  /** This computer's pinned downloads and the store disk's free space, for the Toolchain sheet. */
  async plan(): Promise<ToolchainPlan> {
    const { host, store } = this.#options;
    // A tool is keyed by its host; a destination artifact (host null) serves every host.
    const servesHost = (entry: ToolchainEntry) => host !== null && (entry.host === host || entry.host === null);
    const downloads = this.#ops.manifest
      .filter((entry) => servesHost(entry) && isDownloadableEntry(entry))
      .map((entry): ToolchainDownload => {
        // A component the app bundles downloads nothing; its copy takes its own size on disk.
        if (isBundled(entry))
          return { id: entry.id, version: entry.version, bytes: 0, diskBytes: entry.local?.bytes ?? 0, bundled: true };
        const bytes = entry.archives.reduce((sum, archive) => sum + archive.bytes, 0);
        // The install's own disk check (`install.ts`) counts the same: each archive unpacked, plus the reserve.
        return { id: entry.id, version: entry.version, bytes, diskBytes: unpackedBytes(bytes) };
      });
    const freeBytes = await (this.#options.freeBytes ?? diskFreeBytes)(store).catch(() => null);
    return { downloads, freeBytes, reserveBytes: DISK_RESERVE_BYTES };
  }

  /** Prepares the host's complete C++ set, regardless of the caller's selected game destinations. */
  install(_targets?: readonly BuildTarget[]): Promise<ToolchainInstallJob> {
    // Every caller joins the same complete scope, fixed before a first job can begin.
    const targets = cppSetupTargets(this.#options.host);
    if (this.#running) return this.#running;
    const abort = new AbortController();
    const running = this.#runJob(targets, abort.signal).finally(() => {
      if (this.#running !== running) return;
      this.#running = null;
      this.#abort = null;
    });
    this.#abort = abort;
    this.#running = running;
    return running;
  }

  /** Cancels the running install and waits for it to end; false when none runs. */
  async cancel(): Promise<boolean> {
    const running = this.#running;
    if (!running) return false;
    this.#abort?.abort();
    await running;
    return true;
  }

  /**
   * Removes every installed version neither the current lock nor any game's lock names. It removes
   * nothing, and says why, while an install or another prune runs, before the first lock, when a
   * game records a lock the store cannot read back, or from a store that is not this profile's own.
   */
  async prune(gameLocks?: readonly string[]): Promise<ToolchainPruneResult> {
    if (this.#running || this.#pruning) return keptAll(ToolchainPruneRefusal.Busy);
    const pruning = this.#pruneOnce(gameLocks);
    this.#pruning = pruning;
    try {
      return await pruning;
    } finally {
      this.#pruning = null;
      this.#bytes = null;
    }
  }

  /**
   * From now on prune removes nothing: the store is not this profile's own (the `cpp-game`
   * fixture links it to the developer's store, which other profiles and tests build with).
   */
  markStoreShared(): void {
    this.#shared = true;
  }

  /** Runs `xcode-select --install` (Apple's dialog); false off a Mac or when it could not ask. */
  async installClt(): Promise<boolean> {
    if (this.#options.host !== ToolchainHost.MacArm64) return false;
    const result = await this.#options.exec(XCODE_SELECT, ["--install"], { timeoutMs: CLT_INSTALL_TIMEOUT_MS });
    return result.code === 0;
  }

  /**
   * The lock new games of `stack` (raylib by default) build with, or null before its first install.
   * Given the `project` a build is for, a Rust · wgpu game's own lock instead: the one its last
   * build recorded while the store can read it back ({@link lockForGame}), so an app update that
   * moved the Rust lock on keeps building it, offline, on the toolchain it was made with. A raylib
   * game builds on raylib's current lock, as it always did.
   */
  async currentLock(stack: CompiledStack = GameStack.RaylibCpp, project?: string): Promise<ToolchainLock | null> {
    if (stack === GameStack.RustWgpu) await this.#seeding;
    if (project === undefined || stack !== GameStack.RustWgpu) return this.#ops.currentLock(this.#options.store, stack);
    const recorded = await this.#options.recordedLock?.(project).catch(() => undefined);
    return this.lockForGame(stack, recorded);
  }

  /**
   * The lock a `stack` game builds on: the one it recorded (`recorded`, the lock digest of its
   * last build in the host's own record) while the store can still read it back, so an app update
   * that moved the current lock on never rebuilds it on another toolchain; else the current lock.
   */
  async lockForGame(stack: CompiledStack, recorded: unknown): Promise<ToolchainLock | null> {
    const own = typeof recorded === "string" ? await this.#ops.readRecordedLock(this.#options.store, recorded) : null;
    if (own && stackOfLock(own) === stack) return own;
    return this.#ops.currentLock(this.#options.store, stack);
  }

  /**
   * A developer profile only: seeds this store's Rust · wgpu stack from local artifacts
   * (`rustSeed`): the components the dev lock names, copied and verified from the local Rust
   * store (`rust-seed.ts`), then the base and the Mac and web prewarms built here under the prewarm
   * sandbox, and the lock made current. A store already on the lock is left as it is. A release
   * build, a bad lock, a link, a digest that is not the recorded one or a store that overlaps
   * another is refused before anything is added. One seed runs at a time; null without a source.
   */
  seedRust(): Promise<RustSeedOutcome | null> {
    if (this.#seeding) return this.#seeding;
    const seeding = this.#seedRustOnce().finally(() => {
      if (this.#seeding === seeding) this.#seeding = null;
    });
    this.#seeding = seeding;
    return seeding;
  }

  async #seedRustOnce(): Promise<RustSeedOutcome | null> {
    const source = this.#options.rustSeed;
    if (!source) return null;
    try {
      return await this.#seedRustFrom(source);
    } catch (error) {
      if (error instanceof SeedError)
        return { phase: RustSeedPhase.Refused, refusal: error.refusal, detail: error.message };
      const problem = error instanceof ToolchainError ? error.problem : ToolchainProblem.Prewarm;
      return { phase: RustSeedPhase.Failed, problem, detail: String(error) };
    }
  }

  async #seedRustFrom(source: RustSeedSource): Promise<RustSeedOutcome> {
    const { store, host, releaseBuild = isReleaseBuild() } = this.#options;
    if (releaseBuild) throw new SeedError(SeedRefusal.ReleaseBuild, MESSAGE.releaseSeed);
    if (!host) throw new SeedError(SeedRefusal.NoSource, MESSAGE.noRustHost);
    const lock = await readSeedLock(source.lockFile);
    const targets = await this.#rustSeedTargets(lock);
    if (await this.#rustSeeded(lock, targets, source)) return { phase: RustSeedPhase.Current, lock: lock.digest };
    if (!this.#options.prewarmSandbox || (this.#options.prewarmDenyWrite ?? []).length === 0)
      throw new ToolchainError(ToolchainProblem.Prewarm, MESSAGE.noPrewarmSandbox);
    await this.#assertRustSeedSpace();
    const seeded = await seedRustComponents({ from: source.from, to: store, lock, host, forbidden: source.forbidden });
    this.#bytes = null;
    const prewarmed = await this.#rustBaseAndPrewarm(lock, targets, source);
    await writeCurrentLock(store, lock, GameStack.RustWgpu);
    const skipped = RUST_SEED_TARGETS.filter((target) => !prewarmed.includes(target));
    return { phase: RustSeedPhase.Seeded, lock: lock.digest, ...seeded, prewarmed, skipped };
  }

  /**
   * Refuses a seed, typed `disk-space`, before anything is added when the store's disk has no room
   * for the eager store it builds (components, base and prewarms): a seed that ran the disk out
   * midway would leave the whole computer without space, and the next seed tries again.
   */
  async #assertRustSeedSpace(): Promise<void> {
    const needed = RUST_EAGER_STORE_BUDGET_BYTES + DISK_RESERVE_BYTES;
    const free = await (this.#options.freeBytes ?? diskFreeBytes)(await nearestExisting(this.#options.store));
    if (free < needed) throw new ToolchainError(ToolchainProblem.DiskSpace, MESSAGE.noSeedSpace(needed, free));
  }

  /** The Rust destinations a seed prewarms here: those the lock serves, the Mac only on a Mac with the Command Line Tools. */
  async #rustSeedTargets(lock: ToolchainLock): Promise<BuildTarget[]> {
    const required = STACK_REQUIRED_COMPONENTS[GameStack.RustWgpu];
    const served = (target: BuildTarget) => required[target].every((id) => lock.entries[id] !== undefined);
    const targets = RUST_SEED_TARGETS.filter(served);
    if (!targets.includes(BuildTarget.Mac)) return targets;
    const builds = this.#options.host === ToolchainHost.MacArm64 && (await this.#options.probeClt()).present;
    return builds ? targets : targets.filter((target) => target !== BuildTarget.Mac);
  }

  /** Whether this store already builds `lock`: its current Rust lock, its base and every seeded destination's prewarm. */
  async #rustSeeded(lock: ToolchainLock, targets: readonly BuildTarget[], source: RustSeedSource): Promise<boolean> {
    const { store } = this.#options;
    if ((await readCurrentLock(store, GameStack.RustWgpu))?.digest !== lock.digest) return false;
    if (!(await readRustBase(store, lock))) return false;
    for (const target of targets) {
      const found = await locateRust(store, lock, target, { rustflags: source.rustflags });
      if (!found.ok) return false;
    }
    return true;
  }

  /**
   * Assembles the base when the store has none and prewarms each of `targets` it has not, under
   * the prewarm sandbox; answers the destinations prewarmed. A prewarm that fails leaves that
   * destination to build cold (the lane needs only the base) and the next seed tries it again.
   */
  async #rustBaseAndPrewarm(
    lock: ToolchainLock,
    targets: readonly BuildTarget[],
    source: RustSeedSource,
  ): Promise<BuildTarget[]> {
    const { store, prewarmSandbox, prewarmDenyWrite = [] } = this.#options;
    if (!prewarmSandbox) throw new ToolchainError(ToolchainProblem.Prewarm, MESSAGE.noPrewarmSandbox);
    const sandbox = await prewarmSandbox();
    try {
      const deps = { run: sandbox.run, denyWrite: prewarmDenyWrite, now: this.#options.now };
      if (!(await readRustBase(store, lock))) await installRustBase(store, lock, deps);
      const project = await source.warmProject();
      if (!project) throw new ToolchainError(ToolchainProblem.Prewarm, MESSAGE.noWarmProject);
      const prewarmed: BuildTarget[] = [];
      for (const target of targets) {
        const rustflags = source.rustflags ?? [];
        const ready = (await locateRust(store, lock, target, { rustflags })).ok;
        const tools = target === BuildTarget.Mac;
        const warmed = ready || (await this.#prewarmRustTarget(lock, target, project, { ...deps, rustflags, tools }));
        if (warmed) prewarmed.push(target);
      }
      return prewarmed;
    } finally {
      await sandbox.dispose();
    }
  }

  /** One Rust prewarm; a refused one (typed) answers false, so the base and the other destinations stand. */
  async #prewarmRustTarget(
    lock: ToolchainLock,
    target: BuildTarget,
    project: RustWarmProject,
    deps: Parameters<typeof prewarmRust>[4],
  ): Promise<boolean> {
    try {
      await prewarmRust(this.#options.store, lock, target, project, deps);
      return true;
    } catch (error) {
      if (error instanceof ToolchainError) return false;
      throw error;
    }
  }

  /**
   * The paths a build of `targets` needs under `lock`, or what is missing: with `stale` when the
   * lock folder records a prewarm an older Genex made, and `notHosted` when a missing component has
   * no download yet, so the stage says what the person can do about it.
   */
  async locate(lock: ToolchainLock, targets: readonly BuildTarget[]): Promise<LocateResult> {
    const found = await this.#ops.locateToolchain(this.#options.store, lock, targets, this.#locateOptions());
    if (found.ok) return found;
    if (found.needsPrewarm) {
      const recorded = await isRegularFile(path.join(lockFolder(this.#options.store, lock), PREWARM_FILE));
      return recorded ? { ...found, stale: true } : found;
    }
    return this.#hasNoDownload(found.missing) ? { ...found, notHosted: true } : found;
  }

  /**
   * The headless platform file a release build prewarms and locates with: its resources' copy.
   * Source and developer builds name none, so the store reads the checkout's.
   */
  #locateOptions(): LocateOptions {
    const { resources, releaseBuild = isReleaseBuild() } = this.#options;
    return releaseBuild && resources ? { headlessPlatform: headlessPlatformPath(resources) } : {};
  }

  /** Whether any of `missing` is a part Genex pinned but published no download of, for this computer. */
  #hasNoDownload(missing: readonly ToolchainId[]): boolean {
    const { host } = this.#options;
    if (!host) return false;
    return missing.some((id) => {
      const entry = this.#ops.manifestEntry(id, host);
      return entry?.local !== undefined && !isDownloadable(entry);
    });
  }

  async #pruneOnce(gameLocks: readonly string[] | undefined): Promise<ToolchainPruneResult> {
    if (this.#shared) return keptAll(ToolchainPruneRefusal.Shared);
    const kept = await this.#keptLocks(gameLocks);
    if (typeof kept === "string") return keptAll(kept);
    const { store } = this.#options;
    // The crate checker is in no lock; its current pins stay (a refreshed snapshot replaces the old one).
    const checker = this.#options.host ? crateCheckFolders(this.#options.host) : [];
    const keep = new Set([...this.#ops.referencedVersions(kept), ...checker]);
    const pruned = await this.#ops.pruneStore(store, keep);
    const swept = await this.#ops.sweepLockRecords(store, kept);
    return { removed: pruned.removed + swept.removed, bytes: pruned.bytes + swept.bytes };
  }

  /** Every stack's current lock, each once. */
  async #currentLocks(): Promise<ToolchainLock[]> {
    const locks = new Map<string, ToolchainLock>();
    for (const stack of COMPILED_STACKS) {
      const lock = await this.#ops.currentLock(this.#options.store, stack);
      if (lock) locks.set(lock.digest, lock);
    }
    return [...locks.values()];
  }

  /**
   * The locks pruning keeps: every stack's current lock and every lock a game records, read back
   * from the store's lock records; or why it cannot know what some game needs (a game on a lock
   * the store cannot read back keeps everything).
   */
  async #keptLocks(gameLocks: readonly string[] | undefined): Promise<ToolchainLock[] | ToolchainPruneRefusal> {
    const current = await this.#currentLocks();
    const games = gameLocks ?? (await this.#options.gameLocks?.());
    return retainedLocks(current, games, (digest) => this.#ops.readRecordedLock(this.#options.store, digest));
  }

  async #storeBytes(): Promise<number> {
    this.#bytes ??= diskBytesUnder(this.#options.store);
    return this.#bytes;
  }

  #iso(): string {
    return new Date(this.#options.now?.() ?? Date.now()).toISOString();
  }

  /** Records and announces the job. */
  #update(job: ToolchainInstallJob): void {
    this.#job = job;
    this.#options.emit({ ...job });
  }

  /** Ends the job: stamped, announced, and on anything but success with no staging left behind. */
  async #finish(end: JobEnd): Promise<ToolchainInstallJob> {
    const previous = this.#job;
    const job: ToolchainInstallJob = {
      phase: end.phase,
      entry: end.entry === undefined ? (previous?.entry ?? null) : end.entry,
      completed: previous?.completed ?? 0,
      total: previous?.total ?? 0,
      startedAt: previous?.startedAt ?? this.#iso(),
      finishedAt: this.#iso(),
      ...(end.problem ? { problem: end.problem } : {}),
      ...(end.unavailable?.length ? { unavailable: end.unavailable } : {}),
    };
    if (end.phase !== ToolchainInstallPhase.Installed)
      await rm(path.join(this.#options.store, STAGING_FOLDER), { recursive: true, force: true }).catch(() => {});
    this.#bytes = null;
    this.#update(job);
    return job;
  }

  /**
   * The manifest entries `targets` need, each downloadable or already in the store at its pin (a
   * local artifact the developer's store holds), or the first one that is neither and why.
   */
  #downloadableEntries(
    host: ToolchainHost,
    targets: readonly BuildTarget[],
    receipts: readonly ToolchainReceipt[],
  ): ToolchainEntry[] | NonNullable<InstallPlan["unpinned"]> {
    const entries: ToolchainEntry[] = [];
    for (const id of requiredFor(targets)) {
      const entry = this.#ops.manifestEntry(id, host);
      const held = entry !== null && isPinned(entry) && holds(receipts, entry, this.#ops.entrySha12(entry));
      if (!held && !isDownloadableEntry(entry)) return { id, problem: missingDownload(entry) };
      if (entry) entries.push(entry);
    }
    return entries;
  }

  /**
   * What an install of `targets` can install: the entries of every destination whose components
   * all have a download or are already in the store, the destinations that do not, and the first
   * component without one. Bundled artifacts install from the app; an artifact with neither a
   * bundle nor a published download leaves its destination out unless the store holds its pin.
   */
  #installable(
    host: ToolchainHost,
    targets: readonly BuildTarget[],
    receipts: readonly ToolchainReceipt[],
  ): InstallPlan {
    const entries = new Map<ToolchainId, ToolchainEntry>();
    const unavailable: BuildTarget[] = [];
    let unpinned: InstallPlan["unpinned"] = null;
    for (const target of BUILD_TARGETS.filter((item) => targets.includes(item))) {
      const found = this.#downloadableEntries(host, [target], receipts);
      if (Array.isArray(found)) for (const entry of found) entries.set(entry.id, entry);
      else {
        unavailable.push(target);
        unpinned ??= found;
      }
    }
    return { entries: [...entries.values()], unavailable, unpinned };
  }

  /** One install, start to end. It never throws: every failure is the job's typed end. */
  async #runJob(targets: readonly BuildTarget[] | undefined, signal: AbortSignal): Promise<ToolchainInstallJob> {
    const startedAt = this.#iso();
    this.#update({ phase: ToolchainInstallPhase.Preflight, entry: null, completed: 0, total: 0, startedAt });
    try {
      return await this.#finish(await this.#install(targets, signal, startedAt));
    } catch (error) {
      if (signal.aborted) return this.#finish({ phase: ToolchainInstallPhase.Cancelled });
      const phase = this.#job?.phase ?? ToolchainInstallPhase.Preflight;
      const problem =
        error instanceof ToolchainError ? error.problem : (PHASE_PROBLEM[phase] ?? ToolchainProblem.Download);
      return this.#finish({ phase: ToolchainInstallPhase.Failed, problem });
    }
  }

  /** Preflight, the downloads, prewarm and the current lock; answers how the job ends. */
  async #install(targets: readonly BuildTarget[] | undefined, signal: AbortSignal, startedAt: string): Promise<JobEnd> {
    const { host, store } = this.#options;
    if (!host) throw new ToolchainError(ToolchainProblem.UnsupportedHost, MESSAGE.unsupportedHost);
    const wanted = targets ?? cppSetupTargets(host);
    if (wanted.length === 0) throw new ToolchainError(ToolchainProblem.UnsupportedHost, MESSAGE.unsupportedHost);
    await this.#pruning;
    const receipts = await this.#ops.readReceipts(store);
    // A destination still waiting for a pin never holds back the others: they install, it is named.
    const { entries, unavailable, unpinned } = this.#installable(host, wanted, receipts);
    if (unpinned && entries.length === 0)
      return { phase: ToolchainInstallPhase.Failed, problem: unpinned.problem, entry: unpinned.id, unavailable };
    const clt = wanted.includes(BuildTarget.Mac) ? await this.#options.probeClt() : { present: false };
    if (!clt.present && wanted.includes(BuildTarget.Mac) && !unavailable.includes(BuildTarget.Mac))
      unavailable.push(BuildTarget.Mac);
    unavailable.sort((a, b) => BUILD_TARGETS.indexOf(a) - BUILD_TARGETS.indexOf(b));
    const missing = entries.filter((entry) => !holds(receipts, entry, this.#ops.entrySha12(entry)));
    if (missing.length > 0) {
      const done = await this.#ops.installComponents(store, missing, this.#installDeps(signal, startedAt));
      signal.throwIfAborted();
      if (done.phase === ToolchainInstallPhase.Cancelled) return { phase: ToolchainInstallPhase.Cancelled };
      if (done.phase === ToolchainInstallPhase.Failed)
        return { phase: done.phase, problem: done.problem ?? ToolchainProblem.Download, entry: done.entry };
    }
    const lock = await this.#nextLock(entries);
    await this.#prewarm(lock, signal, startedAt, clt.present);
    signal.throwIfAborted();
    await this.#ops.writeCurrentLock(store, lock);
    return { phase: ToolchainInstallPhase.Installed, entry: null, unavailable };
  }

  /**
   * Prewarms every destination the new lock can build that prewarm serves (a lock's digest covers
   * all its entries, so adding a Mac component re-prewarms the web too), unless the store already
   * holds those outputs for this lock. Its commands run in a sandbox of its own, never the core's.
   */
  async #prewarm(lock: ToolchainLock, signal: AbortSignal, startedAt: string, cltPresent: boolean): Promise<void> {
    const { store, prewarmSandbox, prewarmDenyWrite = [] } = this.#options;
    const servable = (target: BuildTarget) => REQUIRED_COMPONENTS[target].every((id) => lock.entries[id]);
    const supported = cppSetupTargets(this.#options.host);
    const targets = PREWARMED_TARGETS.filter(
      (target) => supported.includes(target) && servable(target) && (target !== BuildTarget.Mac || cltPresent),
    );
    if (targets.length === 0 || (await this.#ops.locateToolchain(store, lock, targets, this.#locateOptions())).ok)
      return;
    if (await this.#seeded(lock, targets)) return;
    if (!prewarmSandbox || prewarmDenyWrite.length === 0)
      throw new ToolchainError(ToolchainProblem.Prewarm, MESSAGE.noPrewarmSandbox);
    this.#update({ phase: ToolchainInstallPhase.Prewarming, entry: null, completed: 0, total: 0, startedAt });
    const sandbox = await prewarmSandbox();
    try {
      await this.#ops.prewarm(store, lock, targets, {
        run: sandbox.run,
        denyWrite: prewarmDenyWrite,
        now: this.#options.now,
        signal,
        ...this.#locateOptions(),
      });
    } finally {
      await sandbox.dispose();
    }
    // A developer profile may seed from these outputs later; outputs a manifest cannot list stay unseedable.
    await this.#ops.writePrewarmManifest(store, lock).catch(() => null);
  }

  /**
   * A developer profile's store: whether seeding the lock folder from the normal profile's
   * (`seedFrom`) left `targets` located, so no prewarm runs. A refused seed (no manifest, a
   * tampered one, outputs that name the normal store) is no error: the prewarm runs as always.
   */
  async #seeded(lock: ToolchainLock, targets: readonly BuildTarget[]): Promise<boolean> {
    const { store, seedFrom } = this.#options;
    if (!seedFrom) return false;
    try {
      await this.#ops.seedPrewarm({ from: seedFrom, to: store, lock });
    } catch (error) {
      if (error instanceof SeedError) return false;
      throw error;
    }
    return (await this.#ops.locateToolchain(store, lock, targets, this.#locateOptions())).ok;
  }

  /** What the substrate's install is given; its progress is announced, its end is the service's. */
  #installDeps(signal: AbortSignal, startedAt: string): InstallDeps {
    return {
      fetch: this.#options.fetch ?? ((url, init) => fetch(url, init)),
      run: this.#options.run,
      freeBytes: this.#options.freeBytes ?? diskFreeBytes,
      onJob: ({ phase, entry, completed, total }) => {
        if (isInstallRunning({ phase })) this.#update({ phase, entry, completed, total, startedAt });
      },
      signal,
      now: this.#options.now,
      resources: this.#options.resources,
      ...(this.#options.downloadCache ? { downloadCache: this.#options.downloadCache } : {}),
    };
  }

  /**
   * The crate checker's tools at the recipe's pins and the shipped `policy`'s snapshot (crate
   * requests): located in the store, else first installed there from their pinned downloads. Only
   * the person's approval of a crate reaches this, so the network it may open is theirs, as the
   * crate's own fetch is. Null when this host has no pins, an install job or a prune is running, or
   * the install fails. No lock names them and no build waits on them.
   */
  async crateCheckTools(policy: CratePolicy): Promise<CrateCheckTools | null> {
    const { host, store } = this.#options;
    if (!host) return null;
    const found = await locateCrateCheckTools(store, host, policy);
    if (found || this.#running || this.#pruning) return found;
    const entries = crateCheckEntries(host);
    const receipts = await this.#ops.readReceipts(store);
    const missing = entries.filter((entry) => !holds(receipts, entry, this.#ops.entrySha12(entry)));
    if (missing.length === 0) return null;
    // Its own quiet install: the Toolchain sheet's job is the setup's, not this one's.
    const deps = { ...this.#installDeps(new AbortController().signal, this.#iso()), onJob: () => {} };
    const done = await this.#ops.installComponents(store, missing, deps);
    this.#bytes = null;
    if (done.phase !== ToolchainInstallPhase.Installed) return null;
    return await locateCrateCheckTools(store, host, policy);
  }

  /** The crate checker's sandbox for one vendor job ({@link ToolchainServiceOptions.crateCheckSandbox}). */
  async crateCheckSandbox(spec: { writes: string; reads: readonly string[] }): Promise<CrateCheckSandbox> {
    const open = this.#options.crateCheckSandbox;
    if (!open) throw new Error(MESSAGE.noCrateCheckSandbox);
    return await open(spec);
  }

  /** The current lock with `entries` pinned in it: what new games build with once this install ends. */
  async #nextLock(entries: readonly ToolchainEntry[]): Promise<ToolchainLock> {
    const previous = await this.#ops.currentLock(this.#options.store);
    const pins: ToolchainLock["entries"] = { ...previous?.entries };
    for (const entry of entries) pins[entry.id] = { version: entry.version, sha12: this.#ops.entrySha12(entry) };
    return this.#ops.lockOf(pins);
  }
}
