/**
 * The harness's native-run methods (compiled games): build one destination through the game's
 * stack's lane (the build-lane seam; a stack with no lane yet is refused `stack-gated`), with the
 * host's admission facts for a Mac, Windows or Linux build, and read or stop a game's native run.
 * Roots go through `assertHarnessRoot`; artifact paths are always the host's own. No method
 * installs a toolchain, runs `xcode-select` or writes a lock: only the lane records one (and a
 * Windows or Linux build's destination check), after a build of the game folder. A harness stops
 * only the runs its own leases started, never the person's Play window. A game's crash records and
 * a lease's frame profile answer `unavailable` until the host keeps records and reads profiles.
 */
import path from "node:path";
import { CppBuildPurpose } from "../../shared/build-problem.ts";
import { BuildTarget, destinationsOf, isBuildTarget, isCompiledStack, stackOf } from "../../shared/game-project.ts";
import { type GameCrashesUnavailable, gameCrashesUnavailable } from "../../shared/crash-record.ts";
import { type ProfileUnavailable, ProfileUnavailableReason, profileUnavailable } from "../../shared/frame-profile.ts";
import { type HarnessHostHandlers, type HarnessParams, HostMethod } from "../../shared/harness-api.ts";
import {
  NATIVE_MAC_EXECUTABLES,
  type NativeAdmissionFacts,
  NativeError,
  NativeRefusal,
  NativeRunMode,
  type NativeRunStatus,
} from "../../shared/native-contract.ts";
import { admitMacBundle, readMachO } from "../../substrate/native-bundle.ts";
import {
  type CrossAngle,
  crossAdmissionFacts,
  type DesktopTarget,
  isDesktopTarget,
} from "../../substrate/native-cross-admission.ts";
import { NativeLeasePort } from "../../substrate/native-game-port.ts";
import type { CoreInternals, StudioCore } from "../studio-core.ts";

const MESSAGE = {
  invalidTarget: (target: string) => `native.build: "${target}" is not a destination`,
  notNative: (project: string) => `"${project}" is not a C++ · raylib game`,
  laneMissing: (project: string) => `"${project}" is made with a stack this build has no lane for yet`,
} as const;

/** A lock is named to the harness by its first 12 hex digits, as the store's folders are. */
const LOCK_DIGEST_CHARS = 12;

/** The destination a call names, or a refusal before anything runs. */
function checkedTarget(raw: unknown): BuildTarget {
  if (!isBuildTarget(raw)) throw new Error(MESSAGE.invalidTarget(String(raw)));
  return raw;
}

/** The library's compiled game `project` and its stack (the root, when named, already checked by `assertHarnessRoot`). */
async function nativeGame(core: StudioCore, project: string) {
  const game = (await core.games.list()).find((listed) => listed.name === project);
  if (!game) throw new NativeError(NativeRefusal.NotADestination, MESSAGE.notNative(project));
  const stack = stackOf(game.shape);
  if (!isCompiledStack(stack)) throw new NativeError(NativeRefusal.NotADestination, MESSAGE.notNative(project));
  return { game, stack };
}

/** The executable a judging run starts: the headless build a lease runs. */
const JUDGED_EXECUTABLE = NATIVE_MAC_EXECUTABLES[NativeRunMode.Headless];

/**
 * The host's own facts about a Mac build's `out/`, read-only: admission's verdict on the judged
 * executable, and that executable's imports and rpaths as written, read even when admission
 * refused it so the import that failed it is named. Nothing is assembled, signed or started.
 */
export async function admissionFacts(
  output: string,
  angleManifestSha256: string | null,
): Promise<NativeAdmissionFacts> {
  const admitted = await admitMacBundle(output, { mode: NativeRunMode.Headless });
  const image = admitted.ok
    ? admitted.bundle.image
    : await readMachO(path.join(output, JUDGED_EXECUTABLE)).catch(() => null);
  return {
    target: BuildTarget.Mac,
    refusal: admitted.ok ? null : admitted.refusal,
    detail: admitted.ok ? null : admitted.detail,
    imports: image?.dylibs ?? [],
    rpaths: image?.rpaths ?? [],
    angleManifestSha256,
  };
}

/** The toolchain lock a build is made with, as the store answers it. */
type CurrentLock = Awaited<ReturnType<StudioCore["toolchains"]["currentLock"]>>;

/** The digest of the store ANGLE's manifest the lock pins for the Mac, or null when the store has none. */
async function lockedAngleDigest(core: StudioCore, lock: CurrentLock) {
  if (!lock) return null;
  const located = await core.toolchains.locate(lock, [BuildTarget.Mac]).catch(() => null);
  return located?.ok ? (located.toolchain.angle?.manifestSha256 ?? null) : null;
}

/** The store ANGLE the lock pins for a Windows or Linux build (its folder and manifest digest), or null when the store has none. */
async function lockedCrossAngle(
  core: StudioCore,
  lock: CurrentLock,
  target: DesktopTarget,
): Promise<CrossAngle | null> {
  if (!lock) return null;
  const located = await core.toolchains.locate(lock, [target]).catch(() => null);
  return located?.ok ? (located.toolchain.cross?.[target]?.angle ?? null) : null;
}

