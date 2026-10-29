/**
 * The C++ build lane (`CppBuilds`): a C++ · raylib game built out of source, per destination and
 * toolchain lock, into `<root>/<project>-<sha12(realroot)>/<target>-<lockDigest12>/`, whose `out/`
 * is the only thing Live serves and the exporters and the native runs read: for the web
 * `index.html`, `index.js`, `index.wasm` and `index.data`; for the Mac exactly `game`, `game-headless`
 * and `assets/`; for Windows and Linux, cross-built with the store's zig on a Mac or Linux host,
 * `game.exe` or `game` beside `assets/`, admitted through the PE or ELF gate before anything may
 * use it (never served: Live serves the web build only). Host-fixed argv and env, the source
 * root write-denied while it builds, no domain opened for it, typed refusals before anything runs;
 * a Mac build without the Command Line Tools is refused `clt-missing` before anything is made.
 *
 * The folder is never wiped: CMake's cache, Ninja's log and the objects in it are what make the
 * next build incremental. An in-tree `build/` is the agent's scratch and is never served.
 *
 * A build run writes its own folder, so the host trusts no name in it: every folder on the way is
 * checked to be a real one (a link planted there is removed, never followed), host files are
 * written by rename, read only when they are regular files, and the wrapper the build runs lives
 * outside every build folder. The root is the host's own (`layout.cppBuilds`, under no writable
 * root), so only a build's own run writes anything in it, and only its own folder. The assets a
 * build takes are the host's copy beside that folder (`cpp-assets.ts`), never `assets/` itself, and
 * a Mac `out/` is trimmed only once moved beside it, where no build run writes.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, realpath, rename, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { StudioPlatform } from "../shared/boot.ts";
import {
  type BuildDiagnostic,
  BuildPhase,
  type BuildProblem,
  BuildProblemCode,
  CppBuildPurpose,
  DiagnosticTool,
} from "../shared/build-problem.ts";
import { MINUTE_MS } from "../shared/duration.ts";
import { errorMessage } from "../shared/errors.ts";
import { BuildTarget, DESKTOP_TARGETS, type GameDestinations, type ProjectShape } from "../shared/game-project.ts";
import { buildRefusal, crossCheckBadge, DestinationBadge, hostOf } from "../shared/game-targets.ts";
import {
  type DestinationCheck,
  NATIVE_CROSS_EXECUTABLES,
  NATIVE_MAC_EXECUTABLES,
  type NativeRefusal,
} from "../shared/native-contract.ts";
import { cppLaneRunsOn, ToolchainId, type ToolchainLock } from "../shared/toolchain.ts";
import type { UiEventMap } from "../shared/ui-events.ts";
import { atomicWriteText, pathExists, readRegularFile } from "../substrate/fsx.ts";
import {
  admitCrossOutput,
  crossAdmissionFacts,
  type CrossAdmission,
  type DesktopTarget,
} from "../substrate/native-cross-admission.ts";
import { isInside, toPosixRelative } from "../substrate/paths.ts";
import { literalGlob, type RunRequest, type RunResult, type SandboxPolicy, shellQuote } from "../substrate/spawn.ts";
import { crossBuildEnv } from "../substrate/toolchain-store/cross-targets.ts";
import { MAC_ASSETS_MARKER, readRecipe, targetRecipe } from "../substrate/toolchain-store/genex-cmake.ts";
import {
  execXcode,
  type LocatedToolchain,
  type LocateResult,
  macSdkPath,
  type XcodeExec,
} from "../substrate/toolchain-store/locate.ts";
import { isLockDigest } from "../substrate/toolchain-store/lock.ts";
import { stageAssets } from "./cpp-assets.ts";
import { type BuildOutcome, outputLines } from "./game-build.ts";

const execFileAsync = promisify(execFile);

const MESSAGE = {
  noOutput: (files: readonly string[]) =>
    `the build finished but left no ${files.map((file) => `out/${file}`).join(" and ")} in its own folder`,
  linked: (where: string) => `${where} is a link or not a folder, and the build lane never works through one`,
  noCrossFiles: (target: string) => `the toolchain has no ${target} cross files`,
} as const;

/** Why a build is made (`shared/build-problem.ts`), kept where the lane's callers import it from. */
export { CppBuildPurpose };

/** How long a CMake configure may run. */
export const CPP_CONFIGURE_TIMEOUT_MS = 3 * MINUTE_MS;

/** How long `cmake --build` may run, per destination. */
export const CPP_BUILD_TIMEOUT_MS = {
  [BuildTarget.Web]: 15 * MINUTE_MS,
  [BuildTarget.Mac]: 10 * MINUTE_MS,
  [BuildTarget.Windows]: 15 * MINUTE_MS,
  [BuildTarget.Linux]: 15 * MINUTE_MS,
  // raylib builds no mobile destination (no host matrix row lists one); the rows keep the table exhaustive.
  [BuildTarget.Ios]: 15 * MINUTE_MS,
  [BuildTarget.Android]: 15 * MINUTE_MS,
} as const satisfies Record<BuildTarget, number>;

/** How many cores one build gets before a second may run beside it (`CPP_BUILDS_MAX = cores / 4`). */
const CORES_PER_BUILD = 4;
/** How many diagnostics a problem keeps: the stage has room for three. */
const DIAGNOSTICS_KEPT = 3;
/** How many output lines a problem keeps, as a browser game's build problem does. */
const PROBLEM_LINES = 3;
/** The longest diagnostic message the stage is given. */
const DIAGNOSTIC_MAX_CHARS = 400;

/** The most of a CMake cache the host reads back to move it; a bigger one is dropped and CMake starts afresh. */
const CMAKE_CACHE_MAX_BYTES = 16 * 1024 * 1024;
/** The most of a built stamp (one source path) the host reads. */
const STAMP_MAX_BYTES = 64 * 1024;

/** The folder genex.cmake writes the game into, inside the build folder: the only served output. */
const OUTPUT_DIR = "out";
/**
 * Beside a Mac build folder (`<target>-<digest12>.out`): its `out/` while the host trims it, where
 * no build run can write.
 */
const OUTPUT_ASIDE = ".out";
/** The page Live loads from `out/`. */
export const CPP_ENTRY = "index.html";
/** The Mac build's two executables, which its `out/` must hold beside `assets/`. */
const MAC_EXECUTABLES: readonly string[] = Object.values(NATIVE_MAC_EXECUTABLES);
/** The folder of a Mac build's `out/` that holds its copied assets. */
const MAC_ASSETS_DIR = "assets";
/** CMake's cache: in the source root, an in-source configure the lane refuses; in a seeded build folder, moved. */
const CMAKE_CACHE = "CMakeCache.txt";
/** The build folder's private Emscripten cache, cloned once from the lock's prewarmed one. */
const EM_CACHE_DIR = "em-cache";
/** Clang's module cache, kept in the build folder instead of the home folder. */
const MODULE_CACHE_DIR = "clang-module-cache";
/**
 * Host-written helpers the web builds run (the `-B` Python wrapper), per lock, in the root beside
 * the build folders: never inside one, which its build run can write.
 */
const TOOLS_DIR = ".genex-tools";
const PYTHON_WRAPPER = "python3";
/** Which folder a worker's first build folder was cloned from. */
const SEEDED_FROM = ".seeded-from";
/**
 * Written beside a build folder (`<target>-<digest12>.built`) after a build that worked: the
 * source root it built, so a worker can be seeded from it. Beside it, so its own run cannot forge it.
 */
const BUILT_STAMP = ".built";
/**
 * Beside a Windows or Linux build folder (`<target>-<digest12>.admitted`), written after the gate
 * admitted its `out/`: the sha256 of the executable it admitted. Only an `out/` whose executable
 * still has it is a build to fall back on; a refusal removes it. Beside it, so no build run forges it.
 */
const ADMITTED_STAMP = ".admitted";
/** The most of a cross build's executable the host hashes against its admitted stamp (the PE gate's own cap). */
const CROSS_EXE_MAX_BYTES = 512 * 1024 * 1024;
/** zig's global and local caches, inside the build folder: zig otherwise writes the home folder's. */
const ZIG_CACHE_DIR = "zig-cache";
/**
 * How much of a Windows or Linux run's output the sandbox keeps: a new build folder's first build
 * has zig build libc++ for the target, which prints some 5 MB of its own warnings (zig 0.16.0)
 * before the game's own error, which the problem must still name.
 */
