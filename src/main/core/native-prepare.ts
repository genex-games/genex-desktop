/**
 * Everything before a native game starts: the destination and host checks, the lane's Mac build
 * (`gameBuilds.ensure`, the build-lane seam: Live's purpose for the Play window and Live's Native view, Judging's for
 * agents), bundle admission, the game's once-chosen bundle id, the store's ANGLE for the lock and the
 * run directory. A run embedded in Live admits and assembles the headless executable exactly as an
 * agent's run does: it draws into Live's frames ring, never a window. Any refusal is a typed
 * `NativeError` (`BuildFailed` carries the build's problem), and nothing is started or left behind.
 * A Windows or Linux host runs its own OS's build instead: the lane's cross build, admitted again
 * through the PE or ELF gate, then its run directory (no bundle id, no codesign); neither OS has a
 * windowless build, so an agent's run there is refused, and Live shows no Windows or Linux build.
 *
 * A Rust · wgpu game runs on the Mac for Live's embedded view and an agent's headless run: its
 * lane's Mac build with the Rust lock, the wgpu admission (system libraries only, no ANGLE) and a
 * run directory without ANGLE, assembled only from the bytes the lane admitted (its receipt's
 * digests; a build with none is refused) and named in the run's `build` for capture provenance.
 * Its window run and its Windows and Linux runs have no lane yet (`lane-missing`): the facade's
 * studio mode serves headless, so a window would never show.
 */
import type { StudioPlatform } from "../../shared/boot.ts";
import type { BuildIdentity } from "../../shared/build-preview.ts";
import { BuildProblemCode } from "../../shared/build-problem.ts";
import {
  BuildTarget,
  type GameProject,
  destinationsOf,
  GameStack,
  isCompiledStack,
  liveEmbedsStack,
  playsInOwnWindow,
  stackOf,
} from "../../shared/game-project.ts";
import { TargetRefusal, runRefusal } from "../../shared/game-targets.ts";
import {
  GameBoxProblem,
  NATIVE_MAC_EXECUTABLES,
  NativeError,
  NativeRefusal,
  NativeRunMode,
} from "../../shared/native-contract.ts";
import type { GameWorkspaces } from "../../substrate/game-workspace.ts";
import {
  admitMacBundle,
  admitWgpuBundle,
  assembleRunDir,
  assembleWgpuRunDir,
  checkMacAngle,
  type MacAngle,
} from "../../substrate/native-bundle.ts";
import { admitCrossOutput, type CrossAngle, type DesktopTarget } from "../../substrate/native-cross-admission.ts";
import { assembleCrossRunDir } from "../../substrate/native-rundir-cross.ts";
import { CppBuildPurpose, refusalProblem, toolchainRefusal } from "../cpp-build.ts";
import type { GameBuildLanes } from "../game-build.ts";
import type { ConformanceGateResult } from "./game-conformance-gate.ts";
import type { NativePrepareRequest, PreparedRun } from "./native-runs.ts";
import type { HostExec, ToolchainService } from "./toolchains.ts";

/** The build purpose of each run mode: the person's (the window, Live's Native view) or an agent's. */
const BUILD_PURPOSE = {
  [NativeRunMode.Window]: CppBuildPurpose.Live,
  [NativeRunMode.Embedded]: CppBuildPurpose.Live,
  [NativeRunMode.Headless]: CppBuildPurpose.Judging,
} as const satisfies Record<NativeRunMode, CppBuildPurpose>;

/** The executable each mode runs: an embedded run draws headless, into Live's frames ring. */
const ADMITTED_MODE = {
  [NativeRunMode.Window]: NativeRunMode.Window,
  [NativeRunMode.Embedded]: NativeRunMode.Headless,
  [NativeRunMode.Headless]: NativeRunMode.Headless,
} as const satisfies Record<NativeRunMode, NativeRunMode>;