/**
 * The host's admission facts for a desktop build's `out/`, read-only: a Mac bundle's, or a Windows
 * or Linux build's against the lock's store ANGLE for it. Null for the web target, and for a cross
 * build whose lock names no store ANGLE (no verdict is made up).
 */
async function admissionOf(
  core: StudioCore,
  lock: CurrentLock,
  target: BuildTarget,
  output: string,
): Promise<NativeAdmissionFacts | null> {
  if (target === BuildTarget.Mac) return admissionFacts(output, await lockedAngleDigest(core, lock));
  if (!isDesktopTarget(target)) return null;
  const angle = await lockedCrossAngle(core, lock, target);
  return angle ? crossAdmissionFacts(output, target, angle) : null;
}

/** `native.build`: one destination built by the lane for judging; the answer names only host-derived paths. */
async function build(core: StudioCore, x: CoreInternals, p: HarnessParams<typeof HostMethod.NativeBuild>) {
  const target = checkedTarget(p?.target);
  const root = await x.assertHarnessRoot(p.project, p.root ?? null);
  const { game, stack } = await nativeGame(core, p.project);
  // The game's own stack's lock: a Rust game never builds under the C++ toolchain's lock, and
  // builds on the lock it recorded while the store keeps it (an app update moved the current on).
  const lock = await core.toolchains.currentLock(stack, p.project);
  const asked = {
    project: p.project,
    dir: root ?? game.dir,
    shape: game.shape,
    destinations: destinationsOf(game),
    lock,
    recordLock: root === null,
  };
  const receipt = await x.gameBuilds.ensure(asked, target, CppBuildPurpose.Judging);
  // The seam's own code: no lane for this stack (`lane-missing`), never the closed gate's `stack-gated`.
  if (receipt.refusal !== null) throw new NativeError(receipt.refusal, MESSAGE.laneMissing(p.project));
  const { outcome } = receipt;
  const output = outcome.ok ? outcome.output : null;
  // The host's admission facts for a desktop build: what the game later says it renders with is a
  // claim. A refused cross build retains host-read imports without serving its output.
  const admission = outcome.nativeAdmission ?? (output ? await admissionOf(core, lock, target, output) : null);
  return {
    ok: outcome.ok,
    problem: outcome.problem,
    lock: lock ? lock.digest.slice(0, LOCK_DIGEST_CHARS) : null,
    output,
    admission,
  };
}

/** The native lease `handle` names, or null when it names none. */
function leasePort(x: CoreInternals, handle: string): NativeLeasePort | null {
  if (!x.previewPool?.leaseOf(handle)?.native) return null;
  const port = x.previewPool.port(handle);
  return port instanceof NativeLeasePort ? port : null;
}

/** `native.status`: the lease's run when `handle` names one, else the person's window run; null when none runs. */
async function status(
  core: StudioCore,
  x: CoreInternals,
  p: HarnessParams<typeof HostMethod.NativeStatus>,
): Promise<NativeRunStatus | null> {
  await x.assertHarnessRoot(p.project, null);
  if (!p.handle) return core.nativeRuns.state(p.project, NativeRunMode.Window);
  const run = leasePort(x, p.handle)?.run;
  return run && run.status.project === p.project ? run.status : null;
}

/**
 * `native.stop`: the runs of `project` this harness's own leases hold or are still starting (or the
 * one `handle` names); never the person's window. True when it stopped or cancelled one.
 */
async function stop(x: CoreInternals, p: HarnessParams<typeof HostMethod.NativeStop>): Promise<boolean> {
  await x.assertHarnessRoot(p.project, null);
  const owner = `harness:${x.harnessBoot}`;
  const leases = (x.previewPool?.leases() ?? []).filter(
    (lease) => lease.native && lease.owner === owner && (p.handle === undefined || lease.handle === p.handle),
  );
  let stopped = false;
  for (const lease of leases) {
    const port = leasePort(x, lease.handle);
    if (port?.project !== p.project) continue;
    if (await port.stopRun()) stopped = true;
  }
  return stopped;
}

/** `game.crashes`: the game is checked like every root; no record is kept yet. */
async function crashes(
  x: CoreInternals,
  p: HarnessParams<typeof HostMethod.GameCrashes>,
): Promise<GameCrashesUnavailable> {
  await x.assertHarnessRoot(p.project, null);
  return gameCrashesUnavailable();
}

/** `preview.frameProfile`: `no-run` for a handle that names no lease; no profile is read yet. */
function frameProfile(x: CoreInternals, p: HarnessParams<typeof HostMethod.PreviewFrameProfile>): ProfileUnavailable {
  const leased = Boolean(x.previewPool?.leaseOf(p.handle));
  return profileUnavailable(leased ? ProfileUnavailableReason.NotServed : ProfileUnavailableReason.NoRun);
}

/** The `native.*` handlers, spread into `StudioCore.api()`. */
export function nativeRpc(core: StudioCore, x: CoreInternals) {
  return {
    [HostMethod.NativeBuild]: async (p) => build(core, x, p),
    [HostMethod.NativeStatus]: async (p) => status(core, x, p),
    [HostMethod.NativeStop]: async (p) => stop(x, p),
    [HostMethod.GameCrashes]: async (p) => crashes(x, p),
    [HostMethod.PreviewFrameProfile]: async (p) => frameProfile(x, p),
  } satisfies Partial<HarnessHostHandlers>;
}