const CROSS_OUTPUT_MAX_CHARS = 8 * 1024 * 1024;
/**
 * Beside a build folder (`<target>-<digest12>.assets`): the copy of the game's assets a build
 * takes (`cpp-assets.ts`), written by the host only, so no build run edits what the next one takes.
 */
const ASSETS_STAGE = ".assets";
/**
 * Beside the stage (`<target>-<digest12>.assets.stamp`): what it holds, rewritten whenever that
 * changed, so the web link re-runs for a replaced or removed asset whatever its time.
 */
const ASSETS_STAMP = ".stamp";
/** What the web link packs the stage into: dropped from `out/` once the stage is empty. */
const PACKED_ASSETS = "index.data";
/**
 * Beside a build folder (`<target>-<digest12>.source`), written before the folder is made: the
 * source root it builds, so a sweep knows a worktree's folder once the worktree is gone.
 */
const SOURCE_STAMP = ".source";
/** A fresh folder a clone is copied into, made exclusively, before it is renamed into place. */
const CLONE_PREFIX = ".clone-";
/** The system's own tools, after the store's: a shell, `cp`, `env`, never a package manager's. */
const SYSTEM_PATH = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
/** The host's `cp`, which clones on APFS (`-c`) and on btrfs/XFS (`--reflink=auto`). */
const CP = "/bin/cp";
/** A dependency fetched at configure time would open the network: CMake is told never to. */
const FETCH_DISCONNECTED = "-DFETCHCONTENT_FULLY_DISCONNECTED=ON";
/** A build folder of one project: `<project>-<sha12>`. */
const PROJECT_FOLDER = /^(.+)-[0-9a-f]{12}$/;
/** One destination's build folder for one lock inside a project's: `<target>-<digest12>`. */
const BUILD_FOLDER = /^(web|macos|windows|linux)-([0-9a-f]{12})$/;
/** A lock's helpers folder under {@link TOOLS_DIR}: `<digest12>`. */
const TOOLS_FOLDER = /^[0-9a-f]{12}$/;
/** A project name that is one plain path segment; any other is foldered as {@link UNNAMED_PROJECT}. */
const SAFE_PROJECT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const UNNAMED_PROJECT = "game";

/** One build: the game, where its sources are, the destination, and the lock to build with. */
export interface CppBuildInput {
  project: string;
  /** Where the sources are: the game folder, or a worktree the app made. */
  dir: string;
  shape: ProjectShape;
  target: BuildTarget;
  /** The game's destinations: a desktop target outside them is `NotADestination` (Web always builds). */
  destinations: GameDestinations;
  purpose: CppBuildPurpose;
  /** The lock to build with; null is the store's current lock. */
  lock: ToolchainLock | null;
  /**
   * `dir` is the game folder itself, whose lock a build that worked records in the host's library
   * (`writeLock`). A worktree's or a snapshot's build records nothing.
   */
  recordLock?: boolean;
}

/** Everything the lane reaches, injected: the sandbox, the store, the progress sink and the host facts. */
export interface CppBuildsOptions {
  /** Where build folders live: the host's own `layout.cppBuilds`, which no agent process can write. */
  root: string;
  /** Every configure and build runs here: `ProcessSandbox.run`. */
  run: (request: RunRequest) => Promise<RunResult>;
  locate: (lock: ToolchainLock, targets: readonly BuildTarget[]) => Promise<LocateResult>;
  currentLock: () => Promise<ToolchainLock | null>;
  emit: (progress: UiEventMap["build.progress"]) => void;
  platform: NodeJS.Platform;
  /** Caps concurrent builds and `ninja -j`. */
  cores: number;
  /** Paths every build policy write-denies besides the source root (the store, the native runs). */
  denyWrite: readonly string[];
  /** Records the lock digest a build of the game folder used, in the host's library (`GameWorkspaces.writeNativeLock`). */
  writeLock: (project: string, digest: string) => Promise<void>;
  /** Admits a Windows or Linux build's `out/` through the PE or ELF gate (default: `admitCrossOutput`); a test stands one in. */
  admitCross?: typeof admitCrossOutput;
  /**
   * Records a desktop build's check of the game folder in the host's library
   * (`GameWorkspaces.writeNativeCheck`, then `game.changed`); absent, no check is recorded.
   */
  writeCheck?: (project: string, target: BuildTarget, check: DestinationCheck) => Promise<void>;
  /** The host's `cp` the clones run (default `/bin/cp`); a test stands a slow one in. */
  cp?: string;
  /**
   * Runs `xcode-select -p` and `xcrun --show-sdk-path` for a Mac build's SDK, outside the sandbox
   * (default: `execFile`); a test stands in for the Command Line Tools.
   */
  exec?: XcodeExec;
  /** The clock progress and problems are stamped with (default: `Date.now`). */
  now?: () => number;
}

/** How many C++ builds may run at once on `cores` cores (`CPP_BUILDS_MAX`). */
export function cppBuildsMax(cores: number): number {
  return Math.max(1, Math.floor(usableCores(cores) / CORES_PER_BUILD));
}

/** The `-j` every `cmake --build` carries: the cores shared among the builds that may run at once. */
export function cppBuildJobs(cores: number): number {
  return Math.max(1, Math.floor(usableCores(cores) / cppBuildsMax(cores)));
}

function usableCores(cores: number): number {
  return Number.isFinite(cores) && cores >= 1 ? Math.floor(cores) : 1;
}

/**
 * Why a store that located no toolchain cannot build: its first build prepared by an older Genex
 * (set it up again), every tool installed but the first build never prepared (set it up), a part
 * with no download yet (nothing to install), or tools to install.
 */
export function toolchainRefusal(located: {
  ok: false;
  needsPrewarm?: true;
  stale?: true;
  notHosted?: true;
}): BuildProblemCode {
  if (located.stale) return BuildProblemCode.ToolchainStale;
  if (located.needsPrewarm) return BuildProblemCode.ToolchainUnprepared;
  return located.notHosted ? BuildProblemCode.ToolchainNotHosted : BuildProblemCode.ToolchainMissing;
}

/** A build problem that ran nothing: the reason is the whole story, `lines` the facts behind it. */
export function refusalProblem(refusal: {
  project: string;
  target: BuildTarget;
  reason: BuildProblemCode;
  lines?: string[];
  showingLastBuild?: boolean;
  at: string;
}): BuildProblem {
  return {
    project: refusal.project,
    command: "",
    code: null,
    lines: refusal.lines ?? [],
    needsInstall: false,
    install: null,
    skippedScripts: null,
    showingLastBuild: refusal.showingLastBuild ?? false,
    at: refusal.at,
    reason: refusal.reason,
    target: refusal.target,
  };
}

/** Where one game's build for a destination and lock lives: `<root>/<project>-<sha12(source)>/<target>-<digest12>`. */
export function cppBinaryDir(
  root: string,
  project: string,
  source: string,
  target: BuildTarget,
  lock: ToolchainLock,
): string {
  const key = createHash("sha256").update(source).digest("hex").slice(0, 12);
  return path.join(path.resolve(root), `${projectFolder(project)}-${key}`, `${target}-${lock.digest.slice(0, 12)}`);
}

/** The project's name as a folder name: itself when it is one plain segment, never a path. */
function projectFolder(project: string): string {
  return SAFE_PROJECT.test(project) ? project : UNNAMED_PROJECT;
}

/** One build, resolved: the real source root, its build folder, the lock it builds with and, for the Mac, the SDK. */
interface Pending {
  input: CppBuildInput;
  source: string;
  bin: string;
  lock: ToolchainLock;
  /** `CMAKE_OSX_SYSROOT` of a Mac build; null for every other destination. */
  sdk: string | null;
}

/** A pending build with the toolchain located. */
interface BuildPlan extends Pending {
  toolchain: LocatedToolchain;
  genex: string;
}

/** What both runs of a build share: their environment, policy overlay and label. */
type RunStep = Pick<RunRequest, "env" | "policy" | "label">;

/**
 * A build running (or waiting for a slot), which later looks at the same folder join. Each caller
 * waits on it with its own signal: one that aborts stops only its own wait, and the build is
 * cancelled once no caller waits on it any more (or by `cancelAll`).
 */