const MESSAGE = {
  notInLibrary: (project: string) => `there is no game called "${project}"`,
  notNative: (project: string) => `"${project}" is not a compiled game`,
  noRunLane: (project: string, target: string, mode: string) =>
    `"${project}" has no ${mode} run on ${target} in this build: Live shows its Mac build`,
  notADestination: (project: string, target: string) => `"${project}" is not made for ${target}`,
  embedded: "Live shows only Mac builds in this version",
  notRunnableHere: (target: string) => `${target} games do not run on this computer`,
  refusedHere: (target: string, refusal: string) => `${target} cannot run here (${refusal})`,
  buildFailed: (target: string) => `the ${target} build failed`,
  laneMissing: (project: string) => `"${project}" is made with a stack this build has no lane for yet`,
  noAngle: "the toolchain store holds no Mac ANGLE for this lock",
  noCrossAngle: (target: string) => `the toolchain store holds no ${target} ANGLE for this lock`,
  noHeadlessBuild: (target: string) =>
    `there is no headless ${target} build: an agent's run is judged on the web build`,
  angleRefused: (refusal: string) => `the toolchain store's Mac ANGLE for this lock failed its check (${refusal})`,
  notAdmitted: (target: string) => `the ${target} build names no admitted files: nothing in it can be run`,
} as const;

/** Each target refusal as the native run's own refusal (the aliases keep one home: `game-targets.ts`). */
const NATIVE_REFUSAL_OF = {
  [TargetRefusal.MacBuildsNeedAMac]: NativeRefusal.NotRunnableHere,
  [TargetRefusal.NotRunnableHere]: NativeRefusal.NotRunnableHere,
  [TargetRefusal.NoGameBox]: NativeRefusal.NoGameBox,
  [TargetRefusal.NotADestination]: NativeRefusal.NotADestination,
  [TargetRefusal.StackIsFixed]: NativeRefusal.NotADestination,
  [TargetRefusal.NoJudgingTarget]: NativeRefusal.NotRunnableHere,
  [TargetRefusal.KindUnsupported]: NativeRefusal.KindUnsupported,
  [TargetRefusal.StackGated]: NativeRefusal.StackGated,
  [TargetRefusal.ToolchainOffline]: NativeRefusal.ToolchainOffline,
} as const satisfies Record<TargetRefusal, NativeRefusal>;

/** A host refusal of `target` as the native refusal a run or lease is refused with. */
export function nativeRefusalOf(refusal: TargetRefusal): NativeRefusal {
  return NATIVE_REFUSAL_OF[refusal];
}

/** Why this host will not run `target` for a native run, or null: an unknown host runs nothing. */
export function hostRefusal(host: StudioPlatform | null, target: BuildTarget, gameBox: boolean): NativeError | null {
  if (!host) return new NativeError(NativeRefusal.NotRunnableHere, MESSAGE.notRunnableHere(target));
  const refused = runRefusal(host, target, { gameBox });
  return refused ? new NativeError(nativeRefusalOf(refused), MESSAGE.refusedHere(target, refused)) : null;
}

/** Bundle admission and assembly, injected so prepare is tested over fakes (default: `native-bundle.ts`). */
export interface NativeBundleSteps {
  admit: typeof admitMacBundle;
  checkAngle: typeof checkMacAngle;
  assemble: typeof assembleRunDir;
  /** A Windows or Linux build's re-admission through its gate (default: `admitCrossOutput`). */
  admitCross?: typeof admitCrossOutput;
  /** A Windows or Linux run directory (default: `assembleCrossRunDir`). */
  assembleCross?: typeof assembleCrossRunDir;
  /** A Rust · wgpu game's Mac admission (default: `admitWgpuBundle`). */
  admitWgpu?: typeof admitWgpuBundle;
  /** A Rust · wgpu game's Mac run directory, without ANGLE (default: `assembleWgpuRunDir`). */
  assembleWgpu?: typeof assembleWgpuRunDir;
}

const BUNDLE_STEPS: NativeBundleSteps = {
  admit: admitMacBundle,
  checkAngle: checkMacAngle,
  assemble: assembleRunDir,
};

/** What preparing a run reaches: the studio's own services, passed whole by the core. */
export interface NativePrepareDeps {
  /** `layout.nativeRuns`. */
  root: string;
  /** This host, or null on a platform the studio does not build for. */
  host: StudioPlatform | null;
  /** Whether `ProcessSandbox` has a game box for this host's own OS. */
  gameBox(): boolean;
  /** Why this host has no game box for a `mode` run (`ProcessSandbox.gameBox`), carried by a `no-game-box` refusal. */
  gameBoxProblem?(mode: NativeRunMode): GameBoxProblem | null;
  /** The library, and the game's once-chosen bundle id (`GameWorkspaces.bundleIdFor`). */
  games: Pick<GameWorkspaces, "list"> & { bundleIdFor(name: string): Promise<string> };
  /** The build-lane seam (`x.gameBuilds`): the game's stack's lane builds it. */
  gameBuilds: Pick<GameBuildLanes, "ensure">;
  toolchains: Pick<ToolchainService, "currentLock" | "locate">;
  /** Host programs without a shell (`codesign` in the run directory). */
  exec: HostExec;
  /** Admission and assembly (default: `native-bundle.ts`). */
  bundle?: NativeBundleSteps;
  /** The clock a refusal's problem is stamped with (default: `Date.now`). */
  now?(): number;
  /**
   * The conformance gate of an ejected Rust game (`game-conformance-gate.ts`): asked with the
   * build a run would start, before it is admitted. Absent: every build passes (a test's rig).
   */
  conformance?(build: ConformanceGateBuild): Promise<ConformanceGateResult>;
}

/** What the conformance gate is asked about: the game and the build digest the run would start. */
export interface ConformanceGateBuild {
  project: string;
  buildDigest: string | null;
}

/**
 * Whether a compiled game's stack has a run lane for `target` and `mode`: raylib's for every
 * desktop destination, a Rust game's for the Mac's embedded and headless runs only.
 */
function hasRunLane(game: GameProject, target: BuildTarget, mode: NativeRunMode): boolean {
  const stack = stackOf(game.shape);
  if (playsInOwnWindow(stack)) return true;
  return liveEmbedsStack(stack) && target === BuildTarget.Mac && mode !== NativeRunMode.Window;
}

/** The game, when it is a compiled game naming `target` whose stack runs `mode` there; else the typed refusal. */
async function nativeGame(deps: NativePrepareDeps, request: NativePrepareRequest): Promise<GameProject> {
  const { project, target, mode } = request;
  const game = (await deps.games.list()).find((listed) => listed.name === project);
  if (!game) throw new NativeError(NativeRefusal.NotADestination, MESSAGE.notInLibrary(project));
  if (!isCompiledStack(stackOf(game.shape))) {
    throw new NativeError(NativeRefusal.NotADestination, MESSAGE.notNative(project));
  }
  if (!destinationsOf(game).targets.includes(target)) {
    throw new NativeError(NativeRefusal.NotADestination, MESSAGE.notADestination(project, target));
  }
  if (!hasRunLane(game, target, mode)) {
    throw new NativeError(NativeRefusal.LaneMissing, MESSAGE.noRunLane(project, target, mode));
  }
  return game;
}

/** The lane's build of the run's destination; a failure is `build-failed` with the lane's problem. */
async function build(deps: NativePrepareDeps, request: NativePrepareRequest, game: GameProject, signal: AbortSignal) {
  const stack = stackOf(game.shape);
  // A Rust game's own retained lock, so Live builds it on the toolchain it was made with.
  const lock = isCompiledStack(stack) ? await deps.toolchains.currentLock(stack, request.project) : null;
  signal.throwIfAborted();
  const receipt = await deps.gameBuilds.ensure(
    {
      project: request.project,
      dir: request.root ?? game.dir,
      shape: game.shape,
      destinations: destinationsOf(game),
      lock,
      recordLock: request.root === undefined,
    },
    request.target,
    BUILD_PURPOSE[request.mode],
    { signal },
  );
  signal.throwIfAborted();
  // The seam's own code: no lane for this stack (`lane-missing`), never the closed gate's `stack-gated`.
  if (receipt.refusal !== null) throw new NativeError(receipt.refusal, MESSAGE.laneMissing(request.project));
  const { outcome } = receipt;
  if (!outcome.ok || !outcome.output || !lock) {
    throw new NativeError(NativeRefusal.BuildFailed, MESSAGE.buildFailed(request.target), outcome.problem);
  }
  return { output: outcome.output, lock, admittedFiles: outcome.rust?.receipt?.outputs ?? null };
}