interface InFlight {
  /** The game it builds (its folder or a copy of it). */
  project: string;
  controller: AbortController;
  done: Promise<BuildOutcome>;
  /** The callers still waiting on it; one without a signal waits until it ends. */
  waiters: number;
}

/** The C++ build lane: one out-of-source build per game, destination and lock. */
export class CppBuilds {
  readonly options: CppBuildsOptions;
  readonly #inFlight = new Map<string, InFlight>();
  /** Builds waiting for one of the `cppBuildsMax` slots, oldest first. */
  readonly #waiting: Array<() => void> = [];
  #active = 0;
  /** The lock digest last recorded per project, so the library is written once per change. */
  readonly #recorded = new Map<string, string>();
  /** The check last recorded per project and cross destination, so the library is written once per change. */
  readonly #checked = new Map<string, string>();
  /** The sweep running, which a build in flight waits for before it touches the disk. */
  #sweeping: Promise<number> | null = null;
  /** Another sweep was asked for while one ran: it runs once more. */
  #sweepAgain = false;

  constructor(options: CppBuildsOptions) {
    this.options = options;
  }

  /**
   * Configure and build `input` with the host's own argv, and answer the served output or the
   * problem. Refusals (a Mac build off a Mac, a desktop target the game does not name, an
   * in-source configure, a lock the store does not hold) run nothing. A second look at the same
   * folder while it builds shares that build. Each caller's signal ends only its own wait, at once
   * and as `Cancelled`; the shared build is cancelled once every caller waiting on it has aborted.
   */
  async ensure(input: CppBuildInput, options: { signal?: AbortSignal } = {}): Promise<BuildOutcome> {
    const { refused, sdk } = await this.#preflight(input);
    if (refused) return this.#refused(input, refused);
    const source = await realpath(input.dir).catch(() => path.resolve(input.dir));
    const current = input.lock ? { lock: input.lock } : await this.#currentLock();
    const { lock } = current;
    if (!lock) return this.#refused(input, BuildProblemCode.ToolchainMissing, current.why ? [current.why] : []);
    // A digest names the build folder: one that is not the store's hex could name a path.
    if (!isLockDigest(lock.digest)) return this.#refused(input, BuildProblemCode.ToolchainMissing);
    const bin = cppBinaryDir(this.options.root, input.project, source, input.target, lock);
    const running = this.#inFlight.get(bin);
    const joinable = running && !running.controller.signal.aborted;
    const flight = joinable ? running : this.#start({ input, source, bin, lock, sdk }, running ?? null);
    return await this.#wait(flight, input, bin, options.signal);
  }

  /**
   * A new in-flight build of `pending.bin`, known until it settles. A build Stop cancelled can still
   * be in its host-side preparation (a clone): the new one starts once it has settled, never beside it.
   */
  #start(pending: Pending, cancelled: InFlight | null): InFlight {
    const controller = new AbortController();
    const start = () => this.#ensure(pending, controller.signal);
    const done = cancelled ? cancelled.done.then(start, start) : start();
    const flight: InFlight = { project: pending.input.project, controller, done, waiters: 0 };
    this.#inFlight.set(pending.bin, flight);
    const forget = () => {
      if (this.#inFlight.get(pending.bin) === flight) this.#inFlight.delete(pending.bin);
    };
    done.then(forget, forget);
    return flight;
  }

  /**
   * One caller's wait on `flight`: its outcome, or `Cancelled` as soon as the caller's own signal
   * aborts. Only the last caller to leave cancels the build; a leaving caller says nothing on
   * `build.progress`, since the build it leaves goes on (and ends once, for everyone).
   */
  async #wait(flight: InFlight, input: CppBuildInput, bin: string, signal: AbortSignal | undefined) {
    flight.waiters += 1;
    if (!signal) return await flight.done;
    let leave = () => {};
    const left = new Promise<null>((resolve) => {
      leave = () => resolve(null);
      if (signal.aborted) leave();
      else signal.addEventListener("abort", leave, { once: true });
    });
    try {
      const outcome = await Promise.race([flight.done, left]);
      if (outcome) return outcome;
      flight.waiters -= 1;
      if (flight.waiters === 0) flight.controller.abort();
      return this.#left(input, await this.#lastOutput(bin, input.target));
    } finally {
      signal.removeEventListener("abort", leave);
    }
  }

  /**
   * Why `input` cannot build on this computer, before anything is made or run, and a Mac build's
   * SDK: without the Command Line Tools a Mac build is refused `clt-missing`.
   */
  async #preflight(input: CppBuildInput): Promise<{ refused: BuildProblemCode | null; sdk: string | null }> {
    const refused = targetRefusal(input, this.options.platform);
    if (refused || input.target !== BuildTarget.Mac) return { refused, sdk: null };
    const sdk = await macSdkPath(this.options.exec ?? execXcode, this.options.platform);
    return { refused: sdk ? null : BuildProblemCode.CltMissing, sdk };
  }

  /**
   * Composer Stop and the app's stop: aborts every build in flight or waiting; nothing in
   * flight is no error. A cancelled build stays known until it settles, so the next build of its
   * folder waits for it.
   */
  cancelAll(): void {
    for (const flight of this.#inFlight.values()) flight.controller.abort();
  }

  /** Composer Stop: aborts `project`'s builds in flight or waiting, of its folder and every copy; other games' go on. */
  cancelGame(project: string): void {
    for (const flight of this.#inFlight.values()) if (flight.project === project) flight.controller.abort();
  }

  /**
   * Removes the build folders nothing will build again, with what sits beside them: those whose
   * source root is gone (a worktree a night or a Play removed) or unknown, and those of a lock
   * other than the store's current one, whose helpers go too. Each holds a clone of a lock's
   * em-cache. A project with a build in flight is left whole, a build that starts meanwhile waits
   * for the sweep before it touches the disk, and a sweep asked for while one runs runs once more. Nothing is
   * followed through a link. Answers how many build folders went.
   */
  sweep(): Promise<number> {
    if (this.#sweeping) {
      this.#sweepAgain = true;
      return this.#sweeping;
    }
    const sweeping = (async () => {
      let removed = 0;
      do {
        this.#sweepAgain = false;
        removed += await this.#sweepOnce();
      } while (this.#sweepAgain);
      return removed;
    })().finally(() => {
      this.#sweeping = null;
    });
    this.#sweeping = sweeping;
    return sweeping;
  }

  async #sweepOnce(): Promise<number> {
    const root = path.resolve(this.options.root);
    if (!(await lstat(root).catch(() => null))?.isDirectory()) return 0;
    const { lock } = await this.#currentLock();
    const current = lock && isLockDigest(lock.digest) ? lock.digest.slice(0, 12) : null;
    const busy = new Set([...this.#inFlight.keys()].map((bin) => path.dirname(bin)));
    const busyLocks = new Set([...this.#inFlight.keys()].map((bin) => BUILD_FOLDER.exec(path.basename(bin))?.[2]));
    let removed = 0;
    for (const name of await readdir(root).catch(() => [] as string[])) {
      const folder = path.join(root, name);
      if (!(await lstat(folder).catch(() => null))?.isDirectory()) continue;
      if (name === TOOLS_DIR && current)
        await sweepTools(folder, (digest) => digest !== current && !busyLocks.has(digest));
      else if (PROJECT_FOLDER.test(name) && !busy.has(folder)) removed += await sweepProject(folder, current);
    }
    return removed;
  }

  async #ensure(pending: Pending, signal: AbortSignal): Promise<BuildOutcome> {
    const { input, source, bin } = pending;
    // In flight before it touches the disk: a sweep that started first ends first, and one that
    // starts later leaves this project whole.
    await this.#sweeping?.catch(() => {});
    const lastGood = await this.#lastOutput(bin, input.target);
    const cache = path.join(source, CMAKE_CACHE);
    if (await pathExists(cache)) return this.#refused(input, BuildProblemCode.InSourceBuild, [cache], lastGood);
    // A store that cannot be read is as good as a missing one: the stage says so, not an exception.
    const located = await this.options
      .locate(pending.lock, [input.target])
      .catch((error: unknown): { ok: false; missing: string[] } => ({ ok: false, missing: [errorMessage(error)] }));
    const missing: string[] = located.ok ? missingFrom(located.toolchain, input.target) : located.missing;
    if (!located.ok || missing.length)
      return this.#refused(
        input,
        located.ok ? BuildProblemCode.ToolchainMissing : toolchainRefusal(located),
        missing,
        lastGood,
      );
    const genex = located.toolchain.genexCmake[input.target] ?? "";
    const release = await this.#slot(signal);
    if (!release) return this.#cancelled(input, lastGood);
    try {
      return await this.#build({ ...pending, toolchain: located.toolchain, genex }, signal);
    } catch (error) {
      // Whatever failed host-side or before a run started (a clone, a planted link, a sandbox that
      // would not start), the caller gets an outcome and the stage hears `failed`.
      const last = await this.#lastOutput(bin, input.target);
      if (signal.aborted) return this.#cancelled(input, last);
      return this.#refused(input, BuildProblemCode.CommandFailed, [errorMessage(error)], last);
    } finally {
      release();
    }
  }

  /** Configure, then build, then check `out/` — the two runs in the sandbox, everything else host-side. */
  async #build(plan: BuildPlan, signal: AbortSignal): Promise<BuildOutcome> {
    const { input, bin } = plan;
    this.#emit(input, BuildPhase.Configure);
    const staged = await this.#prepare(plan, signal);
    const step: RunStep & Pick<RunRequest, "maxOutputBytes"> = {
      env: buildEnv(plan, this.#toolsDir(plan)),
      policy: await this.#policy(plan),
      label: `cpp:${input.project}:${input.target}:${input.purpose}`,
      ...(isCrossBuild(input.target) ? { maxOutputBytes: CROSS_OUTPUT_MAX_CHARS } : {}),
    };
    const configure = await this.#run(plan, step, configureCommand(plan), CPP_CONFIGURE_TIMEOUT_MS, signal);
    if (!configure) return this.#cancelled(input, await this.#lastOutput(bin, input.target));
    if (configure.code !== 0) return this.#failed(plan, configure, signal);
    if (signal.aborted) return this.#cancelled(input, await this.#lastOutput(bin, input.target));
    this.#emit(input, BuildPhase.Build);
    const command = buildCommand(plan, cppBuildJobs(this.options.cores));
    const build = await this.#run(plan, step, command, CPP_BUILD_TIMEOUT_MS[input.target], signal);
    if (!build) return this.#cancelled(input, await this.#lastOutput(bin, input.target));
    if (build.code !== 0) return this.#failed(plan, build, signal);
    const planted = input.target === BuildTarget.Mac ? await keepMacOutputs(bin) : null;
    if (planted) return this.#failed(plan, build, signal, planted);
    const output = await this.#builtOutput(bin, input.target);
    if (!output) return this.#failed(plan, build, signal, MESSAGE.noOutput(servedFiles(input.target)));
    const gated = await this.#gateCross(plan, output);
    if (gated) return gated;
    if (staged === 0 && input.target === BuildTarget.Web) await dropStalePack(output, assetsStamp(bin));
    await atomicWriteText(`${bin}${BUILT_STAMP}`, plan.source);
    if (input.recordLock) await this.#recordLock(input.project, plan.lock.digest);
    this.#emit(input, BuildPhase.Done);
    return { ok: true, output, lastGood: output, problem: null, ran: true };
  }

  /** One run in the sandbox, in the build folder; null when Stop came first: nothing starts after a cancel. */
  async #run(
    plan: BuildPlan,
    step: RunStep,
    command: string,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<RunResult | null> {
    if (signal.aborted) return null;
    // Nothing a build's CMake files start outlives it: the host reads and trims out/ next.
    return await this.options.run({ command, cwd: plan.bin, ...step, timeoutMs, signal, reapGroup: true });
  }

  /**
   * The build folder, ready to run in, every folder on the way a real one: seeded from the lead's
   * when it is new, `out/` a folder or nothing, for the web its own em-cache cloned once from the
   * lock's and the lock's Python wrapper written, for Windows and Linux its own zig cache cloned
   * once from the lock's prewarmed one, and the assets staged for the web and the Mac
   * (how many: null for a build that stages none). All host-side, on paths the host chose.
   */
  async #prepare(plan: BuildPlan, signal: AbortSignal): Promise<number | null> {
    const root = path.resolve(this.options.root);
    await mkdir(path.dirname(root), { recursive: true });
    await ownFolder(root);
    await ownFolder(path.dirname(plan.bin));
    await atomicWriteText(`${plan.bin}${SOURCE_STAMP}`, plan.source);
    await ownFolder(plan.bin, () => this.#seed(plan, signal));
    // What genex.cmake makes; anything else at its name would be served from wherever it points.
    await dropUnlessFolder(path.join(plan.bin, OUTPUT_DIR));
    const emscripten = webEmscripten(plan);
    if (emscripten) {
      signal.throwIfAborted();
      const cache = path.join(plan.bin, EM_CACHE_DIR);
      await ownFolder(cache, () => cloneTree(emscripten.cache, cache, this.#copier(signal)));
      signal.throwIfAborted();
      await this.#writeWrapper(plan, emscripten.python);
    }
    const zigCache = crossZigCache(plan);
    if (zigCache) {
      signal.throwIfAborted();
      const cache = path.join(plan.bin, ZIG_CACHE_DIR);
      await ownFolder(cache, () => cloneTree(zigCache, cache, this.#copier(signal)));
    }
    if (copiesAssets(plan.input.target)) await forgetGoneAssets(plan.bin);
    const stages = emscripten !== null || copiesAssets(plan.input.target);
    const staged = stages ? await stageAssets(plan.source, assetsStage(plan.bin), assetsStamp(plan.bin)) : null;
    if (!(await realFolders(root, plan.bin))) throw new Error(MESSAGE.linked(plan.bin));
    return staged;
  }

  /**
   * The lock's `-B` Python wrapper. emcc starts Python with -E, which ignores
   * PYTHONDONTWRITEBYTECODE: -B keeps `__pycache__` out of the store (write-denied in the app,
   * and shared by every build). Written by rename, so a link at its name is replaced, not written through.
   */
  async #writeWrapper(plan: BuildPlan, python: string): Promise<void> {
    const tools = this.#toolsDir(plan);
    await ownFolder(path.dirname(tools));
    await ownFolder(tools);
    await atomicWriteText(path.join(tools, PYTHON_WRAPPER), `#!/bin/sh\nexec ${shellQuote(python)} -B "$@"\n`, {
      mode: 0o755,
    });
  }

  /** How this lane's clones copy: the host's `cp`, cloning where this platform can, ended by `signal`. */
  #copier(signal: AbortSignal): Copier {
    return { cp: this.options.cp ?? CP, platform: this.options.platform, signal };
  }

  /** Where the lock's host-written helpers are: `<root>/.genex-tools/<digest12>`. */
  #toolsDir(plan: Pending): string {
    return path.join(path.resolve(this.options.root), TOOLS_DIR, plan.lock.digest.slice(0, 12));
  }

  /**
   * A worker's first build folder for a lock is a clone of the lead's (the newest folder of the
   * same project, destination and lock that built), so it starts with the em-cache and CMake's
   * compiler checks already done. CMake refuses a cache made for another folder, so the clone's
   * cache is moved to this one; its `out/` goes, so a failing worker never serves the lead's game.
   */
  async #seed(plan: BuildPlan, signal: AbortSignal): Promise<void> {
    const lead = await this.#leadFor(plan);
    if (!lead) {
      await mkdir(plan.bin);
      return;
    }
    await cloneTree(lead.bin, plan.bin, this.#copier(signal));
    try {
      await rm(path.join(plan.bin, OUTPUT_DIR), { recursive: true, force: true });
      await moveBuildCache(plan.bin, lead, plan.source);
      await atomicWriteText(path.join(plan.bin, SEEDED_FROM), `${lead.bin}\n`);
    } catch (error) {
      // A half-seeded folder would keep a cache CMake refuses: it goes, and the next build seeds again.
      await rm(plan.bin, { recursive: true, force: true });
      throw error;
    }
  }

  /**
   * The newest built folder of this project for the same destination and lock, other than this
   * one; never one reached through a link or stamped by anything but a regular file.
   */
  async #leadFor(plan: BuildPlan): Promise<{ bin: string; source: string } | null> {
    const root = path.resolve(this.options.root);
    const leaf = path.basename(plan.bin);
    let best: { bin: string; source: string; at: number } | null = null;
    for (const name of await readdir(root).catch(() => [] as string[])) {
      if (PROJECT_FOLDER.exec(name)?.[1] !== projectFolder(plan.input.project)) continue;
      const bin = path.join(root, name, leaf);
      if (bin === plan.bin) continue;
      const built = await builtBy(root, bin);
      if (!built || (best && best.at >= built.at)) continue;
      best = { bin, ...built };
    }
    return best && { bin: best.bin, source: best.source };
  }

  /**
   * What the live stage may fall back to: `out/` as {@link #builtOutput} finds it, and for Windows
   * or Linux only an `out/` the gate admitted ({@link #lastAdmitted}).
   */
  async #lastOutput(bin: string, target: BuildTarget): Promise<string | null> {
    if (isCrossBuild(target)) return await this.#lastAdmitted(bin, target);
    return await this.#builtOutput(bin, target);
  }

  /**
   * A cross build's `out/` as a build to fall back on: what {@link #builtOutput} finds, and only while
   * its executable is the very one the gate admitted (the stamp beside the folder). A refused,
   * never-admitted or since-changed executable is no output.
   */
  async #lastAdmitted(bin: string, target: DesktopTarget): Promise<string | null> {
    const output = await this.#builtOutput(bin, target);
    if (!output) return null;
    const [stamp, exe] = await Promise.all([
      readRegularFile(`${bin}${ADMITTED_STAMP}`, STAMP_MAX_BYTES).catch(() => null),
      readRegularFile(path.join(output, NATIVE_CROSS_EXECUTABLES[target]), CROSS_EXE_MAX_BYTES).catch(() => null),
    ]);
    const admitted = stamp !== null && exe !== null && stamp.toString("utf8") === sha256(exe);
    return admitted ? output : null;
  }

  /**
   * `out/` when it holds what `target` builds (the web's page; the Mac's two executables; the
   * Windows or Linux executable), each a regular file, and every folder down to it is a real one.
   */
  async #builtOutput(bin: string, target: BuildTarget): Promise<string | null> {
    const output = path.join(bin, OUTPUT_DIR);
    for (const file of servedFiles(target)) {
      const found = await lstat(path.join(output, file)).catch(() => null);
      if (!found?.isFile()) return null;
    }
    return (await realFolders(path.resolve(this.options.root), output)) ? output : null;
  }

  /**
   * One slot of `cppBuildsMax(cores)`, or null when the build was cancelled while it waited.
   * The release hands the slot to the oldest waiter.
   */
  async #slot(signal: AbortSignal): Promise<(() => void) | null> {
    if (signal.aborted) return null;
    const release = () => {
      this.#active--;
      this.#waiting.shift()?.();
    };
    if (this.#active < cppBuildsMax(this.options.cores)) {
      this.#active++;
      return release;
    }
    return await new Promise((resolve) => {
      const take = () => {
        signal.removeEventListener("abort", leave);
        this.#active++;
        resolve(release);
      };
      const leave = () => {
        const at = this.#waiting.indexOf(take);
        if (at >= 0) this.#waiting.splice(at, 1);
        resolve(null);
      };
      this.#waiting.push(take);
      signal.addEventListener("abort", leave, { once: true });
    });
  }

  /**
   * The source root joins the store and the native runs in every run's write denies, each as
   * named and as real: the sandbox matches real paths, and a store may be reached through a link.
   * On a Mac each is written as a literal glob, since sandbox-runtime reads `[`, `*` or `?` in a
   * path (a game called `pong [v2]`) as a pattern. The one write the lane opens is the build folder itself.
   *
   * The lane opens no domain: the network is the sandbox's base policy (none for agent processes).
   * A package install or a genex-cli call in flight opens its domain to every sandboxed process,
   * a build included (docs/agent/architecture.md, "Residual risks").
   */
  async #policy(plan: BuildPlan): Promise<Partial<SandboxPolicy>> {
    const named = [plan.source, path.resolve(plan.input.dir), ...this.options.denyWrite.map((p) => path.resolve(p))];
    const real = await Promise.all(named.map((p) => realpath(p).catch(() => p)));
    const literal = this.options.platform === StudioPlatform.Mac ? literalGlob : (p: string) => p;
    return { denyWrite: [...new Set([...named, ...real].map(literal))], allowWrite: [plan.bin] };
  }

  /** The store's current lock, or why there is none to build with. */
  async #currentLock(): Promise<{ lock: ToolchainLock | null; why?: string }> {
    try {
      return { lock: await this.options.currentLock() };
    } catch (error) {
      return { lock: null, why: errorMessage(error) };
    }
  }

  /** The lock is recorded once per project and digest; a record that cannot be written does not undo a build. */
  async #recordLock(project: string, digest: string): Promise<void> {
    if (this.#recorded.get(project) === digest) return;
    try {
      await this.options.writeLock(project, digest);
      this.#recorded.set(project, digest);
    } catch {
      // Not recorded, so the next build that works tries again.
    }
  }

  /**
   * A Windows or Linux build's `out/` through the PE or ELF gate (`admitCrossOutput`) against the
   * lock's store ANGLE. Admitted: the executable's digest is stamped beside the folder (what a later
   * failure may fall back on) and the destination's check recorded, and the build goes on. Refused:
   * the stamp goes, the failed check is recorded, and the outcome is `GateRefused`, serving nothing.
   * Null for every other destination, and for an admitted build.
   */
  async #gateCross(plan: BuildPlan, output: string): Promise<BuildOutcome | null> {
    const { input, bin } = plan;
    if (!isCrossBuild(input.target)) return null;
    const { angle } = crossFiles(plan.toolchain, input.target);
    const admit = this.options.admitCross ?? admitCrossOutput;
    const admission = await admit({ target: input.target, out: output, angle });
    const stamp = `${bin}${ADMITTED_STAMP}`;
    if (admission.ok) {
      const digest = await admittedDigest(admission, path.join(output, NATIVE_CROSS_EXECUTABLES[input.target]));
      await atomicWriteText(stamp, digest);
      await this.#recordCheck(plan, this.#passedBadge(input.target));
      return null;
    }
    await rm(stamp, { force: true });
    await this.#recordCheck(plan, DestinationBadge.Failed, admission.refusal);
    const problem: BuildProblem = {
      ...refusalProblem({
        project: input.project,
        target: input.target,
        reason: BuildProblemCode.GateRefused,
        lines: [admission.detail],
        at: this.#at(),
      }),
      gate: { refusal: admission.refusal, file: admission.file },
    };
    this.#emit(input, BuildPhase.Failed);
    const nativeAdmission = await crossAdmissionFacts(output, input.target, angle, admission);
    return { ok: false, output: null, lastGood: null, problem, ran: true, nativeAdmission };
  }

  /**
   * Records a Windows or Linux build of the game folder in the host's library (`writeCheck`), once
   * per change of its badge, lock or refusal; a worktree's build, any other destination and a lane
   * with no library record nothing, and a record that cannot be written does not undo a build.
   */
  async #recordCheck(plan: BuildPlan, badge: DestinationBadge, refusal?: NativeRefusal): Promise<void> {
    const { input } = plan;
    const write = this.options.writeCheck;
    if (!write || !input.recordLock || !isCrossBuild(input.target)) return;
    const check: DestinationCheck = { badge, lock: plan.lock.digest.slice(0, 12), at: this.#at() };
    if (refusal) check.refusal = refusal;
    const key = `${input.project}\n${input.target}`;
    const known = [badge, check.lock, refusal ?? ""].join("\n");
    if (this.#checked.get(key) === known) return;
    try {
      await write(input.project, input.target, check);
      this.#checked.set(key, known);
    } catch {
      // Not recorded, so the next build tries again.
    }
  }

  /** An admitted build's badge: built where this host runs the destination, else built, not run here. */
  #passedBadge(target: DesktopTarget): DestinationBadge {
    const host = hostOf(this.options.platform);
    return host ? crossCheckBadge(host, target) : DestinationBadge.NotRunHere;
  }

  #refused(
    input: CppBuildInput,
    reason: BuildProblemCode,
    lines: string[] = [],
    lastGood: string | null = null,
  ): BuildOutcome {
    const problem = refusalProblem({
      project: input.project,
      target: input.target,
      reason,
      lines,
      showingLastBuild: lastGood !== null,
      at: this.#at(),
    });
    this.#emit(input, BuildPhase.Failed);
    return { ok: false, output: null, lastGood, problem, ran: false };
  }

  #cancelled(input: CppBuildInput, lastGood: string | null): BuildOutcome {
    return this.#refused(input, BuildProblemCode.Cancelled, [], lastGood);
  }

  /** A caller that stopped waiting on a build that goes on: `Cancelled` for it, with nothing announced. */
  #left(input: CppBuildInput, lastGood: string | null): BuildOutcome {
    const { project, target } = input;
    const showingLastBuild = lastGood !== null;
    const problem = refusalProblem({
      project,
      target,
      reason: BuildProblemCode.Cancelled,
      showingLastBuild,
      at: this.#at(),
    });
    return { ok: false, output: null, lastGood, problem, ran: false };
  }

  async #failed(plan: BuildPlan, result: RunResult, signal: AbortSignal, note?: string): Promise<BuildOutcome> {
    const { input } = plan;
    const lastGood = await this.#lastOutput(plan.bin, input.target);
    const problem: BuildProblem = {
      project: input.project,
      command: result.command,
      code: result.code,
      lines: note ? [note, ...outputLines(result, PROBLEM_LINES - 1)] : outputLines(result, PROBLEM_LINES),
      needsInstall: false,
      install: null,
      skippedScripts: null,
      showingLastBuild: lastGood !== null,
      at: this.#at(),
      reason: failureReason(result, signal),
      target: input.target,
      diagnostics: parseDiagnostics(`${result.stdout}\n${result.stderr}`, plan.source),
    };
    // A build Stop cancelled says nothing of the destination.
    if (problem.reason !== BuildProblemCode.Cancelled) await this.#recordCheck(plan, DestinationBadge.Failed);
    this.#emit(input, BuildPhase.Failed);
    return { ok: false, output: null, lastGood, problem, ran: true };
  }

  #emit(input: CppBuildInput, phase: BuildPhase): void {
    this.options.emit({ project: input.project, target: input.target, purpose: input.purpose, phase, at: this.#now() });
  }

  #now(): number {
    return this.options.now?.() ?? Date.now();
  }

  #at(): string {
    return new Date(this.#now()).toISOString();
  }
}