/** The store's Mac ANGLE for `lock`, checked; a store without one is `build-failed` (the toolchain is missing). */
async function storeAngle(
  deps: NativePrepareDeps,
  steps: NativeBundleSteps,
  request: NativePrepareRequest,
  lock: NonNullable<Awaited<ReturnType<NativePrepareDeps["toolchains"]["currentLock"]>>>,
  signal: AbortSignal,
): Promise<MacAngle> {
  const located = await deps.toolchains.locate(lock, [BuildTarget.Mac]);
  signal.throwIfAborted();
  const angle = located.ok ? located.toolchain.angle : null;
  if (!angle) {
    const lines = located.ok ? [] : located.missing;
    const problem = refusalProblem({
      project: request.project,
      target: request.target,
      reason: located.ok ? BuildProblemCode.ToolchainMissing : toolchainRefusal(located),
      lines,
      at: new Date((deps.now ?? Date.now)()).toISOString(),
    });
    throw new NativeError(NativeRefusal.BuildFailed, MESSAGE.noAngle, problem);
  }
  const refused = await steps.checkAngle(angle);
  if (refused) throw new NativeError(refused, MESSAGE.angleRefused(refused));
  return angle;
}

/** A `no-game-box` refusal with why this host has no box, when the sandbox says; any other refusal as it is. */
function withBox(error: NativeError, deps: NativePrepareDeps, mode: NativeRunMode): NativeError {
  const box = error.refusal === NativeRefusal.NoGameBox ? (deps.gameBoxProblem?.(mode) ?? null) : null;
  return box ? new NativeError(error.refusal, error.message, error.problem, box) : error;
}

/** Whether `target` is a Windows or Linux build (cross-built with zig), run here only on its own OS. */
function isDesktopTarget(target: BuildTarget): target is DesktopTarget {
  return target === BuildTarget.Windows || target === BuildTarget.Linux;
}

/** The store's ANGLE for a Windows or Linux `lock`; a store without one is `build-failed` (the toolchain is missing). */
async function storeCrossAngle(
  deps: NativePrepareDeps,
  request: NativePrepareRequest,
  target: DesktopTarget,
  lock: NonNullable<Awaited<ReturnType<NativePrepareDeps["toolchains"]["currentLock"]>>>,
): Promise<CrossAngle> {
  const located = await deps.toolchains.locate(lock, [target]);
  const angle = located.ok ? located.toolchain.cross?.[target]?.angle : undefined;
  if (angle) return angle;
  const problem = refusalProblem({
    project: request.project,
    target,
    reason: BuildProblemCode.ToolchainMissing,
    lines: located.ok ? [] : located.missing,
    at: new Date((deps.now ?? Date.now)()).toISOString(),
  });
  throw new NativeError(NativeRefusal.BuildFailed, MESSAGE.noCrossAngle(target), problem);
}

/**
 * A Windows or Linux host's own OS: the lane's build, its output admitted again through the PE or
 * ELF gate against the store's ANGLE (the lane admitted it once; the files may have changed since),
 * then the run directory. Window runs only: neither OS has a headless build.
 */
async function prepareDesktopRun(
  deps: NativePrepareDeps,
  steps: NativeBundleSteps,
  request: NativePrepareRequest,
  context: { game: GameProject; target: DesktopTarget; signal: AbortSignal },
): Promise<PreparedRun> {
  const { game, target, signal } = context;
  if (request.mode !== NativeRunMode.Window) {
    const box = GameBoxProblem.NoHeadlessBuild;
    throw new NativeError(NativeRefusal.NoGameBox, MESSAGE.noHeadlessBuild(target), null, box);
  }
  const { output, lock } = await build(deps, request, game, signal);
  request.onAdmitting?.();
  const angle = await storeCrossAngle(deps, request, target, lock);
  signal.throwIfAborted();
  const admission = await (steps.admitCross ?? admitCrossOutput)({ target, out: output, angle });
  signal.throwIfAborted();
  if (!admission.ok) throw new NativeError(admission.refusal, admission.detail);
  const assemble = steps.assembleCross ?? assembleCrossRunDir;
  const assembled = await assemble({ root: deps.root, runId: request.runId, admitted: admission, angle });
  return { runId: request.runId, ...assembled, bundleId: null };
}

/**
 * The conformance gate's call line: an ejected game's run (Live's, an agent's) starts only on a
 * build with a green conformance run, `conformance-required` otherwise, before anything is
 * admitted or assembled. The suite's own runs are what open the gate, so they pass it.
 */