/** A computer the lane does not build on yet, a Mac build off a Mac, or a desktop target the game does not name; Web always builds. */
function targetRefusal(input: CppBuildInput, platform: NodeJS.Platform): BuildProblemCode | null {
  if (!cppLaneRunsOn(platform)) return BuildProblemCode.UnsupportedHost;
  const host = hostOf(platform);
  const unbuildable = host ? buildRefusal(host, input.target) !== null : input.target === BuildTarget.Mac;
  if (unbuildable) return BuildProblemCode.MacBuildsNeedAMac;
  const named = input.destinations.targets.includes(input.target);
  if (DESKTOP_TARGETS.includes(input.target) && !named) return BuildProblemCode.NotADestination;
  return null;
}

/**
 * What a located toolchain still lacks for `target`: its genex.cmake, Emscripten for the web, ANGLE
 * for the Mac, zig and the lock's cross files for Windows and Linux.
 */
function missingFrom(toolchain: LocatedToolchain, target: BuildTarget): ToolchainId[] {
  const missing: ToolchainId[] = [];
  if (!toolchain.genexCmake[target]) missing.push(ToolchainId.RaylibSource);
  if (isCrossBuild(target) && !(toolchain.zig && toolchain.cross?.[target])) missing.push(ToolchainId.Zig);
  if (target === BuildTarget.Web && !toolchain.emscripten) missing.push(ToolchainId.Emsdk);
  if (target === BuildTarget.Mac && !toolchain.angle) missing.push(ToolchainId.AngleMac);
  return missing;
}

/** The files a build's `out/` must hold for `target`: the web's page, the Mac's two executables, or one executable. */
function servedFiles(target: BuildTarget): readonly string[] {
  if (isCrossBuild(target)) return [NATIVE_CROSS_EXECUTABLES[target]];
  return target === BuildTarget.Mac ? MAC_EXECUTABLES : [CPP_ENTRY];
}

/** Whether `target` is cross-built with zig (Windows x64, Linux x64). */
function isCrossBuild(target: BuildTarget): target is DesktopTarget {
  return Object.hasOwn(NATIVE_CROSS_EXECUTABLES, target);
}

/** Whether a build for `target` copies the staged assets into `out/assets` (every desktop destination). */
function copiesAssets(target: BuildTarget): boolean {
  return target === BuildTarget.Mac || isCrossBuild(target);
}

/** The lock's cross files for `target`; `missingFrom` refuses a build without them before it plans one. */
function crossFiles(toolchain: LocatedToolchain, target: DesktopTarget): CrossFiles {
  const files = toolchain.cross?.[target];
  if (!files) throw new Error(MESSAGE.noCrossFiles(target));
  return files;
}

/** The lock's files for one cross destination, as a locate names them. */
type CrossFiles = NonNullable<NonNullable<LocatedToolchain["cross"]>[DesktopTarget]>;

/** `bytes`' sha256, lowercase hex. */
function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * The sha256 of the executable the gate admitted: the very bytes it read (Windows) or its own
 * digest (Linux); for a gate that says neither, the file as it is now, read without following a link.
 */
async function admittedDigest(admission: Extract<CrossAdmission, { ok: true }>, exe: string): Promise<string> {
  if (admission.windows) return sha256(admission.windows.exe.bytes);
  if (admission.linux) return admission.linux.exeSha256;
  return sha256(await readRegularFile(exe, CROSS_EXE_MAX_BYTES));
}

/**
 * A Mac build folder whose `out/assets` is not a real folder (a worker's clone loses `out/`; a
 * person removed it) forgets genex.cmake's marker, so the build copies the assets again. Only
 * looked at: nothing is removed through `out/`, which a build run can replace with a link.
 */
async function forgetGoneAssets(bin: string): Promise<void> {
  const assets = await lstat(path.join(bin, OUTPUT_DIR, MAC_ASSETS_DIR)).catch(() => null);
  if (assets?.isDirectory()) return;
  await rm(path.join(bin, MAC_ASSETS_MARKER), { force: true });
}

/**
 * A Mac build's `out/` as the native runs admit it: exactly `game`, `game-headless` and `assets/`.
 * The build's run may have replaced `out/` (or anything in it) with a link, and a process it left
 * behind may still be writing there, so `out/` is first renamed beside the build folder, where no
 * build run can write (`rename` moves a link itself), and trimmed there: anything else a build left
 * goes, a link itself and never what it points at. An `out/` or `out/assets` that is not a real
 * folder is no output at all: it goes whole, and the answer says why. Null when `out/` is kept (or
 * there was none, which the caller reads as no output).
 */
async function keepMacOutputs(bin: string): Promise<string | null> {
  const output = path.join(bin, OUTPUT_DIR);
  const aside = `${bin}${OUTPUT_ASIDE}`;
  await rm(aside, { recursive: true, force: true });
  if (!(await renamed(output, aside))) return null;
  const refused = await trimMacOutput(aside);
  // Put back unless refused; whatever a lingering process made at out/ meanwhile makes the rename fail.
  if (!refused && (await renamed(aside, output))) return null;
  await rm(aside, { recursive: true, force: true });
  return refused ?? MESSAGE.linked(OUTPUT_DIR);
}

/** Whether `from` was renamed to `to` (nothing at `from`, or a name `to` cannot take, is false). */
async function renamed(from: string, to: string): Promise<boolean> {
  return rename(from, to).then(
    () => true,
    () => false,
  );
}

/**
 * Trims a Mac `out/` moved to `dir` (a folder no build run can write) to its two regular-file
 * executables and its `assets/` folder; answers why it is no output when `dir` or its `assets` is
 * not a real folder.
 */
async function trimMacOutput(dir: string): Promise<string | null> {
  if (!(await lstat(dir).catch(() => null))?.isDirectory()) return MESSAGE.linked(OUTPUT_DIR);
  for (const name of await readdir(dir)) {
    if (name === MAC_ASSETS_DIR) continue;
    const executable = MAC_EXECUTABLES.includes(name) && (await lstat(path.join(dir, name))).isFile();
    if (!executable) await rm(path.join(dir, name), { recursive: true, force: true });
  }
  const assets = await lstat(path.join(dir, MAC_ASSETS_DIR)).catch(() => null);
  if (!assets) await mkdir(path.join(dir, MAC_ASSETS_DIR));
  else if (!assets.isDirectory()) return MESSAGE.linked(`${OUTPUT_DIR}/${MAC_ASSETS_DIR}`);
  return null;
}