async function gateConformance(
  deps: NativePrepareDeps,
  request: NativePrepareRequest,
  buildDigest: string | null,
): Promise<void> {
  if (!deps.conformance || request.conformance === true) return;
  const gate = await deps.conformance({ project: request.project, buildDigest });
  if (!gate.ok) throw new NativeError(NativeRefusal.ConformanceRequired, gate.detail);
}

/**
 * A Rust · wgpu game's Mac run (embedded or headless): the lane's build, the wgpu admission and a
 * run directory with no ANGLE, signed with the game's once-chosen bundle id.
 */
async function prepareWgpuRun(
  deps: NativePrepareDeps,
  steps: NativeBundleSteps,
  request: NativePrepareRequest,
  context: { game: GameProject; signal: AbortSignal },
): Promise<PreparedRun> {
  const { game, signal } = context;
  const { output, lock, admittedFiles } = await build(deps, request, game, signal);
  if (!admittedFiles) throw new NativeError(NativeRefusal.NotAnExecutable, MESSAGE.notAdmitted(request.target));
  const exe = NATIVE_MAC_EXECUTABLES[ADMITTED_MODE[request.mode]];
  const digest = admittedFiles.find((file) => file.path === exe)?.sha256 ?? null;
  await gateConformance(deps, request, digest);
  signal.throwIfAborted();
  request.onAdmitting?.();
  const admission = await (steps.admitWgpu ?? admitWgpuBundle)(output, { mode: ADMITTED_MODE[request.mode] });
  signal.throwIfAborted();
  if (!admission.ok) throw new NativeError(admission.refusal, admission.detail);
  const bundleId = await deps.games.bundleIdFor(request.project);
  signal.throwIfAborted();
  const assembled = await (steps.assembleWgpu ?? assembleWgpuRunDir)({
    root: deps.root,
    runId: request.runId,
    admitted: admission.bundle,
    bundleId,
    uiElement: true,
    gameName: game.title,
    exec: deps.exec,
    admittedFiles,
  });
  const identity: BuildIdentity = { stack: GameStack.RustWgpu, target: request.target, digest, lock: lock.digest };
  const crashBuild = digest === null ? null : { output, exe, digest };
  return { runId: request.runId, ...assembled, bundleId, build: identity, crashBuild };
}

/**
 * Builds, admits and assembles one run of `request.project`; throws `NativeError` and leaves
 * nothing. The signal is checked between every step: a Stop mid-way assembles nothing after it.
 */
export async function prepareNativeRun(
  deps: NativePrepareDeps,
  request: NativePrepareRequest,
  signal: AbortSignal,
): Promise<PreparedRun> {
  const steps = deps.bundle ?? BUNDLE_STEPS;
  const game = await nativeGame(deps, request);
  const refused = hostRefusal(deps.host, request.target, deps.gameBox());
  if (refused) throw withBox(refused, deps, request.mode);
  const embeddedCross = request.mode === NativeRunMode.Embedded && isDesktopTarget(request.target);
  if (embeddedCross) throw new NativeError(NativeRefusal.EmbedUnsupported, MESSAGE.embedded);
  signal.throwIfAborted();
  const target = request.target;
  if (isDesktopTarget(target)) return prepareDesktopRun(deps, steps, request, { game, target, signal });
  if (!playsInOwnWindow(stackOf(game.shape))) return prepareWgpuRun(deps, steps, request, { game, signal });
  const { output, lock } = await build(deps, request, game, signal);
  request.onAdmitting?.();
  const admission = await steps.admit(output, { mode: ADMITTED_MODE[request.mode] });
  signal.throwIfAborted();
  if (!admission.ok) throw new NativeError(admission.refusal, admission.detail);
  const bundleId = await deps.games.bundleIdFor(request.project);
  signal.throwIfAborted();
  const angle = await storeAngle(deps, steps, request, lock, signal);
  signal.throwIfAborted();
  const assembled = await steps.assemble({
    root: deps.root,
    runId: request.runId,
    admitted: admission.bundle,
    angle,
    bundleId,
    uiElement: request.mode !== NativeRunMode.Window,
    gameName: game.title,
    exec: deps.exec,
  });
  return { runId: request.runId, ...assembled, bundleId };
}