function failureReason(result: RunResult, signal: AbortSignal): BuildProblemCode {
  if (signal.aborted) return BuildProblemCode.Cancelled;
  return result.timedOut ? BuildProblemCode.TimedOut : BuildProblemCode.CommandFailed;
}

/**
 * Remove whatever is at `p` unless it is a real folder, and say whether it is one. A link is
 * removed itself, never followed (`rm` takes the link, not what it points at).
 */
async function dropUnlessFolder(p: string): Promise<boolean> {
  const found = await lstat(p).catch(() => null);
  if (found?.isDirectory()) return true;
  if (found) await rm(p, { recursive: true, force: true });
  return false;
}

/**
 * `dir` as a real folder, made by `make` (a plain `mkdir` by default) unless it already is one. A
 * link or a file at its name, put there by a process that can write its parent, is removed first.
 */
async function ownFolder(dir: string, make: () => Promise<unknown> = () => mkdir(dir)): Promise<void> {
  if (await dropUnlessFolder(dir)) return;
  try {
    await make();
  } catch (error) {
    // Another build made the same folder meanwhile (the root, a project's folder): a real folder is all this asks for.
    const exists = (error as NodeJS.ErrnoException).code === "EEXIST";
    const made = exists ? await lstat(dir).catch(() => null) : null;
    if (!made?.isDirectory()) throw error;
  }
}

/** Whether `root` and every folder from it down to `target` is a real folder, never a link. */
async function realFolders(root: string, target: string): Promise<boolean> {
  if (!isInside(root, target)) return false;
  const rel = path.relative(root, target);
  let current = root;
  for (const name of ["", ...(rel ? rel.split(path.sep) : [])]) {
    current = path.join(current, name);
    const found = await lstat(current).catch(() => null);
    if (!found?.isDirectory()) return false;
  }
  return true;
}

/** What a build folder last built and when, from the regular-file stamp beside it; null for one reached through a link. */
async function builtBy(root: string, bin: string): Promise<{ source: string; at: number } | null> {
  if (!(await realFolders(root, bin))) return null;
  const stamp = `${bin}${BUILT_STAMP}`;
  const found = await lstat(stamp).catch(() => null);
  if (!found?.isFile()) return null;
  const source = await readRegularFile(stamp, STAMP_MAX_BYTES).catch(() => null);
  return source && { source: source.toString("utf8"), at: found.mtimeMs };
}

/** Where the host stages the assets a build of `bin` takes: beside it, never in it. */
function assetsStage(bin: string): string {
  return `${bin}${ASSETS_STAGE}`;
}

/**
 * A web link with no assets to pack leaves the last packing's `index.data` in `out/`, which Live
 * and the exports serve whole: one older than the stage's last change is stale and goes. One the
 * build just wrote is what it packed, and stays.
 */
async function dropStalePack(output: string, stamp: string): Promise<void> {
  const data = path.join(output, PACKED_ASSETS);
  const [packed, changed] = await Promise.all([lstat(data).catch(() => null), lstat(stamp).catch(() => null)]);
  if (packed && changed && packed.mtimeMs < changed.mtimeMs) await rm(data, { force: true });
}

/** The stamp the web link of `bin` depends on, beside its stage. */
function assetsStamp(bin: string): string {
  return `${assetsStage(bin)}${ASSETS_STAMP}`;
}

/** Emscripten, when this build is a web build that has one. */
function webEmscripten(plan: BuildPlan): NonNullable<LocatedToolchain["emscripten"]> | null {
  return plan.input.target === BuildTarget.Web ? plan.toolchain.emscripten : null;
}

/**
 * The lock's prewarmed zig cache (the libc and libc++ zig built for the target), when this is a
 * Windows or Linux build whose lock kept one: a new build folder's first build starts from it.
 */
function crossZigCache(plan: BuildPlan): string | null {
  if (!isCrossBuild(plan.input.target)) return null;
  return plan.toolchain.cross?.[plan.input.target]?.zigCache ?? null;
}

/** The folder `emcc` lives in: four levels above its CMake toolchain file (`cmake/Modules/Platform/`). */
function emccDir(toolchainFile: string): string {
  return path.resolve(toolchainFile, "..", "..", "..", "..");
}

/**
 * The environment of both runs: the store's tools first on PATH, the lock's EM_CONFIG, this
 * folder's own EM_CACHE and clang module cache, emsdk's Python behind the lock's `-B` wrapper in
 * `tools`, and for Windows and Linux zig's caches in this folder (`crossBuildEnv`, which refuses a
 * folder CMake cannot be told).
 */
function buildEnv(plan: BuildPlan, tools: string): Record<string, string> {
  const dirs = [path.dirname(plan.toolchain.cmake), path.dirname(plan.toolchain.ninja)];
  // The env equivalent of `-fmodules-cache-path`, which clang would warn about on every compile
  // that does not use modules.
  const env: Record<string, string> = {
    PYTHONDONTWRITEBYTECODE: "1",
    CLANG_MODULE_CACHE_PATH: path.join(plan.bin, MODULE_CACHE_DIR),
  };
  const emscripten = webEmscripten(plan);
  if (emscripten) {
    dirs.unshift(tools);
    dirs.push(emccDir(emscripten.toolchainFile), path.dirname(emscripten.node));
    env.EM_CONFIG = emscripten.config;
    env.EM_CACHE = path.join(plan.bin, EM_CACHE_DIR);
    env.EMSDK_PYTHON = path.join(tools, PYTHON_WRAPPER);
    env.EMCC_SKIP_SANITY_CHECK = "1";
  }
  if (isCrossBuild(plan.input.target)) Object.assign(env, crossBuildEnv(path.join(plan.bin, ZIG_CACHE_DIR)));
  return { ...env, PATH: [...new Set([...dirs, ...SYSTEM_PATH])].join(path.delimiter) };
}

/**
 * `cmake -S <root> -B <bin> -G Ninja …`: every word the host's, every one quoted. Web and Windows
 * and Linux name their toolchain file (Emscripten's, or the lock's zig `toolchain-<x>.cmake`).
 */
function configureCommand(plan: BuildPlan): string {
  const args = [
    plan.toolchain.cmake,
    "-S",
    plan.source,
    "-B",
    plan.bin,
    "-G",
    "Ninja",
    `-DCMAKE_MAKE_PROGRAM=${plan.toolchain.ninja}`,
    `-DGENEX_CMAKE=${plan.genex}`,
  ];
  const emscripten = webEmscripten(plan);
  if (emscripten) args.push(`-DCMAKE_TOOLCHAIN_FILE=${emscripten.toolchainFile}`);
  if (isCrossBuild(plan.input.target))
    args.push(`-DCMAKE_TOOLCHAIN_FILE=${crossFiles(plan.toolchain, plan.input.target).toolchainFile}`);
  if (plan.input.target === BuildTarget.Mac) args.push(...macConfigureArgs(plan));
  if (emscripten || copiesAssets(plan.input.target))
    args.push(`-DGENEX_ASSETS=${assetsStage(plan.bin)}`, `-DGENEX_ASSETS_STAMP=${assetsStamp(plan.bin)}`);
  args.push(FETCH_DISCONNECTED);
  return args.map(shellQuote).join(" ");
}

/** A Mac configure's SDK (from `xcrun`), and the recipe's arch and deployment target, before the first `project()`. */
function macConfigureArgs(plan: BuildPlan): string[] {
  const cache = targetRecipe(readRecipe(), BuildTarget.Mac).cmake ?? {};
  return [
    `-DCMAKE_OSX_SYSROOT=${plan.sdk ?? ""}`,
    ...Object.entries(cache).map(([name, value]) => `-D${name}=${value}`),
  ];
}

function buildCommand(plan: BuildPlan, jobs: number): string {
  return [plan.toolchain.cmake, "--build", plan.bin, `-j${jobs}`].map(shellQuote).join(" ");
}

/** How a clone copies: which `cp`, the platform whose clone flag it takes, and the Stop that ends it. */
interface Copier {
  cp: string;
  platform: NodeJS.Platform;
  signal: AbortSignal;
}

/**
 * Clone a folder (an APFS or reflink clone where the file system has one), whole or not at all.
 * Links in it are copied as links, never followed (`cp -R`). Stop ends the copy and leaves nothing.
 */
async function cloneTree(from: string, to: string, copier: Copier): Promise<void> {
  const clone = copier.platform === StudioPlatform.Mac ? ["-c", "-R"] : ["-R", "--reflink=auto"];
  const cloned = await copyInto(from, to, clone, copier).then(
    () => true,
    () => false,
  );
  copier.signal.throwIfAborted();
  // A volume that cannot clone (or a cp without the flag) still copies.
  if (!cloned) await copyInto(from, to, ["-R"], copier);
}

/**
 * `from`'s contents copied into a fresh folder made exclusively beside `to` (so nothing planted at
 * a name the host would pick is copied into), then renamed to `to`; nothing is left on a failure
 * or a Stop, which kills the copy.
 */
async function copyInto(from: string, to: string, flags: readonly string[], copier: Copier): Promise<void> {
  const fresh = await mkdtemp(path.join(path.dirname(to), CLONE_PREFIX));
  try {
    await execFileAsync(copier.cp, [...flags, `${from}${path.sep}.`, fresh], { signal: copier.signal });
    await rename(fresh, to);
  } catch (error) {
    await rm(fresh, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Sweeps one project's folder: each build folder of a lock other than `current` (when there is
 * one), or whose source root is unknown or gone, goes with everything named after it beside it
 * (`.built`, `.source`, `.assets`, `.assets.stamp`, `.out`), as do half-made clones; an empty project
 * folder goes too. Answers how many build folders went.
 */
async function sweepProject(project: string, current: string | null): Promise<number> {
  let removed = 0;
  const names = await readdir(project).catch(() => [] as string[]);
  for (const name of names) {
    const digest = BUILD_FOLDER.exec(name)?.[2];
    if (!digest) continue;
    const oldLock = current !== null && digest !== current;
    if (!oldLock && (await sourceIsThere(path.join(project, name)))) continue;
    await removeNamed(project, names, (other) => other === name || other.startsWith(`${name}.`));
    removed++;
  }
  await removeNamed(project, await readdir(project).catch(() => [] as string[]), (name) =>
    name.startsWith(CLONE_PREFIX),
  );
  await rmdir(project).catch(() => {});
  return removed;
}

/** Removes each of `names` in `folder` that `chosen` picks; a link goes itself, never what it points at. */
async function removeNamed(folder: string, names: readonly string[], chosen: (name: string) => boolean): Promise<void> {
  for (const name of names) if (chosen(name)) await rm(path.join(folder, name), { recursive: true, force: true });
}

/** The lock helper folders under `tools` that `stale` names go. */
async function sweepTools(tools: string, stale: (digest: string) => boolean): Promise<void> {
  for (const name of await readdir(tools).catch(() => [] as string[]))
    if (TOOLS_FOLDER.test(name) && stale(name)) await rm(path.join(tools, name), { recursive: true, force: true });
}

/**
 * Whether the source root a build folder was made for is still there, read from the host's stamps
 * beside it (`.source`, else `.built`); a folder with neither, or reached through a link, has none.
 */
async function sourceIsThere(bin: string): Promise<boolean> {
  if (!(await lstat(bin).catch(() => null))?.isDirectory()) return false;
  for (const stamp of [`${bin}${SOURCE_STAMP}`, `${bin}${BUILT_STAMP}`]) {
    const source = await readRegularFile(stamp, STAMP_MAX_BYTES).catch(() => null);
    if (source?.length) return pathExists(source.toString("utf8"));
  }
  return false;
}

/**
 * Point a cloned CMake cache at its new folder and source root, written by rename. One that is
 * not a regular file (a link the lead's run planted), too big, or with no source to move from is
 * dropped, and CMake starts afresh.
 */
async function moveBuildCache(bin: string, lead: { bin: string; source: string }, source: string): Promise<void> {
  const cache = path.join(bin, CMAKE_CACHE);
  const text = await readRegularFile(cache, CMAKE_CACHE_MAX_BYTES).then(
    (bytes) => bytes.toString("utf8"),
    () => null,
  );
  if (text === null || !lead.source) {
    await rm(cache, { recursive: true, force: true });
    return;
  }
  await atomicWriteText(cache, text.split(lead.bin).join(bin).split(lead.source).join(source));
}

/** `file:line:col: error: message` (clang, and zig's own compiler). */
const LOCATED_ERROR = /^(.+?):(\d+):(\d+): (?:fatal )?error: (.+)$/;
/** `CMake Error at file:line (command):`, `CMake Error in file:` or `CMake Error: message`. */
const CMAKE_ERROR = /^CMake Error(?: at (.+?):(\d+)(?: \([^)]*\))?| in (.+?))?:\s*(.*)$/;
/** Errors that name no source line, by the tool that printed them. */
const UNLOCATED_ERRORS: ReadonlyArray<readonly [RegExp, DiagnosticTool]> = [
  [/^wasm-ld: error: (.+)$/, DiagnosticTool.WasmLd],
  [/^(?:emcc|em\+\+): error: (.+)$/, DiagnosticTool.Emcc],
  [/^ninja: error: (.+)$/, DiagnosticTool.Ninja],
  // The linkers zig drives: lld-link for Windows, ld.lld for Linux.
  [/^(?:lld-link|ld\.lld): error: (.+)$/, DiagnosticTool.Zig],
  [/^error: (.+)$/, DiagnosticTool.Zig],
];
/** emcc's line saying the compiler it ran failed: the compiler's own error is the one to show. */
const RESTATED_FAILURE = /failed \(returned \d+\)$/;

/**
 * The first three errors in a build's output, over progress lines, warnings and notes: clang's
 * `file:line:col: error:`, CMake's, wasm-ld's, emcc's, Ninja's and zig's (its own and its linkers').
 * A file inside the source root is named relative to it (what the person's editor calls it); any
 * other keeps its path. An error said again (a Mac build compiles each source twice, once per
 * executable) counts once.
 */
export function parseDiagnostics(output: string, sourceRoot: string): BuildDiagnostic[] {
  const lines = output.split("\n").map((line) => line.trimEnd());
  const found: BuildDiagnostic[] = [];
  const said = new Set<string>();
  for (let index = 0; index < lines.length && found.length < DIAGNOSTICS_KEPT; index++) {
    const diagnostic = diagnosticAt(lines, index, sourceRoot);
    const key = diagnostic && JSON.stringify(diagnostic);
    if (!diagnostic || !key || said.has(key)) continue;
    said.add(key);
    found.push(diagnostic);
  }
  return found;
}

function diagnosticAt(lines: readonly string[], index: number, root: string): BuildDiagnostic | null {
  const line = lines[index] ?? "";
  const located = LOCATED_ERROR.exec(line);
  if (located) {
    const [, file = "", row = "", column = "", message = ""] = located;
    return {
      tool: DiagnosticTool.Clang,
      file: sourceRelative(root, file),
      line: Number(row),
      column: Number(column),
      message: clip(message),
    };
  }
  const cmake = CMAKE_ERROR.exec(line);
  if (cmake) return cmakeDiagnostic(cmake, lines, index, root);
  for (const [pattern, tool] of UNLOCATED_ERRORS) {
    const message = pattern.exec(line)?.[1];
    if (message && !RESTATED_FAILURE.test(message))
      return { tool, file: null, line: null, column: null, message: clip(message) };
  }
  return null;
}

/** CMake puts its message on the indented line after the location; an inline message wins. */
function cmakeDiagnostic(
  match: RegExpExecArray,
  lines: readonly string[],
  index: number,
  root: string,
): BuildDiagnostic {
  const [, atFile, row, inFile, inline = ""] = match;
  const file = atFile ?? inFile ?? null;
  const following = lines.slice(index + 1).find((next) => next.trim().length > 0) ?? "";
  const message = inline.trim() || following.trim();
  return {
    tool: DiagnosticTool.CMake,
    file: file === null ? null : sourceRelative(root, file),
    line: row ? Number(row) : null,
    column: null,
    message: clip(message),
  };
}

function sourceRelative(root: string, file: string): string {
  if (!path.isAbsolute(file) || !isInside(root, file)) return file;
  return toPosixRelative(path.relative(root, file));
}

function clip(message: string): string {
  return message.length > DIAGNOSTIC_MAX_CHARS ? `${message.slice(0, DIAGNOSTIC_MAX_CHARS - 1)}…` : message;
}
